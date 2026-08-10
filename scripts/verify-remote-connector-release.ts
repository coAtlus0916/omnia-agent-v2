import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REMOTE_CONNECTOR_DATA_DIRECTORY,
  REMOTE_CONNECTOR_INSTALL_DIRECTORY,
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_UPDATE_MANIFEST_URL,
  REMOTE_CONNECTOR_VERSION
} from '../src/remote-connector/constants.js';
import {
  sha256File,
  validateUpdateManifest,
  verifyPortableRoot
} from '../src/remote-connector/release-contract.js';

const root = path.resolve(import.meta.dirname, '..');
const releaseRoot = path.join(root, 'remote-connector', 'releases', REMOTE_CONNECTOR_VERSION);
const packageName = `Omnia-Agent-v5-Remote-Connector-v${REMOTE_CONNECTOR_VERSION}-Portable`;
const portableRoot = path.join(releaseRoot, packageName);
const archivePath = path.join(releaseRoot, `${packageName}.zip`);
const stablePath = path.join(root, 'remote-connector', 'public', 'stable.json');

const stable = validateUpdateManifest(JSON.parse(fs.readFileSync(stablePath, 'utf8')));
const portable = verifyPortableRoot(portableRoot);

assert.equal(stable.product, REMOTE_CONNECTOR_PRODUCT);
assert.equal(stable.version, REMOTE_CONNECTOR_VERSION);
assert.equal(portable.version, REMOTE_CONNECTOR_VERSION);
assert.equal(stable.sequence, portable.sequence);
assert.equal(stable.url, `https://download.example.invalid/files/v5-remote-connector/releases/${REMOTE_CONNECTOR_VERSION}/${packageName}.zip`);
assert.equal(stable.size, fs.statSync(archivePath).size);
assert.equal(stable.sha256, sha256File(archivePath));
assert.equal(REMOTE_CONNECTOR_UPDATE_MANIFEST_URL, 'https://download.example.invalid/files/v5-remote-connector/stable.json');
assert.equal(REMOTE_CONNECTOR_INSTALL_DIRECTORY, 'OmniaAgentV5RemoteConnector');
assert.equal(REMOTE_CONNECTOR_DATA_DIRECTORY, 'OmniaAgentV5RemoteConnector');

const identity = JSON.parse(fs.readFileSync(path.join(portableRoot, 'package-identity.json'), 'utf8')) as Record<string, unknown>;
assert.equal(identity.product, REMOTE_CONNECTOR_PRODUCT);
assert.equal(identity.v4Coexistence, 'isolated');
assert.equal(identity.installDirectory, REMOTE_CONNECTOR_INSTALL_DIRECTORY);
assert.equal(identity.dataDirectory, REMOTE_CONNECTOR_DATA_DIRECTORY);

for (const forbidden of [
  'connector-stable.json',
  '\\OmniaAgentConnector\\',
  '/opt/omnia-agent/current',
  'Omnia-Connector-v'
]) {
  for (const filename of portable.files.map((entry) => entry.path).filter((entry) => /\.(?:cjs|cmd|json|txt)$/i.test(entry))) {
    const body = fs.readFileSync(path.join(portableRoot, ...filename.split('/')), 'utf8');
    assert.equal(body.includes(forbidden), false, `${filename} contains the v4 identity ${forbidden}`);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  product: stable.product,
  version: stable.version,
  sequence: stable.sequence,
  sha256: stable.sha256,
  size: stable.size,
  manifest: stablePath,
  archive: archivePath
}, null, 2)}\n`);

