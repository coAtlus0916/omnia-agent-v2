import { EventEmitter } from 'node:events';
import type {
  ConnectionSnapshot,
  RemotePairingSnapshot,
  ShellSnapshot,
  WorkspaceDirectorySnapshot,
  WorkspaceSafetySnapshot
} from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type { FeatureActionRequest, FeatureRuntimeSnapshot } from '../../shared/feature-contracts.js';
import type { ConnectorTransport } from '../connector/connector-transport.js';
import {
  beginPairingSession,
  cancelPairingSession,
  commitPairingSession,
  inspectBridgePairingCapability,
  pollPairingSession,
  revokeBinding
} from '../connector/remote-connector-transport.js';
import {
  BRIDGE_PROTOCOL,
  type BridgePairingCapabilityInspection
} from '../../shared/bridge-contracts.js';
import type { CoreDatabase } from '../database.js';
import type { AttachmentService } from './attachment-service.js';
import type { ChatService } from './chat-service.js';
import type { FeaturePackageManager } from '../features/package-manager.js';
import type { InteractionLogService } from './interaction-log-service.js';

const utcNow = () => new Date().toISOString();

export interface ShellServiceTiming {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  connectTimeoutMs: number;
  connectPollMs: number;
}

interface RemoteLifecycleApi {
  inspectBridge: typeof inspectBridgePairingCapability;
  beginPairing: typeof beginPairingSession;
  pollPairing: typeof pollPairingSession;
  cancelPairing: typeof cancelPairingSession;
  commitPairing: typeof commitPairingSession;
  revoke: typeof revokeBinding;
}

export class ShellService {
  private connection: ConnectionSnapshot;
  private workspaceDirectory: WorkspaceDirectorySnapshot = {
    available: false,
    reasonCode: 'not_connected',
    reason: '请先连接 Omnia Pack。',
    observation: null
  };
  private keepaliveRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private connectAttempt = 0;
  private cancelledConnectAttempt = 0;
  private readonly events = new EventEmitter();
  private remotePairing: RemotePairingSnapshot = {
    state: 'idle', pairingCode: '', expiresAt: '', message: ''
  };
  private bridgePairing: BridgePairingCapabilityInspection = {
    status: 'checking', canCreateSession: false, reasonCode: '',
    reason: '正在检查 Remote Bridge 是否支持一次性链接会话。',
    bridgeVersion: '', bridgeProtocol: '', buildIdentity: '', checkedAt: ''
  };
  private pairingSecret: {
    sessionId: string;
    pollSecret: string;
    expectedStateVersion: number;
    expectedPairId: string;
    expectedGeneration: number;
    expectedBindingState: 'unpaired' | 'bound' | 'repair_required' | 'revoked';
    expiresAt: string;
    bridgeUrl: string;
  } | null = null;
  private pairingPollRunning = false;
  private unsubscribeTransport: (() => void) | null = null;
  private recoveredSessionKey = '';
  private recoveryRunning: Promise<void> | null = null;
  private readonly timing: ShellServiceTiming;
  private readonly remoteLifecycle: RemoteLifecycleApi;
  private revocationRetryRunning = false;
  private transportReconcileRunning = false;
  private transportReconcilePending = false;
  private lifecycleMutationRunning = false;

  constructor(
    private readonly database: CoreDatabase,
    private readonly adapter: ConnectorTransport & { onStateChanged?(listener: () => void): () => void },
    private readonly chat: ChatService,
    private readonly attachments?: AttachmentService,
    private readonly features?: FeaturePackageManager,
    timing: Partial<ShellServiceTiming> = {},
    remoteLifecycle: Partial<RemoteLifecycleApi> = {},
    private readonly interactionLogs?: InteractionLogService
  ) {
    this.timing = {
      now: timing.now || Date.now,
      sleep: timing.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      connectTimeoutMs: timing.connectTimeoutMs ?? 10 * 60_000,
      connectPollMs: timing.connectPollMs ?? 2_500
    };
    this.remoteLifecycle = {
      inspectBridge: remoteLifecycle.inspectBridge || inspectBridgePairingCapability,
      beginPairing: remoteLifecycle.beginPairing || beginPairingSession,
      pollPairing: remoteLifecycle.pollPairing || pollPairingSession,
      cancelPairing: remoteLifecycle.cancelPairing || cancelPairingSession,
      commitPairing: remoteLifecycle.commitPairing || commitPairingSession,
      revoke: remoteLifecycle.revoke || revokeBinding
    };
    const cached = database.getConnectionPayload<ConnectionSnapshot>();
    this.connection = cached?.transport === 'remote'
      ? cached
      : adapter.unavailableSnapshot('正在检查 Remote Connector 服务。');
    this.unsubscribeTransport = adapter.onStateChanged?.(() => {
      if (this.connection.connecting || this.pairingPollRunning || this.pairingSecret) return;
      this.scheduleTransportReconcile();
    }) || null;
  }

  private scheduleTransportReconcile(): void {
    this.transportReconcilePending = true;
    if (this.transportReconcileRunning) return;
    this.transportReconcileRunning = true;
    void (async () => {
      while (this.transportReconcilePending) {
        this.transportReconcilePending = false;
        try {
          await this.syncConnection();
          await this.reconcileConnectedSession();
        } catch (error) {
          this.connection = this.adapter.unavailableSnapshot(
            error instanceof Error ? error.message : 'Remote 状态调和失败。'
          );
          this.database.saveConnectionPayload(this.connection);
        }
        this.emitChanged();
      }
    })().catch(() => undefined).finally(() => {
      this.transportReconcileRunning = false;
      if (this.transportReconcilePending) this.scheduleTransportReconcile();
    });
  }

