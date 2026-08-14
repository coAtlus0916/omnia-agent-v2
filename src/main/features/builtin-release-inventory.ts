import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  packageDigest,
  verifyOfficialPackage,
  type OfficialPackageEnvelope
} from './official-package.ts';

export const BUILTIN_RELEASE_INVENTORY_SCHEMA = 'omnia.shell-builtin-release-inventory/v1' as const;

export interface BuiltinFeatureReleaseEntry {
  readonly delivery: 'shell-builtin-baseline';
  readonly featureId: string;
  readonly version: string;
  readonly sequence: number;
  readonly sourceDirectory: string;
  readonly filename: string;
  readonly sourceRelativePath: string;
  readonly fileSha256: string;
  readonly packageDigest: string;
}

export interface PostInstallFeatureBoundary {
  readonly featureId: string;
  readonly delivery: 'post-install';
  readonly bundled: false;
  readonly reason: string;
}

export interface BuiltinFeatureReleaseInventory {
  readonly schemaVersion: typeof BUILTIN_RELEASE_INVENTORY_SCHEMA;
  readonly baselinePolicy: 'fixed-shell-baseline';
  readonly builtins: readonly BuiltinFeatureReleaseEntry[];
  readonly postInstallFeatures: readonly PostInstallFeatureBoundary[];
}

/**
 * This is the sole Shell builtin release inventory. It intentionally names
 * accepted, immutable Shell baseline packages rather than the newest Feature
 * development candidates. Independently accepted Feature updates are installed
 * through the signed post-install channel and do not rewrite this baseline.
 */
export const BUILTIN_FEATURE_RELEASE_INVENTORY: BuiltinFeatureReleaseInventory = Object.freeze({
  schemaVersion: BUILTIN_RELEASE_INVENTORY_SCHEMA,
  baselinePolicy: 'fixed-shell-baseline',
  builtins: Object.freeze([
    Object.freeze({
      delivery: 'shell-builtin-baseline',
      featureId: 'omnia.recording',
      version: '0.3.0',
      sequence: 4,
      sourceDirectory: 'recording',
      filename: 'recording-0.3.0.ofp',
      sourceRelativePath: 'feature-packages/recording/candidates/recording-0.3.0.ofp',
      fileSha256: 'sha256:4dd3b488e6b72a672530533313e14d6016ecccf29f6de31fb454519bac2c5fe6',
      packageDigest: 'sha256:472718bf4daed2df196685469b44f63192ebebd1ee9654614b466b67041bd8e7'
    }),
    Object.freeze({
      delivery: 'shell-builtin-baseline',
      featureId: 'omnia.create-associate',
      version: '0.2.43',
      sequence: 45,
      sourceDirectory: 'create-associate',
      filename: 'create-associate-0.2.43.ofp',
      sourceRelativePath: 'feature-packages/create-associate/candidates/create-associate-0.2.43.ofp',
      fileSha256: 'sha256:0b3d1597f963961eae16023fe769e4820b94aa85edeb47a898c013ebca19b4a1',
      packageDigest: 'sha256:813fe3ec2d864058314b20da5eb92eb7725a711bfd17cd2226911e081743f52b'
    }),
    Object.freeze({
      delivery: 'shell-builtin-baseline',
      featureId: 'omnia.delete-elements',
      version: '0.2.1',
      sequence: 8,
      sourceDirectory: 'delete-elements',
      filename: 'delete-elements-0.2.1.ofp',
      sourceRelativePath: 'feature-packages/delete-elements/candidates/delete-elements-0.2.1.ofp',
      fileSha256: 'sha256:c85c3c4cdabbf2ffd4d72af5c1498637409be089f831b1b78288728b6f54a3b6',
      packageDigest: 'sha256:be02dcf583b7d50503cc2bfe23f2244c12ad626a66cee78a82f79c006eeceb7f'
    })
  ]),
  postInstallFeatures: Object.freeze([
    Object.freeze({
      featureId: 'omnia.workpaper-preparation',
      delivery: 'post-install',
      bundled: false,
      reason: 'No accepted immutable Workpaper release asset belongs to this Shell builtin baseline.'
    })
  ])
});

