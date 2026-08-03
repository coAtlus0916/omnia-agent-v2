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

function log(level: 'info' | 'warn' | 'error', message: string, detail: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    level,
    product: REMOTE_CONNECTOR_PRODUCT,
    message,
    ...detail
  });
  fs.appendFileSync(path.join(paths.logs, 'supervisor.jsonl'), `${entry}\n`, { encoding: 'utf8', mode: 0o600 });
}

function acquireLock(): boolean {
  const publish = () => {
    const handle = fs.openSync(paths.supervisorLock, 'wx', 0o600);
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token: lockToken, createdAt: new Date().toISOString() }));
    fs.closeSync(handle);
    ownsLock = true;
  };
  try {
    publish();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let pid = 0;
  try { pid = Number(JSON.parse(fs.readFileSync(paths.supervisorLock, 'utf8')).pid); } catch { /* stale */ }
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch { /* stale */ }
  }
  fs.rmSync(paths.supervisorLock, { force: true });
  publish();
  return true;
}

function releaseLock(): void {
  if (!ownsLock) return;
  try {
    const current = JSON.parse(fs.readFileSync(paths.supervisorLock, 'utf8')) as { token?: string };
    if (current.token === lockToken) fs.rmSync(paths.supervisorLock, { force: true });
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
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: paths.installRoot,
        OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: paths.dataRoot
      }
    }
  );
  worker = child;
  child.once('exit', (code, signal) => {
    if (worker === child) worker = null;
    if (!stopping && !transitioning) {
      log('warn', 'Versioned Remote Connector worker exited; Supervisor will restart it.', {
        version: state.current,
        code,
        signal
      });
    }
  });
  child.once('error', (error) => {
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
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
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
  await stopWorker();
  releaseLock();
}

async function main(): Promise<void> {
  if (!acquireLock()) {
    if (once) fs.writeFileSync(paths.updateRequest, new Date().toISOString(), { mode: 0o600 });
    return;
  }
  fs.rmSync(paths.stopRequest, { force: true });
  startWorker();
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
    if (!worker && !transitioning && !stopping) startWorker();
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
