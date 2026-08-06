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
import { bridgeSocketHeartbeatDecision } from './socket-health.js';
import {
  clearStoredBridgeCredential,
  clearCandidateBridgeCredential,
  acceptCommittedCandidateBridgeCredential,
  readCandidateBridgeCredential,
  readOrCreateConnectorDeviceIdentity,
  readStoredBridgeCredentialState,
  validateRemoteBridgeUrl
} from './bridge-credential.js';

const SUPERVISOR_TAKEOVER_HEARTBEAT_MS = 10_000;
const SUPERVISOR_TAKEOVER_ACK_TIMEOUT_MS = 12_000;
const SUPERVISOR_RECOVERY_MAX_ATTEMPTS = 3;
const SUPERVISOR_ACTIVE_OPERATION_DIAGNOSTIC_MS = 30_000;

type SupervisorTakeoverRecord = Record<string, unknown> | null;

export function supervisorRecoveryDecision(input: {
  ownerHealthy: boolean;
  recoveryInProgress: boolean;
  missingForMs: number;
  ownerLeaseMs: number;
  activeOperations: number;
  now: number;
  retryAt: number;
}): 'healthy' | 'in_progress' | 'wait_lease' | 'drain_active' | 'wait_retry' | 'recover' {
  if (input.recoveryInProgress) return 'in_progress';
  if (input.ownerHealthy) return 'healthy';
  if (input.missingForMs < input.ownerLeaseMs) return 'wait_lease';
  if (input.activeOperations > 0) return 'drain_active';
  if (input.now < input.retryAt) return 'wait_retry';
  return 'recover';
}

export function supervisorRecoveryRetryDelayMs(failures: number): number {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, Math.min(5, failures - 1))));
}

export function evaluateSupervisorTakeover(input: {
  lock: SupervisorTakeoverRecord;
  heartbeat: SupervisorTakeoverRecord;
  expectedOwnerPid: number;
  expectedOwnerToken: string;
  workerPid: number;
  minimumCreatedAt: number;
  now: number;
  newSupervisorAlive: boolean;
}): { acknowledged: boolean; reason: string; supervisorPid: number; heartbeatAt: string } {
  const lock = input.lock;
  const heartbeat = input.heartbeat;
  const supervisorPid = Number(lock?.pid || 0);
  const lockToken = typeof lock?.token === 'string' ? lock.token : '';
  const lockCreatedAt = Date.parse(String(lock?.createdAt || ''));
  const heartbeatAt = String(heartbeat?.heartbeatAt || '');
  const heartbeatTime = Date.parse(heartbeatAt);
  if (
    lock?.schemaVersion !== 'omnia.v5.remote-connector-supervisor-lock/v1'
    || lock.product !== REMOTE_CONNECTOR_PRODUCT
    || !Number.isSafeInteger(supervisorPid)
    || supervisorPid <= 0
    || lockToken.length < 16
    || !Number.isFinite(lockCreatedAt)
  ) return { acknowledged: false, reason: 'replacement_lock_missing_or_invalid', supervisorPid: 0, heartbeatAt: '' };
  if (supervisorPid === input.expectedOwnerPid || lockToken === input.expectedOwnerToken) {
    return { acknowledged: false, reason: 'owner_lock_not_replaced', supervisorPid, heartbeatAt: '' };
  }
  if (lockCreatedAt < input.minimumCreatedAt - 5_000 || !input.newSupervisorAlive) {
    return { acknowledged: false, reason: 'replacement_supervisor_not_live', supervisorPid, heartbeatAt: '' };
  }
  if (
    heartbeat?.schemaVersion !== 'omnia.v5.remote-connector-supervisor-heartbeat/v1'
    || heartbeat.product !== REMOTE_CONNECTOR_PRODUCT
    || Number(heartbeat.pid) !== supervisorPid
    || heartbeat.token !== lockToken
    || !Number.isSafeInteger(Number(heartbeat.workerPid))
    || Number(heartbeat.workerPid) < 0
  ) return { acknowledged: false, reason: 'replacement_heartbeat_identity_mismatch', supervisorPid, heartbeatAt };
  if (
    !Number.isFinite(heartbeatTime)
    || input.now - heartbeatTime < -5_000
    || input.now - heartbeatTime > SUPERVISOR_TAKEOVER_HEARTBEAT_MS
  ) return { acknowledged: false, reason: 'replacement_heartbeat_stale', supervisorPid, heartbeatAt };
  return { acknowledged: true, reason: 'replacement_supervisor_acknowledged', supervisorPid, heartbeatAt };
}

