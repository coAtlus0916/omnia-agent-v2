import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  REMOTE_CONNECTOR_DATA_DIRECTORY,
  REMOTE_CONNECTOR_GUARDIAN_VERSION,
  REMOTE_CONNECTOR_INSTALL_DIRECTORY,
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_SUPERVISOR_VERSION
} from './constants.js';
import { compareVersions, isVersion, sha256File, verifyPortableRoot } from './release-contract.js';

export interface PendingUpdate {
  version: string;
  sequence: number;
  stagedAt: string;
}

export interface ManagedState {
  schemaVersion: 'omnia.v5.remote-connector-managed/v1' | 'omnia.v5.remote-connector-managed/v2';
  /** Monotonic local CAS revision. Missing means revision zero for <=0.3.35 compatibility. */
  revision: number;
  /** Exact durable update transaction owning pending/promotion state; empty outside a transaction. */
  transitionId: string;
  current: string;
  previous: string;
  highestSequence: number;
  pending: PendingUpdate | null;
  blocked: Record<string, { sequence: number; reason: string; blockedAt: string }>;
  updatedAt: string;
}

export interface PortablePackageIdentity {
  schemaVersion: 'omnia.v5.remote-connector-identity/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  version: string;
  sequence: number;
  supervisorVersion: string;
}

export type ManagedWorkerIdentityRole = 'current' | 'pending';

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export interface RemoteConnectorPaths {
  installRoot: string;
  versions: string;
  bootstrap: string;
  bootstrapLock: string;
  bootstrapState: string;
  bootstrapSlots: string;
  guardianLock: string;
  guardianRequest: string;
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
  updateMutex: string;
  updateTransaction: string;
  workerMaintenance: string;
  operationActivity: string;
  workerStatuses: string;
  workerClaim: string;
  rollbackBarrier: string;
  baselineAdmission: string;
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
    bootstrapState: path.join(installRoot, 'bootstrap', 'bootstrap-state.json'),
    bootstrapSlots: path.join(installRoot, 'bootstrap', 'slots'),
    guardianLock: path.join(dataRoot, 'guardian.lock'),
    guardianRequest: path.join(dataRoot, 'guardian.request.json'),
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
    updateMutex: path.join(dataRoot, 'connector-update.lock'),
    updateTransaction: path.join(dataRoot, 'connector-update-transaction.json'),
    workerMaintenance: path.join(dataRoot, 'worker-maintenance.json'),
    operationActivity: path.join(dataRoot, 'operation-activity.json'),
    workerStatuses: path.join(dataRoot, 'worker-statuses'),
    workerClaim: path.join(dataRoot, 'worker-claim.json'),
    rollbackBarrier: path.join(dataRoot, 'rollback-barrier.json'),
    baselineAdmission: path.join(dataRoot, 'baseline-admission.json'),
    logs: path.join(dataRoot, 'logs')
  };
}

