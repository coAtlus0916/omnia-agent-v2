import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type {
  ConnectorConnection,
  ConnectorRequest,
  RecordingCommandRequest
} from '../../connector/contracts.js';
import {
  BRIDGE_HEALTH_PRODUCT,
  BRIDGE_PAIRING_SESSION_CONTRACT,
  BRIDGE_PAIRING_CODE_PATTERN,
  BRIDGE_PAIRING_CODE_TTL_MS,
  BRIDGE_PRODUCT,
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA,
  BRIDGE_VERSION,
  type BridgeEnvelope,
  type BridgeHealthResponse,
  type BridgePairingCapabilityInspection,
  type BridgePairingPollResponse,
  type BridgePairingSessionResponse
} from '../../shared/bridge-contracts.js';
import type { ConnectionSnapshot, WorkspaceObservation } from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectorTransport, WorkspaceAuthorityExpectation } from './connector-transport.js';
import type {
  OperationInvocationRequest,
  OperationRegistrationRequest,
  OperationRegistrationResult
} from '../../shared/operation-contracts.js';
import { normalizeWorkspaceAuthorityRead } from '../services/workspace-authority.js';

export interface RemoteTransportConfig {
  bridgeUrl: string;
  pairId: string;
  token: string;
  generation?: number;
}

export interface RemotePairingSession {
  sessionId: string;
  pairingCode: string;
  pollSecret: string;
  expiresAt: string;
}

function bridgeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('REMOTE.INVALID_URL', 'Remote Bridge URL 无效。'); }
  const localTest = process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localTest) throw new AppError('REMOTE.TLS_REQUIRED', 'Remote Bridge 必须使用 HTTPS/WSS。');
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError('REMOTE.INVALID_URL', 'Remote Bridge URL 不能包含凭据、查询参数或片段。');
  }
  return url;
}

function endpoint(base: URL, route: string): URL {
  return new URL(route, base.href.endsWith('/') ? base.href : `${base.href}/`);
}

