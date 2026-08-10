import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface FaultMarker {
  schemaVersion: 'omnia.v5.remote-connector-fault-test/v1';
  token: string;
  fixtureRoot: string;
  hostTempRoot: string;
  processTempRoot: string;
}

function assertIsolatedFaultTestRoot(): void {
  const installRoot = path.resolve(String(process.env.OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT || ''));
  const dataRoot = path.resolve(String(process.env.OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT || ''));
  const startupEntry = path.resolve(String(process.env.OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY || ''));
  const fixtureRoot = path.dirname(installRoot);
  const processTempRoot = path.resolve(os.tmpdir());
  const hostTempText = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_HOST_TEMP_ROOT || '');
  const hostTempRoot = path.resolve(hostTempText || '.');
  const token = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_FAULT_TEST_TOKEN || '');
  if (!path.isAbsolute(hostTempText) || !fixtureRoot.startsWith(`${hostTempRoot}${path.sep}`)
    || !path.basename(fixtureRoot).startsWith('omnia-remote-update-fault-')
    || path.dirname(dataRoot) !== fixtureRoot
    || path.basename(installRoot) !== 'install'
    || path.basename(dataRoot) !== 'data'
    || processTempRoot !== path.join(fixtureRoot, 'process-temp')
    || startupEntry !== path.join(fixtureRoot, 'startup', 'RemoteConnector.cmd')
    || !/^[a-f0-9]{48}$/u.test(token)) {
    throw new Error('Remote Connector fault-test control escaped its isolated three-layer path guard.');
  }
  let marker: FaultMarker;
  try { marker = JSON.parse(fs.readFileSync(path.join(fixtureRoot, '.fault-test-marker.json'), 'utf8')) as FaultMarker; }
  catch { throw new Error('Remote Connector fault-test marker is unavailable.'); }
  if (marker.schemaVersion !== 'omnia.v5.remote-connector-fault-test/v1' || marker.token !== token
    || path.resolve(marker.fixtureRoot || '') !== fixtureRoot
    || path.resolve(marker.hostTempRoot || '') !== hostTempRoot
    || path.resolve(marker.processTempRoot || '') !== processTempRoot) {
    throw new Error('Remote Connector fault-test marker token differs from the process environment.');
  }
}

/** Enables a production-unreachable fault point only inside the same exact,
 * token-bound temporary fixture used by process fault tests. */
export function isolatedFaultTestFlag(envName: string): boolean {
  const raw = process.env[envName];
  if (raw === undefined) return false;
  if (raw !== '1') throw new Error('Remote Connector fault-test flag must be exactly 1.');
  assertIsolatedFaultTestRoot();
  return true;
}

/** Test-only timing can be enabled only for a token-bound isolated tree under
 * the OS temp directory. Production/default roots can never satisfy all three
 * guards (temp containment, dedicated basename, exact marker token). */
export function isolatedFaultTestDuration(envName: string, fallbackMs: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return fallbackMs;
  assertIsolatedFaultTestRoot();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 250 || value > 10_000) {
    throw new Error('Remote Connector fault-test duration is outside its bounded range.');
  }
  return value;
}