export const CREATE_ASSOCIATE_ONLY_BUILTIN_PROFILE = 'create-associate-only' as const;
export const COMPANY_LOOPBACK_CURRENT_BUILTIN_PROFILE = 'company-loopback-current' as const;

/**
 * Dedicated portable profile used by the self-contained Connector Next build.
 * It deliberately contains one immutable, accepted Feature package. Connector
 * Next remains a generic transport and never imports this Feature's code.
 */
export const CREATE_ASSOCIATE_ONLY_FEATURE_RELEASE_INVENTORY: BuiltinFeatureReleaseInventory = Object.freeze({
  schemaVersion: BUILTIN_RELEASE_INVENTORY_SCHEMA,
  baselinePolicy: 'fixed-shell-baseline',
  builtins: Object.freeze([
    Object.freeze({
      delivery: 'shell-builtin-baseline',
      featureId: 'omnia.create-associate',
      version: '0.2.123',
      sequence: 125,
      sourceDirectory: 'create-associate',
      filename: 'create-associate-0.2.123.ofp',
      sourceRelativePath: 'feature-packages/create-associate/candidates/create-associate-0.2.123.ofp',
      fileSha256: 'sha256:24aa8a7cd35aaab3d4ed9b2a9fe4e3415476ddb0e46d786348fd8719c9462432',
      packageDigest: 'sha256:06c6f1d13bd3d6d57862a7bbdd090223a7037db783d74804d6dd3531ba384189'
    })
  ]),
  postInstallFeatures: Object.freeze([
    Object.freeze({
      featureId: 'omnia.recording',
      delivery: 'post-install',
      bundled: false,
      reason: 'The Create-and-Associate portable profile intentionally contains exactly one Feature.'
    }),
    Object.freeze({
      featureId: 'omnia.delete-elements',
      delivery: 'post-install',
      bundled: false,
      reason: 'The Create-and-Associate portable profile intentionally contains exactly one Feature.'
    }),
    Object.freeze({
      featureId: 'omnia.workpaper-preparation',
      delivery: 'post-install',
      bundled: false,
      reason: 'The Create-and-Associate portable profile intentionally contains exactly one Feature.'
    })
  ])
});

/**
 * Self-contained company portable profile. It freezes the four Feature
 * releases currently accepted by the product while Connector Next remains a
 * generic loopback transport with no Feature-specific code.
 */
