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
  type BridgeDiscoverySessionResponse,
  type BridgePairResponse
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
}

function bridgeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('REMOTE.INVALID_URL', 'Remote Bridge URL 无效。'); }
  const localTest = process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localTest) {
    throw new AppError('REMOTE.TLS_REQUIRED', 'Remote Bridge 必须使用 HTTPS/WSS。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError('REMOTE.INVALID_URL', 'Remote Bridge URL 不能包含凭据、查询参数或片段。');
  }
  return url;
}

function wsEndpoint(base: URL): URL {
  const url = new URL('v1/connect', base.href.endsWith('/') ? base.href : `${base.href}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

export async function pairWithBridge(input: {
  bridgeUrl: string;
  pairingCode: string;
  role: 'shell' | 'connector';
  name: string;
}, fetchImpl: typeof fetch = fetch): Promise<{ token: string; pairId: string }> {
  const base = bridgeUrl(input.bridgeUrl);
  const response = await fetchImpl(new URL('v1/pair', base.href.endsWith('/') ? base.href : `${base.href}/`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      schemaVersion: BRIDGE_SCHEMA,
      role: input.role,
      pairingCode: input.pairingCode,
      name: input.name
    }),
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json() as BridgePairResponse & { message?: string };
  if (!response.ok || payload.schemaVersion !== BRIDGE_SCHEMA || !payload.token) {
    throw new AppError('REMOTE.PAIRING_FAILED', payload.message || `Bridge HTTP ${response.status}`, true);
  }
  return { token: payload.token, pairId: payload.pairId };
}

export async function pairWaitingConnector(input: {
  bridgeUrl: string;
  connectorId?: string;
}, fetchImpl: typeof fetch = fetch): Promise<{
  token: string;
  pairId: string;
  connectorId: string;
  connectorName: string;
  confirmationCode: string;
}> {
  const base = bridgeUrl(input.bridgeUrl);
  const response = await fetchImpl(
    new URL('v1/discovery/sessions', base.href.endsWith('/') ? base.href : `${base.href}/`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        schemaVersion: BRIDGE_SCHEMA,
        product: BRIDGE_PRODUCT,
        protocol: BRIDGE_PROTOCOL,
        shellNonce: `shell-${randomUUID()}`,
        ...(input.connectorId ? { connectorId: input.connectorId } : {})
      }),
      signal: AbortSignal.timeout(20_000)
    }
  );
  const payload = await response.json().catch(() => ({})) as BridgeDiscoverySessionResponse & {
    code?: string;
    message?: string;
    candidates?: Array<{ connectorId: string; name: string }>;
  };
  if (
    !response.ok
    || payload.schemaVersion !== BRIDGE_SCHEMA
    || payload.product !== BRIDGE_PRODUCT
    || payload.protocol !== BRIDGE_PROTOCOL
    || !payload.token
    || !payload.pairId
    || !payload.connector?.connectorId
  ) {
    const candidates = Array.isArray(payload.candidates)
      ? payload.candidates.map((candidate) => `${candidate.name} (${candidate.connectorId})`).join('、')
      : '';
    throw new AppError(
      payload.code || 'REMOTE.MATCHING_FAILED',
      candidates ? `${payload.message || 'Remote 匹配失败。'} 候选：${candidates}` : payload.message || `Bridge HTTP ${response.status}`,
      true
    );
  }
  return {
    token: payload.token,
    pairId: payload.pairId,
    connectorId: payload.connector.connectorId,
    connectorName: payload.connector.name,
    confirmationCode: payload.confirmationCode
  };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  operation: ConnectorRequest['operation'];
}

export class RemoteConnectorTransport implements ConnectorTransport {
  readonly mode = 'remote' as const;
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly config: () => RemoteTransportConfig) {}

  async start(): Promise<void> {
    await this.ensureSocket();
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, 'shell transport stopped');
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new AppError('REMOTE.TRANSPORT_STOPPED', 'Remote 传输已停止。', true));
      this.pending.delete(id);
    }
  }

  async registerOperation(input: OperationRegistrationRequest): Promise<OperationRegistrationResult> {
    return this.call('operation_register', input as unknown as Record<string, unknown>, 30_000);
  }

  async invokeOperation(input: OperationInvocationRequest): Promise<unknown> {
    return this.call('operation_invoke', input as unknown as Record<string, unknown>, 120_000);
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    const config = this.config();
    if (!config.bridgeUrl || !config.pairId || !config.token) {
      throw new AppError('REMOTE.NOT_CONFIGURED', 'Remote Bridge 尚未配对。');
    }
    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsEndpoint(bridgeUrl(config.bridgeUrl)), {
        headers: { Authorization: `Bearer ${config.token}` },
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
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new AppError('REMOTE.CONNECT_FAILED', `Remote Bridge 连接失败：${error.message}`, true));
      });
      socket.on('message', (data) => this.handleMessage(data.toString()));
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
      });
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  private handleMessage(text: string): void {
    let envelope: BridgeEnvelope;
    try { envelope = JSON.parse(text) as BridgeEnvelope; } catch { return; }
    if (envelope.schemaVersion !== BRIDGE_SCHEMA) return;
    if (envelope.kind === 'state') {
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
    const id = randomUUID();
    const request: ConnectorRequest = { schemaVersion: 'omnia.connector-ipc/v1', id, operation, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'cancel',
            requestId: id,
            reason: 'shell_timeout'
          }));
        }
        reject(new AppError('REMOTE.TIMEOUT', 'Remote Connector 响应超时。', true));
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
        reject(new AppError('REMOTE.SEND_FAILED', '无法向 Remote Connector 发送请求。', true));
      });
    });
  }

  private map(raw: ConnectorConnection): ConnectionSnapshot {
    return {
      transport: 'remote',
      adapter: 'v5_remote_connector',
      adapterAvailable: true,
      adapterReason: '',
      remoteAvailable: true,
      remoteReason: '',
      ...raw
    };
  }

  unavailableSnapshot(reason: string): ConnectionSnapshot {
    return {
      transport: 'remote',
      adapter: 'v5_remote_connector',
      adapterAvailable: false,
      adapterReason: reason,
      remoteAvailable: false,
      remoteReason: reason,
      status: 'not_configured',
      connected: false,
      connecting: false,
      connectorId: '',
      connectorName: 'Omnia Agent v5 Remote Connector',
      connectorVersion: '',
      engagementId: '',
      engagementName: '',
      clientName: '',
      checkedAt: new Date().toISOString(),
      message: reason
    };
  }

  async load(): Promise<ConnectionSnapshot> {
    try { return this.map(await this.call('status', {}, 15_000) as ConnectorConnection); }
    catch (error) { return this.unavailableSnapshot(error instanceof Error ? error.message : 'Remote Connector 不可用。'); }
  }
  async connect(): Promise<ConnectionSnapshot> {
    return this.map(await this.call('connect', {}, 90_000) as ConnectorConnection);
  }
  async cancelConnect(): Promise<void> {
    for (const [id, pending] of this.pending) {
      if (pending.operation !== 'connect') continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({
          schemaVersion: BRIDGE_SCHEMA,
          kind: 'cancel',
          requestId: id,
          reason: 'user_cancelled_connect'
        }));
      }
      pending.reject(new AppError('CONNECTOR.CONNECT_CANCELLED', 'Remote Connect 已取消。', true));
    }
  }
  async refresh(): Promise<ConnectionSnapshot> {
    return this.map(await this.call('refresh', {}, 90_000) as ConnectorConnection);
  }
  async lightRead(expectedEngagementId: string): Promise<WorkspaceObservation> {
    const raw = await this.call('workspace_light_read', { expectedEngagementId }, 90_000) as ConnectorWorkspaceLightRead;
    if (raw.schemaVersion !== 'omnia.workspace-light-read/v1' || raw.profile !== 'workspace_light_read') {
      throw new AppError('WORKSPACE.INVALID_CONTRACT', 'Remote Connector 返回了不兼容的轻抓取合同。');
    }
    return {
      observationId: randomUUID(),
      profile: 'workspace_light_read',
      authorityId: raw.authorityId,
      engagementId: raw.engagementId,
      capturedAt: new Date().toISOString(),
      source: raw.source,
      coverage: 'full',
      sections: raw.sections,
      workspaces: raw.workspaces
    };
  }
  async recordingCommand(input: RecordingCommandRequest): Promise<unknown> {
    return this.call('recording_command', input as unknown as Record<string, unknown>, 180_000);
  }
}

export const _test = { bridgeUrl, wsEndpoint };
