import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_FEATURES,
  installBuiltinFeaturePackages
} from '../src/main/features/builtin-features.ts';
import type { FeaturePackageManager } from '../src/main/features/package-manager.ts';
import {
  BUILTIN_FEATURE_RELEASE_INVENTORY,
  BUILTIN_FEATURE_RELEASE_PROJECTION,
  assertBuiltinFeatureReleaseProjection,
  validateBuiltinFeatureReleaseInventory,
  type BuiltinFeatureReleaseInventory,
  type BuiltinFeatureReleaseProjection
} from '../src/main/features/builtin-release-inventory.ts';
import { packageDigest, type OfficialPackageEnvelope } from '../src/main/features/official-package.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withBuiltins(
  builtins: BuiltinFeatureReleaseInventory['builtins']
): BuiltinFeatureReleaseInventory {
  return {
    ...BUILTIN_FEATURE_RELEASE_INVENTORY,
    builtins
  };
}

test('fixed builtin inventory verifies the accepted tracked Shell baseline', () => {
  const verified = validateBuiltinFeatureReleaseInventory(repository);
  assert.deepEqual(
    verified.map(({ entry, fileSha256, packageDigest: signedDigest }) => ({
      featureId: entry.featureId,
      version: entry.version,
      sequence: entry.sequence,
      filename: entry.filename,
      fileSha256,
      packageDigest: signedDigest
    })),
    [
      {
        featureId: 'omnia.recording',
        version: '0.3.0',
        sequence: 4,
        filename: 'recording-0.3.0.ofp',
        fileSha256: 'sha256:4dd3b488e6b72a672530533313e14d6016ecccf29f6de31fb454519bac2c5fe6',
        packageDigest: 'sha256:472718bf4daed2df196685469b44f63192ebebd1ee9654614b466b67041bd8e7'
      },
      {
        featureId: 'omnia.create-associate',
        version: '0.2.43',
        sequence: 45,
        filename: 'create-associate-0.2.43.ofp',
        fileSha256: 'sha256:0b3d1597f963961eae16023fe769e4820b94aa85edeb47a898c013ebca19b4a1',
        packageDigest: 'sha256:813fe3ec2d864058314b20da5eb92eb7725a711bfd17cd2226911e081743f52b'
      },
      {
        featureId: 'omnia.delete-elements',
        version: '0.2.1',
        sequence: 8,
        filename: 'delete-elements-0.2.1.ofp',
        fileSha256: 'sha256:c85c3c4cdabbf2ffd4d72af5c1498637409be089f831b1b78288728b6f54a3b6',
        packageDigest: 'sha256:be02dcf583b7d50503cc2bfe23f2244c12ad626a66cee78a82f79c006eeceb7f'
      }
    ]
  );
  assert.deepEqual(BUILTIN_FEATURES, BUILTIN_FEATURE_RELEASE_PROJECTION.runtimeCatalog);
  assert.equal(BUILTIN_FEATURES.some((item) => item.version === '0.2.103'), false);
});

test('Workpaper is an explicit post-install boundary, not an omitted builtin copy', () => {
  assert.equal(
    BUILTIN_FEATURE_RELEASE_INVENTORY.builtins.some((item) => item.featureId === 'omnia.workpaper-preparation'),
    false
  );
  assert.deepEqual(BUILTIN_FEATURE_RELEASE_INVENTORY.postInstallFeatures, [{
    featureId: 'omnia.workpaper-preparation',
    delivery: 'post-install',
    bundled: false,
    reason: 'No accepted immutable Workpaper release asset belongs to this Shell builtin baseline.'
  }]);
  assert.deepEqual(
    BUILTIN_FEATURE_RELEASE_PROJECTION.postInstallFeatures,
    BUILTIN_FEATURE_RELEASE_INVENTORY.postInstallFeatures
  );
});

test('runtime, Windows copy, and release manifest are projected without secondary version lists', () => {
  assertBuiltinFeatureReleaseProjection(BUILTIN_FEATURE_RELEASE_PROJECTION);
  const packageWindows = fs.readFileSync(path.join(repository, 'scripts', 'package-windows.mjs'), 'utf8');
  const builtinRuntime = fs.readFileSync(path.join(repository, 'src', 'main', 'features', 'builtin-features.ts'), 'utf8');
  for (const entry of BUILTIN_FEATURE_RELEASE_INVENTORY.builtins) {
    assert.doesNotMatch(packageWindows, new RegExp(entry.filename.replaceAll('.', '\\.')));
    assert.doesNotMatch(builtinRuntime, new RegExp(entry.filename.replaceAll('.', '\\.')));
  }
  assert.match(packageWindows, /BUILTIN_FEATURE_RELEASE_PROJECTION\.copyFiles/u);
  assert.match(packageWindows, /BUILTIN_FEATURE_RELEASE_PROJECTION\.releaseManifest/u);
  assert.match(packageWindows, /featureReleaseInventory/u);
  assert.match(builtinRuntime, /BUILTIN_FEATURE_RELEASE_PROJECTION\.runtimeCatalog/u);
  assert.ok(
    packageWindows.indexOf('validateBuiltinFeatureReleaseInventory(root)')
      < packageWindows.indexOf('await removeWithRetry(release)'),
    'Windows packaging must verify all builtin inputs before mutating its staging release.'
  );
  const buildScript = fs.readFileSync(path.join(repository, 'scripts', 'build.mjs'), 'utf8');
  assert.ok(
    buildScript.indexOf('validateBuiltinFeatureReleaseInventory(root)')
      < buildScript.indexOf("await rm(dist, { recursive: true, force: true })"),
    'The build must verify all builtin inputs before replacing dist.'
  );
});

