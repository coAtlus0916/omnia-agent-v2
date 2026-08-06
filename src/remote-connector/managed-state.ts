import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  REMOTE_CONNECTOR_DATA_DIRECTORY,
  REMOTE_CONNECTOR_INSTALL_DIRECTORY,
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_SUPERVISOR_VERSION
} from './constants.js';
import { compareVersions, sha256File, verifyPortableRoot } from './release-contract.js';

export interface PendingUpdate {
  version: string;
  sequence: number;
  stagedAt: string;
}

export interface ManagedState {
  schemaVersion: 'omnia.v5.remote-connector-managed/v1';
  current: string;
  previous: string;
  highestSequence: number;
  pending: PendingUpdate | null;
  blocked: Record<string, { sequence: number; reason: string; blockedAt: string }>;
  updatedAt: string;
}

export interface RemoteConnectorPaths {
  installRoot: string;
  versions: string;
  bootstrap: string;
  bootstrapLock: string;
  managedStart: string;
  startupEntry: string;
  updates: string;
  dataRoot: string;
  state: string;
  status: string;
  supervisorLock: string;
  supervisorHeartbeat: string;
  supervisorRecoveryLock: string;
  workerRecoveryHandoff: string;
  stopRequest: string;
  updateRequest: string;
  logs: string;
}

interface BootstrapMarker {
  schemaVersion: 'omnia.v5.remote-connector-bootstrap/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  supervisorVersion: string;
  supervisorSha256: string;
  installedAt: string;
}

export interface BootstrapMigrationResult {
  state: 'already_current' | 'migrated' | 'newer_preserved';
  supervisorVersion: string;
  at: string;
}

