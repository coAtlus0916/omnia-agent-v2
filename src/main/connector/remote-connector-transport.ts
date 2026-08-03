import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type {
  ConnectorConnection,
  ConnectorRequest,
  RecordingCommandRequest,
  ConnectorWorkspaceLightRead
} from '../../connector/contracts.js';
import {
  BRIDGE_PRODUCT,
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA,
  type BridgeEnvelope,
  type BridgePairingPollResponse,
  type BridgePairingSessionResponse
} from '../../shared/bridge-contracts.js';
import type { ConnectionSnapshot, WorkspaceObservation } from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectorTransport } from './connector-transport.js';
import type {
  OperationInvocationRequest,
  OperationRegistrationRequest,
  OperationRegistrationResult
} from '../../shared/operation-contracts.js';

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
  if (!response.ok || payload.schemaVersion !== BRIDGE_SCHEMA || !payload.sessionId || !payload.pairingCode || !payload.pollSecret) {
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
      pending.reject(new AppError(code, message, false));
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
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new AppError(
      response.error?.code || 'REMOTE.CONNECTOR_ERROR',
      response.error?.message || 'Remote Connector 操作失败。',
      response.error?.retryable === true
    ));
  }

  private async call(operation: ConnectorRequest['operation'], payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    await this.ensureSocket();
    if (!this.connectorOnline && operation !== 'health') throw new AppError('REMOTE.CONNECTOR_OFFLINE', 'Remote Connector 离线。', true);
    if (!this.protocolCompatible) throw new AppError('REMOTE.CONNECTOR_INCOMPATIBLE', 'Remote Connector 协议不兼容。');
    const id = randomUUID();
    const request: ConnectorRequest = { schemaVersion: 'omnia.connector-ipc/v1', id, operation, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({
          schemaVersion: BRIDGE_SCHEMA, kind: 'cancel', requestId: id, reason: 'shell_timeout'
        }));
        const mutationUncertain = operation === 'operation_invoke';
        reject(new AppError(
          mutationUncertain ? 'REMOTE.MUTATION_UNCERTAIN' : 'REMOTE.TIMEOUT',
          mutationUncertain
            ? 'Remote Operation 响应超时；mutation 可能已经发生，禁止自动重放，必须只读 reconcile。'
            : 'Remote Connector 响应超时。',
          !mutationUncertain
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, operation });
      this.socket!.send(JSON.stringify({
        schemaVersion: BRIDGE_SCHEMA,
        kind: 'command',
        request,
        deadlineAt: new Date(Date.now() + timeoutMs).toISOString()
      }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        const mutationUncertain = operation === 'operation_invoke';
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
      if (!this.connectorOnline) return this.unavailableSnapshot(this.stateMessage || 'Remote Connector 离线。');
      return this.map(await this.call('status', {}, 15_000) as ConnectorConnection);
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
  async lightRead(expectedEngagementId: string): Promise<WorkspaceObservation> {
    const raw = await this.call('workspace_light_read', { expectedEngagementId }, 90_000) as ConnectorWorkspaceLightRead;
    if (raw.schemaVersion !== 'omnia.workspace-light-read/v1' || raw.profile !== 'workspace_light_read') {
      throw new AppError('WORKSPACE.INVALID_CONTRACT', 'Remote Connector 返回了不兼容的轻抓取合同。');
    }
    return {
      observationId: randomUUID(), profile: 'workspace_light_read', authorityId: raw.authorityId,
      engagementId: raw.engagementId, capturedAt: new Date().toISOString(), source: raw.source,
      coverage: 'full', sections: raw.sections, workspaces: raw.workspaces
    };
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
