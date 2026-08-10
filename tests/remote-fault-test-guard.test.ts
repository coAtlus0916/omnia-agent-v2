import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isolatedFaultTestFlag } from '../src/remote-connector/fault-test-guard.js';

test('fault guard binds host temp, fixture root, process temp, startup, and marker token', (t) => {
  const hostTempRoot = path.resolve(os.tmpdir());
  const fixtureRoot = fs.mkdtempSync(path.join(hostTempRoot, 'omnia-remote-update-fault-'));
  const processTempRoot = path.join(fixtureRoot, 'process-temp');
  const installRoot = path.join(fixtureRoot, 'install');
  const dataRoot = path.join(fixtureRoot, 'data');
  const startupEntry = path.join(fixtureRoot, 'startup', 'RemoteConnector.cmd');
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(processTempRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, '.fault-test-marker.json'), JSON.stringify({
    schemaVersion: 'omnia.v5.remote-connector-fault-test/v1', token,
    fixtureRoot, hostTempRoot, processTempRoot
  }));
  const keys = [
    'TEMP', 'TMP', 'OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT', 'OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT',
    'OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY', 'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_TOKEN',
    'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_HOST_TEMP_ROOT', 'OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_PROBE'
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      const value = before[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    TEMP: processTempRoot,
    TMP: processTempRoot,
    OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: installRoot,
    OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: dataRoot,
    OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY: startupEntry,
    OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_TOKEN: token,
    OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_HOST_TEMP_ROOT: hostTempRoot,
    OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_PROBE: '1'
  });
  assert.equal(isolatedFaultTestFlag('OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_PROBE'), true);
  process.env.OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_HOST_TEMP_ROOT = processTempRoot;
  assert.throws(
    () => isolatedFaultTestFlag('OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_PROBE'),
    /escaped its isolated three-layer path guard/
  );
});
