import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  REMOTE_CONNECTOR_GUARDIAN_VERSION,
  REMOTE_CONNECTOR_PRODUCT
} from './constants.js';
import {
  ensureRemoteConnectorDirectories,
  acquireRemoteConnectorMutex,
  type RemoteConnectorPaths,
  resolveRemoteConnectorPaths,
  withRemoteConnectorMutex,
  writeJsonAtomic
} from './managed-state.js';
import { pidMatchesExactStartTime, processBirthMatch, processStartTimeUtc } from './process-liveness.js';
import { compareVersions, sha256File } from './release-contract.js';
import { readRollbackBarrier } from './update-transaction.js';

export interface SupervisorSlotIdentity {
  slot: 'a' | 'b';
  version: string;
  root: string;
  supervisorSha256: string;
  runtimeSha256: string;
}

export interface BootstrapState {
  schemaVersion: 'omnia.v5.remote-connector-bootstrap-state/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  guardianVersion: string;
  guardianSha256: string;
  guardianRuntimeSha256: string;
  revision: number;
  active: SupervisorSlotIdentity;
  previous: SupervisorSlotIdentity | null;
  pending: (SupervisorSlotIdentity & { transactionId: string }) | null;
  blocked: Record<string, { sha256: string; reason: string; blockedAt: string }>;
  transition: {
    action: 'activate_pending' | 'rollback_previous';
    transactionId: string;
    requestId: string;
    from: SupervisorSlotIdentity;
    to: SupervisorSlotIdentity;
    phase: 'candidate_starting' | 'candidate_acknowledged' | 'rollback_stopping' | 'rollback_starting';
    guardianToken: string;
    startedAt: string;
  } | null;
  completedRequests: Record<string, { transactionId: string; action: GuardianRequest['action']; outcome: 'activated' | 'rolled_back' | 'blocked'; completedAt: string }>;
  updatedAt: string;
}

export interface GuardianRequest {
  schemaVersion: 'omnia.v5.remote-connector-guardian-request/v1';
  transactionId: string;
  requestId: string;
  revision: number;
  action: 'activate_pending' | 'rollback_previous';
  expectedActiveVersion: string;
  expectedPendingVersion: string;
  requestedAt: string;
  expiresAt: string;
}

function activeSlot(slot: SupervisorSlotIdentity & { transactionId?: string }): SupervisorSlotIdentity {
  return {
    slot: slot.slot,
    version: slot.version,
    root: slot.root,
    supervisorSha256: slot.supervisorSha256,
    runtimeSha256: slot.runtimeSha256
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...allowed].sort().join('|');
}

function assertSlot(value: unknown, pending = false): asserts value is SupervisorSlotIdentity & { transactionId?: string } {
  const keys = ['slot', 'version', 'root', 'supervisorSha256', 'runtimeSha256', ...(pending ? ['transactionId'] : [])];
  if (!record(value) || !exactKeys(value, keys)
    || !['a', 'b'].includes(String(value.slot || ''))
    || !/^\d+\.\d+\.\d+$/u.test(String(value.version || ''))
    || typeof value.root !== 'string' || !value.root || path.isAbsolute(value.root) || value.root.includes('..')
    || !/^[a-f0-9]{64}$/u.test(String(value.supervisorSha256 || ''))
    || !/^[a-f0-9]{64}$/u.test(String(value.runtimeSha256 || ''))
    || (pending && (typeof value.transactionId !== 'string' || !/^[a-f0-9]{48}$/u.test(value.transactionId)))) {
    throw new Error('Supervisor bootstrap slot identity is invalid.');
  }
}

