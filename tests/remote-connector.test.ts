import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  REMOTE_CONNECTOR_DATA_DIRECTORY,
  REMOTE_CONNECTOR_INSTALL_DIRECTORY,
  REMOTE_CONNECTOR_UPDATE_MANIFEST_URL
} from '../src/remote-connector/constants.js';
import {
  validateUpdateManifest,
  verifyPortableRoot,
  type PortableManifest,
  type UpdateManifest
} from '../src/remote-connector/release-contract.js';
import { resolveRemoteConnectorPaths } from '../src/remote-connector/managed-state.js';

const signedUpdateFixture: UpdateManifest = {
  schemaVersion: 'omnia.v5.remote-connector-update/v1',
  product: 'omnia-agent-v5-remote-connector',
  channel: 'stable',
  platform: 'win32-x64',
  version: '9.9.9',
  sequence: 999,
  publishedAt: '2026-07-31T00:00:00.000Z',
  url: 'https://download.labcaspian.com/files/v5-remote-connector/releases/9.9.9/fixture.zip',
  sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  size: 123,
  minimumSupervisorVersion: '0.1.0',
  keyId: 'v5-remote-connector-release-2026-01',
  signature: '7x1aE7vA1YrX+1xaKRFE5G0svfIw48oj/jmsA0rFfp5izle72eCUxqwUJ9xVYsqywJsyNlDM9xCkCIqA0haQBg=='
};

const signedPortableFixture: PortableManifest = {
  schemaVersion: 'omnia.v5.remote-connector-portable/v1',
  product: 'omnia-agent-v5-remote-connector',
  version: '9.9.9',
  sequence: 999,
  platform: 'win32-x64',
  keyId: 'v5-remote-connector-release-2026-01',
  files: [{
    path: 'README.txt',
    size: 8,
    sha256: 'e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f'
  }],
  signature: '7GQ2iT00NKqA4sDIucxlmObMIz2VW0fcDGTexdchsBmj3pHhOdLRXdTyz3F55tqYy1vaMqcCWSZXPcTqk1puBw=='
};

test('v5 Remote Connector uses a signed update channel isolated from v4', () => {
  assert.equal(REMOTE_CONNECTOR_INSTALL_DIRECTORY, 'OmniaAgentV5RemoteConnector');
  assert.equal(REMOTE_CONNECTOR_DATA_DIRECTORY, 'OmniaAgentV5RemoteConnector');
  assert.equal(
    REMOTE_CONNECTOR_UPDATE_MANIFEST_URL,
    'https://download.labcaspian.com/files/v5-remote-connector/stable.json'
  );
  assert.doesNotMatch(REMOTE_CONNECTOR_UPDATE_MANIFEST_URL, /connector-stable\.json/);
  assert.equal(validateUpdateManifest(signedUpdateFixture).sequence, 999);
  assert.throws(() => validateUpdateManifest({ ...signedUpdateFixture, signature: 'AAAA' }), /signature is invalid/);
  assert.throws(
    () => validateUpdateManifest({
      ...signedUpdateFixture,
      url: 'https://agent.labcaspian.com/downloads/connector-stable.json'
    }),
    /outside the isolated v5 release path|signature/
  );
});

test('managed paths refuse the legacy v4 install and data roots', () => {
  const local = String(process.env.LOCALAPPDATA);
  const roaming = String(process.env.APPDATA);
  const paths = resolveRemoteConnectorPaths({
    installRoot: path.join(local, REMOTE_CONNECTOR_INSTALL_DIRECTORY),
    dataRoot: path.join(roaming, REMOTE_CONNECTOR_DATA_DIRECTORY)
  });
  assert.notEqual(paths.installRoot, path.join(local, 'OmniaAgentConnector'));
  assert.notEqual(paths.dataRoot, path.join(roaming, 'OmniaAgentConnector'));
  assert.throws(() => resolveRemoteConnectorPaths({
    installRoot: path.join(local, 'OmniaAgentConnector'),
    dataRoot: path.join(roaming, REMOTE_CONNECTOR_DATA_DIRECTORY)
  }), /refuses to use the v4 Connector/);
});

test('portable package verification covers signature, exact inventory, size, and SHA-256', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-remote-portable-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'README.txt'), 'fixture\n');
  fs.writeFileSync(path.join(root, 'portable-manifest.json'), JSON.stringify(signedPortableFixture));
  assert.equal(verifyPortableRoot(root).version, '9.9.9');
  fs.writeFileSync(path.join(root, 'README.txt'), 'tampered\n');
  assert.throws(() => verifyPortableRoot(root), /verification failed/);
});
