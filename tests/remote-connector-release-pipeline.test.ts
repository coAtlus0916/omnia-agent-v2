import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { buildRemoteConnector } from '../scripts/build-remote-connector.mjs';
import {
  promoteRemoteConnectorCandidate,
  REMOTE_CONNECTOR_RELEASE
} from '../scripts/promote-remote-connector-candidate.mjs';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const portableName = `Omnia-Agent-v5-Remote-Connector-v${REMOTE_CONNECTOR_RELEASE.version}-Portable`;
const archiveName = `${portableName}.zip`;

test('Connector-only build writes only its temporary output and excludes Feature and Bridge sources', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-connector-only-build-test-'));
  const outputRoot = path.join(temporaryRoot, 'output');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const sharedDist = path.join(workspaceRoot, 'dist');
  const before = snapshotTree(sharedDist);

  const result = await buildRemoteConnector(outputRoot);

  assert.deepEqual(fs.readdirSync(outputRoot).sort(), ['cli.cjs', 'guardian.cjs', 'supervisor.cjs', 'worker.cjs']);
  assert.equal(path.dirname(outputRoot), temporaryRoot);
  assert.deepEqual(snapshotTree(sharedDist), before);
  assert.ok(result.inputs.includes('src/remote-connector/cli.ts'));
  assert.ok(result.inputs.includes('src/remote-connector/guardian.ts'));
  assert.ok(result.inputs.includes('src/remote-connector/supervisor.ts'));
  assert.ok(result.inputs.includes('src/remote-connector/worker.ts'));
  assert.equal(result.inputs.some((input) => input.startsWith('feature-packages/')), false);
  assert.equal(result.inputs.some((input) => input.startsWith('src/bridge/')), false);
  assert.deepEqual(
    result.inputs.filter((input) => input.startsWith('src/main/')),
    ['src/main/features/official-package.ts']
  );
  assert.equal(result.inputs.some((input) => input.startsWith('src/renderer/')), false);
});

test('candidate packager is locked to the 0.3.36/39/0.1.7 local baseline and has no publication branch', () => {
  const source = fs.readFileSync(path.join(workspaceRoot, 'scripts', 'package-remote-connector.mjs'), 'utf8');
  assert.match(source, /const version = '0\.3\.36';/);
  assert.match(source, /const sequence = 39;/);
  assert.match(source, /const supervisorVersion = '0\.1\.7';/);
  assert.match(source, /'guardian\.cjs'/);
  assert.match(source, /const candidateOutputRoot = path\.join\(root, 'remote-connector', 'candidates'\);/);
  assert.match(source, /minimumSupervisorVersion: supervisorVersion/);
  assert.match(source, /cpython-3\.13\.14-embed-amd64/);
  assert.match(source, /spawnSync\(\s*managedPython,/);
  assert.doesNotMatch(source, /candidateOnly\s*=/);
  assert.doesNotMatch(source, /\|\|\s*'python(?:\.exe)?'/);
  assert.doesNotMatch(source, /fs\.renameSync\([^\n]*stableManifestPath/);
  assert.doesNotMatch(source, /fs\.copyFileSync\([^\n]*publicZipPath/);
  const promotionSource = fs.readFileSync(
    path.join(workspaceRoot, 'scripts', 'promote-remote-connector-candidate.mjs'),
    'utf8'
  );
  assert.doesNotMatch(promotionSource, /node:(?:http|https|net)|\bfetch\s*\(|\bcurl(?:\.exe)?\b|\bssh\b|\bscp\b/);
  assert.doesNotMatch(promotionSource, /\bbuildRemoteConnector\b|\bcreateZip\b|\bcrypto\.sign\b/);
});

test('promotion preserves frozen bytes, records previous stable, and is idempotent', (t) => {
  const fixture = createCandidateFixture(t);
  const candidateBefore = snapshotTree(fixture.candidateRoot);
  const result = promoteRemoteConnectorCandidate({
    workspaceRoot: fixture.root,
    publicKeyPem: fixture.publicKey
  });

  assert.equal(result.phase, 'complete');
  assert.equal(result.resumed, false);
  assert.deepEqual(snapshotTree(fixture.candidateRoot), candidateBefore);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.root, 'remote-connector', 'public', 'stable.json')),
    fixture.manifestBytes
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.root, 'remote-connector', 'public', 'releases', '0.3.35', archiveName)),
    fixture.archiveBytes
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.root, 'remote-connector', 'releases', '0.3.35', archiveName)),
    fixture.archiveBytes
  );
  const journalPath = path.join(
    fixture.root,
    'remote-connector',
    'promotion-journals',
    'remote-connector-0.3.35-38.json'
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    phase: string;
    previousStable: { exists: boolean; sha256: string; bytesBase64: string };
  };
  assert.equal(journal.phase, 'complete');
  assert.equal(journal.previousStable.exists, true);
  assert.equal(Buffer.from(journal.previousStable.bytesBase64, 'base64').toString('utf8'), fixture.previousStable);
  assert.equal(journal.previousStable.sha256, sha256(Buffer.from(fixture.previousStable)));

  const resumed = promoteRemoteConnectorCandidate({
    workspaceRoot: fixture.root,
    publicKeyPem: fixture.publicKey
  });
  assert.equal(resumed.phase, 'complete');
  assert.equal(resumed.resumed, true);
  assert.deepEqual(snapshotTree(fixture.candidateRoot), candidateBefore);
});