export const COMPANY_LOOPBACK_CURRENT_FEATURE_RELEASE_INVENTORY: BuiltinFeatureReleaseInventory = Object.freeze({
  schemaVersion: BUILTIN_RELEASE_INVENTORY_SCHEMA,
  baselinePolicy: 'fixed-shell-baseline',
  builtins: Object.freeze([
    Object.freeze({
      delivery: 'shell-builtin-baseline',
      featureId: 'omnia.create-associate',
      version: '0.2.150',
      sequence: 152,
      sourceDirectory: 'create-associate',
      filename: 'create-associate-0.2.150.ofp',
      sourceRelativePath: 'feature-packages/create-associate/candidates/create-associate-0.2.150.ofp',
      fileSha256: 'sha256:a019a652c779b593e8e119fd0f8ded3372f9eb9ffd758206d0336c5fe4ec6fd5',
      packageDigest: 'sha256:76cc704cc7f29aa10348e976a1395437e345abede01c022c1e2367d671295073'
    }),
    Object.freeze({
      delivery: 'shell-builtin-baseline',
      featureId: 'omnia.recording',
      version: '0.4.21',
      sequence: 34,
      sourceDirectory: 'recording',
      filename: 'recording-0.4.21.ofp',
      sourceRelativePath: 'feature-packages/recording/candidates/recording-0.4.21.ofp',
      fileSha256: 'sha256:d9da739303b335040dcec9ff31e947e76ffadb793c9a5d0d68a0553fd4126a52',
      packageDigest: 'sha256:948b88ea9d72e49721712cf9d31ec1d754ff809011767f8fd047b3ab4826b9a7'
    }),
    Object.freeze({
      delivery: 'shell-builtin-baseline',
      featureId: 'omnia.delete-elements',
      version: '0.3.32',
      sequence: 1786632995691,
      sourceDirectory: 'delete-elements',
      filename: 'delete-elements-0.3.32.ofp',
      sourceRelativePath: 'feature-packages/delete-elements/candidates/delete-elements-0.3.32.ofp',
      fileSha256: 'sha256:7757d995610f830af9a0091a5edb5b21ffe1daeca71055106cc01609ddefd7e5',
      packageDigest: 'sha256:0aed84b8fa5d2ca69ce9ceaa58ac6517ccbbcd257b0b2f2b8a6a674a7a2ff337'
    }),
    Object.freeze({
      delivery: 'shell-builtin-baseline',
      featureId: 'omnia.workpaper-preparation',
      version: '0.1.81',
      sequence: 82,
      sourceDirectory: 'workpaper-preparation',
      filename: 'workpaper-preparation-0.1.81.ofp',
      sourceRelativePath: 'feature-packages/workpaper-preparation/candidates/workpaper-preparation-0.1.81.ofp',
      fileSha256: 'sha256:26a670b8e47f090248ac4341d3027c344dbb2e9a70540cc3e4e0a126ae3bfe48',
      packageDigest: 'sha256:c45a094381cc33c142def9e0af509e1059d7fd7998e75b406dd5948309607069'
    })
  ]),
  postInstallFeatures: Object.freeze([])
});

export function builtinFeatureReleaseInventoryForProfile(
  profile = String(process.env.OMNIA_AGENT_BUILTIN_PROFILE || '').trim()
): BuiltinFeatureReleaseInventory {
  if (!profile || profile === 'standard') return BUILTIN_FEATURE_RELEASE_INVENTORY;
  if (profile === CREATE_ASSOCIATE_ONLY_BUILTIN_PROFILE) return CREATE_ASSOCIATE_ONLY_FEATURE_RELEASE_INVENTORY;
  if (profile === COMPANY_LOOPBACK_CURRENT_BUILTIN_PROFILE) return COMPANY_LOOPBACK_CURRENT_FEATURE_RELEASE_INVENTORY;
  throw new Error(`Unknown Omnia builtin Feature profile: ${profile}`);
}

export const ACTIVE_BUILTIN_FEATURE_RELEASE_INVENTORY = builtinFeatureReleaseInventoryForProfile();

export interface BuiltinFeatureRuntimeCatalogEntry extends BuiltinFeatureReleaseEntry {}

export interface BuiltinFeatureCopyProjection {
  readonly featureId: string;
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
  readonly filename: string;
}

export interface BuiltinFeatureManifestProjection {
  readonly featureId: string;
  readonly version: string;
  readonly sequence: number;
  readonly filename: string;
  readonly relativePath: string;
  readonly fileSha256: string;
  readonly packageDigest: string;
}

export interface BuiltinFeatureReleaseProjection {
  readonly runtimeCatalog: readonly BuiltinFeatureRuntimeCatalogEntry[];
  readonly copyFiles: readonly BuiltinFeatureCopyProjection[];
  readonly releaseManifest: readonly BuiltinFeatureManifestProjection[];
  readonly postInstallFeatures: readonly PostInstallFeatureBoundary[];
}

export interface VerifiedBuiltinFeatureRelease {
  readonly entry: BuiltinFeatureReleaseEntry;
  readonly absoluteFilename: string;
  readonly envelope: OfficialPackageEnvelope;
  readonly fileSha256: string;
  readonly packageDigest: string;
}