function wsEndpoint(base: URL): URL {
  const url = endpoint(base, 'v1/connect');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

const bridgeVersionCompatible = (value: string): boolean => {
  const current = BRIDGE_VERSION.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const candidate = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return Boolean(
    current
    && candidate
    && Number(candidate[1]) === Number(current[1])
    && Number(candidate[2]) === Number(current[2])
    && Number(candidate[3]) >= Number(current[3])
  );
};

const CONNECTOR_PROBE_OPERATIONS = new Set<ConnectorRequest['operation']>([
  'health',
  'status',
  'connect'
]);

const bridgeInspection = (
  status: BridgePairingCapabilityInspection['status'],
  reasonCode: string,
  reason: string,
  health: Partial<BridgeHealthResponse> = {}
): BridgePairingCapabilityInspection => ({
  status,
  canCreateSession: status === 'supported',
  reasonCode,
  reason,
  bridgeVersion: typeof health.version === 'string' ? health.version : '',
  bridgeProtocol: typeof health.protocol === 'string' ? health.protocol : '',
  buildIdentity: typeof health.buildIdentity === 'string' ? health.buildIdentity : '',
  checkedAt: new Date().toISOString()
});

export async function inspectBridgePairingCapability(input: {
  bridgeUrl: string;
}, fetchImpl: typeof fetch = fetch): Promise<BridgePairingCapabilityInspection> {
  let base: URL;
  try {
    base = bridgeUrl(input.bridgeUrl);
  } catch {
    return bridgeInspection(
      'incompatible',
      'REMOTE.BRIDGE_CONFIGURATION_INVALID',
      'Remote Bridge 地址配置无效；请修复安装配置后重试。'
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(endpoint(base, 'v1/health'), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    return bridgeInspection(
      'unreachable',
      'REMOTE.BRIDGE_UNREACHABLE',
      '无法访问 Remote Bridge 健康检查；请检查网络或联系管理员确认 Bridge 服务在线。'
    );
  }
  const payload = await response.json().catch(() => ({})) as Partial<BridgeHealthResponse>;
  if (!response.ok) {
    return bridgeInspection(
      'unreachable',
      'REMOTE.BRIDGE_UNREACHABLE',
      `Remote Bridge 健康检查不可用（HTTP ${response.status}）；请检查部署或反向代理。`,
      payload
    );
  }
  if (
    payload.schemaVersion !== BRIDGE_SCHEMA
    || payload.ok !== true
  ) {
    return bridgeInspection(
      'incompatible',
      'REMOTE.BRIDGE_IDENTITY_INCOMPATIBLE',
      'Remote Bridge 身份或健康合同不兼容；请部署 Omnia Agent v5 Bridge。',
      payload
    );
  }
  if (
    !payload.version
    || !payload.buildIdentity
    || !payload.protocol
    || !payload.startedAt
    || !payload.capabilities?.pairingSessions
  ) {
    return bridgeInspection(
      'upgrade_required',
      'REMOTE.BRIDGE_UPGRADE_REQUIRED',
      'Remote Bridge 版本过旧，未声明一次性链接会话能力；请先升级 Bridge。',
      payload
    );
  }
  if (payload.product !== BRIDGE_HEALTH_PRODUCT) {
    return bridgeInspection(
      'incompatible',
      'REMOTE.BRIDGE_IDENTITY_INCOMPATIBLE',
      'Remote Bridge 身份不兼容；请部署 Omnia Agent v5 Bridge。',
      payload
    );
  }
  if (payload.protocol !== BRIDGE_PROTOCOL) {
    return bridgeInspection(
      'incompatible',
      'REMOTE.BRIDGE_PROTOCOL_INCOMPATIBLE',
      `Remote Bridge 协议不兼容（当前 ${payload.protocol}，需要 ${BRIDGE_PROTOCOL}）；请先升级 Bridge。`,
      payload
    );
  }
  if (!bridgeVersionCompatible(payload.version)) {
    return bridgeInspection(
      'upgrade_required',
      'REMOTE.BRIDGE_UPGRADE_REQUIRED',
      `Remote Bridge 版本 ${payload.version} 不支持当前 Shell pairing contract；请先升级 Bridge。`,
      payload
    );
  }
  if (
    payload.capabilities.pairingSessions.contractVersion !== BRIDGE_PAIRING_SESSION_CONTRACT
    || payload.capabilities.pairingSessions.create !== true
  ) {
    return bridgeInspection(
      'upgrade_required',
      'REMOTE.BRIDGE_UPGRADE_REQUIRED',
      'Remote Bridge 未启用当前一次性链接会话合同；请先完成 Bridge 升级与 pairing canary。',
      payload
    );
  }
  if (Number.isNaN(Date.parse(payload.startedAt))) {
    return bridgeInspection(
      'incompatible',
      'REMOTE.BRIDGE_HEALTH_INCOMPATIBLE',
      'Remote Bridge 健康响应缺少有效启动身份；请检查 Bridge 部署。',
      payload
    );
  }
  return bridgeInspection(
    'supported',
    '',
    'Remote Bridge 支持当前一次性链接会话合同。',
    payload
  );
}

export async function beginPairingSession(input: {
  bridgeUrl: string;
  replacementPairId?: string;
  currentToken?: string;
  requestNonce?: string;
}, fetchImpl: typeof fetch = fetch): Promise<RemotePairingSession> {
  const base = bridgeUrl(input.bridgeUrl);
  const response = await fetchImpl(endpoint(base, 'v1/pairing/sessions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(input.currentToken ? { Authorization: `Bearer ${input.currentToken}` } : {})
    },
    body: JSON.stringify({
      schemaVersion: BRIDGE_SCHEMA,
      product: BRIDGE_PRODUCT,
      protocol: BRIDGE_PROTOCOL,
      shellNonce: input.requestNonce || `shell-${randomUUID()}`,
      ...(input.replacementPairId ? { replacementPairId: input.replacementPairId } : {})
    }),
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({})) as BridgePairingSessionResponse & { message?: string };
  const expiresIn = Date.parse(String(payload.expiresAt || '')) - Date.now();
  if (!response.ok || payload.schemaVersion !== BRIDGE_SCHEMA || !payload.sessionId || !BRIDGE_PAIRING_CODE_PATTERN.test(String(payload.pairingCode || '')) || !payload.pollSecret
    || !Number.isFinite(expiresIn) || expiresIn < 1 || expiresIn > BRIDGE_PAIRING_CODE_TTL_MS + 5_000) {
    throw new AppError('REMOTE.PAIRING_SESSION_FAILED', payload.message || `Bridge HTTP ${response.status}`, true);
  }
  return payload;
}

export async function pollPairingSession(input: {
  bridgeUrl: string;
  sessionId: string;
  pollSecret: string;
}, fetchImpl: typeof fetch = fetch): Promise<BridgePairingPollResponse> {
  const base = bridgeUrl(input.bridgeUrl);
  const response = await fetchImpl(endpoint(base, `v1/pairing/sessions/${encodeURIComponent(input.sessionId)}`), {
    headers: { Authorization: `Pairing ${input.pollSecret}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({})) as BridgePairingPollResponse & { message?: string };
  if ((!response.ok && response.status !== 410) || payload.schemaVersion !== BRIDGE_SCHEMA) {
    throw new AppError('REMOTE.PAIRING_POLL_FAILED', payload.message || `Bridge HTTP ${response.status}`, true);
  }
  return payload;
}

export async function cancelPairingSession(input: {
  bridgeUrl: string;
  sessionId: string;
  pollSecret: string;
}, fetchImpl: typeof fetch = fetch): Promise<'cancelled' | 'expired' | 'matched'> {
  const base = bridgeUrl(input.bridgeUrl);
  const response = await fetchImpl(endpoint(base, `v1/pairing/sessions/${encodeURIComponent(input.sessionId)}`), {
    method: 'DELETE',
    headers: { Authorization: `Pairing ${input.pollSecret}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({})) as { schemaVersion?: string; state?: string; message?: string };
  if (response.status === 409 && payload.state === 'matched') return 'matched';
  if (response.status === 410 && payload.state === 'expired') return 'expired';
  if (!response.ok || payload.schemaVersion !== BRIDGE_SCHEMA || payload.state !== 'cancelled') {
    throw new AppError('REMOTE.PAIRING_CANCEL_FAILED', payload.message || `Bridge HTTP ${response.status}`, true);
  }
  return 'cancelled';
}

export async function commitPairingSession(input: {
  bridgeUrl: string;
  sessionId: string;
  pollSecret: string;
}, fetchImpl: typeof fetch = fetch): Promise<void> {
  const base = bridgeUrl(input.bridgeUrl);
  const response = await fetchImpl(endpoint(base, `v1/pairing/sessions/${encodeURIComponent(input.sessionId)}/commit`), {
    method: 'POST',
    headers: { Authorization: `Pairing ${input.pollSecret}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({})) as { schemaVersion?: string; state?: string; message?: string };
  if (!response.ok || payload.schemaVersion !== BRIDGE_SCHEMA || payload.state !== 'matched') {
    throw new AppError('REMOTE.PAIRING_COMMIT_FAILED', payload.message || `Bridge HTTP ${response.status}`, true);
  }
}

export async function revokeBinding(input: {
  bridgeUrl: string;
  pairId: string;
  token: string;
}, fetchImpl: typeof fetch = fetch): Promise<void> {
  const base = bridgeUrl(input.bridgeUrl);
  const response = await fetchImpl(endpoint(base, `v1/bindings/${encodeURIComponent(input.pairId)}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${input.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      throw new AppError('REMOTE.REVOKE_CREDENTIAL_INVALID', 'Remote binding 凭据已失效；本地已进入修复状态，不能宣称远端解绑成功。');
    }
    throw new AppError('REMOTE.REVOKE_FAILED', 'Bridge 未确认解除当前设备绑定；本地绑定仍保留以便重试。', true);
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  operation: ConnectorRequest['operation'];
  mutationAuthorized: boolean;
}

const connectorVersionCompatible = (value: string): boolean => {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return Boolean(match && Number(match[1]) === 0 && Number(match[2]) === 3 && Number(match[3]) >= 4);
};

export class RemoteConnectorTransport implements ConnectorTransport {
  readonly mode = 'remote' as const;
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private connectorOnline = false;
  private protocolCompatible = true;
  private connectorId = '';
  private connectorVersion = '';
  private generation = 0;
  private stateMessage = '';
  private repairRequired = false;
  private configIdentity = '';
  private lastAuthorizationRefreshAt = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly events = new EventEmitter();

  constructor(private readonly config: () => RemoteTransportConfig) {}

  onStateChanged(listener: () => void): () => void {
    this.events.on('state', listener);
    return () => this.events.off('state', listener);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const config = this.config();
    const nextIdentity = [config.bridgeUrl, config.pairId, config.generation || 0].join('|');
    if (nextIdentity !== this.configIdentity) {
      this.configIdentity = nextIdentity;
      this.repairRequired = false;
      this.protocolCompatible = true;
      this.reconnectAttempt = 0;
      this.stateMessage = '';
      this.lastAuthorizationRefreshAt = 0;
    }
    if (!config.bridgeUrl || !config.pairId || !config.token) return;
    try { await this.ensureSocket(); } catch { this.scheduleReconnect(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, 'shell transport stopped');
    this.rejectPending('REMOTE.TRANSPORT_STOPPED', 'Remote 传输已停止。');
  }

  private rejectPending(code: string, message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      const uncertain = pending.mutationAuthorized && ['REMOTE.IN_FLIGHT_DISCONNECTED', 'REMOTE.CONNECTOR_DISCONNECTED'].includes(code);
      pending.reject(new AppError(
        uncertain ? 'REMOTE.MUTATION_UNCERTAIN' : code,
        uncertain ? '已授权 mutation 在返回前失联；effect 未知，只允许只读 reconcile。' : message,
        !uncertain
      ));
      this.pending.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || !this.config().token || this.repairRequired || !this.protocolCompatible) return;
    const base = Math.min(30_000, 1_000 * (2 ** Math.min(this.reconnectAttempt, 5)));
    const delay = base + Math.floor(Math.random() * Math.max(250, base / 3));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureSocket().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref();
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    const config = this.config();
    if (!config.bridgeUrl || !config.pairId || !config.token) throw new AppError('REMOTE.NOT_CONFIGURED', 'Remote Connector 尚未配对。');
    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsEndpoint(bridgeUrl(config.bridgeUrl)), {
        headers: { Authorization: `Bearer ${config.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL },
        handshakeTimeout: 15_000,
        maxPayload: 2 * 1024 * 1024
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new AppError('REMOTE.CONNECT_TIMEOUT', 'Remote Bridge 连接超时。', true));
      }, 20_000);
      socket.once('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.reconnectAttempt = 0;
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new AppError('REMOTE.CONNECT_FAILED', `Remote Bridge 连接失败：${error.message}`, true));
      });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        if (response.statusCode === 426) {
          this.protocolCompatible = false;
          this.stateMessage = 'Remote Connector 协议或版本不兼容。';
        } else if ([401, 403].includes(response.statusCode || 0)) {
          this.repairRequired = true;
          this.stateMessage = 'Remote binding 已失效，需要重新配对。';
        }
        socket.terminate();
        reject(new AppError(this.repairRequired ? 'REMOTE.REPAIR_REQUIRED' : 'REMOTE.CONNECTOR_INCOMPATIBLE', this.stateMessage));
      });
      socket.on('message', (data) => this.handleMessage(data.toString()));
      socket.on('close', (code) => {
        if (this.socket === socket) this.socket = null;
        this.connectorOnline = false;
        if (code === 4003) {
          this.repairRequired = true;
          this.stateMessage = 'Remote binding 已撤销或 generation 失效，需要修复连接。';
        }
        this.rejectPending('REMOTE.IN_FLIGHT_DISCONNECTED', 'Remote Connector 在命令执行期间断开；外部 effect 状态未知，禁止自动重放。');
        this.events.emit('state');
        this.scheduleReconnect();
      });
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  private handleMessage(text: string): void {
    let envelope: BridgeEnvelope;
    try { envelope = JSON.parse(text) as BridgeEnvelope; } catch { return; }
    if (envelope.schemaVersion !== BRIDGE_SCHEMA) return;
    if (envelope.kind === 'state') {
      this.connectorOnline = envelope.connectorOnline;
      this.protocolCompatible = envelope.protocol === BRIDGE_PROTOCOL
        && (!envelope.connectorVersion || connectorVersionCompatible(envelope.connectorVersion));
      this.connectorId = envelope.connectorId;
      this.connectorVersion = envelope.connectorVersion;
      this.generation = envelope.generation;
      this.stateMessage = envelope.message;
      this.events.emit('state');
      return;
    }
    if (envelope.kind !== 'result') return;
    const response = envelope.response;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) {
      const wasOffline = !this.connectorOnline;
      this.connectorOnline = true;
      if (wasOffline) {
        this.stateMessage = 'Remote Connector 在线。';
        this.events.emit('state');
      }
      pending.resolve(response.value);
      return;
    }
    const errorCode = response.error?.code || 'REMOTE.CONNECTOR_ERROR';
    const errorMessage = response.error?.message || 'Remote Connector 操作失败。';
    pending.reject(new AppError(
      errorCode,
      errorMessage,
      response.error?.retryable === true
    ));
  }

  private async call(operation: ConnectorRequest['operation'], payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    await this.ensureSocket();
    if (!this.connectorOnline && !CONNECTOR_PROBE_OPERATIONS.has(operation)) {
      throw new AppError('REMOTE.CONNECTOR_OFFLINE', 'Remote Connector 离线。', true);
    }
    if (!this.protocolCompatible) throw new AppError('REMOTE.CONNECTOR_INCOMPATIBLE', 'Remote Connector 协议不兼容。');
    const id = randomUUID();
    const request: ConnectorRequest = { schemaVersion: 'omnia.connector-ipc/v1', id, operation, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({
          schemaVersion: BRIDGE_SCHEMA, kind: 'cancel', requestId: id, reason: 'shell_timeout'
        }));
        const mutationUncertain = operation === 'operation_invoke' && payload.mutationAuthorized === true;
        reject(new AppError(
          mutationUncertain ? 'REMOTE.MUTATION_UNCERTAIN' : 'REMOTE.TIMEOUT',
          mutationUncertain
            ? 'Remote Operation 响应超时；mutation 可能已经发生，禁止自动重放，必须只读 reconcile。'
            : 'Remote Connector 响应超时。',
          !mutationUncertain
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, operation, mutationAuthorized: operation === 'operation_invoke' && payload.mutationAuthorized === true });
      this.socket!.send(JSON.stringify({
        schemaVersion: BRIDGE_SCHEMA,
        kind: 'command',
        request,
        deadlineAt: new Date(Date.now() + timeoutMs).toISOString()
      }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        const mutationUncertain = operation === 'operation_invoke' && payload.mutationAuthorized === true;
        reject(new AppError(
          mutationUncertain ? 'REMOTE.MUTATION_UNCERTAIN' : 'REMOTE.SEND_FAILED',
          mutationUncertain
            ? 'Remote Operation 发送结果不确定；禁止自动重放，必须只读 reconcile。'
            : '无法向 Remote Connector 发送请求。',
          !mutationUncertain
        ));
      });
    });
  }

  unavailableSnapshot(reason: string): ConnectionSnapshot {
    const configured = Boolean(this.config().token);
    return {
      transport: 'remote', adapter: 'v5_remote_connector', adapterAvailable: configured,
      adapterReason: reason, remoteAvailable: configured, remoteReason: reason,
      bridgeOnline: this.socket?.readyState === WebSocket.OPEN,
      connectorOnline: this.connectorOnline,
      protocolCompatible: this.protocolCompatible,
      bindingState: configured ? (this.protocolCompatible && !this.repairRequired ? 'bound' : 'repair_required') : 'unpaired',
      status: configured
        ? (this.repairRequired ? 'repair_required' : !this.protocolCompatible ? 'connector_incompatible' : this.connectorOnline ? 'not_connected' : 'connector_offline')
        : 'not_configured',
      connected: false, connecting: false,
      connectorId: this.connectorId, connectorName: 'Omnia Agent v5 Remote Connector',
      connectorVersion: this.connectorVersion, sessionGeneration: this.generation,
      engagementId: '', engagementName: '', clientName: '', checkedAt: new Date().toISOString(),
      message: reason
    };
  }

  private map(raw: ConnectorConnection): ConnectionSnapshot {
    return {
      transport: 'remote', adapter: 'v5_remote_connector', adapterAvailable: true,
      adapterReason: '', remoteAvailable: true, remoteReason: '',
      bridgeOnline: true, connectorOnline: this.connectorOnline,
      protocolCompatible: this.protocolCompatible, bindingState: 'bound',
      ...raw
    };
  }

  async load(): Promise<ConnectionSnapshot> {
    if (!this.config().token) return this.unavailableSnapshot('Remote Connector 尚未配对。');
    try {
      await this.ensureSocket();
      const status = await this.call('status', {}, 15_000) as ConnectorConnection;
      const authorizationExpired = !status.connected
        && /Omnia 只读 API 返回 HTTP (?:401|403)/u.test(String(status.message || ''));
      if (authorizationExpired && Date.now() - this.lastAuthorizationRefreshAt >= 60_000) {
        this.lastAuthorizationRefreshAt = Date.now();
        try {
          return this.map(await this.call('refresh', {}, 90_000) as ConnectorConnection);
        } catch {
          // Preserve the exact status response. The next bounded retry is
          // allowed after the cooldown; no read or mutation is replayed.
        }
      }
      return this.map(status);
    } catch (error) {
      return this.unavailableSnapshot(error instanceof Error ? error.message : 'Remote Connector 不可用。');
    }
  }

  async connect(): Promise<ConnectionSnapshot> { return this.map(await this.call('connect', {}, 90_000)); }
  async cancelConnect(): Promise<void> {
    for (const [id, pending] of this.pending) {
      if (!['connect', 'status'].includes(pending.operation)) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({
        schemaVersion: BRIDGE_SCHEMA, kind: 'cancel', requestId: id, reason: 'user_cancelled_connect'
      }));
      pending.reject(new AppError('CONNECTOR.CONNECT_CANCELLED', 'Remote Connect 已取消。', true));
    }
  }
  async refresh(): Promise<ConnectionSnapshot> { return this.map(await this.call('refresh', {}, 90_000)); }
  async lightRead(expected: WorkspaceAuthorityExpectation): Promise<WorkspaceObservation> {
    const raw = await this.call('workspace_authority_read', { expectedEngagementId: expected.engagementId }, 90_000);
    return normalizeWorkspaceAuthorityRead(raw, expected);
  }
  async recordingCommand(input: RecordingCommandRequest): Promise<unknown> {
    return this.call('recording_command', input as unknown as Record<string, unknown>, 180_000);
  }
  async registerOperation(input: OperationRegistrationRequest): Promise<OperationRegistrationResult> {
    return this.call('operation_register', input as unknown as Record<string, unknown>, 30_000);
  }
  async invokeOperation(input: OperationInvocationRequest): Promise<unknown> {
    return this.call('operation_invoke', input as unknown as Record<string, unknown>, 120_000);
  }
}

export const _test = { bridgeUrl, wsEndpoint };
