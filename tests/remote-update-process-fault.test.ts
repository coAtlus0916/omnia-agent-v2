import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { build, type Plugin } from 'esbuild';
import {
  REMOTE_CONNECTOR_KEY_ID,
  REMOTE_CONNECTOR_PLATFORM,
  REMOTE_CONNECTOR_PRODUCT
} from '../src/remote-connector/constants.js';
import { writeBaselineAdmission } from '../src/remote-connector/baseline-admission.js';
import {
  canonicalJson,
  sha256File,
  type PortableManifest
} from '../src/remote-connector/release-contract.js';
import {
  ensureRemoteConnectorDirectories,
  migrateSupervisorBootstrap,
  readManagedState,
  resolveRemoteConnectorPaths,
  versionRoot,
  writeManagedState
} from '../src/remote-connector/managed-state.js';
import {
  createUpdateTransaction,
  readRollbackBarrier,
  readUpdateTransaction,
  readWorkerClaim,
  readWorkerMaintenance,
  writeWorkerMaintenance
} from '../src/remote-connector/update-transaction.js';
import { processIsAlive, processStartTimeUtc } from '../src/remote-connector/process-liveness.js';

const repository = path.resolve(import.meta.dirname, '..');

function alive(pid: number): boolean {
  return processIsAlive(pid);
}

function processExecutablePath(pid: number): string | null {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).Path`
  ], { windowsHide: true, encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value ? path.resolve(value) : null;
}

async function waitFor<T>(read: () => T | null, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function readRecord(filename: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, any>; }
  catch { return null; }
}

function fileSnapshot(filename: string): Record<string, unknown> {
  try {
    const stat = fs.statSync(filename);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: sha256File(filename)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function treeSnapshot(target: string): Record<string, unknown> {
  try {
    const rootStat = fs.lstatSync(target);
    if (!rootStat.isDirectory()) return fileSnapshot(target);
    const files: Record<string, unknown>[] = [];
    const visit = (directory: string) => {
      const entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const entry of entries) {
        const filename = path.join(directory, entry.name);
        const relative = path.relative(target, filename).replaceAll('\\', '/');
        const stat = fs.lstatSync(filename);
        if (entry.isDirectory()) {
          files.push({ path: `${relative}/`, type: 'directory', mtimeMs: stat.mtimeMs });
          visit(filename);
        } else if (entry.isSymbolicLink()) {
          files.push({ path: relative, type: 'symlink', target: fs.readlinkSync(filename), mtimeMs: stat.mtimeMs });
        } else {
          files.push({
            path: relative, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs,
            sha256: stat.size <= 2 * 1024 * 1024 ? sha256File(filename) : null
          });
        }
      }
    };
    visit(target);
    return { exists: true, type: 'directory', files };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    return { exists: true, state: 'unknown', error: String(error) };
  }
}

function assertIsolatedFixture(
  root: string, installRoot: string, dataRoot: string, startupEntry: string, token: string
): void {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`), 'fault root must be below OS temp');
  assert.ok(path.basename(resolved).startsWith('omnia-remote-update-fault-'), 'fault root must use the dedicated prefix');
  assert.equal(path.resolve(installRoot), path.join(resolved, 'install'));
  assert.equal(path.resolve(dataRoot), path.join(resolved, 'data'));
  assert.equal(path.resolve(startupEntry), path.join(resolved, 'startup', 'RemoteConnector.cmd'));
  const marker = readRecord(path.join(resolved, '.fault-test-marker.json'));
  assert.equal(marker?.schemaVersion, 'omnia.v5.remote-connector-fault-test/v1');
  assert.equal(marker?.token, token);
  assert.equal(path.resolve(String(marker?.fixtureRoot || '')), resolved);
  assert.equal(path.resolve(String(marker?.hostTempRoot || '')), tempRoot);
  assert.equal(path.resolve(String(marker?.processTempRoot || '')), path.join(resolved, 'process-temp'));
}

