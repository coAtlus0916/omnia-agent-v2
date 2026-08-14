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
  BRIDGE_PROTOCOL,
  type BridgePairingCapabilityInspection,
  type BridgePairingPollResponse,
  type BridgePairingSessionResponse
} from '../../shared/bridge-contracts.js';
import type { CoreDatabase } from '../database.js';
import type { AttachmentService } from './attachment-service.js';
import type { ChatService } from './chat-service.js';
import type { FeaturePackageManager } from '../features/package-manager.js';
import type { InteractionLogService } from './interaction-log-service.js';
import type { LogExportService } from './log-export-service.js';

const utcNow = () => new Date().toISOString();

export interface ShellServiceTiming {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  connectTimeoutMs: number;
  connectPollMs: number;
  connectStartupTimeoutMs: number;
}

const CONNECT_WAITING_STATES = new Set<ConnectionSnapshot['status']>([
  'browser_starting',
  'waiting_login',
  'waiting_pack',
  'waiting_authorization',
  'identifying_pack',
  'target_closed'
]);

const CONNECT_TERMINAL_STATES = new Set<ConnectionSnapshot['status']>([
  'not_configured',
  'connector_offline',
  'connector_incompatible',
  'multiple_targets',
  'identity_changed',
  'repair_required',
  'error'
]);

const CONNECT_PASSIVE_RECONCILE_STATES = new Set<ConnectionSnapshot['status']>([
  ...CONNECT_WAITING_STATES,
  // A remote Agent can recover independently after a workstation restart or
  // control-plane outage. Keep one passive status reconciliation in flight so
  // the already-visible Shell observes that recovery without a Shell restart.
  'connector_offline',
  'error'
]);

interface RemoteLifecycleApi {
  inspectBridge(input: { bridgeUrl: string }): Promise<BridgePairingCapabilityInspection>;
  beginPairing(input: { bridgeUrl: string; requestNonce: string; replacementPairId?: string; currentToken?: string }): Promise<BridgePairingSessionResponse>;
  pollPairing(input: { bridgeUrl: string; sessionId: string; pollSecret: string }): Promise<BridgePairingPollResponse>;
  cancelPairing(input: { bridgeUrl: string; sessionId: string; pollSecret: string }): Promise<'waiting' | 'candidate' | 'matched' | 'expired'>;
  commitPairing(input: { bridgeUrl: string; sessionId: string; pollSecret: string }): Promise<void>;
  revoke(input: { bridgeUrl: string; pairId: string; token: string }): Promise<void>;
}