export function validateBootstrapState(value: unknown): BootstrapState {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'product', 'guardianVersion', 'guardianSha256', 'guardianRuntimeSha256',
    'revision', 'active', 'previous', 'pending', 'blocked', 'transition', 'completedRequests', 'updatedAt'
  ]) || value.schemaVersion !== 'omnia.v5.remote-connector-bootstrap-state/v1'
    || value.product !== REMOTE_CONNECTOR_PRODUCT
    || !/^\d+\.\d+\.\d+$/u.test(String(value.guardianVersion || ''))
    || !/^[a-f0-9]{64}$/u.test(String(value.guardianSha256 || ''))
    || !/^[a-f0-9]{64}$/u.test(String(value.guardianRuntimeSha256 || ''))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !record(value.blocked) || !iso(value.updatedAt)) {
    throw new Error('Supervisor bootstrap state is invalid.');
  }
  assertSlot(value.active);
  if (value.previous !== null) assertSlot(value.previous);
  if (value.pending !== null) assertSlot(value.pending, true);
  if (value.transition !== null) {
    if (!record(value.transition) || !exactKeys(value.transition, [
      'action', 'transactionId', 'requestId', 'from', 'to', 'phase', 'guardianToken', 'startedAt'
    ]) || !['activate_pending', 'rollback_previous'].includes(String(value.transition.action || ''))
      || !/^[a-f0-9]{48}$/u.test(String(value.transition.transactionId || ''))
      || !/^[a-f0-9]{48}$/u.test(String(value.transition.requestId || ''))
      || !['candidate_starting', 'candidate_acknowledged', 'rollback_stopping', 'rollback_starting'].includes(String(value.transition.phase || ''))
      || typeof value.transition.guardianToken !== 'string' || value.transition.guardianToken.length < 24
      || !iso(value.transition.startedAt)) throw new Error('Supervisor bootstrap transition is invalid.');
    assertSlot(value.transition.from);
    assertSlot(value.transition.to);
  }
  if (!record(value.completedRequests)) throw new Error('Supervisor completed request ledger is invalid.');
  for (const [requestId, completed] of Object.entries(value.completedRequests)) {
    if (!/^[a-f0-9]{48}$/u.test(requestId) || !record(completed)
      || !exactKeys(completed, ['transactionId', 'action', 'outcome', 'completedAt'])
      || !/^[a-f0-9]{48}$/u.test(String(completed.transactionId || ''))
      || !['activate_pending', 'rollback_previous'].includes(String(completed.action || ''))
      || !['activated', 'rolled_back', 'blocked'].includes(String(completed.outcome || ''))
      || !iso(completed.completedAt)) throw new Error('Supervisor completed request entry is invalid.');
  }
  if (value.previous && value.previous.slot === value.active.slot) throw new Error('Previous and active Supervisor slots collide.');
  if (value.pending && value.pending.slot === value.active.slot) throw new Error('Pending and active Supervisor slots collide.');
  for (const [version, blocked] of Object.entries(value.blocked)) {
    if (!/^\d+\.\d+\.\d+$/u.test(version) || !record(blocked)
      || !exactKeys(blocked, ['sha256', 'reason', 'blockedAt'])
      || !/^[a-f0-9]{64}$/u.test(String(blocked.sha256 || ''))
      || typeof blocked.reason !== 'string' || blocked.reason.length < 1 || blocked.reason.length > 500
      || !iso(blocked.blockedAt)) throw new Error('Blocked Supervisor identity is invalid.');
  }
  return value as unknown as BootstrapState;
}

export function readBootstrapState(paths: RemoteConnectorPaths): BootstrapState {
  try { return validateBootstrapState(JSON.parse(fs.readFileSync(paths.bootstrapState, 'utf8'))); }
  catch { throw new Error('Supervisor bootstrap pointer is missing or corrupt; guardian startup is fail-closed.'); }
}

export function casBootstrapState(
  paths: RemoteConnectorPaths,
  expectedRevision: number,
  update: (state: BootstrapState) => Omit<BootstrapState, 'revision' | 'updatedAt'>
): BootstrapState {
  return withRemoteConnectorMutex(`${paths.bootstrapState}.lock`, 35_000, () => {
    const state = readBootstrapState(paths);
    if (state.revision !== expectedRevision) {
      throw Object.assign(new Error('Supervisor bootstrap pointer CAS failed.'), { code: 'CONNECTOR.UPDATE_CAS_MISMATCH' });
    }
    const candidate = update(structuredClone(state));
    const next = validateBootstrapState({ ...candidate, revision: state.revision + 1, updatedAt: new Date().toISOString() });
    writeJsonAtomic(paths.bootstrapState, next);
    return next;
  });
}