  async initialize(): Promise<void> {
    await this.refreshBridgePairingCapability();
    const pendingPairing = this.database.getPendingRemotePairing();
    if (pendingPairing) {
      if (pendingPairing.status === 'creating') {
        if (Date.parse(pendingPairing.expiresAt) <= this.timing.now()) {
          this.database.clearRemotePairingIntent(pendingPairing.sessionId);
          this.remotePairing = { state: 'expired', pairingCode: '', expiresAt: pendingPairing.expiresAt, message: '未完成的配对 reservation 已超过 Bridge 会话上限并安全释放。' };
        } else {
          this.remotePairing = { state: 'failed', pairingCode: '', expiresAt: pendingPairing.expiresAt, message: 'Shell 在创建 Bridge 会话期间中断；reservation 将保持失败关闭直到原始窗口结束。' };
        }
      } else if (pendingPairing.status === 'manual_cleanup_required') {
        this.remotePairing = { state: 'failed', pairingCode: '', expiresAt: pendingPairing.expiresAt, message: `配对 cleanup 凭据损坏且存在已知远端候选；需要 Bridge 管理员按 session hash ${pendingPairing.sessionIdHash} 执行 revoke/reconcile，当前连接无限期失败关闭。` };
      } else if (pendingPairing.status === 'manual_reconcile_required' || pendingPairing.status === 'corrupt') {
        this.remotePairing = {
          state: 'failed', pairingCode: '', expiresAt: pendingPairing.expiresAt,
          message: `配对 poll proof 不可恢复；本地 code 到期不能证明 Bridge ready candidate 已结束。需要 Bridge 管理员按 session hash ${pendingPairing.sessionIdHash} 确认候选已取消、recovery TTL 已过或已 revoke 后再清理并重新链接。`
        };
      } else if (pendingPairing.cleanupRequired) {
        this.remotePairing = { state: 'failed', pairingCode: '', expiresAt: pendingPairing.expiresAt, message: '正在清理未能接管的候选 binding；当前本地 binding 不会被覆盖。' };
        try { await this.retryPendingPairingCleanup(); } catch { /* background retry keeps durable cleanup proof */ }
      } else if (pendingPairing.commitRequired) {
        this.pairingSecret = { ...pendingPairing };
        this.remotePairing = { state: 'candidate', pairingCode: '', expiresAt: pendingPairing.expiresAt, message: '正在恢复已安全暂存的 Remote binding 提交。' };
        try { await this.completePendingPairingCommit(); } catch { /* durable staged token and proof remain for retry */ }
      } else {
        this.pairingSecret = { ...pendingPairing };
        this.remotePairing = {
          state: 'candidate', pairingCode: '', expiresAt: pendingPairing.expiresAt,
          message: Date.parse(pendingPairing.expiresAt) <= this.timing.now()
            ? '本地链接码窗口已过；正在向 Bridge 核验 ready/active recovery 状态。'
            : '正在恢复未完成的 Remote 配对验证。'
        };
      }
    }
    if (this.database.getPendingRemoteRevocation()) {
      await this.adapter.stop();
      try { await this.retryPendingRemoteRevocation(); } catch { /* backgroundTick retries without projecting bound */ }
      if (this.database.getPendingRemoteRevocation()) {
        this.connection = {
          ...this.adapter.unavailableSnapshot('解除绑定尚未获得 Bridge 确认；需要联网完成。'),
          bindingState: 'repair_required', status: 'repair_required', connected: false, connecting: false
        };
        this.database.saveConnectionPayload(this.connection);
      }
    } else {
      await this.syncConnection();
    }
    await this.reconcileConnectedSession();
    this.timer = setInterval(() => {
      void this.backgroundTick();
    }, 5_000);
    this.timer.unref();
    await this.backgroundTick();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
  }

  onChanged(listener: (snapshot: ShellSnapshot) => void): () => void {
    this.events.on('changed', listener);
    return () => this.events.off('changed', listener);
  }

  private emitChanged(): void {
    this.events.emit('changed', this.snapshot());
  }

  private safetySnapshot(): WorkspaceSafetySnapshot {
    const safety = this.database.getSafety();
    if (!safety.enabled) {
      return { ...safety, validForCurrentConnection: true, invalidReason: '' };
    }
    if (!this.connection.connected || safety.engagementId !== this.connection.engagementId) {
      return {
        ...safety,
        validForCurrentConnection: false,
        invalidReason: '安全锁绑定的 Pack 与当前连接不一致。'
      };
    }
    if (safety.connectorId !== this.connection.connectorId
      || safety.sessionGeneration !== this.connection.sessionGeneration
      || safety.authorityInstanceId !== String(this.connection.authorityInstanceId || '')
      || safety.tenantOrOrgId !== String(this.connection.tenantOrOrgId || '')
      || safety.packId !== String(this.connection.packId || '')) {
      return {
        ...safety,
        validForCurrentConnection: false,
        invalidReason: '安全锁绑定的 Connector 或权威 Pack 身份与当前连接不一致。'
      };
    }
    const current = this.workspaceDirectory.available ? this.workspaceDirectory.observation : null;
    if (!current) {
      return {
        ...safety,
        validForCurrentConnection: false,
        invalidReason: '当前没有可核验的权威 Workspace 层级。'
      };
    }
    const availableIds = new Set(current.workspaces.map((workspace) => workspace.id));
    const missing = safety.workspaceIds.filter((id) => !availableIds.has(id));
    if (missing.length > 0) {
      return {
        ...safety,
        validForCurrentConnection: false,
        invalidReason: '安全锁中的 Workspace 已不在当前权威目录内，请重新配置。'
      };
    }
    return { ...safety, validForCurrentConnection: true, invalidReason: '' };
  }