const FEATURE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const DIRECTORY = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function fail(message: string): never {
  throw new Error(`Built-in Feature release inventory is invalid: ${message}`);
}

function assertInventoryContract(inventory: BuiltinFeatureReleaseInventory): void {
  if (inventory.schemaVersion !== BUILTIN_RELEASE_INVENTORY_SCHEMA) fail('schemaVersion does not match the supported contract.');
  if (inventory.baselinePolicy !== 'fixed-shell-baseline') fail('baselinePolicy must keep the Shell baseline fixed.');
  if (!Array.isArray(inventory.builtins) || inventory.builtins.length === 0) fail('at least one builtin package is required.');
  if (!Array.isArray(inventory.postInstallFeatures)) fail('postInstallFeatures must be an array.');

  const featureIds = new Set<string>();
  const filenames = new Set<string>();
  const sourcePaths = new Set<string>();
  for (const entry of inventory.builtins) {
    if (entry.delivery !== 'shell-builtin-baseline') fail(`${entry.featureId || '<unknown>'} has the wrong delivery channel.`);
    if (!FEATURE_ID.test(entry.featureId)) fail('a builtin featureId is malformed.');
    if (!VERSION.test(entry.version)) fail(`${entry.featureId} has a malformed version.`);
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= 0) fail(`${entry.featureId} has an invalid sequence.`);
    if (!DIRECTORY.test(entry.sourceDirectory)) fail(`${entry.featureId} has an unsafe source directory.`);
    if (entry.filename !== `${entry.sourceDirectory}-${entry.version}.ofp`) {
      fail(`${entry.featureId} filename and version drifted apart.`);
    }
    const expectedSource = `feature-packages/${entry.sourceDirectory}/candidates/${entry.filename}`;
    if (entry.sourceRelativePath !== expectedSource) fail(`${entry.featureId} source path drifted from its filename.`);
    if (!SHA256.test(entry.fileSha256) || !SHA256.test(entry.packageDigest)) {
      fail(`${entry.featureId} has a malformed digest.`);
    }
    if (featureIds.has(entry.featureId)) fail(`duplicate featureId ${entry.featureId}.`);
    if (filenames.has(entry.filename)) fail(`duplicate filename ${entry.filename}.`);
    if (sourcePaths.has(entry.sourceRelativePath)) fail(`duplicate source path ${entry.sourceRelativePath}.`);
    featureIds.add(entry.featureId);
    filenames.add(entry.filename);
    sourcePaths.add(entry.sourceRelativePath);
  }

  const postInstallIds = new Set<string>();
  for (const boundary of inventory.postInstallFeatures) {
    if (!FEATURE_ID.test(boundary.featureId)) fail('a post-install featureId is malformed.');
    if (boundary.delivery !== 'post-install' || boundary.bundled !== false || !boundary.reason.trim()) {
      fail(`${boundary.featureId} has an invalid post-install boundary.`);
    }
    if (featureIds.has(boundary.featureId) || postInstallIds.has(boundary.featureId)) {
      fail(`${boundary.featureId} appears in more than one delivery channel.`);
    }
    postInstallIds.add(boundary.featureId);
  }
}

function freezeObjects<T extends object>(values: T[]): readonly Readonly<T>[] {
  return Object.freeze(values.map((value) => Object.freeze(value)));
}

