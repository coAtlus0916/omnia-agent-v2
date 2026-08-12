import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { _test as packageManagerTest } from '../src/main/features/package-manager.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FEATURES = [
  ['omnia.create-associate', 'create-associate', 'scripts/package-create-associate-feature.mjs'],
  ['omnia.delete-elements', 'delete-elements', 'scripts/package-delete-feature.mjs'],
  ['omnia.recording', 'recording', 'scripts/package-recording-feature.mjs'],
  ['omnia.workpaper-preparation', 'workpaper-preparation', 'scripts/package-workpaper-preparation-feature.mjs']
] as const;

test('signed Python sidecar paths are derived from one strict Feature slug with no shared fallback', () => {
  for (const [featureId, slug, packageScript] of FEATURES) {
    const expected = {
      bridgePath: `middle/${slug}-python-bridge.cjs`,
      entryPath: `python/${slug}-engine.py`
    };
    assert.deepEqual(packageManagerTest.featurePythonSidecarPaths(featureId), expected);
    const sourceRoot = path.join(repositoryRoot, 'feature-packages', slug, 'source');
    assert.equal(fs.statSync(path.join(sourceRoot, ...expected.bridgePath.split('/'))).isFile(), true);
    assert.equal(fs.statSync(path.join(sourceRoot, ...expected.entryPath.split('/'))).isFile(), true);
    const script = fs.readFileSync(path.join(repositoryRoot, packageScript), 'utf8');
    assert.match(script, new RegExp(`bridgePath:\\s*['"]${expected.bridgePath.replaceAll('.', '\\.') }['"]`, 'u'));
    assert.match(script, new RegExp(`entryPath:\\s*['"]${expected.entryPath.replaceAll('.', '\\.') }['"]`, 'u'));
  }

  for (const invalid of [
    'omnia.Create', 'omnia.create_associate', 'omnia.create--associate', 'omnia.create-associate-',
    `omnia.${'a'.repeat(65)}`
  ]) {
    assert.throws(() => packageManagerTest.featurePythonSidecarPaths(invalid), /lowercase hyphenated Feature slug/u);
  }
});

test('production source trees contain no generic Python engine or bridge entry basename', () => {
  const sharedEngine = ['engine', '.py'].join('');
  const sharedBridge = ['python-', 'bridge.cjs'].join('');
  for (const [, slug] of FEATURES) {
    const sourceRoot = path.join(repositoryRoot, 'feature-packages', slug, 'source');
    assert.equal(fs.existsSync(path.join(sourceRoot, 'python', sharedEngine)), false);
    assert.equal(fs.existsSync(path.join(sourceRoot, 'middle', sharedBridge)), false);
  }
});