  snapshot(): ShellSnapshot {
    const keepalive = this.database.getKeepalive();
    const featureRuntime: FeatureRuntimeSnapshot = this.features?.snapshot({
      connection: this.connection,
      safetyLock: this.safetySnapshot()
    }) ?? {
      schemaVersion: 'omnia.feature-runtime-snapshot/v1',
      snapshotId: 'empty',
      stateVersion: 1,
      groups: [],
      navigation: [],
      selectedFeatureId: '',
      surface: null,
      messageCards: []
    };
    return {
      schemaVersion: 'omnia.shell-home/v1',
      generatedAt: utcNow(),
      productVersion: '0.4.9',
      featureCount: this.database.activeFeatureCount(),
      features: featureRuntime,
      connection: this.connection,
      keepalive: { ...keepalive, running: this.keepaliveRunning },
      workspaceDirectory: this.workspaceDirectory,
      safety: this.safetySnapshot(),
      chat: this.chat.snapshot(),
      preference: this.database.getPreference(),
      layout: this.database.getLayout()
      ,
      settingsLayout: this.database.getSettingsLayout(),
      settings: {
        ai: this.database.publicAiSettings(),
        connection: this.database.publicConnectionSettings()
      },
      bridgePairing: this.bridgePairing,
      remotePairing: this.remotePairing
    };
  }

  private async refreshBridgePairingCapability(): Promise<void> {
    const binding = this.database.getRemoteBinding();
    this.bridgePairing = await this.remoteLifecycle.inspectBridge({ bridgeUrl: binding.bridgeUrl });
  }

  selectFeature(featureId: string): ShellSnapshot {
    if (!this.features) throw new AppError('FEATURE.RUNTIME_UNAVAILABLE', 'Feature runtime is unavailable.');
    this.features.select(featureId);
    this.emitChanged();
    return this.snapshot();
  }

  async featureAction(request: FeatureActionRequest): Promise<ShellSnapshot> {
    if (!this.features) throw new AppError('FEATURE.RUNTIME_UNAVAILABLE', 'Feature runtime is unavailable.');
    if (this.safetySnapshot().enabled) {
      // Do not trust the directory captured when the dialog was opened. Every
      // Feature action under an enabled lock starts from live authority data;
      // mutation preparation receives only this revalidated durable scope.
      await this.refreshWorkspaceDirectory();
      const revalidatedSafety = this.safetySnapshot();
      if (!revalidatedSafety.validForCurrentConnection) {
        throw new AppError(
          'SAFETY.LIVE_REVALIDATION_FAILED',
          revalidatedSafety.invalidReason || '安全锁实时复核失败。'
        );
      }
    }
    await this.features.action(request, {
      connection: this.connection,
      safetyLock: this.safetySnapshot()
    });
    const eventIds = this.features.takePendingRuntimeEvents();
    if (eventIds.length > 0) {
      try {
        await this.refreshWorkspaceDirectory();
        this.features.completeRuntimeEvents(eventIds);
      } catch (error) {
        this.features.completeRuntimeEvents(eventIds, error instanceof Error ? error.message : 'Workspace refresh failed.');
      }
    }
    this.emitChanged();
    return this.snapshot();
  }

  async disposeFeatureRuntime(): Promise<void> {
    await this.features?.disposeRuntime();
  }

  private async syncConnection(): Promise<void> {
    this.connection = await this.adapter.load();
    const binding = this.database.getRemoteBinding();
    if (
      binding.bindingState === 'bound'
      && this.connection.status === 'repair_required'
      && this.connection.bindingState === 'repair_required'
    ) {
      this.database.markRemoteBindingRepairRequired(binding.stateVersion);
    }
    if (binding.bindingState === 'repair_required' && this.connection.status !== 'repair_required') {
      this.connection = {
        ...this.connection,
        bindingState: 'repair_required', status: 'repair_required', connected: false, connecting: false,
        message: 'Remote binding 需要人工修复或完成待处理的解除绑定；已失败关闭。'
      };
    }
    this.database.saveConnectionPayload(this.connection);
    if (!this.connection.connected) {
      this.recoveredSessionKey = '';
      this.workspaceDirectory = {
        available: false,
        reasonCode: 'not_connected',
        reason: this.connection.message || '请先连接 Omnia Pack。',
        observation: null
      };
    }
  }

  private connectedSessionKey(): string {
    if (!this.connection.connected || !this.connection.engagementId) return '';
    return [
      this.connection.connectorId,
      this.connection.sessionGeneration || 0,
      this.connection.engagementId
    ].join(':');
  }

  private async reconcileConnectedSession(force = false): Promise<void> {
    const targetKey = this.connectedSessionKey();
    if (!targetKey) {
      this.recoveredSessionKey = '';
      return;
    }
    if (!force && targetKey === this.recoveredSessionKey) return;
    if (this.recoveryRunning) {
      await this.recoveryRunning;
      if (!force && targetKey === this.recoveredSessionKey) return;
    }
    this.recoveryRunning = (async () => {
      await this.features?.initializeRuntime();
      try {
        await this.refreshWorkspaceDirectory();
      } catch {
        // Directory refresh already projected its real failure into
        // workspaceDirectory. A Connector/capability failure must not prevent
        // Shell startup or turn a valid transport session into a fake outage.
      }
      if (this.connectedSessionKey() === targetKey) this.recoveredSessionKey = targetKey;
    })();
    try {
      await this.recoveryRunning;
    } finally {
      this.recoveryRunning = null;
    }
  }

  async connect(): Promise<ShellSnapshot> {
    const binding = this.database.getRemoteBinding();
    if (!binding.remotePaired || binding.bindingState !== 'bound') {
      return this.beginRemotePairing({
        repair: binding.bindingState === 'repair_required',
        confirmed: binding.bindingState !== 'repair_required',
        expectedStateVersion: binding.stateVersion
      });
    }
    const attempt = ++this.connectAttempt;
    const deadline = this.timing.now() + this.timing.connectTimeoutMs;
    this.connection = {
      ...this.connection,
      status: 'bridge_connecting',
      connecting: true,
      message: '正在连接 Connector…'
    };
    this.emitChanged();
    try {
      let connected = await this.adapter.connect();
      while (!connected.connected && this.timing.now() < deadline) {
        if (this.cancelledConnectAttempt === attempt) break;
        if (['multiple_targets', 'identity_changed', 'connector_incompatible', 'repair_required'].includes(connected.status)) break;
        this.connection = connected;
        this.database.saveConnectionPayload(this.connection);
        this.emitChanged();
        await this.timing.sleep(this.timing.connectPollMs);
        connected = await this.adapter.load();
      }
      if (this.cancelledConnectAttempt === attempt) {
        this.connection = {
          ...await this.adapter.load(),
          status: 'cancelled', connecting: false, connected: false, message: '连接已取消。'
        };
        this.database.saveConnectionPayload(this.connection);
        return this.snapshot();
      }
      this.connection = connected.connected ? connected : {
        ...connected,
        status: this.timing.now() >= deadline ? 'timed_out' : connected.status,
        connecting: false,
        message: this.timing.now() >= deadline ? '等待目标 Pack 超时。请确认 Omnia 已登录并打开唯一目标 Pack。' : connected.message
      };
      this.database.saveConnectionPayload(this.connection);
    } catch (error) {
      await this.syncConnection();
      throw error;
    } finally {
      this.emitChanged();
    }
    if (this.connection.connected) {
      await this.reconcileConnectedSession(true);
    }
    return this.snapshot();
  }