export function verifySupervisorSlot(paths: RemoteConnectorPaths, slot: SupervisorSlotIdentity): string {
  assertSlot(slot);
  const root = path.resolve(paths.bootstrap, slot.root);
  if (!root.startsWith(`${path.resolve(paths.bootstrapSlots)}${path.sep}`)) {
    throw new Error('Supervisor slot escaped the immutable bootstrap slot root.');
  }
  const supervisor = path.join(root, 'supervisor.cjs');
  const runtime = path.join(root, 'node.exe');
  if (sha256File(supervisor) !== slot.supervisorSha256 || sha256File(runtime) !== slot.runtimeSha256) {
    throw new Error('Supervisor slot bytes differ from the atomic bootstrap pointer.');
  }
  return root;
}

export function stageSupervisorSlot(
  paths: RemoteConnectorPaths,
  candidateVersionRoot: string,
  supervisorVersion: string,
  transactionId: string
): BootstrapState {
  return withRemoteConnectorMutex(`${paths.bootstrapState}.lock`, 35_000, () => {
    const state = readBootstrapState(paths);
    if (state.pending) {
      if (state.pending.transactionId === transactionId && state.pending.version === supervisorVersion) return state;
      throw new Error('Another Supervisor bootstrap transition is pending.');
    }
    if (compareVersions(supervisorVersion, state.active.version) < 0) {
      throw new Error('Supervisor bootstrap sequence cannot downgrade.');
    }
    if (supervisorVersion === state.active.version) return state;
    const slot: 'a' | 'b' = state.active.slot === 'a' ? 'b' : 'a';
    const sourceSupervisor = path.join(candidateVersionRoot, 'app', 'supervisor.cjs');
    const sourceRuntime = path.join(candidateVersionRoot, 'runtime', 'node.exe');
    const supervisorSha256 = sha256File(sourceSupervisor);
    const runtimeSha256 = sha256File(sourceRuntime);
    const blocked = state.blocked[supervisorVersion];
    if (blocked?.sha256 === supervisorSha256) throw new Error('This exact Supervisor candidate is blocked after failed takeover.');
    const generation = `${supervisorVersion}-${supervisorSha256.slice(0, 16)}`;
    const relativeRoot = path.join('slots', slot, generation);
    const destination = path.join(paths.bootstrap, relativeRoot);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    const installImmutable = (source: string, target: string, expected: string) => {
      if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (sha256File(target) !== expected) throw new Error('Immutable Supervisor slot contains conflicting bytes.');
    };
    installImmutable(sourceSupervisor, path.join(destination, 'supervisor.cjs'), supervisorSha256);
    installImmutable(sourceRuntime, path.join(destination, 'node.exe'), runtimeSha256);
    const pending: BootstrapState['pending'] = {
      slot,
      version: supervisorVersion,
      root: relativeRoot.split(path.sep).join('/'),
      supervisorSha256,
      runtimeSha256,
      transactionId
    };
    const next = validateBootstrapState({
      ...state,
      revision: state.revision + 1,
      pending,
      updatedAt: new Date().toISOString()
    });
    writeJsonAtomic(paths.bootstrapState, next);
    return next;
  });
}

export function writeGuardianRequest(paths: RemoteConnectorPaths, request: GuardianRequest): void {
  if (!record(request) || !exactKeys(request, [
    'schemaVersion', 'transactionId', 'requestId', 'revision', 'action', 'expectedActiveVersion', 'expectedPendingVersion', 'requestedAt', 'expiresAt'
  ]) || request.schemaVersion !== 'omnia.v5.remote-connector-guardian-request/v1'
    || !/^[a-f0-9]{48}$/u.test(request.transactionId)
    || !/^[a-f0-9]{48}$/u.test(request.requestId)
    || !Number.isSafeInteger(request.revision) || request.revision < 0
    || !['activate_pending', 'rollback_previous'].includes(request.action)
    || !/^\d+\.\d+\.\d+$/u.test(request.expectedActiveVersion)
    || !/^\d+\.\d+\.\d+$/u.test(request.expectedPendingVersion)
    || !iso(request.requestedAt) || !iso(request.expiresAt)
    || Date.parse(request.expiresAt) <= Date.parse(request.requestedAt)
    || Date.parse(request.expiresAt) - Date.parse(request.requestedAt) > 10 * 60_000) throw new Error('Guardian request is invalid.');
  writeJsonAtomic(paths.guardianRequest, request);
}

