import { WebSocket } from 'ws';
import { LocalConnector, ConnectorOperationError } from '../connector/local-connector.js';
import type { ConnectorRequest } from '../connector/contracts.js';
import { BRIDGE_SCHEMA, type BridgeEnvelope } from '../shared/bridge-contracts.js';
import {
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_BRIDGE_URL,
  REMOTE_CONNECTOR_UPDATE_MANIFEST_URL,
  REMOTE_CONNECTOR_VERSION
} from './constants.js';
import {
  ensureRemoteConnectorDirectories,
  resolveRemoteConnectorPaths,
  writeJsonAtomic
} from './managed-state.js';
import { RemoteCommandGate } from './wire-request.js';
import {
  pollWaitingConnector,
  readOrCreateConnectorDeviceIdentity,
  readStoredBridgeCredential,
  registerWaitingConnector,
  validateRemoteBridgeUrl
} from './bridge-credential.js';

if (process.argv.includes('--health-probe')) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    product: REMOTE_CONNECTOR_PRODUCT,
    version: REMOTE_CONNECTOR_VERSION,
    mode: 'remote',
    protocol: BRIDGE_SCHEMA,
    operationHost: 'official-signed-package-gate',
    recordingCommand: 'omnia.v5.recording-command/v1'
  })}\n`);
  process.exit(0);
}

const paths = resolveRemoteConnectorPaths();
ensureRemoteConnectorDirectories(paths);
const deviceIdentity = readOrCreateConnectorDeviceIdentity(paths.dataRoot);
const connector = new LocalConnector(paths.dataRoot, fetch, {
  id: deviceIdentity.connectorId,
  name: 'Omnia Agent v5 Remote Connector',
  version: REMOTE_CONNECTOR_VERSION
});
const commandGate = new RemoteCommandGate();
let stopping = false;
let bridgeState: 'waiting_matching' | 'connecting' | 'connected' | 'disconnected' = 'waiting_matching';
let bridgeReason = '';
let activeOperations = 0;
let socket: WebSocket | null = null;
const cancelledRequests = new Set<string>();

function status(): void {
  writeJsonAtomic(paths.status, {
    schemaVersion: 'omnia.v5.remote-connector-status/v1',
    product: REMOTE_CONNECTOR_PRODUCT,
    version: REMOTE_CONNECTOR_VERSION,
    pid: process.pid,
    mode: 'remote',
    bridgeState,
    bridgeReason,
    activeOperations,
    uncertainOperations: 0,
    updateManifestUrl: REMOTE_CONNECTOR_UPDATE_MANIFEST_URL,
    heartbeatAt: new Date().toISOString()
  });
}

async function dispatch(request: ConnectorRequest): Promise<unknown> {
  switch (request.operation) {
    case 'health': return connector.health();
    case 'connect': return connector.connect();
    case 'refresh': return connector.refresh();
    case 'status': return connector.status();
    case 'workspace_light_read':
      return connector.workspaceLightRead(String(request.payload.expectedEngagementId || ''));
    case 'recording_command':
      return connector.recordingCommand(request.payload as any);
    case 'operation_register':
      return connector.registerOperation(request.payload as any);
    case 'operation_invoke':
      return connector.invokeOperation(request.payload as any);
    default:
      throw new ConnectorOperationError('CONNECTOR.UNKNOWN_OPERATION', 'Connector operation 不受支持。');
  }
}

async function runSocket(): Promise<void> {
  const credential = readStoredBridgeCredential(paths.dataRoot);
  if (!credential) {
    bridgeState = 'waiting_matching';
    bridgeReason = '正在等待 Omnia Agent Remote Connect 匹配。';
    status();
    try {
      const lease = await registerWaitingConnector({
        dataRoot: paths.dataRoot,
        bridgeUrl: process.env.OMNIA_V5_REMOTE_BRIDGE_URL || REMOTE_CONNECTOR_BRIDGE_URL
      });
      bridgeReason = `等待匹配设备 ${lease.connectorId}；lease 将于 ${lease.expiresAt} 到期。`;
      status();
      while (!stopping && Date.parse(lease.expiresAt) > Date.now()) {
        const state = await pollWaitingConnector({ dataRoot: paths.dataRoot, lease });
        if (state === 'matched') {
          bridgeReason = '匹配完成，正在建立受保护的 v5 Bridge 会话。';
          status();
          return;
        }
        if (state === 'expired') return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } catch (error) {
      bridgeState = 'disconnected';
      bridgeReason = error instanceof Error ? `等待匹配失败：${error.message}`.slice(0, 500) : '等待匹配失败。';
      status();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    return;
  }
  try {
    bridgeState = 'connecting';
    bridgeReason = '';
    status();
    const base = validateRemoteBridgeUrl(credential.bridgeUrl);
    const url = new URL('v1/connect', base.href.endsWith('/') ? base.href : `${base.href}/`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${credential.token}` },
        handshakeTimeout: 15_000,
        maxPayload: 2 * 1024 * 1024
      });
      socket = ws;
      ws.once('open', () => {
        bridgeState = 'connected';
        bridgeReason = '';
        status();
      });
      ws.on('message', (data) => {
        let envelope: BridgeEnvelope;
        try { envelope = JSON.parse(data.toString()) as BridgeEnvelope; } catch { return; }
        if (envelope.schemaVersion !== BRIDGE_SCHEMA) return;
        if (envelope.kind === 'cancel') {
          if (commandGate.isActive(envelope.requestId)) cancelledRequests.add(envelope.requestId);
          return;
        }
        if (envelope.kind !== 'command') return;
        const request = envelope.request;
        if (!Number.isFinite(Date.parse(envelope.deadlineAt)) || Date.parse(envelope.deadlineAt) <= Date.now()) {
          ws.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'result',
            response: {
              schemaVersion: 'omnia.connector-ipc/v1',
              id: request.id,
              ok: false,
              error: { code: 'REMOTE.DEADLINE_EXCEEDED', message: '命令在到达 Connector 前已超时。', retryable: true }
            }
          }));
          return;
        }
        const execution = commandGate.handle(request, dispatch);
        activeOperations = commandGate.activeCount;
        status();
        void execution.then((response) => {
          if (ws.readyState === WebSocket.OPEN && !cancelledRequests.delete(request.id)) {
            ws.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response }));
          }
        }).finally(() => {
          activeOperations = commandGate.activeCount;
          status();
        });
      });
      ws.once('close', () => resolve());
      ws.once('error', reject);
    });
  } catch (error) {
    bridgeState = 'disconnected';
    bridgeReason = error instanceof Error ? error.message.slice(0, 500) : 'Remote Bridge 连接失败。';
    status();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } finally {
    socket = null;
  }
}

const timer = setInterval(status, 2_000);
timer.unref();
status();
void (async () => {
  while (!stopping) await runSocket();
})().catch(() => undefined);

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  socket?.close(1000, 'shutdown');
  await connector.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
}