  async cancelConnect(): Promise<ShellSnapshot> {
    if (!this.connection.connecting) return this.snapshot();
    this.cancelledConnectAttempt = this.connectAttempt;
    await this.adapter.cancelConnect();
    this.connection = {
      ...this.connection,
      status: 'cancelled',
      connecting: false,
      connected: false,
      message: '连接已取消。'
    };
    this.database.saveConnectionPayload(this.connection);
    this.emitChanged();
    return this.snapshot();
  }

  async refresh(): Promise<ShellSnapshot> {
    if (!this.connection.adapterAvailable) await this.syncConnection();
    if (!this.connection.adapterAvailable) {
      throw new AppError('CONNECTOR.UNAVAILABLE', this.connection.adapterReason || 'Remote Connector 服务不可用。', true);
    }
    try {
      const refresh = () => this.adapter.refresh();
      this.connection = this.interactionLogs
        ? await this.interactionLogs.run({
          plane: 'connector', component: 'remote-transport', surface: 'shell.session', action: 'session-refresh',
          failurePoint: 'connector.session.refresh'
        }, refresh)
        : await refresh();
      this.database.saveConnectionPayload(this.connection);
      if (this.connection.connected) await this.refreshWorkspaceDirectory();
      else {
        this.workspaceDirectory = {
          available: false,
          reasonCode: 'not_connected',
          reason: this.connection.message,
          observation: null
        };
      }
      return this.snapshot();
    } finally {
      this.emitChanged();
    }
  }

  async setKeepalive(enabled: boolean): Promise<ShellSnapshot> {
    if (enabled && !this.connection.connected) {
      throw new AppError('KEEPALIVE.NOT_CONNECTED', '请先连接 Omnia Pack，再开启保活。');
    }
    const now = utcNow();
    this.database.updateKeepalive({
      enabled,
      enabledAt: enabled ? (this.database.getKeepalive().enabledAt || now) : '',
      lastError: '',
      nextAttemptAt: enabled ? now : ''
    });
    this.emitChanged();
    if (enabled) await this.runKeepalive();
    return this.snapshot();
  }

  private async backgroundTick(): Promise<void> {
    const pendingPairing = this.database.getPendingRemotePairing();
    if (pendingPairing?.status === 'creating' && Date.parse(pendingPairing.expiresAt) <= this.timing.now()) {
      this.database.clearRemotePairingIntent(pendingPairing.sessionId);
      this.remotePairing = { state: 'expired', pairingCode: '', expiresAt: pendingPairing?.expiresAt || '', message: '损坏或未完成的配对 reservation 已超过原始有效期并安全清理。' };
      this.emitChanged();
    } else if (pendingPairing?.status === 'active' && pendingPairing.cleanupRequired) {
      try { await this.retryPendingPairingCleanup(); } catch { /* durable cleanup remains pending */ }
    } else if (pendingPairing?.status === 'active' && pendingPairing.commitRequired) {
      try { await this.completePendingPairingCommit(); } catch { /* durable staged commit remains pending */ }
    }
    if (this.database.getPendingRemoteRevocation() && !this.revocationRetryRunning) {
      try { await this.retryPendingRemoteRevocation(); } catch { /* durable pending state is the retry source */ }
    }
    if (this.pairingSecret) {
      try { await this.pollRemotePairing(); } catch { /* retry without consuming session */ }
    }
    const keepalive = this.database.getKeepalive();
    if (!keepalive.enabled || this.keepaliveRunning) return;
    const next = Date.parse(keepalive.nextAttemptAt);
    if (Number.isFinite(next) && next > Date.now()) return;
    await this.runKeepalive();
  }

  private async runKeepalive(): Promise<void> {
    if (this.keepaliveRunning) return;
    this.keepaliveRunning = true;
    const attemptedAt = utcNow();
    const current = this.database.getKeepalive();
    const nextAttemptAt = new Date(Date.now() + current.intervalSeconds * 1_000).toISOString();
    this.database.updateKeepalive({ lastAttemptAt: attemptedAt, nextAttemptAt, lastError: '' });
    this.emitChanged();
    try {
      if (!this.connection.connected) throw new AppError('KEEPALIVE.NOT_CONNECTED', '当前 Pack 连接已失效。');
      const refresh = () => this.adapter.refresh();
      this.connection = this.interactionLogs
        ? await this.interactionLogs.run({
          plane: 'connector', component: 'remote-transport', surface: 'shell.session', action: 'keepalive-refresh',
          failurePoint: 'connector.keepalive.refresh'
        }, refresh)
        : await refresh();
      this.database.saveConnectionPayload(this.connection);
      if (!this.connection.connected) throw new AppError('KEEPALIVE.REFRESH_FAILED', this.connection.message);
      this.database.updateKeepalive({ lastSuccessAt: utcNow(), lastError: '' });
    } catch (error) {
      this.database.updateKeepalive({
        lastError: error instanceof Error ? error.message : '保活失败。'
      });
    } finally {
      this.keepaliveRunning = false;
      this.emitChanged();
    }
  }

