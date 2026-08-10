import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { quarantineLegacyManagedStreamOrphans } from '../connector/managed-stream-host.js';
import {
  REMOTE_CONNECTOR_MAX_ARCHIVE_BYTES,
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_SUPERVISOR_VERSION,
  REMOTE_CONNECTOR_UPDATE_INTERVAL_MS,
  REMOTE_CONNECTOR_UPDATE_MANIFEST_URL
} from './constants.js';
import {
  assertPendingPackageIdentity,
  classifyManagedWorkerIdentity,
  ensureRemoteConnectorDirectories,
  readManagedState,
  resolveRemoteConnectorPaths,
  type ManagedState,
  type ManagedWorkerIdentityRole,
  versionRoot,
  writeManagedState
} from './managed-state.js';
import {
  archiveWorkerMaintenance,
  casUpdateTransaction,
  completeUpdateTransactionAndArchiveBarrier,
  createUpdateTransaction,
  readRollbackBarrier,
  readUpdateTransaction,
  readWorkerClaim,
  readWorkerMaintenance,
  writeWorkerMaintenance,
  type ConnectorUpdateTransaction,
  type WorkerMaintenanceRecord,
  type WorkerProcessIdentity
} from './update-transaction.js';
import {
  casBootstrapState,
  readBootstrapState,
  stageSupervisorSlot,
  writeGuardianRequest
} from './guardian.js';
import {
  compareVersions,
  validateUpdateManifest,
  verifyPortableRoot,
  type UpdateManifest
} from './release-contract.js';
import {
  assertUpdateSequenceAdmitted,
  workerHeartbeatRecoveryDecision,
  workerLifecycleAllowsActivation
} from './update-policy.js';
import {
  readBaselineAdmission,
  requiresSealedBaselineRestart,
  writeBaselineAdmission
} from './baseline-admission.js';
import {
  pidMatchesExactStartTime,
  processBirthMatch,
  processIsAlive,
  processStartTimeUtc
} from './process-liveness.js';
import { isolatedFaultTestDuration, isolatedFaultTestFlag } from './fault-test-guard.js';

const paths = resolveRemoteConnectorPaths();
ensureRemoteConnectorDirectories(paths);
const guardianPid = Number(process.env.OMNIA_V5_REMOTE_CONNECTOR_GUARDIAN_PID || 0);
const guardianToken = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_GUARDIAN_TOKEN || '');
const bootstrapRevision = Number(process.env.OMNIA_V5_REMOTE_CONNECTOR_BOOTSTRAP_REVISION || -1);
const supervisorSlot = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_SLOT || '');
const supervisorSha256 = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_SHA256 || '');
const updateTransactionId = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_UPDATE_TRANSACTION_ID || '');
const once = process.argv.includes('--once');
let worker: ChildProcess | null = null;
let workerIdentity: WorkerProcessIdentity | null = null;
let workerHasStarted = false;
let workerStartedAt = 0;
let workerHeartbeatStaleSince = 0;
let lastWorkerWatchdogAt = 0;
let stopping = false;
let transitioning = false;
let ownsLock = false;
const lockToken = crypto.randomBytes(24).toString('base64url');
const supervisorProcessStartedAt = processStartTimeUtc(process.pid);
let lockHeartbeatTimer: NodeJS.Timeout | null = null;
const SUPERVISOR_HEARTBEAT_INTERVAL_MS = 1_000;
const SUPERVISOR_HEARTBEAT_STALE_MS = 30_000;
const SUPERVISOR_STARTING_GRACE_MS = 10_000;
const SUPERVISOR_RECOVERY_GATE_LEASE_MS = 15_000;
const WORKER_RECOVERY_HANDOFF_WAIT_MS = 20_000;
const WORKER_RECOVERY_HANDOFF_MAX_AGE_MS = 60_000;
const WORKER_STATUS_STARTUP_GRACE_MS = 15_000;
const WORKER_STATUS_HEARTBEAT_FRESH_MS = 5_000;
const WORKER_STATUS_RECOVERY_DELAY_MS = 30_000;
const FAULT_TEST_TERMINALIZING_HOLD_MS = isolatedFaultTestDuration(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_TERMINALIZING_HOLD_MS', 0
);
const FAULT_TEST_PROMOTED_HOLD_MS = isolatedFaultTestDuration(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_PROMOTED_HOLD_MS', 0
);
const FAULT_TEST_WORKER_A_QUIESCED_HOLD_MS = isolatedFaultTestDuration(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_WORKER_A_QUIESCED_HOLD_MS', 0
);
const FAULT_TEST_ROLLBACK_HOLD_MS = isolatedFaultTestDuration(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_ROLLBACK_HOLD_MS', 0
);
const FAULT_TEST_FAIL_PROMOTION_PREPARED = isolatedFaultTestFlag(
  'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_FAIL_PROMOTION_PREPARED'
);
const UPDATE_EXTRACTION_TIMEOUT_MS = 5 * 60_000;
let heartbeatFailureSince = 0;
let heartbeatTickRunning = false;
let workerRestartFailures = 0;
let nextWorkerStartAt = 0;
let automaticUpdateTask: Promise<void> | null = null;
let automaticUpdateAbort: AbortController | null = null;

interface SupervisorLock {
  schemaVersion: 'omnia.v5.remote-connector-supervisor-lock/v2';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  pid: number;
  token: string;
  processStartedAt: string;
  createdAt: string;
  guardianPid: number;
  guardianToken: string;
  bootstrapRevision: number;
  supervisorSlot: 'a' | 'b';
  supervisorSha256: string;
  transactionId: string;
}

interface ParsedSupervisorLock extends SupervisorLock {
  legacy: boolean;
}

interface SupervisorHeartbeat {
  schemaVersion: 'omnia.v5.remote-connector-supervisor-heartbeat/v2';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  pid: number;
  token: string;
  processStartedAt: string;
  supervisorVersion: string;
  workerPid: number;
  guardianPid: number;
  guardianToken: string;
  bootstrapRevision: number;
  supervisorSlot: 'a' | 'b';
  supervisorSha256: string;
  transactionId: string;
  heartbeatAt: string;
}

interface WorkerRecoveryHandoff {
  schemaVersion: 'omnia.v5.remote-connector-worker-recovery/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  recoveryId: string;
  ownerPid: number;
  ownerToken: string;
  workerPid: number;
  executionGeneration: string;
  admissionSealed: true;
  workerClaimReleased: true;
  createdAt: string;
  expiresAt: string;
}

interface RecoveryHandoffWorkerIdentity {
  role: ManagedWorkerIdentityRole;
  version: string;
  sequence: number;
}

