import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_BRIDGE_URL,
  REMOTE_CONNECTOR_SUPERVISOR_VERSION,
  REMOTE_CONNECTOR_UPDATE_MANIFEST_URL
} from './constants.js';
import {
  compareVersions,
  verifyPortableRoot
} from './release-contract.js';
import {
  ensureRemoteConnectorDirectories,
  ensureManagedLaunchers,
  migrateSupervisorBootstrap,
  readManagedState,
  resolveRemoteConnectorPaths,
  versionRoot,
  writeManagedState
} from './managed-state.js';
import { pairRemoteConnector } from './bridge-credential.js';

const paths = resolveRemoteConnectorPaths();
const portableRoot = path.resolve(__dirname, '..');

function copyPortableVersion(): { version: string; sequence: number; destination: string } {
  ensureRemoteConnectorDirectories(paths);
  const manifest = verifyPortableRoot(portableRoot);
  const destination = versionRoot(paths, manifest.version);
  if (fs.existsSync(destination)) {
    const existing = verifyPortableRoot(destination);
    if (existing.version !== manifest.version || existing.sequence !== manifest.sequence) {
      throw new Error('A different package already occupies this v5 Remote Connector version slot.');
    }
  } else {
    const temporary = `${destination}.${process.pid}.installing`;
    fs.cpSync(portableRoot, temporary, { recursive: true, errorOnExist: true, force: false });
    verifyPortableRoot(temporary);
    fs.renameSync(temporary, destination);
  }
  return { version: manifest.version, sequence: manifest.sequence, destination };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readJsonRecord(filename: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

function legacyPidWasReused(lock: Record<string, unknown>): boolean {
  const pid = Number(lock.pid || 0);
  const lockCreatedAt = Date.parse(String(lock.createdAt || ''));
  if (
    process.platform !== 'win32'
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isFinite(lockCreatedAt)
  ) return false;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
  ], { windowsHide: true, encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return false;
  const processStartedAt = Date.parse(String(result.stdout || '').trim());
  return Number.isFinite(processStartedAt) && processStartedAt > lockCreatedAt + 5_000;
}

function lockBelongsToLiveSupervisor(lock: Record<string, unknown> | null): boolean {
  const pid = Number(lock?.pid || 0);
  if (!lock || !processIsAlive(pid)) return false;
  const legacy = lock.schemaVersion === undefined && lock.product === undefined;
  return !legacy || !legacyPidWasReused(lock);
}

function assertOperationStateSafe(): void {
  if (fs.existsSync(paths.status)) {
    let status: { activeOperations?: number; uncertainOperations?: number };
    try { status = JSON.parse(fs.readFileSync(paths.status, 'utf8')) as typeof status; }
    catch { throw new Error('Connector status 无法验证；为避免在途命令被切换，拒绝手工升级。'); }
    if (Number(status.activeOperations || 0) > 0 || Number(status.uncertainOperations || 0) > 0) {
      throw new Error('存在 active/uncertain Operation；必须先完成或只读 reconcile，不能切换 Connector 版本。');
    }
  }
}

function assertManualActivationSafe(): void {
  assertOperationStateSafe();
  const lock = readJsonRecord(paths.supervisorLock);
  if (!lock && fs.existsSync(paths.supervisorLock)) {
    throw new Error('Supervisor lock 无法验证；为避免在途命令被切换，拒绝手工升级。');
  }
  if (lockBelongsToLiveSupervisor(lock)) {
    throw new Error('请先运行 StopRemoteConnector.cmd 并等待健康的 Connector 停止，再激活新版本。');
  }
}

function install(): void {
  const installed = copyPortableVersion();
  let state = readManagedState(paths);
  if (state.current && compareVersions(state.current, installed.version) > 0) {
    const currentRoot = versionRoot(paths, state.current);
    verifyPortableRoot(currentRoot);
    migrateSupervisorBootstrap(paths, currentRoot, { installRuntime: true, gateWaitMs: 35_000 });
    ensureManagedLaunchers(paths);
    process.stdout.write(
      `托管 Remote Connector ${state.current} 高于便携包 ${installed.version}；保留并启动托管最新版。\n`
    );
    return;
  }
  const promotesNewVersion = !state.current || compareVersions(installed.version, state.current) > 0;
  if (state.current && promotesNewVersion) assertManualActivationSafe();
  migrateSupervisorBootstrap(paths, installed.destination, { installRuntime: true, gateWaitMs: 35_000 });
  state = writeManagedState(paths, {
    ...state,
    current: promotesNewVersion ? installed.version : state.current,
    previous: state.current && promotesNewVersion ? state.current : state.previous,
    pending: promotesNewVersion ? null : state.pending,
    highestSequence: Math.max(state.highestSequence, installed.sequence)
  });
  ensureManagedLaunchers(paths);
  process.stdout.write(`v5 Remote Connector ${installed.version} 已安装并激活到独立目录：${paths.installRoot}\n`);
}

function supervisorCommand(): { node: string; script: string } {
  const node = path.join(paths.bootstrap, 'node.exe');
  const script = path.join(paths.bootstrap, 'supervisor.cjs');
  if (!fs.existsSync(node) || !fs.existsSync(script)) {
    throw new Error('v5 Remote Connector bootstrap 尚未安装。');
  }
  return { node, script };
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: paths.installRoot,
    OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: paths.dataRoot
  };
  delete environment.OMNIA_V5_REMOTE_BRIDGE_PAIRING_CODE;
  delete environment.OMNIA_V5_REMOTE_BRIDGE_TOKEN;
  delete environment.OMNIA_V5_REMOTE_PAIR_ID;
  return environment;
}

interface RuntimeHealth {
  healthy: boolean;
  reason: string;
  supervisorVersion?: string;
}

const START_HEALTH_STALE_MS = 10_000;
const START_VERIFICATION_TIMEOUT_MS = 75_000;

function runtimeHealth(expectedWorkerVersion: string, now = Date.now()): RuntimeHealth {
  const lock = readJsonRecord(paths.supervisorLock);
  const heartbeat = readJsonRecord(paths.supervisorHeartbeat);
  const status = readJsonRecord(paths.status);
  if (!lock) return { healthy: false, reason: 'Supervisor lock is missing or unreadable.' };
  if (!heartbeat) return { healthy: false, reason: 'Supervisor heartbeat is missing or unreadable.' };
  if (!status) return { healthy: false, reason: 'Worker status is missing or unreadable.' };

  const supervisorPid = Number(lock.pid || 0);
  const workerPid = Number(heartbeat.workerPid || 0);
  const supervisorHeartbeatAt = Date.parse(String(heartbeat.heartbeatAt || ''));
  const workerHeartbeatAt = Date.parse(String(status.heartbeatAt || ''));
  const supervisorVersion = String(heartbeat.supervisorVersion || '');
  if (
    lock.schemaVersion !== 'omnia.v5.remote-connector-supervisor-lock/v1'
    || lock.product !== REMOTE_CONNECTOR_PRODUCT
    || heartbeat.schemaVersion !== 'omnia.v5.remote-connector-supervisor-heartbeat/v1'
    || heartbeat.product !== REMOTE_CONNECTOR_PRODUCT
    || heartbeat.token !== lock.token
    || Number(heartbeat.pid) !== supervisorPid
  ) return { healthy: false, reason: 'Supervisor lock and heartbeat identity do not match.' };
  if (!processIsAlive(supervisorPid)) {
    return { healthy: false, reason: `Supervisor process ${supervisorPid || 'unknown'} is not running.` };
  }
  if (!Number.isFinite(supervisorHeartbeatAt) || now - supervisorHeartbeatAt < -5_000 || now - supervisorHeartbeatAt > START_HEALTH_STALE_MS) {
    return { healthy: false, reason: 'Supervisor heartbeat is stale.' };
  }
  if (!supervisorVersion || compareVersions(supervisorVersion, REMOTE_CONNECTOR_SUPERVISOR_VERSION) < 0) {
    return {
      healthy: false,
      reason: `Supervisor ${supervisorVersion || 'unknown'} is older than required ${REMOTE_CONNECTOR_SUPERVISOR_VERSION}.`
    };
  }
  if (
    status.schemaVersion !== 'omnia.v5.remote-connector-status/v1'
    || status.product !== REMOTE_CONNECTOR_PRODUCT
    || status.version !== expectedWorkerVersion
    || Number(status.pid) !== workerPid
  ) return { healthy: false, reason: 'Worker status does not match the managed version and Supervisor child identity.' };
  if (!processIsAlive(workerPid)) {
    return { healthy: false, reason: `Worker process ${workerPid || 'unknown'} is not running.` };
  }
  if (!Number.isFinite(workerHeartbeatAt) || now - workerHeartbeatAt < -5_000 || now - workerHeartbeatAt > START_HEALTH_STALE_MS) {
    return { healthy: false, reason: 'Worker heartbeat is stale.' };
  }
  return { healthy: true, reason: 'healthy', supervisorVersion };
}

async function stopForPortableUpgrade(): Promise<void> {
  assertOperationStateSafe();
  const initialLock = readJsonRecord(paths.supervisorLock);
  if (!initialLock) {
    if (fs.existsSync(paths.supervisorLock)) {
      throw new Error('Supervisor lock is unreadable; refusing portable activation without a verifiable owner.');
    }
    return;
  }
  if (!lockBelongsToLiveSupervisor(initialLock)) return;
  const supervisorPid = Number(initialLock?.pid || 0);
  const supervisorToken = initialLock?.token;
  fs.writeFileSync(paths.stopRequest, new Date().toISOString(), { encoding: 'utf8', mode: 0o600 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const currentLock = readJsonRecord(paths.supervisorLock);
    if (currentLock?.token && currentLock.token !== supervisorToken) {
      throw new Error('A different Supervisor acquired the lock while the portable upgrade was stopping the old instance.');
    }
    if (!currentLock && !processIsAlive(supervisorPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Supervisor ${supervisorPid || 'unknown'} did not exit and release its lock within 10 seconds; `
    + 'retry StartRemoteConnector.cmd after it finishes stopping or inspect supervisor.jsonl.'
  );
}

async function prepareUnhealthyRestart(): Promise<void> {
  const initialLock = readJsonRecord(paths.supervisorLock);
  if (!initialLock) {
    if (fs.existsSync(paths.supervisorLock)) {
      throw new Error('Supervisor lock is unreadable; refusing an unsafe restart.');
    }
    return;
  }
  const supervisorPid = Number(initialLock.pid || 0);
  assertOperationStateSafe();
  fs.writeFileSync(paths.stopRequest, new Date().toISOString(), { encoding: 'utf8', mode: 0o600 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(paths.supervisorLock) && !processIsAlive(supervisorPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (processIsAlive(supervisorPid) && !legacyPidWasReused(initialLock)) {
    throw new Error(
      `Supervisor ${supervisorPid || 'unknown'} is still alive after its heartbeat became unhealthy; `
      + 'refusing a duplicate start. Inspect supervisor.jsonl or stop the owned process explicitly.'
    );
  }
}

async function start(): Promise<void> {
  ensureRemoteConnectorDirectories(paths);
  const portable = verifyPortableRoot(portableRoot);
  let state = readManagedState(paths);
  if (!state.current || compareVersions(portable.version, state.current) > 0) {
    if (state.current) await stopForPortableUpgrade();
    install();
  } else if (compareVersions(portable.version, state.current) === 0) {
    const currentRoot = versionRoot(paths, state.current);
    verifyPortableRoot(currentRoot);
    migrateSupervisorBootstrap(paths, currentRoot, { installRuntime: true, gateWaitMs: 35_000 });
    ensureManagedLaunchers(paths);
  } else {
    verifyPortableRoot(versionRoot(paths, state.current));
    ensureManagedLaunchers(paths);
  }
  state = readManagedState(paths);
  const existing = runtimeHealth(state.current);
  if (existing.healthy) {
    process.stdout.write(
      `v5 Remote Connector is already healthy (Supervisor ${existing.supervisorVersion}, worker ${state.current}).\n`
    );
    return;
  }
  await prepareUnhealthyRestart();
  const recovered = runtimeHealth(state.current);
  if (recovered.healthy) {
    process.stdout.write(
      `v5 Remote Connector recovered while Start was waiting (Supervisor ${recovered.supervisorVersion}, worker ${state.current}).\n`
    );
    return;
  }
  const command = supervisorCommand();
  const deadline = Date.now() + START_VERIFICATION_TIMEOUT_MS;
  let observed = runtimeHealth(state.current);
  let nextSpawnAt = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextSpawnAt) {
      const child = spawn(command.node, [command.script], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        cwd: paths.bootstrap,
        env: workerEnvironment()
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      nextSpawnAt = Date.now() + 2_000;
    }
    observed = runtimeHealth(state.current);
    if (observed.healthy) {
      process.stdout.write(
        `v5 Remote Connector started and verified (Supervisor ${observed.supervisorVersion}, worker ${state.current}).\n`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `v5 Remote Connector did not become healthy within ${START_VERIFICATION_TIMEOUT_MS / 1_000} seconds: ${observed.reason} `
    + `Run StatusRemoteConnector.cmd and inspect ${path.join(paths.logs, 'supervisor.jsonl')}.`
  );
}

function status(): void {
  ensureRemoteConnectorDirectories(paths);
  const state = readManagedState(paths);
  let runtimeStatus: unknown = null;
  try { runtimeStatus = JSON.parse(fs.readFileSync(paths.status, 'utf8')); } catch { /* not running */ }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'omnia.v5.remote-connector-cli-status/v1',
    product: REMOTE_CONNECTOR_PRODUCT,
    installRoot: paths.installRoot,
    dataRoot: paths.dataRoot,
    updateManifestUrl: REMOTE_CONNECTOR_UPDATE_MANIFEST_URL,
    managed: state,
    runtime: runtimeStatus
  }, null, 2)}\n`);
}

function stop(): void {
  ensureRemoteConnectorDirectories(paths);
  fs.writeFileSync(paths.stopRequest, new Date().toISOString(), { encoding: 'utf8', mode: 0o600 });
  process.stdout.write('已请求停止 v5 Remote Connector；不会向 v4 Connector 发送任何信号。\n');
}

function checkUpdate(): void {
  ensureRemoteConnectorDirectories(paths);
  const state = readManagedState(paths);
  if (!state.current) install();
  const command = supervisorCommand();
  const result = spawnSync(command.node, [command.script, '--once'], {
    windowsHide: true,
    stdio: 'inherit',
    cwd: paths.bootstrap,
    env: workerEnvironment()
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`v5 Remote Connector update check failed with exit code ${result.status}.`);
}

async function pair(): Promise<void> {
  ensureRemoteConnectorDirectories(paths);
  let pairingCode = String(process.argv[3] || '').trim();
  const bridgeUrl = String(process.argv[4] || process.env.OMNIA_V5_REMOTE_BRIDGE_URL || REMOTE_CONNECTOR_BRIDGE_URL).trim();
  let prompt: ReturnType<typeof createInterface> | null = null;
  try {
    if (!pairingCode) {
      prompt = createInterface({ input: process.stdin, output: process.stdout });
      if (!pairingCode) pairingCode = (await prompt.question('Connector 一次性配对码：')).trim();
    }
    const result = await pairRemoteConnector({
      dataRoot: paths.dataRoot,
      bridgeUrl,
      pairingCode,
      name: `${os.hostname()} Omnia Agent v5 Remote Connector`
    });
    pairingCode = '';
    process.stdout.write(`候选绑定已接收：${result.pairId}。候选凭据已由 Windows DPAPI 保护；Remote Connector 在线验证成功后才会原子启用，验证失败会保留旧绑定。\n`);
  } finally {
    pairingCode = '';
    prompt?.close();
  }
}

async function main(): Promise<void> {
  const command = String(process.argv[2] || 'status').toLowerCase();
  try {
    if (command === 'install') install();
    else if (command === 'start') await start();
    else if (command === 'status') status();
    else if (command === 'stop') stop();
    else if (command === 'check-update') checkUpdate();
    else if (command === 'pair') await pair();
    else throw new Error('Usage: cli.cjs install|pair|start|status|stop|check-update');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'v5 Remote Connector command failed.'}\n`);
    process.exitCode = 1;
  }
}

void main();