  async refreshWorkspaceDirectory(): Promise<ShellSnapshot> {
    if (!this.connection.connected || !this.connection.engagementId) {
      this.workspaceDirectory = {
        available: false,
        reasonCode: 'not_connected',
        reason: '请先连接 Omnia Pack。',
        observation: null
      };
      this.emitChanged();
      return this.snapshot();
    }
    const expectedAuthority = {
      connectorId: this.connection.connectorId,
      sessionGeneration: this.connection.sessionGeneration,
      authorityInstanceId: String(this.connection.authorityInstanceId || ''),
      tenantOrOrgId: String(this.connection.tenantOrOrgId || ''),
      packId: String(this.connection.packId || ''),
      engagementId: this.connection.engagementId
    };
    const previous = this.database.getLatestWorkspaceObservation(this.connection.engagementId);
    try {
      const lightRead = () => this.adapter.lightRead(expectedAuthority);
      const observation = this.interactionLogs
        ? await this.interactionLogs.run({
          plane: 'connector', component: 'remote-transport', surface: 'settings.safety', action: 'workspace-authority-read',
          failurePoint: 'connector.workspace_authority_read', details: { engagementId: this.connection.engagementId }
        }, lightRead)
        : await lightRead();
      this.database.saveWorkspaceObservation(observation);
      this.workspaceDirectory = {
        available: true,
        reasonCode: '',
        reason: '',
        observation
      };
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      this.workspaceDirectory = {
        available: false,
        reasonCode: appError?.code === 'WORKSPACE.AUTHORITY_HIERARCHY_UNAVAILABLE'
          ? 'authority_hierarchy_unavailable'
          : appError?.code === 'CONNECTOR.UNAVAILABLE'
            ? 'dependency_unavailable'
            : 'read_failed',
        reason: error instanceof Error ? error.message : '权威 Workspace 轻抓取失败。',
        observation: previous
      };
      this.emitChanged();
      throw error;
    }
    this.emitChanged();
    return this.snapshot();
  }

  async saveSafety(input: {
    enabled: boolean;
    workspaceIds: string[];
    expectedStateVersion: number;
  }): Promise<ShellSnapshot> {
    if (!this.connection.connected || !this.connection.engagementId) {
      throw new AppError('SAFETY.NOT_CONNECTED', '请先连接 Omnia Pack。');
    }
    const expectedConnection = [
      this.connection.connectorId,
      this.connection.sessionGeneration,
      this.connection.authorityInstanceId,
      this.connection.tenantOrOrgId,
      this.connection.packId,
      this.connection.engagementId
    ].join('|');
    if (input.enabled) {
      // Renderer selection is never authority. Re-read through the fixed
      // Connector interaction immediately before the Core validates and saves.
      await this.refreshWorkspaceDirectory();
      const currentConnection = [
        this.connection.connectorId,
        this.connection.sessionGeneration,
        this.connection.authorityInstanceId,
        this.connection.tenantOrOrgId,
        this.connection.packId,
        this.connection.engagementId
      ].join('|');
      if (!this.connection.connected || currentConnection !== expectedConnection) {
        throw new AppError('SAFETY.CONNECTION_CHANGED', '安全锁校验期间 Connector 或 Pack 身份发生变化，未保存。', true);
      }
    }
    const observation = this.workspaceDirectory.available ? this.workspaceDirectory.observation : null;
    if (!observation) {
      throw new AppError(
        'SAFETY.AUTHORITY_HIERARCHY_UNAVAILABLE',
        this.workspaceDirectory.reason || '当前无法取得权威 Section/Workspace 层级，安全锁失败关闭。'
      );
    }
    const uniqueIds = [...new Set(input.workspaceIds.map((value) => value.trim()).filter(Boolean))];
    if (input.enabled && uniqueIds.length === 0) {
      throw new AppError('SAFETY.EMPTY_SCOPE', '启用安全锁前至少选择一个 Workspace。');
    }
    const validIds = new Set(observation.workspaces.map((workspace) => workspace.id));
    if (uniqueIds.some((id) => !validIds.has(id))) {
      throw new AppError('SAFETY.INVALID_WORKSPACE', '安全锁包含不属于当前权威目录的 Workspace。');
    }
    this.database.saveSafety({
      enabled: input.enabled,
      connectorId: observation.connectorId,
      sessionGeneration: observation.sessionGeneration,
      authorityInstanceId: observation.authorityInstanceId,
      tenantOrOrgId: observation.tenantOrOrgId,
      packId: observation.packId,
      engagementId: this.connection.engagementId,
      workspaceIds: uniqueIds,
      authorityObservationId: observation.observationId,
      expectedStateVersion: input.expectedStateVersion
    });
    this.emitChanged();
    return this.snapshot();
  }

  assertWorkspaceTargetsAllowed(engagementId: string, workspaceIds: string[]): void {
    const safety = this.safetySnapshot();
    if (!safety.enabled || !safety.validForCurrentConnection) {
      throw new AppError('SAFETY.REQUIRED', safety.invalidReason || '安全锁未启用。');
    }
    if (safety.engagementId !== engagementId) {
      throw new AppError('SAFETY.ENGAGEMENT_MISMATCH', '安全锁与目标 Pack 不一致。');
    }
    const allowed = new Set(safety.workspaceIds);
    if (workspaceIds.length === 0 || workspaceIds.some((id) => !allowed.has(id))) {
      throw new AppError('SAFETY.WORKSPACE_BLOCKED', '目标 Workspace 不在安全锁允许范围内。');
    }
  }

  async sendMessage(input: string | { content: string; attachmentIds: string[] }): Promise<ShellSnapshot> {
    await this.chat.send(typeof input === 'string' ? { content: input, attachmentIds: [] } : input);
    this.emitChanged();
    return this.snapshot();
  }

  async importAttachments(filenames: string[]): Promise<ShellSnapshot> {
    if (!this.attachments) throw new AppError('CHAT.ATTACHMENTS_UNAVAILABLE', '附件服务不可用。');
    await this.attachments.importFiles(filenames);
    this.emitChanged();
    return this.snapshot();
  }