if (process.argv.includes('--recovery-contract-probe')) {
  const input = JSON.parse(fs.readFileSync(0, 'utf8')) as {
    takeoverCases?: Array<Parameters<typeof evaluateSupervisorTakeover>[0]>;
    decisionCases?: Array<Parameters<typeof supervisorRecoveryDecision>[0]>;
    retryFailures?: number[];
  };
  process.stdout.write(`${JSON.stringify({
    takeover: (input.takeoverCases || []).map(evaluateSupervisorTakeover),
    decisions: (input.decisionCases || []).map(supervisorRecoveryDecision),
    retryDelays: (input.retryFailures || []).map(supervisorRecoveryRetryDelayMs),
    maxAttempts: SUPERVISOR_RECOVERY_MAX_ATTEMPTS
  })}\n`);
  process.exit(0);
}

if (process.argv.includes('--health-probe')) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    product: REMOTE_CONNECTOR_PRODUCT,
    version: REMOTE_CONNECTOR_VERSION,
    mode: 'remote',
    protocol: BRIDGE_PROTOCOL,
    operationHost: 'official-signed-package-gate',
    pageObservation: 'omnia.page-observation.current-pack.v1'
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
let bridgeState: 'unpaired' | 'repair_required' | 'connector_incompatible' | 'connecting' | 'connected' | 'disconnected' | 'fenced' = 'unpaired';
let bridgeReason = '';
let activeOperations = 0;
let candidateFailureCount = 0;
let socket: WebSocket | null = null;
const cancelledRequests = new Set<string>();
let reconnectAttempt = 0;
let replacedBackoffUntil = 0;
let credentialRepairRequired = false;
let socketCredentialPairId = '';
let heartbeatAt = new Date().toISOString();
let lastDiagnosticsSentAt = 0;
let lastBridgePingAt = 0;
let lastBridgePongAt = 0;
let bootstrapMigration: Record<string, unknown> = {
  state: 'pending',
  supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
  at: new Date().toISOString()
};
const expectedSupervisorPid = Number(process.env.OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_PID || 0);
const expectedSupervisorToken = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_TOKEN || '');
let supervisorLeaseMissingSince = 0;
let supervisorLeaseWaitLogged = false;
let supervisorRecoveryFailures = 0;
let supervisorRecoveryRetryAt = 0;
let supervisorRecoveryInProgress = false;
let supervisorRecoveryQuiescing = false;
let supervisorActiveOperationDrainStartedAt = 0;
let supervisorActiveOperationDeadlineLogged = false;
const SUPERVISOR_OWNER_LEASE_MS = 35_000;
const WORKER_RECOVERY_HANDOFF_MS = 60_000;
const REPLACED_CONNECTION_BACKOFF_MS = 5 * 60_000;
const WEBSOCKET_CLOSE_TIMEOUT_MS = 5_000;
const WEBSOCKET_PING_INTERVAL_MS = 10_000;
const WEBSOCKET_PONG_TIMEOUT_MS = 30_000;
let shutdownPromise: Promise<void> | null = null;

async function reconnectDelay(): Promise<void> {
  const base = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt, 5)));
  reconnectAttempt += 1;
  const ordinaryDelay = base + Math.floor(Math.random() * Math.max(250, base / 3));
  const fencedDelay = Math.max(0, replacedBackoffUntil - Date.now());
  await new Promise((resolve) => setTimeout(resolve, Math.max(ordinaryDelay, fencedDelay)));
}