function readGuardianRequest(paths: RemoteConnectorPaths): GuardianRequest | null {
  try {
    const value = JSON.parse(fs.readFileSync(paths.guardianRequest, 'utf8')) as GuardianRequest;
    writeGuardianRequestValidation(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Guardian request is corrupt; Supervisor takeover is fail-closed.');
  }
}

function writeGuardianRequestValidation(value: GuardianRequest): void {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'transactionId', 'requestId', 'revision', 'action', 'expectedActiveVersion', 'expectedPendingVersion', 'requestedAt', 'expiresAt'
  ]) || value.schemaVersion !== 'omnia.v5.remote-connector-guardian-request/v1'
    || !/^[a-f0-9]{48}$/u.test(value.transactionId) || !/^[a-f0-9]{48}$/u.test(value.requestId)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !['activate_pending', 'rollback_previous'].includes(value.action)
    || !/^\d+\.\d+\.\d+$/u.test(value.expectedActiveVersion)
    || !/^\d+\.\d+\.\d+$/u.test(value.expectedPendingVersion) || !iso(value.requestedAt) || !iso(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.requestedAt)
    || Date.parse(value.expiresAt) - Date.parse(value.requestedAt) > 10 * 60_000) {
    throw new Error('invalid guardian request');
  }
}

function startSupervisor(
  paths: RemoteConnectorPaths,
  slot: SupervisorSlotIdentity,
  guardianToken: string,
  bootstrapRevision: number,
  transactionId: string
): ChildProcess {
  const root = verifySupervisorSlot(paths, slot);
  return spawn(path.join(root, 'node.exe'), [path.join(root, 'supervisor.cjs')], {
    cwd: root,
    detached: false,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: paths.installRoot,
      OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: paths.dataRoot,
      OMNIA_V5_REMOTE_CONNECTOR_GUARDIAN_PID: String(process.pid),
      OMNIA_V5_REMOTE_CONNECTOR_GUARDIAN_TOKEN: guardianToken,
      OMNIA_V5_REMOTE_CONNECTOR_EXPECTED_SUPERVISOR_VERSION: slot.version,
      OMNIA_V5_REMOTE_CONNECTOR_BOOTSTRAP_REVISION: String(bootstrapRevision),
      OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_SLOT: slot.slot,
      OMNIA_V5_REMOTE_CONNECTOR_SUPERVISOR_SHA256: slot.supervisorSha256,
      OMNIA_V5_REMOTE_CONNECTOR_UPDATE_TRANSACTION_ID: transactionId
    }
  });
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(true); });
  });
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    const killed = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      const timeout = setTimeout(() => resolve(false), 10_000);
      child.once('exit', () => { clearTimeout(timeout); resolve(true); });
    });
    if (!killed && child.exitCode === null) throw new Error('Supervisor did not exit after guardian SIGKILL.');
  }
}