function log(level: 'info' | 'warn' | 'error', message: string, detail: Record<string, unknown> = {}): void {
  try {
    const entry = JSON.stringify({
      at: new Date().toISOString(),
      level,
      product: REMOTE_CONNECTOR_PRODUCT,
      message,
      ...detail
    });
    fs.appendFileSync(path.join(paths.logs, 'supervisor.jsonl'), `${entry}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* logging must never terminate process supervision */ }
}

function readLock(): ParsedSupervisorLock | null {
  try {
    const value = JSON.parse(fs.readFileSync(paths.supervisorLock, 'utf8')) as Partial<SupervisorLock>;
    const pid = Number(value.pid);
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || typeof value.token !== 'string'
      || value.token.length < 16
      || !Number.isFinite(Date.parse(String(value.createdAt || '')))
    ) return null;
    // 0.1.6 already published a product-tagged v1 lock, but it did not carry
    // Guardian or exact process-birth identity. Treat both that shape and the
    // older untagged shape as legacy publication proofs; v2 is the first shape
    // that may authorize exact Guardian/Supervisor process signalling.
    const legacy = (value.schemaVersion === undefined && value.product === undefined)
      || ((value as Record<string, unknown>).schemaVersion === 'omnia.v5.remote-connector-supervisor-lock/v1'
        && value.product === REMOTE_CONNECTOR_PRODUCT
        && value.processStartedAt === undefined
        && value.guardianToken === undefined);
    if (!legacy && (
      value.schemaVersion !== 'omnia.v5.remote-connector-supervisor-lock/v2'
      || value.product !== REMOTE_CONNECTOR_PRODUCT
      || !Number.isFinite(Date.parse(String(value.processStartedAt || '')))
      || !Number.isSafeInteger(value.guardianPid) || Number(value.guardianPid) <= 0
      || typeof value.guardianToken !== 'string' || value.guardianToken.length < 24
      || !Number.isSafeInteger(value.bootstrapRevision) || Number(value.bootstrapRevision) < 0
      || !['a', 'b'].includes(String(value.supervisorSlot || ''))
      || !/^[a-f0-9]{64}$/u.test(String(value.supervisorSha256 || ''))
      || (String(value.transactionId || '') !== '' && !/^[a-f0-9]{48}$/u.test(String(value.transactionId)))
    )) return null;
    return {
      schemaVersion: 'omnia.v5.remote-connector-supervisor-lock/v2',
      product: REMOTE_CONNECTOR_PRODUCT,
      pid,
      token: value.token,
      processStartedAt: String(value.processStartedAt || ''),
      createdAt: String(value.createdAt),
      guardianPid: Number(value.guardianPid || 0),
      guardianToken: String(value.guardianToken || ''),
      bootstrapRevision: Number(value.bootstrapRevision ?? -1),
      supervisorSlot: (value.supervisorSlot || 'a') as 'a' | 'b',
      supervisorSha256: String(value.supervisorSha256 || ''),
      transactionId: String(value.transactionId || ''),
      legacy
    };
  } catch {
    return null;
  }
}

function readHeartbeat(): SupervisorHeartbeat | null {
  try {
    const value = JSON.parse(fs.readFileSync(paths.supervisorHeartbeat, 'utf8')) as SupervisorHeartbeat;
    if (
      value.schemaVersion !== 'omnia.v5.remote-connector-supervisor-heartbeat/v2'
      || value.product !== REMOTE_CONNECTOR_PRODUCT
      || !Number.isSafeInteger(value.pid)
      || !Number.isSafeInteger(value.workerPid)
      || value.workerPid < 0
      || typeof value.token !== 'string'
      || !Number.isFinite(Date.parse(value.processStartedAt))
      || typeof value.supervisorVersion !== 'string'
      || !Number.isSafeInteger(value.guardianPid) || value.guardianPid <= 0
      || typeof value.guardianToken !== 'string' || value.guardianToken.length < 24
      || !Number.isSafeInteger(value.bootstrapRevision) || value.bootstrapRevision < 0
      || !['a', 'b'].includes(value.supervisorSlot)
      || !/^[a-f0-9]{64}$/u.test(value.supervisorSha256)
      || (value.transactionId !== '' && !/^[a-f0-9]{48}$/u.test(value.transactionId))
      || !Number.isFinite(Date.parse(value.heartbeatAt))
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function legacyWorkerIsHealthy(now = Date.now()): boolean {
  const status = readWorkerStatus();
  const pid = Number(status?.pid || 0);
  const heartbeatAt = Date.parse(String(status?.heartbeatAt || ''));
  return Number.isSafeInteger(pid)
    && pid > 0
    && processIsAlive(pid)
    && Number.isFinite(heartbeatAt)
    && now - heartbeatAt <= 5_000;
}

function lockIsLive(lock: ParsedSupervisorLock, now = Date.now()): boolean {
  if (!processIsAlive(lock.pid)) return false;
  if (lock.legacy) return legacyWorkerIsHealthy(now);
  const heartbeat = readHeartbeat();
  if (
    heartbeat
    && heartbeat.pid === lock.pid
    && heartbeat.token === lock.token
    && now - Date.parse(heartbeat.heartbeatAt) >= -5_000
    && now - Date.parse(heartbeat.heartbeatAt) <= SUPERVISOR_HEARTBEAT_STALE_MS
  ) return true;
  return now - Date.parse(lock.createdAt) <= SUPERVISOR_STARTING_GRACE_MS;
}

function lockOwnerIsLive(lock: ParsedSupervisorLock): boolean {
  return processIsAlive(lock.pid) && !pidWasReused(lock);
}

function orphanWorkerIsLive(lock: ParsedSupervisorLock): boolean {
  if (lock.legacy) {
    const status = readWorkerStatus();
    const workerPid = Number(status?.pid || 0);
    const heartbeatAt = String(status?.heartbeatAt || '');
    return Number.isSafeInteger(workerPid)
      && workerPid > 0
      && processIsAlive(workerPid)
      && !pidWasReused({ pid: workerPid, createdAt: heartbeatAt });
  }
  const heartbeat = readHeartbeat();
  if (
    !heartbeat
    || heartbeat.pid !== lock.pid
    || heartbeat.token !== lock.token
    || heartbeat.workerPid <= 0
    || !processIsAlive(heartbeat.workerPid)
  ) return false;
  return !pidWasReused({ pid: heartbeat.workerPid, createdAt: heartbeat.heartbeatAt });
}

function readWorkerRecoveryHandoff(lock: ParsedSupervisorLock, now = Date.now()): WorkerRecoveryHandoff | null {
  try {
    const value = JSON.parse(fs.readFileSync(paths.workerRecoveryHandoff, 'utf8')) as WorkerRecoveryHandoff;
    const createdAt = Date.parse(value.createdAt);
    const expiresAt = Date.parse(value.expiresAt);
    if (
      value.schemaVersion !== 'omnia.v5.remote-connector-worker-recovery/v1'
      || value.product !== REMOTE_CONNECTOR_PRODUCT
      || typeof value.recoveryId !== 'string'
      || value.recoveryId.length < 16
      || value.ownerPid !== lock.pid
      || value.ownerToken !== lock.token
      || !Number.isSafeInteger(value.workerPid)
      || value.workerPid <= 0
      || !/^[a-f0-9]{48}$/u.test(value.executionGeneration)
      || value.admissionSealed !== true
      || value.workerClaimReleased !== true
      || !Number.isFinite(createdAt)
      || !Number.isFinite(expiresAt)
      || createdAt > now + 5_000
      || expiresAt <= now
      || expiresAt - createdAt > WORKER_RECOVERY_HANDOFF_MAX_AGE_MS
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function clearWorkerRecoveryHandoff(recoveryId: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(paths.workerRecoveryHandoff, 'utf8')) as Partial<WorkerRecoveryHandoff>;
    if (current.recoveryId === recoveryId) fs.rmSync(paths.workerRecoveryHandoff, { force: true });
  } catch { /* best effort */ }
}

function recoveryHandoffStillMatches(recoveryId: string): boolean {
  try {
    const current = JSON.parse(fs.readFileSync(paths.workerRecoveryHandoff, 'utf8')) as Partial<WorkerRecoveryHandoff>;
    return current.recoveryId === recoveryId;
  } catch {
    return false;
  }
}

function handoffWorkerIsLive(handoff: WorkerRecoveryHandoff): boolean {
  return processIsAlive(handoff.workerPid)
    && !pidWasReused({ pid: handoff.workerPid, createdAt: handoff.createdAt });
}

function identifyRecoveryHandoffWorker(
  handoff: WorkerRecoveryHandoff,
  now = Date.now()
): RecoveryHandoffWorkerIdentity | null {
  try {
    const status = readWorkerStatusByGeneration(handoff.executionGeneration);
    const statusHeartbeatAt = Date.parse(String(status?.heartbeatAt || ''));
    const handoffCreatedAt = Date.parse(handoff.createdAt);
    if (
      !status
      || !Number.isSafeInteger(status.pid)
      || status.pid !== handoff.workerPid
      || status.executionGeneration !== handoff.executionGeneration
      || status.admissionClosed !== true || status.admissionSealed !== true
      || status.workerClaimHeld !== false || status.maintenanceState !== 'quiesced'
      || typeof status.version !== 'string'
      || !Number.isSafeInteger(status.sequence)
      || !Number.isFinite(statusHeartbeatAt)
      || statusHeartbeatAt < handoffCreatedAt - 5_000
      || statusHeartbeatAt > now + 5_000
    ) return null;
    const state = readManagedState(paths);
    const identity = { version: status.version, sequence: status.sequence };
    const pendingRole = classifyManagedWorkerIdentity(state, identity, null);
    if (pendingRole === 'pending') {
      return { role: pendingRole, version: status.version, sequence: status.sequence as number };
    }
    if (!state.current) return null;
    const currentManifest = verifyPortableRoot(versionRoot(paths, state.current));
    if (currentManifest.version !== state.current) return null;
    const currentRole = classifyManagedWorkerIdentity(state, identity, currentManifest.sequence);
    return currentRole === 'current'
      ? { role: currentRole, version: status.version, sequence: status.sequence as number }
      : null;
  } catch {
    return null;
  }
}

async function waitForHandoffWorkerExit(
  lock: ParsedSupervisorLock,
  handoff: WorkerRecoveryHandoff
): Promise<boolean> {
  const deadline = Math.min(Date.parse(handoff.expiresAt), Date.now() + WORKER_RECOVERY_HANDOFF_WAIT_MS);
  let nextHeartbeatAt = 0;
  log('info', 'Verified an orphan Worker recovery handoff; waiting for the quiesced Worker to exit.', {
    ownerPid: lock.pid,
    workerPid: handoff.workerPid
  });
  while (Date.now() < deadline) {
    if (ownsLock && Date.now() >= nextHeartbeatAt) {
      if (!await publishHeartbeat()) return false;
      nextHeartbeatAt = Date.now() + SUPERVISOR_HEARTBEAT_INTERVAL_MS;
    }
    if (!handoffWorkerIsLive(handoff)) {
      clearWorkerRecoveryHandoff(handoff.recoveryId);
      log('info', 'Recovery handoff Worker exited; replacement Worker startup may proceed.', {
        ownerPid: lock.pid,
        workerPid: handoff.workerPid
      });
      return true;
    }
    if (!recoveryHandoffStillMatches(handoff.recoveryId)) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!handoffWorkerIsLive(handoff)) {
    clearWorkerRecoveryHandoff(handoff.recoveryId);
    return true;
  }
  log('error', 'Recovery handoff Worker did not exit before the bounded takeover deadline.', {
    ownerPid: lock.pid,
    workerPid: handoff.workerPid
  });
  return false;
}

function ownsCurrentLock(): boolean {
  const current = readLock();
  return Boolean(current && !current.legacy && current.pid === process.pid && current.token === lockToken
    && current.processStartedAt === supervisorProcessStartedAt
    && current.guardianPid === guardianPid && current.guardianToken === guardianToken
    && current.bootstrapRevision === bootstrapRevision && current.supervisorSlot === supervisorSlot
    && current.supervisorSha256 === supervisorSha256 && current.transactionId === updateTransactionId
    && pidMatchesExactStartTime(process.pid, supervisorProcessStartedAt!));
}

function retryableHeartbeatError(error: unknown): boolean {
  return ['EPERM', 'EBUSY', 'EACCES'].includes(String((error as NodeJS.ErrnoException)?.code || ''));
}

async function writeHeartbeatAtomic(value: SupervisorHeartbeat): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const temporary = `${paths.supervisorHeartbeat}.${process.pid}.${lockToken}.${attempt}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, paths.supervisorHeartbeat);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableHeartbeatError(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  throw lastError;
}

async function publishHeartbeat(): Promise<boolean> {
  if (!ownsCurrentLock() || !guardianLeaseIsLive()) return false;
  await writeHeartbeatAtomic({
    schemaVersion: 'omnia.v5.remote-connector-supervisor-heartbeat/v2',
    product: REMOTE_CONNECTOR_PRODUCT,
    pid: process.pid,
    token: lockToken,
    processStartedAt: supervisorProcessStartedAt!,
    supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
    workerPid: Number(worker?.pid || workerIdentity?.pid || 0),
    guardianPid,
    guardianToken,
    bootstrapRevision,
    supervisorSlot: supervisorSlot as 'a' | 'b',
    supervisorSha256,
    transactionId: updateTransactionId,
    heartbeatAt: new Date().toISOString()
  } satisfies SupervisorHeartbeat);
  return ownsCurrentLock();
}

function guardianLeaseIsLive(): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(paths.guardianLock, 'utf8')) as Record<string, unknown>;
    const createdAt = String(value.createdAt || '');
    return value.schemaVersion === 'omnia.v5.remote-connector-mutex/v1'
      && Number(value.pid) === guardianPid && value.token === guardianToken
      && Number.isFinite(Date.parse(createdAt))
      && processBirthMatch(guardianPid, createdAt) === 'match';
  } catch { return false; }
}

function pidWasReused(lock: { pid: number; createdAt: string }): boolean {
  return processIsAlive(lock.pid) && processBirthMatch(lock.pid, lock.createdAt) === 'mismatch';
}

function activeRecoveryClaims(directory: string): Array<{ token: string; createdAt: number }> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const active: Array<{ token: string; createdAt: number }> = [];
  for (const filename of fs.readdirSync(directory)) {
    const claimPath = path.join(directory, filename);
    const claim = readJsonRecord(claimPath);
    const filenamePid = Number(/^claim-(\d+)-/.exec(filename)?.[1] || 0);
    const pid = Number(claim?.pid || filenamePid);
    const token = String(claim?.token || filename);
    const createdAtText = String(claim?.createdAt || '');
    const createdAt = Date.parse(createdAtText);
    const ownerLive = Number.isSafeInteger(pid)
      && pid > 0
      && processIsAlive(pid)
      && (!Number.isFinite(createdAt) || !pidWasReused({ pid, createdAt: createdAtText }));
    if (ownerLive) {
      active.push({ token, createdAt: Number.isFinite(createdAt) ? createdAt : fs.statSync(claimPath).mtimeMs });
    } else {
      fs.rmSync(claimPath, { force: true });
    }
  }
  return active.sort((left, right) => left.createdAt - right.createdAt || left.token.localeCompare(right.token));
}