test('a signed post-install update stays active while the immutable builtin remains its rollback baseline', () => {
  const activeVersions = new Map([
    ['omnia.recording', '0.4.19'],
    ['omnia.create-associate', '0.2.103'],
    ['omnia.delete-elements', '0.3.20']
  ]);
  let installCalled = false;
  const manager = {
    installedVersion(featureId: string, featureVersion: string) {
      const builtin = BUILTIN_FEATURE_RELEASE_INVENTORY.builtins.find((item) =>
        item.featureId === featureId && item.version === featureVersion);
      return builtin ? { packageDigest: builtin.packageDigest, documentationPath: 'accepted-baseline' } : null;
    },
    list() {
      return [...activeVersions].map(([featureId, featureVersion]) => ({ featureId, featureVersion }));
    },
    install() {
      installCalled = true;
      throw new Error('A post-install activation must not be overwritten by builtin bootstrap.');
    }
  } as unknown as FeaturePackageManager;

  const results = installBuiltinFeaturePackages(manager, repository, false);
  assert.equal(installCalled, false);
  assert.deepEqual(results.map((item) => ({
    featureId: item.featureId,
    targetVersion: item.targetVersion,
    activeVersion: item.activeVersion,
    action: item.action
  })), BUILTIN_FEATURE_RELEASE_INVENTORY.builtins.map((item) => ({
    featureId: item.featureId,
    targetVersion: item.version,
    activeVersion: activeVersions.get(item.featureId),
    action: 'preserved-rollback'
  })));
});

test('projection drift is rejected instead of producing a mismatched package', () => {
  const drifted = structuredClone(BUILTIN_FEATURE_RELEASE_PROJECTION) as {
    runtimeCatalog: BuiltinFeatureReleaseProjection['runtimeCatalog'];
    copyFiles: Array<{ featureId: string; sourceRelativePath: string; targetRelativePath: string; filename: string }>;
    releaseManifest: BuiltinFeatureReleaseProjection['releaseManifest'];
    postInstallFeatures: BuiltinFeatureReleaseProjection['postInstallFeatures'];
  };
  const createCopy = drifted.copyFiles.find((item) => item.featureId === 'omnia.create-associate');
  assert.ok(createCopy);
  createCopy.targetRelativePath = 'resources/app/builtins/create-associate-0.2.48.ofp';
  assert.throws(
    () => assertBuiltinFeatureReleaseProjection(drifted),
    /projection drifted from the release inventory/u
  );
});

test('missing, digest-drifted, and identity-drifted baseline assets fail closed', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-builtin-missing-'));
  try {
    assert.throws(
      () => validateBuiltinFeatureReleaseInventory(emptyRoot),
      /release asset is missing/u
    );
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }

  const [recording, ...rest] = BUILTIN_FEATURE_RELEASE_INVENTORY.builtins;
  assert.ok(recording);
  assert.throws(
    () => validateBuiltinFeatureReleaseInventory(repository, withBuiltins([
      { ...recording, fileSha256: `sha256:${'0'.repeat(64)}` },
      ...rest
    ])),
    /release asset digest mismatch/u
  );
  assert.throws(
    () => validateBuiltinFeatureReleaseInventory(repository, withBuiltins([
      { ...recording, featureId: 'omnia.recording-drifted' },
      ...rest
    ])),
    /release asset identity mismatch/u
  );
  assert.throws(
    () => validateBuiltinFeatureReleaseInventory(repository, withBuiltins([
      { ...recording, version: '0.3.1' },
      ...rest
    ])),
    /filename and version drifted apart/u
  );
});

test('a byte-consistent but re-identified package still fails official signature verification', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-builtin-signature-'));
  try {
    const original = BUILTIN_FEATURE_RELEASE_INVENTORY.builtins[0];
    assert.ok(original);
    const parsed = JSON.parse(fs.readFileSync(path.join(repository, ...original.sourceRelativePath.split('/')), 'utf8')) as OfficialPackageEnvelope;
    const tampered = { ...parsed, version: '0.3.1' } as OfficialPackageEnvelope;
    const bytes = Buffer.from(JSON.stringify(tampered));
    const entry = {
      ...original,
      version: '0.3.1',
      filename: 'recording-0.3.1.ofp',
      sourceRelativePath: 'feature-packages/recording/candidates/recording-0.3.1.ofp',
      fileSha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      packageDigest: packageDigest(tampered)
    };
    const target = path.join(temporaryRoot, ...entry.sourceRelativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    assert.throws(
      () => validateBuiltinFeatureReleaseInventory(temporaryRoot, withBuiltins([entry])),
      /signature is invalid/u
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