function childHasExited(child: ChildProcess | null): boolean {
  return child !== null && child.exitCode !== null;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return pid > 0; }
  catch (error) { return ['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code || '')); }
}

async function stopRecordedSupervisor(
  paths: RemoteConnectorPaths,
  slot: SupervisorSlotIdentity,
  priorGuardianToken: string,
  currentGuardianToken: string,
  expectedTransactionId: string | null
): Promise<void> {
  let currentGuardianLease: Record<string, unknown>;
  try { currentGuardianLease = JSON.parse(fs.readFileSync(paths.guardianLock, 'utf8')) as Record<string, unknown>; }
  catch { throw new Error('Guardian cannot prove its current lease before Supervisor takeover.'); }
  if (currentGuardianLease.schemaVersion !== 'omnia.v5.remote-connector-mutex/v1'
    || Number(currentGuardianLease.pid) !== process.pid || currentGuardianLease.token !== currentGuardianToken
    || processBirthMatch(process.pid, String(currentGuardianLease.createdAt || '')) !== 'match') {
    throw new Error('Guardian current lease identity drifted before Supervisor takeover.');
  }
  let heartbeat: Record<string, unknown> | null = null;
  let lock: Record<string, unknown> | null = null;
  const heartbeatExists = fs.existsSync(paths.supervisorHeartbeat);
  const lockExists = fs.existsSync(paths.supervisorLock);
  if (!heartbeatExists && !lockExists) return;
  try { heartbeat = JSON.parse(fs.readFileSync(paths.supervisorHeartbeat, 'utf8')) as Record<string, unknown>; }
  catch { throw new Error('Guardian cannot read the prior Supervisor heartbeat; takeover is fail-closed.'); }
  try { lock = JSON.parse(fs.readFileSync(paths.supervisorLock, 'utf8')) as Record<string, unknown>; }
  catch { throw new Error('Guardian cannot read the prior Supervisor lock; takeover is fail-closed.'); }
  const pid = Number(heartbeat.pid || 0);
  const token = String(heartbeat.token || '');
  const createdAt = String(lock.createdAt || '');
  const processStartedAt = String(lock.processStartedAt || '');
  if (heartbeat.schemaVersion !== 'omnia.v5.remote-connector-supervisor-heartbeat/v2'
    || lock.schemaVersion !== 'omnia.v5.remote-connector-supervisor-lock/v2'
    || heartbeat.product !== REMOTE_CONNECTOR_PRODUCT || lock.product !== REMOTE_CONNECTOR_PRODUCT
    || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(Date.parse(processStartedAt))) {
    throw new Error('Guardian cannot validate the prior Supervisor authority records; takeover is fail-closed.');
  }
  if (heartbeat.supervisorSlot !== slot.slot || heartbeat.supervisorSha256 !== slot.supervisorSha256) return;
  if (heartbeat.supervisorVersion !== slot.version
    || Number(lock.pid) !== pid || lock.token !== token || lock.createdAt !== createdAt
    || heartbeat.processStartedAt !== processStartedAt
    || !Number.isSafeInteger(lock.guardianPid) || Number(lock.guardianPid) <= 0
    || heartbeat.guardianPid !== lock.guardianPid
    || lock.guardianToken !== priorGuardianToken || heartbeat.guardianToken !== priorGuardianToken
    || lock.bootstrapRevision !== heartbeat.bootstrapRevision
    || lock.transactionId !== heartbeat.transactionId
    || (expectedTransactionId !== null && lock.transactionId !== expectedTransactionId)
    || lock.supervisorSlot !== slot.slot || lock.supervisorSha256 !== slot.supervisorSha256) {
    throw new Error('Guardian observed a split Supervisor authority identity; takeover is fail-closed.');
  }
  const ownsRecordedProcess = () => {
    try {
      const currentHeartbeat = JSON.parse(fs.readFileSync(paths.supervisorHeartbeat, 'utf8')) as Record<string, unknown>;
      const currentLock = JSON.parse(fs.readFileSync(paths.supervisorLock, 'utf8')) as Record<string, unknown>;
      const guardianLease = JSON.parse(fs.readFileSync(paths.guardianLock, 'utf8')) as Record<string, unknown>;
      const heartbeatAt = Date.parse(String(currentHeartbeat.heartbeatAt || ''));
      return guardianLease.schemaVersion === 'omnia.v5.remote-connector-mutex/v1'
        && Number(guardianLease.pid) === process.pid && guardianLease.token === currentGuardianToken
        && processBirthMatch(process.pid, String(guardianLease.createdAt || '')) === 'match'
        && currentHeartbeat.schemaVersion === 'omnia.v5.remote-connector-supervisor-heartbeat/v2'
        && currentLock.schemaVersion === 'omnia.v5.remote-connector-supervisor-lock/v2'
        && currentHeartbeat.product === REMOTE_CONNECTOR_PRODUCT && currentLock.product === REMOTE_CONNECTOR_PRODUCT
        && Number(currentHeartbeat.pid) === pid && currentHeartbeat.token === token
        && currentHeartbeat.supervisorVersion === slot.version
        && currentHeartbeat.supervisorSlot === slot.slot
        && currentHeartbeat.supervisorSha256 === slot.supervisorSha256
        && currentHeartbeat.processStartedAt === processStartedAt
        && Number(currentLock.pid) === pid && currentLock.token === token
        && currentLock.createdAt === createdAt && currentLock.supervisorSlot === slot.slot
        && currentLock.supervisorSha256 === slot.supervisorSha256
        && currentLock.processStartedAt === processStartedAt
        && currentHeartbeat.guardianPid === currentLock.guardianPid
        && currentLock.guardianToken === priorGuardianToken && currentHeartbeat.guardianToken === priorGuardianToken
        && currentLock.bootstrapRevision === currentHeartbeat.bootstrapRevision
        && currentLock.transactionId === currentHeartbeat.transactionId
        && (expectedTransactionId === null || currentLock.transactionId === expectedTransactionId)
        && Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt >= -5_000
        && Date.now() - heartbeatAt <= 5_000
        && pidMatchesExactStartTime(pid, processStartedAt);
    } catch { return false; }
  };
  if (!ownsRecordedProcess()) throw new Error('Guardian cannot prove prior Supervisor signal authority.');
  const birthState = (): 'absent'|'match'|'mismatch'|'unknown' => {
    if (!processAlive(pid)) return 'absent';
    const current = processStartTimeUtc(pid);
    if (!current) return 'unknown';
    return current === processStartedAt ? 'match' : 'mismatch';
  };
  try { process.kill(pid, 'SIGTERM'); } catch { /* re-check below */ }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && birthState() === 'match') await new Promise((resolve) => setTimeout(resolve, 100));
  let state = birthState();
  if (state === 'unknown') throw new Error('Guardian cannot prove prior Supervisor birth after SIGTERM.');
  if (state === 'match') {
    if (!ownsRecordedProcess()) {
      throw new Error('Guardian cannot re-prove prior Supervisor authority before SIGKILL.');
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* re-check below */ }
    const killDeadline = Date.now() + 10_000;
    while (Date.now() < killDeadline && birthState() === 'match') await new Promise((resolve) => setTimeout(resolve, 100));
    state = birthState();
  }
  if (state === 'match' || state === 'unknown') {
    throw new Error('Guardian could not confirm prior Supervisor exit during crash recovery.');
  }
}