  async removeAttachment(id: string): Promise<ShellSnapshot> {
    if (!this.attachments) throw new AppError('CHAT.ATTACHMENTS_UNAVAILABLE', '附件服务不可用。');
    await this.attachments.remove(id);
    this.emitChanged();
    return this.snapshot();
  }

  previewAttachmentPath(id: string): string {
    if (!this.attachments) throw new AppError('CHAT.ATTACHMENTS_UNAVAILABLE', '附件服务不可用。');
    return this.attachments.previewPath(id);
  }

  saveComposerHeight(heightPx: number): ShellSnapshot {
    this.database.saveComposerHeight(heightPx);
    this.emitChanged();
    return this.snapshot();
  }

  saveAiSettings(input: Parameters<ChatService['saveSettings']>[0]): ShellSnapshot {
    this.chat.saveSettings(input);
    this.emitChanged();
    return this.snapshot();
  }

  async testAiProvider(): Promise<ShellSnapshot> {
    try {
      await this.chat.testProvider();
    } finally {
      this.emitChanged();
    }
    return this.snapshot();
  }

  async diagnoseRemoteConnection(): Promise<ShellSnapshot> {
    await Promise.all([
      this.syncConnection(),
      this.refreshBridgePairingCapability()
    ]);
    this.emitChanged();
    return this.snapshot();
  }

  async beginRemotePairing(input: { repair: boolean; confirmed?: boolean; expectedStateVersion: number }): Promise<ShellSnapshot> {
    if (this.lifecycleMutationRunning || this.pairingPollRunning) throw new AppError('REMOTE.LIFECYCLE_PENDING', '已有 Remote 生命周期变更正在进行。', true);
    this.lifecycleMutationRunning = true;
    let intentId = '';
    try {
      if (this.database.hasPendingRemoteLifecycleWork()) {
        throw new AppError('REMOTE.LIFECYCLE_PENDING', '已有配对或解除绑定流程正在恢复；请先完成或取消当前流程。', true);
      }
      let current = this.database.getRemoteBinding();
      if (current.stateVersion !== input.expectedStateVersion) throw new AppError('SETTINGS.CONFLICT', '连接状态已更新，请重试。', true);
      if (current.remotePaired && !input.repair) throw new AppError('REMOTE.ALREADY_PAIRED', '当前设备已绑定。');
      if (input.repair && input.confirmed !== true) throw new AppError('REMOTE.CONFIRMATION_REQUIRED', '重新配对前需要明确确认。');
      await this.refreshBridgePairingCapability();
      this.emitChanged();
      if (!this.bridgePairing.canCreateSession) {
        throw new AppError(
          this.bridgePairing.reasonCode || 'REMOTE.BRIDGE_UPGRADE_REQUIRED',
          this.bridgePairing.reason,
          this.bridgePairing.status === 'unreachable'
        );
      }
      const afterPreflight = this.database.getRemoteBinding();
      if (afterPreflight.stateVersion !== current.stateVersion) {
        throw new AppError('SETTINGS.CONFLICT', '连接状态在 Bridge 预检期间已更新，请重试。', true);
      }
      current = afterPreflight;
      const replacement = input.repair && current.bindingState === 'bound' ? current : null;
      const reservation = this.database.reserveRemotePairingIntent({
        bridgeUrl: current.bridgeUrl, expectedPairId: current.pairId, expectedGeneration: current.generation,
        expectedBindingState: current.bindingState, expectedStateVersion: current.stateVersion
      });
      intentId = reservation.intentId;
      const session = await this.remoteLifecycle.beginPairing({
        bridgeUrl: current.bridgeUrl, requestNonce: reservation.requestNonce,
        ...(replacement ? { replacementPairId: replacement.pairId, currentToken: replacement.remoteToken } : {})
      });
      this.database.finalizeRemotePairingIntent({
        intentId, sessionId: session.sessionId, pollSecret: session.pollSecret, expiresAt: session.expiresAt
      });
      intentId = '';
      this.pairingSecret = {
        sessionId: session.sessionId, pollSecret: session.pollSecret, expectedStateVersion: current.stateVersion,
        expectedPairId: current.pairId, expectedGeneration: current.generation,
        expectedBindingState: current.bindingState, expiresAt: session.expiresAt, bridgeUrl: current.bridgeUrl
      };
      this.remotePairing = {
        state: 'waiting', pairingCode: session.pairingCode, expiresAt: session.expiresAt,
        message: '请在公司电脑 Remote Connector 中输入该 4 位数字链接码（2 分钟内有效）。'
      };
      this.emitChanged();
      return this.snapshot();
    } catch (error) {
      if (intentId) this.database.clearRemotePairingIntent(intentId);
      throw error;
    } finally {
      this.lifecycleMutationRunning = false;
    }
  }