for (const failAt of [
  'after_release_stage',
  'after_release_publish_before_journal',
  'after_public_publish_before_journal',
  'after_stable_replace_before_journal',
  'after_stable_published'
]) {
  test(`promotion resumes without rebuilding after interruption: ${failAt}`, (t) => {
    const fixture = createCandidateFixture(t);
    const candidateBefore = snapshotTree(fixture.candidateRoot);
    assert.throws(
      () => promoteRemoteConnectorCandidate({
        workspaceRoot: fixture.root,
        publicKeyPem: fixture.publicKey,
        failAt
      }),
      /Injected promotion interruption/
    );

    const result = promoteRemoteConnectorCandidate({
      workspaceRoot: fixture.root,
      publicKeyPem: fixture.publicKey
    });
    assert.equal(result.phase, 'complete');
    assert.deepEqual(snapshotTree(fixture.candidateRoot), candidateBefore);
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.root, 'remote-connector', 'public', 'stable.json')),
      fixture.manifestBytes
    );
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.root, 'remote-connector', 'public', 'releases', '0.3.35', archiveName)),
      fixture.archiveBytes
    );
  });
}

test('promotion fails closed when an existing immutable public target differs', (t) => {
  const fixture = createCandidateFixture(t);
  const conflicting = path.join(fixture.root, 'remote-connector', 'public', 'releases', '0.3.35');
  fs.mkdirSync(conflicting, { recursive: true });
  fs.writeFileSync(path.join(conflicting, archiveName), 'not-the-candidate');
  assert.throws(
    () => promoteRemoteConnectorCandidate({
      workspaceRoot: fixture.root,
      publicKeyPem: fixture.publicKey
    }),
    /does not match the frozen candidate/
  );
  assert.equal(fs.existsSync(path.join(fixture.root, 'remote-connector', 'releases', '0.3.35')), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'remote-connector', 'public', 'stable.json'), 'utf8'), fixture.previousStable);
});

function createCandidateFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-connector-promotion-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const candidateRoot = path.join(root, 'remote-connector', 'candidates', '0.3.35');
  const portableRoot = path.join(candidateRoot, portableName);
  fs.mkdirSync(path.join(portableRoot, 'app'), { recursive: true });
  fs.writeFileSync(path.join(portableRoot, 'app', 'worker.cjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(portableRoot, 'README.txt'), 'frozen candidate\n');
  fs.writeFileSync(path.join(portableRoot, 'package-identity.json'), `${JSON.stringify({
    schemaVersion: 'omnia.v5.remote-connector-identity/v1',
    product: REMOTE_CONNECTOR_RELEASE.product,
    version: REMOTE_CONNECTOR_RELEASE.version,
    sequence: REMOTE_CONNECTOR_RELEASE.sequence,
    supervisorVersion: REMOTE_CONNECTOR_RELEASE.supervisorVersion,
    sourceCommit: 'a'.repeat(40),
    platform: REMOTE_CONNECTOR_RELEASE.platform,
    installDirectory: 'OmniaAgentV5RemoteConnector',
    dataDirectory: 'OmniaAgentV5RemoteConnector',
    updateManifestUrl: 'https://download.example.invalid/files/v5-remote-connector/stable.json',
    v4Coexistence: 'isolated'
  }, null, 2)}\n`);
  const files = listFiles(portableRoot).map((filename) => ({
    path: path.relative(portableRoot, filename).split(path.sep).join('/'),
    size: fs.statSync(filename).size,
    sha256: sha256(fs.readFileSync(filename))
  })).sort(comparePaths);
  const portableManifest = signObject({
    schemaVersion: 'omnia.v5.remote-connector-portable/v1',
    product: REMOTE_CONNECTOR_RELEASE.product,
    version: REMOTE_CONNECTOR_RELEASE.version,
    sequence: REMOTE_CONNECTOR_RELEASE.sequence,
    platform: REMOTE_CONNECTOR_RELEASE.platform,
    keyId: REMOTE_CONNECTOR_RELEASE.keyId,
    files
  }, privateKey);
  fs.writeFileSync(
    path.join(portableRoot, 'portable-manifest.json'),
    `${JSON.stringify(portableManifest, null, 2)}\n`
  );

  const archivePath = path.join(candidateRoot, archiveName);
  const archive = spawnSync('tar.exe', ['-a', '-cf', archivePath, '-C', candidateRoot, portableName], {
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(archive.status, 0, archive.stderr || archive.stdout);
  const archiveBytes = fs.readFileSync(archivePath);
  const updateManifest = signObject({
    schemaVersion: 'omnia.v5.remote-connector-update/v1',
    product: REMOTE_CONNECTOR_RELEASE.product,
    channel: REMOTE_CONNECTOR_RELEASE.channel,
    platform: REMOTE_CONNECTOR_RELEASE.platform,
    version: REMOTE_CONNECTOR_RELEASE.version,
    sequence: REMOTE_CONNECTOR_RELEASE.sequence,
    publishedAt: '2026-08-10T00:00:00.000Z',
    url: `https://download.example.invalid/files/v5-remote-connector/releases/0.3.35/${archiveName}`,
    sha256: sha256(archiveBytes),
    size: archiveBytes.length,
    minimumSupervisorVersion: REMOTE_CONNECTOR_RELEASE.supervisorVersion,
    rolloutPolicy: 'automatic_safe_window',
    securitySeverity: 'normal',
    newRunStopAt: '2026-08-17T00:00:00.000Z',
    maxDrainUntil: '2026-08-24T00:00:00.000Z',
    offerExpiresAt: '2026-09-09T00:00:00.000Z',
    keyId: REMOTE_CONNECTOR_RELEASE.keyId
  }, privateKey);
  const manifestBytes = Buffer.from(`${JSON.stringify(updateManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(candidateRoot, 'candidate-update-manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(candidateRoot, 'sbom.json'), `${JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    metadata: {
      component: {
        type: 'application',
        name: REMOTE_CONNECTOR_RELEASE.product,
        version: REMOTE_CONNECTOR_RELEASE.version
      }
    }
  }, null, 2)}\n`);
  const previousStable = '{"version":"0.3.33","sequence":36}\n';
  const publicRoot = path.join(root, 'remote-connector', 'public');
  fs.mkdirSync(publicRoot, { recursive: true });
  fs.writeFileSync(path.join(publicRoot, 'stable.json'), previousStable);
  return {
    root,
    candidateRoot,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    archiveBytes,
    manifestBytes,
    previousStable
  };
}

function signObject<T extends Record<string, unknown>>(value: T, privateKey: crypto.KeyObject) {
  const signature = crypto.sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64');
  return { ...value, signature };
}

function canonicalJson(value: unknown): string {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function listFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

function snapshotTree(root: string) {
  if (!fs.existsSync(root)) return { exists: false, digest: null, entries: 0 };
  const files = listFiles(root).map((filename) => ({
    path: path.relative(root, filename).split(path.sep).join('/'),
    size: fs.statSync(filename).size,
    sha256: sha256(fs.readFileSync(filename))
  })).sort(comparePaths);
  return { exists: true, digest: sha256(Buffer.from(canonicalJson(files))), entries: files.length };
}

function sha256(bytes: Buffer) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function comparePaths(left: { path: string }, right: { path: string }) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