async function acquireRecoveryGate(): Promise<boolean> {
  const deadline = Date.now() + SUPERVISOR_RECOVERY_GATE_LEASE_MS + 5_000;
  const claimsDirectory = `${paths.supervisorRecoveryLock}.claims`;
  const claimPath = path.join(claimsDirectory, `claim-${process.pid}-${lockToken}.json`);
  const claimTemporary = `${claimPath}.tmp`;
  const publishGate = () => {
    const handle = fs.openSync(paths.supervisorRecoveryLock, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token: lockToken, createdAt: new Date().toISOString() }));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  };
  try {
    while (Date.now() < deadline) {
      const gate = readJsonRecord(paths.supervisorRecoveryLock);
      if (!gate && !fs.existsSync(paths.supervisorRecoveryLock)) {
        const claims = activeRecoveryClaims(claimsDirectory);
        if (claims.length > 0 && claims[0]?.token !== lockToken) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        try {
          publishGate();
          if (claims[0]?.token === lockToken) {
            fs.rmSync(claimPath, { force: true });
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (activeRecoveryClaims(claimsDirectory).length === 0 && ownsRecoveryGate()) return true;
          releaseRecoveryGate();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        continue;
      }
      const gatePid = Number(gate?.pid || 0);
      const gateCreatedAt = String(gate?.createdAt || '');
      if (
        Number.isSafeInteger(gatePid)
        && gatePid > 0
        && processIsAlive(gatePid)
        && (!Number.isFinite(Date.parse(gateCreatedAt)) || !pidWasReused({ pid: gatePid, createdAt: gateCreatedAt }))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      fs.mkdirSync(claimsDirectory, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(claimPath)) {
        const handle = fs.openSync(claimTemporary, 'wx', 0o600);
        try {
          fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token: lockToken, createdAt: new Date().toISOString() }));
          fs.fsyncSync(handle);
        } finally {
          fs.closeSync(handle);
        }
        try { fs.linkSync(claimTemporary, claimPath); } finally { fs.rmSync(claimTemporary, { force: true }); }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const claims = activeRecoveryClaims(claimsDirectory);
      if (claims[0]?.token !== lockToken) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const confirmedGate = readJsonRecord(paths.supervisorRecoveryLock);
      if (confirmedGate?.token !== gate?.token) continue;
      fs.rmSync(paths.supervisorRecoveryLock, { force: true });
      try {
        publishGate();
        fs.rmSync(claimPath, { force: true });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  } finally {
    fs.rmSync(claimTemporary, { force: true });
    fs.rmSync(claimPath, { force: true });
  }
}

function readJsonRecord(filename: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

function ownsRecoveryGate(): boolean {
  return readJsonRecord(paths.supervisorRecoveryLock)?.token === lockToken;
}

function releaseRecoveryGate(): void {
  try {
    const current = readJsonRecord(paths.supervisorRecoveryLock);
    if (current?.token === lockToken) fs.rmSync(paths.supervisorRecoveryLock, { force: true });
  } catch { /* best effort */ }
}

async function acquireLock(): Promise<boolean> {
  const publish = () => {
    const handle = fs.openSync(paths.supervisorLock, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify({
        schemaVersion: 'omnia.v5.remote-connector-supervisor-lock/v2',
        product: REMOTE_CONNECTOR_PRODUCT,
        pid: process.pid,
        token: lockToken,
        processStartedAt: supervisorProcessStartedAt!,
        createdAt: new Date().toISOString(),
        guardianPid,
        guardianToken,
        bootstrapRevision,
        supervisorSlot: supervisorSlot as 'a' | 'b',
        supervisorSha256,
        transactionId: updateTransactionId
      } satisfies SupervisorLock));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    ownsLock = true;
  };
  if (!await acquireRecoveryGate()) {
    log('error', 'Supervisor recovery gate did not become available; refusing an unsafe concurrent start.');
    return false;
  }
  try {
    const observed = readLock();
    if (!observed && fs.existsSync(paths.supervisorLock)) {
      log('error', 'Supervisor lock is unreadable; refusing automatic recovery without a verifiable owner token.');
      return false;
    }
    if (observed && lockIsLive(observed)) return false;
    let recoveryHandoff: WorkerRecoveryHandoff | null = null;
    let recoveryHandoffIdentity: RecoveryHandoffWorkerIdentity | null = null;
    if (observed) recoveryHandoff = readWorkerRecoveryHandoff(observed);
    if (recoveryHandoff) {
      recoveryHandoffIdentity = identifyRecoveryHandoffWorker(recoveryHandoff);
      if (!recoveryHandoffIdentity) {
        log('error', 'Recovery handoff Worker identity is not the exact managed current or pending release; refusing takeover.', {
          ownerPid: observed?.pid,
          workerPid: recoveryHandoff.workerPid
        });
        return false;
      }
    }
    if (observed && lockOwnerIsLive(observed)) {
      if (!recoveryHandoff) {
        log('error', 'Stale Supervisor heartbeat still belongs to a live PID; refused dual startup without a verified Worker recovery handoff.', {
          ownerPid: observed.pid,
          legacy: observed.legacy
        });
        return false;
      }
      log('warn', 'Verified a Worker recovery handoff from a stale live Supervisor; fencing the old owner token.', {
        ownerPid: observed.pid,
        workerPid: recoveryHandoff.workerPid,
        workerRole: recoveryHandoffIdentity?.role,
        workerVersion: recoveryHandoffIdentity?.version,
        workerSequence: recoveryHandoffIdentity?.sequence
      });
    }
    if (observed && orphanWorkerIsLive(observed) && !recoveryHandoff) {
      log('error', 'Supervisor exited without a verified Worker recovery handoff; refusing an unsafe replacement.', {
        ownerPid: observed.pid,
        workerPid: readHeartbeat()?.workerPid
      });
      return false;
    }
    if (!ownsRecoveryGate()) return false;
    if (observed) {
      const confirmed = readLock();
      if (!confirmed || confirmed.pid !== observed.pid || confirmed.token !== observed.token) return false;
    }
    fs.rmSync(paths.supervisorLock, { force: true });
    try {
      publish();
      if (!await publishHeartbeat()) return false;
      if (observed && recoveryHandoff) {
        log('info', 'Published the fenced Supervisor heartbeat; waiting for the quiesced Worker to acknowledge takeover and exit.', {
          ownerPid: observed.pid,
          workerPid: recoveryHandoff.workerPid,
          workerRole: recoveryHandoffIdentity?.role,
          workerVersion: recoveryHandoffIdentity?.version,
          workerSequence: recoveryHandoffIdentity?.sequence
        });
        if (!await waitForHandoffWorkerExit(observed, recoveryHandoff)) {
          throw new Error('Quiesced Worker did not exit after the fenced Supervisor takeover acknowledgement.');
        }
      }
      return ownsCurrentLock();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    releaseRecoveryGate();
  }
}

function releaseLock(): void {
  if (!ownsLock) return;
  try {
    const current = readLock();
    if (current?.token === lockToken) fs.rmSync(paths.supervisorLock, { force: true });
  } catch { /* best effort */ }
  try {
    const heartbeat = readHeartbeat();
    if (heartbeat?.token === lockToken) fs.rmSync(paths.supervisorHeartbeat, { force: true });
  } catch { /* best effort */ }
  ownsLock = false;
}

function verifiedPortableVersion(version: string): string {
  if (!version) throw new Error('v5 Remote Connector is not installed.');
  const root = versionRoot(paths, version);
  const manifest = verifyPortableRoot(root);
  if (manifest.version !== version) throw new Error('Managed version does not match its signed portable manifest.');
  return root;
}

async function stopUnidentifiedOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const terminated = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timeout = setTimeout(() => resolve(false), 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(true); });
  });
  if (terminated || child.exitCode !== null) return;
  child.kill('SIGKILL');
  const killed = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timeout = setTimeout(() => resolve(false), 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(true); });
  });
  if (!killed && child.exitCode === null) {
    throw new Error('Worker with an unreadable birth identity did not exit through its owned ChildProcess handle.');
  }
}

async function startWorker(
  explicitVersion?: string,
  probationEpoch = '',
  workerTransactionId = updateTransactionId
): Promise<ChildProcess> {
  const state = readManagedState(paths);
  const workerVersion = explicitVersion || state.current;
  const root = verifiedPortableVersion(workerVersion);
  const portable = verifyPortableRoot(root);
  let effectiveProbationEpoch = probationEpoch;
  if (!effectiveProbationEpoch) {
    const baseline = readBaselineAdmission(paths);
    if (requiresSealedBaselineRestart(baseline, workerVersion)) {
      effectiveProbationEpoch = crypto.randomBytes(24).toString('hex');
      workerTransactionId = '';
    }
  }
  const executionGeneration = crypto.randomBytes(24).toString('hex');
  const child = spawn(
    path.join(root, 'runtime', 'node.exe'),
    [path.join(root, 'app', 'worker.cjs')],
    {
      cwd: root,
      // A forced Supervisor termination must not tear down the Worker before
      // its owner-lease recovery handoff can run. Keep the ChildProcess handle
      // referenced for exit/error observation and owned stop; do not unref it.
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: paths.installRoot,
        OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: paths.dataRoot,
        OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_PID: String(process.pid),
        OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_TOKEN: lockToken,
        OMNIA_V5_REMOTE_CONNECTOR_GUARDIAN_PID: String(guardianPid),
        OMNIA_V5_REMOTE_CONNECTOR_GUARDIAN_TOKEN: guardianToken,
        OMNIA_V5_REMOTE_CONNECTOR_WORKER_TOKEN: executionGeneration,
        OMNIA_V5_REMOTE_CONNECTOR_UPDATE_TRANSACTION_ID: workerTransactionId,
        ...(effectiveProbationEpoch ? { OMNIA_V5_REMOTE_CONNECTOR_PROBATION_EPOCH: effectiveProbationEpoch } : {})
      }
    }
  );
  let workerProcessStartedAt: string | null = null;
  for (let attempt = 0; attempt < 10 && !workerProcessStartedAt; attempt += 1) {
    workerProcessStartedAt = processStartTimeUtc(Number(child.pid || 0));
    if (!workerProcessStartedAt) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!workerProcessStartedAt) {
    await stopUnidentifiedOwnedChild(child);
    throw new Error('Worker process birth identity could not be persisted; refusing unsafe adoption.');
  }
  worker = child;
  workerIdentity = {
    pid: Number(child.pid || 0),
    token: executionGeneration,
    version: workerVersion,
    sequence: portable.sequence,
    startedAt: workerProcessStartedAt,
    statusPath: workerStatusPath(executionGeneration)
  };
  if (effectiveProbationEpoch && !workerTransactionId) {
    writeBaselineAdmission(paths, {
      phase: 'promoted', version: workerVersion, sequence: portable.sequence,
      epoch: effectiveProbationEpoch, executionGeneration, admittedAt: ''
    });
  }
  workerHasStarted = true;
  workerStartedAt = Date.now();
  workerHeartbeatStaleSince = 0;
  let failureRecorded = false;
  const recordFailureBackoff = () => {
    if (failureRecorded || stopping || transitioning) return;
    failureRecorded = true;
    workerRestartFailures = Math.min(workerRestartFailures + 1, 6);
    nextWorkerStartAt = Date.now() + Math.min(30_000, 1_000 * (2 ** (workerRestartFailures - 1)));
  };
  child.once('exit', (code, signal) => {
    if (worker === child) {
      worker = null;
      if (workerIdentity?.pid === Number(child.pid || 0)) workerIdentity = null;
      workerHeartbeatStaleSince = 0;
    }
    if (!stopping && !transitioning) {
      recordFailureBackoff();
      log('warn', 'Versioned Remote Connector worker exited; Supervisor will restart it.', {
        version: workerVersion,
        code,
        signal
      });
    }
  });
  child.once('error', (error) => {
    const childPid = Number(child.pid || 0);
    const processConfirmedAbsent = child.exitCode !== null
      || childPid <= 0
      || !processIsAlive(childPid);
    if (worker === child && processConfirmedAbsent) {
      worker = null;
      if (workerIdentity?.pid === childPid) workerIdentity = null;
      workerHeartbeatStaleSince = 0;
    }
    recordFailureBackoff();
    log('error', 'Versioned Remote Connector worker failed to start.', {
      version: workerVersion,
      error: error.message
    });
  });
  return child;
}

function abandonWorkerForOwnerLoss(): void {
  const child = worker;
  worker = null;
  workerIdentity = null;
  if (!child || child.exitCode !== null) return;
  child.removeAllListeners();
  child.unref();
}