export function ensureRemoteConnectorDirectories(paths: RemoteConnectorPaths): void {
  for (const directory of [
    paths.installRoot,
    paths.versions,
    paths.bootstrap,
    paths.updates,
    paths.bootstrapSlots,
    paths.dataRoot,
    paths.workerStatuses,
    paths.logs
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function defaultManagedState(): ManagedState {
  return {
    schemaVersion: 'omnia.v5.remote-connector-managed/v1',
    revision: 0,
    transitionId: '',
    current: '',
    previous: '',
    highestSequence: 0,
    pending: null,
    blocked: {},
    updatedAt: new Date().toISOString()
  };
}

export function assertPendingPackageIdentity(
  pending: PendingUpdate,
  identity: unknown,
  expectedSupervisorVersion = REMOTE_CONNECTOR_SUPERVISOR_VERSION
): asserts identity is PortablePackageIdentity {
  const value = identity as Partial<PortablePackageIdentity> | null;
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== 'omnia.v5.remote-connector-identity/v1'
    || value.product !== REMOTE_CONNECTOR_PRODUCT
    || value.version !== pending.version
    || value.sequence !== pending.sequence
    || value.supervisorVersion !== expectedSupervisorVersion
  ) {
    throw new Error(
      `v5 Remote Connector candidate requires Supervisor ${expectedSupervisorVersion} package identity.`
    );
  }
}

export function classifyManagedWorkerIdentity(
  state: ManagedState,
  identity: { version: unknown; sequence: unknown },
  currentSequence: number | null
): ManagedWorkerIdentityRole | null {
  if (
    typeof identity.version !== 'string'
    || !isVersion(identity.version)
    || !Number.isSafeInteger(identity.sequence)
    || Number(identity.sequence) <= 0
  ) return null;
  if (
    state.pending?.version === identity.version
    && state.pending.sequence === identity.sequence
  ) return 'pending';
  if (
    state.current === identity.version
    && Number.isSafeInteger(currentSequence)
    && currentSequence === identity.sequence
  ) return 'current';
  return null;
}

export function readManagedState(paths: RemoteConnectorPaths): ManagedState {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.state, 'utf8')) as ManagedState & {
      revision?: unknown;
      transitionId?: unknown;
    };
    const value = {
      ...raw,
      revision: raw.revision === undefined ? 0 : raw.revision,
      transitionId: raw.transitionId === undefined ? '' : raw.transitionId
    } as ManagedState;
    const pendingValid = value.pending === null || (
      Boolean(value.pending)
      && typeof value.pending === 'object'
      && !Array.isArray(value.pending)
      && Object.keys(value.pending).sort().join('|') === 'sequence|stagedAt|version'
      && isVersion(value.pending.version)
      && Number.isSafeInteger(value.pending.sequence)
      && value.pending.sequence > value.highestSequence
      && isIsoTimestamp(value.pending.stagedAt)
    );
    const blockedValid = Boolean(value.blocked)
      && typeof value.blocked === 'object'
      && !Array.isArray(value.blocked)
      && Object.entries(value.blocked).every(([version, blocked]) => (
        isVersion(version)
        && Boolean(blocked)
        && typeof blocked === 'object'
        && !Array.isArray(blocked)
        && Object.keys(blocked).sort().join('|') === 'blockedAt|reason|sequence'
        && Number.isSafeInteger(blocked.sequence)
        && blocked.sequence > 0
        && typeof blocked.reason === 'string'
        && blocked.reason.length > 0
        && blocked.reason.length <= 500
        && isIsoTimestamp(blocked.blockedAt)
      ));
    if (
      !['omnia.v5.remote-connector-managed/v1', 'omnia.v5.remote-connector-managed/v2'].includes(value.schemaVersion)
      || typeof value.current !== 'string'
      || (value.current !== '' && !isVersion(value.current))
      || typeof value.previous !== 'string'
      || (value.previous !== '' && !isVersion(value.previous))
      || !Number.isSafeInteger(value.highestSequence)
      || value.highestSequence < 0
      || !Number.isSafeInteger(value.revision)
      || value.revision < 0
      || typeof value.transitionId !== 'string'
      || (value.transitionId !== '' && !/^[a-f0-9]{48}$/u.test(value.transitionId))
      || !pendingValid
      || !blockedValid
      || !isIsoTimestamp(value.updatedAt)
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
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
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

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return ['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code || '')); }
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
  const gate = acquireRemoteConnectorMutex(paths.bootstrapLock, options.gateWaitMs ?? 35_000);
  const gateToken = gate.token;
  try {
    const runtimeSource = path.join(versionRootPath, 'runtime', 'node.exe');
    const supervisorSource = path.join(versionRootPath, 'app', 'supervisor.cjs');
    const guardianSource = path.join(versionRootPath, 'app', 'guardian.cjs');
    const runtimeTarget = path.join(paths.bootstrap, 'node.exe');
    const guardianTarget = path.join(paths.bootstrap, 'guardian.cjs');
    const markerTarget = path.join(paths.bootstrap, 'bootstrap.json');
    if (!fs.existsSync(runtimeSource) || !fs.existsSync(supervisorSource) || !fs.existsSync(guardianSource)) {
      throw new Error('The verified release does not contain the complete guardian/Supervisor bootstrap.');
    }
    if (options.installRuntime && !fs.existsSync(runtimeTarget)) {
      fs.copyFileSync(runtimeSource, runtimeTarget, fs.constants.COPYFILE_EXCL);
    }
    if (!fs.existsSync(runtimeTarget)) {
      throw new Error('The persistent guardian runtime is unavailable.');
    }
    const marker = readBootstrapMarker(markerTarget);
    const at = new Date().toISOString();
    if (marker && compareVersions(marker.supervisorVersion, REMOTE_CONNECTOR_SUPERVISOR_VERSION) > 0) {
      return { state: 'newer_preserved', supervisorVersion: marker.supervisorVersion, at };
    }

    const sourceSha256 = sha256File(supervisorSource);
    if (marker?.supervisorVersion === REMOTE_CONNECTOR_SUPERVISOR_VERSION && marker.supervisorSha256 !== sourceSha256) {
      throw new Error('The verified worker package changed Supervisor bytes without increasing its version.');
    }
    if (!ownsBootstrapGate(paths, gateToken)) {
      throw new Error('Lost the bootstrap migration gate before preparing immutable Supervisor bytes.');
    }

    const guardianSha256 = sha256File(guardianSource);
    if (!fs.existsSync(guardianTarget)) {
      fs.copyFileSync(guardianSource, guardianTarget, fs.constants.COPYFILE_EXCL);
    } else if (sha256File(guardianTarget) !== guardianSha256) {
      throw new Error('The fixed online-upgrade guardian bytes differ from the 0.3.36 baseline.');
    }
    const runtimeSha256 = sha256File(runtimeSource);
    if (sha256File(runtimeTarget) !== runtimeSha256) {
      throw new Error('The persistent guardian runtime differs from the verified baseline runtime.');
    }

    let existingState: Record<string, unknown> | null = null;
    try { existingState = JSON.parse(fs.readFileSync(paths.bootstrapState, 'utf8')) as Record<string, unknown>; } catch { /* first baseline */ }
    if (existingState) {
      const active = existingState.active as Record<string, unknown> | undefined;
      if (existingState.schemaVersion !== 'omnia.v5.remote-connector-bootstrap-state/v1'
        || existingState.product !== REMOTE_CONNECTOR_PRODUCT
        || !active || typeof active.version !== 'string') {
        throw new Error('The existing atomic Supervisor bootstrap pointer is invalid.');
      }
      if (compareVersions(active.version, REMOTE_CONNECTOR_SUPERVISOR_VERSION) > 0) {
        return { state: 'newer_preserved', supervisorVersion: active.version, at };
      }
      if (active.version === REMOTE_CONNECTOR_SUPERVISOR_VERSION) {
        const activeRoot = path.resolve(paths.bootstrap, String(active.root || ''));
        if (!activeRoot.startsWith(`${path.resolve(paths.bootstrapSlots)}${path.sep}`)
          || sha256File(path.join(activeRoot, 'supervisor.cjs')) !== sourceSha256
          || sha256File(path.join(activeRoot, 'node.exe')) !== runtimeSha256) {
          throw new Error('The active immutable Supervisor slot differs from its baseline identity.');
        }
        return { state: 'already_current', supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION, at };
      }
      // A live automatic transition owns all later slot changes. The local
      // baseline migrator never overwrites an older but valid atomic pointer.
      throw new Error('An older atomic Supervisor pointer requires the guarded portable baseline start.');
    }

    const generation = `${REMOTE_CONNECTOR_SUPERVISOR_VERSION}-${sourceSha256.slice(0, 16)}`;
    const relativeSlotRoot = path.join('slots', 'a', generation);
    const slotRoot = path.join(paths.bootstrap, relativeSlotRoot);
    fs.mkdirSync(slotRoot, { recursive: true, mode: 0o700 });
    for (const [source, target, expected] of [
      [supervisorSource, path.join(slotRoot, 'supervisor.cjs'), sourceSha256],
      [runtimeSource, path.join(slotRoot, 'node.exe'), runtimeSha256]
    ] as const) {
      if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (sha256File(target) !== expected) throw new Error('Immutable Supervisor baseline slot contains conflicting bytes.');
    }
    if (!ownsBootstrapGate(paths, gateToken)) {
      throw new Error('Lost the bootstrap migration gate before publishing its atomic pointer.');
    }
    writeJsonAtomic(paths.bootstrapState, {
      schemaVersion: 'omnia.v5.remote-connector-bootstrap-state/v1',
      product: REMOTE_CONNECTOR_PRODUCT,
      guardianVersion: REMOTE_CONNECTOR_GUARDIAN_VERSION,
      guardianSha256,
      guardianRuntimeSha256: runtimeSha256,
      revision: 0,
      active: {
        slot: 'a',
        version: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
        root: relativeSlotRoot.split(path.sep).join('/'),
        supervisorSha256: sourceSha256,
        runtimeSha256
      },
      previous: null,
      pending: null,
      blocked: {},
      transition: null,
      completedRequests: {},
      updatedAt: at
    });
    writeJsonAtomic(markerTarget, {
      schemaVersion: 'omnia.v5.remote-connector-bootstrap/v1',
      product: REMOTE_CONNECTOR_PRODUCT,
      supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION,
      supervisorSha256: sourceSha256,
      installedAt: at
    } satisfies BootstrapMarker);
    return { state: 'migrated', supervisorVersion: REMOTE_CONNECTOR_SUPERVISOR_VERSION, at };
  } finally {
    gate.release();
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
  return withRemoteConnectorMutex(paths.updateMutex, 35_000, () => {
    const authoritative = readManagedState(paths);
    if (authoritative.revision !== input.revision) {
      throw Object.assign(new Error(
        `Managed Remote Connector state CAS failed: expected revision ${input.revision}, current ${authoritative.revision}.`
      ), { code: 'CONNECTOR.UPDATE_CAS_MISMATCH' });
    }
    if (input.highestSequence < authoritative.highestSequence) {
      throw new Error('Managed Remote Connector sequence high-water cannot move backwards.');
    }
    const next = {
      ...input,
      revision: authoritative.revision + 1,
      highestSequence: Math.max(authoritative.highestSequence, input.highestSequence),
      updatedAt: new Date().toISOString()
    };
    writeJsonAtomic(paths.state, next);
    return next;
  });
}

/**
 * The 0.3.36 baseline promotes v1 to v2 only after it is the managed current
 * Worker and no pending candidate exists. That preserves 0.3.35 rollback while
 * 0.3.36 itself is still in probation, then establishes revision/transition CAS
 * as the permanent online-update baseline.
 */
export function upgradeManagedStateV2(
  paths: RemoteConnectorPaths,
  expectedCurrentVersion: string
): ManagedState {
  const state = readManagedState(paths);
  if (state.schemaVersion === 'omnia.v5.remote-connector-managed/v2') return state;
  if (state.current !== expectedCurrentVersion || state.pending !== null || state.transitionId !== '') {
    throw new Error('Managed-state v2 migration is allowed only for the exact quiescent current baseline.');
  }
  return writeManagedState(paths, {
    ...state,
    schemaVersion: 'omnia.v5.remote-connector-managed/v2'
  });
}

interface CrossProcessMutexOwner {
  schemaVersion: 'omnia.v5.remote-connector-mutex/v1';
  pid: number;
  token: string;
  createdAt: string;
  ticket?: number;
}

function mutexOwner(filename: string): CrossProcessMutexOwner | null {
  const value = readJsonRecord(filename);
  if (value?.schemaVersion !== 'omnia.v5.remote-connector-mutex/v1'
    || !Number.isSafeInteger(Number(value.pid)) || Number(value.pid) <= 0
    || typeof value.token !== 'string' || value.token.length < 24
    || !isIsoTimestamp(value.createdAt)) return null;
  return value as unknown as CrossProcessMutexOwner;
}

/**
 * A bounded, token-fenced cross-process mutex. A stale owner is removed only by
 * atomically renaming the exact observed lock, so two recovery writers cannot
 * both believe they stole the same lease.
 */
export interface RemoteConnectorMutexLease {
  token: string;
  release(): void;
}

export function acquireRemoteConnectorMutex(filename: string, waitMs: number): RemoteConnectorMutexLease {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString('base64url');
  const deadline = Date.now() + Math.max(1, waitMs);
  const claimsDirectory = `${filename}.bakery`;
  fs.mkdirSync(claimsDirectory, { recursive: true, mode: 0o700 });
  const prefix = `${process.pid}-${token}`;
  const choosingPath = path.join(claimsDirectory, `${prefix}.choosing`);
  const claimPath = path.join(claimsDirectory, `${prefix}.json`);
  const owner: CrossProcessMutexOwner = {
    schemaVersion: 'omnia.v5.remote-connector-mutex/v1',
    pid: process.pid,
    token,
    createdAt: new Date().toISOString()
  };

  const liveOwner = (candidate: CrossProcessMutexOwner): boolean => (
    processIsAlive(candidate.pid) && !pidWasReused(candidate)
  );
  const readClaims = (): CrossProcessMutexOwner[] => {
    const claims: CrossProcessMutexOwner[] = [];
    for (const entry of fs.readdirSync(claimsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const target = path.join(claimsDirectory, entry.name);
      const candidate = mutexOwner(target);
      if (!candidate || !Number.isSafeInteger(candidate.ticket) || Number(candidate.ticket) <= 0 || !liveOwner(candidate)) {
        fs.rmSync(target, { force: true });
        continue;
      }
      claims.push(candidate);
    }
    return claims.sort((left, right) => Number(left.ticket) - Number(right.ticket)
      || (left.token < right.token ? -1 : left.token > right.token ? 1 : 0));
  };
  const hasLiveChooser = (): boolean => {
    let live = false;
    for (const entry of fs.readdirSync(claimsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.choosing')) continue;
      const target = path.join(claimsDirectory, entry.name);
      const candidate = mutexOwner(target);
      if (!candidate || !liveOwner(candidate)) fs.rmSync(target, { force: true });
      else if (candidate.token !== token) live = true;
    }
    return live;
  };

  // Lamport bakery: choosing is published before reading tickets. Concurrent
  // contenders may choose the same ticket, but the immutable random token is a
  // deterministic tie breaker. A later contender observes the live owner's
  // ticket and can never remove or overtake it.
  writeJsonAtomic(choosingPath, owner);
  let acquired = false;
  try {
    const ticket = readClaims().reduce((maximum, claim) => Math.max(maximum, Number(claim.ticket)), 0) + 1;
    writeJsonAtomic(claimPath, { ...owner, ticket });
  } finally {
    fs.rmSync(choosingPath, { force: true });
  }

  try {
    while (Date.now() < deadline) {
      if (hasLiveChooser()) {
        sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
        continue;
      }
      const claims = readClaims();
      if (claims[0]?.token !== token) {
        sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
        continue;
      }

      const existing = mutexOwner(filename);
      if (existing && existing.token !== token && liveOwner(existing)) {
        sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
        continue;
      }
      if (existing && existing.token !== token) {
        // Only the elected bakery owner reaches this branch. Re-read the exact
        // token immediately before removal; no second recovery writer can race.
        if (mutexOwner(filename)?.token !== existing.token) continue;
        fs.rmSync(filename, { force: true });
      } else if (!existing && fs.existsSync(filename)) {
        throw new Error('Remote Connector update mutex is unreadable; refusing concurrent mutation.');
      }

      if (!fs.existsSync(filename)) {
        try { fs.linkSync(claimPath, filename); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
      }
      if (mutexOwner(filename)?.token !== token) continue;
      acquired = true;
      let released = false;
      return {
        token,
        release: () => {
          if (released) return;
          released = true;
          try {
            if (mutexOwner(filename)?.token === token) fs.rmSync(filename, { force: true });
          } finally {
            fs.rmSync(claimPath, { force: true });
          }
        }
      };
    }
    throw Object.assign(new Error('Timed out waiting for the Remote Connector update mutex.'), { code: 'EBUSY' });
  } finally {
    fs.rmSync(choosingPath, { force: true });
    if (!acquired) fs.rmSync(claimPath, { force: true });
  }
}

export function withRemoteConnectorMutex<T>(filename: string, waitMs: number, action: () => T): T {
  const lease = acquireRemoteConnectorMutex(filename, waitMs);
  try { return action(); }
  finally { lease.release(); }
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
  const guardian = path.join(paths.bootstrap, 'guardian.cjs');
  if (!fs.existsSync(runtime) || !fs.existsSync(guardian) || !fs.existsSync(paths.bootstrapState)) {
    throw new Error('v5 Remote Connector managed bootstrap is incomplete.');
  }
  const state = readManagedState(paths);
  if (!state.current) throw new Error('v5 Remote Connector managed version is unavailable.');
  const currentRoot = versionRoot(paths, state.current);
  verifyPortableRoot(currentRoot);
  const guardianArguments = `"${guardian}" --run-guardian`.replaceAll("'", "''");
  const hiddenStart = [
    `$arguments = '${guardianArguments}'`,
    `Start-Process -FilePath ${powershellLiteral(runtime)} -ArgumentList $arguments -WorkingDirectory ${powershellLiteral(currentRoot)} -WindowStyle Hidden`
  ].join('; ');
  const encodedStart = Buffer.from(hiddenStart, 'utf16le').toString('base64');
  writeTextAtomic(paths.managedStart, [
    '@echo off',
    'setlocal',
    `set "OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT=${cmd(paths.installRoot)}"`,
    `set "OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT=${cmd(paths.dataRoot)}"`,
    `set "OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY=${cmd(paths.startupEntry)}"`,
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