function supervisorAcknowledged(
  paths: RemoteConnectorPaths,
  child: ChildProcess,
  slot: SupervisorSlotIdentity,
  guardianToken: string,
  bootstrapRevision: number,
  transactionId: string
): boolean {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(paths.supervisorHeartbeat, 'utf8')) as Record<string, unknown>;
    const lock = JSON.parse(fs.readFileSync(paths.supervisorLock, 'utf8')) as Record<string, unknown>;
    const at = Date.parse(String(heartbeat.heartbeatAt || ''));
    const processStartedAt = String(heartbeat.processStartedAt || '');
    return heartbeat.schemaVersion === 'omnia.v5.remote-connector-supervisor-heartbeat/v2'
      && lock.schemaVersion === 'omnia.v5.remote-connector-supervisor-lock/v2'
      && heartbeat.product === REMOTE_CONNECTOR_PRODUCT && lock.product === REMOTE_CONNECTOR_PRODUCT
      && Number(heartbeat.pid) === Number(child.pid || 0)
      && Number(lock.pid) === Number(child.pid || 0) && lock.token === heartbeat.token
      && lock.processStartedAt === processStartedAt && pidMatchesExactStartTime(Number(child.pid || 0), processStartedAt)
      && heartbeat.supervisorVersion === slot.version
      && heartbeat.guardianPid === process.pid
      && heartbeat.guardianToken === guardianToken
      && lock.guardianPid === process.pid && lock.guardianToken === guardianToken
      && heartbeat.bootstrapRevision === bootstrapRevision
      && lock.bootstrapRevision === bootstrapRevision
      && heartbeat.supervisorSlot === slot.slot
      && lock.supervisorSlot === slot.slot
      && heartbeat.supervisorSha256 === slot.supervisorSha256
      && lock.supervisorSha256 === slot.supervisorSha256
      && heartbeat.transactionId === transactionId
      && lock.transactionId === transactionId
      && Number.isFinite(at) && Date.now() - at >= -5_000 && Date.now() - at < 5_000;
  } catch { return false; }
}

