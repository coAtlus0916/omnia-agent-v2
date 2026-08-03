import { EventEmitter } from 'node:events';
import type {
  ConnectionSnapshot,
  ShellSnapshot,
  WorkspaceDirectorySnapshot,
  WorkspaceSafetySnapshot
} from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type { FeatureActionRequest, FeatureRuntimeSnapshot } from '../../shared/feature-contracts.js';
import type { ConnectorTransport } from '../connector/connector-transport.js';
import { pairWaitingConnector, pairWithBridge } from '../connector/remote-connector-transport.js';
import type { CoreDatabase } from '../database.js';
import type { AttachmentService } from './attachment-service.js';
import type { ChatService } from './chat-service.js';
import type { FeaturePackageManager } from '../features/package-manager.js';

const utcNow = () => new Date().toISOString();

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

  constructor(
    private readonly database: CoreDatabase,
    private readonly adapter: ConnectorTransport & {
      switchMode?(mode: 'local' | 'remote', expectedStateVersion: number): Promise<void>;
    },
    private readonly chat: ChatService,
    private readonly attachments?: AttachmentService,
    private readonly features?: FeaturePackageManager
  ) {
    this.connection = database.getConnectionPayload<ConnectionSnapshot>()
      || adapter.unavailableSnapshot('正在检查 Local Connector 服务。');
  }

  async initialize(): Promise<void> {
    await this.syncConnection();
    if (this.connection.connected) {
      const previous = this.database.getLatestWorkspaceObservation(this.connection.engagementId);
      if (previous) {
        this.workspaceDirectory = {
          available: true,
          reasonCode: '',
          reason: '',
          observation: previous
        };
      }
    }
    this.timer = setInterval(() => {
      void this.backgroundTick();
    }, 5_000);
    this.timer.unref();
    await this.backgroundTick();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      productVersion: '0.4.1',
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
      }
    };
  }

  selectFeature(featureId: string): ShellSnapshot {
    if (!this.features) throw new AppError('FEATURE.RUNTIME_UNAVAILABLE', 'Feature runtime is unavailable.');
    this.features.select(featureId);
    this.emitChanged();
    return this.snapshot();
  }

  async featureAction(request: FeatureActionRequest): Promise<ShellSnapshot> {
    if (!this.features) throw new AppError('FEATURE.RUNTIME_UNAVAILABLE', 'Feature runtime is unavailable.');
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
    this.database.saveConnectionPayload(this.connection);
    if (!this.connection.connected) {
      this.workspaceDirectory = {
        available: false,
        reasonCode: 'not_connected',
        reason: this.connection.message || '请先连接 Omnia Pack。',
        observation: null
      };
    }
  }

  async connect(): Promise<ShellSnapshot> {
    const attempt = ++this.connectAttempt;
    this.connection = {
      ...this.connection,
      status: 'opening',
      connecting: true,
      message: '正在连接 Connector…'
    };
    this.emitChanged();
    try {
      const connected = await this.adapter.connect();
      if (this.cancelledConnectAttempt === attempt) {
        this.connection = await this.adapter.load();
        throw new AppError('CONNECTOR.CONNECT_CANCELLED', '连接已取消。', true);
      }
      this.connection = connected;
      this.database.saveConnectionPayload(this.connection);
    } catch (error) {
      await this.syncConnection();
      throw error;
    } finally {
      this.emitChanged();
    }
    if (this.connection.connected) await this.refreshWorkspaceDirectory();
    return this.snapshot();
  }

  async cancelConnect(): Promise<ShellSnapshot> {
    if (!this.connection.connecting && this.connection.status !== 'opening') return this.snapshot();
    this.cancelledConnectAttempt = this.connectAttempt;
    await this.adapter.cancelConnect();
    this.connection = {
      ...this.connection,
      status: 'not_connected',
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
      throw new AppError('CONNECTOR.UNAVAILABLE', this.connection.adapterReason || 'Local Connector 服务不可用。', true);
    }
    try {
      this.connection = await this.adapter.refresh();
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
      this.connection = await this.adapter.refresh();
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
    const previous = this.database.getLatestWorkspaceObservation(this.connection.engagementId);
    try {
      const observation = await this.adapter.lightRead(this.connection.engagementId);
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
    }
    this.emitChanged();
    return this.snapshot();
  }

  saveSafety(input: {
    enabled: boolean;
    workspaceIds: string[];
    expectedStateVersion: number;
  }): ShellSnapshot {
    if (!this.connection.connected || !this.connection.engagementId) {
      throw new AppError('SAFETY.NOT_CONNECTED', '请先连接 Omnia Pack。');
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

  async pairRemote(input: {
    bridgeUrl: string;
    pairingCode: string;
    connectorId?: string;
    expectedStateVersion: number;
  }): Promise<ShellSnapshot> {
    const current = this.database.getConnectionSettings();
    if (current.remotePaired) {
      if (current.stateVersion !== input.expectedStateVersion) {
        throw new AppError('SETTINGS.CONFLICT', '连接设置已在其他窗口更新，请刷新后重试。', true);
      }
      const requestedBridge = input.bridgeUrl.trim().replace(/\/+$/, '');
      const savedBridge = current.remoteBridgeUrl.trim().replace(/\/+$/, '');
      if (input.pairingCode.trim() || requestedBridge !== savedBridge) {
        throw new AppError(
          'REMOTE.REPAIR_REQUIRED',
          '当前 Remote Connector 已匹配。如需更换 Bridge 或 Connector，请先使用后续提供的重新匹配流程。'
        );
      }
      if (current.mode !== 'remote') {
        if (!this.adapter.switchMode) {
          throw new AppError('CONNECTOR.MODE_SWITCH_UNAVAILABLE', '连接模式切换服务不可用。');
        }
        await this.adapter.switchMode('remote', current.stateVersion);
      }
      await this.syncConnection();
      this.emitChanged();
      return this.snapshot();
    }
    const paired = input.pairingCode.trim()
      ? await pairWithBridge({
          bridgeUrl: input.bridgeUrl,
          pairingCode: input.pairingCode,
          role: 'shell',
          name: 'Omnia Agent v5 Shell'
        })
      : await pairWaitingConnector({
          bridgeUrl: input.bridgeUrl,
          ...(input.connectorId ? { connectorId: input.connectorId } : {})
        });
    const saved = this.database.saveRemotePairing({
      bridgeUrl: input.bridgeUrl,
      pairId: paired.pairId,
      token: paired.token,
      expectedStateVersion: input.expectedStateVersion
    });
    if (this.adapter.switchMode) {
      await this.adapter.switchMode('remote', saved.stateVersion);
      await this.syncConnection();
    }
    this.emitChanged();
    return this.snapshot();
  }

  async setConnectionMode(mode: 'local' | 'remote', expectedStateVersion: number): Promise<ShellSnapshot> {
    if (!this.adapter.switchMode) throw new AppError('CONNECTOR.MODE_SWITCH_UNAVAILABLE', '连接模式切换服务不可用。');
    await this.adapter.switchMode(mode, expectedStateVersion);
    await this.syncConnection();
    if (mode === 'local') await this.features?.initializeRuntime();
    this.emitChanged();
    return this.snapshot();
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