function status(): void {
  heartbeatAt = new Date().toISOString();
  try {
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
  } catch {
    // Antivirus/indexer locks and ACL transitions must not take down a live Worker.
  }
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

function readJsonRecord(filename: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function recordLifecycleDiagnostic(detail: Record<string, unknown>): void {
  try {
    appendBootstrapMigrationDiagnostic(paths, {
      at: new Date().toISOString(),
      workerVersion: REMOTE_CONNECTOR_VERSION,
      pid: process.pid,
      supervisorPid: expectedSupervisorPid,
      ...detail
    });
  } catch {
    // Recovery must not crash merely because the diagnostics file is unavailable.
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function replacementSupervisorLockObserved(lock: Record<string, unknown> | null): boolean {
  const pid = Number(lock?.pid || 0);
  const token = typeof lock?.token === 'string' ? lock.token : '';
  return Boolean(
    lock?.schemaVersion === 'omnia.v5.remote-connector-supervisor-lock/v1'
    && lock.product === REMOTE_CONNECTOR_PRODUCT
    && Number.isSafeInteger(pid)
    && pid > 0
    && token.length >= 16
    && pid !== expectedSupervisorPid
    && token !== expectedSupervisorToken
  );
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
  if (stopping) return;
  const ownerHealthy = supervisorOwnerLeaseIsHealthy(now);
  if (ownerHealthy) {
    supervisorLeaseMissingSince = 0;
    supervisorLeaseWaitLogged = false;
    supervisorActiveOperationDrainStartedAt = 0;
    supervisorActiveOperationDeadlineLogged = false;
    if (!supervisorRecoveryInProgress) {
      supervisorRecoveryQuiescing = false;
    }
    return;
  }
  if (!supervisorLeaseMissingSince) supervisorLeaseMissingSince = now;
  const missingFor = now - supervisorLeaseMissingSince;
  const decision = supervisorRecoveryDecision({
    ownerHealthy,
    recoveryInProgress: supervisorRecoveryInProgress,
    missingForMs: missingFor,
    ownerLeaseMs: SUPERVISOR_OWNER_LEASE_MS,
    activeOperations,
    now,
    retryAt: supervisorRecoveryRetryAt
  });
  if (decision === 'drain_active') {
    supervisorRecoveryQuiescing = true;
    bridgeReason = 'Supervisor owner lease is stale; waiting fail-closed for the active command to finish before recovery.';
    status();
    if (!supervisorLeaseWaitLogged) {
      supervisorLeaseWaitLogged = true;
      supervisorActiveOperationDrainStartedAt = now;
      recordLifecycleDiagnostic({
        event: 'supervisor_owner_lease_waiting_for_active_operations',
        activeOperations
      });
    }
    if (
      !supervisorActiveOperationDeadlineLogged
      && supervisorActiveOperationDrainStartedAt > 0
      && now - supervisorActiveOperationDrainStartedAt >= SUPERVISOR_ACTIVE_OPERATION_DIAGNOSTIC_MS
    ) {
      supervisorActiveOperationDeadlineLogged = true;
      recordLifecycleDiagnostic({
        event: 'supervisor_owner_recovery_blocked_by_active_operations',
        activeOperations,
        blockedForMs: now - supervisorActiveOperationDrainStartedAt,
        policy: 'fail_closed_no_force_cancel_no_uncertain_fabrication'
      });
    }
    return;
  }
  if (decision !== 'recover') return;
  supervisorRecoveryInProgress = true;
  supervisorRecoveryQuiescing = true;
  recordLifecycleDiagnostic({
    event: 'supervisor_owner_lease_lost',
    activeOperations,
    missingForMs: missingFor
  });
  void recoverSupervisorAfterOwnerLoss();
}

async function startRecoverySupervisor(attempt: number): Promise<number> {
  const runtime = path.join(paths.bootstrap, 'node.exe');
  const supervisor = path.join(paths.bootstrap, 'supervisor.cjs');
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
  const supervisorPid = child.pid || 0;
  recordLifecycleDiagnostic({ event: 'worker_recovery_supervisor_spawned', supervisorPid, attempt });
  return supervisorPid;
}

async function waitForSupervisorTakeover(minimumCreatedAt: number): Promise<ReturnType<typeof evaluateSupervisorTakeover>> {
  const deadline = Date.now() + SUPERVISOR_TAKEOVER_ACK_TIMEOUT_MS;
  let result: ReturnType<typeof evaluateSupervisorTakeover> = {
    acknowledged: false,
    reason: 'replacement_lock_missing_or_invalid',
    supervisorPid: 0,
    heartbeatAt: ''
  };
  while (Date.now() < deadline && !stopping) {
    const lock = readJsonRecord(paths.supervisorLock);
    const supervisorPid = Number(lock?.pid || 0);
    result = evaluateSupervisorTakeover({
      lock,
      heartbeat: readJsonRecord(paths.supervisorHeartbeat),
      expectedOwnerPid: expectedSupervisorPid,
      expectedOwnerToken: expectedSupervisorToken,
      workerPid: process.pid,
      minimumCreatedAt,
      now: Date.now(),
      newSupervisorAlive: Number.isSafeInteger(supervisorPid) && supervisorPid > 0 && processIsAlive(supervisorPid)
    });
    if (result.acknowledged) return result;
    await wait(250);
  }
  return result;
}

async function quiesceRemoteConnectionForSupervisorRecovery(): Promise<void> {
  bridgeState = 'disconnected';
  bridgeReason = 'Supervisor recovery is in progress; new commands are quiesced before dispatch.';
  status();
  await closeSocketGracefully();
}

async function exitAfterSupervisorTakeover(
  takeover: ReturnType<typeof evaluateSupervisorTakeover>,
  attempt: number
): Promise<never> {
  recordLifecycleDiagnostic({
    event: 'worker_recovery_supervisor_acknowledged',
    attempt,
    newSupervisorPid: takeover.supervisorPid,
    heartbeatAt: takeover.heartbeatAt
  });
  try {
    await shutdown();
  } catch (error) {
    recordLifecycleDiagnostic({
      event: 'worker_recovery_shutdown_failed_after_ack',
      newSupervisorPid: takeover.supervisorPid,
      error: redactDiagnosticText(error instanceof Error ? error.message : 'worker shutdown failed after takeover acknowledgement')
    });
  }
  process.exit(1);
}

function clearWorkerRecoveryHandoff(recoveryId: string): void {
  const handoff = readJsonRecord(paths.workerRecoveryHandoff);
  if (handoff?.recoveryId !== recoveryId) return;
  try { fs.unlinkSync(paths.workerRecoveryHandoff); } catch { /* best effort, strict expiry also bounds it */ }
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
    supervisorRecoveryRetryAt = Date.now() + supervisorRecoveryRetryDelayMs(supervisorRecoveryFailures);
    supervisorRecoveryInProgress = false;
    supervisorRecoveryQuiescing = false;
    recordLifecycleDiagnostic({
      event: 'worker_recovery_handoff_failed',
      retryAt: new Date(supervisorRecoveryRetryAt).toISOString(),
      error: redactDiagnosticText(error instanceof Error ? error.message : 'unknown handoff error')
    });
    return;
  }
  const recoveryWindowStartedAt = createdAt.getTime();

  try {
    await quiesceRemoteConnectionForSupervisorRecovery();
  } catch (error) {
    recordLifecycleDiagnostic({
      event: 'worker_recovery_remote_quiesce_failed',
      error: redactDiagnosticText(error instanceof Error ? error.message : 'remote quiesce failed')
    });
  }
  recordLifecycleDiagnostic({
    event: 'worker_recovery_handoff_published',
    handoffCreatedAt: createdAt.toISOString()
  });

  for (let attempt = 1; attempt <= SUPERVISOR_RECOVERY_MAX_ATTEMPTS && !stopping; attempt += 1) {
    if (attempt > 1) {
      try {
        createdAt = publishHandoff();
        recordLifecycleDiagnostic({
          event: 'worker_recovery_handoff_refreshed',
          handoffCreatedAt: createdAt.toISOString(),
          attempt
        });
      } catch (error) {
        recordLifecycleDiagnostic({
          event: 'worker_recovery_handoff_refresh_failed',
          attempt,
          error: redactDiagnosticText(error instanceof Error ? error.message : 'unknown handoff refresh error')
        });
        await wait(supervisorRecoveryRetryDelayMs(attempt));
        continue;
      }
    }
    try {
      await startRecoverySupervisor(attempt);
    } catch (error) {
      recordLifecycleDiagnostic({
        event: 'worker_recovery_supervisor_spawn_failed',
        attempt,
        error: redactDiagnosticText(error instanceof Error ? error.message : 'unknown recovery spawn error')
      });
      await wait(supervisorRecoveryRetryDelayMs(attempt));
      continue;
    }
    const takeover = await waitForSupervisorTakeover(recoveryWindowStartedAt);
    if (takeover.acknowledged) {
      await exitAfterSupervisorTakeover(takeover, attempt);
    }
    recordLifecycleDiagnostic({
      event: 'worker_recovery_supervisor_ack_timeout',
      attempt,
      observedSupervisorPid: takeover.supervisorPid,
      observedHeartbeatAt: takeover.heartbeatAt,
      reason: takeover.reason
    });
    if (attempt < SUPERVISOR_RECOVERY_MAX_ATTEMPTS) {
      await wait(supervisorRecoveryRetryDelayMs(attempt));
    }
  }

  supervisorRecoveryFailures = Math.min(supervisorRecoveryFailures + 1, 5);
  supervisorRecoveryRetryAt = Date.now() + supervisorRecoveryRetryDelayMs(supervisorRecoveryFailures);
  let replacementPending = replacementSupervisorLockObserved(readJsonRecord(paths.supervisorLock));
  if (replacementPending && !stopping) {
    const finalTakeover = await waitForSupervisorTakeover(recoveryWindowStartedAt);
    if (finalTakeover.acknowledged) {
      await exitAfterSupervisorTakeover(finalTakeover, SUPERVISOR_RECOVERY_MAX_ATTEMPTS);
    }
    replacementPending = replacementSupervisorLockObserved(readJsonRecord(paths.supervisorLock));
  }
  recordLifecycleDiagnostic({
    event: replacementPending
      ? 'worker_recovery_replacement_pending_without_ack'
      : 'worker_recovery_attempts_exhausted',
    attempts: SUPERVISOR_RECOVERY_MAX_ATTEMPTS,
    retryAt: new Date(supervisorRecoveryRetryAt).toISOString(),
    policy: replacementPending ? 'fail_closed' : 'resume_remote_service'
  });
  if (!replacementPending) clearWorkerRecoveryHandoff(recoveryId);
  supervisorRecoveryInProgress = replacementPending;
  supervisorRecoveryQuiescing = replacementPending;
  supervisorLeaseMissingSince = replacementPending ? supervisorLeaseMissingSince : Date.now();
  bridgeState = 'disconnected';
  bridgeReason = replacementPending
    ? 'A replacement Supervisor lock exists without a fresh matching heartbeat; remaining fail-closed.'
    : 'Supervisor recovery attempts were exhausted; remote service resumed pending the next bounded retry.';
  status();
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
      // Diagnostics are emitted only while the socket is OPEN, where the state is connected.
      bridgeState: bridgeState as RemoteConnectorDiagnosticsReport['bridgeState'],
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
  try {
    fs.writeFileSync(paths.updateRequest, new Date().toISOString(), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // A transient data-directory lock must not escape the WebSocket message handler.
  }
}

async function dispatch(request: ConnectorRequest): Promise<unknown> {
  switch (request.operation) {
    case 'health': return connector.health();
    case 'connect': return connector.connect();
    case 'refresh': return connector.refresh();
    case 'status': return connector.status();
    case 'workspace_authority_read':
      return connector.workspaceAuthorityRead(String(request.payload.expectedEngagementId || ''));
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
        const now = Date.now();
        reconnectAttempt = 0;
        replacedBackoffUntil = 0;
        lastBridgePingAt = now;
        lastBridgePongAt = now;
        bridgeState = 'connected';
        bridgeReason = '';
        status();
        sendDiagnostics(credential.pairId, ws);
      });
      ws.on('pong', () => {
        lastBridgePongAt = Date.now();
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
        if (supervisorRecoveryQuiescing) {
          ws.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'result',
            response: {
              schemaVersion: 'omnia.connector-ipc/v1',
              id: request.id,
              ok: false,
              error: {
                code: 'REMOTE.SUPERVISOR_RECOVERY_QUIESCING',
                message: 'Supervisor recovery quiesced this command before dispatch; no Connector effect was started.',
                retryable: false
              }
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
        if (code === 4001) {
          replacedBackoffUntil = Date.now() + REPLACED_CONNECTION_BACKOFF_MS;
          bridgeState = 'fenced';
          bridgeReason = 'Bridge replaced this connection with another instance. This Worker is fenced and will retry after a long backoff.';
          status();
        } else if (code === 4003) {
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
        } else if (!stopping && !supervisorRecoveryInProgress && !supervisorRecoveryQuiescing) {
          bridgeState = 'disconnected';
          bridgeReason = `Remote Bridge connection closed (${code}).`;
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
    if (
      candidateCredential
      && !supervisorRecoveryInProgress
      && !supervisorRecoveryQuiescing
      && bridgeState !== 'repair_required'
      && bridgeState !== 'connector_incompatible'
    ) {
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
    lastBridgePingAt = 0;
    lastBridgePongAt = 0;
  }
  if (!stopping && !credentialRepairRequired && !supervisorRecoveryInProgress && !supervisorRecoveryQuiescing) {
    await reconnectDelay();
  }
}

const timer = setInterval(() => {
  status();
  monitorSupervisorOwner();
  if (socket?.readyState === WebSocket.OPEN) {
    const now = Date.now();
    const health = bridgeSocketHeartbeatDecision({
      now,
      lastPongAt: lastBridgePongAt,
      lastPingAt: lastBridgePingAt,
      pingIntervalMs: WEBSOCKET_PING_INTERVAL_MS,
      pongTimeoutMs: WEBSOCKET_PONG_TIMEOUT_MS
    });
    if (health.terminate) {
      bridgeState = 'disconnected';
      bridgeReason = 'Remote Bridge ping/pong deadline expired; reconnecting.';
      status();
      socket.terminate();
    } else if (health.sendPing) {
      lastBridgePingAt = now;
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }
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
  while (!stopping) {
    if (supervisorRecoveryInProgress || supervisorRecoveryQuiescing) {
      await wait(200);
      continue;
    }
    await runSocket();
  }
})().catch(() => undefined).finally(() => {
  if (stopping) void shutdown();
});

async function closeSocketGracefully(): Promise<void> {
  const ws = socket;
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.off('close', finish);
      ws.off('error', finish);
      resolve();
    };
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch { /* bounded shutdown continues */ }
      finish();
    }, WEBSOCKET_CLOSE_TIMEOUT_MS);
    ws.once('close', finish);
    ws.once('error', finish);
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'shutdown');
    } catch {
      finish();
    }
  });
}

async function shutdown(): Promise<void> {
  if (!shutdownPromise) {
    stopping = true;
    shutdownPromise = (async () => {
      clearInterval(timer);
      await closeSocketGracefully();
      await connector.close();
    })();
  }
  await shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
}