  async pollRemotePairing(): Promise<ShellSnapshot> {
    if (this.lifecycleMutationRunning || this.pairingPollRunning) return this.snapshot();
    this.pairingPollRunning = true;
    try {
    const durable = this.database.getPendingRemotePairing();
    if (durable?.cleanupRequired) {
      await this.retryPendingPairingCleanup();
      return this.snapshot();
    }
    if (durable?.commitRequired) {
      await this.completePendingPairingCommit();
      return this.snapshot();
    }
    if (!this.pairingSecret) return this.snapshot();
    const pending = this.pairingSecret;
    const result = await this.remoteLifecycle.pollPairing({
      bridgeUrl: pending.bridgeUrl,
      sessionId: pending.sessionId,
      pollSecret: pending.pollSecret
    });
    if (result.state === 'expired') {
      this.remotePairing = { state: 'expired', pairingCode: '', expiresAt: result.expiresAt || '', message: '链接码已过期，请重新生成。' };
      this.pairingSecret = null;
      this.database.clearPendingRemotePairing();
      await this.adapter.stop();
      await this.adapter.start();
      await this.syncConnection();
    } else if (['candidate', 'matched'].includes(result.state) && result.token && result.pairId && result.connector && result.generation) {
      const beforeSave = this.database.getRemoteBinding();
      if (
        beforeSave.pairId !== pending.expectedPairId
        || beforeSave.generation !== pending.expectedGeneration
        || beforeSave.bindingState !== pending.expectedBindingState
      ) {
        this.database.stagePendingPairingCleanup(pending.sessionId, result.pairId, result.token, result.generation);
        this.remotePairing = { state: 'failed', pairingCode: '', expiresAt: pending.expiresAt, message: '本地 binding 在配对期间已变化；正在撤销未接管候选，未覆盖当前身份。' };
        await this.retryPendingPairingCleanup();
        return this.snapshot();
      }
      this.database.stagePendingPairingCommit({
        sessionId: pending.sessionId, pairId: result.pairId, token: result.token,
        generation: result.generation, connectorId: result.connector.connectorId,
        connectorName: result.connector.name, connectorVersion: result.connector.version
      });
      this.remotePairing = { state: 'candidate', pairingCode: '', expiresAt: result.expiresAt || pending.expiresAt, message: 'Connector 已验证；正在原子提交 Remote binding。' };
      await this.completePendingPairingCommit();
    } else {
      this.remotePairing = { ...this.remotePairing, state: result.state, message: result.state === 'candidate' ? 'Connector 已消费链接码，正在验证协议与在线健康。' : this.remotePairing.message };
    }
    this.emitChanged();
    return this.snapshot();
    } finally {
      this.pairingPollRunning = false;
    }
  }

  async cancelRemotePairing(): Promise<ShellSnapshot> {
    if (this.lifecycleMutationRunning || this.pairingPollRunning) {
      throw new AppError('REMOTE.LIFECYCLE_PENDING', '配对状态正在变更或核验，不能并发取消。', true);
    }
    this.lifecycleMutationRunning = true;
    try {
    const pending = this.pairingSecret || this.database.getPendingRemotePairing();
    if (pending && 'status' in pending && pending.status !== 'active') {
      const sessionIdHash = 'sessionIdHash' in pending ? String(pending.sessionIdHash || '') : '';
      throw new AppError(
        'REMOTE.PAIRING_RECOVERY_REQUIRED',
        pending.status === 'manual_cleanup_required'
          ? `候选清理凭据损坏；必须由 Bridge 管理员按 session hash ${sessionIdHash} reconcile/revoke 后才能解除失败关闭。`
          : `配对 proof 不可恢复；必须由 Bridge 管理员按 session hash ${sessionIdHash} 确认候选已取消、recovery TTL 已过或已 revoke 后才能清理。`
      );
    }
    if (pending) {
      const state = await this.remoteLifecycle.cancelPairing({
        bridgeUrl: pending.bridgeUrl, sessionId: pending.sessionId, pollSecret: pending.pollSecret
      });
      if (state === 'matched') {
        this.pairingSecret = pending;
        this.remotePairing = { state: 'candidate', pairingCode: '', expiresAt: pending.expiresAt, message: '候选已激活，正在完成安全 binding 持久化。' };
        this.lifecycleMutationRunning = false;
        return this.pollRemotePairing();
      }
    }
    this.pairingSecret = null;
    this.database.clearPendingRemotePairing();
    this.remotePairing = { state: 'idle', pairingCode: '', expiresAt: '', message: '已取消当前链接码会话；可以生成新码。' };
    await this.adapter.stop();
    await this.adapter.start();
    await this.syncConnection();
    this.emitChanged();
    return this.snapshot();
    } finally {
      this.lifecycleMutationRunning = false;
    }
  }

  async revokeRemoteBinding(input: { confirmed: boolean; expectedStateVersion: number }): Promise<ShellSnapshot> {
    if (this.lifecycleMutationRunning || this.pairingPollRunning) throw new AppError('REMOTE.LIFECYCLE_PENDING', '已有 Remote 生命周期变更正在进行。', true);
    this.lifecycleMutationRunning = true;
    try {
      if (input.confirmed !== true) throw new AppError('REMOTE.CONFIRMATION_REQUIRED', '解除绑定前需要明确确认。');
      if (this.database.hasPendingRemoteLifecycleWork()) throw new AppError('REMOTE.LIFECYCLE_PENDING', '已有配对或解除绑定流程正在恢复；不能并发启动解除绑定。', true);
      const current = this.database.getRemoteBinding();
      if (!current.remotePaired || !current.pairId) throw new AppError('REMOTE.NOT_PAIRED', '当前没有可解除的 Remote binding。');
      if (current.stateVersion !== input.expectedStateVersion) throw new AppError('SETTINGS.CONFLICT', '连接状态已更新，请重试。', true);
      this.database.beginRemoteRevocation(current.stateVersion);
      await this.adapter.stop();
      this.connection = {
        ...this.adapter.unavailableSnapshot('正在等待 Bridge 确认解除绑定；在确认前不会恢复连接。'),
        bindingState: 'repair_required', status: 'repair_required', connected: false, connecting: false
      };
      this.database.saveConnectionPayload(this.connection);
      this.emitChanged();
      await this.retryPendingRemoteRevocation();
      return this.snapshot();
    } finally {
      this.lifecycleMutationRunning = false;
    }
  }

