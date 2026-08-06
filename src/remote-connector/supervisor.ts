import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  REMOTE_CONNECTOR_MAX_ARCHIVE_BYTES,
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_SUPERVISOR_VERSION,
  REMOTE_CONNECTOR_UPDATE_INTERVAL_MS,
  REMOTE_CONNECTOR_UPDATE_MANIFEST_URL
} from './constants.js';
import {
  ensureRemoteConnectorDirectories,
  readManagedState,
  resolveRemoteConnectorPaths,
  type ManagedState,
  versionRoot,
  writeManagedState
} from './managed-state.js';
import {
  compareVersions,
  validateUpdateManifest,
  verifyPortableRoot,
  type UpdateManifest
} from './release-contract.js';
import { assertUpdateSequenceAdmitted, workerStatusAllowsActivation } from './update-policy.js';

const paths = resolveRemoteConnectorPaths();
ensureRemoteConnectorDirectories(paths);
const once = process.argv.includes('--once');
let worker: ChildProcess | null = null;
let stopping = false;
let transitioning = false;
let ownsLock = false;
const lockToken = crypto.randomBytes(24).toString('base64url');
let lockHeartbeatTimer: NodeJS.Timeout | null = null;
const SUPERVISOR_HEARTBEAT_INTERVAL_MS = 1_000;
const SUPERVISOR_HEARTBEAT_STALE_MS = 30_000;
const SUPERVISOR_STARTING_GRACE_MS = 10_000;
const SUPERVISOR_RECOVERY_GATE_LEASE_MS = 15_000;
const WORKER_RECOVERY_HANDOFF_WAIT_MS = 20_000;
const WORKER_RECOVERY_HANDOFF_MAX_AGE_MS = 60_000;
let heartbeatFailureSince = 0;
let heartbeatTickRunning = false;
let workerRestartFailures = 0;
let nextWorkerStartAt = 0;

interface SupervisorLock {
  schemaVersion: 'omnia.v5.remote-connector-supervisor-lock/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  pid: number;
  token: string;
  createdAt: string;
}

interface ParsedSupervisorLock extends SupervisorLock {
  legacy: boolean;
}

interface SupervisorHeartbeat {
  schemaVersion: 'omnia.v5.remote-connector-supervisor-heartbeat/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  pid: number;
  token: string;
  supervisorVersion: string;
  workerPid: number;
  heartbeatAt: string;
}

