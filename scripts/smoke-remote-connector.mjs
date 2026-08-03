import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const stableManifest = JSON.parse(fs.readFileSync(path.join(root, 'remote-connector', 'public', 'stable.json'), 'utf8'));
const version = String(stableManifest.version);
const packageName = `Omnia-Agent-v5-Remote-Connector-v${version}-Portable`;
const portable = path.join(root, 'remote-connector', 'releases', version, packageName);
const node = path.join(portable, 'runtime', 'node.exe');
const cli = path.join(portable, 'app', 'cli.cjs');
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-remote-connector-live-smoke-'));
const installRoot = path.join(smokeRoot, 'install');
const dataRoot = path.join(smokeRoot, 'data');
const environment = {
  ...process.env,
  OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: installRoot,
  OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: dataRoot
};
const legacyRoot = path.join(String(process.env.LOCALAPPDATA || ''), 'OmniaAgentConnector');
const legacyBefore = inventory(legacyRoot);

try {
  run('start');
  const statusPath = path.join(dataRoot, 'status.json');
  const lockPath = path.join(dataRoot, 'supervisor.lock');
  await waitFor(() => fs.existsSync(statusPath) && fs.existsSync(lockPath), 15_000);
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(status.product, 'omnia-agent-v5-remote-connector');
  assert.equal(status.version, version);
  assert.equal(status.mode, 'remote');
  assert.ok(['waiting_matching', 'disconnected'].includes(status.bridgeState));
  assert.equal(status.activeOperations, 0);
  assert.equal(status.uncertainOperations, 0);
  assert.match(status.updateManifestUrl, /\/files\/v5-remote-connector\/stable\.json$/);

  run('check-update');
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(fs.existsSync(lockPath), true);

  run('stop');
  await waitFor(() => !fs.existsSync(lockPath), 15_000);
  assert.deepEqual(inventory(legacyRoot), legacyBefore);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    product: status.product,
    version: status.version,
    bridgeState: status.bridgeState,
    isolatedInstallRoot: installRoot,
    isolatedDataRoot: dataRoot,
    v4InstallRootUnchanged: true
  }, null, 2)}\n`);
} finally {
  const lockPath = path.join(dataRoot, 'supervisor.lock');
  if (fs.existsSync(lockPath)) {
    try {
      const pid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid);
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch { /* best effort for the test-owned process */ }
  }
  fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function run(command) {
  const result = spawnSync(node, [cli, command], {
    cwd: portable,
    env: environment,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function inventory(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const filename = path.join(entry.parentPath, entry.name);
      const stat = fs.statSync(filename);
      return {
        path: path.relative(directory, filename),
        directory: entry.isDirectory(),
        size: stat.size,
        modified: stat.mtimeMs
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the v5 Remote Connector smoke-test state.');
}
