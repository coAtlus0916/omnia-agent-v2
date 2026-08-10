import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { WorkstationOmniaSession, ConnectorOperationError } from '../connector/workstation-omnia-session.js';
import type { ConnectorRequest } from '../connector/contracts.js';
import type { ConnectorResponse } from '../connector/contracts.js';
import { canonicalConnectorResponse, connectorResultDigest } from '../shared/connector-delivery.js';
import {
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA,
  REMOTE_CONNECTOR_DIAGNOSTICS_SCHEMA,
  type BridgeEnvelope,
  type RemoteConnectorDiagnosticsReport
} from '../shared/bridge-contracts.js';
import {
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_SEQUENCE,
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
  upgradeManagedStateV2,
  writeJsonAtomic
} from './managed-state.js';
import { readSupervisorDiagnostics, redactDiagnosticText } from './diagnostics.js';
import { RemoteCommandGate } from './wire-request.js';
import { bridgeSocketHeartbeatDecision } from './socket-health.js';
import {
  OperationActivityStore,
  acknowledgeWorkerMaintenance,
  acquireWorkerClaim,
  recordCandidateRollbackBarrier,
  readUpdateTransaction,
  readWorkerClaim,
  readWorkerMaintenance,
  releaseWorkerClaim,
  updateWorkerClaim
} from './update-transaction.js';
import {
  clearStoredBridgeCredential,
  clearCandidateBridgeCredential,
  acceptCommittedCandidateBridgeCredential,
  readCandidateBridgeCredential,
  readOrCreateConnectorDeviceIdentity,
  readStoredBridgeCredentialState,
  validateRemoteBridgeUrl
} from './bridge-credential.js';
import { readBaselineAdmission, writeBaselineAdmission } from './baseline-admission.js';
import { pidMatchesExactStartTime, processIsAlive, processStartTimeUtc } from './process-liveness.js';
import { isolatedFaultTestDuration, isolatedFaultTestFlag } from './fault-test-guard.js';

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
  const processStartedAt = String(lock?.processStartedAt || '');
  const heartbeatAt = String(heartbeat?.heartbeatAt || '');
  const heartbeatTime = Date.parse(heartbeatAt);
  if (
    lock?.schemaVersion !== 'omnia.v5.remote-connector-supervisor-lock/v2'
    || lock.product !== REMOTE_CONNECTOR_PRODUCT
    || !Number.isSafeInteger(supervisorPid)
    || supervisorPid <= 0
    || lockToken.length < 16
    || !Number.isFinite(Date.parse(processStartedAt))
    || !Number.isFinite(lockCreatedAt)
  ) return { acknowledged: false, reason: 'replacement_lock_missing_or_invalid', supervisorPid: 0, heartbeatAt: '' };
  if (supervisorPid === input.expectedOwnerPid || lockToken === input.expectedOwnerToken) {
    return { acknowledged: false, reason: 'owner_lock_not_replaced', supervisorPid, heartbeatAt: '' };
  }
  if (lockCreatedAt < input.minimumCreatedAt - 5_000 || !input.newSupervisorAlive) {
    return { acknowledged: false, reason: 'replacement_supervisor_not_live', supervisorPid, heartbeatAt: '' };
  }
  if (
    heartbeat?.schemaVersion !== 'omnia.v5.remote-connector-supervisor-heartbeat/v2'
    || heartbeat.product !== REMOTE_CONNECTOR_PRODUCT
    || Number(heartbeat.pid) !== supervisorPid
    || heartbeat.token !== lockToken
    || heartbeat.processStartedAt !== processStartedAt
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
    sequence: REMOTE_CONNECTOR_SEQUENCE,
    supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
    mode: 'remote',
    protocol: BRIDGE_PROTOCOL,
    operationHost: 'official-signed-package-gate',
    pageObservation: 'omnia.page-observation.current-pack.v1',
    workerClaim: 'not_acquired',
    bridgeClaim: 'not_acquired'
  })}\n`);
  process.exit(0);
}

const paths = resolveRemoteConnectorPaths();
ensureRemoteConnectorDirectories(paths);
// Repair the stable managed entry for installations created before 0.3.13.
// Startup and future updates must never depend on an extracted version folder.
ensureManagedLaunchers(paths);
const executionGeneration = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_WORKER_TOKEN || '');
if (!/^[a-f0-9]{48}$/u.test(executionGeneration)) {
  throw new Error('Managed Worker requires an exact Supervisor-issued execution generation.');
}
const workerProcessStartedAt = processStartTimeUtc(process.pid);
if (!workerProcessStartedAt) {
  throw new Error('Managed Worker cannot publish an exact process-birth identity.');
}
const probationEpoch = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_PROBATION_EPOCH || '');
if (probationEpoch && !/^[a-f0-9]{48}$/u.test(probationEpoch)) throw new Error('Worker probation epoch is invalid.');
let workerClaimHeld = false;
acquireWorkerClaim(paths, {
  executionGeneration,
  version: REMOTE_CONNECTOR_VERSION,
  sequence: REMOTE_CONNECTOR_SEQUENCE
});
workerClaimHeld = true;
const operationActivity = new OperationActivityStore(paths);
operationActivity.recoverColdStart();
const managedAtStart = readManagedState(paths);
if (managedAtStart.current === REMOTE_CONNECTOR_VERSION && managedAtStart.pending === null) {
  upgradeManagedStateV2(paths, REMOTE_CONNECTOR_VERSION);
}
const deviceIdentity = readOrCreateConnectorDeviceIdentity(paths.dataRoot);
const connector = new WorkstationOmniaSession(paths.dataRoot, fetch, {
  id: deviceIdentity.connectorId,
  name: 'Omnia Agent v5 Remote Connector',
  version: REMOTE_CONNECTOR_VERSION
});
const commandGate = new RemoteCommandGate();
if (probationEpoch) {
  commandGate.beginMaintenance(probationEpoch);
  commandGate.sealMaintenance(probationEpoch);
}
let stopping = false;
let bridgeState: 'unpaired' | 'repair_required' | 'connector_incompatible' | 'connecting' | 'connected' | 'disconnected' | 'fenced' = 'unpaired';
let bridgeReason = '';
let activeOperations = 0;
let uncertainOperations = 0;
let operationActivityState: 'known' | 'unknown' = 'known';
let maintenanceState: 'running' | 'closing_admission' | 'draining' | 'quiesced' | 'retiring' | 'failed_closed' = probationEpoch
  ? 'closing_admission' : 'running';
let maintenanceEpoch = probationEpoch;
let businessAdmissions = 0;
// Every Worker generation starts fail-closed. A Core handshake must prove it
// is speaking to this exact execution generation before any business command
// can cross the pre-effect dispatch boundary.
let protocolAdmitted = false;
let probationProbe: Record<string, unknown> = probationEpoch
  ? { state: 'pending', checkedAt: new Date().toISOString(), error: '' }
  : { state: 'not_applicable', checkedAt: new Date().toISOString(), error: '' };
let maintenanceTask: Promise<void> | null = null;
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
const guardianManaged = /^[A-Za-z0-9_-]{24,}$/u.test(String(process.env.OMNIA_V5_REMOTE_CONNECTOR_GUARDIAN_TOKEN || ''));
const updateTransactionId = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_UPDATE_TRANSACTION_ID || '');
if (updateTransactionId && !/^[a-f0-9]{48}$/u.test(updateTransactionId)) throw new Error('Worker update transaction identity is invalid.');
let supervisorLeaseMissingSince = 0;
let supervisorLeaseWaitLogged = false;
let supervisorRecoveryFailures = 0;
let supervisorRecoveryRetryAt = 0;
let supervisorRecoveryInProgress = false;
let supervisorRecoveryQuiescing = false;
let supervisorActiveOperationDrainStartedAt = 0;
let supervisorActiveOperationDeadlineLogged = false;
const SUPERVISOR_OWNER_LEASE_MS = isolatedFaultTestDuration(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_OWNER_LEASE_MS',
  35_000
);
const FAULT_TEST_MAINTENANCE_HOLD_MS = isolatedFaultTestDuration(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_MAINTENANCE_HOLD_MS',
  0
);
const FAULT_TEST_AUTHORITY_PROBE = isolatedFaultTestFlag(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_AUTHORITY_PROBE'
);
const FAULT_TEST_BUSINESS_DISPATCH = isolatedFaultTestFlag(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_BUSINESS_DISPATCH'
);
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

function status(): boolean {
  heartbeatAt = new Date().toISOString();
  let operationBlockers: ReturnType<WorkstationOmniaSession['maintenanceSnapshot']> | null = null;
  try {
    const counts = operationActivity.counts();
    activeOperations = Math.max(commandGate.activeCount, counts.active);
    uncertainOperations = counts.uncertain;
    operationBlockers = connector.maintenanceSnapshot();
    operationActivityState = operationBlockers.state;
  } catch {
    operationActivityState = 'unknown';
  }
  try {
    const snapshot = {
      schemaVersion: 'omnia.v5.remote-connector-status/v1',
      product: REMOTE_CONNECTOR_PRODUCT,
      version: REMOTE_CONNECTOR_VERSION,
      sequence: REMOTE_CONNECTOR_SEQUENCE,
      pid: process.pid,
      processStartedAt: workerProcessStartedAt,
      mode: 'remote',
      bridgeState,
      bridgeReason,
      activeOperations,
      uncertainOperations,
      operationActivityState,
      operationBlockers,
      maintenanceState,
      maintenanceEpoch,
      admissionClosed: commandGate.admissionClosed,
      admissionSealed: commandGate.admissionSealed,
      executionGeneration,
      workerClaimHeld,
      businessAdmissions,
      probationProbe,
      bootstrapMigration,
      updateManifestUrl: REMOTE_CONNECTOR_UPDATE_MANIFEST_URL,
      heartbeatAt
    };
    writeJsonAtomic(path.join(paths.workerStatuses, `${executionGeneration}.json`), snapshot);
    if (workerClaimHeld) writeJsonAtomic(paths.status, snapshot);
    return true;
  } catch { return false; }
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
    lock?.schemaVersion === 'omnia.v5.remote-connector-supervisor-lock/v2'
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
  const processStartedAt = String(lock?.processStartedAt || '');
  return Boolean(
    processIsAlive(expectedSupervisorPid)
    && lock?.schemaVersion === 'omnia.v5.remote-connector-supervisor-lock/v2'
    && lock.product === REMOTE_CONNECTOR_PRODUCT
    && Number(lock.pid) === expectedSupervisorPid
    && lock.token === expectedSupervisorToken
    && Number.isFinite(Date.parse(processStartedAt))
    && pidMatchesExactStartTime(expectedSupervisorPid, processStartedAt)
    && heartbeat?.schemaVersion === 'omnia.v5.remote-connector-supervisor-heartbeat/v2'
    && heartbeat.product === REMOTE_CONNECTOR_PRODUCT
    && Number(heartbeat.pid) === expectedSupervisorPid
    && heartbeat.token === expectedSupervisorToken
    && heartbeat.processStartedAt === processStartedAt
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
  if (maintenanceState === 'retiring') {
    void shutdown().finally(() => process.exit(0));
    return;
  }
  // During A/B overlap the Supervisor heartbeat names the one Worker the next
  // Supervisor must fence and replace. A retained quiesced Worker A is not that
  // handoff owner and must remain available for rollback without racing B's
  // single durable handoff file.
  const ownerHeartbeat = readJsonRecord(paths.supervisorHeartbeat);
  if (maintenanceState === 'quiesced' && Number(ownerHeartbeat?.workerPid || 0) !== process.pid) return;
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
      newSupervisorAlive: Number.isSafeInteger(supervisorPid) && supervisorPid > 0
        && pidMatchesExactStartTime(supervisorPid, String(lock?.processStartedAt || ''))
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
  if (guardianManaged) {
    await recoverGuardianManagedSupervisorAfterOwnerLoss();
    return;
  }
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

async function recoverGuardianManagedSupervisorAfterOwnerLoss(): Promise<never> {
  const epoch = maintenanceEpoch || crypto.randomBytes(24).toString('hex');
  maintenanceEpoch = epoch;
  if (!commandGate.admissionClosed) commandGate.beginMaintenance(epoch);
  maintenanceState = 'draining';
  supervisorRecoveryQuiescing = true;
  bridgeState = 'disconnected';
  bridgeReason = 'Guardian-managed Supervisor lease was lost; draining to an exact durable handoff.';
  status();
  for (;;) {
    let counts: { active: number; uncertain: number };
    let blockers: ReturnType<WorkstationOmniaSession['maintenanceSnapshot']>;
    try {
      counts = operationActivity.counts();
      blockers = connector.maintenanceSnapshot();
    } catch {
      maintenanceState = 'failed_closed';
      status();
      await wait(1_000);
      continue;
    }
    if (commandGate.activeCount === 0 && counts.active === 0 && counts.uncertain === 0
      && blockers.state === 'known' && blockers.activeResources === 0 && blockers.pendingRegistrations === 0) break;
    status();
    await wait(250);
  }
  commandGate.sealMaintenance(epoch);
  await closeSocketGracefully();
  const finalCounts = operationActivity.counts();
  const finalBlockers = connector.maintenanceSnapshot();
  if (commandGate.activeCount !== 0 || finalCounts.active !== 0 || finalCounts.uncertain !== 0
    || finalBlockers.state !== 'known' || finalBlockers.activeResources !== 0
    || finalBlockers.pendingRegistrations !== 0) {
    maintenanceState = 'failed_closed';
    status();
    for (;;) await wait(1_000);
  }
  if (workerClaimHeld) {
    updateWorkerClaim(paths, executionGeneration, 'quiescing');
    releaseWorkerClaim(paths, executionGeneration);
    workerClaimHeld = false;
  }
  maintenanceState = 'quiesced';
  status();
  const recoveryId = crypto.randomBytes(24).toString('base64url');
  while (!stopping) {
    const createdAt = new Date();
    writeJsonAtomic(paths.workerRecoveryHandoff, {
      schemaVersion: 'omnia.v5.remote-connector-worker-recovery/v1',
      product: REMOTE_CONNECTOR_PRODUCT,
      recoveryId,
      ownerPid: expectedSupervisorPid,
      ownerToken: expectedSupervisorToken,
      workerPid: process.pid,
      executionGeneration,
      admissionSealed: true,
      workerClaimReleased: true,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + WORKER_RECOVERY_HANDOFF_MS).toISOString()
    });
    recordLifecycleDiagnostic({ event: 'guardian_managed_worker_handoff_published', recoveryId });
    const takeover = await waitForSupervisorTakeover(createdAt.getTime());
    if (takeover.acknowledged) await exitAfterSupervisorTakeover(takeover, 0);
    await wait(1_000);
  }
  await shutdown();
  process.exit(1);
}

function sendDiagnostics(pairId: string, ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    if (operationActivityState !== 'known') {
      ws.close(1011, 'operation activity truth unavailable');
      return;
    }
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
      uncertainOperations,
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
  const claim = readWorkerClaim(paths);
  if (!workerClaimHeld || !claim || claim.pid !== process.pid || claim.executionGeneration !== executionGeneration) {
    throw new ConnectorOperationError('REMOTE.WORKER_CLAIM_LOST', 'Worker lost the global Bridge claim before command dispatch.');
  }
  const fence = readWorkerMaintenance(paths);
  const closureAllowed = ['health', 'status', 'operation_delivery_ack', 'operation_delivery_status', 'protocol_admission'].includes(request.operation)
    || (request.operation === 'operation_invoke'
      && (request.payload as any).mutationAuthorized === false
      && Boolean((request.payload as any).reconcileOf)
      && ['readback', 'reconcile', 'recovery'].includes(String((request.payload as any).deliveryContext?.purpose || '')));
  if (fence && fence.target.pid === process.pid && fence.target.token === executionGeneration
    && fence.epoch === maintenanceEpoch && fence.action !== 'resume'
    && (fence.acknowledgement?.admissionSealed ? !['health', 'status', 'protocol_admission'].includes(request.operation) : !closureAllowed)) {
    throw new ConnectorOperationError('REMOTE.MAINTENANCE_FENCED', 'Worker maintenance fence closed final dispatch admission.');
  }
  const controlOperation = ['health', 'status', 'operation_delivery_ack', 'operation_delivery_status', 'protocol_admission']
    .includes(request.operation);
  if (!controlOperation && !protocolAdmitted) {
    throw new ConnectorOperationError(
      'REMOTE.PROTOCOL_ADMISSION_REQUIRED',
      'This Worker generation has not completed the exact Core protocol admission handshake.'
    );
  }
  if (!controlOperation) {
    if (probationEpoch && updateTransactionId && businessAdmissions === 0) {
      recordCandidateRollbackBarrier(paths, {
        schemaVersion: 'omnia.v5.connector-rollback-barrier/v1',
        transactionId: updateTransactionId,
        epoch: probationEpoch,
        executionGeneration,
        requestId: request.id,
        recordedAt: new Date().toISOString()
      }, { version: REMOTE_CONNECTOR_VERSION, sequence: REMOTE_CONNECTOR_SEQUENCE });
    }
    businessAdmissions += 1;
    status();
  }
  switch (request.operation) {
    case 'health': return connector.health();
    case 'connect': return connector.connect();
    case 'refresh':
      if (FAULT_TEST_AUTHORITY_PROBE) {
        return {
          status: 'connected', connected: true, connecting: false,
          connectorId: deviceIdentity.connectorId,
          connectorName: 'Isolated fault authority', connectorVersion: REMOTE_CONNECTOR_VERSION,
          sessionGeneration: 1, authorityInstanceId: 'fault-authority', tenantOrOrgId: 'fault-tenant',
          packId: 'fault-pack', engagementId: '11111111-1111-4111-8111-111111111111',
          engagementName: 'fault-engagement', clientName: 'fault-client',
          checkedAt: new Date().toISOString(), message: 'isolated fault authority'
        };
      }
      return connector.refresh();
    case 'status': return connector.status();
    case 'workspace_authority_read':
      return connector.workspaceAuthorityRead(String(request.payload.expectedEngagementId || ''));
    case 'operation_register':
      return connector.registerOperation(request.payload as any);
    case 'operation_invoke': {
      operationActivity.begin(request.id, request.payload as any, executionGeneration);
      return connector.invokeOperation(request.payload as any);
    }
    case 'operation_delivery_ack':
      return operationActivity.acknowledge(request.payload as any);
    case 'operation_delivery_status':
      return operationActivity.deliveryStatus(request.payload as any);
    case 'protocol_admission': {
      if (probationEpoch && !updateTransactionId) {
        let ready;
        try { ready = readBaselineAdmission(paths); }
        catch { throw new ConnectorOperationError('REMOTE.PROTOCOL_ADMISSION_NOT_READY', 'Cold baseline promotion is not durably ready.'); }
        const managed = readManagedState(paths);
        if (!ready
          || ready.schemaVersion !== 'omnia.v5.connector-baseline-admission/v2'
          || !['promoted', 'admitted'].includes(String(ready.phase))
          || ready.version !== REMOTE_CONNECTOR_VERSION || Number(ready.sequence) !== REMOTE_CONNECTOR_SEQUENCE
          || ready.epoch !== probationEpoch || ready.executionGeneration !== executionGeneration
          || managed.current !== REMOTE_CONNECTOR_VERSION || managed.pending !== null
          || probationProbe.state !== 'verified') {
          throw new ConnectorOperationError('REMOTE.PROTOCOL_ADMISSION_IDENTITY_DRIFT', 'Cold baseline admission identity differs from durable promotion and authority probe.');
        }
        if (ready.phase !== 'admitted') {
          const admittedAt = new Date().toISOString();
          writeBaselineAdmission(paths, {
            phase: 'admitted',
            version: ready.version,
            sequence: ready.sequence,
            epoch: ready.epoch,
            executionGeneration: ready.executionGeneration,
            admittedAt
          });
        }
        if (commandGate.admissionClosed) commandGate.endMaintenance(probationEpoch);
        maintenanceState = 'running';
        status();
      } else if (maintenanceState !== 'running' || commandGate.admissionClosed) {
        throw new ConnectorOperationError('REMOTE.PROTOCOL_ADMISSION_NOT_READY', 'Connector generation has not completed guarded admission.');
      }
      protocolAdmitted = true;
      return {
        schemaVersion: 'omnia.connector-protocol-admission-result/v1',
        admitted: true,
        version: REMOTE_CONNECTOR_VERSION,
        sequence: REMOTE_CONNECTOR_SEQUENCE,
        executionGeneration
      };
    }
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
    protocolAdmitted = false;
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
        const claim = readWorkerClaim(paths);
        if (!workerClaimHeld || !claim || claim.pid !== process.pid || claim.executionGeneration !== executionGeneration) {
          ws.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'result',
            response: {
              schemaVersion: 'omnia.connector-ipc/v1',
              id: request.id,
              ok: false,
              error: { code: 'REMOTE.WORKER_CLAIM_LOST', message: 'Worker claim was fenced before enqueue.', retryable: true }
            }
          }));
          return;
        }
        const controlOperation = ['health', 'status', 'operation_delivery_ack', 'operation_delivery_status', 'protocol_admission']
          .includes(request.operation);
        if (!controlOperation && !protocolAdmitted) {
          ws.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'result',
            response: {
              schemaVersion: 'omnia.connector-ipc/v1',
              id: request.id,
              ok: false,
              error: {
                code: 'REMOTE.PROTOCOL_ADMISSION_REQUIRED',
                message: 'This exact Worker generation rejected the command before platform dispatch.',
                retryable: true
              }
            }
          }));
          return;
        }
        const execution = commandGate.handle(request, dispatch, envelope.deadlineAt);
        activeOperations = commandGate.activeCount;
        status();
        void execution.then((response) => {
          let deliveredResponse = response;
          if (request.operation === 'operation_invoke' && (request.payload as any).deliveryContext) {
            const resultDigest = connectorResultDigest(response);
            operationActivity.finish(
              request.id,
              resultDigest,
              response.ok ? '' : String(response.error?.code || ''),
              canonicalConnectorResponse(response)
            );
            const sessionGeneration = Number((request.payload as any).deliveryContext.sessionGeneration || 0);
            deliveredResponse = {
              ...response,
              delivery: {
                schemaVersion: 'omnia.connector-wire-delivery/v1',
                resultDigest,
                sessionGeneration,
                executionGeneration
              }
            } satisfies ConnectorResponse;
          }
          if (ws.readyState === WebSocket.OPEN && !cancelledRequests.delete(request.id)) {
            ws.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response: deliveredResponse }));
          }
        }).finally(() => {
          activeOperations = commandGate.activeCount;
          status();
        });
      });
      ws.once('close', (code) => {
        protocolAdmitted = false;
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

async function reconcileMaintenance(): Promise<void> {
  let requested: ReturnType<typeof readWorkerMaintenance>;
  try { requested = readWorkerMaintenance(paths); }
  catch {
    maintenanceState = 'failed_closed';
    if (!maintenanceEpoch) maintenanceEpoch = crypto.randomBytes(24).toString('hex');
    if (!commandGate.admissionClosed) commandGate.beginMaintenance(maintenanceEpoch);
    await closeSocketGracefully();
    return;
  }
  if (!requested) return;
  if (requested.target.pid !== process.pid
    || requested.target.token !== executionGeneration
    || requested.target.version !== REMOTE_CONNECTOR_VERSION
    || requested.target.sequence !== REMOTE_CONNECTOR_SEQUENCE) return;
  if (maintenanceEpoch && maintenanceEpoch !== requested.epoch) {
    maintenanceState = 'failed_closed';
    await closeSocketGracefully();
    return;
  }
  maintenanceEpoch = requested.epoch;
  const acknowledge = (state: 'draining' | 'quiesced' | 'running' | 'retiring' | 'failed_closed') => {
    requested = acknowledgeWorkerMaintenance(
      paths,
      requested!.revision,
      requested!.transactionId,
      requested!.epoch,
      executionGeneration,
      {
        pid: process.pid,
        executionGeneration,
        admissionClosed: commandGate.admissionClosed,
        admissionSealed: commandGate.admissionSealed,
        state,
        acknowledgedAt: new Date().toISOString()
      }
    );
  };
  if (requested.action === 'resume') {
    if (maintenanceState === 'retiring') return;
    try {
      if (!workerClaimHeld) {
        acquireWorkerClaim(paths, {
          executionGeneration,
          version: REMOTE_CONNECTOR_VERSION,
          sequence: REMOTE_CONNECTOR_SEQUENCE
        });
        workerClaimHeld = true;
      }
      if (commandGate.admissionClosed) commandGate.endMaintenance(maintenanceEpoch);
      maintenanceState = 'running';
      acknowledge('running');
    } catch {
      maintenanceState = 'failed_closed';
      if (!commandGate.admissionClosed) commandGate.beginMaintenance(maintenanceEpoch);
      if (!commandGate.admissionSealed) commandGate.sealMaintenance(maintenanceEpoch);
      workerClaimHeld = false;
    }
    return;
  }
  if (!commandGate.admissionClosed) commandGate.beginMaintenance(maintenanceEpoch);
  maintenanceState = requested.action === 'retire' ? 'retiring' : 'draining';
  acknowledge(maintenanceState);
  if (FAULT_TEST_MAINTENANCE_HOLD_MS > 0) await wait(FAULT_TEST_MAINTENANCE_HOLD_MS);
  let counts: { active: number; uncertain: number };
  let blockers: ReturnType<WorkstationOmniaSession['maintenanceSnapshot']>;
  try {
    counts = operationActivity.counts();
    blockers = connector.maintenanceSnapshot();
  } catch {
    maintenanceState = 'failed_closed';
    return;
  }
  if (operationActivityState !== 'known' || blockers.state !== 'known'
    || commandGate.activeCount > 0 || counts.active > 0 || counts.uncertain > 0
    || blockers.activeResources > 0 || blockers.pendingRegistrations > 0) return;
  commandGate.sealMaintenance(maintenanceEpoch);
  acknowledge(maintenanceState);
  if (!status()) {
    maintenanceState = 'failed_closed';
    return;
  }
  await closeSocketGracefully();
  try {
    counts = operationActivity.counts();
    blockers = connector.maintenanceSnapshot();
  } catch {
    maintenanceState = 'failed_closed';
    return;
  }
  if (commandGate.activeCount > 0 || counts.active > 0 || counts.uncertain > 0
    || blockers.state !== 'known' || blockers.activeResources > 0 || blockers.pendingRegistrations > 0) {
    maintenanceState = 'failed_closed';
    return;
  }
  if (workerClaimHeld) {
    updateWorkerClaim(paths, executionGeneration, 'quiescing');
    releaseWorkerClaim(paths, executionGeneration);
    workerClaimHeld = false;
  }
  if (requested.action === 'retire') {
    status();
    void shutdown().finally(() => process.exit(0));
    return;
  }
  maintenanceState = 'quiesced';
  acknowledge('quiesced');
  status();
}

let faultBusinessDispatchStarted = false;
const timer = setInterval(() => {
  if (workerClaimHeld) {
    try { updateWorkerClaim(paths, executionGeneration, maintenanceState === 'running' ? 'admitted' : 'quiescing'); }
    catch {
      workerClaimHeld = false;
      maintenanceState = 'failed_closed';
      if (!commandGate.admissionClosed) commandGate.beginMaintenance(maintenanceEpoch || crypto.randomBytes(24).toString('hex'));
      void closeSocketGracefully();
    }
  }
  if (!maintenanceTask) {
    maintenanceTask = reconcileMaintenance().finally(() => { maintenanceTask = null; });
  }
  if (FAULT_TEST_BUSINESS_DISPATCH && !faultBusinessDispatchStarted
    && maintenanceState === 'running' && workerClaimHeld) {
    const transaction = readUpdateTransaction(paths);
    const candidateEligible = transaction?.transactionId === updateTransactionId
      && ['promoted', 'terminalizing', 'completed'].includes(transaction.phase)
      && transaction.workerB?.token === executionGeneration;
    const rollbackEligible = transaction?.transactionId === updateTransactionId
      && transaction.phase === 'rolled_back'
      && transaction.workerA?.token === executionGeneration;
    if (candidateEligible || rollbackEligible) {
      faultBusinessDispatchStarted = true;
      const request: ConnectorRequest = {
        schemaVersion: 'omnia.connector-ipc/v1',
        id: `fault-dispatch-${executionGeneration.slice(0, 24)}`,
        operation: 'refresh',
        payload: {}
      };
      void commandGate.handle(request, dispatch, new Date(Date.now() + 30_000).toISOString())
        .finally(() => { status(); });
    }
  }
  status();
  if (!stopping && maintenanceState !== 'failed_closed') monitorSupervisorOwner();
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
if (probationEpoch) {
  void (async () => {
    if (FAULT_TEST_AUTHORITY_PROBE) {
      bridgeState = 'connected';
      bridgeReason = '';
      probationProbe = {
        state: 'verified',
        connectorId: deviceIdentity.connectorId,
        sessionGeneration: 1,
        engagementId: '11111111-1111-4111-8111-111111111111',
        authorityInstanceId: 'fault-authority',
        tenantOrOrgId: 'fault-tenant',
        packId: 'fault-pack',
        capabilityDigest: crypto.createHash('sha256').update('isolated-fault-authority').digest('hex'),
        checkedAt: new Date().toISOString(),
        error: ''
      };
      status();
      return;
    }
    const deadline = Date.now() + 90_000;
    while (!stopping && maintenanceState === 'closing_admission' && Date.now() < deadline) {
      try {
        const connection = await connector.status();
        if (connection.status !== 'connected' || !connection.connectorId
          || !Number.isSafeInteger(connection.sessionGeneration) || connection.sessionGeneration < 1
          || !connection.engagementId || !connection.authorityInstanceId
          || !connection.tenantOrOrgId || !connection.packId) {
          throw new Error(`workspace authority is ${connection.status}`);
        }
        const authority = await connector.workspaceAuthorityRead(connection.engagementId);
        const binding = authority.connectorBinding;
        if (binding.connectorId !== connection.connectorId
          || binding.sessionGeneration !== connection.sessionGeneration
          || binding.engagementId !== connection.engagementId
          || binding.authorityInstanceId !== connection.authorityInstanceId
          || binding.tenantOrOrgId !== connection.tenantOrOrgId
          || binding.packId !== connection.packId) {
          throw new Error('workspace authority binding changed during candidate probe');
        }
        probationProbe = {
          state: 'verified',
          connectorId: binding.connectorId,
          sessionGeneration: binding.sessionGeneration,
          engagementId: binding.engagementId,
          authorityInstanceId: binding.authorityInstanceId,
          tenantOrOrgId: binding.tenantOrOrgId,
          packId: binding.packId,
          capabilityDigest: crypto.createHash('sha256').update(JSON.stringify({
            schemaVersion: authority.schemaVersion,
            profile: authority.profile,
            source: authority.source
          })).digest('hex'),
          checkedAt: new Date().toISOString(),
          error: ''
        };
        status();
        return;
      } catch (error) {
        probationProbe = {
          state: 'pending',
          checkedAt: new Date().toISOString(),
          error: redactDiagnosticText(error instanceof Error ? error.message : 'candidate authority probe failed')
        };
        status();
        await wait(1_000);
      }
    }
    if (!stopping && probationProbe.state !== 'verified') {
      probationProbe = { ...probationProbe, state: 'failed', checkedAt: new Date().toISOString() };
      status();
    }
  })();
}
void (async () => {
  while (!stopping) {
    if (supervisorRecoveryInProgress || supervisorRecoveryQuiescing || !workerClaimHeld
      || !['running', 'closing_admission', 'draining'].includes(maintenanceState)) {
      await wait(200);
      continue;
    }
    if (FAULT_TEST_AUTHORITY_PROBE && probationEpoch) {
      bridgeState = 'connected';
      bridgeReason = '';
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
      if (workerClaimHeld) {
        releaseWorkerClaim(paths, executionGeneration);
        workerClaimHeld = false;
      }
    })();
  }
  await shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
}
