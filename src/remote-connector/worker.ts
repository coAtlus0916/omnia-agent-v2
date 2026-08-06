import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { WorkstationOmniaSession, ConnectorOperationError } from '../connector/workstation-omnia-session.js';
import type { ConnectorRequest } from '../connector/contracts.js';
import {
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA,
  REMOTE_CONNECTOR_DIAGNOSTICS_SCHEMA,
  type BridgeEnvelope,
  type RemoteConnectorDiagnosticsReport
} from '../shared/bridge-contracts.js';
import {
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_SUPERVISOR_VERSION,
  REMOTE_CONNECTOR_UPDATE_MANIFEST_URL,
  REMOTE_CONNECTOR_VERSION
} from './constants.js';
import {
  ensureRemoteConnectorDirectories,
  ensureManagedLaunchers,
  appendBootstrapMigrationDiagnostic,
  migrateSupervisorBootstrap,
  readManagedState,
  resolveRemoteConnectorPaths,
  writeJsonAtomic
} from './managed-state.js';
import { readSupervisorDiagnostics, redactDiagnosticText } from './diagnostics.js';
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
// Repair the stable managed entry for installations created before 0.3.13.
// Startup and future updates must never depend on an extracted version folder.
ensureManagedLaunchers(paths);
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
let heartbeatAt = new Date().toISOString();
let lastDiagnosticsSentAt = 0;
let bootstrapMigration: Record<string, unknown> = {
  state: 'pending',
  supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
  at: new Date().toISOString()
};
const expectedSupervisorPid = Number(process.env.OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_PID || 0);
const expectedSupervisorToken = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_TOKEN || '');
let supervisorLeaseMissingSince = 0;
let supervisorOwnerExitRequested = false;
let supervisorLeaseWaitLogged = false;
let supervisorRecoveryFailures = 0;
let supervisorRecoveryRetryAt = 0;
const SUPERVISOR_OWNER_LEASE_MS = 35_000;
const WORKER_RECOVERY_HANDOFF_MS = 60_000;

async function reconnectDelay(): Promise<void> {
  const base = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt, 5)));
  reconnectAttempt += 1;
  await new Promise((resolve) => setTimeout(resolve, base + Math.floor(Math.random() * Math.max(250, base / 3))));
}

function status(): void {
  heartbeatAt = new Date().toISOString();
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
    bootstrapMigration,
    updateManifestUrl: REMOTE_CONNECTOR_UPDATE_MANIFEST_URL,
    heartbeatAt
  });
}