  private async retryPendingRemoteRevocation(): Promise<void> {
    if (this.revocationRetryRunning) return;
    const pending = this.database.getPendingRemoteRevocation();
    if (!pending) return;
    if (pending.status === 'manual_revoke_required' || !pending.token) {
      this.connection = {
        ...this.adapter.unavailableSnapshot('解绑凭据不可恢复；需要 Bridge 管理员按 pair 审计执行手工 revoke/reconcile。'),
        bindingState: 'repair_required', status: 'repair_required', connected: false, connecting: false
      };
      this.database.saveConnectionPayload(this.connection);
      this.emitChanged();
      return;
    }
    this.revocationRetryRunning = true;
    try {
      try {
        await this.remoteLifecycle.revoke({ bridgeUrl: pending.bridgeUrl, pairId: pending.pairId, token: pending.token });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'REMOTE.REVOKE_CREDENTIAL_INVALID') {
          this.database.noteRemoteRevocationFailure(error instanceof Error ? error.message : 'Bridge revoke failed.');
          this.connection = {
            ...this.adapter.unavailableSnapshot('解除绑定尚未获得 Bridge 确认；需要联网完成。'),
            bindingState: 'repair_required', status: 'repair_required', connected: false, connecting: false
          };
          this.database.saveConnectionPayload(this.connection);
          this.emitChanged();
          throw error;
        }
        // For an explicit durable revocation request, 401/403 means the old
        // credential is already unusable and therefore completes fail-closed.
      }
      this.database.completeRemoteRevocation();
      this.connection = {
        ...this.adapter.unavailableSnapshot('Remote binding 已解除。'),
        bindingState: 'revoked', status: 'not_configured', connected: false, connecting: false
      };
      this.database.saveConnectionPayload(this.connection);
      this.emitChanged();
    } finally {
      this.revocationRetryRunning = false;
    }
  }

  private async retryPendingPairingCleanup(): Promise<void> {
    const pending = this.database.getPendingRemotePairing();
    if (!pending?.cleanupRequired || !pending.matchedPairId || !pending.matchedToken) return;
    try {
      await this.remoteLifecycle.revoke({
        bridgeUrl: pending.bridgeUrl, pairId: pending.matchedPairId, token: pending.matchedToken
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'REMOTE.REVOKE_CREDENTIAL_INVALID') {
        this.remotePairing = { state: 'failed', pairingCode: '', expiresAt: pending.expiresAt, message: '候选 cleanup 尚未获得 Bridge 确认；已保留加密恢复证明并失败关闭。' };
        this.emitChanged();
        throw error;
      }
    }
    this.database.clearPendingRemotePairing();
    this.pairingSecret = null;
    this.remotePairing = { state: 'failed', pairingCode: '', expiresAt: '', message: '未接管候选已安全撤销；当前本地 binding 保持不变。' };
    this.emitChanged();
  }

  private async completePendingPairingCommit(): Promise<void> {
    const pending = this.database.getPendingRemotePairing();
    if (!pending?.commitRequired || !pending.matchedPairId || !pending.matchedToken) return;
    const current = this.database.getRemoteBinding();
    if (
      current.pairId !== pending.expectedPairId
      || current.generation !== pending.expectedGeneration
      || current.bindingState !== pending.expectedBindingState
    ) {
      this.database.stagePendingPairingCleanup(
        pending.sessionId, pending.matchedPairId, pending.matchedToken, pending.matchedGeneration
      );
      this.remotePairing = { state: 'failed', pairingCode: '', expiresAt: pending.expiresAt, message: '本地 binding 在提交前已变化；正在撤销候选，未覆盖当前身份。' };
      await this.retryPendingPairingCleanup();
      return;
    }
    const remote = await this.remoteLifecycle.pollPairing({
      bridgeUrl: pending.bridgeUrl, sessionId: pending.sessionId, pollSecret: pending.pollSecret
    });
    if (
      !['candidate', 'matched'].includes(remote.state)
      || remote.pairId !== pending.matchedPairId
      || remote.generation !== pending.matchedGeneration
    ) {
      throw new AppError(
        'REMOTE.PAIRING_COMMIT_RECOVERY_MISMATCH',
        remote.state === 'expired'
          ? 'Bridge 配对恢复窗口已过；已暂存凭据保持失败关闭，需要人工 reconcile。'
          : 'Bridge 配对恢复身份与本地暂存候选不一致；保持失败关闭。'
      );
    }
    if (remote.state === 'candidate') {
      await this.remoteLifecycle.commitPairing({
        bridgeUrl: pending.bridgeUrl, sessionId: pending.sessionId, pollSecret: pending.pollSecret
      });
    }
    try {
      this.database.promotePendingPairingCommit(pending.sessionId, BRIDGE_PROTOCOL);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SETTINGS.CONFLICT') {
        this.database.stagePendingPairingCleanup(
          pending.sessionId, pending.matchedPairId, pending.matchedToken, pending.matchedGeneration
        );
        this.remotePairing = { state: 'failed', pairingCode: '', expiresAt: pending.expiresAt, message: 'Bridge 已提交候选但本地 binding 同时变化；正在撤销新 binding，未覆盖当前身份。' };
        await this.retryPendingPairingCleanup();
        return;
      }
      throw error;
    }
    this.remotePairing = { state: 'matched', pairingCode: '', expiresAt: '', message: 'Remote Connector 已验证并绑定。' };
    this.pairingSecret = null;
    await this.adapter.stop();
    await this.adapter.start();
    const transportDeadline = this.timing.now() + 20_000;
    do {
      await this.syncConnection();
      if (this.connection.connectorOnline || !this.connection.protocolCompatible) break;
      await this.timing.sleep(250);
    } while (this.timing.now() < transportDeadline);
    if (!this.connection.connectorOnline) {
      throw new AppError('REMOTE.CONNECTOR_OFFLINE', this.connection.message || 'Remote Connector 离线。', true);
    }
    await this.connect();
    this.emitChanged();
  }

  saveScale(percent: number, expectedStateVersion: number): ShellSnapshot {
    this.database.savePreference(percent, expectedStateVersion);
    this.emitChanged();
    return this.snapshot();
  }

  saveLayout(
    featureNavigationBasisPoints: number,
    featureNavigationCollapsed: boolean,
    expectedStateVersion: number
  ): ShellSnapshot {
    this.database.saveLayout(featureNavigationBasisPoints, featureNavigationCollapsed, expectedStateVersion);
    this.emitChanged();
    return this.snapshot();
  }

  saveSettingsLayout(settingsNavigationBasisPoints: number, expectedStateVersion: number): ShellSnapshot {
    this.database.saveSettingsLayout(settingsNavigationBasisPoints, expectedStateVersion);
    this.emitChanged();
    return this.snapshot();
  }
}