function requiredEnvironmentPath(name: 'LOCALAPPDATA' | 'APPDATA'): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is unavailable; cannot resolve the isolated v5 Remote Connector root.`);
  return value;
}

export function resolveRemoteConnectorPaths(overrides: {
  installRoot?: string;
  dataRoot?: string;
  startupEntry?: string;
} = {}): RemoteConnectorPaths {
  const installRoot = path.resolve(
    overrides.installRoot
      || process.env.OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT
      || path.join(requiredEnvironmentPath('LOCALAPPDATA'), REMOTE_CONNECTOR_INSTALL_DIRECTORY)
  );
  const dataRoot = path.resolve(
    overrides.dataRoot
      || process.env.OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT
      || path.join(requiredEnvironmentPath('APPDATA'), REMOTE_CONNECTOR_DATA_DIRECTORY)
  );
  const legacyRoot = path.resolve(requiredEnvironmentPath('LOCALAPPDATA'), 'OmniaAgentConnector');
  const legacyData = path.resolve(requiredEnvironmentPath('APPDATA'), 'OmniaAgentConnector');
  if (installRoot === legacyRoot || dataRoot === legacyData) {
    throw new Error('v5 Remote Connector refuses to use the v4 Connector install or data root.');
  }
  return {
    installRoot,
    versions: path.join(installRoot, 'versions'),
    bootstrap: path.join(installRoot, 'bootstrap'),
    bootstrapLock: path.join(installRoot, 'bootstrap-update.lock'),
    managedStart: path.join(installRoot, 'StartManagedRemoteConnector.cmd'),
    startupEntry: path.resolve(
      overrides.startupEntry
        || process.env.OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY
        || path.join(
          requiredEnvironmentPath('APPDATA'),
          'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
          'Omnia Agent v5 Remote Connector.cmd'
        )
    ),
    updates: path.join(installRoot, 'updates'),
    dataRoot,
    state: path.join(dataRoot, 'managed-state.json'),
    status: path.join(dataRoot, 'status.json'),
    supervisorLock: path.join(dataRoot, 'supervisor.lock'),
    supervisorHeartbeat: path.join(dataRoot, 'supervisor-heartbeat.json'),
    supervisorRecoveryLock: path.join(dataRoot, 'supervisor-recovery.lock'),
    workerRecoveryHandoff: path.join(dataRoot, 'worker-recovery-handoff.json'),
    stopRequest: path.join(dataRoot, 'stop.request'),
    updateRequest: path.join(dataRoot, 'update.request'),
    logs: path.join(dataRoot, 'logs')
  };
}

export function ensureRemoteConnectorDirectories(paths: RemoteConnectorPaths): void {
  for (const directory of [
    paths.installRoot,
    paths.versions,
    paths.bootstrap,
    paths.updates,
    paths.dataRoot,
    paths.logs
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function defaultManagedState(): ManagedState {
  return {
    schemaVersion: 'omnia.v5.remote-connector-managed/v1',
    current: '',
    previous: '',
    highestSequence: 0,
    pending: null,
    blocked: {},
    updatedAt: new Date().toISOString()
  };
}

export function readManagedState(paths: RemoteConnectorPaths): ManagedState {
  try {
    const value = JSON.parse(fs.readFileSync(paths.state, 'utf8')) as ManagedState;
    if (
      value.schemaVersion !== 'omnia.v5.remote-connector-managed/v1'
      || typeof value.current !== 'string'
      || typeof value.previous !== 'string'
      || !Number.isSafeInteger(value.highestSequence)
      || !value.blocked
      || typeof value.blocked !== 'object'
    ) throw new Error('invalid state');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultManagedState();
    throw new Error('v5 Remote Connector managed state is invalid.');
  }
}

export function writeJsonAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function readJsonRecord(filename: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

function readBootstrapMarker(filename: string): BootstrapMarker | null {
  const value = readJsonRecord(filename);
  if (
    value?.schemaVersion !== 'omnia.v5.remote-connector-bootstrap/v1'
    || value.product !== REMOTE_CONNECTOR_PRODUCT
    || typeof value.supervisorVersion !== 'string'
    || typeof value.supervisorSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.supervisorSha256)
    || !Number.isFinite(Date.parse(String(value.installedAt || '')))
  ) return null;
  return value as unknown as BootstrapMarker;
}

function replaceFileAtomic(source: string, destination: string): void {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  try {
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidWasReused(owner: { pid: number; createdAt: string }): boolean {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${owner.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
  ], { windowsHide: true, encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return false;
  const processStartedAt = Date.parse(String(result.stdout || '').trim());
  const ownerCreatedAt = Date.parse(owner.createdAt);
  return Number.isFinite(processStartedAt)
    && Number.isFinite(ownerCreatedAt)
    && processStartedAt > ownerCreatedAt + 5_000;
}

function sleepSync(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ownsBootstrapGate(paths: RemoteConnectorPaths, token: string): boolean {
  return readJsonRecord(paths.bootstrapLock)?.token === token;
}

function releaseBootstrapGate(paths: RemoteConnectorPaths, token: string): void {
  try {
    if (ownsBootstrapGate(paths, token)) fs.rmSync(paths.bootstrapLock, { force: true });
  } catch { /* best effort */ }
}

function activeBootstrapClaims(directory: string): Array<{ token: string; createdAt: number }> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const active: Array<{ token: string; createdAt: number }> = [];
  for (const filename of fs.readdirSync(directory)) {
    const claimPath = path.join(directory, filename);
    const claim = readJsonRecord(claimPath);
    const filenamePid = Number(/^claim-(\d+)-/u.exec(filename)?.[1] || 0);
    const pid = Number(claim?.pid || filenamePid);
    const token = String(claim?.token || filename);
    const createdAtText = String(claim?.createdAt || '');
    const createdAt = Date.parse(createdAtText);
    const ownerLive = processIsAlive(pid)
      && (!Number.isFinite(createdAt) || !pidWasReused({ pid, createdAt: createdAtText }));
    if (ownerLive) {
      active.push({
        token,
        createdAt: Number.isFinite(createdAt) ? createdAt : fs.statSync(claimPath).mtimeMs
      });
    } else {
      fs.rmSync(claimPath, { force: true });
    }
  }
  return active.sort((left, right) => left.createdAt - right.createdAt || left.token.localeCompare(right.token));
}

function bootstrapGateBusyError(): NodeJS.ErrnoException {
  return Object.assign(new Error('Timed out waiting for the Supervisor bootstrap update gate.'), { code: 'EBUSY' });
}

function acquireBootstrapGate(paths: RemoteConnectorPaths, waitMs: number): string {
  const token = crypto.randomBytes(24).toString('base64url');
  const claimsDirectory = `${paths.bootstrapLock}.claims`;
  const claimPath = path.join(claimsDirectory, `claim-${process.pid}-${token}.json`);
  const claimTemporary = `${claimPath}.tmp`;
  const deadline = Date.now() + Math.max(1, waitMs);
  const publishGate = () => {
    const handle = fs.openSync(paths.bootstrapLock, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify({
        pid: process.pid,
        token,
        supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
        createdAt: new Date().toISOString()
      }));
      fs.fsyncSync(handle);
    } catch (error) {
      fs.rmSync(paths.bootstrapLock, { force: true });
      throw error;
    } finally {
      fs.closeSync(handle);
    }
  };
  try {
    while (Date.now() < deadline) {
      const existing = readJsonRecord(paths.bootstrapLock);
      if (!existing && !fs.existsSync(paths.bootstrapLock)) {
        const claims = activeBootstrapClaims(claimsDirectory);
        if (claims.length > 0 && claims[0]?.token !== token) {
          sleepSync(Math.min(100, Math.max(0, deadline - Date.now())));
          continue;
        }
        try {
          publishGate();
          if (claims[0]?.token === token) {
            fs.rmSync(claimPath, { force: true });
            return token;
          }
          sleepSync(Math.min(50, Math.max(0, deadline - Date.now())));
          if (activeBootstrapClaims(claimsDirectory).length === 0 && ownsBootstrapGate(paths, token)) return token;
          releaseBootstrapGate(paths, token);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        continue;
      }

      const existingPid = Number(existing?.pid || 0);
      const existingCreatedAt = String(existing?.createdAt || '');
      if (
        processIsAlive(existingPid)
        && (!Number.isFinite(Date.parse(existingCreatedAt)) || !pidWasReused({ pid: existingPid, createdAt: existingCreatedAt }))
      ) {
        sleepSync(Math.min(100, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (existing && compareVersions(String(existing.supervisorVersion || '0.0.0'), REMOTE_CONNECTOR_SUPERVISOR_VERSION) > 0) {
        throw new Error('A newer Supervisor bootstrap update was interrupted; retry from that newer release.');
      }

      fs.mkdirSync(claimsDirectory, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(claimPath)) {
        const claimHandle = fs.openSync(claimTemporary, 'wx', 0o600);
        try {
          fs.writeFileSync(claimHandle, JSON.stringify({
            pid: process.pid,
            token,
            createdAt: new Date().toISOString()
          }));
          fs.fsyncSync(claimHandle);
        } finally {
          fs.closeSync(claimHandle);
        }
        try { fs.linkSync(claimTemporary, claimPath); } finally { fs.rmSync(claimTemporary, { force: true }); }
        sleepSync(Math.min(100, Math.max(0, deadline - Date.now())));
      }
      const claims = activeBootstrapClaims(claimsDirectory);
      if (claims[0]?.token !== token) {
        sleepSync(Math.min(100, Math.max(0, deadline - Date.now())));
        continue;
      }
      const confirmedGate = readJsonRecord(paths.bootstrapLock);
      if (confirmedGate?.token !== existing?.token) continue;
      fs.rmSync(paths.bootstrapLock, { force: true });
      try {
        publishGate();
        fs.rmSync(claimPath, { force: true });
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      sleepSync(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw bootstrapGateBusyError();
  } finally {
    fs.rmSync(claimTemporary, { force: true });
    fs.rmSync(claimPath, { force: true });
  }
}

/**
 * Migrates the persistent Supervisor from the already verified version package.
 * The running parent has already loaded its script, so replacing the bootstrap
 * only affects the next managed or portable start.
 */
export function migrateSupervisorBootstrap(
  paths: RemoteConnectorPaths,
  versionRootPath: string,
  options: { installRuntime?: boolean; gateWaitMs?: number } = {}
): BootstrapMigrationResult {
  const gateToken = acquireBootstrapGate(paths, options.gateWaitMs ?? 35_000);
  try {
    const runtimeSource = path.join(versionRootPath, 'runtime', 'node.exe');
    const supervisorSource = path.join(versionRootPath, 'app', 'supervisor.cjs');
    const runtimeTarget = path.join(paths.bootstrap, 'node.exe');
    const supervisorTarget = path.join(paths.bootstrap, 'supervisor.cjs');
    const markerTarget = path.join(paths.bootstrap, 'bootstrap.json');
    if (options.installRuntime && !fs.existsSync(runtimeTarget)) {
      fs.copyFileSync(runtimeSource, runtimeTarget, fs.constants.COPYFILE_EXCL);
    }
    const marker = readBootstrapMarker(markerTarget);
    const at = new Date().toISOString();
    if (marker && compareVersions(marker.supervisorVersion, REMOTE_CONNECTOR_SUPERVISOR_VERSION) > 0) {
      if (!fs.existsSync(supervisorTarget) || sha256File(supervisorTarget) !== marker.supervisorSha256) {
        throw new Error('The newer persistent Supervisor does not match its bootstrap marker.');
      }
      return { state: 'newer_preserved', supervisorVersion: marker.supervisorVersion, at };
    }

    const sourceSha256 = sha256File(supervisorSource);
    if (
      marker?.supervisorVersion === REMOTE_CONNECTOR_SUPERVISOR_VERSION
      && marker.supervisorSha256 !== sourceSha256
    ) {
      throw new Error('The verified worker package changed Supervisor bytes without increasing its version.');
    }
    if (
      marker?.supervisorVersion === REMOTE_CONNECTOR_SUPERVISOR_VERSION
      && fs.existsSync(supervisorTarget)
      && sha256File(supervisorTarget) === sourceSha256
    ) {
      return { state: 'already_current', supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION, at };
    }

    if (!ownsBootstrapGate(paths, gateToken)) {
      throw new Error('Lost the bootstrap migration gate before replacing Supervisor.');
    }
    if (!fs.existsSync(supervisorTarget) || sha256File(supervisorTarget) !== sourceSha256) {
      replaceFileAtomic(supervisorSource, supervisorTarget);
    }
    if (!ownsBootstrapGate(paths, gateToken)) {
      throw new Error('Lost the bootstrap migration gate before publishing its marker.');
    }
    writeJsonAtomic(markerTarget, {
      schemaVersion: 'omnia.v5.remote-connector-bootstrap/v1',
      product: REMOTE_CONNECTOR_PRODUCT,
      supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
      supervisorSha256: sourceSha256,
      installedAt: at
    } satisfies BootstrapMarker);
    return { state: 'migrated', supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION, at };
  } finally {
    releaseBootstrapGate(paths, gateToken);
  }
}

export function appendBootstrapMigrationDiagnostic(
  paths: RemoteConnectorPaths,
  value: Record<string, unknown>
): void {
  try {
    fs.appendFileSync(
      path.join(paths.logs, 'bootstrap-migration.jsonl'),
      `${JSON.stringify(value)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch { /* diagnostics must not interrupt the connector */ }
}