export function createBuiltinFeatureReleaseProjection(
  inventory: BuiltinFeatureReleaseInventory = ACTIVE_BUILTIN_FEATURE_RELEASE_INVENTORY
): BuiltinFeatureReleaseProjection {
  assertInventoryContract(inventory);
  return Object.freeze({
    runtimeCatalog: freezeObjects(inventory.builtins.map((entry) => ({ ...entry }))),
    copyFiles: freezeObjects(inventory.builtins.map((entry) => ({
      featureId: entry.featureId,
      sourceRelativePath: entry.sourceRelativePath,
      targetRelativePath: `resources/app/builtins/${entry.filename}`,
      filename: entry.filename
    }))),
    releaseManifest: freezeObjects(inventory.builtins.map((entry) => ({
      featureId: entry.featureId,
      version: entry.version,
      sequence: entry.sequence,
      filename: entry.filename,
      relativePath: `resources/app/builtins/${entry.filename}`,
      fileSha256: entry.fileSha256,
      packageDigest: entry.packageDigest
    }))),
    postInstallFeatures: freezeObjects(inventory.postInstallFeatures.map((boundary) => ({ ...boundary })))
  });
}

export const BUILTIN_FEATURE_RELEASE_PROJECTION = createBuiltinFeatureReleaseProjection();

export function assertBuiltinFeatureReleaseProjection(
  projection: BuiltinFeatureReleaseProjection,
  inventory: BuiltinFeatureReleaseInventory = ACTIVE_BUILTIN_FEATURE_RELEASE_INVENTORY
): void {
  const expected = createBuiltinFeatureReleaseProjection(inventory);
  if (JSON.stringify(projection) !== JSON.stringify(expected)) {
    throw new Error('Built-in Feature runtime/copy/release-manifest projection drifted from the release inventory.');
  }
}

function resolveInventorySource(repositoryRoot: string, entry: BuiltinFeatureReleaseEntry): string {
  const absoluteRoot = path.resolve(repositoryRoot);
  const absoluteFilename = path.resolve(absoluteRoot, ...entry.sourceRelativePath.split('/'));
  const rootPrefix = `${absoluteRoot}${path.sep}`;
  if (!absoluteFilename.startsWith(rootPrefix)) fail(`${entry.featureId} source escapes the repository root.`);
  return absoluteFilename;
}

function fileDigest(bytes: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function verifyBuiltinFeatureReleaseFile(
  absoluteFilename: string,
  entry: BuiltinFeatureReleaseEntry
): VerifiedBuiltinFeatureRelease {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absoluteFilename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Built-in Feature release asset is missing: ${absoluteFilename}`);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Built-in Feature release asset is not a regular file: ${absoluteFilename}`);
  }
  const bytes = fs.readFileSync(absoluteFilename);
  const actualFileDigest = fileDigest(bytes);
  if (actualFileDigest !== entry.fileSha256) {
    throw new Error(`Built-in Feature release asset digest mismatch: ${absoluteFilename}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Built-in Feature release asset is not valid JSON: ${absoluteFilename}`);
  }
  const envelope = verifyOfficialPackage(parsed, 'omnia-feature');
  if (
    envelope.packageId !== entry.featureId
    || envelope.version !== entry.version
    || envelope.sequence !== entry.sequence
  ) {
    throw new Error(`Built-in Feature release asset identity mismatch: ${absoluteFilename}`);
  }
  const actualPackageDigest = packageDigest(envelope);
  if (actualPackageDigest !== entry.packageDigest) {
    throw new Error(`Built-in Feature signed package digest mismatch: ${absoluteFilename}`);
  }
  return Object.freeze({
    entry,
    absoluteFilename,
    envelope,
    fileSha256: actualFileDigest,
    packageDigest: actualPackageDigest
  });
}

export function validateBuiltinFeatureReleaseInventory(
  repositoryRoot: string,
  inventory: BuiltinFeatureReleaseInventory = ACTIVE_BUILTIN_FEATURE_RELEASE_INVENTORY
): readonly VerifiedBuiltinFeatureRelease[] {
  assertInventoryContract(inventory);
  assertBuiltinFeatureReleaseProjection(createBuiltinFeatureReleaseProjection(inventory), inventory);
  return Object.freeze(inventory.builtins.map((entry) =>
    verifyBuiltinFeatureReleaseFile(resolveInventorySource(repositoryRoot, entry), entry)));
}