async function buildSignedFixture(t: TestContext, options: {
  baselinePhase?: 'admitted'|'promoted';
  candidate?: boolean;
  faultEnvironment?: Record<string, string>;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-remote-update-fault-'));
  const token = crypto.randomBytes(24).toString('hex');
  const hostTempRoot = path.resolve(os.tmpdir());
  const childTemp = path.join(root, 'process-temp');
  fs.writeFileSync(path.join(root, '.fault-test-marker.json'), JSON.stringify({
    schemaVersion: 'omnia.v5.remote-connector-fault-test/v1', token,
    fixtureRoot: root, hostTempRoot, processTempRoot: childTemp
  }));
  const paths = resolveRemoteConnectorPaths({
    installRoot: path.join(root, 'install'),
    dataRoot: path.join(root, 'data'),
    startupEntry: path.join(root, 'startup', 'RemoteConnector.cmd')
  });
  const realAppData = String(process.env.APPDATA);
  const realLocalAppData = String(process.env.LOCALAPPDATA);
  const defaultStartupEntry = path.join(realAppData,
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Omnia Agent v5 Remote Connector.cmd');
  const defaultStartupBefore = fileSnapshot(defaultStartupEntry);
  const forbiddenRealRoots = [
    path.join(realLocalAppData, 'OmniaAgentV5RemoteConnector'),
    path.join(realAppData, 'OmniaAgentV5RemoteConnector'),
    path.join(realLocalAppData, 'OmniaAgentV5Bridge'),
    path.join(realAppData, 'OmniaAgentV5Bridge'),
    path.join(realLocalAppData, 'OmniaAgentV5Pack'),
    path.join(realAppData, 'OmniaAgentV5Pack')
  ].map((value) => path.resolve(value));
  for (const forbidden of forbiddenRealRoots) {
    assert.equal(path.resolve(root).startsWith(`${forbidden}${path.sep}`), false,
      'fault fixture must not overlap a real Connector, Bridge, or Pack root');
  }
  assertIsolatedFixture(root, paths.installRoot, paths.dataRoot, paths.startupEntry, token);
  ensureRemoteConnectorDirectories(paths);
  const signingKeys = crypto.generateKeyPairSync('ed25519');
  const fixturePrivateKey = signingKeys.privateKey;
  const fixturePublicKey = signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const constantsPath = path.join(repository, 'src/remote-connector/constants.ts');
  const identityPlugin = (candidate: boolean): Plugin => ({
    name: candidate ? 'isolated-candidate-identity' : 'isolated-current-identity',
    setup(context) {
      context.onLoad({ filter: /constants\.ts$/ }, (args) => {
        if (path.resolve(args.path) !== path.resolve(constantsPath)) return undefined;
        let contents = fs.readFileSync(args.path, 'utf8').replace(
          /export const REMOTE_CONNECTOR_PUBLIC_KEY = `[\s\S]*?`;/u,
          `export const REMOTE_CONNECTOR_PUBLIC_KEY = ${JSON.stringify(fixturePublicKey)};`
        );
        if (candidate) {
          contents = contents
            .replace("REMOTE_CONNECTOR_VERSION = '0.3.36'", "REMOTE_CONNECTOR_VERSION = '0.3.37'")
            .replace('REMOTE_CONNECTOR_SEQUENCE = 39', 'REMOTE_CONNECTOR_SEQUENCE = 40')
            .replace("REMOTE_CONNECTOR_SUPERVISOR_VERSION = '0.1.7'", "REMOTE_CONNECTOR_SUPERVISOR_VERSION = '0.1.8'");
        }
        return { contents, loader: 'ts' as const };
      });
    }
  });
  const bundleRoot = path.join(root, 'bundles');
  fs.mkdirSync(bundleRoot, { recursive: true });
  for (const name of ['cli', 'guardian', 'supervisor', 'worker']) {
    await build({
      absWorkingDir: repository,
      entryPoints: [path.join(repository, 'src/remote-connector', `${name}.ts`)],
      outfile: path.join(bundleRoot, `${name}.cjs`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      sourcemap: false,
      ...(name === 'worker' ? { external: ['playwright-core'] } : {}),
      plugins: [identityPlugin(false)]
    });
  }
  const portableRoot = versionRoot(paths, '0.3.36');
  fs.mkdirSync(path.join(portableRoot, 'app'), { recursive: true });
  fs.mkdirSync(path.join(portableRoot, 'runtime'), { recursive: true });
  for (const name of ['cli', 'guardian', 'supervisor', 'worker']) {
    fs.copyFileSync(path.join(bundleRoot, `${name}.cjs`), path.join(portableRoot, 'app', `${name}.cjs`));
  }
  fs.copyFileSync(process.execPath, path.join(portableRoot, 'runtime', 'node.exe'));
  const files = [
    'app/cli.cjs', 'app/guardian.cjs', 'app/supervisor.cjs', 'app/worker.cjs', 'runtime/node.exe'
  ].map((relative) => {
    const filename = path.join(portableRoot, ...relative.split('/'));
    return { path: relative, size: fs.statSync(filename).size, sha256: sha256File(filename) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const unsigned = {
    schemaVersion: 'omnia.v5.remote-connector-portable/v1' as const,
    product: REMOTE_CONNECTOR_PRODUCT as PortableManifest['product'],
    version: '0.3.36',
    sequence: 39,
    platform: REMOTE_CONNECTOR_PLATFORM as PortableManifest['platform'],
    keyId: REMOTE_CONNECTOR_KEY_ID as PortableManifest['keyId'],
    files
  };
  const manifest: PortableManifest = {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(canonicalJson(unsigned)), fixturePrivateKey).toString('base64')
  };
  fs.writeFileSync(path.join(portableRoot, 'portable-manifest.json'), JSON.stringify(manifest));
  if (options.candidate) {
    const candidateBundleRoot = path.join(root, 'candidate-bundles');
    fs.mkdirSync(candidateBundleRoot, { recursive: true });
    for (const name of ['cli', 'guardian', 'supervisor', 'worker']) {
      await build({
        absWorkingDir: repository,
        entryPoints: [path.join(repository, 'src/remote-connector', `${name}.ts`)],
        outfile: path.join(candidateBundleRoot, `${name}.cjs`),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        sourcemap: false,
        ...(name === 'worker' ? { external: ['playwright-core'] } : {}),
        plugins: [identityPlugin(true)]
      });
    }
    const candidateRoot = versionRoot(paths, '0.3.37');
    fs.mkdirSync(path.join(candidateRoot, 'app'), { recursive: true });
    fs.mkdirSync(path.join(candidateRoot, 'runtime'), { recursive: true });
    for (const name of ['cli', 'guardian', 'supervisor', 'worker']) {
      fs.copyFileSync(path.join(candidateBundleRoot, `${name}.cjs`), path.join(candidateRoot, 'app', `${name}.cjs`));
    }
    fs.copyFileSync(process.execPath, path.join(candidateRoot, 'runtime', 'node.exe'));
    const candidateFiles = [
      'app/cli.cjs', 'app/guardian.cjs', 'app/supervisor.cjs', 'app/worker.cjs', 'runtime/node.exe'
    ].map((relative) => {
      const filename = path.join(candidateRoot, ...relative.split('/'));
      return { path: relative, size: fs.statSync(filename).size, sha256: sha256File(filename) };
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const candidateUnsigned = {
      schemaVersion: 'omnia.v5.remote-connector-portable/v1' as const,
      product: REMOTE_CONNECTOR_PRODUCT as PortableManifest['product'],
      version: '0.3.37', sequence: 40,
      platform: REMOTE_CONNECTOR_PLATFORM as PortableManifest['platform'],
      keyId: REMOTE_CONNECTOR_KEY_ID as PortableManifest['keyId'],
      files: candidateFiles
    };
    const candidateManifest: PortableManifest = {
      ...candidateUnsigned,
      signature: crypto.sign(null, Buffer.from(canonicalJson(candidateUnsigned)), fixturePrivateKey).toString('base64')
    };
    fs.writeFileSync(path.join(candidateRoot, 'portable-manifest.json'), JSON.stringify(candidateManifest));
  }
  const initial = readManagedState(paths);
  writeManagedState(paths, {
    ...initial,
    schemaVersion: 'omnia.v5.remote-connector-managed/v2',
    current: '0.3.36', previous: '', pending: null, highestSequence: 39, transitionId: ''
  });
  migrateSupervisorBootstrap(paths, portableRoot, { installRuntime: true, gateWaitMs: 5_000 });
  writeBaselineAdmission(paths, {
    phase: options.baselinePhase || 'admitted', version: '0.3.36', sequence: 39,
    epoch: 'a'.repeat(48), executionGeneration: 'b'.repeat(48),
    admittedAt: options.baselinePhase === 'promoted' ? '' : new Date().toISOString()
  });
  let guardian: ChildProcess | null = null;
  type OwnedProcess = {
    startedAt: string;
    executablePath: string;
    role: 'guardian' | 'supervisor' | 'worker';
    token: string;
  };
  const ownedPids = new Map<number, OwnedProcess>();
  const unverifiedOwned = new Map<number, { role: OwnedProcess['role']; token: string; reason: string }>();
  const profileRoot = path.join(root, 'profile');
  const childAppData = path.join(profileRoot, 'AppData', 'Roaming');
  const childLocalAppData = path.join(profileRoot, 'AppData', 'Local');
  for (const directory of [profileRoot, childTemp, childAppData, childLocalAppData, path.dirname(paths.startupEntry)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const allowedFaultEnvironment = new Set([
    'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_AUTHORITY_PROBE',
    'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_BUSINESS_DISPATCH',
    'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_FAIL_PROMOTION_PREPARED',
    'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_PROMOTED_HOLD_MS',
    'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_WORKER_A_QUIESCED_HOLD_MS',
    'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_TERMINALIZING_HOLD_MS',
    'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_ROLLBACK_HOLD_MS'
  ]);
  for (const key of Object.keys(options.faultEnvironment || {})) {
    assert.ok(allowedFaultEnvironment.has(key), `unapproved fault environment key: ${key}`);
  }
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
    TEMP: childTemp,
    TMP: childTemp,
    USERPROFILE: profileRoot,
    HOME: profileRoot,
    APPDATA: childAppData,
    LOCALAPPDATA: childLocalAppData,
    NODE_ENV: 'test',
    NODE_PATH: path.join(repository, 'node_modules'),
    OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: paths.installRoot,
    OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: paths.dataRoot,
    OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY: paths.startupEntry,
    OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_TOKEN: token,
    OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_HOST_TEMP_ROOT: hostTempRoot,
    OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_OWNER_LEASE_MS: '500',
    OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_MAINTENANCE_HOLD_MS: '1500',
    ...options.faultEnvironment
  };
  assert.equal(environment.APPDATA, childAppData);
  assert.equal(environment.LOCALAPPDATA, childLocalAppData);
  assert.equal(environment.USERPROFILE, profileRoot);
  assert.equal(environment.HOME, profileRoot);
  assert.equal(environment.OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY, paths.startupEntry);
  const startGuardian = () => {
    assertIsolatedFixture(root, paths.installRoot, paths.dataRoot, paths.startupEntry, token);
    guardian = spawn(path.join(paths.bootstrap, 'node.exe'), [path.join(paths.bootstrap, 'guardian.cjs'), '--run-guardian'], {
      cwd: portableRoot, env: environment, windowsHide: true, stdio: 'ignore'
    });
    return guardian;
  };
  const sameFixtureProcess = (pid: number, identity: OwnedProcess): boolean => {
    if (!alive(pid)) { unverifiedOwned.delete(pid); return false; }
    const startedAt = processStartTimeUtc(pid);
    const executablePath = processExecutablePath(pid);
    if (!startedAt || !executablePath) {
      unverifiedOwned.set(pid, { role: identity.role, token: identity.token, reason: 'birth_or_executable_probe_unknown' });
      return true;
    }
    unverifiedOwned.delete(pid);
    if (startedAt !== identity.startedAt) return false;
    return executablePath === identity.executablePath
      && executablePath.startsWith(`${path.resolve(root)}${path.sep}`);
  };
  const authorityMatches = (pid: number, identity: OwnedProcess): boolean => {
    const now = Date.now();
    if (identity.role === 'guardian') {
      const lock = readRecord(paths.guardianLock);
      const lockCreatedAt = Date.parse(String(lock?.createdAt || ''));
      const processStartedAt = Date.parse(identity.startedAt);
      return lock?.schemaVersion === 'omnia.v5.remote-connector-mutex/v1'
        && Number(lock?.pid) === pid && lock?.token === identity.token
        && Number.isFinite(lockCreatedAt) && Number.isFinite(processStartedAt)
        && processStartedAt <= lockCreatedAt;
    }
    if (identity.role === 'supervisor') {
      const lock = readRecord(paths.supervisorLock);
      const heartbeat = readRecord(paths.supervisorHeartbeat);
      const heartbeatAt = Date.parse(String(heartbeat?.heartbeatAt || ''));
      return lock?.schemaVersion === 'omnia.v5.remote-connector-supervisor-lock/v2'
        && heartbeat?.schemaVersion === 'omnia.v5.remote-connector-supervisor-heartbeat/v2'
        && lock?.product === REMOTE_CONNECTOR_PRODUCT && heartbeat?.product === REMOTE_CONNECTOR_PRODUCT
        && Number(lock?.pid) === pid && lock?.token === identity.token
        && Number(heartbeat?.pid) === pid && heartbeat?.token === identity.token
        && lock?.processStartedAt === identity.startedAt && heartbeat?.processStartedAt === identity.startedAt
        && lock?.guardianPid === heartbeat?.guardianPid && lock?.guardianToken === heartbeat?.guardianToken
        && lock?.bootstrapRevision === heartbeat?.bootstrapRevision
        && lock?.supervisorSlot === heartbeat?.supervisorSlot
        && lock?.supervisorSha256 === heartbeat?.supervisorSha256
        && lock?.transactionId === heartbeat?.transactionId
        && Number.isFinite(heartbeatAt) && now - heartbeatAt >= -5_000 && now - heartbeatAt <= 5_000;
    }
    const status = readRecord(path.join(paths.workerStatuses, `${identity.token}.json`));
    const claim = (() => { try { return readWorkerClaim(paths); } catch { return null; } })();
    const handoff = readRecord(paths.workerRecoveryHandoff);
    const transaction = (() => { try { return readUpdateTransaction(paths); } catch { return null; } })();
    const maintenance = (() => { try { return readWorkerMaintenance(paths); } catch { return null; } })();
    const heartbeatAt = Date.parse(String(status?.heartbeatAt || ''));
    const statusExact = status?.schemaVersion === 'omnia.v5.remote-connector-status/v1'
      && status?.product === REMOTE_CONNECTOR_PRODUCT
      && Number(status?.pid) === pid && status?.executionGeneration === identity.token
      && status?.processStartedAt === identity.startedAt
      && Number.isFinite(heartbeatAt) && now - heartbeatAt >= -5_000 && now - heartbeatAt <= 5_000;
    const claimExact = claim?.pid === pid && claim.executionGeneration === identity.token && claim.state === 'admitted';
    const handoffExact = Number(handoff?.workerPid) === pid && handoff?.executionGeneration === identity.token
      && Date.parse(String(handoff?.expiresAt || '')) > now;
    const transactionExact = [transaction?.workerA, transaction?.workerB].some(
      (worker) => worker?.pid === pid && worker.token === identity.token
        && worker.startedAt === identity.startedAt
        && worker.version === status?.version && worker.sequence === Number(status?.sequence)
    );
    const transactionIdentityPresent = [transaction?.workerA, transaction?.workerB].some(
      (worker) => worker?.pid === pid && worker.token === identity.token
    );
    const maintenanceExact = transactionExact
      && maintenance?.target.pid === pid && maintenance.target.token === identity.token
      && maintenance.acknowledgement?.pid === pid
      && maintenance.acknowledgement.executionGeneration === identity.token
      && ((status?.maintenanceState === 'quiesced' && maintenance.acknowledgement.state === 'quiesced')
        || (status?.maintenanceState === 'retiring' && maintenance.acknowledgement.state === 'retiring'));
    // Raw Worker signalling additionally requires a durable transaction birth
    // identity. A global claim/status alone can be stale across PID reuse; a
    // non-transaction Worker is stopped only through its owning Guardian child
    // handle, otherwise the evidence root is retained fail-closed.
    return statusExact && (!transactionIdentityPresent || transactionExact)
      && (claimExact || handoffExact || maintenanceExact);
  };
  const ownsFixturePid = (pid: number, identity: OwnedProcess): boolean =>
    sameFixtureProcess(pid, identity) && authorityMatches(pid, identity);
  const rememberPid = (pid: number, role: OwnedProcess['role'], token: string) => {
    if (pid <= 0 || !token) return;
    if (!alive(pid)) { unverifiedOwned.delete(pid); return; }
    const startedAt = processStartTimeUtc(pid);
    const executablePath = processExecutablePath(pid);
    if (startedAt && executablePath?.startsWith(`${path.resolve(root)}${path.sep}`)) {
      const prior = ownedPids.get(pid);
      if (!prior || prior.startedAt !== startedAt || prior.executablePath !== executablePath
        || prior.role !== role || prior.token !== token) {
        ownedPids.set(pid, { startedAt, executablePath, role, token });
      }
      unverifiedOwned.delete(pid);
    } else {
      unverifiedOwned.set(pid, { role, token, reason: 'fixture_pid_identity_probe_unknown_or_outside_root' });
    }
  };
  const killOwned = (pid: number, signal: NodeJS.Signals) => {
    observePids();
    const identity = ownedPids.get(pid);
    assert.ok(identity && ownsFixturePid(pid, identity),
      `refused to ${signal} PID ${pid} without exact fixture birth and executable identity`);
    process.kill(pid, signal);
  };
  const observePids = () => {
    const status = readRecord(paths.status);
    const heartbeat = readRecord(paths.supervisorHeartbeat);
    const supervisorLock = readRecord(paths.supervisorLock);
    const guardianLock = readRecord(paths.guardianLock);
    const handoff = readRecord(paths.workerRecoveryHandoff);
    const claim = (() => { try { return readWorkerClaim(paths); } catch { return null; } })();
    const transaction = (() => { try { return readUpdateTransaction(paths); } catch { return null; } })();
    rememberPid(Number(guardianLock?.pid || 0), 'guardian', String(guardianLock?.token || ''));
    rememberPid(Number(supervisorLock?.pid || 0), 'supervisor', String(supervisorLock?.token || ''));
    rememberPid(Number(heartbeat?.pid || 0), 'supervisor', String(heartbeat?.token || ''));
    rememberPid(Number(status?.pid || 0), 'worker', String(status?.executionGeneration || ''));
    rememberPid(Number(claim?.pid || 0), 'worker', String(claim?.executionGeneration || ''));
    rememberPid(Number(handoff?.workerPid || 0), 'worker', String(handoff?.executionGeneration || ''));
    rememberPid(Number(transaction?.workerA?.pid || 0), 'worker', String(transaction?.workerA?.token || ''));
    rememberPid(Number(transaction?.workerB?.pid || 0), 'worker', String(transaction?.workerB?.token || ''));
    try {
      for (const entry of fs.readdirSync(paths.workerStatuses, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{48}\.json$/u.test(entry.name)) continue;
        const generationStatus = readRecord(path.join(paths.workerStatuses, entry.name));
        rememberPid(Number(generationStatus?.pid || 0), 'worker', String(generationStatus?.executionGeneration || ''));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  let preserveFailureRoot = false;
  const evidence = (scenario: string, error: unknown) => {
    preserveFailureRoot = true;
    observePids();
    const value = {
      scenario,
      error: error instanceof Error ? error.message : String(error),
      capturedAt: new Date().toISOString(),
      root,
      ownedPids: [...ownedPids.entries()].map(([pid, identity]) => ({ pid, ...identity })),
      unverifiedOwnedPids: [...unverifiedOwned.entries()].map(([pid, identity]) => ({ pid, ...identity })),
      liveOwnedPids: [...ownedPids.entries()].filter(([pid, identity]) => sameFixtureProcess(pid, identity))
        .map(([pid]) => pid),
      signalableOwnedPids: [...ownedPids.entries()].filter(([pid, identity]) => ownsFixturePid(pid, identity))
        .map(([pid]) => pid),
      guardianLock: readRecord(paths.guardianLock),
      supervisorLock: readRecord(paths.supervisorLock),
      supervisorHeartbeat: readRecord(paths.supervisorHeartbeat),
      status: readRecord(paths.status),
      workerClaim: (() => { try { return readWorkerClaim(paths); } catch (claimError) { return { error: String(claimError) }; } })(),
      workerRecoveryHandoff: readRecord(paths.workerRecoveryHandoff),
      managedState: readRecord(paths.state),
      bootstrapState: readRecord(paths.bootstrapState),
      updateTransaction: readUpdateTransaction(paths),
      workerMaintenance: readWorkerMaintenance(paths),
      rollbackBarrier: (() => { try { return readRollbackBarrier(paths); } catch (barrierError) { return { error: String(barrierError) }; } })(),
      defaultStartupBefore,
      defaultStartupAfter: fileSnapshot(defaultStartupEntry),
      forbiddenRealRoots,
      fixtureInventory: treeSnapshot(root)
    };
    const target = path.join(os.tmpdir(), `omnia-remote-update-failure-evidence-${scenario}-${Date.now()}.json`);
    fs.writeFileSync(target, JSON.stringify(value, null, 2));
    return target;
  };
  t.after(async () => {
    assertIsolatedFixture(root, paths.installRoot, paths.dataRoot, paths.startupEntry, token);
    const directGuardian = guardian;
    if (directGuardian && directGuardian.exitCode === null && directGuardian.signalCode === null) {
      directGuardian.kill('SIGTERM');
      const terminated = await new Promise<boolean>((resolve) => {
        if (directGuardian.exitCode !== null || directGuardian.signalCode !== null) return resolve(true);
        const timeout = setTimeout(() => resolve(false), 5_000);
        directGuardian.once('exit', () => { clearTimeout(timeout); resolve(true); });
      });
      if (!terminated && directGuardian.exitCode === null && directGuardian.signalCode === null) {
        directGuardian.kill('SIGKILL');
        const killed = await new Promise<boolean>((resolve) => {
          if (directGuardian.exitCode !== null || directGuardian.signalCode !== null) return resolve(true);
          const timeout = setTimeout(() => resolve(false), 5_000);
          directGuardian.once('exit', () => { clearTimeout(timeout); resolve(true); });
        });
        if (!killed && directGuardian.exitCode === null && directGuardian.signalCode === null) {
          preserveFailureRoot = true;
          throw new Error('Direct fixture Guardian ChildProcess did not exit after bounded owned-handle termination.');
        }
      }
    }
    observePids();
    for (const [pid, identity] of ownedPids) {
      if (ownsFixturePid(pid, identity)) try { killOwned(pid, 'SIGTERM'); } catch { /* retained as failure evidence below */ }
    }
    const gracefulDeadline = Date.now() + 5_000;
    while ([...ownedPids].some(([pid, identity]) => sameFixtureProcess(pid, identity)) && Date.now() < gracefulDeadline) {
      observePids();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const [pid, identity] of ownedPids) {
      if (ownsFixturePid(pid, identity)) try { killOwned(pid, 'SIGKILL'); } catch { /* retained as failure evidence below */ }
    }
    const forcedDeadline = Date.now() + 5_000;
    while ([...ownedPids].some(([pid, identity]) => sameFixtureProcess(pid, identity)) && Date.now() < forcedDeadline) {
      observePids();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let stableRound = 0; stableRound < 3; stableRound += 1) {
      observePids();
      const latePids = [...ownedPids].filter(([pid, identity]) => sameFixtureProcess(pid, identity));
      for (const [pid, identity] of latePids) {
        if (ownsFixturePid(pid, identity)) try { killOwned(pid, 'SIGKILL'); } catch { /* retained as failure evidence below */ }
      }
      if (latePids.length > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.deepEqual([...ownedPids].filter(([pid, identity]) => sameFixtureProcess(pid, identity)), [],
      'every exact birth-bound fixture PID must exit before root cleanup');
    if (unverifiedOwned.size > 0) preserveFailureRoot = true;
    assert.deepEqual([...unverifiedOwned.entries()], [],
      'fixture PIDs with unknown birth or executable identity must preserve the evidence root');
    assert.deepEqual(fileSnapshot(defaultStartupEntry), defaultStartupBefore,
      'isolated fault scenarios must never change the exact default Windows Startup entry');
    if (!preserveFailureRoot) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
  const ownedBirthAlive = (pid: number): boolean => {
    const identity = ownedPids.get(pid);
    return Boolean(identity && sameFixtureProcess(pid, identity));
  };
  return { root, token, paths, startGuardian, observePids, killOwned, ownedBirthAlive, evidence, currentGuardian: () => guardian };
}

function requestCandidateUpdate(paths: ReturnType<typeof resolveRemoteConnectorPaths>): string {
  const transaction = createUpdateTransaction(paths,
    { version: '0.3.36', sequence: 39, supervisorVersion: '0.1.7' },
    { version: '0.3.37', sequence: 40, supervisorVersion: '0.1.8' });
  fs.writeFileSync(paths.updateRequest, new Date().toISOString());
  return transaction.transactionId;
}

test('isolated real Guardian SIGKILL recovery preserves one Worker claim', { timeout: 65_000 }, async (t) => {
  const fixture = await buildSignedFixture(t);
  let guardian = fixture.startGuardian();
  try {
    const initial = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      if (!status || !heartbeat) return null;
      return status.maintenanceState === 'running' && status.workerClaimHeld === true
        && Number(status.pid) > 0 && Number(heartbeat.pid) > 0 ? { status, heartbeat } : null;
    }, 15_000, 'initial real Worker admission');
    const killedGuardianPid = Number(guardian.pid);
    const oldSupervisorPid = Number(initial.heartbeat.pid);
    const oldWorkerPid = Number(initial.status.pid);
    fixture.killOwned(killedGuardianPid, 'SIGKILL');
    guardian = fixture.startGuardian();
    const recovered = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      const claim = readWorkerClaim(fixture.paths);
      if (!status || !heartbeat) return null;
      return Number(heartbeat.guardianPid) === Number(guardian.pid)
        && Number(heartbeat.pid) > 0 && Number(heartbeat.pid) !== oldSupervisorPid
        && Number(status.pid) > 0 && Number(status.pid) !== oldWorkerPid
        && status.workerClaimHeld === true && status.maintenanceState === 'running'
        && claim?.executionGeneration === status.executionGeneration
        ? { status, heartbeat } : null;
    }, 42_000, 'Guardian SIGKILL recovery');
    assert.equal(fixture.ownedBirthAlive(killedGuardianPid), false);
    assert.equal(fixture.ownedBirthAlive(oldSupervisorPid), false);
    assert.equal(fixture.ownedBirthAlive(oldWorkerPid), false);
    assert.equal(recovered.status.businessAdmissions, 0);
  } catch (error) {
    const evidencePath = fixture.evidence('guardian-kill', error);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${evidencePath}`);
  }
});

test('isolated real Supervisor SIGKILL recovery seals the orphan before replacement', { timeout: 50_000 }, async (t) => {
  const fixture = await buildSignedFixture(t);
  const guardian = fixture.startGuardian();
  try {
    const initial = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      if (!status || !heartbeat) return null;
      return status.maintenanceState === 'running' && status.workerClaimHeld === true
        && Number(status.pid) > 0 && Number(heartbeat.pid) > 0 ? { status, heartbeat } : null;
    }, 15_000, 'initial real Worker admission');
    const killedSupervisorPid = Number(initial.heartbeat.pid);
    const oldWorkerPid = Number(initial.status.pid);
    fixture.killOwned(killedSupervisorPid, 'SIGKILL');
    const recovered = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      const claim = readWorkerClaim(fixture.paths);
      if (!status || !heartbeat) return null;
      return Number(heartbeat.guardianPid) === Number(guardian.pid)
        && Number(heartbeat.pid) > 0 && Number(heartbeat.pid) !== killedSupervisorPid
        && Number(status.pid) > 0 && Number(status.pid) !== oldWorkerPid
        && status.workerClaimHeld === true && status.maintenanceState === 'running'
        && claim?.executionGeneration === status.executionGeneration
        ? { status, heartbeat } : null;
    }, 25_000, 'Supervisor SIGKILL recovery');
    assert.equal(fixture.ownedBirthAlive(killedSupervisorPid), false);
    assert.equal(fixture.ownedBirthAlive(oldWorkerPid), false);
    assert.equal(recovered.status.businessAdmissions, 0);
  } catch (error) {
    const evidencePath = fixture.evidence('supervisor-kill', error);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${evidencePath}`);
  }
});

test('isolated interleaved Guardian and Supervisor SIGKILL recovers one generation', { timeout: 65_000 }, async (t) => {
  const fixture = await buildSignedFixture(t);
  let guardian = fixture.startGuardian();
  try {
    const initial = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      if (!status || !heartbeat) return null;
      return status.maintenanceState === 'running' && status.workerClaimHeld === true
        && Number(status.pid) > 0 && Number(heartbeat.pid) > 0 ? { status, heartbeat } : null;
    }, 15_000, 'initial real Worker admission');
    const killedGuardianPid = Number(guardian.pid);
    const killedSupervisorPid = Number(initial.heartbeat.pid);
    const oldWorkerPid = Number(initial.status.pid);
    fixture.killOwned(killedGuardianPid, 'SIGKILL');
    fixture.killOwned(killedSupervisorPid, 'SIGKILL');
    guardian = fixture.startGuardian();
    const recovered = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      const claim = readWorkerClaim(fixture.paths);
      if (!status || !heartbeat) return null;
      return Number(heartbeat.guardianPid) === Number(guardian.pid)
        && Number(heartbeat.pid) > 0 && Number(heartbeat.pid) !== killedSupervisorPid
        && Number(status.pid) > 0 && Number(status.pid) !== oldWorkerPid
        && status.workerClaimHeld === true && status.maintenanceState === 'running'
        && claim?.executionGeneration === status.executionGeneration
        ? { status, heartbeat } : null;
    }, 42_000, 'interleaved Guardian/Supervisor SIGKILL recovery');
    assert.equal(fixture.ownedBirthAlive(killedGuardianPid), false);
    assert.equal(fixture.ownedBirthAlive(killedSupervisorPid), false);
    assert.equal(fixture.ownedBirthAlive(oldWorkerPid), false);
    assert.equal(recovered.status.businessAdmissions, 0);
  } catch (error) {
    const evidencePath = fixture.evidence('interleaved-kill', error);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${evidencePath}`);
  }
});

test('real Worker traverses running, draining, quiesced, resumed, and retiring with exact claim state', { timeout: 45_000 }, async (t) => {
  const fixture = await buildSignedFixture(t);
  fixture.startGuardian();
  try {
    const running = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      return status?.maintenanceState === 'running' && status.workerClaimHeld === true ? status : null;
    }, 15_000, 'running Worker');
    assert.equal(running.businessAdmissions, 0);
    const transactionId = 'c'.repeat(48);
    const epoch = 'd'.repeat(48);
    const ownerGuardianToken = 'e'.repeat(48);
    const target = {
      pid: Number(running.pid), token: String(running.executionGeneration), version: '0.3.36', sequence: 39
    };
    const generationStatusPath = path.join(fixture.paths.workerStatuses, `${target.token}.json`);
    writeWorkerMaintenance(fixture.paths, {
      schemaVersion: 'omnia.v5.connector-worker-maintenance/v2', revision: 0,
      transactionId, epoch, ownerGuardianToken, target,
      action: 'quiesce', requestedAt: new Date().toISOString(), acknowledgement: null
    });
    const draining = await waitFor(() => {
      const status = readRecord(generationStatusPath);
      const maintenance = readWorkerMaintenance(fixture.paths);
      return status?.maintenanceState === 'draining'
        && maintenance?.acknowledgement?.state === 'draining' ? status : null;
    }, 8_000, 'draining Worker');
    assert.equal(draining.admissionClosed, true);
    const quiesced = await waitFor(() => {
      const status = readRecord(generationStatusPath);
      const maintenance = readWorkerMaintenance(fixture.paths);
      return status?.maintenanceState === 'quiesced' && status.workerClaimHeld === false
        && maintenance?.acknowledgement?.state === 'quiesced' ? status : null;
    }, 8_000, 'quiesced Worker');
    assert.equal(quiesced.admissionSealed, true);
    assert.equal(readWorkerClaim(fixture.paths), null);

    let maintenance = readWorkerMaintenance(fixture.paths)!;
    writeWorkerMaintenance(fixture.paths, {
      ...maintenance, revision: maintenance.revision, action: 'resume',
      requestedAt: new Date().toISOString(), acknowledgement: null
    });
    const resumed = await waitFor(() => {
      const status = readRecord(generationStatusPath);
      return status?.maintenanceState === 'running' && status.workerClaimHeld === true ? status : null;
    }, 8_000, 'resumed Worker');
    assert.equal(resumed.executionGeneration, running.executionGeneration);
    assert.equal(resumed.businessAdmissions, 0);

    maintenance = readWorkerMaintenance(fixture.paths)!;
    writeWorkerMaintenance(fixture.paths, {
      ...maintenance, revision: maintenance.revision, action: 'retire',
      requestedAt: new Date().toISOString(), acknowledgement: null
    });
    const retiring = await waitFor(() => {
      const status = readRecord(generationStatusPath);
      const record = readWorkerMaintenance(fixture.paths);
      return status?.maintenanceState === 'retiring'
        && record?.acknowledgement?.state === 'retiring' ? status : null;
    }, 8_000, 'retiring Worker');
    assert.equal(retiring.admissionClosed, true);
    await waitFor(() => !fixture.ownedBirthAlive(Number(running.pid)) ? true : null, 8_000, 'retired Worker exit');
  } catch (error) {
    const evidencePath = fixture.evidence('maintenance-states', error);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${evidencePath}`);
  }
});

test('real cold-baseline Worker remains closing_admission with zero business admissions', { timeout: 30_000 }, async (t) => {
  const fixture = await buildSignedFixture(t, { baselinePhase: 'promoted' });
  fixture.startGuardian();
  try {
    const closing = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      return status?.maintenanceState === 'closing_admission'
        && status.admissionClosed === true && status.admissionSealed === true
        && status.workerClaimHeld === true ? status : null;
    }, 15_000, 'sealed cold-baseline Worker');
    assert.equal(closing.businessAdmissions, 0);
    assert.equal(closing.probationProbe?.state, 'pending');
    assert.equal(readWorkerClaim(fixture.paths)?.executionGeneration, closing.executionGeneration);
  } catch (error) {
    const evidencePath = fixture.evidence('closing-admission', error);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${evidencePath}`);
  }
});

test('real A/B terminalizing survives Supervisor SIGKILL and a durable barrier only rolls forward', { timeout: 90_000 }, async (t) => {
  const fixture = await buildSignedFixture(t, {
    candidate: true,
    faultEnvironment: {
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_AUTHORITY_PROBE: '1',
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_BUSINESS_DISPATCH: '1',
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_PROMOTED_HOLD_MS: '5000',
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_TERMINALIZING_HOLD_MS: '5000'
    }
  });
  fixture.startGuardian();
  try {
    await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      return status?.version === '0.3.36' && status.maintenanceState === 'running'
        && status.workerClaimHeld === true ? status : null;
    }, 15_000, 'Worker A running before terminalizing fault');
    const transactionId = requestCandidateUpdate(fixture.paths);
    const terminalizing = await waitFor(() => {
      fixture.observePids();
      const transaction = readUpdateTransaction(fixture.paths);
      const status = transaction?.workerA ? readRecord(transaction.workerA.statusPath) : null;
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      if (transaction?.transactionId !== transactionId || transaction.phase !== 'terminalizing'
        || !transaction.workerA || !transaction.workerB || status?.version !== '0.3.37'
        || status.maintenanceState !== 'running' || status.businessAdmissions !== 1
        || readRollbackBarrier(fixture.paths)?.transactionId !== transactionId
        || Number(heartbeat?.pid || 0) <= 0) return null;
      return { transaction, status, heartbeat };
    }, 35_000, 'real candidate terminalizing hold');
    const killedSupervisorPid = Number(terminalizing.heartbeat!.pid);
    fixture.killOwned(killedSupervisorPid, 'SIGKILL');
    const completed = await waitFor(() => {
      fixture.observePids();
      const transaction = readUpdateTransaction(fixture.paths);
      const state = readManagedState(fixture.paths);
      const bootstrap = readRecord(fixture.paths.bootstrapState);
      const status = readRecord(fixture.paths.status);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      const claim = readWorkerClaim(fixture.paths);
      if (transaction?.phase !== 'completed' || state.current !== '0.3.37'
        || state.transitionId !== '' || bootstrap?.active?.version !== '0.1.8'
        || bootstrap?.previous !== null || status?.version !== '0.3.37'
        || status.maintenanceState !== 'running' || status.workerClaimHeld !== true
        || status.businessAdmissions !== 1 || !transaction.workerA || !transaction.workerB
        || transaction.workerB.pid !== Number(status.pid)
        || transaction.workerB.token !== status.executionGeneration
        || claim?.pid !== Number(status.pid) || claim.executionGeneration !== status.executionGeneration
        || Number(heartbeat?.workerPid) !== Number(status.pid)
        || Number(heartbeat?.pid || 0) <= 0
        || Date.now() - Date.parse(String(status.heartbeatAt || '')) > 5_000) return null;
      return { transaction, status, heartbeat };
    }, 35_000, 'terminalizing restart roll-forward completion');
    assert.equal(fixture.ownedBirthAlive(killedSupervisorPid), false);
    assert.equal(fixture.ownedBirthAlive(completed.transaction.workerA!.pid), false);
    assert.equal(fixture.ownedBirthAlive(terminalizing.transaction.workerB!.pid), false);
    assert.equal(fixture.ownedBirthAlive(completed.transaction.workerB!.pid), true);
    assert.equal(fixture.ownedBirthAlive(Number(completed.heartbeat!.pid)), true);
    assert.equal(readRollbackBarrier(fixture.paths), null);
    const barrierHistory = path.join(fixture.paths.dataRoot, 'rollback-barrier-history');
    assert.ok(fs.readdirSync(barrierHistory).some((name) => name.startsWith(`${transactionId}-`)));
    const bootstrap = readRecord(fixture.paths.bootstrapState)!;
    assert.equal(Object.values(bootstrap.completedRequests || {}).some(
      (entry: any) => entry.transactionId === transactionId && entry.outcome === 'rolled_back'
    ), false);
  } catch (error) {
    const evidencePath = fixture.evidence('terminalizing-barrier-kill', error);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${evidencePath}`);
  }
});

test('real rollback_requested survives interleaved Guardian and Supervisor SIGKILL', { timeout: 100_000 }, async (t) => {
  const fixture = await buildSignedFixture(t, {
    candidate: true,
    faultEnvironment: {
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_AUTHORITY_PROBE: '1',
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_BUSINESS_DISPATCH: '1',
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_FAIL_PROMOTION_PREPARED: '1',
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_WORKER_A_QUIESCED_HOLD_MS: '5000',
      OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_ROLLBACK_HOLD_MS: '5000'
    }
  });
  let guardian = fixture.startGuardian();
  try {
    const workerA = await waitFor(() => {
      fixture.observePids();
      const status = readRecord(fixture.paths.status);
      return status?.version === '0.3.36' && status.maintenanceState === 'running'
        && status.workerClaimHeld === true ? status : null;
    }, 15_000, 'Worker A running before rollback fault');
    const transactionId = requestCandidateUpdate(fixture.paths);
    const quiescedA = await waitFor(() => {
      fixture.observePids();
      const transaction = readUpdateTransaction(fixture.paths);
      const status = transaction?.workerA ? readRecord(transaction.workerA.statusPath) : null;
      if (transaction?.transactionId !== transactionId || transaction.phase !== 'worker_a_quiesced'
        || !transaction.workerA || Number(status?.pid) !== transaction.workerA.pid
        || status?.executionGeneration !== transaction.workerA.token
        || status.maintenanceState !== 'quiesced' || status.workerClaimHeld !== false) return null;
      return transaction.workerA;
    }, 20_000, 'exact quiesced Worker A before rollback replacement fault');
    const killedWorkerAPid = quiescedA.pid;
    fixture.killOwned(killedWorkerAPid, 'SIGKILL');
    await waitFor(() => !fixture.ownedBirthAlive(killedWorkerAPid) ? true : null, 5_000, 'explicit old Worker A exit');
    const rollback = await waitFor(() => {
      fixture.observePids();
      const transaction = readUpdateTransaction(fixture.paths);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      if (transaction?.transactionId !== transactionId || transaction.phase !== 'rollback_requested'
        || !transaction.workerA || !transaction.workerB || Number(heartbeat?.pid || 0) <= 0) return null;
      return { transaction, heartbeat };
    }, 35_000, 'rollback_requested durable hold');
    const killedGuardianPid = Number(guardian.pid);
    const killedSupervisorPid = Number(rollback.heartbeat!.pid);
    fixture.killOwned(killedGuardianPid, 'SIGKILL');
    fixture.killOwned(killedSupervisorPid, 'SIGKILL');
    guardian = fixture.startGuardian();
    const rolledBack = await waitFor(() => {
      fixture.observePids();
      const transaction = readUpdateTransaction(fixture.paths);
      const state = readManagedState(fixture.paths);
      const bootstrap = readRecord(fixture.paths.bootstrapState);
      const status = readRecord(fixture.paths.status);
      const heartbeat = readRecord(fixture.paths.supervisorHeartbeat);
      const claim = readWorkerClaim(fixture.paths);
      if (transaction?.phase !== 'rolled_back' || state.current !== '0.3.36'
        || state.pending !== null || state.transitionId !== ''
        || state.blocked['0.3.37']?.sequence !== 40
        || bootstrap?.active?.version !== '0.1.7' || bootstrap?.previous !== null
        || status?.version !== '0.3.36' || status.maintenanceState !== 'running'
        || status.businessAdmissions !== 1
        || status.workerClaimHeld !== true || !transaction.workerA || !transaction.workerB
        || transaction.workerA.pid !== Number(status.pid)
        || transaction.workerA.token !== status.executionGeneration
        || claim?.pid !== Number(status.pid) || claim.executionGeneration !== status.executionGeneration
        || Number(heartbeat?.workerPid) !== Number(status.pid)
        || Number(heartbeat?.pid || 0) <= 0
        || Date.now() - Date.parse(String(status.heartbeatAt || '')) > 5_000) return null;
      return { transaction, status, heartbeat };
    }, 50_000, 'rollback restart exact completion');
    assert.equal(fixture.ownedBirthAlive(killedGuardianPid), false);
    assert.equal(fixture.ownedBirthAlive(killedSupervisorPid), false);
    assert.equal(Number(workerA.pid), killedWorkerAPid);
    assert.notEqual(rolledBack.transaction.workerA?.pid, killedWorkerAPid);
    assert.equal(fixture.ownedBirthAlive(killedWorkerAPid), false);
    assert.equal(fixture.ownedBirthAlive(rolledBack.transaction.workerB!.pid), false);
    assert.equal(fixture.ownedBirthAlive(rolledBack.transaction.workerA!.pid), true);
    assert.equal(fixture.ownedBirthAlive(Number(rolledBack.heartbeat!.pid)), true);
    assert.equal(readRollbackBarrier(fixture.paths), null);
  } catch (error) {
    const evidencePath = fixture.evidence('rollback-interleaved-kill', error);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${evidencePath}`);
  }
});