async function stopWorker(): Promise<void> {
  const child = worker;
  if (!child) {
    const adopted = workerIdentity;
    if (!adopted) return;
    const initialBirth = workerBirthState(adopted);
    if (initialBirth === 'absent' || initialBirth === 'alive_mismatch') { workerIdentity = null; return; }
    if (initialBirth === 'alive_unknown' || !supervisorMaySignalWorker(adopted)) {
      throw new Error(`Adopted Worker ${adopted.pid} signalling authority is unavailable.`);
    }
    try { process.kill(adopted.pid, 'SIGTERM'); } catch { /* exact liveness check below */ }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && workerBirthState(adopted) === 'alive_match') {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let birthState = workerBirthState(adopted);
    if (birthState === 'alive_unknown') throw new Error(`Adopted Worker ${adopted.pid} birth became unknown after SIGTERM.`);
    if (birthState === 'alive_match') {
      if (!supervisorMaySignalWorker(adopted)) {
        throw new Error(`Adopted Worker ${adopted.pid} SIGKILL authority could not be re-proven.`);
      }
      try { process.kill(adopted.pid, 'SIGKILL'); } catch { /* exact liveness check below */ }
      const killDeadline = Date.now() + 5_000;
      while (Date.now() < killDeadline && workerBirthState(adopted) === 'alive_match') {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      birthState = workerBirthState(adopted);
    }
    if (birthState === 'alive_match' || birthState === 'alive_unknown') {
      throw new Error(`Adopted Worker ${adopted.pid} did not exit with a provable birth transition.`);
    }
    workerIdentity = null;
    return;
  }
  const clearConfirmedWorker = () => {
    if (worker === child) worker = null;
    if (workerIdentity?.pid === Number(child.pid || 0)) workerIdentity = null;
    workerHeartbeatStaleSince = 0;
  };
  if (child.exitCode !== null) {
    clearConfirmedWorker();
    return;
  }
  child.kill('SIGTERM');
  const exitedAfterTerminate = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  if (exitedAfterTerminate || child.exitCode !== null) {
    clearConfirmedWorker();
    return;
  }
  child.kill('SIGKILL');
  const exitedAfterKill = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timeout = setTimeout(() => resolve(false), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  if (!exitedAfterKill && child.exitCode === null) {
    throw new Error(`Worker ${child.pid || 'unknown'} did not exit after owned-process termination.`);
  }
  clearConfirmedWorker();
}

function workerStatusPath(executionGeneration: string): string {
  if (!/^[a-f0-9]{48}$/u.test(executionGeneration)) throw new Error('Worker status generation is invalid.');
  return path.join(paths.workerStatuses, `${executionGeneration}.json`);
}

function readWorkerStatus(identity?: WorkerProcessIdentity): Record<string, unknown> | null {
  try {
    if (identity && path.resolve(identity.statusPath) !== path.resolve(workerStatusPath(identity.token))) return null;
    const filename = identity ? identity.statusPath : paths.status;
    const status = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, unknown>;
    if (
      status.schemaVersion !== 'omnia.v5.remote-connector-status/v1'
      || status.product !== REMOTE_CONNECTOR_PRODUCT
      || !Number.isFinite(Date.parse(String(status.heartbeatAt || '')))
    ) return null;
    return status;
  } catch {
    return null;
  }
}

function readWorkerStatusByGeneration(executionGeneration: string): Record<string, unknown> | null {
  try {
    const status = JSON.parse(fs.readFileSync(workerStatusPath(executionGeneration), 'utf8')) as Record<string, unknown>;
    if (status.schemaVersion !== 'omnia.v5.remote-connector-status/v1'
      || status.product !== REMOTE_CONNECTOR_PRODUCT
      || status.executionGeneration !== executionGeneration
      || !Number.isFinite(Date.parse(String(status.heartbeatAt || '')))) return null;
    return status;
  } catch { return null; }
}

function exactWorkerIdentityFromStatus(status: Record<string, unknown> | null): WorkerProcessIdentity | null {
  if (!status || !Number.isSafeInteger(status.pid) || Number(status.pid) <= 0
    || !/^[a-f0-9]{48}$/u.test(String(status.executionGeneration || ''))
    || !/^\d+\.\d+\.\d+$/u.test(String(status.version || ''))
    || !Number.isSafeInteger(status.sequence) || Number(status.sequence) <= 0) return null;
  const pid = Number(status.pid);
  const startedAt = processStartTimeUtc(pid);
  if (!startedAt) return null;
  const identity = {
    pid,
    token: String(status.executionGeneration),
    version: String(status.version),
    sequence: Number(status.sequence),
    startedAt,
    statusPath: workerStatusPath(String(status.executionGeneration))
  };
  return workerStatusMatches(readWorkerStatus(identity), identity) ? identity : null;
}

function workerStatusMatches(
  status: Record<string, unknown> | null,
  identity: WorkerProcessIdentity,
  options: { quiesced?: boolean; probation?: boolean; running?: boolean; epoch?: string } = {}
): boolean {
  if (!status || Number(status.pid) !== identity.pid
    || status.executionGeneration !== identity.token
    || status.processStartedAt !== identity.startedAt
    || status.version !== identity.version || Number(status.sequence) !== identity.sequence) return false;
  const heartbeatAge = Date.now() - Date.parse(String(status.heartbeatAt || ''));
  if (!Number.isFinite(heartbeatAge) || heartbeatAge < -5_000 || heartbeatAge > 5_000) return false;
  if (options.epoch && status.maintenanceEpoch !== options.epoch) return false;
  const blockers = status.operationBlockers as Record<string, unknown> | null;
  const zeroKnown = status.operationActivityState === 'known'
    && Number(status.activeOperations) === 0 && Number(status.uncertainOperations) === 0
    && blockers?.state === 'known' && Number(blockers.activeResources) === 0
    && Number(blockers.pendingRegistrations) === 0;
  if ((options.quiesced || options.probation) && !zeroKnown) return false;
  if (options.quiesced) {
    return status.maintenanceState === 'quiesced' && status.admissionClosed === true
      && status.admissionSealed === true && status.workerClaimHeld === false;
  }
  if (options.probation) {
    const probe = status.probationProbe as Record<string, unknown> | null;
    return status.maintenanceState === 'closing_admission' && status.admissionClosed === true
      && status.admissionSealed === true && status.workerClaimHeld === true
      && Number(status.businessAdmissions) === 0 && status.bridgeState === 'connected'
      && probe?.state === 'verified'
      && typeof probe.connectorId === 'string' && probe.connectorId.length > 0
      && Number.isSafeInteger(probe.sessionGeneration) && Number(probe.sessionGeneration) > 0
      && typeof probe.engagementId === 'string' && probe.engagementId.length > 0
      && typeof probe.authorityInstanceId === 'string' && probe.authorityInstanceId.length > 0
      && typeof probe.tenantOrOrgId === 'string' && probe.tenantOrOrgId.length > 0
      && typeof probe.packId === 'string' && probe.packId.length > 0
      && /^[a-f0-9]{64}$/u.test(String(probe.capabilityDigest || ''));
  }
  if (options.running) {
    return status.maintenanceState === 'running' && status.admissionClosed === false
      && status.admissionSealed === false && status.workerClaimHeld === true;
  }
  return status.operationActivityState === 'known' && blockers?.state === 'known';
}

function workerPidBelongsToIdentity(identity: WorkerProcessIdentity): boolean {
  if (!pidMatchesExactStartTime(identity.pid, identity.startedAt)) return false;
  const status = readWorkerStatus(identity);
  const heartbeatAge = Date.now() - Date.parse(String(status?.heartbeatAt || ''));
  return Boolean(status
    && Number(status.pid) === identity.pid
    && status.executionGeneration === identity.token
    && status.processStartedAt === identity.startedAt
    && status.version === identity.version
    && Number(status.sequence) === identity.sequence
    && Number.isFinite(heartbeatAge) && heartbeatAge >= -5_000 && heartbeatAge <= 5_000);
}

function supervisorMaySignalWorker(identity: WorkerProcessIdentity): boolean {
  if (!ownsCurrentLock() || !guardianLeaseIsLive() || !workerPidBelongsToIdentity(identity)) return false;
  const claim = readWorkerClaim(paths);
  if (claim && claim.pid === identity.pid && claim.executionGeneration === identity.token
    && claim.state === 'admitted') return true;
  const maintenance = readWorkerMaintenance(paths);
  return Boolean(maintenance
    && maintenance.target.pid === identity.pid && maintenance.target.token === identity.token
    && maintenance.target.version === identity.version && maintenance.target.sequence === identity.sequence
    && maintenance.acknowledgement?.pid === identity.pid
    && maintenance.acknowledgement.executionGeneration === identity.token
    && ['quiesced', 'retiring', 'failed_closed'].includes(maintenance.acknowledgement.state));
}

function exactRunningWorkerOwnsClaim(identity: WorkerProcessIdentity, epoch: string): boolean {
  if (!workerPidBelongsToIdentity(identity)
    || !workerStatusMatches(readWorkerStatus(identity), identity, { running: true, epoch })) return false;
  const claim = readWorkerClaim(paths);
  return Boolean(claim && claim.pid === identity.pid
    && claim.executionGeneration === identity.token && claim.state === 'admitted');
}

function workerBirthState(identity: WorkerProcessIdentity) {
  if (!processIsAlive(identity.pid)) return 'absent' as const;
  const current = processStartTimeUtc(identity.pid);
  if (!current) return 'alive_unknown' as const;
  return current === identity.startedAt ? 'alive_match' as const : 'alive_mismatch' as const;
}

async function waitForWorkerState(
  identity: WorkerProcessIdentity,
  options: { quiesced?: boolean; probation?: boolean; running?: boolean; epoch?: string },
  timeoutMs = 90_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readWorkerStatus(identity);
    if (workerStatusMatches(status, identity, options)) return status!;
    if (!processIsAlive(identity.pid)) throw new Error(`Worker ${identity.pid} exited during guarded transition.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Worker did not reach the exact guarded maintenance state before timeout.');
}

function publishWorkerMaintenance(
  transaction: ConnectorUpdateTransaction,
  target: WorkerProcessIdentity,
  action: WorkerMaintenanceRecord['action']
): WorkerMaintenanceRecord {
  const existing = readWorkerMaintenance(paths);
  if (existing && existing.transactionId === transaction.transactionId
    && existing.epoch === transaction.maintenanceEpoch
    && existing.ownerGuardianToken === transaction.maintenanceAuthorityToken
    && existing.target.pid === target.pid && existing.target.token === target.token
    && existing.target.version === target.version && existing.target.sequence === target.sequence
    && existing.action === action) return existing;
  return writeWorkerMaintenance(paths, {
    schemaVersion: 'omnia.v5.connector-worker-maintenance/v2',
    revision: existing?.revision ?? 0,
    transactionId: transaction.transactionId,
    epoch: transaction.maintenanceEpoch,
    ownerGuardianToken: transaction.maintenanceAuthorityToken,
    target: { pid: target.pid, token: target.token, version: target.version, sequence: target.sequence },
    action,
    requestedAt: new Date().toISOString(),
    acknowledgement: null
  });
}

async function waitForMaintenanceAck(
  transaction: ConnectorUpdateTransaction,
  target: WorkerProcessIdentity,
  expected: NonNullable<WorkerMaintenanceRecord['acknowledgement']>['state'],
  timeoutMs = 90_000
): Promise<WorkerMaintenanceRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readWorkerMaintenance(paths);
    const ack = record?.acknowledgement;
    if (record?.transactionId === transaction.transactionId && record.epoch === transaction.maintenanceEpoch
      && record.ownerGuardianToken === transaction.maintenanceAuthorityToken
      && record.target.pid === target.pid && record.target.token === target.token
      && ack?.pid === target.pid && ack.executionGeneration === target.token && ack.state === expected) return record;
    if (!processIsAlive(target.pid) && expected !== 'retiring') {
      throw new Error(`Worker ${target.pid} exited before maintenance acknowledgement.`);
    }
    if (!processIsAlive(target.pid) && expected === 'retiring') return record!;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Worker maintenance acknowledgement timed out.');
}

function transactionCas(
  transaction: ConnectorUpdateTransaction,
  changes: Partial<Omit<ConnectorUpdateTransaction, 'schemaVersion'|'transactionId'|'revision'|'createdAt'|'updatedAt'>>
): ConnectorUpdateTransaction {
  return casUpdateTransaction(paths, transaction.transactionId, transaction.revision, (current) => ({
    ...current,
    ...changes
  }));
}

function deterministicGuardianRequestId(transactionId: string, action: 'activate_pending'|'rollback_previous'): string {
  return crypto.createHash('sha256').update(`${transactionId}:${action}`).digest('hex').slice(0, 48);
}

function bindManagedPending(transaction: ConnectorUpdateTransaction): ManagedState {
  const state = readManagedState(paths);
  if (state.transitionId === transaction.transactionId
    && state.pending?.version === transaction.candidate.version
    && state.pending.sequence === transaction.candidate.sequence
    && state.current === transaction.current.version) return state;
  if (state.revision !== transaction.managedRevisionAtStage || state.transitionId !== ''
    || state.pending !== null || state.current !== transaction.current.version) {
    throw new Error('Managed release state drifted before durable pending publication.');
  }
  return writeManagedState(paths, {
    ...state,
    transitionId: transaction.transactionId,
    pending: {
      version: transaction.candidate.version,
      sequence: transaction.candidate.sequence,
      stagedAt: transaction.createdAt
    }
  });
}

function workerMaintenanceWasArchived(transaction: ConnectorUpdateTransaction): boolean {
  const root = path.join(paths.dataRoot, 'worker-maintenance-history');
  try {
    return fs.readdirSync(root, { withFileTypes: true }).some((entry) => {
      if (!entry.isFile() || !entry.name.startsWith(`${transaction.transactionId}-`) || !entry.name.endsWith('.json')) return false;
      try {
        const value = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf8')) as Record<string, unknown>;
        return value.schemaVersion === 'omnia.v5.connector-worker-maintenance/v2'
          && value.transactionId === transaction.transactionId
          && value.ownerGuardianToken === transaction.maintenanceAuthorityToken;
      } catch { return false; }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Worker maintenance archive inventory is unavailable.');
  }
}

function updateAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchUpdateManifest(signal?: AbortSignal): Promise<UpdateManifest> {
  const response = await fetch(REMOTE_CONNECTOR_UPDATE_MANIFEST_URL, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: updateAbortSignal(signal, 20_000)
  });
  if (!response.ok) throw new Error(`v5 Remote Connector update manifest returned HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 128 * 1024) throw new Error('v5 Remote Connector update manifest is too large.');
  const text = await response.text();
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('v5 Remote Connector update manifest is too large.');
  return validateUpdateManifest(JSON.parse(text));
}

async function downloadRelease(manifest: UpdateManifest, signal?: AbortSignal): Promise<string> {
  if (manifest.size > REMOTE_CONNECTOR_MAX_ARCHIVE_BYTES) {
    throw new Error('v5 Remote Connector update exceeds the signed package size limit.');
  }
  const finalPath = path.join(paths.updates, `v5-remote-connector-${manifest.version}-${manifest.sequence}.zip`);
  const temporaryPath = `${finalPath}.${process.pid}.partial`;
  const response = await fetch(manifest.url, {
    cache: 'no-store',
    signal: updateAbortSignal(signal, 30 * 60_000)
  });
  if (!response.ok || !response.body) throw new Error(`v5 Remote Connector update download returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength !== manifest.size) {
    throw new Error('v5 Remote Connector update Content-Length differs from the signed size.');
  }
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(temporaryPath, 'wx', 0o600);
  let received = 0;
  let completed = false;
  try {
    try {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes = Buffer.from(chunk.value);
        received += bytes.length;
        if (received > manifest.size || received > REMOTE_CONNECTOR_MAX_ARCHIVE_BYTES) {
          throw new Error('v5 Remote Connector update download exceeded the signed size.');
        }
        fs.writeSync(handle, bytes);
        hash.update(bytes);
      }
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    if (received !== manifest.size || hash.digest('hex') !== manifest.sha256) {
      throw new Error('v5 Remote Connector update archive failed size or SHA-256 verification.');
    }
    fs.renameSync(temporaryPath, finalPath);
    completed = true;
    return finalPath;
  } finally {
    if (!completed) fs.rmSync(temporaryPath, { force: true });
  }
}

async function extractRelease(
  manifest: UpdateManifest,
  archivePath: string,
  signal?: AbortSignal
): Promise<string> {
  const extraction = path.join(paths.updates, `extract-${manifest.version}-${manifest.sequence}`);
  fs.rmSync(extraction, { recursive: true, force: true });
  fs.mkdirSync(extraction, { recursive: true, mode: 0o700 });
  const child = spawn(
    'tar.exe',
    ['-xf', archivePath, '-C', extraction],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  let output = '';
  const capture = (chunk: Buffer | string) => {
    if (output.length < 500) output += chunk.toString().slice(0, 500 - output.length);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const terminate = (error: Error) => {
      try { child.kill('SIGKILL'); } catch { /* timeout/abort still rejects the staging task */ }
      finish(() => reject(error));
    };
    const abort = () => terminate(new Error('v5 Remote Connector update extraction was cancelled.'));
    const timeout = setTimeout(() => {
      terminate(new Error(`v5 Remote Connector update extraction exceeded ${UPDATE_EXTRACTION_TIMEOUT_MS}ms.`));
    }, UPDATE_EXTRACTION_TIMEOUT_MS);
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, exitSignal) => finish(() => resolve({ code, signal: exitSignal })));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  if (result.code !== 0) {
    throw new Error(`v5 Remote Connector update extraction failed (${result.signal || result.code}): ${output}`);
  }
  signal?.throwIfAborted();
  const entries = fs.readdirSync(extraction, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]?.isDirectory()) {
    throw new Error('v5 Remote Connector update archive must contain exactly one portable root.');
  }
  const candidateRoot = path.join(extraction, entries[0].name);
  const portable = verifyPortableRoot(candidateRoot);
  if (portable.version !== manifest.version || portable.sequence !== manifest.sequence) {
    throw new Error('v5 Remote Connector archive identity differs from the signed update offer.');
  }
  const destination = versionRoot(paths, manifest.version);
  if (fs.existsSync(destination)) {
    const existing = verifyPortableRoot(destination);
    if (existing.version !== portable.version || existing.sequence !== portable.sequence) {
      throw new Error('A different package already occupies the target v5 version slot.');
    }
  } else {
    fs.renameSync(candidateRoot, destination);
  }
  fs.rmSync(extraction, { recursive: true, force: true });
  return destination;
}

function verifyPendingCandidatePackage(pending: NonNullable<ManagedState['pending']>): string {
  const root = versionRoot(paths, pending.version);
  const manifest = verifyPortableRoot(root);
  if (manifest.version !== pending.version || manifest.sequence !== pending.sequence) {
    throw new Error('v5 Remote Connector pending state differs from its signed portable package identity.');
  }
  let identity: unknown;
  try {
    identity = JSON.parse(fs.readFileSync(path.join(root, 'package-identity.json'), 'utf8')) as unknown;
  } catch {
    throw new Error('v5 Remote Connector candidate package identity is missing or unreadable.');
  }
  assertPendingPackageIdentity(pending, identity, REMOTE_CONNECTOR_SUPERVISOR_VERSION);
  return root;
}

function healthProbe(
  root: string,
  expectedVersion: string,
  expectedSequence: number,
  expectedSupervisorVersion: string
): void {
  const result = spawnSync(
    path.join(root, 'runtime', 'node.exe'),
    [path.join(root, 'app', 'worker.cjs'), '--health-probe'],
    {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: paths.installRoot,
        OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: paths.dataRoot
      }
    }
  );
  if (result.status !== 0) throw new Error('v5 Remote Connector candidate health probe failed.');
  const status = JSON.parse(String(result.stdout || '{}')) as Record<string, unknown>;
  if (
    status.ok !== true
    || status.product !== REMOTE_CONNECTOR_PRODUCT
    || status.version !== expectedVersion
    || status.sequence !== expectedSequence
    || status.supervisorVersion !== expectedSupervisorVersion
  ) {
    throw new Error('v5 Remote Connector candidate health identity is invalid.');
  }
}

async function probation(expectedVersion: string, expectedSequence: number, child: ChildProcess): Promise<void> {
  const identity = workerIdentity;
  if (!identity || identity.pid !== Number(child.pid || 0)
    || identity.version !== expectedVersion || identity.sequence !== expectedSequence) {
    throw new Error('v5 Remote Connector candidate lacks its exact Supervisor-issued identity.');
  }
  await waitForWorkerState(identity, { probation: true }, 90_000);
}

async function activatePendingBeforeWorkerStart(state: ManagedState): Promise<ManagedState> {
  const pending = state.pending;
  if (!pending || !workerLifecycleAllowsActivation(worker !== null, workerHasStarted)) return state;
  const oldCurrent = state.current;
  const oldPrevious = state.previous;
  transitioning = true;
  let candidate: ChildProcess | null = null;
  let promoted = false;
  try {
    const candidateRoot = verifyPendingCandidatePackage(pending);
    healthProbe(candidateRoot, pending.version, pending.sequence, REMOTE_CONNECTOR_SUPERVISOR_VERSION);
    const baselineEpoch = crypto.randomBytes(24).toString('hex');
    candidate = await startWorker(pending.version, baselineEpoch, '');
    await probation(pending.version, pending.sequence, candidate);
    if (!workerIdentity) throw new Error('Cold baseline Worker identity was lost before prepared publication.');
    writeBaselineAdmission(paths, {
      phase: 'prepared', version: pending.version, sequence: pending.sequence,
      epoch: baselineEpoch, executionGeneration: workerIdentity.token, admittedAt: ''
    });
    const authoritative = readManagedState(paths);
    if (
      authoritative.current !== oldCurrent
      || authoritative.pending?.version !== pending.version
      || authoritative.pending.sequence !== pending.sequence
    ) {
      throw new Error('Managed Remote Connector state changed during candidate probation; refusing a stale promotion.');
    }
    state = writeManagedState(paths, {
      ...authoritative,
      current: pending.version,
      previous: oldCurrent,
      highestSequence: Math.max(authoritative.highestSequence, pending.sequence),
      pending: null
    });
    promoted = true;
    writeBaselineAdmission(paths, {
      phase: 'promoted', version: pending.version, sequence: pending.sequence,
      epoch: baselineEpoch, executionGeneration: workerIdentity.token, admittedAt: ''
    });
    log('info', 'Promoted a signed v5 Remote Connector candidate.', {
      previous: oldCurrent,
      current: pending.version,
      sequence: pending.sequence
    });
    return state;
  } catch (error) {
    if (!promoted && candidate && candidate.exitCode === null) await stopWorker();
    const authoritative = readManagedState(paths);
    if (
      authoritative.current === oldCurrent
      && authoritative.pending?.version === pending.version
      && authoritative.pending.sequence === pending.sequence
    ) {
      state = writeManagedState(paths, {
        ...authoritative,
        current: oldCurrent,
        previous: oldPrevious,
        highestSequence: Math.max(authoritative.highestSequence, pending.sequence),
        pending: null,
        blocked: {
          ...authoritative.blocked,
          [pending.version]: {
            sequence: pending.sequence,
            reason: error instanceof Error ? error.message.slice(0, 500) : 'candidate probation failed',
            blockedAt: new Date().toISOString()
          }
        }
      });
    } else {
      state = authoritative;
    }
    if (!promoted && !worker && state.current) await startWorker(state.current);
    log('error', 'Rolled back a failed v5 Remote Connector candidate.', {
      failedVersion: pending.version,
      restoredVersion: oldCurrent,
      sequence: pending.sequence
    });
    throw error;
  } finally {
    transitioning = false;
  }
}

function preserveLegacyManagedStreamEvidenceBeforeWorkerStart(): void {
  const result = quarantineLegacyManagedStreamOrphans(
    path.join(paths.dataRoot, 'connector', 'operation-streams')
  );
  if (result.failed > 0 || result.remainingOrphans.length > 0) {
    throw new Error(
      `Legacy managed-stream preservation failed closed before Worker startup (${result.failed} failures, `
      + `${result.remainingOrphans.length} remaining orphan files).`
    );
  }
  log('info', 'Verified legacy managed-stream evidence preservation before Worker startup.', {
    quarantined: result.quarantined,
    repaired: result.repaired,
    alreadyQuarantined: result.alreadyQuarantined
  });
}

function readCandidatePackageSupervisorVersion(candidateRoot: string): string {
  const value = JSON.parse(fs.readFileSync(path.join(candidateRoot, 'package-identity.json'), 'utf8')) as Record<string, unknown>;
  if (value.schemaVersion !== 'omnia.v5.remote-connector-identity/v1'
    || value.product !== REMOTE_CONNECTOR_PRODUCT
    || !/^\d+\.\d+\.\d+$/u.test(String(value.supervisorVersion || ''))) {
    throw new Error('Remote Connector candidate package Supervisor identity is invalid.');
  }
  return String(value.supervisorVersion);
}

async function advanceUpdateTransaction(initial: ConnectorUpdateTransaction): Promise<void> {
  let transaction = initial;
  transitioning = true;
  try {
    for (;;) {
      if (transaction.phase === 'completed' || transaction.phase === 'rolled_back') return;
      if (transaction.phase === 'staged') {
        bindManagedPending(transaction);
        let workerA = transaction.workerA;
        if (!workerA) {
          const status = readWorkerStatus();
          workerA = exactWorkerIdentityFromStatus(status);
          if (!workerA || workerA.version !== transaction.current.version
            || workerA.sequence !== transaction.current.sequence || !workerStatusMatches(status, workerA)) {
            throw new Error('Current Worker identity is unavailable; update admission is fail-closed.');
          }
          transaction = transactionCas(transaction, { workerA });
        }
        publishWorkerMaintenance(transaction, workerA, 'quiesce');
        transaction = transactionCas(transaction, { phase: 'maintenance_requested' });
        continue;
      }
      if (transaction.phase === 'maintenance_requested') {
        if (!transaction.workerA) throw new Error('Update transaction lost Worker A identity.');
        publishWorkerMaintenance(transaction, transaction.workerA, 'quiesce');
        const maintenance = await waitForMaintenanceAck(transaction, transaction.workerA, 'quiesced');
        if (!maintenance.acknowledgement?.admissionClosed || !maintenance.acknowledgement.admissionSealed) {
          throw new Error('Worker A quiesce acknowledgement did not close and seal admission.');
        }
        await waitForWorkerState(transaction.workerA, { quiesced: true, epoch: transaction.maintenanceEpoch });
        const claim = readWorkerClaim(paths);
        if (claim?.executionGeneration === transaction.workerA.token) {
          throw new Error('Worker A retained the global Bridge claim after quiesce.');
        }
        transaction = transactionCas(transaction, { phase: 'worker_a_quiesced' });
        if (FAULT_TEST_WORKER_A_QUIESCED_HOLD_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, FAULT_TEST_WORKER_A_QUIESCED_HOLD_MS));
        }
        continue;
      }
      if (transaction.phase === 'worker_a_quiesced') {
        const candidateRoot = verifiedPortableVersion(transaction.candidate.version);
        if (transaction.candidate.supervisorVersion !== REMOTE_CONNECTOR_SUPERVISOR_VERSION) {
          let bootstrap = stageSupervisorSlot(
            paths, candidateRoot, transaction.candidate.supervisorVersion, transaction.transactionId
          );
          transaction = transactionCas(transaction, {
            phase: 'supervisor_switch_requested',
            previousSupervisorSlot: bootstrap.active.slot,
            candidateSupervisorSlot: bootstrap.pending?.slot ?? null
          });
          bootstrap = readBootstrapState(paths);
          const now = new Date();
          writeGuardianRequest(paths, {
            schemaVersion: 'omnia.v5.remote-connector-guardian-request/v1',
            transactionId: transaction.transactionId,
            requestId: deterministicGuardianRequestId(transaction.transactionId, 'activate_pending'),
            revision: bootstrap.revision,
            action: 'activate_pending',
            expectedActiveVersion: bootstrap.active.version,
            expectedPendingVersion: transaction.candidate.supervisorVersion,
            requestedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
          });
          continue;
        }
        transaction = transactionCas(transaction, { phase: 'supervisor_acknowledged' });
        continue;
      }
      if (transaction.phase === 'supervisor_switch_requested') {
        const bootstrap = readBootstrapState(paths);
        const requestId = deterministicGuardianRequestId(transaction.transactionId, 'activate_pending');
        const completed = bootstrap.completedRequests[requestId];
        if (bootstrap.active.version === transaction.candidate.supervisorVersion
          && !bootstrap.transition && completed?.outcome === 'activated') {
          transaction = transactionCas(transaction, { phase: 'supervisor_acknowledged' });
          continue;
        }
        if (completed?.outcome === 'blocked') throw new Error('Guardian blocked the candidate Supervisor generation.');
        if (!bootstrap.pending || bootstrap.pending.transactionId !== transaction.transactionId) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          transaction = readUpdateTransaction(paths) ?? transaction;
          continue;
        }
        const now = new Date();
        writeGuardianRequest(paths, {
          schemaVersion: 'omnia.v5.remote-connector-guardian-request/v1',
          transactionId: transaction.transactionId,
          requestId,
          revision: bootstrap.revision,
          action: 'activate_pending',
          expectedActiveVersion: bootstrap.active.version,
          expectedPendingVersion: transaction.candidate.supervisorVersion,
          requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        transaction = readUpdateTransaction(paths) ?? transaction;
        continue;
      }
      if (transaction.phase === 'supervisor_acknowledged') {
        let workerB = transaction.workerB;
        if (!workerB || !processIsAlive(workerB.pid)) {
          await startWorker(transaction.candidate.version, transaction.maintenanceEpoch, transaction.transactionId);
          if (!workerIdentity || workerIdentity.pid <= 0) throw new Error('Candidate Worker did not receive an execution identity.');
          workerB = workerIdentity;
          transaction = transactionCas(transaction, { workerB, phase: 'worker_b_probation' });
        } else {
          transaction = transactionCas(transaction, { phase: 'worker_b_probation' });
        }
        continue;
      }
      if (transaction.phase === 'worker_b_probation') {
        if (!transaction.workerB) throw new Error('Update transaction lost Worker B identity.');
        const birthState = workerBirthState(transaction.workerB);
        if (birthState === 'absent' || birthState === 'alive_mismatch') {
          await startWorker(transaction.candidate.version, transaction.maintenanceEpoch, transaction.transactionId);
          if (!workerIdentity) throw new Error('Replacement candidate Worker lacks an execution identity.');
          transaction = transactionCas(transaction, { workerB: workerIdentity });
          continue;
        }
        if (birthState === 'alive_unknown') {
          throw new Error('Candidate Worker birth identity is unknown; replacement is fail-closed.');
        }
        workerIdentity = transaction.workerB;
        await waitForWorkerState(transaction.workerB, { probation: true, epoch: transaction.maintenanceEpoch });
        const claim = readWorkerClaim(paths);
        if (!claim || claim.pid !== transaction.workerB.pid
          || claim.executionGeneration !== transaction.workerB.token || claim.state !== 'admitted') {
          throw new Error('Candidate Worker did not hold the exact global claim throughout probation.');
        }
        transaction = transactionCas(transaction, { phase: 'promotion_prepared' });
        continue;
      }
      if (transaction.phase === 'promotion_prepared') {
        if (FAULT_TEST_FAIL_PROMOTION_PREPARED) {
          throw new Error('Isolated fault injection after candidate probation.');
        }
        const state = readManagedState(paths);
        if (state.transitionId === transaction.transactionId
          && state.pending === null && state.current === transaction.candidate.version
          && state.previous === transaction.current.version) {
          transaction = transactionCas(transaction, { phase: 'promoted' });
          continue;
        }
        if (state.transitionId !== transaction.transactionId
          || state.pending?.version !== transaction.candidate.version
          || state.pending.sequence !== transaction.candidate.sequence
          || state.current !== transaction.current.version) {
          throw new Error('Managed release pointer drifted before candidate promotion.');
        }
        writeManagedState(paths, {
          ...state,
          current: transaction.candidate.version,
          previous: transaction.current.version,
          highestSequence: Math.max(state.highestSequence, transaction.candidate.sequence),
          pending: null
        });
        transaction = transactionCas(transaction, { phase: 'promoted' });
        continue;
      }
      if (transaction.phase === 'promoted') {
        if (!transaction.workerA || !transaction.workerB) throw new Error('Promoted transaction lacks Worker identities.');
        const birthState = workerBirthState(transaction.workerB);
        if (birthState === 'absent' || birthState === 'alive_mismatch') {
          await startWorker(transaction.candidate.version, transaction.maintenanceEpoch, transaction.transactionId);
          if (!workerIdentity) throw new Error('Replacement promoted Worker lacks an execution identity.');
          transaction = transactionCas(transaction, { workerB: workerIdentity });
          continue;
        }
        if (birthState === 'alive_unknown') {
          throw new Error('Promoted Worker birth identity is unknown; replacement is fail-closed.');
        }
        // Prove B can own the claim and open admission while A and the
        // Supervisor rollback pointer are still retained. Any first business
        // dispatch durably writes the rollback barrier before effect dispatch.
        if (!exactRunningWorkerOwnsClaim(transaction.workerB, transaction.maintenanceEpoch)) {
          await waitForWorkerState(transaction.workerB, { probation: true, epoch: transaction.maintenanceEpoch });
          publishWorkerMaintenance(transaction, transaction.workerB, 'resume');
          await waitForMaintenanceAck(transaction, transaction.workerB, 'running');
          await waitForWorkerState(transaction.workerB, { running: true, epoch: transaction.maintenanceEpoch });
        }
        workerIdentity = transaction.workerB;
        if (FAULT_TEST_PROMOTED_HOLD_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, FAULT_TEST_PROMOTED_HOLD_MS));
        }
        transaction = transactionCas(transaction, { phase: 'terminalizing' });
        if (FAULT_TEST_TERMINALIZING_HOLD_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, FAULT_TEST_TERMINALIZING_HOLD_MS));
        }
        continue;
      }
      if (transaction.phase === 'terminalizing') {
        if (!transaction.workerA || !transaction.workerB) throw new Error('Terminalizing transaction lacks Worker identities.');
        const birthState = workerBirthState(transaction.workerB);
        if (birthState === 'absent' || birthState === 'alive_mismatch') {
          await startWorker(transaction.candidate.version, transaction.maintenanceEpoch, transaction.transactionId);
          if (!workerIdentity || workerIdentity.version !== transaction.candidate.version
            || workerIdentity.sequence !== transaction.candidate.sequence) {
            throw new Error('Replacement terminalizing Worker B lacks its exact candidate identity.');
          }
          transaction = transactionCas(transaction, { workerB: workerIdentity });
        } else if (birthState === 'alive_unknown') {
          throw new Error('Terminalizing Worker birth identity is unknown; replacement is fail-closed.');
        }
        if (!exactRunningWorkerOwnsClaim(transaction.workerB!, transaction.maintenanceEpoch)) {
          await waitForWorkerState(transaction.workerB!, {
            probation: true, epoch: transaction.maintenanceEpoch
          });
          const terminalClaim = readWorkerClaim(paths);
          if (!terminalClaim || terminalClaim.pid !== transaction.workerB!.pid
            || terminalClaim.executionGeneration !== transaction.workerB!.token
            || terminalClaim.state !== 'admitted') {
            throw new Error('Replacement terminalizing Worker B did not hold the exact global claim during probation.');
          }
          publishWorkerMaintenance(transaction, transaction.workerB!, 'resume');
          await waitForMaintenanceAck(transaction, transaction.workerB!, 'running');
          await waitForWorkerState(transaction.workerB!, {
            running: true, epoch: transaction.maintenanceEpoch
          });
        }
        const terminalWorkerA = transaction.workerA;
        const terminalWorkerB = transaction.workerB;
        if (!terminalWorkerA || !terminalWorkerB) throw new Error('Terminal replacement identity was not persisted.');
        workerIdentity = terminalWorkerB;
        let terminalWorkerAState = workerBirthState(terminalWorkerA);
        if (terminalWorkerAState === 'alive_unknown') {
          throw new Error('Terminal Worker A birth identity is unknown; retirement is fail-closed.');
        }
        if (terminalWorkerAState === 'alive_match') {
          publishWorkerMaintenance(transaction, terminalWorkerA, 'retire');
          await waitForMaintenanceAck(transaction, terminalWorkerA, 'retiring');
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline && workerBirthState(terminalWorkerA) === 'alive_match') {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          terminalWorkerAState = workerBirthState(terminalWorkerA);
          if (terminalWorkerAState === 'alive_match' || terminalWorkerAState === 'alive_unknown') {
            throw new Error('Worker A did not retire with a provable birth transition after promotion.');
          }
        }
        // Closing the bootstrap previous pointer makes terminal completion
        // irreversible before B admits business, even after barrier archival.
        const bootstrap = readBootstrapState(paths);
        if (bootstrap.previous) {
          if (bootstrap.active.version !== transaction.candidate.supervisorVersion) {
            throw new Error('Bootstrap pointer differs from the promoted candidate.');
          }
          casBootstrapState(paths, bootstrap.revision, (current) => ({ ...current, previous: null }));
        }
        const terminalMaintenance = readWorkerMaintenance(paths);
        if (terminalMaintenance) {
          if (terminalMaintenance.transactionId !== transaction.transactionId
            || terminalMaintenance.ownerGuardianToken !== transaction.maintenanceAuthorityToken) {
            throw new Error('Terminal Worker maintenance identity is unavailable for exact archive.');
          }
          archiveWorkerMaintenance(paths, transaction.transactionId,
            transaction.maintenanceAuthorityToken, terminalMaintenance.revision);
        } else if (!workerMaintenanceWasArchived(transaction)) {
          throw new Error('Terminal Worker maintenance archive is missing.');
        }
        const state = readManagedState(paths);
        if (state.transitionId === transaction.transactionId) {
          writeManagedState(paths, { ...state, transitionId: '' });
        }
        transaction = completeUpdateTransactionAndArchiveBarrier(
          paths, transaction.transactionId, transaction.revision
        );
        log('info', 'Completed a durable online Remote Connector promotion.', {
          transactionId: transaction.transactionId,
          version: transaction.candidate.version,
          sequence: transaction.candidate.sequence
        });
        return;
      }
      if (transaction.phase === 'rollback_requested') {
        throw new Error('Rollback recovery is pending Guardian coordination.');
      }
      throw new Error(`Unsupported update transaction phase: ${transaction.phase}`);
    }
  } finally {
    transitioning = false;
  }
}

async function rollbackUpdateTransaction(initial: ConnectorUpdateTransaction, failure: unknown): Promise<void> {
  let transaction = readUpdateTransaction(paths) ?? initial;
  const message = failure instanceof Error ? failure.message.slice(0, 500) : 'candidate transition failed';
  if (['completed', 'rolled_back'].includes(transaction.phase)) return;
  const barrier = readRollbackBarrier(paths);
  if (barrier?.transactionId === transaction.transactionId) {
    throw new Error('Automatic rollback is forbidden after the durable candidate business-admission barrier.');
  }
  if (!['worker_a_quiesced', 'supervisor_switch_requested', 'supervisor_acknowledged',
    'worker_b_probation', 'promotion_prepared', 'promoted', 'rollback_requested'].includes(transaction.phase)) {
    throw failure;
  }
  if (transaction.phase !== 'rollback_requested') {
    transaction = transactionCas(transaction, { phase: 'rollback_requested', error: message });
    if (FAULT_TEST_ROLLBACK_HOLD_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, FAULT_TEST_ROLLBACK_HOLD_MS));
    }
  }
  transitioning = true;
  try {
    let rollbackWorkerBState = transaction.workerB ? workerBirthState(transaction.workerB) : 'absent';
    if (rollbackWorkerBState === 'alive_unknown') {
      throw new Error('Rollback Worker B birth identity is unknown; retirement is fail-closed.');
    }
    if (transaction.workerB && rollbackWorkerBState === 'alive_match') {
      publishWorkerMaintenance(transaction, transaction.workerB, 'retire');
      await waitForMaintenanceAck(transaction, transaction.workerB, 'retiring', 30_000);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && workerBirthState(transaction.workerB) === 'alive_match') {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      rollbackWorkerBState = workerBirthState(transaction.workerB);
      if (rollbackWorkerBState === 'alive_match' || rollbackWorkerBState === 'alive_unknown') {
        throw new Error('Candidate Worker could not be retired with a provable birth transition before rollback.');
      }
    }
    // The candidate was durably sealed and confirmed exited above. Re-read the
    // strict barrier after that linearization point to close the race with its
    // first business dispatch.
    const sealedBarrier = readRollbackBarrier(paths);
    if (sealedBarrier?.transactionId === transaction.transactionId) {
      throw new Error('Automatic rollback is forbidden after the durable candidate business-admission barrier.');
    }
    let bootstrap = readBootstrapState(paths);
    if (bootstrap.pending?.transactionId === transaction.transactionId) {
      bootstrap = casBootstrapState(paths, bootstrap.revision, (current) => ({ ...current, pending: null }));
    }
    if (bootstrap.active.version === transaction.candidate.supervisorVersion
      && bootstrap.previous?.version === transaction.current.supervisorVersion) {
      const now = new Date();
      writeGuardianRequest(paths, {
        schemaVersion: 'omnia.v5.remote-connector-guardian-request/v1',
        transactionId: transaction.transactionId,
        requestId: deterministicGuardianRequestId(transaction.transactionId, 'rollback_previous'),
        revision: bootstrap.revision,
        action: 'rollback_previous',
        expectedActiveVersion: bootstrap.active.version,
        expectedPendingVersion: bootstrap.previous.version,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
      });
      // Guardian will terminate this Supervisor. A restarted previous
      // Supervisor resumes the same rollback_requested transaction.
      for (;;) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (bootstrap.active.version !== transaction.current.supervisorVersion) {
      throw new Error('Guardian rollback did not restore the previous Supervisor identity.');
    }
    const reusableWorkerA = transaction.workerA
      && workerPidBelongsToIdentity(transaction.workerA)
      && workerStatusMatches(readWorkerStatus(transaction.workerA), transaction.workerA, {
        quiesced: true, epoch: transaction.maintenanceEpoch
      });
    if (!reusableWorkerA) {
      await startWorker(transaction.current.version, transaction.maintenanceEpoch, transaction.transactionId);
      if (!workerIdentity || workerIdentity.version !== transaction.current.version
        || workerIdentity.sequence !== transaction.current.sequence) {
        throw new Error('Replacement Worker A lacks its exact rollback identity.');
      }
      transaction = transactionCas(transaction, { workerA: workerIdentity });
      await waitForWorkerState(transaction.workerA!, {
        probation: true, epoch: transaction.maintenanceEpoch
      });
      const rollbackClaim = readWorkerClaim(paths);
      if (!rollbackClaim || rollbackClaim.pid !== transaction.workerA!.pid
        || rollbackClaim.executionGeneration !== transaction.workerA!.token
        || rollbackClaim.state !== 'admitted') {
        throw new Error('Replacement Worker A did not hold the exact global claim during rollback probation.');
      }
    }
    const rollbackWorkerA = transaction.workerA;
    if (!rollbackWorkerA) throw new Error('Rollback Worker A identity was not persisted.');
    workerIdentity = rollbackWorkerA;
    publishWorkerMaintenance(transaction, rollbackWorkerA, 'resume');
    await waitForMaintenanceAck(transaction, rollbackWorkerA, 'running');
    await waitForWorkerState(rollbackWorkerA, { running: true, epoch: transaction.maintenanceEpoch });
    const state = readManagedState(paths);
    const rollbackAlreadyPublished = state.transitionId === '' && state.current === transaction.current.version
      && state.pending === null && state.blocked[transaction.candidate.version]?.sequence === transaction.candidate.sequence;
    if (!rollbackAlreadyPublished && state.transitionId !== transaction.transactionId) {
      throw new Error('Managed release transaction identity drifted during rollback.');
    }
    if (!rollbackAlreadyPublished) {
      writeManagedState(paths, {
        ...state,
        current: transaction.current.version,
        previous: '',
        pending: null,
        transitionId: '',
        highestSequence: Math.max(state.highestSequence, transaction.candidate.sequence),
        blocked: {
          ...state.blocked,
          [transaction.candidate.version]: {
            sequence: transaction.candidate.sequence,
            reason: message || 'candidate transition failed',
            blockedAt: new Date().toISOString()
          }
        }
      });
    }
    const liveMaintenance = readWorkerMaintenance(paths);
    if (liveMaintenance) {
      archiveWorkerMaintenance(paths, transaction.transactionId,
        transaction.maintenanceAuthorityToken, liveMaintenance.revision);
    } else if (!workerMaintenanceWasArchived(transaction)) {
      throw new Error('Rollback Worker maintenance archive is missing.');
    }
    const restoredBootstrap = readBootstrapState(paths);
    if (restoredBootstrap.previous) {
      casBootstrapState(paths, restoredBootstrap.revision, (current) => ({ ...current, previous: null }));
    }
    transaction = transactionCas(transaction, { phase: 'rolled_back', error: message });
    log('warn', 'Rolled back a failed online Remote Connector candidate.', {
      transactionId: transaction.transactionId,
      candidate: transaction.candidate.version,
      restored: transaction.current.version,
      error: message
    });
  } finally {
    transitioning = false;
  }
}

async function advanceOrRollback(transaction: ConnectorUpdateTransaction): Promise<void> {
  try {
    await advanceUpdateTransaction(transaction);
  } catch (error) {
    const authoritative = readUpdateTransaction(paths) ?? transaction;
    await rollbackUpdateTransaction(authoritative, error);
  }
}

async function checkForUpdate(signal?: AbortSignal): Promise<void> {
  let state = readManagedState(paths);
  const activeTransaction = readUpdateTransaction(paths);
  if (activeTransaction && !['completed', 'rolled_back'].includes(activeTransaction.phase)) {
    await advanceOrRollback(activeTransaction);
    return;
  }
  if (state.pending) throw new Error('Managed pending release has no active durable update transaction.');
  const manifest = await fetchUpdateManifest(signal);
  if (compareVersions(REMOTE_CONNECTOR_SUPERVISOR_VERSION, manifest.minimumSupervisorVersion) < 0) {
    throw new Error('v5 Remote Connector Supervisor is below the signed minimum version; a new bootstrap is required.');
  }
  if (
    manifest.version === state.current
    && manifest.sequence >= state.highestSequence
  ) {
    writeManagedState(paths, { ...state, highestSequence: manifest.sequence });
    return;
  }
  assertUpdateSequenceAdmitted(manifest, state);
  const archive = await downloadRelease(manifest, signal);
  try {
    await extractRelease(manifest, archive, signal);
  } finally {
    fs.rmSync(archive, { force: true });
  }
  signal?.throwIfAborted();
  const candidateRoot = verifiedPortableVersion(manifest.version);
  const candidateSupervisorVersion = readCandidatePackageSupervisorVersion(candidateRoot);
  healthProbe(candidateRoot, manifest.version, manifest.sequence, candidateSupervisorVersion);
  const currentPortable = verifyPortableRoot(verifiedPortableVersion(state.current));
  let transaction = createUpdateTransaction(
    paths,
    {
      version: state.current,
      sequence: currentPortable.sequence,
      supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION
    },
    {
      version: manifest.version,
      sequence: manifest.sequence,
      supervisorVersion: candidateSupervisorVersion
    }
  );
  state = bindManagedPending(transaction);
  log('info', 'Staged a signed v5 Remote Connector update into the durable online transaction.', {
    current: state.current,
    pending: manifest.version,
    sequence: manifest.sequence
  });
  transaction = readUpdateTransaction(paths) ?? transaction;
  await advanceOrRollback(transaction);
}

function startAutomaticUpdateCheck(): void {
  if (automaticUpdateTask || stopping) return;
  const controller = new AbortController();
  automaticUpdateAbort = controller;
  let task!: Promise<void>;
  task = (async () => {
    try {
      await checkForUpdate(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        log('warn', 'v5 Remote Connector automatic update check failed safely.', {
          error: error instanceof Error ? error.message : 'unknown update error'
        });
      }
    } finally {
      if (automaticUpdateTask === task) automaticUpdateTask = null;
      if (automaticUpdateAbort === controller) automaticUpdateAbort = null;
    }
  })();
  automaticUpdateTask = task;
}

async function stopAutomaticUpdateCheck(): Promise<void> {
  const task = automaticUpdateTask;
  automaticUpdateAbort?.abort();
  if (task) await task;
}

async function shutdown(stopOwnedWorker = true): Promise<void> {
  if (stopping) return;
  stopping = true;
  transitioning = true;
  if (stopOwnedWorker) await stopAutomaticUpdateCheck();
  else automaticUpdateAbort?.abort();
  if (lockHeartbeatTimer) clearInterval(lockHeartbeatTimer);
  lockHeartbeatTimer = null;
  if (stopOwnedWorker) await stopWorker();
  else abandonWorkerForOwnerLoss();
  releaseLock();
}

function preserveQuiescedWorkerForGuardianHandoff(): boolean {
  try {
    const transaction = readUpdateTransaction(paths);
    const maintenance = readWorkerMaintenance(paths);
    return Boolean(transaction && maintenance && transaction.workerA && workerIdentity
      && ['worker_a_quiesced', 'supervisor_switch_requested'].includes(transaction.phase)
      && transaction.workerA.pid === workerIdentity.pid && transaction.workerA.token === workerIdentity.token
      && maintenance.transactionId === transaction.transactionId
      && maintenance.target.pid === transaction.workerA.pid
      && maintenance.target.token === transaction.workerA.token
      && maintenance.acknowledgement?.state === 'quiesced'
      && maintenance.acknowledgement.admissionClosed
      && maintenance.acknowledgement.admissionSealed);
  } catch {
    return false;
  }
}

async function heartbeatTick(): Promise<void> {
  if (heartbeatTickRunning || stopping) return;
  heartbeatTickRunning = true;
  try {
    if (!await publishHeartbeat()) {
      try { log('error', 'Supervisor ownership token was replaced; stopping the fenced process.'); } catch { /* best effort */ }
      await shutdown(!guardianLeaseIsLive());
      process.exitCode = 1;
      return;
    }
    heartbeatFailureSince = 0;
  } catch (error) {
    const now = Date.now();
    if (!heartbeatFailureSince) {
      heartbeatFailureSince = now;
      try {
        log('warn', 'Supervisor heartbeat write is temporarily unavailable; retrying within the lease.', {
          error: error instanceof Error ? error.message : 'unknown heartbeat error'
        });
      } catch { /* best effort */ }
    }
    if (now - heartbeatFailureSince >= SUPERVISOR_HEARTBEAT_STALE_MS) {
      try {
        log('error', 'Supervisor heartbeat could not be persisted for an entire lease; stopping safely.', {
          error: error instanceof Error ? error.message : 'unknown heartbeat error'
        });
      } catch { /* shutdown must still proceed when logging storage is unavailable */ }
      await shutdown(false);
      process.exitCode = 1;
    }
  } finally {
    heartbeatTickRunning = false;
  }
}

async function main(): Promise<void> {
  if (!supervisorProcessStartedAt
    || !Number.isSafeInteger(guardianPid) || guardianPid <= 0 || guardianToken.length < 24
    || !Number.isSafeInteger(bootstrapRevision) || bootstrapRevision < 0
    || !['a', 'b'].includes(supervisorSlot) || !/^[a-f0-9]{64}$/u.test(supervisorSha256)
    || (updateTransactionId !== '' && !/^[a-f0-9]{48}$/u.test(updateTransactionId))
    || !guardianLeaseIsLive()) {
    throw new Error('Supervisor requires an exact live Guardian bootstrap lease.');
  }
  if (!await acquireLock()) {
    if (once) fs.writeFileSync(paths.updateRequest, new Date().toISOString(), { mode: 0o600 });
    return;
  }
  // Guardian takeover acknowledgement is the exact no-Worker heartbeat
  // published by acquireLock. Renew it while transaction recovery runs; Worker
  // admission remains closed because no Worker has been started yet.
  lockHeartbeatTimer = setInterval(() => { void heartbeatTick(); }, SUPERVISOR_HEARTBEAT_INTERVAL_MS);
  lockHeartbeatTimer.unref();
  if (once) {
    try {
      await checkForUpdate();
    } catch (error) {
      log('warn', 'v5 Remote Connector one-shot update check failed safely.', {
        error: error instanceof Error ? error.message : 'unknown update error'
      });
    }
    await shutdown(false);
    return;
  }
  fs.rmSync(paths.stopRequest, { force: true });
  preserveLegacyManagedStreamEvidenceBeforeWorkerStart();
  const durableTransaction = readUpdateTransaction(paths);
  if (durableTransaction && !['completed', 'rolled_back'].includes(durableTransaction.phase)) {
    if (updateTransactionId && updateTransactionId !== durableTransaction.transactionId) {
      throw new Error('Supervisor Guardian lease is bound to another update transaction.');
    }
    await advanceOrRollback(durableTransaction);
  }
  const initialState = readManagedState(paths);
  if (initialState.pending && !durableTransaction) {
    try {
      await activatePendingBeforeWorkerStart(initialState);
    } catch (error) {
      log('warn', 'Cold-start activation failed; restored the previous v5 Remote Connector Worker.', {
        error: error instanceof Error ? error.message : 'unknown activation error'
      });
    }
  }
  if (!worker && !workerIdentity) {
    const terminal = readUpdateTransaction(paths);
    if (terminal?.phase === 'completed' && terminal.workerB
      && terminal.candidate.version === readManagedState(paths).current
      && workerPidBelongsToIdentity(terminal.workerB)
      && workerStatusMatches(readWorkerStatus(terminal.workerB), terminal.workerB, { running: true })) {
      workerIdentity = terminal.workerB;
    } else {
      await startWorker();
    }
  }
  if (!await publishHeartbeat()) throw new Error('Supervisor lost its ownership token before worker startup completed.');
  let nextUpdateAt = 0;
  do {
    if (fs.existsSync(paths.stopRequest)) break;
    const requested = fs.existsSync(paths.updateRequest);
    if (!automaticUpdateTask && (requested || Date.now() >= nextUpdateAt)) {
      if (requested) fs.rmSync(paths.updateRequest, { force: true });
      nextUpdateAt = Date.now() + REMOTE_CONNECTOR_UPDATE_INTERVAL_MS;
      startAutomaticUpdateCheck();
    }
    if (worker) {
      const status = readWorkerStatus(workerIdentity ?? undefined);
      const now = Date.now();
      const watchdog = workerHeartbeatRecoveryDecision({
        expectedPid: Number(worker.pid || 0),
        statusPid: Number(status?.pid || 0),
        heartbeatAt: String(status?.heartbeatAt || ''),
        workerStartedAt,
        staleSince: workerHeartbeatStaleSince,
        loopGapMs: lastWorkerWatchdogAt ? now - lastWorkerWatchdogAt : 0,
        now,
        startupGraceMs: WORKER_STATUS_STARTUP_GRACE_MS,
        heartbeatFreshMs: WORKER_STATUS_HEARTBEAT_FRESH_MS,
        recoveryDelayMs: WORKER_STATUS_RECOVERY_DELAY_MS
      });
      lastWorkerWatchdogAt = now;
      workerHeartbeatStaleSince = watchdog.staleSince;
      if (watchdog.fresh) {
        workerRestartFailures = 0;
        nextWorkerStartAt = 0;
      } else if (watchdog.recover && !transitioning && !stopping) {
        const stalePid = Number(worker.pid || 0);
        log('warn', 'Remote Connector Worker heartbeat remained stale; Supervisor is recovering the owned Worker.', {
          version: readManagedState(paths).current,
          pid: stalePid,
          staleForMs: now - watchdog.staleSince
        });
        transitioning = true;
        try {
          await stopWorker();
        } finally {
          transitioning = false;
        }
        if (!stopping) await startWorker();
      }
    } else if (workerIdentity) {
      const adoptedStatus = readWorkerStatus(workerIdentity);
      const heartbeatAge = Date.now() - Date.parse(String(adoptedStatus?.heartbeatAt || ''));
      if (!processIsAlive(workerIdentity.pid)
        || !workerStatusMatches(adoptedStatus, workerIdentity)
        || !Number.isFinite(heartbeatAge) || heartbeatAge > WORKER_STATUS_RECOVERY_DELAY_MS) {
        transitioning = true;
        try { await stopWorker(); } finally { transitioning = false; }
      }
    } else if (!transitioning && !stopping && Date.now() >= nextWorkerStartAt) {
      await startWorker();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (!stopping);
  await shutdown();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    const preserveWorker = preserveQuiescedWorkerForGuardianHandoff();
    void shutdown(!preserveWorker).finally(() => process.exit(0));
  });
}

void main().catch((error) => {
  log('error', 'v5 Remote Connector Supervisor stopped after an unrecoverable error.', {
    error: error instanceof Error ? error.message : 'unknown supervisor error'
  });
  void shutdown(false).finally(() => process.exitCode = 1);
});

export const _test = {
  activatePendingBeforeWorkerStart,
  readWorkerStatus
};