interface WorkerRecoveryHandoff {
  schemaVersion: 'omnia.v5.remote-connector-worker-recovery/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  recoveryId: string;
  ownerPid: number;
  ownerToken: string;
  workerPid: number;
  createdAt: string;
  expiresAt: string;
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
    const legacy = value.schemaVersion === undefined && value.product === undefined;
    if (!legacy && (
      value.schemaVersion !== 'omnia.v5.remote-connector-supervisor-lock/v1'
      || value.product !== REMOTE_CONNECTOR_PRODUCT
    )) return null;
    return {
      schemaVersion: 'omnia.v5.remote-connector-supervisor-lock/v1',
      product: REMOTE_CONNECTOR_PRODUCT,
      pid,
      token: value.token,
      createdAt: String(value.createdAt),
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
      value.schemaVersion !== 'omnia.v5.remote-connector-supervisor-heartbeat/v1'
      || value.product !== REMOTE_CONNECTOR_PRODUCT
      || !Number.isSafeInteger(value.pid)
      || !Number.isSafeInteger(value.workerPid)
      || value.workerPid < 0
      || typeof value.token !== 'string'
      || typeof value.supervisorVersion !== 'string'
      || !Number.isFinite(Date.parse(value.heartbeatAt))
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
    const heartbeat = readHeartbeat();
    if (
      value.schemaVersion !== 'omnia.v5.remote-connector-worker-recovery/v1'
      || value.product !== REMOTE_CONNECTOR_PRODUCT
      || typeof value.recoveryId !== 'string'
      || value.recoveryId.length < 16
      || value.ownerPid !== lock.pid
      || value.ownerToken !== lock.token
      || !Number.isSafeInteger(value.workerPid)
      || value.workerPid <= 0
      || !Number.isFinite(createdAt)
      || !Number.isFinite(expiresAt)
      || createdAt > now + 5_000
      || expiresAt <= now
      || expiresAt - createdAt > WORKER_RECOVERY_HANDOFF_MAX_AGE_MS
      || heartbeat?.pid !== lock.pid
      || heartbeat.token !== lock.token
      || heartbeat.workerPid !== value.workerPid
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

async function waitForRecoveringWorkerExit(lock: ParsedSupervisorLock): Promise<boolean> {
  const handoff = readWorkerRecoveryHandoff(lock);
  if (!handoff) return false;
  const deadline = Math.min(Date.parse(handoff.expiresAt), Date.now() + WORKER_RECOVERY_HANDOFF_WAIT_MS);
  log('info', 'Verified an orphan Worker recovery handoff; waiting for the exiting Worker before takeover.', {
    ownerPid: lock.pid,
    workerPid: handoff.workerPid
  });
  while (Date.now() < deadline) {
    if (!orphanWorkerIsLive(lock)) {
      clearWorkerRecoveryHandoff(handoff.recoveryId);
      log('info', 'Recovery handoff Worker exited; Supervisor takeover may proceed.', {
        ownerPid: lock.pid,
        workerPid: handoff.workerPid
      });
      return true;
    }
    if (readWorkerRecoveryHandoff(lock)?.recoveryId !== handoff.recoveryId) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!orphanWorkerIsLive(lock)) {
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
  return Boolean(current && current.pid === process.pid && current.token === lockToken);
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
  if (!ownsCurrentLock()) return false;
  await writeHeartbeatAtomic({
    schemaVersion: 'omnia.v5.remote-connector-supervisor-heartbeat/v1',
    product: REMOTE_CONNECTOR_PRODUCT,
    pid: process.pid,
    token: lockToken,
    supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
    workerPid: Number(worker?.pid || 0),
    heartbeatAt: new Date().toISOString()
  } satisfies SupervisorHeartbeat);
  return ownsCurrentLock();
}

function pidWasReused(lock: { pid: number; createdAt: string }): boolean {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${lock.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
  ], { windowsHide: true, encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return false;
  const processStartedAt = Date.parse(String(result.stdout || '').trim());
  const lockCreatedAt = Date.parse(lock.createdAt);
  return Number.isFinite(processStartedAt)
    && Number.isFinite(lockCreatedAt)
    && processStartedAt > lockCreatedAt + 5_000;
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
        schemaVersion: 'omnia.v5.remote-connector-supervisor-lock/v1',
        product: REMOTE_CONNECTOR_PRODUCT,
        pid: process.pid,
        token: lockToken,
        createdAt: new Date().toISOString()
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
    if (observed && lockOwnerIsLive(observed)) {
      fs.writeFileSync(paths.stopRequest, new Date().toISOString(), { encoding: 'utf8', mode: 0o600 });
      log('error', 'Stale Supervisor heartbeat still belongs to a live PID; requested stop and refused dual startup.', {
        ownerPid: observed.pid,
        legacy: observed.legacy
      });
      return false;
    }
    if (observed && orphanWorkerIsLive(observed)) {
      if (!await waitForRecoveringWorkerExit(observed)) {
        log('error', 'Supervisor exited without proving that its Worker stopped; refusing an unsafe replacement.', {
          ownerPid: observed.pid,
          workerPid: readHeartbeat()?.workerPid
        });
        return false;
      }
      const confirmed = readLock();
      if (!confirmed || confirmed.pid !== observed.pid || confirmed.token !== observed.token) return false;
    }
    if (observed) {
      const completedHandoff = readWorkerRecoveryHandoff(observed);
      if (completedHandoff && !orphanWorkerIsLive(observed)) {
        clearWorkerRecoveryHandoff(completedHandoff.recoveryId);
        log('info', 'Accepted a completed Worker recovery handoff.', {
          ownerPid: observed.pid,
          workerPid: completedHandoff.workerPid
        });
      }
    }
    if (!ownsRecoveryGate()) return false;
    fs.rmSync(paths.supervisorLock, { force: true });
    try {
      publish();
      await publishHeartbeat();
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

function currentPortable(state = readManagedState(paths)): string {
  if (!state.current) throw new Error('v5 Remote Connector is not installed.');
  const root = versionRoot(paths, state.current);
  const manifest = verifyPortableRoot(root);
  if (manifest.version !== state.current) throw new Error('Managed current version does not match its signed portable manifest.');
  return root;
}

function startWorker(): ChildProcess {
  const state = readManagedState(paths);
  const root = currentPortable(state);
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
        OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_TOKEN: lockToken
      }
    }
  );
  worker = child;
  let failureRecorded = false;
  const recordFailureBackoff = () => {
    if (failureRecorded || stopping || transitioning) return;
    failureRecorded = true;
    workerRestartFailures = Math.min(workerRestartFailures + 1, 6);
    nextWorkerStartAt = Date.now() + Math.min(30_000, 1_000 * (2 ** (workerRestartFailures - 1)));
  };
  child.once('exit', (code, signal) => {
    if (worker === child) worker = null;
    if (!stopping && !transitioning) {
      recordFailureBackoff();
      log('warn', 'Versioned Remote Connector worker exited; Supervisor will restart it.', {
        version: state.current,
        code,
        signal
      });
    }
  });
  child.once('error', (error) => {
    if (worker === child) worker = null;
    recordFailureBackoff();
    log('error', 'Versioned Remote Connector worker failed to start.', {
      version: state.current,
      error: error.message
    });
  });
  return child;
}

async function stopWorker(): Promise<void> {
  const child = worker;
  worker = null;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exitedAfterTerminate = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  if (exitedAfterTerminate || child.exitCode !== null) return;
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
}

function readWorkerStatus(): Record<string, unknown> | null {
  try {
    const status = JSON.parse(fs.readFileSync(paths.status, 'utf8')) as Record<string, unknown>;
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

function safeWindowAvailable(): boolean {
  return workerStatusAllowsActivation(readWorkerStatus(), REMOTE_CONNECTOR_PRODUCT);
}

async function fetchUpdateManifest(): Promise<UpdateManifest> {
  const response = await fetch(REMOTE_CONNECTOR_UPDATE_MANIFEST_URL, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`v5 Remote Connector update manifest returned HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 128 * 1024) throw new Error('v5 Remote Connector update manifest is too large.');
  const text = await response.text();
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('v5 Remote Connector update manifest is too large.');
  return validateUpdateManifest(JSON.parse(text));
}

async function downloadRelease(manifest: UpdateManifest): Promise<string> {
  if (manifest.size > REMOTE_CONNECTOR_MAX_ARCHIVE_BYTES) {
    throw new Error('v5 Remote Connector update exceeds the signed package size limit.');
  }
  const finalPath = path.join(paths.updates, `v5-remote-connector-${manifest.version}-${manifest.sequence}.zip`);
  const temporaryPath = `${finalPath}.${process.pid}.partial`;
  const response = await fetch(manifest.url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(30 * 60_000)
  });
  if (!response.ok || !response.body) throw new Error(`v5 Remote Connector update download returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength !== manifest.size) {
    throw new Error('v5 Remote Connector update Content-Length differs from the signed size.');
  }
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(temporaryPath, 'wx', 0o600);
  let received = 0;
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
    fs.rmSync(temporaryPath, { force: true });
    throw new Error('v5 Remote Connector update archive failed size or SHA-256 verification.');
  }
  fs.renameSync(temporaryPath, finalPath);
  return finalPath;
}

function extractRelease(manifest: UpdateManifest, archivePath: string): string {
  const extraction = path.join(paths.updates, `extract-${manifest.version}-${manifest.sequence}`);
  fs.rmSync(extraction, { recursive: true, force: true });
  fs.mkdirSync(extraction, { recursive: true, mode: 0o700 });
  const result = spawnSync(
    'tar.exe',
    ['-xf', archivePath, '-C', extraction],
    {
      windowsHide: true,
      encoding: 'utf8'
    }
  );
  if (result.status !== 0) {
    throw new Error(`v5 Remote Connector update extraction failed: ${String(result.stderr || result.stdout).slice(0, 500)}`);
  }
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

function healthProbe(root: string, expectedVersion: string): void {
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
  if (status.ok !== true || status.product !== REMOTE_CONNECTOR_PRODUCT || status.version !== expectedVersion) {
    throw new Error('v5 Remote Connector candidate health identity is invalid.');
  }
}

async function probation(expectedVersion: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 7_000;
  let firstHealthyAt = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('v5 Remote Connector candidate exited during probation.');
    const status = readWorkerStatus();
    const healthy = status?.version === expectedVersion
      && Date.now() - Date.parse(String(status.heartbeatAt || '')) < 4_000;
    if (healthy && !firstHealthyAt) firstHealthyAt = Date.now();
    if (healthy && Date.now() - firstHealthyAt >= 3_000) return;
    if (!healthy) firstHealthyAt = 0;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('v5 Remote Connector candidate did not remain healthy throughout probation.');
}

async function activatePending(state: ManagedState): Promise<ManagedState> {
  const pending = state.pending;
  if (!pending || !safeWindowAvailable()) return state;
  const oldCurrent = state.current;
  const oldPrevious = state.previous;
  const candidateRoot = versionRoot(paths, pending.version);
  healthProbe(candidateRoot, pending.version);
  transitioning = true;
  await stopWorker();
  let candidate: ChildProcess | null = null;
  try {
    state = writeManagedState(paths, {
      ...state,
      current: pending.version,
      previous: oldCurrent,
      highestSequence: Math.max(state.highestSequence, pending.sequence),
      pending: null
    });
    candidate = startWorker();
    await probation(pending.version, candidate);
    log('info', 'Promoted a signed v5 Remote Connector candidate.', {
      previous: oldCurrent,
      current: pending.version,
      sequence: pending.sequence
    });
    return state;
  } catch (error) {
    if (candidate && candidate.exitCode === null) candidate.kill('SIGTERM');
    state = writeManagedState(paths, {
      ...state,
      current: oldCurrent,
      previous: oldPrevious,
      highestSequence: Math.max(state.highestSequence, pending.sequence),
      pending: null,
      blocked: {
        ...state.blocked,
        [pending.version]: {
          sequence: pending.sequence,
          reason: error instanceof Error ? error.message.slice(0, 500) : 'candidate probation failed',
          blockedAt: new Date().toISOString()
        }
      }
    });
    startWorker();
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

async function checkForUpdate(): Promise<void> {
  let state = readManagedState(paths);
  if (state.pending) {
    state = await activatePending(state);
    if (state.pending) return;
  }
  const manifest = await fetchUpdateManifest();
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
  const archive = await downloadRelease(manifest);
  try {
    extractRelease(manifest, archive);
  } finally {
    fs.rmSync(archive, { force: true });
  }
  state = writeManagedState(paths, {
    ...state,
    pending: {
      version: manifest.version,
      sequence: manifest.sequence,
      stagedAt: new Date().toISOString()
    }
  });
  await activatePending(state);
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  transitioning = true;
  if (lockHeartbeatTimer) clearInterval(lockHeartbeatTimer);
  lockHeartbeatTimer = null;
  await stopWorker();
  releaseLock();
}

async function heartbeatTick(): Promise<void> {
  if (heartbeatTickRunning || stopping) return;
  heartbeatTickRunning = true;
  try {
    if (!await publishHeartbeat()) {
      try { log('error', 'Supervisor ownership token was replaced; stopping the fenced process.'); } catch { /* best effort */ }
      await shutdown();
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
      await shutdown();
      process.exitCode = 1;
    }
  } finally {
    heartbeatTickRunning = false;
  }
}

async function main(): Promise<void> {
  if (!await acquireLock()) {
    if (once) fs.writeFileSync(paths.updateRequest, new Date().toISOString(), { mode: 0o600 });
    return;
  }
  fs.rmSync(paths.stopRequest, { force: true });
  startWorker();
  if (!await publishHeartbeat()) throw new Error('Supervisor lost its ownership token before worker startup completed.');
  lockHeartbeatTimer = setInterval(() => { void heartbeatTick(); }, SUPERVISOR_HEARTBEAT_INTERVAL_MS);
  lockHeartbeatTimer.unref();
  let nextUpdateAt = 0;
  do {
    if (fs.existsSync(paths.stopRequest)) break;
    const requested = fs.existsSync(paths.updateRequest);
    if (requested) fs.rmSync(paths.updateRequest, { force: true });
    if (requested || Date.now() >= nextUpdateAt) {
      try {
        await checkForUpdate();
      } catch (error) {
        log('warn', 'v5 Remote Connector automatic update check failed safely.', {
          error: error instanceof Error ? error.message : 'unknown update error'
        });
      }
      nextUpdateAt = Date.now() + REMOTE_CONNECTOR_UPDATE_INTERVAL_MS;
      if (once) break;
    }
    if (worker) {
      const status = readWorkerStatus();
      if (
        Number(status?.pid || 0) === Number(worker.pid || 0)
        && Date.now() - Date.parse(String(status?.heartbeatAt || '')) < 5_000
      ) {
        workerRestartFailures = 0;
        nextWorkerStartAt = 0;
      }
    } else if (!transitioning && !stopping && Date.now() >= nextWorkerStartAt) {
      startWorker();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (!stopping);
  await shutdown();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
}

void main().catch((error) => {
  log('error', 'v5 Remote Connector Supervisor stopped after an unrecoverable error.', {
    error: error instanceof Error ? error.message : 'unknown supervisor error'
  });
  void shutdown().finally(() => process.exitCode = 1);
});

export const _test = {
  safeWindowAvailable,
  readWorkerStatus
};