export function writeManagedState(paths: RemoteConnectorPaths, input: ManagedState): ManagedState {
  const next = { ...input, updatedAt: new Date().toISOString() };
  writeJsonAtomic(paths.state, next);
  return next;
}

export function versionRoot(paths: RemoteConnectorPaths, version: string): string {
  return path.join(paths.versions, `v${version}`);
}

function cmd(value: string): string {
  return value.replaceAll('%', '%%').replaceAll('"', '""');
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function writeTextAtomic(filename: string, value: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filename);
}

export function ensureManagedLaunchers(paths: RemoteConnectorPaths): void {
  const runtime = path.join(paths.bootstrap, 'node.exe');
  const supervisor = path.join(paths.bootstrap, 'supervisor.cjs');
  if (!fs.existsSync(runtime) || !fs.existsSync(supervisor)) {
    throw new Error('v5 Remote Connector managed bootstrap is incomplete.');
  }
  const state = readManagedState(paths);
  if (!state.current) throw new Error('v5 Remote Connector managed version is unavailable.');
  const currentRoot = versionRoot(paths, state.current);
  verifyPortableRoot(currentRoot);
  const cli = path.join(currentRoot, 'app', 'cli.cjs');
  if (!fs.existsSync(cli)) throw new Error('v5 Remote Connector managed CLI is unavailable.');
  const cliArguments = `"${cli}" start`.replaceAll("'", "''");
  const hiddenStart = [
    `$arguments = '${cliArguments}'`,
    `Start-Process -FilePath ${powershellLiteral(runtime)} -ArgumentList $arguments -WorkingDirectory ${powershellLiteral(currentRoot)} -WindowStyle Hidden`
  ].join('; ');
  const encodedStart = Buffer.from(hiddenStart, 'utf16le').toString('base64');
  writeTextAtomic(paths.managedStart, [
    '@echo off',
    'setlocal',
    `set "OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT=${cmd(paths.installRoot)}"`,
    `set "OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT=${cmd(paths.dataRoot)}"`,
    `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedStart}`,
    'exit /b %errorlevel%',
    ''
  ].join('\r\n'));
  writeTextAtomic(paths.startupEntry, [
    '@echo off',
    `call "${cmd(paths.managedStart)}"`,
    ''
  ].join('\r\n'));
}