const retiredRemoteLifecycle = (): never => {
  throw new AppError('CONNECTOR_NEXT.ENROLLMENT_MANAGED_EXTERNALLY', 'Legacy Remote Connector lifecycle has been retired.');
};

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
  private connectRunning: Promise<void> | null = null;
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
  private workspaceRefreshRunning: { key: string; promise: Promise<ShellSnapshot> } | null = null;
  private lastWorkspaceRecoveryAt = 0;

  constructor(
    private readonly database: CoreDatabase,
    private readonly adapter: ConnectorTransport & { onStateChanged?(listener: () => void): () => void },
    private readonly chat: ChatService,
    private readonly attachments?: AttachmentService,
    private readonly features?: FeaturePackageManager,
    timing: Partial<ShellServiceTiming> = {},
    remoteLifecycle: Partial<RemoteLifecycleApi> = {},
    private readonly interactionLogs?: InteractionLogService,
    private readonly productVersion = '0.5.0',
    private readonly logExports?: LogExportService
  ) {
    this.timing = {
      now: timing.now || Date.now,
      sleep: timing.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      connectTimeoutMs: timing.connectTimeoutMs ?? 10 * 60_000,
      connectPollMs: timing.connectPollMs ?? 2_500,
      connectStartupTimeoutMs: timing.connectStartupTimeoutMs ?? 90_000
    };
    this.remoteLifecycle = {
      inspectBridge: remoteLifecycle.inspectBridge || (async () => retiredRemoteLifecycle()),
      beginPairing: remoteLifecycle.beginPairing || (async () => retiredRemoteLifecycle()),
      pollPairing: remoteLifecycle.pollPairing || (async () => retiredRemoteLifecycle()),
      cancelPairing: remoteLifecycle.cancelPairing || (async () => retiredRemoteLifecycle()),
      commitPairing: remoteLifecycle.commitPairing || (async () => retiredRemoteLifecycle()),
      revoke: remoteLifecycle.revoke || (async () => retiredRemoteLifecycle())
    };
    const cached = database.getConnectionPayload<ConnectionSnapshot>();
    const expectedAdapter = adapter.bindingMode === 'connector_next_enrollment' ? 'connector_next_v3' : 'v5_remote_connector';
    this.connection = cached?.transport === 'remote' && cached.adapter === expectedAdapter
      ? cached
      : adapter.unavailableSnapshot('正在检查 Remote Connector 服务。');
    this.unsubscribeTransport = adapter.onStateChanged?.(() => {
      if (this.connection.connecting || this.pairingPollRunning || this.pairingSecret) return;
      this.scheduleTransportReconcile();
    }) || null;
    this.chat.setChangeListener(() => this.emitChanged());
    // Read-only Shell chat tools observe the live connection and workspace
    // authority projection lazily, so a tool answer always reflects the current
    // state without the Shell exposing secrets or a Connector write path.
    this.chat.setToolContextProvider(() => ({
      connection: this.connection,
      workspaceDirectory: this.workspaceDirectory
    }));
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

  private passiveConnectionSnapshot(observed: ConnectionSnapshot): ConnectionSnapshot {
    // Connector `connecting` describes the remote workstation session, while
    // Shell `connecting` owns the lifetime of an explicit user Connect action.
    // A passive load must never turn a login/Pack/Authorization wait into a
    // cancellable local action or hide the Connect button.
    return observed.connecting ? { ...observed, connecting: false } : observed;
  }

  private usesLegacyRemoteLifecycle(): boolean {
    return false;
  }

  async initialize(): Promise<void> {
    if (!this.usesLegacyRemoteLifecycle()) {
      this.bridgePairing = {
        status: 'supported', canCreateSession: false,
        reasonCode: 'CONNECTOR_NEXT.ENROLLMENT_MANAGED_EXTERNALLY',
        reason: 'Connector Next enrollment is managed by the independent v3 control plane; legacy Bridge pairing is not applicable.',
        bridgeVersion: '', bridgeProtocol: '', buildIdentity: 'connector-next-v3', checkedAt: utcNow()
      };
      this.remotePairing = {
        state: 'matched', pairingCode: '', expiresAt: '',
        message: 'Connector Next uses exact Agent/device/instance enrollment; legacy Remote pairing is not used.'
      };
      await this.syncConnection();
      await this.reconcileConnectedSession();
      this.timer = setInterval(() => { void this.backgroundTick(); }, 5_000);
      this.timer.unref();
      await this.backgroundTick();
      return;
    }
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

  private emitChanged(snapshot = this.snapshot()): ShellSnapshot {
    this.events.emit('changed', snapshot);
    return snapshot;
  }

  private safetySnapshot(): WorkspaceSafetySnapshot {
    const safety = this.database.getSafety();
    const current = this.workspaceDirectory.available ? this.workspaceDirectory.observation : null;
    const globalSectionIds = new Set(safety.globalSectionIds);
    const currentGlobalWorkspaceIds = current && safety.globalEnabled
      ? current.workspaces.filter((workspace) => workspace.parentSectionId && globalSectionIds.has(workspace.parentSectionId)).map((workspace) => workspace.id).sort()
      : [];
    const projected = safety;
    if (!safety.enabled) {
      return { ...projected, validForCurrentConnection: true, invalidReason: '', recovery: 'none' };
    }
    if (!this.connection.connected) {
      return {
        ...projected,
        validForCurrentConnection: false,
        invalidReason: `Remote Connector 或 Pack 当前未连接${this.connection.message ? `：${this.connection.message}` : ''}。安全锁已保留，恢复连接前将继续失败关闭。`,
        recovery: 'none'
      };
    }
    if (safety.engagementId !== this.connection.engagementId) {
      return {
        ...projected,
        validForCurrentConnection: false,
        invalidReason: '安全锁绑定的 Pack 与当前已连接 Pack 不一致，请切回原 Pack 或重新配置安全锁。',
        recovery: 'reconfigure'
      };
    }
    const sameAuthority = safety.connectorId === this.connection.connectorId
      && safety.authorityInstanceId === String(this.connection.authorityInstanceId || '')
      && safety.tenantOrOrgId === String(this.connection.tenantOrOrgId || '')
      && safety.packId === String(this.connection.packId || '');
    if (sameAuthority && safety.sessionGeneration !== Number(this.connection.sessionGeneration || 0)) {
      return {
        ...projected,
        validForCurrentConnection: false,
        invalidReason: 'Remote Connector 已在线且仍为同一 Pack，但连接 generation 已变化。安全锁已保留；请用当前实时 Workspace 目录重新验证并重绑，完成前删除继续失败关闭。',
        recovery: 'rebind'
      };
    }
    if (!sameAuthority) {
      return {
        ...projected,
        validForCurrentConnection: false,
        invalidReason: '安全锁绑定的 Connector 或权威 Pack 身份与当前已连接会话不一致；不能直接重绑，请核对当前 Pack 后重新配置。',
        recovery: 'reconfigure'
      };
    }
    if (!current) {
      const cached = this.workspaceDirectory.observation;
      const reason = String(this.workspaceDirectory.reason || '').trim();
      return {
        ...projected,
        validForCurrentConnection: false,
        invalidReason: cached
          ? `当前 Workspace 实时复核暂不可用${reason ? `：${reason}` : ''}。列表为上次成功缓存；安全锁仍保留，但删除会在自动重读成功前失败关闭。`
          : `当前没有可核验的实时 Workspace 目录${reason ? `：${reason}` : ''}。`,
        recovery: 'none'
      };
    }
    const availableIds = new Set(current.workspaces.map((workspace) => workspace.id));
    const missing = safety.workspaceIds.filter((id) => !availableIds.has(id));
    if (missing.length > 0) {
      return {
        ...projected,
        validForCurrentConnection: false,
        invalidReason: '安全锁中的 Workspace 已不在当前权威目录内，请重新配置。',
        recovery: 'reconfigure'
      };
    }
    const availableSectionIds = new Set(current.sections.map((section) => section.id));
    if (safety.globalEnabled && (safety.globalSectionIds.length === 0
      || safety.globalSectionIds.some((id) => !availableSectionIds.has(id)))) {
      return {
        ...projected,
        validForCurrentConnection: false,
        invalidReason: '全局安全锁中的所在部分已不属于当前权威目录，请重新配置。',
        recovery: 'reconfigure'
      };
    }
    if (safety.globalEnabled && (currentGlobalWorkspaceIds.length !== safety.globalWorkspaceIds.length
      || currentGlobalWorkspaceIds.some((id, index) => id !== [...safety.globalWorkspaceIds].sort()[index]))) {
      return {
        ...projected,
        validForCurrentConnection: false,
        invalidReason: '全局安全锁所在部分的 Workspace 成员已经变化，请重新保存后再执行删除。',
        recovery: 'reconfigure'
      };
    }
    return { ...projected, validForCurrentConnection: true, invalidReason: '', recovery: 'none' };
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
      productVersion: this.productVersion,
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
        connection: this.database.publicConnectionSettings(),
        logs: this.logExports?.snapshot() || {
          state: 'empty', available: false, exportId: '', fileName: '', generatedAt: '', localDate: '',
          size: 0, sha256: '', entryCount: 0, warnings: []
        }
      },
      bridgePairing: this.bridgePairing,
      remotePairing: this.remotePairing
    };
  }

  private async refreshBridgePairingCapability(): Promise<void> {
    if (!this.usesLegacyRemoteLifecycle()) return;
    const binding = this.database.getRemoteBinding();
    this.bridgePairing = await this.remoteLifecycle.inspectBridge({ bridgeUrl: binding.bridgeUrl });
  }

  selectFeature(featureId: string): ShellSnapshot {
    if (!this.features) throw new AppError('FEATURE.RUNTIME_UNAVAILABLE', 'Feature runtime is unavailable.');
    this.features.select(featureId);
    return this.emitChanged();
  }

  async featureAction(request: FeatureActionRequest): Promise<ShellSnapshot> {
    if (!this.features) throw new AppError('FEATURE.RUNTIME_UNAVAILABLE', 'Feature runtime is unavailable.');
    const dependencies = this.features.actionDependencies(request);
    if (dependencies.includes('safety_lock') && this.safetySnapshot().enabled) {
      // Do not trust the directory captured when the dialog was opened. Actions
      // that declare the safety_lock dependency start from live authority data;
      // local-only actions remain local and avoid this remote round trip.
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
    return this.emitChanged();
  }

  async disposeFeatureRuntime(): Promise<void> {
    await this.features?.disposeRuntime();
  }

  private async syncConnection(): Promise<void> {
    const observed = await this.adapter.load();
    // A reconcile already in flight when the user clicks Connect must not
    // overwrite that explicit attempt with a passive snapshot.
    if (this.connectRunning) return;
    this.connection = this.passiveConnectionSnapshot(observed);
    if (this.usesLegacyRemoteLifecycle()) {
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
      this.connection.authorityInstanceId || '',
      this.connection.tenantOrOrgId || '',
      this.connection.packId || '',
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
    if (this.usesLegacyRemoteLifecycle()) {
      const binding = this.database.getRemoteBinding();
      if (!binding.remotePaired || binding.bindingState !== 'bound') {
        return this.beginRemotePairing({
          repair: binding.bindingState === 'repair_required',
          confirmed: binding.bindingState !== 'repair_required',
          expectedStateVersion: binding.stateVersion
        });
      }
    }
    if (this.connection.connecting && this.connectRunning) return this.snapshot();
    const attempt = ++this.connectAttempt;
    const deadline = this.timing.now() + this.timing.connectTimeoutMs;
    this.connection = {
      ...this.connection,
      status: 'bridge_connecting',
      connecting: true,
      connected: false,
      authorityInstanceId: '',
      tenantOrOrgId: '',
      packId: '',
      engagementId: '',
      engagementName: '',
      clientName: '',
      message: '正在连接 Connector…'
    };
    this.database.saveConnectionPayload(this.connection);
    this.emitChanged();
    const running = this.runConnectAttempt(attempt, deadline);
    this.connectRunning = running;
    void running.finally(() => {
      if (this.connectRunning === running) this.connectRunning = null;
    }).catch(() => undefined);
    return this.snapshot();
  }

  private connectAttemptCancelled(attempt: number): boolean {
    return this.cancelledConnectAttempt === attempt || this.connectAttempt !== attempt;
  }

  private projectConnectState(attempt: number, next: ConnectionSnapshot): boolean {
    if (this.connectAttemptCancelled(attempt)) return false;
    this.connection = next;
    this.database.saveConnectionPayload(this.connection);
    this.emitChanged();
    return true;
  }

  private async runConnectAttempt(attempt: number, deadline: number): Promise<void> {
    const startupDeadline = Math.min(deadline, this.timing.now() + this.timing.connectStartupTimeoutMs);
    let reachedWaitingState = false;
    let next: ConnectionSnapshot;
    try {
      const observed = await this.adapter.load();
      if (this.connectAttemptCancelled(attempt)) return;
      // An explicit Connect click is also the user's request to rebind an
      // already-open workstation target. Waiting states must therefore reach
      // Connector.connect() once: that path may focus the existing target and
      // recapture a newly issued Page Authorization without reloading it.
      // Passive startup/background probes continue to use load() only.
      if (!observed.connected && CONNECT_WAITING_STATES.has(observed.status)) {
        if (!this.projectConnectState(attempt, { ...observed, connecting: true, connected: false })) return;
      }
      next = observed.connected || CONNECT_TERMINAL_STATES.has(observed.status)
        ? observed
        : await this.adapter.connect();
    } catch (error) {
      if (this.connectAttemptCancelled(attempt)) return;
      const code = error instanceof AppError ? error.code : '';
      if (code !== 'REMOTE.TIMEOUT') {
        const unavailable = this.adapter.unavailableSnapshot(
          error instanceof Error ? error.message : 'Remote Connect 启动失败。'
        );
        this.projectConnectState(attempt, {
          ...unavailable,
          status: code === 'REMOTE.CONNECTOR_OFFLINE' ? 'connector_offline' : unavailable.status,
          connecting: false,
          connected: false
        });
        return;
      }
      next = {
        ...this.connection,
        status: 'bridge_connecting',
        connecting: true,
        connected: false,
        message: 'Remote Connect 启动命令已达到阶段时限；正在读取 Connector 的真实启动状态。'
      };
    }

    while (!this.connectAttemptCancelled(attempt)) {
      if (next.connected) {
        if (!this.projectConnectState(attempt, next)) return;
        await this.reconcileConnectedSession(true);
        return;
      }

      if (CONNECT_TERMINAL_STATES.has(next.status)) {
        this.projectConnectState(attempt, { ...next, connecting: false, connected: false });
        return;
      }

      if (CONNECT_WAITING_STATES.has(next.status)) reachedWaitingState = true;
      const activeDeadline = reachedWaitingState ? deadline : startupDeadline;
      if (this.timing.now() >= activeDeadline) {
        await this.adapter.cancelConnect().catch(() => undefined);
        this.projectConnectState(attempt, {
          ...next,
          status: 'timed_out',
          connecting: false,
          connected: false,
          message: reachedWaitingState
            ? '等待目标 Pack 超时。请确认 Omnia 已登录并打开唯一目标 Pack。'
            : 'Remote Connect 启动阶段超时；Connector 未返回可继续等待的登录或 Pack 状态。'
        });
        return;
      }

      if (!this.projectConnectState(attempt, { ...next, connecting: true, connected: false })) return;
      await this.timing.sleep(this.timing.connectPollMs);
      if (this.connectAttemptCancelled(attempt)) return;
      try {
        next = await this.adapter.load();
      } catch (error) {
        const unavailable = this.adapter.unavailableSnapshot(
          error instanceof Error ? error.message : 'Remote Connector 状态读取失败。'
        );
        this.projectConnectState(attempt, {
          ...unavailable,
          status: unavailable.connectorOnline ? 'error' : 'connector_offline',
          connecting: false,
          connected: false
        });
        return;
      }
    }
  }

  async cancelConnect(): Promise<ShellSnapshot> {
    if (!this.connection.connecting) return this.snapshot();
    this.cancelledConnectAttempt = this.connectAttempt;
    this.connection = {
      ...this.connection,
      status: 'cancelled',
      connecting: false,
      connected: false,
      message: '连接已取消。'
    };
    this.database.saveConnectionPayload(this.connection);
    this.emitChanged();
    await this.adapter.cancelConnect().catch(() => undefined);
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
      nextAttemptAt: enabled ? now : '',
      // A stale failure must not outlive the keepalive it belongs to: turning
      // keepalive off clears it, otherwise the bar keeps showing "保活失败".
      lastError: enabled ? this.database.getKeepalive().lastError : ''
    });
    this.emitChanged();
    if (enabled) await this.runKeepalive();
    return this.snapshot();
  }

  private async backgroundTick(): Promise<void> {
    if (this.usesLegacyRemoteLifecycle()) {
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
    }
    const keepalive = this.database.getKeepalive();
    const keepaliveNext = Date.parse(keepalive.nextAttemptAt);
    const keepaliveDue = keepalive.enabled
      && !this.keepaliveRunning
      && !this.connectRunning
      && (!Number.isFinite(keepaliveNext) || keepaliveNext <= Date.now());
    if (
      CONNECT_PASSIVE_RECONCILE_STATES.has(this.connection.status)
      && !this.connectRunning
      && !this.pairingPollRunning
      && !this.pairingSecret
      && (!this.usesLegacyRemoteLifecycle() || !this.database.hasPendingRemoteLifecycleWork())
      && !keepaliveDue
    ) {
      // A normal Shell restart must keep observing the existing Connector,
      // browser, Pack and Page Authorization layers. This is deliberately a
      // passive status reconciliation: it never starts, focuses, navigates or
      // reloads the workstation browser. The transport single-flight guard
      // prevents overlapping five-second ticks.
      this.scheduleTransportReconcile();
    }
    if (this.connection.connected
      && !this.workspaceDirectory.available
      && Boolean(this.workspaceDirectory.observation)
      && !this.workspaceRefreshRunning
      && this.timing.now() - this.lastWorkspaceRecoveryAt >= 30_000) {
      this.lastWorkspaceRecoveryAt = this.timing.now();
      try { await this.refreshWorkspaceDirectory(); } catch { /* retain cached display and retry after the bounded cooldown */ }
    }
    if (!keepaliveDue) return;
    await this.runKeepalive();
  }

  private async runKeepalive(): Promise<void> {
    if (this.keepaliveRunning || this.connectRunning) return;
    this.keepaliveRunning = true;
    const attemptedAt = utcNow();
    const current = this.database.getKeepalive();
    const nextAttemptAt = new Date(Date.now() + current.intervalSeconds * 1_000).toISOString();
    // Preserve the last authoritative failure while the probe is in flight.
    // It is cleared only after a live status proves the Pack is connected.
    // The `lastAttemptAt`/`nextAttemptAt` bookkeeping is not UI-meaningful on
    // its own; the final emit below broadcasts the settled state, so a
    // full-snapshot broadcast + surface re-bootstrap is not fired mid-probe.
    this.database.updateKeepalive({ lastAttemptAt: attemptedAt, nextAttemptAt });
    try {
      const readStatus = async () => {
        const observed = this.passiveConnectionSnapshot(await this.adapter.load());
        if (this.connectRunning) return observed;
        this.connection = observed;
        this.database.saveConnectionPayload(observed);
        if (!observed.connected) {
          throw new AppError('KEEPALIVE.REFRESH_FAILED', observed.message || 'Remote Connector status no longer reports the current Pack connection.');
        }
        return observed;
      };
      const observed = this.interactionLogs
        ? await this.interactionLogs.run({
          plane: 'connector', component: 'remote-transport', surface: 'shell.session', action: 'keepalive-status',
          failurePoint: 'connector.keepalive.status'
        }, readStatus)
        : await readStatus();
      // An explicit Connect that started during the bounded passive read owns
      // the projection and will perform its own reconciliation.
      if (this.connectRunning) return;
      this.connection = observed;
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
    const key = [
      this.connection.connectorId,
      this.connection.sessionGeneration,
      this.connection.authorityInstanceId,
      this.connection.tenantOrOrgId,
      this.connection.packId,
      this.connection.engagementId
    ].join('|');
    if (this.workspaceRefreshRunning?.key === key) return this.workspaceRefreshRunning.promise;
    if (this.workspaceRefreshRunning) {
      try { await this.workspaceRefreshRunning.promise; } catch { /* the current identity still requires its own fresh read */ }
      return this.refreshWorkspaceDirectory();
    }
    const refresh = this.refreshWorkspaceDirectoryNow();
    const flight = { key, promise: refresh };
    this.workspaceRefreshRunning = flight;
    try {
      return await refresh;
    } finally {
      if (this.workspaceRefreshRunning === flight) this.workspaceRefreshRunning = null;
    }
  }

  private async refreshWorkspaceDirectoryNow(): Promise<ShellSnapshot> {
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
      sessionGeneration: Number(this.connection.sessionGeneration || 0),
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
      this.lastWorkspaceRecoveryAt = 0;
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
      this.lastWorkspaceRecoveryAt = this.timing.now();
      this.emitChanged();
      throw error;
    }
    this.emitChanged();
    return this.snapshot();
  }

  async saveSafety(input: {
    enabled: boolean;
    globalEnabled?: boolean;
    globalSectionIds?: string[];
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
    if (!Array.isArray(input.workspaceIds) || (input.globalSectionIds !== undefined && !Array.isArray(input.globalSectionIds))) {
      throw new AppError('SAFETY.INVALID_INPUT', '安全锁范围格式无效。');
    }
    const uniqueIds = [...new Set(input.workspaceIds.map((value) => String(value).trim()).filter(Boolean))].sort();
    const globalEnabled = input.globalEnabled === true;
    const globalSectionIds = globalEnabled
      ? [...new Set((input.globalSectionIds || []).map((value) => String(value).trim()).filter(Boolean))].sort()
      : [];
    if (input.enabled && uniqueIds.length === 0) {
      throw new AppError('SAFETY.EMPTY_SCOPE', '启用安全锁前至少选择一个 Workspace。');
    }
    const validIds = new Set(observation.workspaces.map((workspace) => workspace.id));
    if (uniqueIds.some((id) => !validIds.has(id))) {
      throw new AppError('SAFETY.INVALID_WORKSPACE', '安全锁包含不属于当前权威目录的 Workspace。');
    }
    const validSectionIds = new Set(observation.sections.map((section) => section.id));
    if (globalEnabled && globalSectionIds.length === 0) {
      throw new AppError('SAFETY.EMPTY_GLOBAL_SCOPE', '启用全局安全锁前至少选择一个所在部分。');
    }
    if (globalSectionIds.some((id) => !validSectionIds.has(id))) {
      throw new AppError('SAFETY.INVALID_GLOBAL_SECTION', '全局安全锁包含不属于当前权威目录的所在部分。');
    }
    const selectedSections = new Set(globalSectionIds);
    const globalWorkspaceIds = globalEnabled
      ? observation.workspaces.filter((workspace) => workspace.parentSectionId && selectedSections.has(workspace.parentSectionId)).map((workspace) => workspace.id).sort()
      : [];
    if (globalEnabled && globalWorkspaceIds.length === 0) {
      throw new AppError('SAFETY.EMPTY_GLOBAL_MEMBERSHIP', '所选所在部分没有 Omnia 返回的可核验 Workspace 成员，不能启用全局安全锁。');
    }
    this.database.saveSafety({
      enabled: input.enabled,
      globalEnabled,
      globalSectionIds,
      globalWorkspaceIds,
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
    if (!this.usesLegacyRemoteLifecycle()) throw new AppError('CONNECTOR_NEXT.ENROLLMENT_MANAGED_EXTERNALLY', 'Connector Next enrollment is managed by its independent v3 control plane.');
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
    if (!this.usesLegacyRemoteLifecycle()) throw new AppError('CONNECTOR_NEXT.ENROLLMENT_MANAGED_EXTERNALLY', 'Connector Next does not use legacy Remote pairing.');
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
    if (!this.usesLegacyRemoteLifecycle()) throw new AppError('CONNECTOR_NEXT.ENROLLMENT_MANAGED_EXTERNALLY', 'Connector Next revocation belongs to its independent v3 control plane.');
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

  saveFeatureVersionVisibility(visible: boolean, expectedStateVersion: number): ShellSnapshot {
    this.database.saveFeatureVersionVisibility(visible, expectedStateVersion);
    this.emitChanged();
    return this.snapshot();
  }

  async generateTodayLogs(): Promise<ShellSnapshot> {
    if (!this.logExports) throw new AppError('LOG_EXPORT.UNAVAILABLE', '日志导出服务不可用。');
    const snapshot = this.snapshot();
    let connectorContext: Record<string, unknown> | null = null;
    try { connectorContext = this.adapter.diagnosticContext?.() || null; } catch { connectorContext = null; }
    await this.logExports.generateToday({
      shellVersion: this.productVersion,
      connection: {
        adapter: this.connection.adapter,
        status: this.connection.status,
        connected: this.connection.connected,
        connectorId: this.connection.connectorId,
        connectorVersion: this.connection.connectorVersion,
        sessionGeneration: this.connection.sessionGeneration ?? null,
        authorityInstanceId: this.connection.authorityInstanceId || '',
        tenantOrOrgId: this.connection.tenantOrOrgId || '',
        packId: this.connection.packId || '',
        engagementId: this.connection.engagementId,
        checkedAt: this.connection.checkedAt
      },
      connector: connectorContext,
      features: snapshot.features.navigation.map((item) => ({
        featureId: item.featureId,
        featureVersion: item.featureVersion,
        availability: item.availability
      }))
    });
    return this.emitChanged();
  }

  logExportDownload(exportId: string): { source: string; suggestedName: string } {
    if (!this.logExports) throw new AppError('LOG_EXPORT.UNAVAILABLE', '日志导出服务不可用。');
    return this.logExports.download(exportId);
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