async function awaitSupervisorAck(
  paths: RemoteConnectorPaths,
  child: ChildProcess,
  slot: SupervisorSlotIdentity,
  guardianToken: string,
  bootstrapRevision: number,
  transactionId: string
): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (supervisorAcknowledged(paths, child, slot, guardianToken, bootstrapRevision, transactionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function guardianMain(): Promise<void> {
  const paths = resolveRemoteConnectorPaths();
  ensureRemoteConnectorDirectories(paths);
  let state = readBootstrapState(paths);
  const guardianPath = path.resolve(process.argv[1] || '');
  const runtimePath = path.join(paths.bootstrap, 'node.exe');
  if (sha256File(guardianPath) !== state.guardianSha256
    || sha256File(runtimePath) !== state.guardianRuntimeSha256
    || state.guardianVersion !== REMOTE_CONNECTOR_GUARDIAN_VERSION) {
    throw new Error('Guardian runtime bytes differ from the atomic bootstrap identity.');
  }
  let lease;
  try { lease = acquireRemoteConnectorMutex(paths.guardianLock, 500); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EBUSY') return;
    throw error;
  }
  const token = lease.token;
  let child: ChildProcess | null = null;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await stopChild(child);
    lease.release();
  };
  const removeRequest = (requestId: string) => {
    try {
      const current = readGuardianRequest(paths);
      if (current?.requestId === requestId) fs.rmSync(paths.guardianRequest, { force: true });
    } catch { /* corrupt requests remain fail-closed */ }
  };
  const startAndAck = async (slot: SupervisorSlotIdentity, revision: number, transactionId: string) => {
    child = startSupervisor(paths, slot, token, revision, transactionId);
    return awaitSupervisorAck(paths, child, slot, token, revision, transactionId);
  };
  const recoverAndAck = async (slot: SupervisorSlotIdentity, revision: number, transactionId: string) => {
    const deadline = Date.now() + 90_000;
    while (!stopping && Date.now() < deadline) {
      if (await startAndAck(slot, revision, transactionId)) return true;
      await stopChild(child);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown(); });
  try {
    if (state.transition) {
      // A guardian may die after the target acknowledged but before the pointer
      // CAS. Stop both exact recorded generations before resuming so a new
      // guardian can never leave two Supervisors alive.
      const priorGuardianToken = state.transition.guardianToken;
      await stopRecordedSupervisor(paths, state.transition.from, priorGuardianToken, token, null);
      await stopRecordedSupervisor(paths, state.transition.to, priorGuardianToken, token, state.transition.transactionId);
      if (state.transition.guardianToken !== token) {
        state = casBootstrapState(paths, state.revision, (current) => ({
          ...current,
          transition: current.transition ? { ...current.transition, guardianToken: token } : null
        }));
      }
    }
    const initialSlot = state.transition ? activeSlot(state.transition.to) : state.active;
    const initialTransactionId = state.transition?.transactionId ?? '';
    if (!await recoverAndAck(initialSlot, state.revision, initialTransactionId)) {
      throw new Error('Active Supervisor did not acknowledge its exact bootstrap version.');
    }
    while (!stopping) {
      const request = readGuardianRequest(paths);
      if (request) {
        state = readBootstrapState(paths);
        const completed = state.completedRequests[request.requestId];
        if (completed) {
          if (completed.transactionId !== request.transactionId || completed.action !== request.action) {
            throw new Error('Guardian request id was replayed with another transition identity.');
          }
          removeRequest(request.requestId);
          continue;
        }
        if (request.action === 'activate_pending') {
          if (!state.transition && Date.parse(request.expiresAt) <= Date.now()) {
            throw new Error('Guardian activation request expired before durable takeover started.');
          }
          if (!state.transition && request.revision !== state.revision) {
            throw new Error('Guardian activation request bootstrap revision is stale.');
          }
          if (!state.transition && (!state.pending || state.pending.transactionId !== request.transactionId
            || state.active.version !== request.expectedActiveVersion
            || state.pending.version !== request.expectedPendingVersion)) {
            throw new Error('Guardian activation request differs from the atomic bootstrap pointer.');
          }
          if (!state.transition) {
            state = casBootstrapState(paths, state.revision, (current) => ({
              ...current,
              transition: {
                action: 'activate_pending',
                transactionId: request.transactionId,
                requestId: request.requestId,
                from: current.active,
                to: activeSlot(current.pending!),
                phase: 'candidate_starting',
                guardianToken: token,
                startedAt: new Date().toISOString()
              }
            }));
          }
          if (state.transition?.requestId !== request.requestId
            || state.transition.transactionId !== request.transactionId) {
            throw new Error('Another durable Supervisor transition owns the bootstrap pointer.');
          }
          await stopChild(child);
          const target = activeSlot(state.transition.to);
          const acknowledged = await startAndAck(target, state.revision, request.transactionId);
          if (acknowledged) {
            state = casBootstrapState(paths, state.revision, (current) => ({
              ...current,
              active: activeSlot(current.transition!.to),
              previous: current.transition!.from,
              pending: null,
              transition: null,
              completedRequests: {
                ...current.completedRequests,
                [request.requestId]: {
                  transactionId: request.transactionId,
                  action: request.action,
                  outcome: 'activated',
                  completedAt: new Date().toISOString()
                }
              }
            }));
          } else {
            await stopChild(child);
            state = casBootstrapState(paths, state.revision, (current) => ({
              ...current,
              pending: null,
              transition: null,
              blocked: {
                ...current.blocked,
                [current.transition!.to.version]: {
                  sha256: current.transition!.to.supervisorSha256,
                  reason: 'Supervisor candidate failed exact version acknowledgement.',
                  blockedAt: new Date().toISOString()
                }
              },
              completedRequests: {
                ...current.completedRequests,
                [request.requestId]: {
                  transactionId: request.transactionId,
                  action: request.action,
                  outcome: 'blocked',
                  completedAt: new Date().toISOString()
                }
              }
            }));
            if (!await startAndAck(state.active, state.revision, request.transactionId)) {
              throw new Error('Previous Supervisor failed after candidate rollback.');
            }
          }
          removeRequest(request.requestId);
        } else {
          const barrier = readRollbackBarrier(paths);
          if (barrier?.transactionId === request.transactionId) {
            throw new Error('Supervisor rollback is forbidden after the first durable candidate business admission.');
          }
          if (!state.transition && (Date.parse(request.expiresAt) <= Date.now() || request.revision !== state.revision)) {
            throw new Error('Guardian rollback request is expired or stale.');
          }
          if (!state.transition && (!state.previous || state.active.version !== request.expectedActiveVersion
            || state.previous.version !== request.expectedPendingVersion)) {
            throw new Error('Guardian rollback request differs from the atomic bootstrap pointer.');
          }
          if (!state.transition) {
            state = casBootstrapState(paths, state.revision, (current) => ({
              ...current,
              transition: {
                action: 'rollback_previous',
                transactionId: request.transactionId,
                requestId: request.requestId,
                from: current.active,
                to: current.previous!,
                phase: 'rollback_stopping',
                guardianToken: token,
                startedAt: new Date().toISOString()
              }
            }));
          }
          if (state.transition?.action !== 'rollback_previous' || state.transition.requestId !== request.requestId) {
            throw new Error('Another durable Supervisor transition owns rollback.');
          }
          const rollback = state.transition.to;
          await stopChild(child);
          state = casBootstrapState(paths, state.revision, (current) => ({
            ...current,
            transition: { ...current.transition!, phase: 'rollback_starting' }
          }));
          if (!await startAndAck(rollback, state.revision, request.transactionId)) {
            throw new Error('Previous Supervisor failed rollback acknowledgement.');
          }
          state = casBootstrapState(paths, state.revision, (current) => ({
            ...current,
            active: rollback,
            previous: current.transition!.from,
            pending: null,
            transition: null,
            completedRequests: {
              ...current.completedRequests,
              [request.requestId]: {
                transactionId: request.transactionId,
                action: request.action,
                outcome: 'rolled_back',
                completedAt: new Date().toISOString()
              }
            }
          }));
          removeRequest(request.requestId);
        }
      } else if (childHasExited(child)) {
        state = readBootstrapState(paths);
        const slot = state.transition ? activeSlot(state.transition.to) : state.active;
        if (!await recoverAndAck(slot, state.revision, state.transition?.transactionId ?? '')) {
          throw new Error('Guardian could not restart the atomic active Supervisor slot.');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await shutdown();
  }
}

if (process.argv.includes('--run-guardian')) {
  void guardianMain().catch(() => { process.exitCode = 1; });
}

export const _test = {
  supervisorAcknowledged,
  writeGuardianRequestValidation
};
