import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const previousVersion = '0.3.33';
const currentVersion = '0.3.35';
const previousPackage = path.join(root, 'remote-connector', 'releases', previousVersion, `Omnia-Agent-v5-Remote-Connector-v${previousVersion}-Portable`);
const currentPackage = path.join(root, 'remote-connector', 'releases', currentVersion, `Omnia-Agent-v5-Remote-Connector-v${currentVersion}-Portable`);
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-remote-connector-upgrade-'));
const installRoot = path.join(smokeRoot, 'install');
const dataRoot = path.join(smokeRoot, 'data');
const statePath = path.join(dataRoot, 'managed-state.json');
const statusPath = path.join(dataRoot, 'status.json');
const credentialProbe = path.join(dataRoot, 'binding-preservation.probe');
const environment = {
  ...process.env,
  OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: installRoot,
  OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: dataRoot,
  OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY: path.join(smokeRoot, 'startup', 'Omnia Agent v5 Remote Connector.cmd')
};

function cli(portable, command) {
  const result = spawnSync(path.join(portable, 'runtime', 'node.exe'), [path.join(portable, 'app', 'cli.cjs'), command], {
    cwd: portable,
    env: environment,
    encoding: 'utf8',
    windowsHide: true
  });
  return result;
}

try {
  assert.equal(fs.existsSync(previousPackage), true, 'previous connector package is missing');
  assert.equal(fs.existsSync(currentPackage), true, 'current connector package is missing');
  let result = cli(previousPackage, 'install');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.current, previousVersion);
  assert.equal(state.highestSequence, 36);

  fs.writeFileSync(credentialProbe, 'protected-binding-bytes-must-be-preserved\n');
  fs.writeFileSync(statusPath, `${JSON.stringify({
    schemaVersion: 'omnia.v5.remote-connector-status/v1',
    product: 'omnia-agent-v5-remote-connector',
    activeOperations: 1,
    uncertainOperations: 0
  }, null, 2)}\n`);
  result = cli(currentPackage, 'install');
  assert.notEqual(result.status, 0, 'manual upgrade bypassed an active Operation');
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.current, previousVersion, 'blocked upgrade changed current');

  fs.writeFileSync(statusPath, `${JSON.stringify({
    schemaVersion: 'omnia.v5.remote-connector-status/v1',
    product: 'omnia-agent-v5-remote-connector',
    activeOperations: 0,
    uncertainOperations: 0
  }, null, 2)}\n`);
  result = cli(currentPackage, 'install');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.current, previousVersion);
  assert.equal(state.pending?.version, currentVersion);
  assert.equal(state.pending?.sequence, 38);
  assert.equal(state.highestSequence, 36);
  assert.equal(fs.readFileSync(credentialProbe, 'utf8'), 'protected-binding-bytes-must-be-preserved\n');

  const installed = path.join(installRoot, 'versions', `v${currentVersion}`);
  result = spawnSync(path.join(installed, 'runtime', 'node.exe'), [path.join(installed, 'app', 'worker.cjs'), '--health-probe'], {
    env: environment, encoding: 'utf8', windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const health = JSON.parse(result.stdout);
  assert.equal(health.version, currentVersion);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    from: previousVersion,
    to: currentVersion,
    activeOperationBlocked: true,
    dataPreserved: true,
    current: state.current,
    previous: state.previous,
    highestSequence: state.highestSequence,
    health
  }, null, 2)}\n`);
} finally {
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}
