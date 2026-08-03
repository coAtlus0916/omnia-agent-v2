import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_UPDATE_MANIFEST_URL
} from './constants.js';
import {
  compareVersions,
  verifyPortableRoot
} from './release-contract.js';
import {
  ensureRemoteConnectorDirectories,
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

function installBootstrap(versionRootPath: string): void {
  const runtimeSource = path.join(versionRootPath, 'runtime', 'node.exe');
  const supervisorSource = path.join(versionRootPath, 'app', 'supervisor.cjs');
  const runtimeTarget = path.join(paths.bootstrap, 'node.exe');
  const supervisorTarget = path.join(paths.bootstrap, 'supervisor.cjs');
  const markerTarget = path.join(paths.bootstrap, 'bootstrap.json');
  if (!fs.existsSync(runtimeTarget)) fs.copyFileSync(runtimeSource, runtimeTarget, fs.constants.COPYFILE_EXCL);
  if (!fs.existsSync(supervisorTarget)) fs.copyFileSync(supervisorSource, supervisorTarget, fs.constants.COPYFILE_EXCL);
  if (!fs.existsSync(markerTarget)) {
    fs.writeFileSync(markerTarget, `${JSON.stringify({
      schemaVersion: 'omnia.v5.remote-connector-bootstrap/v1',
      product: REMOTE_CONNECTOR_PRODUCT,
      supervisorVersion: '0.1.0',
      installedAt: new Date().toISOString()
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
}

function install(): void {
  const installed = copyPortableVersion();
  installBootstrap(installed.destination);
  const state = readManagedState(paths);
  if (state.current && compareVersions(state.current, installed.version) > 0) {
    throw new Error('Manual bootstrap refuses to downgrade the managed v5 Remote Connector.');
  }
  writeManagedState(paths, {
    ...state,
    current: state.current || installed.version,
    highestSequence: Math.max(state.highestSequence, installed.sequence)
  });
  process.stdout.write(`v5 Remote Connector ${installed.version} 已安装到独立目录：${paths.installRoot}\n`);
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

function start(): void {
  install();
  const command = supervisorCommand();
  const child = spawn(command.node, [command.script], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    cwd: paths.bootstrap,
    env: workerEnvironment()
  });
  child.unref();
  process.stdout.write('v5 Remote Connector Supervisor 已启动；它不会停止、升级或复用 v4 Connector。\n');
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
  install();
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
  let bridgeUrl = String(process.argv[3] || '').trim();
  let pairingCode = String(process.argv[4] || '').trim();
  let prompt: ReturnType<typeof createInterface> | null = null;
  try {
    if (!bridgeUrl || !pairingCode) {
      prompt = createInterface({ input: process.stdin, output: process.stdout });
      if (!bridgeUrl) bridgeUrl = (await prompt.question('Bridge HTTPS 地址：')).trim();
      if (!pairingCode) pairingCode = (await prompt.question('Connector 一次性配对码：')).trim();
    }
    const result = await pairRemoteConnector({
      dataRoot: paths.dataRoot,
      bridgeUrl,
      pairingCode,
      name: `${os.hostname()} Omnia Agent v5 Remote Connector`
    });
    pairingCode = '';
    process.stdout.write(`配对成功：${result.pairId}。凭据已由 Windows DPAPI 保护；现在可直接运行 StartRemoteConnector.cmd。\n`);
  } finally {
    pairingCode = '';
    prompt?.close();
  }
}

async function main(): Promise<void> {
  const command = String(process.argv[2] || 'status').toLowerCase();
  try {
    if (command === 'install') install();
    else if (command === 'start') start();
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