function scheduleBootstrapMigration(attempt = 1): void {
  setTimeout(() => {
    try {
      const result = migrateSupervisorBootstrap(
        paths,
        path.resolve(path.dirname(process.argv[1] || ''), '..'),
        { gateWaitMs: 500 }
      );
      bootstrapMigration = { ...result };
      appendBootstrapMigrationDiagnostic(paths, {
        event: 'bootstrap_migration_completed',
        ...result,
        workerVersion: REMOTE_CONNECTOR_VERSION,
        pid: process.pid
      });
      status();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (['EBUSY', 'EEXIST'].includes(String(code || '')) && attempt < 16 && !stopping) {
        scheduleBootstrapMigration(attempt + 1);
        return;
      }
      const at = new Date().toISOString();
      const message = redactDiagnosticText(error instanceof Error ? error.message : 'unknown bootstrap migration error');
      bootstrapMigration = {
        state: 'failed',
        supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
        at,
        error: message
      };
      appendBootstrapMigrationDiagnostic(paths, {
        event: 'bootstrap_migration_failed',
        ...bootstrapMigration,
        workerVersion: REMOTE_CONNECTOR_VERSION,
        pid: process.pid
      });
      status();
    }
  }, attempt === 1 ? 0 : 2_000).unref();
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function supervisorOwnerLeaseIsHealthy(now = Date.now()): boolean {
  if (!Number.isSafeInteger(expectedSupervisorPid) || expectedSupervisorPid <= 0 || !expectedSupervisorToken) {
    return true;
  }
  let lock: Record<string, unknown> | null = null;
  let heartbeat: Record<string, unknown> | null = null;
  try { lock = JSON.parse(fs.readFileSync(paths.supervisorLock, 'utf8')) as Record<string, unknown>; } catch { /* lease check below */ }
  try { heartbeat = JSON.parse(fs.readFileSync(paths.supervisorHeartbeat, 'utf8')) as Record<string, unknown>; } catch { /* lease check below */ }
  const heartbeatAt = Date.parse(String(heartbeat?.heartbeatAt || ''));
  return Boolean(
    processIsAlive(expectedSupervisorPid)
    && lock?.schemaVersion === 'omnia.v5.remote-connector-supervisor-lock/v1'
    && lock.product === REMOTE_CONNECTOR_PRODUCT
    && Number(lock.pid) === expectedSupervisorPid
    && lock.token === expectedSupervisorToken
    && heartbeat?.schemaVersion === 'omnia.v5.remote-connector-supervisor-heartbeat/v1'
    && heartbeat.product === REMOTE_CONNECTOR_PRODUCT
    && Number(heartbeat.pid) === expectedSupervisorPid
    && heartbeat.token === expectedSupervisorToken
    && Number.isFinite(heartbeatAt)
    && now - heartbeatAt >= -5_000
    && now - heartbeatAt <= SUPERVISOR_OWNER_LEASE_MS
  );
}

function monitorSupervisorOwner(now = Date.now()): void {
  if (supervisorOwnerExitRequested || stopping || supervisorOwnerLeaseIsHealthy(now)) {
    if (!supervisorOwnerExitRequested) {
      supervisorLeaseMissingSince = 0;
      supervisorLeaseWaitLogged = false;
    }
    return;
  }
  if (!supervisorLeaseMissingSince) supervisorLeaseMissingSince = now;
  const missingFor = now - supervisorLeaseMissingSince;
  if (missingFor < SUPERVISOR_OWNER_LEASE_MS) return;
  if (activeOperations > 0) {
    if (!supervisorLeaseWaitLogged) {
      supervisorLeaseWaitLogged = true;
      appendBootstrapMigrationDiagnostic(paths, {
        event: 'supervisor_owner_lease_waiting_for_active_operations',
        at: new Date(now).toISOString(),
        workerVersion: REMOTE_CONNECTOR_VERSION,
        pid: process.pid,
        supervisorPid: expectedSupervisorPid,
        activeOperations
      });
    }
    return;
  }
  if (now < supervisorRecoveryRetryAt) return;
  supervisorOwnerExitRequested = true;
  appendBootstrapMigrationDiagnostic(paths, {
    event: 'supervisor_owner_lease_lost',
    at: new Date(now).toISOString(),
    workerVersion: REMOTE_CONNECTOR_VERSION,
    pid: process.pid,
    supervisorPid: expectedSupervisorPid,
    activeOperations
  });
  void recoverSupervisorAfterOwnerLoss();
}

async function startRecoverySupervisor(): Promise<void> {
  const runtime = path.join(paths.bootstrap, 'node.exe');
  const supervisor = path.join(paths.bootstrap, 'supervisor.cjs');
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const child = spawn(runtime, [supervisor], {
        cwd: paths.bootstrap,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: paths.installRoot,
          OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: paths.dataRoot
        }
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      appendBootstrapMigrationDiagnostic(paths, {
        event: 'worker_recovery_supervisor_spawned',
        at: new Date().toISOString(),
        workerVersion: REMOTE_CONNECTOR_VERSION,
        pid: process.pid,
        supervisorPid: child.pid || 0,
        attempt
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to start the recovery Supervisor.');
}

async function recoverSupervisorAfterOwnerLoss(): Promise<void> {
  const recoveryId = crypto.randomBytes(24).toString('base64url');
  const publishHandoff = () => {
    const createdAt = new Date();
    writeJsonAtomic(paths.workerRecoveryHandoff, {
      schemaVersion: 'omnia.v5.remote-connector-worker-recovery/v1',
      product: REMOTE_CONNECTOR_PRODUCT,
      recoveryId,
      ownerPid: expectedSupervisorPid,
      ownerToken: expectedSupervisorToken,
      workerPid: process.pid,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + WORKER_RECOVERY_HANDOFF_MS).toISOString()
    });
    return createdAt;
  };

  let createdAt: Date;
  try {
    createdAt = publishHandoff();
  } catch (error) {
    supervisorRecoveryFailures = Math.min(supervisorRecoveryFailures + 1, 5);
    supervisorRecoveryRetryAt = Date.now() + Math.min(30_000, 1_000 * (2 ** (supervisorRecoveryFailures - 1)));
    supervisorOwnerExitRequested = false;
    appendBootstrapMigrationDiagnostic(paths, {
      event: 'worker_recovery_handoff_failed',
      at: new Date().toISOString(),
      workerVersion: REMOTE_CONNECTOR_VERSION,
      pid: process.pid,
      supervisorPid: expectedSupervisorPid,
      retryAt: new Date(supervisorRecoveryRetryAt).toISOString(),
      error: redactDiagnosticText(error instanceof Error ? error.message : 'unknown handoff error')
    });
    return;
  }

  supervisorRecoveryFailures = 0;
  supervisorRecoveryRetryAt = 0;
  let shutdownError = '';
  try {
    await shutdown();
  } catch (error) {
    shutdownError = redactDiagnosticText(error instanceof Error ? error.message : 'worker shutdown failed');
  }

  try {
    createdAt = publishHandoff();
  } catch (error) {
    appendBootstrapMigrationDiagnostic(paths, {
      event: 'worker_recovery_handoff_refresh_failed',
      at: new Date().toISOString(),
      workerVersion: REMOTE_CONNECTOR_VERSION,
      pid: process.pid,
      supervisorPid: expectedSupervisorPid,
      error: redactDiagnosticText(error instanceof Error ? error.message : 'unknown handoff refresh error')
    });
  }
  appendBootstrapMigrationDiagnostic(paths, {
    event: 'worker_recovery_handoff_published',
    at: createdAt.toISOString(),
    workerVersion: REMOTE_CONNECTOR_VERSION,
    pid: process.pid,
    supervisorPid: expectedSupervisorPid,
    shutdownError
  });
  try {
    await startRecoverySupervisor();
  } catch (error) {
    appendBootstrapMigrationDiagnostic(paths, {
      event: 'worker_recovery_supervisor_failed',
      at: new Date().toISOString(),
      workerVersion: REMOTE_CONNECTOR_VERSION,
      pid: process.pid,
      supervisorPid: expectedSupervisorPid,
      error: redactDiagnosticText(error instanceof Error ? error.message : 'unknown recovery error'),
      shutdownError
    });
  } finally {
    process.exit(1);
  }
}

function sendDiagnostics(pairId: string, ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    const managed = readManagedState(paths);
    const diagnostics: RemoteConnectorDiagnosticsReport = {
      schemaVersion: REMOTE_CONNECTOR_DIAGNOSTICS_SCHEMA,
      reportedAt: new Date().toISOString(),
      pairId,
      connectorId: deviceIdentity.connectorId,
      version: REMOTE_CONNECTOR_VERSION,
      pid: process.pid,
      bridgeState,
      bridgeReason: redactDiagnosticText(bridgeReason),
      heartbeatAt,
      activeOperations,
      uncertainOperations: 0,
      managed: {
        current: managed.current,
        previous: managed.previous,
        pending: managed.pending ? {
          version: managed.pending.version,
          sequence: managed.pending.sequence,
          stagedAt: managed.pending.stagedAt
        } : null,
        highestSequence: managed.highestSequence
      },
      supervisorEvents: readSupervisorDiagnostics(paths)
    };
    ws.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'diagnostics', diagnostics }));
    lastDiagnosticsSentAt = Date.now();
  } catch {
    // Diagnostics are best-effort and must never interrupt command execution.
  }
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
        sendDiagnostics(credential.pairId, ws);
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
          if (commandGate.isActive(envelope.requestId)) {
            cancelledRequests.add(envelope.requestId);
            commandGate.cancel(envelope.requestId);
          }
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
        const execution = commandGate.handle(request, dispatch, envelope.deadlineAt);
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
  monitorSupervisorOwner();
  if (socket?.readyState === WebSocket.OPEN && socketCredentialPairId && Date.now() - lastDiagnosticsSentAt >= 10_000) {
    sendDiagnostics(socketCredentialPairId, socket);
  }
  const candidate = readCandidateBridgeCredential(paths.dataRoot);
  if (candidate && activeOperations === 0 && socket?.readyState === WebSocket.OPEN && candidate.pairId !== socketCredentialPairId) {
    socket.close(4000, 'candidate credential ready');
  }
}, 2_000);
timer.unref();
status();
scheduleBootstrapMigration();
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
