import fs from 'node:fs';
import { WebSocket } from 'ws';
import { WorkstationOmniaSession, ConnectorOperationError } from '../connector/workstation-omnia-session.js';
import type { ConnectorRequest } from '../connector/contracts.js';
import { BRIDGE_PROTOCOL, BRIDGE_SCHEMA, type BridgeEnvelope } from '../shared/bridge-contracts.js';
import {
  REMOTE_CONNECTOR_PRODUCT,
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
  clearStoredBridgeCredential,
  clearCandidateBridgeCredential,
  acceptCommittedCandidateBridgeCredential,
  readCandidateBridgeCredential,
  readOrCreateConnectorDeviceIdentity,
  readStoredBridgeCredentialState,
  validateRemoteBridgeUrl
} from './bridge-credential.js';

if (process.argv.includes('--health-probe')) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    product: REMOTE_CONNECTOR_PRODUCT,
    version: REMOTE_CONNECTOR_VERSION,
    mode: 'remote',
    protocol: BRIDGE_PROTOCOL,
    operationHost: 'official-signed-package-gate',
    recordingCommand: 'omnia.v5.recording-command/v1'
  })}\n`);
  process.exit(0);
}

const paths = resolveRemoteConnectorPaths();
ensureRemoteConnectorDirectories(paths);
const deviceIdentity = readOrCreateConnectorDeviceIdentity(paths.dataRoot);
const connector = new WorkstationOmniaSession(paths.dataRoot, fetch, {
  id: deviceIdentity.connectorId,
  name: 'Omnia Agent v5 Remote Connector',
  version: REMOTE_CONNECTOR_VERSION
});
const commandGate = new RemoteCommandGate();
let stopping = false;
let bridgeState: 'unpaired' | 'repair_required' | 'connector_incompatible' | 'connecting' | 'connected' | 'disconnected' = 'unpaired';
let bridgeReason = '';
let activeOperations = 0;
let candidateFailureCount = 0;
let socket: WebSocket | null = null;
const cancelledRequests = new Set<string>();
let reconnectAttempt = 0;
let credentialRepairRequired = false;
let socketCredentialPairId = '';

async function reconnectDelay(): Promise<void> {
  const base = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt, 5)));
  reconnectAttempt += 1;
  await new Promise((resolve) => setTimeout(resolve, base + Math.floor(Math.random() * Math.max(250, base / 3))));
}

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

function requestOnlineUpdate(): void {
  fs.writeFileSync(paths.updateRequest, new Date().toISOString(), { encoding: 'utf8', mode: 0o600 });
}

async function dispatch(request: ConnectorRequest): Promise<unknown> {
  switch (request.operation) {
    case 'health': return connector.health();
    case 'connect': return connector.connect();
    case 'refresh': return connector.refresh();
    case 'status': return connector.status();
    case 'workspace_authority_read':
      return connector.workspaceAuthorityRead(String(request.payload.expectedEngagementId || ''));
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
  const credentialState = readStoredBridgeCredentialState(paths.dataRoot);
  const candidateCredential = readCandidateBridgeCredential(paths.dataRoot);
  const credential = candidateCredential || credentialState.credential;
  if (!credential) {
    if (credentialState.state === 'repair_required') credentialRepairRequired = true;
    bridgeState = credentialRepairRequired ? 'repair_required' : 'unpaired';
    bridgeReason = credentialRepairRequired
      ? '设备凭据已撤销或 generation 失效，需要从 Agent Connect 流程重新配对。'
      : '尚未绑定 Omnia Agent；请在 Agent 顶部 Connect 流程生成链接码后运行 PairRemoteConnector.cmd。';
    status();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return;
  }
  try {
    socketCredentialPairId = credential.pairId;
    bridgeState = 'connecting';
    bridgeReason = '';
    status();
    const base = validateRemoteBridgeUrl(credential.bridgeUrl);
    const url = new URL('v1/connect', base.href.endsWith('/') ? base.href : `${base.href}/`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${credential.token}`,
          'X-Omnia-Protocol': BRIDGE_PROTOCOL,
          'X-Omnia-Connector-Id': deviceIdentity.connectorId,
          'X-Omnia-Connector-Version': REMOTE_CONNECTOR_VERSION
        },
        handshakeTimeout: 15_000,
        maxPayload: 2 * 1024 * 1024
      });
      socket = ws;
      ws.once('open', () => {
        reconnectAttempt = 0;
        bridgeState = 'connected';
        bridgeReason = '';
        status();
      });
      ws.on('message', (data) => {
        let envelope: BridgeEnvelope;
        try { envelope = JSON.parse(data.toString()) as BridgeEnvelope; } catch { return; }
        if (envelope.schemaVersion !== BRIDGE_SCHEMA) return;
        if (envelope.kind === 'binding_committed') {
          if (
            candidateCredential?.pairId === credential.pairId
            && envelope.pairId === credential.pairId
            && envelope.generation === credential.generation
          ) {
            if (acceptCommittedCandidateBridgeCredential(paths.dataRoot, envelope.pairId, envelope.generation)) {
              candidateFailureCount = 0;
            }
          }
          return;
        }
        if (envelope.kind === 'update_check') {
          requestOnlineUpdate();
          return;
        }
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
      ws.once('close', (code) => {
        if (code === 4003) {
          if (candidateCredential?.pairId === credential.pairId) {
            clearCandidateBridgeCredential(paths.dataRoot);
            bridgeState = credentialState.credential ? 'disconnected' : 'repair_required';
            credentialRepairRequired = !credentialState.credential;
            bridgeReason = credentialState.credential ? '候选绑定验证失败，已保留并恢复旧绑定。' : '候选设备凭据被拒，需要重新配对。';
          } else {
            clearStoredBridgeCredential(paths.dataRoot);
            credentialRepairRequired = true;
            bridgeState = 'repair_required';
            bridgeReason = '设备凭据已撤销或 generation 失效，需要从 Agent Connect 流程重新配对。';
          }
          status();
        }
        resolve();
      });
      ws.once('error', reject);
      ws.once('unexpected-response', (_request, response) => {
        if (response.statusCode === 426) {
          if (candidateCredential && credentialState.credential) {
            clearCandidateBridgeCredential(paths.dataRoot);
            candidateFailureCount = 0;
            bridgeState = 'disconnected';
            bridgeReason = '候选绑定协议不兼容，已保留并恢复旧绑定。';
          } else {
            bridgeState = 'connector_incompatible';
            bridgeReason = 'Remote Connector 版本或协议与 Bridge 不兼容。';
            stopping = true;
          }
        } else if ([401, 403].includes(response.statusCode || 0)) {
          if (candidateCredential) {
            clearCandidateBridgeCredential(paths.dataRoot);
            bridgeState = credentialState.credential ? 'disconnected' : 'repair_required';
            credentialRepairRequired = !credentialState.credential;
          } else {
            clearStoredBridgeCredential(paths.dataRoot);
            bridgeState = 'repair_required';
            credentialRepairRequired = true;
          }
          bridgeReason = credentialRepairRequired ? '设备凭据已失效，需要重新配对。' : '候选绑定失败，正在恢复旧绑定。';
        }
        status();
        ws.terminate();
        reject(new Error(bridgeReason));
      });
    });
  } catch (error) {
    if (candidateCredential && bridgeState !== 'repair_required' && bridgeState !== 'connector_incompatible') {
      candidateFailureCount += 1;
      if (candidateFailureCount >= 3) {
        clearCandidateBridgeCredential(paths.dataRoot);
        candidateFailureCount = 0;
        bridgeReason = credentialState.credential
          ? '候选绑定连续连接失败，已清除候选并恢复旧绑定。'
          : '候选绑定连续连接失败，需要重新配对。';
        if (!credentialState.credential) {
          credentialRepairRequired = true;
          bridgeState = 'repair_required';
        }
      }
    }
    if (bridgeState !== 'repair_required' && bridgeState !== 'connector_incompatible') {
      bridgeState = 'disconnected';
      if (!bridgeReason) bridgeReason = error instanceof Error ? error.message.slice(0, 500) : 'Remote Bridge 连接失败。';
    }
    status();
  } finally {
    socket = null;
    socketCredentialPairId = '';
  }
  if (!stopping && !credentialRepairRequired) await reconnectDelay();
}

const timer = setInterval(() => {
  status();
  const candidate = readCandidateBridgeCredential(paths.dataRoot);
  if (candidate && activeOperations === 0 && socket?.readyState === WebSocket.OPEN && candidate.pairId !== socketCredentialPairId) {
    socket.close(4000, 'candidate credential ready');
  }
}, 2_000);
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
