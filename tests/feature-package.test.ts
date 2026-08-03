import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.js';
import { FeaturePackageManager } from '../src/main/features/package-manager.js';
import {
  canonicalJson,
  verifyOfficialPackage
} from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const repo = path.resolve(import.meta.dirname, '..');
const package010 = path.join(repo, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.0.ofp');
const package011 = path.join(repo, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.1.ofp');
const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };

function createRoot(): { root: string; database: CoreDatabase; manager: FeaturePackageManager } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-feature-test-'));
  const paths = resolveProductPaths(root);
  const database = new CoreDatabase(paths.database, cipher);
  return { root, database, manager: new FeaturePackageManager(database.db, paths) };
}

test('official package verifier rejects non-canonical and Windows-colliding members', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const base = {
    schemaVersion: 'omnia.official-package-envelope/v1',
    product: 'omnia-feature',
    packageId: 'example.feature',
    version: '1.0.0',
    sequence: 1,
    publisher: { keyId: 'omnia-v5-official-feature-2026-01', algorithm: 'Ed25519' },
    files: [
      { path: 'A.txt', size: 1, sha256: crypto.createHash('sha256').update('a').digest('hex'), contentBase64: 'YQ==' },
      { path: 'a.TXT', size: 1, sha256: crypto.createHash('sha256').update('b').digest('hex'), contentBase64: 'Yg==' }
    ]
  };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(base)), privateKey).toString('base64');
  assert.throws(
    () => verifyOfficialPackage({ ...base, signature }, 'omnia-feature', publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    /Duplicate official package member/
  );
  const badBase64 = {
    ...base,
    files: [{ path: 'safe.txt', size: 1, sha256: crypto.createHash('sha256').update('a').digest('hex'), contentBase64: 'YQ' }]
  };
  const badSignature = crypto.sign(null, Buffer.from(canonicalJson(badBase64)), privateKey).toString('base64');
  assert.throws(
    () => verifyOfficialPackage(
      { ...badBase64, signature: badSignature },
      'omnia-feature',
      publicKey.export({ type: 'spki', format: 'pem' }).toString()
    ),
    /canonical base64/
  );
});

test('install, upgrade, documentation projection, idempotency and rollback share one activation head', () => {
  const { root, database, manager } = createRoot();
  try {
    assert.deepEqual(manager.snapshot().navigation, []);
    assert.equal(database.activeFeatureCount(), 0);
    const first = manager.install(package010);
    assert.equal(first.featureVersion, '0.1.0');
    assert.equal(first.runtimeEnabled, false);
    assert.match(first.documentationPath, /0\.1\.0/);
    const firstHead = manager.list()[0]!;
    const firstGeneration = firstHead.activationGeneration;
    const noOp = manager.install(package010);
    assert.equal(noOp.idempotent, true);
    assert.equal(noOp.activationGeneration, firstGeneration);
    const upgraded = manager.install(package011);
    assert.equal(upgraded.featureVersion, '0.1.1');
    assert.equal(upgraded.activationGeneration, firstGeneration + 1);
    assert.match(upgraded.documentationPath, /0\.1\.1/);
    const docsRoot = path.join(root, 'data', ...upgraded.documentationPath.split('/'));
    assert.equal(fs.existsSync(path.join(docsRoot, 'FEATURE.md')), true);
    const registry = database.db.prepare(`
      SELECT h.feature_version, h.documentation_path, d.feature_version AS docs_version, d.physical_path
      FROM feature_activation_heads h
      JOIN documentation_registry d
        ON d.feature_id=h.feature_id AND d.feature_version=h.feature_version
    `).get() as Record<string, unknown>;
    assert.equal(registry.feature_version, '0.1.1');
    assert.equal(registry.docs_version, '0.1.1');
    assert.equal(registry.documentation_path, registry.physical_path);
    const rolledBack = manager.rollback('omnia.delete-elements', '0.1.0');
    assert.equal(rolledBack.featureVersion, '0.1.0');
    assert.equal(manager.list()[0]!.documentationPath, first.documentationPath);
    assert.equal(database.activeFeatureCount(), 0);
    const selected = manager.select('omnia.delete-elements');
    assert.equal(selected.surface?.status, 'blocked');
    assert.equal(selected.navigation[0]?.availability, 'disabled');
    assert.equal(manager.select('').surface, null);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fault after immutable move is recorded and verified orphan is safely reused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-feature-fault-'));
  const paths = resolveProductPaths(root);
  const database = new CoreDatabase(paths.database, cipher);
  try {
    const crashing = new FeaturePackageManager(database.db, paths, (point) => {
      if (point === 'after_immutable_move_before_activation') throw new Error('injected crash');
    });
    assert.throws(() => crashing.install(package010), /injected crash/);
    assert.equal(crashing.list().length, 0);
    const failed = database.db.prepare(`
      SELECT status, reason FROM feature_install_attempts ORDER BY started_at DESC LIMIT 1
    `).get() as Record<string, unknown>;
    assert.equal(failed.status, 'failed');
    const recovered = new FeaturePackageManager(database.db, paths);
    const installed = recovered.install(package010);
    assert.equal(installed.featureVersion, '0.1.0');
    assert.equal(recovered.list().length, 1);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('signed packages have exact product scopes and nested Operation inventory', () => {
  const outer = verifyOfficialPackage(
    JSON.parse(fs.readFileSync(package011, 'utf8')) as unknown,
    'omnia-feature'
  );
  const operationMember = outer.files.find((member) => member.path === 'connector-capability/operation.ofop');
  assert.ok(operationMember);
  const nested = verifyOfficialPackage(
    JSON.parse(Buffer.from(operationMember.contentBase64, 'base64').toString('utf8')) as unknown,
    'omnia-connector-operation'
  );
  assert.deepEqual(
    nested.files.map((member) => member.path).sort(),
    ['SIGNATURE.json', 'docs/OPERATION.md', 'manifest.json', 'operation/policy.json', 'sbom.json']
  );
  const manifest = JSON.parse(
    Buffer.from(nested.files.find((member) => member.path === 'manifest.json')!.contentBase64, 'base64').toString('utf8')
  ) as { operations: Array<{ effect: string; enabledByDefault: boolean }> };
  assert.equal(manifest.operations.find((operation) => operation.effect === 'omnia_mutation')?.enabledByDefault, false);
});
