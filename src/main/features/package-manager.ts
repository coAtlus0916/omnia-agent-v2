import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DeclarativeFeatureSurface,
  DeclarativeProgress,
  FeatureArtifactDescriptor,
  FeatureArtifactInputRequest,
  FeatureActionRequest,
  FeatureNavigationGroup,
  FeatureNavigationLeaf,
  FeatureRuntimeSnapshot
} from '../../shared/feature-contracts.js';
import { AppError } from '../../shared/errors.js';
import { connectorResultDigest } from '../../shared/connector-delivery.js';
import type { ProductPaths } from '../paths.js';
import type { ConnectionSnapshot, WorkspaceSafetySnapshot } from '../../shared/contracts.js';
import type { ConnectorTransport } from '../connector/connector-transport.js';
import {
  canonicalJson,
  packageDigest,
  packageFile,
  verifyOfficialPackage,
  type OfficialPackageEnvelope
} from './official-package.js';
import { FeatureRuntimeStore, isFeatureRuntimeStorePort } from './feature-runtime-store.js';
import { FeatureWorkerSupervisor, type FeatureWorkerPortContext } from './worker-supervisor.js';
import type { InteractionLogService } from '../services/interaction-log-service.js';

const PRODUCT_VERSION = '0.4.15';
// A Return action owns the durable mutation authorization while it executes a
// bounded sequence of individually timed signed Operations. The previous
// 15-minute envelope could terminate a healthy multi-row Return after a
// command commit but before read-back. Keep the per-Operation/HTTP deadlines
// unchanged; only allow the authorized batch coordinator to remain alive.
const OMNIA_MUTATION_WORKER_TIMEOUT_MS = 45 * 60_000;
const MAX_SIGNED_OPERATION_COUNT = 64;
const MANAGED_PYTHON_DISTRIBUTION = 'cpython-3.13.14-embed-amd64';
const MANAGED_PYTHON_ARCHIVE_SHA256 = '90b4e5b9898b72d744650524bff92377c367f44bd5fbd09e3148656c080ad907';
const REQUIRED_FEATURE_MEMBERS = [
  'SIGNATURE.json',
  'backend/migrations/001.json',
  'connector-capability/operation.ofop',
  'docs/FEATURE.md',
  'docs/IMPLEMENTATION_MAP.md',
  'docs/manifest.json',
  'frontend/surface.json',
  'manifest.json',
  'middle/worker.cjs',
  'sbom.json'
] as const;
const FEATURE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;

interface FeatureManifest {
  schemaVersion: 'omnia.feature-manifest/v1';
  featureId: string;
  version: string;
  sequence: number;
  displayName: string;
  minimumShellVersion: string;
  requiredIsolation: 'strong' | 'process';
  storeNamespace: string;
  migrationPath: 'backend/migrations/001.json';
  surfacePath: 'frontend/surface.json';
  workerPath: 'middle/worker.cjs';
  operationPackagePath: 'connector-capability/operation.ofop';
  contractsPath?: 'contracts/feature-runtime.json';
  implementationMapPath?: 'contracts/implementation-map.json';
  testsManifestPath?: 'tests/manifest.json';
  assets?: Array<{ path: string; sha256: string; kind: 'governance' | 'runtime_template_base' | 'source_template' }>;
  recoveryCompatibility?: {
    schemaVersion: 'omnia.feature-recovery-compatibility/v1';
    mode: 'partial_close_no_reuse' | 'frozen_input_finalize';
    sourceFeatureVersions: string[];
    actionId: 'recover-interrupted-run' | 'retry-finalization';
  };
  navigation: {
    groups: FeatureNavigationGroup[];
    leaves: Array<Omit<FeatureNavigationLeaf, 'availability' | 'reason'>>;
  };
}

interface DocumentationManifest {
  schemaVersion: 'omnia.feature-documentation/v1';
  featureId: string;
  featureVersion: string;
  documents: Array<{ path: string; sha256: string; purpose: string }>;
}

interface OperationDescriptor {
  operationId: string;
  effect: 'read_only' | 'omnia_mutation';
  requestSchema: string;
  responseSchema: string;
  enabledByDefault: boolean;
  grantsMutationPermit?: boolean;
  permitsOperationId?: string;
  routes: Array<{
    stepId: string;
    method: 'GET' | 'POST' | 'PATCH';
    routeTemplate: string;
    parameters?: Array<{ name: string; type: 'guid' | 'string' }>;
    bodyMode: 'none' | 'single_id_array' | 'information_search' | 'parameter_array' | 'signed_json';
    bodyParameter?: string;
  }>;
}

interface OperationManifest {
  schemaVersion: 'omnia.connector-operation-manifest/v1';
  packageId: string;
  version: string;
  sequence: number;
  featureId: string;
  resourceOwner?: {
    schemaVersion: 'omnia.operation-resource-owner/v1';
    ownerId: string;
    compatibilityVersion: number;
    capabilities: string[];
    compatibleSourcePackageDigests: string[];
  };
  operations: OperationDescriptor[];
}

interface ValidatedOperationPackage {
  envelope: OfficialPackageEnvelope;
  manifest: OperationManifest;
  digest: string;
  capabilityFingerprint: string;
}

function resourceOwnerIdentity(manifest: OperationManifest): string {
  const owner = manifest.resourceOwner;
  if (!owner) return '';
  return canonicalJson({
    schemaVersion: owner.schemaVersion,
    ownerId: owner.ownerId,
    compatibilityVersion: owner.compatibilityVersion,
    capabilities: owner.capabilities
  });
}

function assertCompatibleOperationHandoff(
  source: ValidatedOperationPackage,
  target: ValidatedOperationPackage
): void {
  if (
    source.manifest.featureId !== target.manifest.featureId
    || source.manifest.packageId !== target.manifest.packageId
    || source.manifest.version === target.manifest.version
  ) throw new AppError(
    'FEATURE.OPERATION_HANDOFF_IDENTITY_MISMATCH',
    'The signed Operation handoff does not preserve the exact Feature and package family identity.'
  );
  if (target.manifest.sequence <= source.manifest.sequence) {
    throw new AppError(
      'FEATURE.OPERATION_HANDOFF_UNPROVEN',
      'Operation package replacement must advance the signed publisher sequence.'
    );
  }
  const targetOwner = target.manifest.resourceOwner;
  if (!targetOwner) {
    if (source.manifest.resourceOwner) {
      throw new AppError(
        'FEATURE.OPERATION_OWNER_DOWNGRADE_FORBIDDEN',
        'A signed Operation resource owner cannot be removed by install or rollback.'
      );
    }
    return;
  }
  const sourceOwnerIdentity = resourceOwnerIdentity(source.manifest);
  const targetOwnerIdentity = resourceOwnerIdentity(target.manifest);
  const compatibleStableOwner = sourceOwnerIdentity !== '' && sourceOwnerIdentity === targetOwnerIdentity;
  const compatibleLegacyDigest = sourceOwnerIdentity === ''
    && targetOwner.compatibleSourcePackageDigests.includes(source.digest);
  if (
    (!compatibleStableOwner && !compatibleLegacyDigest)
    || target.capabilityFingerprint !== source.capabilityFingerprint
  ) {
    throw new AppError(
      'FEATURE.OPERATION_HANDOFF_UNPROVEN',
      'The new signed Operation package does not prove compatibility with the active Operation resource owner or exact package digest.'
    );
  }
}

type OperationHandoffPhase =
  | 'staged' | 'prepared' | 'committed' | 'abort_pending' | 'finalize_pending' | 'aborted' | 'finalized';

interface OperationHandoffLedger {
  handoffId: string;
  featureId: string;
  sourceFeatureVersion: string;
  sourcePackageDigest: string;
  sourceOperationPackageDigest: string;
  sourceActivationGeneration: number;
  targetFeatureVersion: string;
  targetPackageDigest: string;
  targetOperationPackageDigest: string;
  targetActivationGeneration: number;
  registrationToken: string;
  replacedPackageDigests: string[];
  phase: OperationHandoffPhase;
  createdAt: string;
  updatedAt: string;
  lastError: string;
}

const ACTIVE_OPERATION_HANDOFF_PHASES: OperationHandoffPhase[] = [
  'staged', 'prepared', 'committed', 'abort_pending', 'finalize_pending'
];

function ensureOperationHandoffLedger(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS feature_operation_handoffs(
      handoff_id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      source_feature_version TEXT NOT NULL,
      source_package_digest TEXT NOT NULL,
      source_operation_package_digest TEXT NOT NULL,
      source_activation_generation INTEGER NOT NULL CHECK(source_activation_generation >= 1),
      target_feature_version TEXT NOT NULL,
      target_package_digest TEXT NOT NULL,
      target_operation_package_digest TEXT NOT NULL,
      target_activation_generation INTEGER NOT NULL CHECK(target_activation_generation >= 1),
      registration_token TEXT NOT NULL,
      replaced_package_digests_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('staged','prepared','committed','abort_pending','finalize_pending','aborted','finalized')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feature_operation_handoffs_one_active
    ON feature_operation_handoffs(feature_id)
    WHERE phase IN ('staged','prepared','committed','abort_pending','finalize_pending');
    CREATE UNIQUE INDEX IF NOT EXISTS feature_operation_handoffs_registration_token
    ON feature_operation_handoffs(registration_token)
    WHERE registration_token<>'';

    CREATE TABLE IF NOT EXISTS feature_operation_registration_adoptions(
      adoption_id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      package_digest TEXT NOT NULL,
      operation_package_digest TEXT NOT NULL,
      activation_generation INTEGER NOT NULL CHECK(activation_generation = 1),
      registration_token TEXT NOT NULL UNIQUE,
      replaced_package_digests_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('finalize_pending','finalized')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feature_operation_registration_adoptions_feature
    ON feature_operation_registration_adoptions(feature_id);
  `);
}

type OperationRegistrationAdoptionPhase = 'finalize_pending' | 'finalized';

interface OperationRegistrationAdoption {
  adoptionId: string;
  featureId: string;
  featureVersion: string;
  packageDigest: string;
  operationPackageDigest: string;
  activationGeneration: 1;
  registrationToken: string;
  replacedPackageDigests: string[];
  phase: OperationRegistrationAdoptionPhase;
}

function operationRegistrationAdoptionFromRow(row: Record<string, unknown>): OperationRegistrationAdoption {
  let replacedPackageDigests: unknown;
  try { replacedPackageDigests = JSON.parse(String(row.replaced_package_digests_json)); }
  catch { throw new AppError('FEATURE.OPERATION_ADOPTION_LEDGER_CORRUPT', 'Operation adoption replacement identity is invalid.'); }
  if (!Array.isArray(replacedPackageDigests)
    || replacedPackageDigests.length < 1
    || replacedPackageDigests.some((digest) => typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest))
    || canonicalJson([...new Set(replacedPackageDigests)].sort()) !== canonicalJson(replacedPackageDigests)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(String(row.adoption_id))
    || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(String(row.feature_id))
    || !/^\d+\.\d+\.\d+$/u.test(String(row.feature_version))
    || !/^sha256:[0-9a-f]{64}$/u.test(String(row.package_digest))
    || !/^sha256:[0-9a-f]{64}$/u.test(String(row.operation_package_digest))
    || Number(row.activation_generation) !== 1
    || !/^[0-9a-f]{64}$/u.test(String(row.registration_token))
    || !['finalize_pending', 'finalized'].includes(String(row.phase))) {
    throw new AppError('FEATURE.OPERATION_ADOPTION_LEDGER_CORRUPT', 'Operation adoption ledger fields are invalid.');
  }
  return {
    adoptionId: String(row.adoption_id),
    featureId: String(row.feature_id),
    featureVersion: String(row.feature_version),
    packageDigest: String(row.package_digest),
    operationPackageDigest: String(row.operation_package_digest),
    activationGeneration: 1,
    registrationToken: String(row.registration_token),
    replacedPackageDigests,
    phase: String(row.phase) as OperationRegistrationAdoptionPhase
  };
}

function operationRegistrationAdoptionByToken(
  database: DatabaseSync,
  featureId: string,
  registrationToken: string
): OperationRegistrationAdoption | null {
  const row = database.prepare(`
    SELECT * FROM feature_operation_registration_adoptions
    WHERE feature_id=? AND registration_token=?
  `).get(featureId, registrationToken) as Record<string, unknown> | undefined;
  return row ? operationRegistrationAdoptionFromRow(row) : null;
}

function operationHandoffFromRow(row: Record<string, unknown>): OperationHandoffLedger {
  let replacedPackageDigests: unknown;
  try { replacedPackageDigests = JSON.parse(String(row.replaced_package_digests_json)); }
  catch { throw new AppError('FEATURE.OPERATION_HANDOFF_LEDGER_CORRUPT', 'Operation handoff ledger replacement identity is invalid.'); }
  const phase = String(row.phase) as OperationHandoffPhase;
  const registrationToken = String(row.registration_token);
  if (!Array.isArray(replacedPackageDigests)
    || replacedPackageDigests.some((digest) => typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest))
    || canonicalJson([...new Set(replacedPackageDigests)].sort()) !== canonicalJson(replacedPackageDigests)
    || !/^sha256:[0-9a-f]{64}$/u.test(String(row.source_package_digest))
    || !/^sha256:[0-9a-f]{64}$/u.test(String(row.source_operation_package_digest))
    || !/^sha256:[0-9a-f]{64}$/u.test(String(row.target_package_digest))
    || !/^sha256:[0-9a-f]{64}$/u.test(String(row.target_operation_package_digest))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(String(row.handoff_id))
    || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(String(row.feature_id))
    || !/^\d+\.\d+\.\d+$/u.test(String(row.source_feature_version))
    || !/^\d+\.\d+\.\d+$/u.test(String(row.target_feature_version))
    || String(row.source_feature_version) === String(row.target_feature_version)
    || !ACTIVE_OPERATION_HANDOFF_PHASES.concat('aborted', 'finalized').includes(phase)
    || !Number.isSafeInteger(Number(row.source_activation_generation))
    || Number(row.source_activation_generation) < 1
    || !Number.isSafeInteger(Number(row.target_activation_generation))
    || Number(row.target_activation_generation) <= Number(row.source_activation_generation)
    || !Number.isFinite(Date.parse(String(row.created_at)))
    || !Number.isFinite(Date.parse(String(row.updated_at)))
    || (phase === 'staged'
      ? registrationToken !== '' || replacedPackageDigests.length !== 0
      : !/^[0-9a-f]{64}$/u.test(registrationToken)
        || canonicalJson(replacedPackageDigests) !== canonicalJson([String(row.source_operation_package_digest)]))) {
    throw new AppError('FEATURE.OPERATION_HANDOFF_LEDGER_CORRUPT', 'Operation handoff ledger fields are invalid.');
  }
  return {
    handoffId: String(row.handoff_id),
    featureId: String(row.feature_id),
    sourceFeatureVersion: String(row.source_feature_version),
    sourcePackageDigest: String(row.source_package_digest),
    sourceOperationPackageDigest: String(row.source_operation_package_digest),
    sourceActivationGeneration: Number(row.source_activation_generation),
    targetFeatureVersion: String(row.target_feature_version),
    targetPackageDigest: String(row.target_package_digest),
    targetOperationPackageDigest: String(row.target_operation_package_digest),
    targetActivationGeneration: Number(row.target_activation_generation),
    registrationToken,
    replacedPackageDigests,
    phase,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastError: String(row.last_error)
  };
}

function activeOperationHandoff(database: DatabaseSync, featureId: string): OperationHandoffLedger | null {
  const rows = database.prepare(`
    SELECT * FROM feature_operation_handoffs
    WHERE feature_id=? AND phase IN ('staged','prepared','committed','abort_pending','finalize_pending')
    ORDER BY created_at,handoff_id
  `).all(featureId) as Array<Record<string, unknown>>;
  if (rows.length > 1) {
    throw new AppError('FEATURE.OPERATION_HANDOFF_LEDGER_AMBIGUOUS', 'More than one durable Operation handoff exists for this Feature.');
  }
  return rows[0] ? operationHandoffFromRow(rows[0]) : null;
}

function operationHandoffByToken(
  database: DatabaseSync,
  featureId: string,
  registrationToken: string
): OperationHandoffLedger | null {
  if (!/^[0-9a-f]{64}$/u.test(registrationToken)) return null;
  const rows = database.prepare(`
    SELECT * FROM feature_operation_handoffs
    WHERE feature_id=? AND registration_token=?
    ORDER BY created_at,handoff_id
  `).all(featureId, registrationToken) as Array<Record<string, unknown>>;
  if (rows.length > 1) {
    throw new AppError(
      'FEATURE.OPERATION_HANDOFF_LEDGER_AMBIGUOUS',
      'More than one durable Operation handoff uses the same Connector registration token.'
    );
  }
  return rows[0] ? operationHandoffFromRow(rows[0]) : null;
}

function assertNoActiveOperationHandoff(database: DatabaseSync, featureId: string, mutation: string): void {
  const active = activeOperationHandoff(database, featureId);
  if (active) {
    throw new AppError(
      'FEATURE.OPERATION_HANDOFF_IN_PROGRESS',
      `${mutation} is blocked while the exact ${active.sourceFeatureVersion} -> ${active.targetFeatureVersion} Operation handoff is ${active.phase}.`
    );
  }
}

async function ensureExactSourceOperationRegistration(
  database: DatabaseSync,
  connector: ConnectorTransport,
  input: {
    featureId: string;
    featureVersion: string;
    operationPackage: unknown;
    validatedOperationPackage: ValidatedOperationPackage;
  }
): Promise<void> {
  const expected = input.validatedOperationPackage;
  let registration = await connector.registerOperation({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: input.featureId,
    featureVersion: input.featureVersion,
    operationPackage: input.operationPackage
  });
  const exactReplacementHistory = () => {
    if (!Array.isArray(registration.replacedPackageDigests)
      || typeof registration.registrationToken !== 'string'
      || !/^[0-9a-f]{64}$/u.test(registration.registrationToken)) return false;
    if (registration.replacedPackageDigests.length === 0) return true;
    const prior = operationHandoffByToken(database, input.featureId, registration.registrationToken);
    if (prior?.phase === 'finalized'
      && prior.targetFeatureVersion === input.featureVersion
      && prior.targetOperationPackageDigest === expected.digest
      && canonicalJson(prior.replacedPackageDigests)
        === canonicalJson(registration.replacedPackageDigests)) return true;
    const adoption = operationRegistrationAdoptionByToken(
      database, input.featureId, registration.registrationToken
    );
    return adoption?.phase === 'finalized'
      && adoption.featureVersion === input.featureVersion
      && adoption.operationPackageDigest === expected.digest
      && canonicalJson(adoption.replacedPackageDigests)
        === canonicalJson(registration.replacedPackageDigests);
  };
  const exactIdentity = () => (
    registration.schemaVersion === 'omnia.operation-registration-result/v1'
    && registration.featureId === input.featureId
    && registration.featureVersion === input.featureVersion
    && registration.packageId === expected.manifest.packageId
    && registration.packageDigest === expected.digest
    && Array.isArray(registration.operationIds)
    && canonicalJson([...registration.operationIds].sort())
      === canonicalJson(expected.manifest.operations.map((operation) => operation.operationId).sort())
    && exactReplacementHistory()
  );
  if (!exactIdentity() || !['prepared', 'committed'].includes(registration.registrationState)) {
    const observed = JSON.stringify({
      schemaVersion: registration.schemaVersion,
      featureId: registration.featureId,
      featureVersion: registration.featureVersion,
      packageId: registration.packageId,
      packageDigest: registration.packageDigest,
      registrationState: registration.registrationState,
      operationIds: registration.operationIds,
      replacedPackageDigests: registration.replacedPackageDigests,
      registrationTokenValid: typeof registration.registrationToken === 'string'
        && /^[0-9a-f]{64}$/u.test(registration.registrationToken)
    });
    throw new AppError(
      'FEATURE.OPERATION_HANDOFF_SOURCE_REGISTRATION_UNPROVEN',
      `Connector did not prove the exact active source Operation registration before handoff: ${observed}`
    );
  }
  if (registration.registrationState === 'prepared') {
    const registrationToken = registration.registrationToken;
    registration = await connector.registerOperation({
      schemaVersion: 'omnia.operation-registration-commit/v1',
      featureId: input.featureId,
      featureVersion: input.featureVersion,
      operationPackageDigest: expected.digest,
      registrationToken
    });
    if (!exactIdentity()
      || registration.registrationState !== 'committed'
      || registration.registrationToken !== registrationToken) {
      throw new AppError(
        'FEATURE.OPERATION_HANDOFF_SOURCE_COMMIT_DRIFT',
        'Connector did not commit the exact active source Operation registration before handoff.'
      );
    }
  }
}

async function registerExactOperationHandoff(
  connector: ConnectorTransport,
  input: {
    featureId: string;
    featureVersion: string;
    operationPackage: unknown;
    operationManifest: OperationManifest;
    operationPackageDigest: string;
    sourceOperationPackageDigest: string;
  }
): Promise<{
  registrationState: 'prepared' | 'committed';
  registrationToken: string;
  replacedPackageDigests: string[];
}> {
  const registration = await connector.registerOperation({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: input.featureId,
    featureVersion: input.featureVersion,
    operationPackage: input.operationPackage
  });
  const expectedOperationIds = input.operationManifest.operations.map((operation) => operation.operationId).sort();
  if (
    registration.schemaVersion !== 'omnia.operation-registration-result/v1'
    || registration.featureId !== input.featureId
    || registration.featureVersion !== input.featureVersion
    || registration.packageId !== input.operationManifest.packageId
    || registration.packageDigest !== input.operationPackageDigest
    || !['prepared', 'committed'].includes(registration.registrationState)
    || typeof registration.registrationToken !== 'string'
    || !/^[0-9a-f]{64}$/u.test(registration.registrationToken)
    || !Array.isArray(registration.replacedPackageDigests)
    || canonicalJson([...new Set(registration.replacedPackageDigests)].sort())
      !== canonicalJson(registration.replacedPackageDigests)
    || canonicalJson(registration.replacedPackageDigests)
      !== canonicalJson([input.sourceOperationPackageDigest])
    || !Array.isArray(registration.operationIds)
    || canonicalJson([...registration.operationIds].sort()) !== canonicalJson(expectedOperationIds)
  ) throw new AppError(
    'FEATURE.OPERATION_HANDOFF_REGISTRATION_DRIFT',
    'Connector Operation handoff returned another signed package identity.'
  );
  return {
    registrationState: registration.registrationState === 'prepared' ? 'prepared' : 'committed',
    registrationToken: registration.registrationToken,
    replacedPackageDigests: [...registration.replacedPackageDigests]
  };
}

async function restoreExactCommittedOperationHandoff(
  connector: ConnectorTransport,
  input: {
    featureId: string;
    featureVersion: string;
    operationPackage: unknown;
    operationManifest: OperationManifest;
    operationPackageDigest: string;
    sourceOperationPackageDigest: string;
    registrationToken: string;
  }
): Promise<void> {
  const registration = await registerExactOperationHandoff(connector, input);
  if (registration.registrationState !== 'committed'
    || registration.registrationToken !== input.registrationToken) {
    throw new AppError(
      'FEATURE.OPERATION_HANDOFF_RESTORE_DRIFT',
      'Connector did not restore the exact committed Operation registration token.'
    );
  }
}

async function commitExactOperationHandoff(
  connector: ConnectorTransport,
  input: {
    featureId: string;
    featureVersion: string;
    operationPackageDigest: string;
    registrationToken: string;
    operationManifest: OperationManifest;
    replacedPackageDigests: string[];
  }
): Promise<void> {
  const registration = await connector.registerOperation({
    schemaVersion: 'omnia.operation-registration-commit/v1',
    featureId: input.featureId,
    featureVersion: input.featureVersion,
    operationPackageDigest: input.operationPackageDigest,
    registrationToken: input.registrationToken
  });
  const expectedOperationIds = input.operationManifest.operations.map((operation) => operation.operationId).sort();
  if (
    registration.schemaVersion !== 'omnia.operation-registration-result/v1'
    || registration.featureId !== input.featureId
    || registration.featureVersion !== input.featureVersion
    || registration.packageId !== input.operationManifest.packageId
    || registration.packageDigest !== input.operationPackageDigest
    || registration.registrationState !== 'committed'
    || registration.registrationToken !== input.registrationToken
    || !Array.isArray(registration.replacedPackageDigests)
    || canonicalJson(registration.replacedPackageDigests) !== canonicalJson(input.replacedPackageDigests)
    || !Array.isArray(registration.operationIds)
    || canonicalJson([...registration.operationIds].sort()) !== canonicalJson(expectedOperationIds)
  ) throw new AppError(
    'FEATURE.OPERATION_HANDOFF_COMMIT_DRIFT',
    'Connector Operation handoff commit returned another registration identity.'
  );
}

async function finalizeExactOperationHandoff(
  connector: ConnectorTransport,
  input: {
    featureId: string;
    featureVersion: string;
    operationPackageDigest: string;
    registrationToken: string;
    operationManifest: OperationManifest;
    replacedPackageDigests: string[];
  }
): Promise<void> {
  const registration = await connector.registerOperation({
    schemaVersion: 'omnia.operation-registration-finalize/v1',
    featureId: input.featureId,
    featureVersion: input.featureVersion,
    operationPackageDigest: input.operationPackageDigest,
    registrationToken: input.registrationToken
  });
  const expectedOperationIds = input.operationManifest.operations.map((operation) => operation.operationId).sort();
  if (
    registration.schemaVersion !== 'omnia.operation-registration-result/v1'
    || registration.featureId !== input.featureId
    || registration.featureVersion !== input.featureVersion
    || registration.packageId !== input.operationManifest.packageId
    || registration.packageDigest !== input.operationPackageDigest
    || registration.registrationState !== 'committed'
    || registration.registrationToken !== input.registrationToken
    || !Array.isArray(registration.replacedPackageDigests)
    || canonicalJson([...new Set(registration.replacedPackageDigests)].sort())
      !== canonicalJson(registration.replacedPackageDigests)
    || canonicalJson(registration.replacedPackageDigests) !== canonicalJson(input.replacedPackageDigests)
    || !Array.isArray(registration.operationIds)
    || canonicalJson([...registration.operationIds].sort()) !== canonicalJson(expectedOperationIds)
  ) throw new AppError(
    'FEATURE.OPERATION_HANDOFF_FINALIZE_DRIFT',
    'Connector Operation handoff finalize returned another registration identity.'
  );
}

async function finalizeExactBaselineOperationAdoption(
  database: DatabaseSync,
  connector: ConnectorTransport,
  input: {
    featureId: string;
    featureVersion: string;
    packageDigest: string;
    activationGeneration: number;
    operationPackageDigest: string;
    registrationToken: string;
    operationManifest: OperationManifest;
    replacedPackageDigests: string[];
  }
): Promise<void> {
  if (input.activationGeneration !== 1
    || input.replacedPackageDigests.length < 1
    || canonicalJson([...new Set(input.replacedPackageDigests)].sort())
      !== canonicalJson(input.replacedPackageDigests)) {
    throw new AppError(
      'FEATURE.OPERATION_ADOPTION_REFUSED',
      'Only an exact first-generation committed Operation registration may be adopted.'
    );
  }
  let adoption = operationRegistrationAdoptionByToken(
    database, input.featureId, input.registrationToken
  );
  if (!adoption) {
    const now = utcNow();
    database.exec('BEGIN IMMEDIATE;');
    try {
      const head = database.prepare(`
        SELECT feature_version,package_digest,activation_generation,runtime_enabled
        FROM feature_activation_heads WHERE feature_id=?
      `).get(input.featureId) as Record<string, unknown> | undefined;
      const events = database.prepare(`
        SELECT from_version,to_version,event_type,activation_generation,package_digest
        FROM feature_activation_events WHERE feature_id=?
        ORDER BY occurred_at,event_id
      `).all(input.featureId) as Array<Record<string, unknown>>;
      const anyCommand = database.prepare(`
        SELECT 1
        FROM feature_commands c JOIN feature_runs r ON r.run_id=c.run_id
        WHERE r.feature_id=? LIMIT 1
      `).get(input.featureId);
      const anyHandoff = database.prepare(`
        SELECT 1 FROM feature_operation_handoffs WHERE feature_id=? LIMIT 1
      `).get(input.featureId);
      const priorAdoption = database.prepare(`
        SELECT 1 FROM feature_operation_registration_adoptions WHERE feature_id=? LIMIT 1
      `).get(input.featureId);
      if (!head
        || String(head.feature_version) !== input.featureVersion
        || String(head.package_digest) !== input.packageDigest
        || Number(head.activation_generation) !== 1
        || Number(head.runtime_enabled) !== 1
        || events.length !== 1
        || String(events[0]!.from_version) !== ''
        || String(events[0]!.to_version) !== input.featureVersion
        || String(events[0]!.event_type) !== 'install'
        || Number(events[0]!.activation_generation) !== 1
        || String(events[0]!.package_digest) !== input.packageDigest
        || anyCommand || anyHandoff || priorAdoption) {
        throw new AppError(
          'FEATURE.OPERATION_ADOPTION_REFUSED',
          'Existing Operation registrations require a normal durable Core handoff outside an unused first-generation baseline.'
        );
      }
      database.prepare(`
        INSERT INTO feature_operation_registration_adoptions(
          adoption_id,feature_id,feature_version,package_digest,operation_package_digest,
          activation_generation,registration_token,replaced_package_digests_json,phase,
          created_at,updated_at,last_error
        ) VALUES(?,?,?,?,?,1,?,?,'finalize_pending',?,?, '')
      `).run(
        randomUUID(), input.featureId, input.featureVersion, input.packageDigest,
        input.operationPackageDigest, input.registrationToken,
        canonicalJson(input.replacedPackageDigests), now, now
      );
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
    adoption = operationRegistrationAdoptionByToken(database, input.featureId, input.registrationToken);
  }
  if (!adoption
    || adoption.featureVersion !== input.featureVersion
    || adoption.packageDigest !== input.packageDigest
    || adoption.operationPackageDigest !== input.operationPackageDigest
    || adoption.activationGeneration !== input.activationGeneration
    || canonicalJson(adoption.replacedPackageDigests) !== canonicalJson(input.replacedPackageDigests)) {
    throw new AppError(
      'FEATURE.OPERATION_ADOPTION_LEDGER_DRIFT',
      'The durable Operation adoption identity differs from the active signed package.'
    );
  }
  if (adoption.phase === 'finalized') return;
  try {
    await finalizeExactOperationHandoff(connector, input);
    const changed = database.prepare(`
      UPDATE feature_operation_registration_adoptions
      SET phase='finalized',updated_at=?,last_error=''
      WHERE adoption_id=? AND phase='finalize_pending'
    `).run(utcNow(), adoption.adoptionId);
    if (changed.changes !== 1) throw new AppError(
      'FEATURE.OPERATION_ADOPTION_LEDGER_DRIFT',
      'Operation adoption changed while finalization was in flight.'
    );
  } catch (error) {
    database.prepare(`
      UPDATE feature_operation_registration_adoptions
      SET updated_at=?,last_error=?
      WHERE adoption_id=? AND phase='finalize_pending'
    `).run(
      utcNow(), error instanceof Error ? error.message.slice(0, 1000) : 'Operation adoption finalize failed.',
      adoption.adoptionId
    );
    throw error;
  }
}

async function abortExactOperationHandoff(
  connector: ConnectorTransport,
  input: {
    featureId: string;
    featureVersion: string;
    operationPackageDigest: string;
    registrationToken: string;
    operationManifest: OperationManifest;
    sourceOperationPackageDigest: string;
  }
): Promise<void> {
  const registration = await connector.registerOperation({
    schemaVersion: 'omnia.operation-registration-abort/v1',
    featureId: input.featureId,
    featureVersion: input.featureVersion,
    operationPackageDigest: input.operationPackageDigest,
    registrationToken: input.registrationToken
  });
  const expectedOperationIds = input.operationManifest.operations.map((operation) => operation.operationId).sort();
  if (
    registration.schemaVersion !== 'omnia.operation-registration-result/v1'
    || registration.featureId !== input.featureId
    || registration.featureVersion !== input.featureVersion
    || registration.packageId !== input.operationManifest.packageId
    || registration.packageDigest !== input.operationPackageDigest
    || registration.registrationState !== 'aborted'
    || registration.registrationToken !== input.registrationToken
    || !Array.isArray(registration.replacedPackageDigests)
    || canonicalJson(registration.replacedPackageDigests) !== canonicalJson([input.sourceOperationPackageDigest])
    || !Array.isArray(registration.operationIds)
    || canonicalJson([...registration.operationIds].sort()) !== canonicalJson(expectedOperationIds)
  ) throw new AppError(
    'FEATURE.OPERATION_HANDOFF_ABORT_DRIFT',
    'Connector Operation handoff abort returned another registration identity.'
  );
}

function persistPreparedOperationHandoff(
  database: DatabaseSync,
  source: ActivationHead,
  target: ActivationHead,
  registrationToken: string,
  replacedPackageDigests: string[],
  preparedAt: string
): void {
  if (!/^[0-9a-f]{64}$/u.test(registrationToken)
    || !Array.isArray(replacedPackageDigests)
    || !Number.isFinite(Date.parse(preparedAt))) {
    throw new AppError('FEATURE.OPERATION_HANDOFF_PREPARE_INVALID', 'Operation handoff preparation identity is invalid.');
  }
  database.exec('BEGIN IMMEDIATE;');
  try {
    const ledger = activeOperationHandoff(database, source.featureId);
    if (!ledger
      || ledger.sourceFeatureVersion !== source.featureVersion
      || ledger.sourcePackageDigest !== source.packageDigest
      || ledger.sourceActivationGeneration !== source.activationGeneration
      || ledger.targetFeatureVersion !== target.featureVersion
      || ledger.targetPackageDigest !== target.packageDigest
      || ledger.targetActivationGeneration !== target.activationGeneration
      || !['staged', 'prepared', 'committed'].includes(ledger.phase)
      || canonicalJson(replacedPackageDigests) !== canonicalJson([ledger.sourceOperationPackageDigest])
      || (ledger.phase !== 'staged' && (
        ledger.registrationToken !== registrationToken
        || canonicalJson(ledger.replacedPackageDigests) !== canonicalJson(replacedPackageDigests)
      ))) {
      throw new AppError('FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Durable Operation handoff changed during prepare.');
    }
    const active = database.prepare(`
      SELECT feature_version,activation_generation,runtime_enabled,package_digest
      FROM feature_activation_heads WHERE feature_id=?
    `).get(source.featureId) as Record<string, unknown> | undefined;
    if (!active
      || active.feature_version !== source.featureVersion
      || Number(active.activation_generation) !== source.activationGeneration
      || active.package_digest !== source.packageDigest) {
      throw new AppError('FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH', 'Feature activation head changed during Operation handoff prepare.');
    }
    const staged = database.prepare(`UPDATE feature_registry SET lifecycle='candidate',health=?
      WHERE feature_id=? AND feature_version=? AND package_digest=? AND lifecycle='candidate'`).run(
        ledger.phase === 'committed'
          ? `operation_handoff_committed:${registrationToken}`
          : `operation_handoff_prepared:${registrationToken}`,
        target.featureId, target.featureVersion, target.packageDigest
      );
    if (staged.changes !== 1) {
      throw new AppError('FEATURE.OPERATION_HANDOFF_CANDIDATE_CAS_MISMATCH', 'Operation handoff candidate changed during prepare.');
    }
    if (ledger.phase === 'staged') {
      const prepared = database.prepare(`
        UPDATE feature_operation_handoffs
        SET registration_token=?,replaced_package_digests_json=?,phase='prepared',updated_at=?,last_error=''
        WHERE handoff_id=? AND phase='staged' AND registration_token=''
      `).run(registrationToken, JSON.stringify(replacedPackageDigests), preparedAt, ledger.handoffId);
      if (prepared.changes !== 1) {
        throw new AppError('FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Durable Operation handoff token changed during prepare.');
      }
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function persistCommittedOperationHandoff(
  database: DatabaseSync,
  source: ActivationHead,
  target: ActivationHead,
  registrationToken: string,
  replacedPackageDigests: string[],
  committedAt: string
): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const ledger = activeOperationHandoff(database, source.featureId);
    if (!ledger
      || ledger.sourceFeatureVersion !== source.featureVersion
      || ledger.sourcePackageDigest !== source.packageDigest
      || ledger.sourceActivationGeneration !== source.activationGeneration
      || ledger.targetFeatureVersion !== target.featureVersion
      || ledger.targetPackageDigest !== target.packageDigest
      || ledger.targetActivationGeneration !== target.activationGeneration
      || !['prepared', 'committed'].includes(ledger.phase)
      || ledger.registrationToken !== registrationToken
      || canonicalJson(ledger.replacedPackageDigests) !== canonicalJson(replacedPackageDigests)
      || canonicalJson(replacedPackageDigests) !== canonicalJson([ledger.sourceOperationPackageDigest])) {
      throw new AppError('FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Durable Operation handoff changed before commit persistence.');
    }
    const active = database.prepare(`SELECT feature_version,activation_generation,runtime_enabled,package_digest
      FROM feature_activation_heads WHERE feature_id=?`).get(source.featureId) as Record<string, unknown> | undefined;
    if (!active || active.feature_version !== source.featureVersion
      || Number(active.activation_generation) !== source.activationGeneration
      || active.package_digest !== source.packageDigest) {
      throw new AppError('FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH', 'Feature activation head changed before Operation handoff commit persistence.');
    }
    if (ledger.phase === 'prepared') {
      const committed = database.prepare(`UPDATE feature_operation_handoffs
        SET phase='committed',updated_at=?,last_error=''
        WHERE handoff_id=? AND phase='prepared' AND registration_token=? AND target_package_digest=?`)
        .run(committedAt, ledger.handoffId, registrationToken, target.packageDigest);
      if (committed.changes !== 1) throw new AppError(
        'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Durable Operation handoff commit phase changed.'
      );
    }
    const candidate = database.prepare(`UPDATE feature_registry SET health=?
      WHERE feature_id=? AND feature_version=? AND package_digest=? AND lifecycle='candidate'`)
      .run(`operation_handoff_committed:${registrationToken}`, target.featureId, target.featureVersion, target.packageDigest);
    if (candidate.changes !== 1) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_CANDIDATE_CAS_MISMATCH', 'Operation handoff candidate changed before commit persistence.'
    );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function finalizePreparedOperationHandoff(
  database: DatabaseSync,
  source: ActivationHead,
  target: ActivationHead,
  registrationToken: string,
  finalizedAt: string
): void {
  if (!/^[0-9a-f]{64}$/u.test(registrationToken)) {
    throw new AppError('FEATURE.OPERATION_HANDOFF_FINALIZE_INVALID', 'Operation handoff finalize token is invalid.');
  }
  database.exec('BEGIN IMMEDIATE;');
  try {
    const ledger = activeOperationHandoff(database, source.featureId);
    if (!ledger
      || ledger.phase !== 'committed'
      || ledger.registrationToken !== registrationToken
      || ledger.sourceFeatureVersion !== source.featureVersion
      || ledger.sourcePackageDigest !== source.packageDigest
      || ledger.sourceActivationGeneration !== source.activationGeneration
      || ledger.targetFeatureVersion !== target.featureVersion
      || ledger.targetPackageDigest !== target.packageDigest
      || ledger.targetActivationGeneration !== target.activationGeneration
      || canonicalJson(ledger.replacedPackageDigests) !== canonicalJson([ledger.sourceOperationPackageDigest])) {
      throw new AppError('FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Committed Operation handoff ledger identity changed before Core activation.');
    }
    const finalized = database.prepare(`
      UPDATE feature_activation_heads
      SET feature_version=?,activation_generation=?,runtime_enabled=1,runtime_reason='',
          package_path=?,package_digest=?,updated_at=?,documentation_path=?
      WHERE feature_id=? AND feature_version=? AND package_digest=? AND activation_generation=?
    `).run(
      target.featureVersion, target.activationGeneration, target.packagePath, target.packageDigest,
      finalizedAt, target.documentationPath, target.featureId, source.featureVersion,
      source.packageDigest, source.activationGeneration
    );
    if (finalized.changes !== 1) {
      throw new AppError('FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH', 'Prepared Feature activation head changed before Operation handoff completion.');
    }
    const sourceRegistry = database.prepare(`UPDATE feature_registry SET lifecycle='previous'
      WHERE feature_id=? AND feature_version=? AND package_digest=? AND lifecycle IN ('active','candidate')`)
      .run(source.featureId, source.featureVersion, source.packageDigest);
    const sourceDocumentation = database.prepare(`UPDATE documentation_registry SET lifecycle='previous'
      WHERE feature_id=? AND feature_version=? AND lifecycle='active'`)
      .run(source.featureId, source.featureVersion);
    const targetRegistry = database.prepare(`UPDATE feature_registry SET lifecycle='active',health=?,activated_at=?
      WHERE feature_id=? AND feature_version=? AND package_digest=? AND lifecycle='candidate'`)
      .run(`operation_handoff_finalize_pending:${registrationToken}`, finalizedAt, target.featureId, target.featureVersion, target.packageDigest);
    const targetDocumentation = database.prepare(`UPDATE documentation_registry SET lifecycle='active',activated_at=?
      WHERE feature_id=? AND feature_version=? AND lifecycle='candidate'`)
      .run(finalizedAt, target.featureId, target.featureVersion);
    if ([sourceRegistry, sourceDocumentation, targetRegistry, targetDocumentation].some((result) => result.changes !== 1)) {
      throw new AppError(
        'FEATURE.OPERATION_HANDOFF_CANDIDATE_CAS_MISMATCH',
        'Feature or documentation lifecycle changed before the exact Core activation transaction.'
      );
    }
    const existingEvent = database.prepare(`
      SELECT event_id FROM feature_activation_events
      WHERE feature_id=? AND from_version=? AND to_version=? AND event_type='upgrade'
        AND activation_generation=? AND package_digest=?
    `).get(
      target.featureId, source.featureVersion, target.featureVersion,
      target.activationGeneration, target.packageDigest
    );
    if (!existingEvent) database.prepare(`
      INSERT INTO feature_activation_events(
        event_id,feature_id,from_version,to_version,event_type,activation_generation,package_digest,occurred_at
      ) VALUES(?,?,?,?, 'upgrade',?,?,?)
    `).run(
      randomUUID(), target.featureId, source.featureVersion, target.featureVersion,
      target.activationGeneration, target.packageDigest, finalizedAt
    );
    const ledgerFinalized = database.prepare(`
      UPDATE feature_operation_handoffs SET phase='finalize_pending',updated_at=?,last_error=''
      WHERE handoff_id=? AND phase='committed' AND registration_token=? AND target_package_digest=?
    `).run(finalizedAt, ledger.handoffId, registrationToken, target.packageDigest);
    if (ledgerFinalized.changes !== 1) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Operation handoff ledger changed during Core activation.'
    );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function markOperationHandoffAbortPending(
  database: DatabaseSync,
  ledger: OperationHandoffLedger,
  error: unknown,
  updatedAt: string
): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const head = database.prepare(`SELECT feature_version,package_digest,activation_generation,runtime_enabled
      FROM feature_activation_heads WHERE feature_id=?`).get(ledger.featureId) as Record<string, unknown> | undefined;
    if (!head || head.feature_version !== ledger.sourceFeatureVersion
      || head.package_digest !== ledger.sourcePackageDigest
      || Number(head.activation_generation) !== ledger.sourceActivationGeneration) throw new AppError(
        'FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH',
        'Source activation head changed before the Operation handoff could enter abort reconciliation.'
      );
    const changed = database.prepare(`UPDATE feature_operation_handoffs
      SET phase='abort_pending',updated_at=?,last_error=?
      WHERE handoff_id=? AND source_package_digest=? AND source_operation_package_digest=?
        AND target_package_digest=? AND target_operation_package_digest=?
        AND registration_token=? AND phase IN ('prepared','committed')`)
      .run(
        updatedAt, error instanceof Error ? error.message.slice(0, 1000) : 'Core activation CAS failed.',
        ledger.handoffId, ledger.sourcePackageDigest, ledger.sourceOperationPackageDigest,
        ledger.targetPackageDigest, ledger.targetOperationPackageDigest, ledger.registrationToken
      );
    if (changed.changes !== 1) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Operation handoff could not enter abort-pending reconciliation.'
    );
    database.exec('COMMIT;');
  } catch (handoffError) {
    database.exec('ROLLBACK;');
    throw handoffError;
  }
}

function completeAbortedOperationHandoff(
  database: DatabaseSync,
  ledger: OperationHandoffLedger,
  abortedAt: string
): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const head = database.prepare(`SELECT feature_version,package_digest,activation_generation,runtime_enabled
      FROM feature_activation_heads WHERE feature_id=?`).get(ledger.featureId) as Record<string, unknown> | undefined;
    if (!head || head.feature_version !== ledger.sourceFeatureVersion
      || head.package_digest !== ledger.sourcePackageDigest
      || Number(head.activation_generation) !== ledger.sourceActivationGeneration) throw new AppError(
        'FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH', 'Source activation head changed before Operation handoff abort completion.'
      );
    const aborted = database.prepare(`UPDATE feature_operation_handoffs
      SET phase='aborted',updated_at=?,last_error=''
      WHERE handoff_id=? AND phase='abort_pending' AND registration_token=?`)
      .run(abortedAt, ledger.handoffId, ledger.registrationToken);
    if (aborted.changes !== 1) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Operation handoff abort phase changed.'
    );
    const targetRegistry = database.prepare(`UPDATE feature_registry SET lifecycle='rejected',health='operation_handoff_aborted'
      WHERE feature_id=? AND feature_version=? AND package_digest=? AND lifecycle='candidate'`)
      .run(ledger.featureId, ledger.targetFeatureVersion, ledger.targetPackageDigest);
    const targetDocumentation = database.prepare(`UPDATE documentation_registry SET lifecycle='previous'
      WHERE feature_id=? AND feature_version=? AND lifecycle='candidate'`)
      .run(ledger.featureId, ledger.targetFeatureVersion);
    if (targetRegistry.changes !== 1 || targetDocumentation.changes !== 1) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_CANDIDATE_CAS_MISMATCH',
      'Operation handoff target changed before abort completion.'
    );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function completeFinalizedOperationHandoff(
  database: DatabaseSync,
  ledger: OperationHandoffLedger,
  finalizedAt: string
): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const head = database.prepare(`SELECT feature_version,package_digest,activation_generation,runtime_enabled
      FROM feature_activation_heads WHERE feature_id=?`).get(ledger.featureId) as Record<string, unknown> | undefined;
    if (!head || head.feature_version !== ledger.targetFeatureVersion
      || head.package_digest !== ledger.targetPackageDigest
      || Number(head.activation_generation) !== ledger.targetActivationGeneration
      || Number(head.runtime_enabled) !== 1) throw new AppError(
        'FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH', 'Target activation head changed before Operation handoff finalize completion.'
      );
    const completed = database.prepare(`UPDATE feature_operation_handoffs
      SET phase='finalized',updated_at=?,last_error=''
      WHERE handoff_id=? AND phase='finalize_pending' AND registration_token=?`)
      .run(finalizedAt, ledger.handoffId, ledger.registrationToken);
    if (completed.changes !== 1) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH', 'Operation handoff finalize phase changed.'
    );
    const targetRegistry = database.prepare(`UPDATE feature_registry SET health='ready'
      WHERE feature_id=? AND feature_version=? AND package_digest=? AND lifecycle='active'`)
      .run(ledger.featureId, ledger.targetFeatureVersion, ledger.targetPackageDigest);
    if (targetRegistry.changes !== 1) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_CANDIDATE_CAS_MISMATCH',
      'Operation handoff target changed before finalize completion.'
    );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

interface ActivationHead {
  featureId: string;
  featureVersion: string;
  activationGeneration: number;
  runtimeEnabled: boolean;
  runtimeReason: string;
  packagePath: string;
  packageDigest: string;
  documentationPath: string;
}

interface InstalledFeaturePackage {
  manifest: FeatureManifest;
  surface: DeclarativeFeatureSurface;
  envelope: OfficialPackageEnvelope;
  root: string;
  pythonSidecar: PythonSidecarDeclaration | null;
  runtimeContract: FeatureRuntimeContractDeclaration | null;
}

interface FeatureAiReviewCapabilityDeclaration {
  capabilityId: string;
  requestSchemaVersion: string;
  maxRequestBytes: number;
}

interface FeatureRuntimeContractDeclaration {
  storePorts: readonly string[];
  aiReviewCapabilities: readonly FeatureAiReviewCapabilityDeclaration[];
  pythonSidecar: PythonSidecarDeclaration | null;
}

interface PythonSidecarDeclaration {
  schemaVersion: 'omnia.python-sidecar-runtime/v1';
  implementation: 'cpython';
  version: '3.13.14';
  architecture: 'win32-x64';
  protocol: 'omnia.python-sidecar-rpc/v1';
  bridgePath: string;
  entryPath: string;
  members: string[];
  maxFrameBytes: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

const FEATURE_PYTHON_SIDECAR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function featurePythonSidecarPaths(featureId: string): { bridgePath: string; entryPath: string } {
  const slug = featureId.split('.').at(-1) || '';
  if (!FEATURE_PYTHON_SIDECAR_SLUG.test(slug) || slug.length > 64) {
    throw new Error('Feature Python sidecar requires a bounded lowercase hyphenated Feature slug.');
  }
  return {
    bridgePath: `middle/${slug}-python-bridge.cjs`,
    entryPath: `python/${slug}-engine.py`
  };
}

function assertDeclaredStorePort(
  runtimeContract: FeatureRuntimeContractDeclaration | null,
  method: string
): void {
  if (!runtimeContract?.storePorts.includes(method)) {
    throw new AppError(
      'FEATURE.STORE_PORT_UNDECLARED',
      `Feature runtime contract does not authorize Store method: ${method}`
    );
  }
}

export interface FeatureInstallResult {
  attemptId: string;
  featureId: string;
  featureVersion: string;
  packageDigest: string;
  documentationPath: string;
  activationGeneration: number;
  runtimeEnabled: boolean;
  runtimeReason: string;
  idempotent: boolean;
}

export interface FeatureRuntimeContext {
  connection: ConnectionSnapshot;
  safetyLock: WorkspaceSafetySnapshot;
  /** Test/canary harness evidence. The production Shell intentionally supplies no entries. */
  verifiedCanaryCapabilities?: Array<{
    featureId: string;
    scenarioId: string;
    capabilityId: string;
  }>;
}

export interface FeatureRuntimeDependencies {
  connector: ConnectorTransport;
  workerHostEntrypoint: string;
  featureReview?: (input: unknown, context: FeatureWorkerPortContext) => Promise<unknown>;
  /** Disposable read-only projection; it must never replace the authoritative runtime Surface. */
  publishSurfaceProjection?: (surface: DeclarativeFeatureSurface) => void;
}

type ReturnProgressRow = {
  target_key: string;
  target_kind: string;
  state: string;
  object_type: string | null;
  command_state: string;
};

type LiveReturnProgressSnapshot = {
  stateVersion: number;
  signature: string;
  progress: DeclarativeProgress;
};

const TERMINAL_RETURN_COMMAND_STATES = new Set([
  'readback_verified',
  'closed_not_applied',
  'failed',
  'uncertain'
]);

function shouldPublishLiveReturnProgress(method: string, input: unknown): boolean {
  if (method === 'finishReturn') return true;
  if (method !== 'recordReturnEvidence' || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  return TERMINAL_RETURN_COMMAND_STATES.has(String((input as Record<string, unknown>).commandState || ''));
}

function returnProgressRowState(row: ReturnProgressRow): 'passed' | 'uncertain' | 'failed' | 'running' | 'pending' {
  if (row.state === 'verified' || ['readback_verified', 'closed_not_applied'].includes(row.command_state)) return 'passed';
  if (row.state === 'uncertain' || row.command_state === 'uncertain') return 'uncertain';
  if (row.state === 'failed' || row.command_state === 'failed') return 'failed';
  if (['prepared', 'submitted', 'committed', 'verifying'].includes(row.command_state)) return 'running';
  return 'pending';
}

/**
 * Builds a disposable progress projection from durable Core ledger rows.
 *
 * Intent rows are allowed to materialize incrementally: the immutable totals
 * come from the authorized Feature Surface, while Core contributes only states
 * it has actually committed. Within one Surface revision, completed counters
 * are monotonic so a stale read/projection can never flash a capsule back to 0.
 */
export function buildLiveReturnProgress(
  declared: DeclarativeProgress,
  rows: ReturnProgressRow[],
  previous?: DeclarativeProgress
): DeclarativeProgress | null {
  if (!Array.isArray(rows) || rows.length > declared.total
    || declared.items.length < 1 || declared.items.length > 5
    || declared.items.reduce((total, item) => total + Number(item.total || 0), 0) !== declared.total) return null;
  type ReturnProgressGroup = 'elements' | 'gra' | 'relations' | 'risk-control' | 'settings';
  const groups = new Map<ReturnProgressGroup, ReturnProgressRow[]>([
    ['elements', rows.filter((row) => row.target_kind === 'object' && row.object_type !== 'GRA')],
    ['gra', rows.filter((row) => row.target_kind === 'object' && row.object_type === 'GRA')],
    ['relations', rows.filter((row) => row.target_kind === 'relation')],
    ['risk-control', rows.filter((row) => row.target_kind === 'risk_control')],
    ['settings', rows.filter((row) => !['object', 'relation', 'risk_control'].includes(row.target_kind))]
  ]);
  const groupForItem = (item: DeclarativeProgress['items'][number]): ReturnProgressGroup | null => {
    const label = item.label.normalize('NFKC').trim().toLocaleLowerCase('en-US').replaceAll(/\s+/gu, '');
    if (label === 'gra') return 'gra';
    if (label === 'risk-control' || label === 'riskcontrol') return 'risk-control';
    if (label === '关系' || label === 'relation' || label === 'relations') return 'relations';
    if (label === '元素' || label === 'element' || label === 'elements') return 'elements';
    if (label === '设置' || label === 'setting' || label === 'settings') return 'settings';
    return null;
  };
  const declaredGroups = new Set<ReturnProgressGroup>();
  const mappedGroups: ReturnProgressRow[][] = [];
  for (const item of declared.items) {
    const group = groupForItem(item);
    if (!group || declaredGroups.has(group)) return null;
    declaredGroups.add(group);
    mappedGroups.push(groups.get(group)!);
  }
  if ([...groups].some(([group, groupRows]) => groupRows.length > 0 && !declaredGroups.has(group))) return null;
  const previousItems = new Map((previous?.items || []).map((item) => [item.itemId, item]));
  const items: DeclarativeProgress['items'] = [];
  for (let index = 0; index < declared.items.length; index += 1) {
    const item = declared.items[index]!;
    const group = mappedGroups[index]!;
    if (item.itemId !== `return-group-${index}` || !Number.isSafeInteger(item.total)
      || (item.total as number) < group.length) return null;
    const total = item.total as number;
    const prior = previousItems.get(item.itemId);
    const rowStates = group.map(returnProgressRowState);
    const ledgerCompleted = rowStates.filter((state) => state === 'passed').length;
    const completed = Math.min(total, Math.max(item.completed || 0, prior?.completed || 0, ledgerCompleted));
    const failed = rowStates.includes('failed') || prior?.state === 'failed';
    const uncertain = rowStates.includes('uncertain') || prior?.state === 'uncertain';
    const running = rowStates.includes('running') || completed > 0;
    const state = failed ? 'failed'
      : uncertain ? 'uncertain'
        : completed === total ? 'passed'
          : running ? 'running' : 'pending';
    items.push({
      ...item,
      state,
      completed,
      total,
      percent: total === 0 ? 0 : Math.floor(completed * 100 / total)
    });
  }
  const rowStates = rows.map(returnProgressRowState);
  const ledgerCompleted = rowStates.filter((state) => state === 'passed').length;
  const completed = Math.min(declared.total, Math.max(declared.completed, previous?.completed || 0, ledgerCompleted));
  const state = rowStates.includes('failed') || previous?.state === 'failed' ? 'failed'
    : rowStates.includes('uncertain') || previous?.state === 'uncertain' ? 'uncertain'
      : completed === declared.total ? 'passed'
        : 'running';
  return {
    ...declared,
    completed,
    percent: declared.total === 0 ? 0 : Math.floor(completed * 100 / declared.total),
    state,
    items
  };
}

function utcNow(): string {
  return new Date().toISOString();
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unknown or missing fields.`);
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseSemver(value: string): [number, number, number] {
  if (!SEMVER.test(value)) throw new Error(`Invalid semantic version: ${value}`);
  return value.split('.').map(Number) as [number, number, number];
}

function semverAtLeast(actual: string, minimum: string): boolean {
  const left = parseSemver(actual);
  const right = parseSemver(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return true;
}

function validateNavigationId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function parseManifest(envelope: OfficialPackageEnvelope): FeatureManifest {
  const value = parseJson(packageFile(envelope, 'manifest.json'), 'Feature manifest');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Feature manifest is invalid.');
  exactKeys(value, [
    'schemaVersion',
    'featureId',
    'version',
    'sequence',
    'displayName',
    'minimumShellVersion',
    'requiredIsolation',
    'storeNamespace',
    'migrationPath',
    'surfacePath',
    'workerPath',
    'operationPackagePath',
    ...(Object.hasOwn(value,'contractsPath')?['contractsPath']:[]),
    ...(Object.hasOwn(value,'implementationMapPath')?['implementationMapPath']:[]),
    ...(Object.hasOwn(value,'testsManifestPath')?['testsManifestPath']:[]),
    'navigation',
    ...(Object.hasOwn(value, 'assets') ? ['assets'] : []),
    ...(Object.hasOwn(value, 'recoveryCompatibility') ? ['recoveryCompatibility'] : [])
  ], 'Feature manifest');
  const manifest = value as FeatureManifest;
  if (
    manifest.schemaVersion !== 'omnia.feature-manifest/v1'
    || manifest.featureId !== envelope.packageId
    || manifest.version !== envelope.version
    || manifest.sequence !== envelope.sequence
    || !FEATURE_ID.test(manifest.featureId)
    || typeof manifest.displayName !== 'string'
    || manifest.displayName.length < 1
    || manifest.displayName.length > 80
    || !SEMVER.test(manifest.minimumShellVersion)
    || !semverAtLeast(PRODUCT_VERSION, manifest.minimumShellVersion)
    || !['strong', 'process'].includes(manifest.requiredIsolation)
    || !/^[a-z][a-z0-9_]{2,63}$/u.test(manifest.storeNamespace)
    || manifest.migrationPath !== 'backend/migrations/001.json'
    || manifest.surfacePath !== 'frontend/surface.json'
    || manifest.workerPath !== 'middle/worker.cjs'
    || manifest.operationPackagePath !== 'connector-capability/operation.ofop'
    || !manifest.navigation
    || typeof manifest.navigation !== 'object'
    || Array.isArray(manifest.navigation)
  ) throw new Error('Feature manifest identity, compatibility, or isolation contract is invalid.');
  if (manifest.recoveryCompatibility) {
    exactKeys(manifest.recoveryCompatibility,
      ['schemaVersion','mode','sourceFeatureVersions','actionId'], 'Feature recovery compatibility');
    const recovery = manifest.recoveryCompatibility;
    if (recovery.schemaVersion !== 'omnia.feature-recovery-compatibility/v1'
      || !['partial_close_no_reuse','frozen_input_finalize'].includes(recovery.mode)
      || !Array.isArray(recovery.sourceFeatureVersions)
      || recovery.sourceFeatureVersions.length < 1 || recovery.sourceFeatureVersions.length > 8
      || recovery.sourceFeatureVersions.some((version)=>!SEMVER.test(version) || version === manifest.version)
      || new Set(recovery.sourceFeatureVersions).size !== recovery.sourceFeatureVersions.length) {
      throw new Error('Feature recovery compatibility declaration is invalid.');
    }
    if (recovery.mode === 'partial_close_no_reuse' && recovery.actionId !== 'recover-interrupted-run') {
      throw new Error('Partial-Return recovery must use its exact close-only action.');
    }
    if (recovery.mode === 'frozen_input_finalize' && recovery.actionId !== 'retry-finalization') {
      throw new Error('Frozen-input recovery must use its exact finalization action.');
    }
    if (recovery.mode === 'frozen_input_finalize'
      && recovery.sourceFeatureVersions.some((sourceVersion) => !semverAtLeast(manifest.version, sourceVersion))) {
      throw new Error('Frozen-input recovery may finalize only explicitly declared earlier Feature generations.');
    }
  }
  const declaresBundleContracts = manifest.contractsPath !== undefined
    || manifest.implementationMapPath !== undefined
    || manifest.testsManifestPath !== undefined;
  if (declaresBundleContracts && (
    manifest.contractsPath !== 'contracts/feature-runtime.json'
    || manifest.implementationMapPath !== 'contracts/implementation-map.json'
    || manifest.testsManifestPath !== 'tests/manifest.json'
  )) throw new Error('A Feature bundle contract extension must declare the runtime contract, implementation map, and tests manifest together.');
  exactKeys(manifest.navigation, ['groups', 'leaves'], 'Feature navigation');
  if (!Array.isArray(manifest.navigation.groups) || !Array.isArray(manifest.navigation.leaves)) {
    throw new Error('Feature navigation arrays are invalid.');
  }
  if (
    manifest.navigation.groups.length > 12
    || manifest.navigation.leaves.length > 24
  ) throw new Error('Feature navigation exceeds the product limits.');
  const groupIds = new Set<string>();
  for (const group of manifest.navigation.groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('Feature navigation group is invalid.');
    exactKeys(group, ['id', 'parentId', 'level', 'label', 'order'], 'Feature navigation group');
    validateNavigationId(group.id, 'Feature navigation group id');
    if (groupIds.has(group.id)) throw new Error('Feature navigation group id is duplicated.');
    groupIds.add(group.id);
    if (
      (group.parentId !== null && typeof group.parentId !== 'string')
      || (group.level !== 1 && group.level !== 2)
      || typeof group.label !== 'string'
      || group.label.length < 1
      || group.label.length > 80
      || !Number.isSafeInteger(group.order)
    ) throw new Error('Feature navigation group fields are invalid.');
  }
  for (const group of manifest.navigation.groups) {
    if (
      (group.level === 1 && group.parentId !== null)
      || (group.level === 2 && (
        !group.parentId
        || !groupIds.has(group.parentId)
        || manifest.navigation.groups.find((parent) => parent.id === group.parentId)?.level !== 1
      ))
    ) throw new Error('Feature navigation group hierarchy is invalid.');
  }
  const allNavigationIds = new Set(groupIds);
  const routes = new Set<string>();
  for (const leaf of manifest.navigation.leaves) {
    if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) throw new Error('Feature navigation leaf is invalid.');
    exactKeys(leaf, ['id', 'parentId', 'level', 'label', 'order', 'featureId', 'featureVersion', 'route'], 'Feature navigation leaf');
    validateNavigationId(leaf.id, 'Feature navigation leaf id');
    const parent = manifest.navigation.groups.find((group) => group.id === leaf.parentId);
    const flat = leaf.parentId === '' && leaf.level === 2;
    if (
      allNavigationIds.has(leaf.id)
      || (!flat && !parent)
      || (!flat && leaf.level === 2 && parent!.level !== 1)
      || (leaf.level === 3 && parent!.level !== 2)
      || (leaf.level !== 2 && leaf.level !== 3)
      || typeof leaf.label !== 'string'
      || leaf.label.length < 1
      || leaf.label.length > 80
      || !Number.isSafeInteger(leaf.order)
      || leaf.featureId !== manifest.featureId
      || leaf.featureVersion !== manifest.version
      || typeof leaf.route !== 'string'
      || !/^feature:[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(leaf.route)
      || routes.has(leaf.route)
    ) throw new Error('Feature navigation leaf fields are invalid.');
    allNavigationIds.add(leaf.id);
    routes.add(leaf.route);
  }
  if (manifest.navigation.leaves.length === 0) throw new Error('Feature must declare at least one navigation leaf.');
  if (manifest.assets !== undefined) {
    if (!Array.isArray(manifest.assets) || manifest.assets.length > 16) throw new Error('Feature managed assets are invalid.');
    const paths = new Set<string>();
    for (const asset of manifest.assets) {
      exactKeys(asset, ['path', 'sha256', 'kind'], 'Feature managed asset');
      if (!/^backend\/[\p{L}\p{N}][\p{L}\p{N} ._-]{2,127}\.(json|xlsx)$/u.test(asset.path)
        || paths.has(asset.path) || !/^[0-9a-f]{64}$/u.test(asset.sha256)
        || !['governance', 'runtime_template_base', 'source_template'].includes(asset.kind)
        || crypto.createHash('sha256').update(packageFile(envelope, asset.path)).digest('hex') !== asset.sha256) {
        throw new Error('Feature managed asset identity or digest is invalid.');
      }
      paths.add(asset.path);
    }
  }
  return manifest;
}

function parseSurface(envelope: OfficialPackageEnvelope, manifest: FeatureManifest): DeclarativeFeatureSurface {
  const value = parseJson(packageFile(envelope, manifest.surfacePath), 'Declarative Feature surface');
  return validateSurface(value, manifest);
}

function validateSurface(value: unknown, manifest: FeatureManifest): DeclarativeFeatureSurface {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Declarative Feature surface is invalid.');
  exactKeys(value, [
    'schemaVersion',
    'featureId',
    'featureVersion',
    'surfaceId',
    'stateVersion',
    'title',
    'description',
    'density',
    'status',
    'statusMessage',
    'scopes',
    'items',
    'selectedItemIds',
    'search',
    'actions',
    ...(Object.hasOwn(value, 'lifecycle') ? ['lifecycle'] : []),
    ...(Object.hasOwn(value, 'recorder') ? ['recorder'] : []),
    ...(Object.hasOwn(value, 'artifacts') ? ['artifacts'] : []),
    ...(Object.hasOwn(value, 'editors') ? ['editors'] : []),
    ...(Object.hasOwn(value, 'workflow') ? ['workflow'] : []),
    ...(Object.hasOwn(value, 'progress') ? ['progress'] : []),
    ...(Object.hasOwn(value, 'issues') ? ['issues'] : []),
    ...(Object.hasOwn(value, 'review') ? ['review'] : []),
    ...(Object.hasOwn(value, 'selectionBrowser') ? ['selectionBrowser'] : [])
  ], 'Declarative Feature surface');
  const surface = value as DeclarativeFeatureSurface;
  if (
    surface.schemaVersion !== 'omnia.declarative-feature-surface/v1'
    || surface.featureId !== manifest.featureId
    || surface.featureVersion !== manifest.version
    || typeof surface.surfaceId !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(surface.surfaceId)
    || !Number.isSafeInteger(surface.stateVersion)
    || surface.stateVersion < 1
    || typeof surface.title !== 'string'
    || typeof surface.description !== 'string'
    || surface.density !== 'compact'
    || !['idle', 'loading', 'ready', 'empty', 'blocked', 'error', 'stale'].includes(surface.status)
    || typeof surface.statusMessage !== 'string'
    || !Array.isArray(surface.scopes)
    || !Array.isArray(surface.items)
    || !Array.isArray(surface.selectedItemIds)
    || typeof surface.search !== 'string'
    || !Array.isArray(surface.actions)
    || (surface.recorder !== undefined && (!surface.recorder || typeof surface.recorder !== 'object' || Array.isArray(surface.recorder)))
    || (surface.artifacts !== undefined && !Array.isArray(surface.artifacts))
    || (surface.editors !== undefined && !Array.isArray(surface.editors))
    || (surface.issues !== undefined && !Array.isArray(surface.issues))
    || (surface.review !== undefined && (!surface.review || typeof surface.review !== 'object' || Array.isArray(surface.review)))
    || (surface.selectionBrowser !== undefined && (!surface.selectionBrowser || typeof surface.selectionBrowser !== 'object' || Array.isArray(surface.selectionBrowser)))
  ) throw new Error('Declarative Feature surface contract is invalid.');
  if (surface.selectionBrowser !== undefined) {
    const browser = surface.selectionBrowser;
    exactKeys(browser, [
      'schemaVersion', 'hierarchyLabel', 'resultsLabel', 'searchPlaceholder', 'emptyMessage',
      'allScopesLabel', 'selectVisibleLabel', 'clearSelectionLabel', 'footerActionIds', 'primaryActionId',
      ...(Object.hasOwn(browser, 'layout') ? ['layout'] : [])
    ], 'Declarative selection browser');
    if (browser.layout !== undefined) {
      const layout = browser.layout;
      if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
        throw new Error('Declarative selection browser layout is invalid.');
      }
      exactKeys(layout, ['schemaVersion', 'mode'], 'Declarative selection browser layout');
      if (layout.schemaVersion !== 'omnia.selection-browser-layout/v1'
        || !['standard', 'fixed_footer_split'].includes(layout.mode)) {
        throw new Error('Declarative selection browser layout fields are invalid.');
      }
    }
    if (browser.schemaVersion !== 'omnia.declarative-selection-browser/v1'
      || typeof browser.hierarchyLabel !== 'string' || browser.hierarchyLabel.length < 1 || browser.hierarchyLabel.length > 80
      || typeof browser.resultsLabel !== 'string' || browser.resultsLabel.length < 1 || browser.resultsLabel.length > 80
      || typeof browser.searchPlaceholder !== 'string' || browser.searchPlaceholder.length < 1 || browser.searchPlaceholder.length > 120
      || typeof browser.emptyMessage !== 'string' || browser.emptyMessage.length < 1 || browser.emptyMessage.length > 500
      || typeof browser.allScopesLabel !== 'string' || browser.allScopesLabel.length < 1 || browser.allScopesLabel.length > 80
      || typeof browser.selectVisibleLabel !== 'string' || browser.selectVisibleLabel.length < 1 || browser.selectVisibleLabel.length > 80
      || typeof browser.clearSelectionLabel !== 'string' || browser.clearSelectionLabel.length < 1 || browser.clearSelectionLabel.length > 80
      || !Array.isArray(browser.footerActionIds) || browser.footerActionIds.length < 1 || browser.footerActionIds.length > 20
      || new Set(browser.footerActionIds).size !== browser.footerActionIds.length
      || browser.footerActionIds.some((actionId) => typeof actionId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(actionId))
      || typeof browser.primaryActionId !== 'string' || !browser.footerActionIds.includes(browser.primaryActionId)) {
      throw new Error('Declarative selection browser fields are invalid.');
    }
  }
  for (const action of surface.actions) {
    if (
      !action
      || typeof action !== 'object'
      || Array.isArray(action)
      || typeof action.actionId !== 'string'
      || typeof action.label !== 'string'
      || !['read_only', 'local_state_write', 'omnia_mutation'].includes(action.effect)
      || (action.visible !== undefined && typeof action.visible !== 'boolean')
      || typeof action.enabled !== 'boolean'
      || typeof action.reason !== 'string'
      || (action.presentation !== undefined && !['default', 'record', 'pause', 'stop', 'export', 'refresh', 'recover', 'restart', 'upload', 'return', 'file_input', 'background'].includes(action.presentation))
      || (action.selectionMode !== undefined && !['none', 'single', 'multiple'].includes(action.selectionMode))
    ) throw new Error('Declarative Feature action is invalid.');
    if (action.presentation === 'background' && action.effect === 'omnia_mutation') {
      throw new Error('Declarative Feature background actions cannot perform Omnia mutations.');
    }
    if (action.presentation === 'recover' && (
      surface.recorder === undefined
      || action.effect !== 'local_state_write'
      || (action.selectionMode || 'none') !== 'none'
      || !action.dependencies?.includes('remote_connector')
    )) throw new Error('Recorder recovery actions require a real recorder, local-state effect, explicit recorder identity, and Remote Connector dependency.');
    const actionKeys = ['actionId', 'label', 'effect', 'enabled', 'reason'];
    if (Object.hasOwn(action, 'visible')) actionKeys.push('visible');
    if (Object.hasOwn(action, 'presentation')) actionKeys.push('presentation');
    if (Object.hasOwn(action, 'pendingPresentation')) actionKeys.push('pendingPresentation');
    if (Object.hasOwn(action, 'selectionMode')) actionKeys.push('selectionMode');
    if (Object.hasOwn(action, 'dependencies')) actionKeys.push('dependencies');
    if (Object.hasOwn(action, 'canaryCapability')) actionKeys.push('canaryCapability');
    if (Object.hasOwn(action, 'input')) actionKeys.push('input');
    if (Object.hasOwn(action, 'output')) actionKeys.push('output');
    exactKeys(action, actionKeys, 'Declarative Feature action');
    if (action.pendingPresentation !== undefined) {
      const pending = action.pendingPresentation;
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
        throw new Error('Declarative Feature action pending presentation is invalid.');
      }
      exactKeys(
        pending,
        ['schemaVersion', 'title', 'message', 'workflowStepId'],
        'Declarative Feature action pending presentation'
      );
      if (
        pending.schemaVersion !== 'omnia.declarative-action-pending-presentation/v1'
        || typeof pending.title !== 'string'
        || pending.title.length < 1
        || pending.title.length > 120
        || typeof pending.message !== 'string'
        || pending.message.length < 1
        || pending.message.length > 500
        || typeof pending.workflowStepId !== 'string'
        || !/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(pending.workflowStepId)
        || action.visible === false
        || action.presentation === 'background'
      ) throw new Error('Declarative Feature action pending presentation fields are invalid.');
    }
    if (action.presentation === 'return' && action.pendingPresentation === undefined) {
      throw new Error('Declarative Feature Return actions require a pending presentation.');
    }
    if (action.dependencies !== undefined && (
      !Array.isArray(action.dependencies)
      || new Set(action.dependencies).size !== action.dependencies.length
      || action.dependencies.some((dependency) => !['remote_connector', 'safety_lock', 'verified_canary'].includes(dependency))
    )) throw new Error('Declarative Feature action dependencies are invalid.');
    if (action.canaryCapability !== undefined) {
      if (!action.canaryCapability || typeof action.canaryCapability !== 'object' || Array.isArray(action.canaryCapability)) {
        throw new Error('Declarative Feature action canary capability is invalid.');
      }
      exactKeys(action.canaryCapability, ['scenarioId', 'capabilityId'], 'Declarative Feature canary capability');
      if (
        !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(action.canaryCapability.scenarioId)
        || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(action.canaryCapability.capabilityId)
      ) throw new Error('Declarative Feature canary capability identity is invalid.');
    }
    if (action.dependencies?.includes('verified_canary') && !action.canaryCapability) {
      throw new Error('A verified-canary action must declare its scenario and capability.');
    }
    if (action.input !== undefined) {
      if (!action.input || typeof action.input !== 'object' || Array.isArray(action.input)) {
        throw new Error('Declarative Feature action input is invalid.');
      }
      if (action.input.kind === 'open_file') {
        exactKeys(action.input, ['kind', 'accept', 'label'], 'Declarative Feature action input');
        if (
          !Array.isArray(action.input.accept)
          || action.input.accept.length < 1
          || action.input.accept.length > 8
          || action.input.accept.some((item) => typeof item !== 'string' || !/^\.[a-z0-9]{1,12}$/u.test(item))
          || typeof action.input.label !== 'string'
          || action.input.label.length < 1
          || action.input.label.length > 80
        ) throw new Error('Declarative Feature action input fields are invalid.');
      } else if (action.input.kind === 'toggle') {
        const toggleKeys = ['kind', 'fieldKey', 'label', 'defaultValue'];
        if (Object.hasOwn(action.input, 'value')) toggleKeys.push('value');
        exactKeys(action.input, toggleKeys, 'Declarative Feature toggle input');
        if (
          typeof action.input.fieldKey !== 'string'
          || !/^[a-z][a-z0-9._-]{2,127}$/u.test(action.input.fieldKey)
          || typeof action.input.label !== 'string'
          || action.input.label.length < 1
          || action.input.label.length > 120
          || typeof action.input.defaultValue !== 'boolean'
          || (Object.hasOwn(action.input, 'value') && typeof action.input.value !== 'boolean')
        ) throw new Error('Declarative Feature toggle input fields are invalid.');
      } else {
        throw new Error('Declarative Feature action input fields are invalid.');
      }
    }
    if (action.output !== undefined) {
      if (!action.output || typeof action.output !== 'object' || Array.isArray(action.output)) throw new Error('Declarative Feature action output is invalid.');
      exactKeys(action.output, ['kind', 'memberPath', 'suggestedName'], 'Declarative Feature action output');
      if (action.output.kind !== 'save_managed_asset'
        || !/^backend\/[\p{L}\p{N}][\p{L}\p{N} ._/-]{1,239}$/u.test(action.output.memberPath)
        || action.output.memberPath.includes('..')
        || typeof action.output.suggestedName !== 'string' || action.output.suggestedName.length < 1 || action.output.suggestedName.length > 255) {
        throw new Error('Declarative Feature action output fields are invalid.');
      }
    }
  }
  if (surface.lifecycle !== undefined) {
    const lifecycle = surface.lifecycle;
    if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
      throw new Error('Declarative Feature Surface lifecycle is invalid.');
    }
    exactKeys(lifecycle, ['schemaVersion', 'onReopenActionId'], 'Declarative Feature Surface lifecycle');
    const action = surface.actions.find((candidate) => candidate.actionId === lifecycle.onReopenActionId);
    if (
      lifecycle.schemaVersion !== 'omnia.declarative-feature-surface-lifecycle/v1'
      || typeof lifecycle.onReopenActionId !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(lifecycle.onReopenActionId)
      || !action
      || action.visible !== false
      || action.presentation !== 'background'
      || action.effect === 'omnia_mutation'
      || (action.selectionMode || 'none') !== 'none'
      || action.input !== undefined
      || action.output !== undefined
    ) throw new Error('Declarative Feature Surface on-reopen action is invalid.');
  }
  if (surface.recorder !== undefined) {
    const recorder = surface.recorder;
    exactKeys(recorder, [
      'state', 'recordingId', 'startedAt', 'updatedAt', 'elapsedMs', 'eventCount', 'interactionCount',
      'networkRequestCount', 'riskCount', 'controlCount', 'captureState', 'captureMessage', 'exportAvailable'
    ], 'Declarative recorder');
    if (
      !['idle', 'recording', 'paused', 'stopped', 'exported', 'cancelled', 'error'].includes(recorder.state)
      || typeof recorder.recordingId !== 'string' || recorder.recordingId.length > 100
      || typeof recorder.startedAt !== 'string' || recorder.startedAt.length > 100
      || typeof recorder.updatedAt !== 'string' || recorder.updatedAt.length > 100
      || !Number.isSafeInteger(recorder.elapsedMs) || recorder.elapsedMs < 0
      || !Number.isSafeInteger(recorder.eventCount) || recorder.eventCount < 0
      || !Number.isSafeInteger(recorder.interactionCount) || recorder.interactionCount < 0
      || !Number.isSafeInteger(recorder.networkRequestCount) || recorder.networkRequestCount < 0
      || !Number.isSafeInteger(recorder.riskCount) || recorder.riskCount < 0
      || !Number.isSafeInteger(recorder.controlCount) || recorder.controlCount < 0
      || !['idle', 'pending', 'complete', 'incomplete'].includes(recorder.captureState)
      || typeof recorder.captureMessage !== 'string' || recorder.captureMessage.length > 500
      || typeof recorder.exportAvailable !== 'boolean'
    ) throw new Error('Declarative recorder fields are invalid.');
  }
  if (
    surface.title.length < 1
    || surface.title.length > 100
    || surface.description.length > 500
    || surface.statusMessage.length > 500
    || surface.search.length > 200
    || surface.scopes.length > 5000
    || surface.items.length > 2_000
    || surface.selectedItemIds.length > 2_000
    || surface.actions.length > 20
    || (surface.artifacts?.length || 0) > 100
    || (surface.editors?.length || 0) > 500
    || (surface.issues?.length || 0) > 2_000
  ) throw new Error('Declarative Feature surface exceeds product limits.');
  if (surface.workflow !== undefined) {
    if (!surface.workflow || typeof surface.workflow !== 'object' || Array.isArray(surface.workflow)) throw new Error('Declarative workflow is invalid.');
    exactKeys(surface.workflow, ['revision', 'currentStepId', 'steps'], 'Declarative workflow');
    if (!Number.isSafeInteger(surface.workflow.revision) || surface.workflow.revision < 1
      || typeof surface.workflow.currentStepId !== 'string' || !Array.isArray(surface.workflow.steps)
      || surface.workflow.steps.length < 1 || surface.workflow.steps.length > 20) throw new Error('Declarative workflow fields are invalid.');
    const stepIds = new Set<string>();
    for (const step of surface.workflow.steps) {
      exactKeys(step, ['stepId', 'label', 'state', 'detail'], 'Declarative workflow step');
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(step.stepId) || stepIds.has(step.stepId)
        || typeof step.label !== 'string' || step.label.length < 1 || step.label.length > 80
        || !['pending', 'current', 'completed', 'warning', 'failed'].includes(step.state)
        || typeof step.detail !== 'string' || step.detail.length > 500) throw new Error('Declarative workflow step fields are invalid.');
      stepIds.add(step.stepId);
    }
    if (!stepIds.has(surface.workflow.currentStepId)) throw new Error('Declarative workflow current step is invalid.');
    if (surface.actions.some((action) => action.pendingPresentation && !stepIds.has(action.pendingPresentation.workflowStepId))) {
      throw new Error('Declarative Feature action pending workflow step is invalid.');
    }
  } else if (surface.actions.some((action) => action.pendingPresentation !== undefined)) {
    throw new Error('Declarative Feature action pending presentation requires a workflow.');
  }
  if (surface.progress !== undefined) {
    const progress = surface.progress;
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) throw new Error('Declarative progress is invalid.');
    exactKeys(progress, ['label', 'completed', 'total', 'percent', 'state', 'message', 'items'], 'Declarative progress');
    if (typeof progress.label !== 'string' || progress.label.length < 1 || progress.label.length > 100
      || !Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.total) || progress.completed < 0 || progress.total < 0 || progress.completed > progress.total
      || !Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100
      || !['pending', 'running', 'passed', 'warning', 'failed', 'skipped', 'uncertain'].includes(progress.state)
      || typeof progress.message !== 'string' || progress.message.length > 500 || !Array.isArray(progress.items) || progress.items.length > 500) throw new Error('Declarative progress fields are invalid.');
    for (const item of progress.items) {
      const hasCounters = Object.hasOwn(item, 'completed') || Object.hasOwn(item, 'total') || Object.hasOwn(item, 'percent');
      exactKeys(item, hasCounters
        ? ['itemId', 'label', 'state', 'detail', 'completed', 'total', 'percent']
        : ['itemId', 'label', 'state', 'detail'], 'Declarative progress item');
      if (typeof item.itemId !== 'string' || typeof item.label !== 'string' || item.label.length < 1 || item.label.length > 120
        || !['pending', 'running', 'passed', 'warning', 'failed', 'skipped', 'uncertain'].includes(item.state)
        || typeof item.detail !== 'string' || item.detail.length > 500) throw new Error('Declarative progress item fields are invalid.');
      if (hasCounters) {
        const expectedPercent = item.total === 0 ? 0 : Math.floor((item.completed as number) * 100 / (item.total as number));
        if (!Number.isSafeInteger(item.completed) || !Number.isSafeInteger(item.total) || !Number.isSafeInteger(item.percent)
          || (item.completed as number) < 0 || (item.total as number) < 0 || (item.completed as number) > (item.total as number)
          || (item.percent as number) < 0 || (item.percent as number) > 100 || item.percent !== expectedPercent) {
          throw new Error('Declarative progress item counters are invalid.');
        }
      }
    }
  }
  for (const issue of surface.issues || []) {
    exactKeys(issue, ['issueId', 'scope', 'severity', 'elementId', 'fieldKey', 'message'], 'Declarative issue');
    if (typeof issue.issueId !== 'string' || !['global', 'element', 'field'].includes(issue.scope)
      || !['warning', 'error'].includes(issue.severity) || typeof issue.elementId !== 'string'
      || typeof issue.fieldKey !== 'string' || typeof issue.message !== 'string' || issue.message.length < 1 || issue.message.length > 500) throw new Error('Declarative issue fields are invalid.');
  }
  if (surface.review !== undefined) {
    const review = surface.review;
    exactKeys(review, ['selectedKind', 'selectedRowKey', 'elementTypes', 'elements', 'fields', 'issueOrder'], 'Declarative review');
    if (!['APP', 'DB', 'OS', 'TOOL', 'DCNO'].includes(review.selectedKind)
      || typeof review.selectedRowKey !== 'string'
      || !Array.isArray(review.elementTypes) || review.elementTypes.length > 5
      || !Array.isArray(review.elements) || review.elements.length > 2_000
      || !Array.isArray(review.fields) || review.fields.length > 20_000
      || !Array.isArray(review.issueOrder) || review.issueOrder.length > 2_000) throw new Error('Declarative review fields are invalid.');
    const kinds = new Set<string>();
    for (const type of review.elementTypes) {
      exactKeys(type, ['kind', 'label', 'count', 'issueCount', 'warningCount', 'disabled', 'reason'], 'Declarative review element type');
      if (!['APP', 'DB', 'OS', 'TOOL', 'DCNO'].includes(type.kind) || kinds.has(type.kind)
        || typeof type.label !== 'string' || type.label.length < 1 || type.label.length > 80
        || !Number.isSafeInteger(type.count) || type.count < 0
        || !Number.isSafeInteger(type.issueCount) || type.issueCount < 0
        || !Number.isSafeInteger(type.warningCount) || type.warningCount < 0
        || typeof type.disabled !== 'boolean' || typeof type.reason !== 'string' || type.reason.length > 500) throw new Error('Declarative review element type fields are invalid.');
      kinds.add(type.kind);
    }
    const rowKeys = new Set<string>();
    for (const element of review.elements) {
      exactKeys(element, ['rowKey', 'kind', 'elementId', 'label', 'sourceSheet', 'sourceRow', 'issueCount', 'warningCount', 'derivedDisplay', 'inheritanceDecision', 'blocking', 'excluded'], 'Declarative review element');
      if (typeof element.rowKey !== 'string' || element.rowKey.length < 1 || rowKeys.has(element.rowKey)
        || !['APP', 'DB', 'OS', 'TOOL', 'DCNO'].includes(element.kind)
        || typeof element.elementId !== 'string' || element.elementId.length > 200
        || typeof element.label !== 'string' || element.label.length < 1 || element.label.length > 500
        || typeof element.sourceSheet !== 'string' || element.sourceSheet.length > 200
        || !Number.isSafeInteger(element.sourceRow) || element.sourceRow < 0
        || !Number.isSafeInteger(element.issueCount) || element.issueCount < 0
        || !Number.isSafeInteger(element.warningCount) || element.warningCount < 0
        || typeof element.derivedDisplay !== 'string' || element.derivedDisplay.length > 500
        || typeof element.blocking !== 'boolean' || typeof element.excluded !== 'boolean') throw new Error('Declarative review element fields are invalid.');
      if (element.inheritanceDecision !== null) {
        const decision = element.inheritanceDecision;
        exactKeys(decision, ['schemaVersion', 'policy', 'sourceModes', 'mixedSources', 'result', 'message'], 'Declarative inheritance decision');
        if (decision.schemaVersion !== 'omnia.create-associate.infrastructure-rait-decision/v1'
          || decision.policy !== 'any_higher_else_all_lower'
          || !Array.isArray(decision.sourceModes) || decision.sourceModes.length < 1 || decision.sourceModes.length > 200
          || typeof decision.mixedSources !== 'boolean' || !['Higher', 'Lower'].includes(decision.result)
          || typeof decision.message !== 'string' || decision.message.length > 500) throw new Error('Declarative inheritance decision fields are invalid.');
        for (const source of decision.sourceModes) {
          exactKeys(source, ['rowKey', 'elementId', 'rait'], 'Declarative inheritance source');
          if (typeof source.rowKey !== 'string' || source.rowKey.length < 1 || source.rowKey.length > 500
            || typeof source.elementId !== 'string' || source.elementId.length < 1 || source.elementId.length > 200
            || !['Higher', 'Lower'].includes(source.rait)) throw new Error('Declarative inheritance source fields are invalid.');
        }
      }
      rowKeys.add(element.rowKey);
    }
    if (review.selectedRowKey && !rowKeys.has(review.selectedRowKey)) throw new Error('Declarative review selected row is invalid.');
    const fieldKeys = new Set<string>();
    for (const field of review.fields) {
      exactKeys(field, ['rowKey', 'kind', 'fieldKey', 'rawFieldKey', 'label', 'expectedRevision', 'inputKind', 'currentValue', 'allowedValues', 'required', 'maxLength', 'editable', 'message', 'sourceSheet', 'sourceRow', 'derivation'], 'Declarative review field');
      if (!rowKeys.has(field.rowKey) || !['APP', 'DB', 'OS', 'TOOL', 'DCNO'].includes(field.kind)
        || typeof field.fieldKey !== 'string' || field.fieldKey.length < 1 || field.fieldKey.length > 500 || fieldKeys.has(field.fieldKey)
        || typeof field.rawFieldKey !== 'string' || field.rawFieldKey.length > 200
        || typeof field.label !== 'string' || field.label.length < 1 || field.label.length > 200
        || !Number.isSafeInteger(field.expectedRevision) || field.expectedRevision < 0
        || !['text', 'enum', 'textarea', 'readonly'].includes(field.inputKind)
        || typeof field.currentValue !== 'string' || field.currentValue.length > 10_000
        || !Array.isArray(field.allowedValues) || field.allowedValues.length > 200
        || field.allowedValues.some((item) => typeof item !== 'string' || item.length > 200)
        || typeof field.required !== 'boolean' || !Number.isSafeInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 10_000
        || typeof field.editable !== 'boolean' || typeof field.message !== 'string' || field.message.length > 1_000
        || typeof field.sourceSheet !== 'string' || field.sourceSheet.length > 200
        || !Number.isSafeInteger(field.sourceRow) || field.sourceRow < 0
        || typeof field.derivation !== 'string' || field.derivation.length > 500) throw new Error('Declarative review field fields are invalid.');
      fieldKeys.add(field.fieldKey);
    }
    const reviewIssueIds = new Set<string>();
    for (const issue of review.issueOrder) {
      exactKeys(issue, ['issueId', 'rowKey', 'fieldKey', 'severity', 'message'], 'Declarative review issue');
      if (typeof issue.issueId !== 'string' || issue.issueId.length < 1 || reviewIssueIds.has(issue.issueId)
        || (issue.rowKey !== '' && !rowKeys.has(issue.rowKey)) || typeof issue.fieldKey !== 'string'
        || !['warning', 'error'].includes(issue.severity)
        || typeof issue.message !== 'string' || issue.message.length < 1 || issue.message.length > 500) throw new Error('Declarative review issue fields are invalid.');
      reviewIssueIds.add(issue.issueId);
    }
  }
  const scopeIds = new Set<string>();
  for (const scope of surface.scopes) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('Declarative Feature scope is invalid.');
    exactKeys(scope, surface.selectionBrowser === undefined
      ? ['id', 'parentId', 'label', 'parentLabel', 'selected']
      : ['id', 'parentId', 'kind', 'level', 'label', 'parentLabel', 'selected', 'initialExpanded', 'disabledReason'], 'Declarative Feature scope');
    if (
      typeof scope.id !== 'string'
      || scope.id.length < 1
      || scope.id.length > 200
      || scopeIds.has(scope.id)
      || (surface.selectionBrowser === undefined
        ? (typeof scope.parentId !== 'string' || scope.parentId.length < 1 || scope.parentId.length > 200)
        : (scope.parentId !== null && (typeof scope.parentId !== 'string' || scope.parentId.length < 1 || scope.parentId.length > 200)))
      || (surface.selectionBrowser !== undefined && (scope.kind === undefined || !['section', 'workspace', 'element_type'].includes(scope.kind)))
      || (surface.selectionBrowser !== undefined && (scope.level === undefined || ![1, 2, 3].includes(scope.level)))
      || typeof scope.label !== 'string'
      || scope.label.length < 1
      || scope.label.length > 120
      || typeof scope.parentLabel !== 'string'
      || scope.parentLabel.length < 1
      || scope.parentLabel.length > 120
      || typeof scope.selected !== 'boolean'
      || (surface.selectionBrowser !== undefined && typeof scope.initialExpanded !== 'boolean')
      || (surface.selectionBrowser !== undefined && (typeof scope.disabledReason !== 'string' || scope.disabledReason.length > 500))
    ) throw new Error('Declarative Feature scope fields are invalid.');
    scopeIds.add(scope.id);
  }
  for (const scope of surface.selectionBrowser === undefined ? [] : surface.scopes) {
    const level = scope.level;
    if (level === undefined) throw new Error('Declarative Feature scope hierarchy is invalid.');
    const parent = scope.parentId === null ? undefined : surface.scopes.find((candidate) => candidate.id === scope.parentId);
    if ((level === 1 && (scope.parentId !== null || scope.kind !== 'section'))
      || (level > 1 && (!parent || parent.level !== level - 1))
      || (level === 2 && scope.kind !== 'workspace')
      || (level === 3 && scope.kind !== 'element_type')) {
      throw new Error('Declarative Feature scope hierarchy is invalid.');
    }
  }
  const itemIds = new Set<string>();
  for (const item of surface.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Declarative Feature item is invalid.');
    exactKeys(item, [
      'id',
      'scopeId',
      'type',
      'title',
      'subtitle',
      'selectable',
      'disabledReason',
      'concurrencyToken'
    ], 'Declarative Feature item');
    if (
      typeof item.id !== 'string'
      || item.id.length < 1
      || item.id.length > 200
      || itemIds.has(item.id)
      || !scopeIds.has(item.scopeId)
      || typeof item.type !== 'string'
      || item.type.length < 1
      || item.type.length > 80
      || typeof item.title !== 'string'
      || item.title.length < 1
      || item.title.length > 200
      || typeof item.subtitle !== 'string'
      || item.subtitle.length > 500
      || typeof item.selectable !== 'boolean'
      || typeof item.disabledReason !== 'string'
      || item.disabledReason.length > 500
      || typeof item.concurrencyToken !== 'string'
      || item.concurrencyToken.length > 500
    ) throw new Error('Declarative Feature item fields are invalid.');
    itemIds.add(item.id);
  }
  if (
    new Set(surface.selectedItemIds).size !== surface.selectedItemIds.length
    || surface.selectedItemIds.some((id) => typeof id !== 'string' || !itemIds.has(id))
  ) throw new Error('Declarative Feature selection is not a subset of the current items.');
  const actionIds = new Set<string>();
  for (const action of surface.actions) {
    if (
      !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(action.actionId)
      || actionIds.has(action.actionId)
      || action.label.length < 1
      || action.label.length > 80
      || action.reason.length > 500
    ) throw new Error('Declarative Feature action identity is invalid.');
    actionIds.add(action.actionId);
  }
  if (surface.selectionBrowser !== undefined
    && (surface.selectionBrowser.footerActionIds.some((actionId) => !actionIds.has(actionId))
      || !actionIds.has(surface.selectionBrowser.primaryActionId))) {
    throw new Error('Declarative selection browser references an undeclared action.');
  }
  for (const artifact of surface.artifacts || []) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('Declarative Feature artifact is invalid.');
    exactKeys(artifact, ['artifactId', 'kind', 'name', 'sha256', 'sizeBytes', 'available', 'reason'], 'Declarative Feature artifact');
    if (
      typeof artifact.artifactId !== 'string'
      || !['source', 'template_candidate', 'template_instance', 'result', 'evidence'].includes(artifact.kind)
      || typeof artifact.name !== 'string'
      || artifact.name.length < 1
      || artifact.name.length > 255
      || !/^[0-9a-f]{64}$/u.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.sizeBytes)
      || artifact.sizeBytes < 0
      || typeof artifact.available !== 'boolean'
      || typeof artifact.reason !== 'string'
      || artifact.reason.length > 500
    ) throw new Error('Declarative Feature artifact fields are invalid.');
  }
  for (const editor of surface.editors || []) {
    if (!editor || typeof editor !== 'object' || Array.isArray(editor)) throw new Error('Declarative Feature editor is invalid.');
    exactKeys(editor, [
      'issueId', 'fieldKey', 'expectedRevision', 'inputKind', 'label', 'currentValue',
      'allowedValues', 'required', 'maxLength'
    ], 'Declarative Feature editor');
    if (
      typeof editor.issueId !== 'string' || typeof editor.fieldKey !== 'string'
      || !Number.isSafeInteger(editor.expectedRevision) || editor.expectedRevision < 1
      || !['text', 'enum'].includes(editor.inputKind) || typeof editor.label !== 'string'
      || typeof editor.currentValue !== 'string' || !Array.isArray(editor.allowedValues)
      || editor.allowedValues.some((value) => typeof value !== 'string' || value.length > 200)
      || (editor.inputKind === 'enum' && editor.allowedValues.length < 1)
      || typeof editor.required !== 'boolean' || !Number.isSafeInteger(editor.maxLength)
      || editor.maxLength < 1 || editor.maxLength > 10_000
    ) throw new Error('Declarative Feature editor fields are invalid.');
  }
  return surface;
}

const CLEARABLE_SURFACE_FIELDS = new Set(['recorder', 'workflow', 'progress', 'issues', 'review', 'artifacts', 'editors']);
const WORKER_SURFACE_PATCH_FIELDS = new Set([
  'stateVersion', 'status', 'statusMessage', 'scopes', 'items', 'selectedItemIds', 'search', 'actions',
  'recorder', 'workflow', 'progress', 'issues', 'review', 'artifacts', 'editors', 'clearFields',
  // Compatibility-only worker metadata from create-associate 0.2.59. It is
  // deliberately consumed below and never becomes part of the declarative
  // Surface. Execution policy remains durable Core/Feature state.
  'returnExecution'
]);

function applyWorkerSurfacePatch(
  base: DeclarativeFeatureSurface,
  input: unknown,
  manifest: FeatureManifest
): DeclarativeFeatureSurface {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Feature worker Surface patch is invalid.');
  const patch = input as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !WORKER_SURFACE_PATCH_FIELDS.has(key))) {
    throw new Error('Feature worker Surface patch contains a forbidden field.');
  }
  const clearFields = patch.clearFields;
  if (clearFields !== undefined && (
    !Array.isArray(clearFields)
    || clearFields.length > CLEARABLE_SURFACE_FIELDS.size
    || new Set(clearFields).size !== clearFields.length
    || clearFields.some((field) => typeof field !== 'string' || !CLEARABLE_SURFACE_FIELDS.has(field))
  )) throw new Error('Feature worker requested invalid Surface field clearing.');
  let actions = base.actions;
  if (patch.actions !== undefined) {
    if (!Array.isArray(patch.actions) || patch.actions.length > base.actions.length) throw new Error('Feature worker action patch is invalid.');
    const seen = new Set<string>();
    const actionPatches = patch.actions.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Feature worker action patch is invalid.');
      const actionPatch = candidate as Record<string, unknown>;
      if (Object.keys(actionPatch).some((key) => !['actionId', 'enabled', 'reason', 'label'].includes(key))
        || typeof actionPatch.actionId !== 'string' || seen.has(actionPatch.actionId)
        || !base.actions.some((declared) => declared.actionId === actionPatch.actionId)
        || typeof actionPatch.enabled !== 'boolean' || typeof actionPatch.reason !== 'string'
        || (actionPatch.label !== undefined && (typeof actionPatch.label !== 'string' || actionPatch.label.length < 1))) {
        throw new Error('Feature worker action patch is invalid.');
      }
      seen.add(actionPatch.actionId);
      return actionPatch;
    });
    actions = base.actions.map((declared) => {
      const actionPatch = actionPatches.find((candidate) => candidate.actionId === declared.actionId);
      return actionPatch ? {
        ...declared,
        enabled: actionPatch.enabled as boolean,
        reason: actionPatch.reason as string,
        ...(actionPatch.label !== undefined ? { label: actionPatch.label as string } : {})
      } : declared;
    });
  }
  const {
    clearFields: _clearFields,
    actions: _actions,
    stateVersion: requestedStateVersion,
    returnExecution: _returnExecution,
    ...surfacePatch
  } = patch;
  const next = {
    ...base,
    ...surfacePatch,
    schemaVersion: base.schemaVersion,
    featureId: base.featureId,
    featureVersion: base.featureVersion,
    surfaceId: base.surfaceId,
    stateVersion: Math.max(base.stateVersion + 1, Number(requestedStateVersion || 0)),
    actions
  } as DeclarativeFeatureSurface;
  const cleared = Array.isArray(clearFields) ? clearFields as string[] : [];
  for (const field of cleared) delete (next as unknown as Record<string, unknown>)[field];
  return validateSurface(next, manifest);
}

function validateDocumentation(envelope: OfficialPackageEnvelope, manifest: FeatureManifest): string {
  const value = parseJson(packageFile(envelope, 'docs/manifest.json'), 'Documentation manifest');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Documentation manifest is invalid.');
  exactKeys(value, ['schemaVersion', 'featureId', 'featureVersion', 'documents'], 'Documentation manifest');
  const docs = value as DocumentationManifest;
  if (
    docs.schemaVersion !== 'omnia.feature-documentation/v1'
    || docs.featureId !== manifest.featureId
    || docs.featureVersion !== manifest.version
    || !Array.isArray(docs.documents)
    || docs.documents.length < 2
  ) throw new Error('Documentation manifest identity is invalid.');
  const documentPaths = new Set<string>();
  for (const document of docs.documents) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Documentation entry is invalid.');
    exactKeys(document, ['path', 'sha256', 'purpose'], 'Documentation entry');
    if (
      !/^docs\/[A-Z][A-Z0-9_]{1,63}\.md$/u.test(document.path)
      || documentPaths.has(document.path)
      || !/^[0-9a-f]{64}$/u.test(document.sha256)
      || typeof document.purpose !== 'string'
      || crypto.createHash('sha256').update(packageFile(envelope, document.path)).digest('hex') !== document.sha256
    ) throw new Error('Documentation entry digest or path is invalid.');
    documentPaths.add(document.path);
  }
  return crypto.createHash('sha256').update(packageFile(envelope, 'docs/manifest.json')).digest('hex');
}

function validateFeatureBundleContracts(
  envelope: OfficialPackageEnvelope,
  manifest: FeatureManifest,
  allowInstalledLegacyPythonPaths = false
): FeatureRuntimeContractDeclaration {
  if(!manifest.contractsPath||!manifest.implementationMapPath||!manifest.testsManifestPath) throw new Error('Feature bundle contract extension is absent.');
  const runtime=parseJson(packageFile(envelope,manifest.contractsPath),'Feature runtime contract') as Record<string,unknown>;
  const mapping=parseJson(packageFile(envelope,manifest.implementationMapPath),'Feature implementation map') as Record<string,unknown>;
  const tests=parseJson(packageFile(envelope,manifest.testsManifestPath),'Feature tests manifest') as Record<string,unknown>;
  const vectors=parseJson(packageFile(envelope,'tests/vectors.json'),'Feature test vectors') as Record<string,unknown>;
  if(runtime?.schemaVersion!=='omnia.feature-runtime-contract/v1'||runtime.featureId!==manifest.featureId||runtime.featureVersion!==manifest.version
    ||!Array.isArray(runtime.inputs)||!Array.isArray(runtime.outputs)||!Array.isArray(runtime.events)||!Array.isArray(runtime.errors)||!Array.isArray(runtime.storePorts)) throw new Error('Feature runtime contract is invalid.');
  exactKeys(runtime, [
    'schemaVersion','featureId','featureVersion','inputs','outputs','events','errors','storePorts',
    ...(Object.hasOwn(runtime,'aiReviewCapabilities')?['aiReviewCapabilities']:[]),
    ...(Object.hasOwn(runtime,'pythonSidecar')?['pythonSidecar']:[])
  ], 'Feature runtime contract');
  const storePorts=(runtime.storePorts as unknown[]).map(String);
  const storePortShapeInvalid=storePorts.length<1||storePorts.length>96
    ||new Set(storePorts).size!==storePorts.length
    ||storePorts.some((method)=>!/^[A-Za-z][A-Za-z0-9]{1,95}$/u.test(method));
  if(storePortShapeInvalid
    ||(!allowInstalledLegacyPythonPaths&&storePorts.some((method)=>!isFeatureRuntimeStorePort(method)))) {
    throw new Error('Feature runtime contract Store port allowlist is invalid or contains a non-Core method.');
  }
  const rawAiCapabilities=Object.hasOwn(runtime,'aiReviewCapabilities')?runtime.aiReviewCapabilities:[];
  if(!Array.isArray(rawAiCapabilities)||rawAiCapabilities.length>16)throw new Error('Feature AI review capability allowlist is invalid.');
  const aiReviewCapabilities=rawAiCapabilities.map((raw)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Feature AI review capability declaration is invalid.');
    exactKeys(raw,['capabilityId','requestSchemaVersion','maxRequestBytes'],'Feature AI review capability');
    const capability=raw as Record<string,unknown>;
    const declaration:FeatureAiReviewCapabilityDeclaration={
      capabilityId:String(capability.capabilityId||''),
      requestSchemaVersion:String(capability.requestSchemaVersion||''),
      maxRequestBytes:Number(capability.maxRequestBytes)
    };
    if(!/^[a-z0-9][a-z0-9._/-]{2,127}$/u.test(declaration.capabilityId)
      ||!/^[a-z0-9][a-z0-9._/-]{2,127}$/u.test(declaration.requestSchemaVersion)
      ||!Number.isSafeInteger(declaration.maxRequestBytes)||declaration.maxRequestBytes<1
      ||declaration.maxRequestBytes>1024*1024)throw new Error('Feature AI review capability policy is invalid.');
    return declaration;
  });
  if(new Set(aiReviewCapabilities.map((item)=>item.capabilityId)).size!==aiReviewCapabilities.length) {
    throw new Error('Feature AI review capability is duplicated.');
  }
  if(mapping?.schemaVersion!=='omnia.feature-implementation-map/v1'||mapping.featureId!==manifest.featureId||mapping.featureVersion!==manifest.version
    ||!mapping.planes||typeof mapping.planes!=='object'||Array.isArray(mapping.planes)) throw new Error('Feature implementation map is invalid.');
  const planes=mapping.planes as Record<string,unknown>;
  for(const plane of ['surface','worker','store','connector']) if(!Array.isArray(planes[plane])||(planes[plane] as unknown[]).length<1) throw new Error('Feature implementation map omits a required Plane.');
  if(tests?.schemaVersion!=='omnia.feature-tests-manifest/v1'||tests.featureId!==manifest.featureId||tests.featureVersion!==manifest.version
    ||!Array.isArray(tests.testIds)||(tests.testIds as unknown[]).length<1||tests.vectorsPath!=='tests/vectors.json'||tests.selfTestPath!=='tests/self-test.cjs'||tests.status!=='declared') throw new Error('Feature tests manifest is invalid.');
  if(vectors?.schemaVersion!=='omnia.feature-test-vectors/v1'||vectors.featureId!==manifest.featureId||!Array.isArray(vectors.vectors)||(vectors.vectors as unknown[]).length<1) throw new Error('Feature test vectors are invalid.');
  const ids=new Set((tests.testIds as unknown[]).map(String));
  if((vectors.vectors as Array<Record<string,unknown>>).some((vector)=>!ids.has(String(vector.testId||''))||!Object.hasOwn(vector,'expected'))) throw new Error('Feature test vectors differ from the signed test inventory.');
  if (!Object.hasOwn(runtime, 'pythonSidecar')) return {storePorts,aiReviewCapabilities,pythonSidecar:null};
  const sidecar = runtime.pythonSidecar;
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) throw new Error('Feature Python sidecar declaration is invalid.');
  exactKeys(sidecar, [
    'schemaVersion', 'implementation', 'version', 'architecture', 'protocol',
    'bridgePath', 'entryPath', 'members', 'maxFrameBytes', 'heartbeatIntervalMs', 'heartbeatTimeoutMs'
  ], 'Feature Python sidecar declaration');
  const declaration = sidecar as PythonSidecarDeclaration;
  const expectedPaths = featurePythonSidecarPaths(manifest.featureId);
  const usesFeatureUniquePaths = declaration.bridgePath === expectedPaths.bridgePath
    && declaration.entryPath === expectedPaths.entryPath;
  const usesInstalledLegacyPaths = allowInstalledLegacyPythonPaths
    && declaration.bridgePath === 'middle/python-bridge.cjs'
    && declaration.entryPath === 'python/engine.py';
  if (
    declaration.schemaVersion !== 'omnia.python-sidecar-runtime/v1'
    || declaration.implementation !== 'cpython'
    || declaration.version !== '3.13.14'
    || declaration.architecture !== 'win32-x64'
    || declaration.protocol !== 'omnia.python-sidecar-rpc/v1'
    || (!usesFeatureUniquePaths && !usesInstalledLegacyPaths)
    || !Array.isArray(declaration.members)
    || declaration.members.length < 1
    || declaration.members.length > 32
    || new Set(declaration.members).size !== declaration.members.length
    || [...declaration.members].sort().some((member, index) => member !== declaration.members[index])
    || !declaration.members.includes(declaration.entryPath)
    || declaration.members.some((member) => member !== declaration.entryPath
      && !/^python\/[a-z][a-z0-9_]{1,63}\.py$/u.test(member))
    || declaration.maxFrameBytes !== 1024 * 1024
    || declaration.heartbeatIntervalMs !== 5_000
    || declaration.heartbeatTimeoutMs !== 15_000
  ) throw new Error('Feature Python sidecar runtime policy is invalid.');
  packageFile(envelope, declaration.bridgePath);
  for (const member of declaration.members) packageFile(envelope, member);
  return {storePorts,aiReviewCapabilities,pythonSidecar:declaration};
}

function validateOperationPackage(input: unknown, featureManifest: FeatureManifest): ValidatedOperationPackage {
  const envelope = verifyOfficialPackage(input, 'omnia-connector-operation');
  const digest = packageDigest(envelope);
  const legacyRequired = ['SIGNATURE.json', 'docs/OPERATION.md', 'manifest.json', 'operation/policy.json', 'sbom.json'];
  const executableRequired = [...legacyRequired, 'operation/handler.cjs'].sort();
  const actual = envelope.files.map((file) => file.path).sort();
  const executable = actual.length === executableRequired.length
    && actual.every((member, index) => member === executableRequired[index]);
  const legacy = actual.length === legacyRequired.length
    && actual.every((member, index) => member === [...legacyRequired].sort()[index]);
  if (!executable && !legacy) {
    throw new Error('Connector Operation package inventory is incomplete or contains undeclared files.');
  }
  const raw = parseJson(packageFile(envelope, 'manifest.json'), 'Connector Operation manifest');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Connector Operation manifest is invalid.');
  exactKeys(raw, [
    'schemaVersion', 'packageId', 'version', 'sequence', 'featureId',
    ...(Object.hasOwn(raw, 'resourceOwner') ? ['resourceOwner'] : []),
    'operations'
  ], 'Connector Operation manifest');
  const manifest = raw as OperationManifest;
  if (
    manifest.schemaVersion !== 'omnia.connector-operation-manifest/v1'
    || manifest.packageId !== envelope.packageId
    || manifest.version !== envelope.version
    || manifest.sequence !== envelope.sequence
    || manifest.featureId !== featureManifest.featureId
    || manifest.version !== featureManifest.version
    || manifest.sequence !== featureManifest.sequence
    || !Array.isArray(manifest.operations)
    || manifest.operations.length < 1
    || manifest.operations.length > MAX_SIGNED_OPERATION_COUNT
  ) throw new Error('Connector Operation manifest identity is invalid.');
  if (manifest.resourceOwner) {
    const owner = manifest.resourceOwner;
    exactKeys(owner, [
      'schemaVersion', 'ownerId', 'compatibilityVersion', 'capabilities', 'compatibleSourcePackageDigests'
    ], 'Connector Operation resource owner');
    if (
      owner.schemaVersion !== 'omnia.operation-resource-owner/v1'
      || typeof owner.ownerId !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(owner.ownerId)
      || !Number.isSafeInteger(owner.compatibilityVersion)
      || owner.compatibilityVersion < 1
      || owner.compatibilityVersion > 0x7fffffff
      || !Array.isArray(owner.capabilities)
      || owner.capabilities.length < 1
      || owner.capabilities.length > 16
      || owner.capabilities.some((capability) =>
        typeof capability !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(capability))
      || canonicalJson([...new Set(owner.capabilities)].sort()) !== canonicalJson(owner.capabilities)
      || !Array.isArray(owner.compatibleSourcePackageDigests)
      || owner.compatibleSourcePackageDigests.length > 16
      || owner.compatibleSourcePackageDigests.some((sourceDigest) =>
        typeof sourceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(sourceDigest))
      || canonicalJson([...new Set(owner.compatibleSourcePackageDigests)].sort())
        !== canonicalJson(owner.compatibleSourcePackageDigests)
      || owner.compatibleSourcePackageDigests.includes(digest)
    ) throw new Error('Connector Operation resource owner compatibility contract is invalid.');
  }
  const operationIds = new Set<string>();
  for (const operation of manifest.operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('Connector Operation entry is invalid.');
    exactKeys(operation, executable ? [
      'operationId',
      'effect',
      'requestSchema',
      'responseSchema',
      'enabledByDefault',
      'grantsMutationPermit',
      ...(Object.hasOwn(operation, 'permitsOperationId') ? ['permitsOperationId'] : []),
      'routes'
    ] : [
      'operationId',
      'effect',
      'requestSchema',
      'responseSchema',
      'enabledByDefault',
      'routes'
    ], 'Connector Operation entry');
    if (
      typeof operation.operationId !== 'string'
      || !/^[a-z0-9][a-z0-9.-]{5,159}\.v\d+$/u.test(operation.operationId)
      || operationIds.has(operation.operationId)
      || (operation.effect !== 'read_only' && operation.effect !== 'omnia_mutation')
      || typeof operation.requestSchema !== 'string'
      || !/^omnia\.[a-z0-9.-]+\/v\d+$/u.test(operation.requestSchema)
      || typeof operation.responseSchema !== 'string'
      || !/^omnia\.[a-z0-9.-]+\/v\d+$/u.test(operation.responseSchema)
      || typeof operation.enabledByDefault !== 'boolean'
      || (executable && typeof operation.grantsMutationPermit !== 'boolean')
      || (operation.permitsOperationId !== undefined && typeof operation.permitsOperationId !== 'string')
      || !Array.isArray(operation.routes)
      || operation.routes.length < 1
      || operation.routes.length > 16
    ) throw new Error('Connector Operation entry is not a strict allowlisted route contract.');
    operationIds.add(operation.operationId);
    if (operation.effect === 'omnia_mutation' && operation.enabledByDefault) {
      throw new Error('Mutation Connector Operations must be disabled by default.');
    }
    const stepIds = new Set<string>();
    for (const route of operation.routes) {
      if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('Connector Operation route is invalid.');
      exactKeys(route, executable
        ? ['stepId', 'method', 'routeTemplate', 'parameters', 'bodyMode', 'bodyParameter']
        : ['stepId', 'method', 'routeTemplate', 'bodyMode'], 'Connector Operation route');
      if (
        typeof route.stepId !== 'string'
        || !/^[a-z][a-z0-9._-]{1,63}$/u.test(route.stepId)
        || stepIds.has(route.stepId)
        || !['GET', 'POST', 'PATCH'].includes(route.method)
        || typeof route.routeTemplate !== 'string'
        || route.routeTemplate.length < 1
        || route.routeTemplate.length > 300
        || !/^\/[a-zA-Z0-9._?=&{}/-]+$/u.test(route.routeTemplate)
        || /\*\*|https?:|\/\/|\\|\.\./iu.test(route.routeTemplate)
        || !['none', 'single_id_array', 'information_search', 'parameter_array', 'signed_json'].includes(route.bodyMode)
        || (!['none', 'signed_json'].includes(route.bodyMode) && route.method !== 'POST')
        || (route.method === 'GET' && route.bodyMode !== 'none')
      ) throw new Error('Connector Operation route is not a strict product allowlist entry.');
      if (executable) {
        if (
          !Array.isArray(route.parameters)
          || route.parameters.some((parameter) =>
            !parameter
            || typeof parameter !== 'object'
            || Array.isArray(parameter)
            || (exactKeys(parameter, ['name', 'type'], 'Connector Operation route parameter'), false)
            || typeof parameter.name !== 'string'
            || !/^[A-Za-z][A-Za-z0-9]*$/u.test(parameter.name)
            || !['guid', 'string'].includes(parameter.type)
          )
          || typeof route.bodyParameter !== 'string'
          || (route.bodyMode === 'parameter_array'
            && !route.parameters.some((parameter) => parameter.name === route.bodyParameter))
        ) throw new Error('Connector Operation route parameter contract is invalid.');
      }
      stepIds.add(route.stepId);
    }
  }
  for (const operation of manifest.operations) {
    if (
      operation.permitsOperationId !== undefined
      && manifest.operations.find((candidate) => candidate.operationId === operation.permitsOperationId)?.effect !== 'omnia_mutation'
    ) throw new Error('Connector Operation permit target is not a declared mutation Operation.');
  }
  const policyBytes = packageFile(envelope, 'operation/policy.json');
  const policy = parseJson(policyBytes, 'Connector Operation policy');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Connector Operation policy is invalid.');
  exactKeys(policy, ['schemaVersion', 'packageId', 'operationDigests'], 'Connector Operation policy');
  const policyRecord = policy as {
    schemaVersion: unknown;
    packageId: unknown;
    operationDigests: unknown;
  };
  if (
    policyRecord.schemaVersion !== 'omnia.connector-operation-policy/v1'
    || policyRecord.packageId !== manifest.packageId
    || !policyRecord.operationDigests
    || typeof policyRecord.operationDigests !== 'object'
    || Array.isArray(policyRecord.operationDigests)
  ) throw new Error('Connector Operation policy identity is invalid.');
  exactKeys(policyRecord.operationDigests as object, [...operationIds], 'Connector Operation policy digests');
  for (const operation of manifest.operations) {
    const digest = (policyRecord.operationDigests as Record<string, unknown>)[operation.operationId];
    const expected = crypto.createHash('sha256').update(JSON.stringify(operation)).digest('hex');
    if (digest !== expected) throw new Error('Connector Operation policy digest does not match its exact route contract.');
  }
  const signature = parseJson(packageFile(envelope, 'SIGNATURE.json'), 'Connector Operation signature metadata');
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) throw new Error('Connector Operation signature metadata is invalid.');
  exactKeys(signature, ['schemaVersion', 'scope', 'keyId'], 'Connector Operation signature metadata');
  const signatureRecord = signature as Record<string, unknown>;
  if (
    signatureRecord.schemaVersion !== 'omnia.package-signature-metadata/v1'
    || signatureRecord.scope !== 'connector-operation'
    || signatureRecord.keyId !== 'omnia-v5-official-operation-2026-01'
  ) throw new Error('Connector Operation signature scope is invalid.');
  if (manifest.resourceOwner && !executable) {
    throw new Error('Connector Operation resource ownership requires an executable signed handler.');
  }
  const capabilityFingerprint = executable
    ? crypto.createHash('sha256').update(canonicalJson({
      publisherKeyId: envelope.publisher.keyId,
      featureId: manifest.featureId,
      packageId: manifest.packageId,
      operations: manifest.operations,
      handlerSha256: crypto.createHash('sha256').update(packageFile(envelope, 'operation/handler.cjs')).digest('hex'),
      policySha256: crypto.createHash('sha256').update(policyBytes).digest('hex')
    })).digest('hex')
    : '';
  return { envelope, manifest, digest, capabilityFingerprint };
}

interface PrivateMigration {
  schemaVersion: 'omnia.feature-private-migration/v1';
  namespace: string;
  version: 1;
  tables: Array<{
    name: string;
    columns: Array<{
      name: string;
      type: 'TEXT' | 'INTEGER';
      notNull: boolean;
      primaryKey: boolean;
    }>;
  }>;
}

function parsePrivateMigration(envelope: OfficialPackageEnvelope, namespace: string): PrivateMigration {
  const value = parseJson(packageFile(envelope, 'backend/migrations/001.json'), 'Feature private migration');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Feature private migration is invalid.');
  exactKeys(value, ['schemaVersion', 'namespace', 'version', 'tables'], 'Feature private migration');
  const migration = value as PrivateMigration;
  if (
    migration.schemaVersion !== 'omnia.feature-private-migration/v1'
    || migration.namespace !== namespace
    || migration.version !== 1
    || !Array.isArray(migration.tables)
    || migration.tables.length < 1
    || migration.tables.length > 16
  ) throw new Error('Feature private migration identity is invalid.');
  const tableNames = new Set<string>();
  for (const table of migration.tables) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('Feature migration table is invalid.');
    exactKeys(table, ['name', 'columns'], 'Feature migration table');
    if (
      typeof table.name !== 'string'
      || !new RegExp(`^${namespace}_[a-z][a-z0-9_]{0,47}$`, 'u').test(table.name)
      || tableNames.has(table.name)
      || !Array.isArray(table.columns)
      || table.columns.length < 1
      || table.columns.length > 32
    ) throw new Error('Feature migration table escaped its namespace or is malformed.');
    tableNames.add(table.name);
    const columnNames = new Set<string>();
    let primaryKeys = 0;
    for (const column of table.columns) {
      if (!column || typeof column !== 'object' || Array.isArray(column)) throw new Error('Feature migration column is invalid.');
      exactKeys(column, ['name', 'type', 'notNull', 'primaryKey'], 'Feature migration column');
      if (
        typeof column.name !== 'string'
        || !/^[a-z][a-z0-9_]{0,47}$/u.test(column.name)
        || columnNames.has(column.name)
        || (column.type !== 'TEXT' && column.type !== 'INTEGER')
        || typeof column.notNull !== 'boolean'
        || typeof column.primaryKey !== 'boolean'
      ) throw new Error('Feature migration column is malformed.');
      columnNames.add(column.name);
      if (column.primaryKey) primaryKeys += 1;
    }
    if (primaryKeys !== 1) throw new Error('Feature migration table must have exactly one primary key.');
  }
  return migration;
}

function applyPrivateMigration(store: DatabaseSync, migration: PrivateMigration): void {
  store.exec('BEGIN IMMEDIATE;');
  try {
    for (const table of migration.tables) {
      const columns = table.columns.map((column) =>
        `"${column.name}" ${column.type}${column.primaryKey ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}`
      ).join(', ');
      store.exec(`CREATE TABLE IF NOT EXISTS "${table.name}" (${columns});`);
    }
    store.exec(`
      CREATE TABLE IF NOT EXISTS "__feature_schema_migrations" (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    store.prepare(`
      INSERT OR IGNORE INTO "__feature_schema_migrations"(version, applied_at) VALUES(?, ?)
    `).run(migration.version, utcNow());
    store.exec('COMMIT;');
  } catch (error) {
    store.exec('ROLLBACK;');
    throw error;
  }
}

function effectiveActionDependencies(
  action: import('../../shared/feature-contracts.js').DeclarativeFeatureAction
): ReadonlyArray<'remote_connector' | 'safety_lock' | 'verified_canary'> {
  if (action.dependencies !== undefined) return action.dependencies;
  return action.effect === 'omnia_mutation' ? ['remote_connector', 'safety_lock'] : [];
}

function readEnvelope(filename: string): unknown {
  const stats = fs.statSync(filename);
  if (!stats.isFile() || stats.size < 1 || stats.size > 96 * 1024 * 1024) {
    throw new Error('Official package file size is invalid.');
  }
  return JSON.parse(fs.readFileSync(filename, 'utf8')) as unknown;
}

function resolveManagedPythonRuntime(
  paths: ProductPaths,
  installed: InstalledFeaturePackage
): import('./worker-supervisor.js').FeatureWorkerManagedRuntime | undefined {
  const declaration = installed.pythonSidecar;
  if (!declaration) return undefined;
  const runtimeRoot = path.resolve(paths.root, 'runtime', 'python', MANAGED_PYTHON_DISTRIBUTION);
  const expectedRuntimeRoot = path.join(path.resolve(paths.root), 'runtime', 'python', MANAGED_PYTHON_DISTRIBUTION);
  if (runtimeRoot !== expectedRuntimeRoot || !path.isAbsolute(runtimeRoot)) {
    throw new AppError('FEATURE.PYTHON_RUNTIME_PATH_INVALID', 'Managed Python runtime escaped the product root.');
  }
  const pythonExecutable = path.join(runtimeRoot, 'python.exe');
  const runtimeManifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  if (!fs.existsSync(pythonExecutable) || !fs.statSync(pythonExecutable).isFile()) {
    throw new AppError(
      'FEATURE.PYTHON_RUNTIME_MISSING',
      `Managed CPython 3.13.14 runtime is missing at the fixed product path: runtime/python/${MANAGED_PYTHON_DISTRIBUTION}/python.exe. System Python and Anaconda fallback are forbidden.`
    );
  }
  if (!fs.existsSync(runtimeManifestPath) || !fs.statSync(runtimeManifestPath).isFile()) {
    throw new AppError('FEATURE.PYTHON_RUNTIME_MANIFEST_MISSING', 'Managed CPython runtime identity manifest is missing.');
  }
  let runtimeManifest: Record<string, unknown>;
  try {
    runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError('FEATURE.PYTHON_RUNTIME_MANIFEST_INVALID', 'Managed CPython runtime identity manifest is invalid.');
  }
  exactKeys(runtimeManifest, [
    'schemaVersion', 'product', 'implementation', 'version', 'architecture', 'distribution',
    'sourceUrl', 'sourceSha256', 'sitePackagesEnabled', 'runtimePipEnabled'
  ], 'Managed Python runtime manifest');
  if (
    runtimeManifest.schemaVersion !== 'omnia.managed-python-runtime/v1'
    || runtimeManifest.product !== 'omnia-agent-v5'
    || runtimeManifest.implementation !== 'CPython'
    || runtimeManifest.version !== declaration.version
    || runtimeManifest.architecture !== declaration.architecture
    || runtimeManifest.distribution !== 'embeddable'
    || runtimeManifest.sourceUrl !== 'https://www.python.org/ftp/python/3.13.14/python-3.13.14-embed-amd64.zip'
    || runtimeManifest.sourceSha256 !== MANAGED_PYTHON_ARCHIVE_SHA256
    || runtimeManifest.sitePackagesEnabled !== false
    || runtimeManifest.runtimePipEnabled !== false
  ) throw new AppError('FEATURE.PYTHON_RUNTIME_IDENTITY_MISMATCH', 'Managed CPython runtime identity differs from the signed Feature contract.');
  const pythonEntry = path.resolve(installed.root, ...declaration.entryPath.split('/'));
  const bridgePath = path.resolve(installed.root, ...declaration.bridgePath.split('/'));
  if (
    !pythonEntry.startsWith(`${installed.root}${path.sep}`)
    || !bridgePath.startsWith(`${installed.root}${path.sep}`)
    || !fs.existsSync(pythonEntry) || !fs.statSync(pythonEntry).isFile()
    || !fs.existsSync(bridgePath) || !fs.statSync(bridgePath).isFile()
  ) throw new AppError('FEATURE.PYTHON_SIDECAR_MEMBER_MISSING', 'Signed Feature Python sidecar members are unavailable.');
  const tempRoot = path.resolve(paths.temp, 'features', installed.manifest.featureId);
  const expectedTempParent = path.resolve(paths.temp, 'features');
  if (!tempRoot.startsWith(`${expectedTempParent}${path.sep}`)) {
    throw new AppError('FEATURE.PYTHON_TEMP_PATH_INVALID', 'Feature Python sidecar temp root escaped its owned namespace.');
  }
  const storePath = path.resolve(paths.data, 'features', installed.manifest.featureId, 'store.sqlite');
  const expectedStoreRoot = path.resolve(paths.data, 'features', installed.manifest.featureId);
  if (!storePath.startsWith(`${expectedStoreRoot}${path.sep}`) || !fs.existsSync(storePath) || !fs.statSync(storePath).isFile()) {
    throw new AppError('FEATURE.PYTHON_STORE_PATH_INVALID', 'Feature Python sidecar store is unavailable outside its migrated private namespace.');
  }
  fs.mkdirSync(tempRoot, { recursive: true });
  return { pythonExecutable, pythonEntry, packageRoot: installed.root, tempRoot, storePath };
}

export class FeaturePackageManager {
  private selectedFeatureId = '';
  private readonly supervisors = new Map<string, FeatureWorkerSupervisor>();
  private readonly runtimeSurfaces = new Map<string, DeclarativeFeatureSurface>();
  private readonly liveReturnProgressSnapshots = new Map<string, LiveReturnProgressSnapshot>();
  private readonly operationRegistrations = new Map<string, { sessionGeneration: number; packageDigest: string }>();
  private readonly installedPackages = new Map<string, { identity: string; value: InstalledFeaturePackage }>();
  private readonly pendingRuntimeEvents = new Set<string>();
  private readonly runtimeStore: FeatureRuntimeStore;
  private connectorDeliveryAckFlush: Promise<void> | null = null;
  private readonly connectorDeliveryAckRetryTimer: NodeJS.Timeout | null;

  constructor(
    private readonly database: DatabaseSync,
    private readonly paths: ProductPaths,
    private readonly faultInjector?: (point: 'after_immutable_move_before_activation') => void,
    private readonly runtime?: FeatureRuntimeDependencies,
    private readonly interactionLogs?: InteractionLogService
  ) {
    ensureOperationHandoffLedger(database);
    this.runtimeStore = new FeatureRuntimeStore(database, paths);
    this.database.prepare(`UPDATE connector_delivery_ack_outbox SET state='pending',updated_at=? WHERE state='sending'`).run(utcNow());
    fs.mkdirSync(path.join(paths.data, 'packages', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'packages', 'installed'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'features'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'documentation', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'documentation', 'features'), { recursive: true });
    if (this.runtime?.connector.acknowledgeDelivery) {
      queueMicrotask(() => { void this.flushConnectorDeliveryAcks(); });
      this.connectorDeliveryAckRetryTimer = setInterval(() => {
        void this.flushConnectorDeliveryAcks();
      }, 5_000);
      this.connectorDeliveryAckRetryTimer.unref();
    } else {
      this.connectorDeliveryAckRetryTimer = null;
    }
  }

  private scheduleConnectorDeliveryAckFlush(): void {
    queueMicrotask(() => {
      // Receipt/effect rows are already durable before this is scheduled.
      // Keeping their network delivery off the Feature command critical path
      // allows the next independent command to enter the Connector pipeline;
      // maintenance and update drains still observe the durable outbox.
      void this.flushConnectorDeliveryAcks().catch(() => undefined);
    });
  }

  private async flushConnectorDeliveryAcks(): Promise<void> {
    const connector = this.runtime?.connector;
    const acknowledgeDelivery = connector?.acknowledgeDelivery?.bind(connector);
    if (!acknowledgeDelivery) return;
    if (this.connectorDeliveryAckFlush) return this.connectorDeliveryAckFlush;
    const drain = async (): Promise<void> => {
      for (;;) {
        const rows = this.database.prepare(`
          SELECT o.ack_id,o.transaction_kind,o.payload_json
          FROM connector_delivery_ack_outbox o
          WHERE o.state='pending'
            AND (
              o.transaction_kind='receipt_committed'
              OR EXISTS(
                SELECT 1 FROM connector_delivery_ack_outbox receipt
                WHERE receipt.request_id=o.request_id
                  AND receipt.transaction_kind='receipt_committed'
                  AND receipt.state='delivered'
              )
            )
          ORDER BY CASE WHEN o.attempts=0 THEN 0 ELSE 1 END,o.created_at DESC,o.ack_id LIMIT 8
        `).all() as Array<{ ack_id: string; transaction_kind: 'receipt_committed'|'effect_resolved'; payload_json: string }>;
        if (rows.length === 0) return;
        let retryNeeded = false;
        const claimedRows: typeof rows = [];
        for (const row of rows) {
          const claimed = this.database.prepare(`
            UPDATE connector_delivery_ack_outbox SET state='sending',attempts=attempts+1,updated_at=?
            WHERE ack_id=? AND state='pending'
          `).run(utcNow(), row.ack_id);
          if (Number(claimed.changes) === 1) claimedRows.push(row);
        }
        for (let offset = 0; offset < claimedRows.length; offset += 8) {
          const chunk = claimedRows.slice(offset, offset + 8);
          const outcomes = await Promise.all(chunk.map(async (row) => {
            try {
              const acknowledged = await acknowledgeDelivery(
                JSON.parse(row.payload_json) as import('../../shared/connector-delivery.js').ConnectorDeliveryAck
              );
              if (!acknowledged || acknowledged.acknowledged !== true
                || !Number.isSafeInteger(acknowledged.clearedMutationCount)
                || acknowledged.clearedMutationCount !== (row.transaction_kind === 'effect_resolved' ? 1 : 0)) {
                throw new Error('Connector returned an invalid delivery acknowledgement result.');
              }
              return { row, error: null };
            } catch (error) {
              return { row, error };
            }
          }));
          for (const outcome of outcomes) {
            if (outcome.error === null) {
              this.database.prepare(`
                UPDATE connector_delivery_ack_outbox SET state='delivered',last_error='',updated_at=?,delivered_at=?
                WHERE ack_id=? AND state='sending'
              `).run(utcNow(), utcNow(), outcome.row.ack_id);
            } else {
              this.database.prepare(`
                UPDATE connector_delivery_ack_outbox SET state='pending',last_error=?,updated_at=?
                WHERE ack_id=? AND state='sending'
              `).run(outcome.error instanceof Error ? outcome.error.message.slice(0, 500) : 'delivery acknowledgement failed', utcNow(), outcome.row.ack_id);
              retryNeeded = true;
            }
          }
        }
        if (retryNeeded) return;
      }
    };
    this.connectorDeliveryAckFlush = drain().finally(() => {
      this.connectorDeliveryAckFlush = null;
    });
    return this.connectorDeliveryAckFlush;
  }

  private async closeConnectorNextMutationNotStarted(input: {
    requestId: string;
    runId: string;
    commandId: string;
    featureId: string;
    featureVersion: string;
    operationId: string;
    operationPackageDigest: string;
    connectorId: string;
    sessionGeneration: number;
    witness: import('../../shared/connector-delivery.js').ConnectorDeliveryWitness;
    message: string;
  }): Promise<void> {
    const command = this.database.prepare(`
      SELECT c.intent_id,c.state,c.connector_request_id,c.connector_execution_generation,
        c.connector_session_generation,c.connector_id,c.connector_operation_package_digest,
        c.connector_feature_version,c.operation_id,r.feature_id
      FROM feature_commands c JOIN feature_runs r ON r.run_id=c.run_id
      WHERE c.run_id=? AND c.command_id=?
    `).get(input.runId,input.commandId) as Record<string,unknown>|undefined;
    const delivery = this.database.prepare(`
      SELECT * FROM connector_delivery_requests
      WHERE request_id=? AND run_id=? AND command_id=? AND purpose='mutation'
    `).get(input.requestId,input.runId,input.commandId) as Record<string,unknown>|undefined;
    if(!command||!delivery||String(command.state)!=='submitted'
      ||String(command.feature_id)!==input.featureId||String(command.connector_request_id)!==input.requestId
      ||String(command.connector_execution_generation)!==input.witness.executionGeneration
      ||Number(command.connector_session_generation)!==input.sessionGeneration
      ||String(command.connector_id)!==input.connectorId
      ||String(command.connector_operation_package_digest)!==input.operationPackageDigest
      ||String(command.connector_feature_version)!==input.featureVersion||String(command.operation_id)!==input.operationId
      ||String(delivery.state)!=='witnessed'||String(delivery.feature_id)!==input.featureId
      ||String(delivery.feature_version)!==input.featureVersion||String(delivery.operation_id)!==input.operationId
      ||String(delivery.operation_package_digest)!==input.operationPackageDigest
      ||String(delivery.connector_id)!==input.connectorId||Number(delivery.session_generation)!==input.sessionGeneration
      ||String(delivery.execution_generation)!==input.witness.executionGeneration
      ||String(delivery.wire_result_digest)!==input.witness.resultDigest){
      throw new AppError('CONNECTOR_NEXT.MUTATION_NOT_STARTED_IDENTITY_INVALID','Connector Next pre-effect proof is not bound to the exact durable command identity.');
    }
    const occurredAt=utcNow();const receiptId=randomUUID();const receiptAckId=randomUUID();const effectAckId=randomUUID();
    const proof={schemaVersion:'omnia.connector-next-pre-effect-proof/v1',requestId:input.requestId,resultDigest:input.witness.resultDigest,
      executionGeneration:input.witness.executionGeneration,code:'CONNECTOR_NEXT.MUTATION_NOT_STARTED',message:input.message};
    const proofDigest=crypto.createHash('sha256').update(canonicalJson(proof)).digest('hex');
    const identity={connectorId:input.connectorId,sessionGeneration:input.sessionGeneration,executionGeneration:input.witness.executionGeneration,
      featureId:input.featureId,featureVersion:input.featureVersion,operationId:input.operationId,operationPackageDigest:input.operationPackageDigest,
      runId:input.runId,commandId:input.commandId};
    const reconciles={requestId:input.requestId,connectorId:input.connectorId,sessionGeneration:input.sessionGeneration,
      executionGeneration:input.witness.executionGeneration,featureId:input.featureId,featureVersion:input.featureVersion,
      operationId:input.operationId,operationPackageDigest:input.operationPackageDigest};
    const receiptAck={schemaVersion:'omnia.connector-delivery-ack/v1',ackId:receiptAckId,deliveredRequestId:input.requestId,
      resultDigest:input.witness.resultDigest,...identity,receiptId,receiptResponseDigest:proofDigest,
      resolution:'receipt_committed',effectOutcome:null,reconciles:null} satisfies import('../../shared/connector-delivery.js').ConnectorDeliveryAck;
    const effectAck={schemaVersion:'omnia.connector-delivery-ack/v1',ackId:effectAckId,deliveredRequestId:input.requestId,
      resultDigest:input.witness.resultDigest,...identity,receiptId,receiptResponseDigest:proofDigest,
      resolution:'closed_not_applied',effectOutcome:'not_applied',reconciles} satisfies import('../../shared/connector-delivery.js').ConnectorDeliveryAck;
    this.database.exec('BEGIN IMMEDIATE;');
    try{
      const closed=this.database.prepare(`UPDATE feature_commands SET state='closed_not_applied',completed_at=?,last_error=?
        WHERE run_id=? AND command_id=? AND state='submitted' AND connector_request_id=?`)
        .run(occurredAt,input.message,input.runId,input.commandId,input.requestId);
      if(Number(closed.changes)!==1)throw new Error('Connector Next pre-effect command closure changed concurrently.');
      const verified=this.database.prepare(`UPDATE managed_content_intents SET state='verified',updated_at=?
        WHERE intent_id=? AND state='commanded'`).run(occurredAt,String(command.intent_id));
      if(Number(verified.changes)!==1)throw new Error('Connector Next pre-effect intent closure changed concurrently.');
      this.database.prepare(`INSERT INTO feature_command_evidence(
        evidence_id,command_id,run_id,evidence_type,evidence_digest,receipt_id,verified,payload_json,occurred_at
      ) VALUES(?,?,?,'reconcile',?,'',1,?,?)`).run(randomUUID(),input.commandId,input.runId,proofDigest,canonicalJson(proof),occurredAt);
      this.database.prepare(`INSERT INTO connector_delivery_ack_outbox(
        ack_id,request_id,transaction_kind,payload_json,state,attempts,last_error,created_at,updated_at,delivered_at
      ) VALUES(?,?,'receipt_committed',?,'pending',0,'',?,?,'')`)
        .run(receiptAckId,input.requestId,canonicalJson(receiptAck),occurredAt,occurredAt);
      this.database.prepare(`INSERT INTO connector_delivery_ack_outbox(
        ack_id,request_id,transaction_kind,payload_json,state,attempts,last_error,created_at,updated_at,delivered_at
      ) VALUES(?,?,'effect_resolved',?,'pending',0,'',?,?,'')`)
        .run(effectAckId,input.requestId,canonicalJson(effectAck),occurredAt,occurredAt);
      this.database.prepare(`UPDATE connector_delivery_requests SET state='effect_resolved',updated_at=?
        WHERE request_id=? AND state='witnessed'`).run(occurredAt,input.requestId);
      this.database.exec('COMMIT;');
    }catch(error){this.database.exec('ROLLBACK;');throw error;}
    await this.flushConnectorDeliveryAcks();
    const delivered=this.database.prepare(`SELECT 1 FROM connector_delivery_ack_outbox
      WHERE ack_id=? AND state='delivered'`).get(effectAckId);
    if(!delivered)throw new AppError('CONNECTOR_NEXT.MUTATION_NOT_STARTED_ACK_PENDING','Connector proved the mutation did not start; durable closure acknowledgement is still pending.',true);
  }

  private currentActivationOwnsRun(runId: string, featureId: string, featureVersion: string): boolean {
    return Boolean(this.database.prepare(`
      WITH RECURSIVE lineage(feature_version,package_digest,activation_generation) AS (
        SELECT r.feature_version,'',0
        FROM feature_runs r
        WHERE r.run_id=? AND r.feature_id=?
        UNION
        SELECT h.target_feature_version,h.target_package_digest,h.target_activation_generation
        FROM lineage l
        JOIN feature_operation_handoffs h
          ON h.feature_id=? AND h.source_feature_version=l.feature_version
        WHERE h.phase='finalized'
      )
      SELECT 1
      FROM lineage l
      JOIN feature_activation_heads a
        ON a.feature_id=?
       AND a.feature_version=l.feature_version
       AND a.runtime_enabled=1
      WHERE l.feature_version=?
        AND (l.package_digest='' OR (
          a.package_digest=l.package_digest
          AND a.activation_generation=l.activation_generation
        ))
      LIMIT 1
    `).get(runId, featureId, featureId, featureId, featureVersion));
  }

  private legacyRecoveryRun(featureId: string, successorFeatureVersion: string, sourceFeatureVersions: string[] = []): Record<string, any> | null {
    const sourceClause = sourceFeatureVersions.length > 0
      ? ` AND feature_version IN (${sourceFeatureVersions.map(()=>' ? ').join(',')})`
      : '';
    const rows = this.database.prepare(`
      SELECT run_id,feature_version,state,state_revision,engagement_id
      FROM feature_runs
      WHERE feature_id=? AND feature_version<>?
        ${sourceClause}
        AND state NOT IN ('succeeded','failed','cancelled','not_evaluable')
      ORDER BY created_at,run_id
    `).all(featureId, successorFeatureVersion, ...sourceFeatureVersions) as Array<Record<string, any>>;
    if (rows.length > 1) throw new AppError('FEATURE.RECOVERY_SOURCE_AMBIGUOUS', 'More than one nonterminal legacy Run blocks cross-generation recovery.');
    return rows[0] || null;
  }

  private assertRecoveryActivationAllowed(manifest: FeatureManifest): void {
    const legacy = this.legacyRecoveryRun(manifest.featureId, manifest.version, manifest.recoveryCompatibility?.sourceFeatureVersions || []);
    if (!legacy) return;
    const declaration = manifest.recoveryCompatibility;
    const inFlight = (this.database.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state IN ('submitted','committed','verifying','uncertain')`)
      .get(String(legacy.run_id)) as { count: number }).count;
    const uncertain = (this.database.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state='uncertain'`)
      .get(String(legacy.run_id)) as { count: number }).count;
    const stateEligible = declaration?.mode === 'partial_close_no_reuse'
      ? String(legacy.state) === 'returning'
      : declaration?.mode === 'frozen_input_finalize'
        ? String(legacy.state) === 'processing'
        : false;
    if (!declaration || !declaration.sourceFeatureVersions.includes(String(legacy.feature_version))
      || !stateEligible || inFlight !== 0 || uncertain !== 0) {
      throw new AppError('FEATURE.ACTIVE_RUN_BLOCKS_ACTIVATION', 'A nonterminal Run blocks activation; only an explicitly declared, unambiguous partial-Return recovery upgrade may proceed.');
    }
  }

  private assertRecoveryModeAction(manifest: FeatureManifest, actionId: string): void {
    const legacy = this.legacyRecoveryRun(manifest.featureId, manifest.version, manifest.recoveryCompatibility?.sourceFeatureVersions || []);
    if (!legacy) return;
    const declaration = manifest.recoveryCompatibility;
    const inFlight = (this.database.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state IN ('submitted','committed','verifying','uncertain')`)
      .get(String(legacy.run_id)) as { count: number }).count;
    const uncertain = (this.database.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state='uncertain'`)
      .get(String(legacy.run_id)) as { count: number }).count;
    const stateEligible = declaration?.mode === 'partial_close_no_reuse'
      ? String(legacy.state) === 'returning'
      : declaration?.mode === 'frozen_input_finalize'
        ? String(legacy.state) === 'processing'
        : false;
    if (!declaration || !declaration.sourceFeatureVersions.includes(String(legacy.feature_version))
      || !stateEligible || inFlight !== 0 || uncertain !== 0
      || actionId !== declaration.actionId) {
      throw new AppError('FEATURE.RECOVERY_MODE_ONLY', 'A legacy partial Return is open; only its declared read-only recovery action is permitted.');
    }
  }

  importArtifact(request: FeatureArtifactInputRequest, sourceFilename: string): FeatureArtifactDescriptor {
    const source = path.resolve(sourceFilename);
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new AppError('FEATURE.ARTIFACT_SIZE_INVALID', 'Feature input must be a regular file.');
    return this.importArtifactContent(request, path.basename(source), fs.readFileSync(source), 'interactive-file-picker');
  }

  importArtifactBytes(request: FeatureArtifactInputRequest, name: string, bytes: Uint8Array): FeatureArtifactDescriptor {
    if (!(bytes instanceof Uint8Array)) throw new AppError('FEATURE.ARTIFACT_BYTES_INVALID', 'Dropped Feature input bytes are invalid.');
    return this.importArtifactContent(request, name, Buffer.from(bytes), 'renderer-drag-drop');
  }

  private importArtifactContent(
    request: FeatureArtifactInputRequest,
    originalName: string,
    bytes: Buffer,
    sourceRef: 'interactive-file-picker' | 'renderer-drag-drop'
  ): FeatureArtifactDescriptor {
    const head = this.head(request.featureId);
    if (!head || head.featureVersion !== request.featureVersion) {
      throw new AppError('FEATURE.VERSION_MISMATCH', 'The Feature artifact target is not the active version.');
    }
    const installed = this.loadInstalled(head);
    if (this.legacyRecoveryRun(request.featureId, request.featureVersion, installed.manifest.recoveryCompatibility?.sourceFeatureVersions || [])) {
      throw new AppError('FEATURE.RECOVERY_MODE_ONLY', 'A legacy partial Return must be closed before a successor Run can import an artifact.');
    }
    const { surface } = installed;
    if (surface.surfaceId !== request.surfaceId) throw new AppError('FEATURE.SURFACE_MISMATCH', 'Feature artifact surface drifted.');
    const action = surface.actions.find((candidate) => candidate.actionId === request.actionId);
    if (!action?.input || action.input.kind !== 'open_file') throw new AppError('FEATURE.INPUT_NOT_DECLARED', 'This action has no file input contract.');
    const fileInput=action.input;
    if (
      request.accept.length !== fileInput.accept.length
      || request.accept.some((extension) => !fileInput.accept.includes(extension))
    ) throw new AppError('FEATURE.INPUT_CONTRACT_MISMATCH', 'Feature input accept list drifted.');
    if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) {
      throw new AppError('FEATURE.ARTIFACT_SIZE_INVALID', 'Feature input must be a non-empty file no larger than 64 MiB.');
    }
    if (typeof originalName !== 'string' || originalName !== path.basename(originalName) || originalName.length > 255) {
      throw new AppError('FEATURE.ARTIFACT_NAME_INVALID', 'Feature input name is invalid.');
    }
    const extension = path.extname(originalName).toLowerCase();
    if (!fileInput.accept.includes(extension)) throw new AppError('FEATURE.ARTIFACT_TYPE_INVALID', 'Selected file type is not allowed.');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const artifactId = randomUUID();
    const runId = randomUUID();
    const traceId = randomUUID();
    const startedAt = utcNow();
    const engagementId = String(request.engagementId || '');
    if (engagementId.length > 200) throw new AppError('FEATURE.ENGAGEMENT_ID_INVALID', 'Feature artifact engagement identity is invalid.');
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const stagedRuns = this.database.prepare(`
        SELECT run_id, state_revision FROM feature_runs
        WHERE feature_id=? AND feature_version=? AND engagement_id=? AND state='acquiring'
        ORDER BY created_at
      `).all(request.featureId, request.featureVersion, engagementId) as Array<{ run_id: string; state_revision: number }>;
      for (const stagedRun of stagedRuns) {
        const nextRevision = Number(stagedRun.state_revision) + 1;
        const cancelled = this.database.prepare(`
          UPDATE feature_runs SET state='cancelled', state_revision=?, last_error='', updated_at=?
          WHERE run_id=? AND feature_id=? AND feature_version=? AND state='acquiring' AND state_revision=?
        `).run(nextRevision, startedAt, stagedRun.run_id, request.featureId, request.featureVersion, stagedRun.state_revision);
        if (cancelled.changes !== 1) throw new Error('Staged Feature Run changed before replacement cancellation.');
        this.database.prepare(`
          INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at)
          VALUES(?, ?, ?, 'acquiring', 'cancelled', 'artifact.staging_replaced', ?, ?)
        `).run(randomUUID(), stagedRun.run_id, nextRevision, JSON.stringify({ replacementRunId: runId, preserveArtifact: true }), startedAt);
      }
      this.database.prepare(`
        INSERT INTO feature_runs(
          run_id, trace_id, feature_id, feature_version, engagement_id, state, state_revision,
          source_artifact_id, template_version_id, output_artifact_id, plan_digest, last_error, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, 'draft', 1, '', '', '', '', '', ?, ?)
      `).run(runId, traceId, request.featureId, request.featureVersion, engagementId, startedAt, startedAt);
      this.database.prepare(`
        INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at)
        VALUES(?, ?, 1, '', 'draft', 'intake.prepared', '{}', ?)
      `).run(randomUUID(), runId, startedAt);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
    const relative = path.posix.join('features', request.featureId, 'artifacts', artifactId, `source${extension}`);
    const destination = path.resolve(this.paths.data, ...relative.split('/'));
    const artifactRoot = path.resolve(this.paths.data, 'features', request.featureId, 'artifacts');
    if (!destination.startsWith(`${artifactRoot}${path.sep}`)) throw new AppError('FEATURE.ARTIFACT_PATH_INVALID', 'Managed artifact path escaped its Feature root.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try { fs.writeFileSync(destination, bytes, { flag: 'wx' }); }
    catch (error) {
      const failedAt = utcNow();
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        this.database.prepare(`UPDATE feature_runs SET state='cancelled', state_revision=2, last_error=?, updated_at=? WHERE run_id=? AND state_revision=1`)
          .run(error instanceof Error ? error.message : 'Artifact copy failed.', failedAt, runId);
        this.database.prepare(`
          INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at)
          VALUES(?, ?, 2, 'draft', 'cancelled', 'artifact.copy_failed', ?, ?)
        `).run(randomUUID(), runId, JSON.stringify({ message: error instanceof Error ? error.message : 'Artifact copy failed.' }), failedAt);
        this.database.exec('COMMIT;');
      } catch (databaseError) {
        this.database.exec('ROLLBACK;');
        throw databaseError;
      }
      throw error;
    }
    const importedAt = utcNow();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare(`
        INSERT INTO feature_artifacts(
          artifact_id, run_id, feature_id, kind, media_type, original_name, source_kind, source_ref,
          managed_path, sha256, size_bytes, source_version, imported_at, created_at
        ) VALUES(?, ?, ?, 'source', ?, ?, 'user_import', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifactId, runId, request.featureId,
        extension === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream',
        originalName, sourceRef, relative, sha256, bytes.length, request.featureVersion, importedAt, importedAt
      );
      const attached = this.database.prepare(`
        UPDATE feature_runs SET source_artifact_id=?, state='acquiring', state_revision=2, updated_at=?
        WHERE run_id=? AND state='draft' AND state_revision=1
      `).run(artifactId, importedAt, runId);
      if (attached.changes !== 1) throw new Error('Feature Run changed before the source artifact could be attached.');
      this.database.prepare(`
        INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at)
        VALUES(?, ?, 2, 'draft', 'acquiring', 'artifact.attached', ?, ?)
      `).run(randomUUID(), runId, JSON.stringify({ artifactId, sha256, sizeBytes: bytes.length, sourceRef }), importedAt);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      fs.rmSync(destination, { force: true });
      const failedAt=utcNow();
      try{
        this.database.exec('BEGIN IMMEDIATE;');
        const failed=this.database.prepare(`UPDATE feature_runs SET state='cancelled',state_revision=2,last_error=?,updated_at=? WHERE run_id=? AND state='draft' AND state_revision=1`).run(error instanceof Error?error.message:'Artifact attach failed.',failedAt,runId);
        if(failed.changes===1)this.database.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) VALUES(?,?,2,'draft','cancelled','artifact.attach_failed',?,?)`).run(randomUUID(),runId,JSON.stringify({message:error instanceof Error?error.message:'Artifact attach failed.'}),failedAt);
        this.database.exec('COMMIT;');
      }catch(recoveryError){this.database.exec('ROLLBACK;');if(error&&typeof error==='object')Object.defineProperty(error,'recoveryError',{value:recoveryError,enumerable:false});}
      throw error;
    }
    return {
      schemaVersion: 'omnia.feature-artifact/v1', artifactId, runId, traceId,
      featureId: request.featureId, featureVersion: request.featureVersion, surfaceId: request.surfaceId,
      kind: 'source', originalName,
      mediaType: extension === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream',
      sizeBytes: bytes.length, sha256, importedAt
    };
  }

  exportManagedAsset(featureId: string, featureVersion: string, actionId: string, memberPath: string): { source: string; suggestedName: string } {
    const head = this.head(featureId);
    if (!head || head.featureVersion !== featureVersion) throw new AppError('FEATURE.VERSION_MISMATCH', 'Managed asset target is not the active Feature version.');
    const { surface } = this.loadInstalled(head);
    const action = surface.actions.find((candidate) => candidate.actionId === actionId);
    if (action?.output?.kind !== 'save_managed_asset' || action.output.memberPath !== memberPath) throw new AppError('FEATURE.OUTPUT_CONTRACT_MISMATCH', 'Managed asset output differs from the signed Surface contract.');
    const row = this.database.prepare(`
      SELECT managed_path, member_digest, asset_kind FROM feature_managed_assets
      WHERE feature_id=? AND feature_version=? AND member_path=?
    `).get(featureId, featureVersion, memberPath) as { managed_path: string; member_digest: string; asset_kind: string } | undefined;
    if (!row || row.asset_kind !== 'source_template') throw new AppError('FEATURE.ASSET_NOT_EXPORTABLE', 'The requested signed source template is unavailable.');
    const source = path.resolve(this.paths.data, ...row.managed_path.split('/'));
    const installedRoot = path.resolve(this.paths.data, 'packages', 'installed', featureId, featureVersion);
    if (!source.startsWith(`${installedRoot}${path.sep}`) || !fs.statSync(source).isFile()) throw new AppError('FEATURE.ASSET_PATH_INVALID', 'Managed source template path is invalid.');
    const bytes = fs.readFileSync(source);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== row.member_digest) throw new AppError('FEATURE.ASSET_INTEGRITY', 'Managed source template digest drifted from the signed package member.');
    return { source, suggestedName: action.output.suggestedName };
  }

  exportArtifact(featureId: string, artifactId: string): { source: string; suggestedName: string } {
    const row = this.database.prepare(`
      SELECT managed_path, original_name, kind, sha256, size_bytes FROM feature_artifacts WHERE artifact_id=? AND feature_id=?
    `).get(artifactId, featureId) as {
      managed_path: string; original_name: string; kind: string; sha256: string; size_bytes: number;
    } | undefined;
    if (!row || !['template_candidate', 'template_instance', 'result', 'evidence'].includes(row.kind)) {
      throw new AppError('FEATURE.ARTIFACT_NOT_EXPORTABLE', 'The requested Feature artifact is unavailable for download.');
    }
    const source = path.resolve(this.paths.data, ...row.managed_path.split('/'));
    const featureRoot = path.resolve(this.paths.data, 'features', featureId, 'artifacts');
    if (!source.startsWith(`${featureRoot}${path.sep}`) || !fs.statSync(source).isFile()) {
      throw new AppError('FEATURE.ARTIFACT_PATH_INVALID', 'Managed artifact path is invalid.');
    }
    const bytes = fs.readFileSync(source);
    if (bytes.length !== row.size_bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw new AppError('FEATURE.ARTIFACT_INTEGRITY', 'Managed artifact bytes drifted from their durable digest.');
    }
    return { source, suggestedName: path.basename(row.original_name) };
  }

  private recoverInterruptedInstalls(): void {
    const rows = this.database.prepare(`
      SELECT attempt_id FROM feature_install_attempts
      WHERE status IN ('validating','staging','committing')
    `).all() as Array<{ attempt_id: string }>;
    for (const row of rows) {
      fs.rmSync(path.join(this.paths.data, 'packages', 'staging', row.attempt_id), { recursive: true, force: true });
      fs.rmSync(path.join(this.paths.data, 'documentation', 'staging', row.attempt_id), { recursive: true, force: true });
      this.database.prepare(`
        UPDATE feature_install_attempts
        SET status='failed', reason_code='INSTALL.INTERRUPTED', reason='Install was interrupted before atomic activation.',
            completed_at=?
        WHERE attempt_id=?
      `).run(utcNow(), row.attempt_id);
    }
  }

  private projectDocumentation(
    envelope: OfficialPackageEnvelope,
    manifest: FeatureManifest,
    digest: string,
    attemptId: string
  ): string {
    const digestSegment = digest.slice('sha256:'.length);
    const relative = path.posix.join(
      'documentation',
      'features',
      manifest.featureId,
      manifest.version,
      digestSegment
    );
    const destination = path.join(this.paths.data, ...relative.split('/'));
    if (fs.existsSync(destination)) {
      const marker = fs.readFileSync(path.join(destination, '.package-digest'), 'utf8');
      if (marker !== digest) throw new AppError('FEATURE.DOCUMENTATION_COLLISION', 'Documentation projection contains different bytes.');
      return relative;
    }
    const stage = path.join(this.paths.data, 'documentation', 'staging', attemptId);
    fs.mkdirSync(stage, { recursive: false });
    const docs = parseJson(packageFile(envelope, 'docs/manifest.json'), 'Documentation manifest') as DocumentationManifest;
    for (const memberPath of ['docs/manifest.json', ...docs.documents.map((document) => document.path)]) {
      const output = path.join(stage, path.basename(memberPath));
      fs.writeFileSync(output, packageFile(envelope, memberPath), { flag: 'wx' });
    }
    fs.writeFileSync(path.join(stage, '.package-digest'), digest, { flag: 'wx' });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) {
      fs.rmSync(stage, { recursive: true, force: true });
    } else {
      fs.renameSync(stage, destination);
    }
    return relative;
  }

  private validate(envelope: OfficialPackageEnvelope): {
    manifest: FeatureManifest;
    surface: DeclarativeFeatureSurface;
    documentationDigest: string;
    operationPackage: ValidatedOperationPackage;
  } {
    const manifest = parseManifest(envelope);
    const surface = parseSurface(envelope, manifest);
    if (manifest.recoveryCompatibility) {
      const action = surface.actions.find((candidate)=>candidate.actionId===manifest.recoveryCompatibility!.actionId);
      const requiredDependencies = manifest.recoveryCompatibility.mode === 'partial_close_no_reuse'
        ? ['remote_connector','safety_lock'] : ['remote_connector'];
      if (!action || action.effect !== 'local_state_write'
        || canonicalJson([...(action.dependencies || [])].sort()) !== canonicalJson(requiredDependencies)) {
        throw new Error('Feature recovery compatibility requires one exact local recovery action with its declared trust-boundary dependencies.');
      }
    }
    const documentationDigest = validateDocumentation(envelope, manifest);
    const runtimeContract = manifest.contractsPath || manifest.implementationMapPath || manifest.testsManifestPath
      ? validateFeatureBundleContracts(envelope, manifest) : null;
    const pythonSidecar = runtimeContract?.pythonSidecar || null;
    const docs = parseJson(packageFile(envelope, 'docs/manifest.json'), 'Documentation manifest') as DocumentationManifest;
    const members = [...envelope.files.map((member) => member.path)].sort();
    const required = [...new Set([
      ...REQUIRED_FEATURE_MEMBERS,
      ...docs.documents.map((document) => document.path),
      ...(manifest.assets || []).map((asset) => asset.path),
      ...(manifest.contractsPath?[manifest.contractsPath]:[]),
      ...(manifest.implementationMapPath?[manifest.implementationMapPath]:[]),
      ...(manifest.testsManifestPath?[manifest.testsManifestPath,'tests/vectors.json','tests/self-test.cjs']:[]),
      ...(pythonSidecar ? [pythonSidecar.bridgePath, ...pythonSidecar.members] : [])
    ])].sort();
    if (members.length !== required.length || members.some((member, index) => member !== required[index])) {
      throw new Error('Feature package member inventory is incomplete or contains undeclared files.');
    }
    parsePrivateMigration(envelope, manifest.storeNamespace);
    const operationInput = parseJson(packageFile(envelope, manifest.operationPackagePath), 'Connector Operation package');
    const operationPackage = validateOperationPackage(operationInput, manifest);
    const signatureMetadata = parseJson(packageFile(envelope, 'SIGNATURE.json'), 'Feature signature metadata');
    if (
      !signatureMetadata
      || typeof signatureMetadata !== 'object'
      || Array.isArray(signatureMetadata)
    ) throw new Error('Feature signature metadata is invalid.');
    exactKeys(signatureMetadata, ['schemaVersion', 'scope', 'keyId'], 'Feature signature metadata');
    const signatureRecord = signatureMetadata as Record<string, unknown>;
    if (
      signatureRecord.schemaVersion !== 'omnia.package-signature-metadata/v1'
      || signatureRecord.scope !== 'feature'
      || signatureRecord.keyId !== 'omnia-v5-official-feature-2026-01'
    ) throw new Error('Feature signature scope is invalid.');
    return { manifest, surface, documentationDigest, operationPackage };
  }

  install(packageFilename: string): FeatureInstallResult {
    this.recoverInterruptedInstalls();
    const attemptId = randomUUID();
    const startedAt = utcNow();
    this.database.prepare(`
      INSERT INTO feature_install_attempts(
        attempt_id, package_path, package_digest, feature_id, feature_version, status,
        reason_code, reason, started_at, completed_at
      ) VALUES(?, ?, '', '', '', 'validating', '', '', ?, '')
    `).run(attemptId, path.resolve(packageFilename), startedAt);
    const staging = path.join(this.paths.data, 'packages', 'staging', attemptId);
    try {
      const envelope = verifyOfficialPackage(readEnvelope(packageFilename), 'omnia-feature');
      const digest = packageDigest(envelope);
      const { manifest, documentationDigest, operationPackage } = this.validate(envelope);
      assertNoActiveOperationHandoff(this.database, manifest.featureId, 'Feature install');
      this.database.prepare(`
        UPDATE feature_install_attempts
        SET package_digest=?, feature_id=?, feature_version=?, status='staging'
        WHERE attempt_id=?
      `).run(digest, manifest.featureId, manifest.version, attemptId);
      const existing = this.database.prepare(`
        SELECT package_digest FROM feature_registry WHERE feature_id=? AND feature_version=?
      `).get(manifest.featureId, manifest.version) as { package_digest: string } | undefined;
      if (existing && existing.package_digest !== digest) {
        throw new AppError('FEATURE.VERSION_IMMUTABLE', 'The installed Feature version has different bytes and cannot be overwritten.');
      }
      const sequence = this.database.prepare(`
        SELECT highest_sequence FROM feature_publisher_sequences WHERE feature_id=?
      `).get(manifest.featureId) as { highest_sequence: number } | undefined;
      if (!existing && sequence && manifest.sequence <= sequence.highest_sequence) {
        throw new AppError('FEATURE.SEQUENCE_ROLLBACK', 'The package sequence is not newer than the highest installed official sequence.');
      }
      const current = this.head(manifest.featureId);
      if (existing && current?.featureVersion === manifest.version && current.packageDigest === digest) {
        this.database.prepare(`
          UPDATE feature_install_attempts
          SET status='completed', completed_at=?, reason_code='INSTALL.IDEMPOTENT',
              reason='Identical active candidate was already installed; no activation event was emitted.'
          WHERE attempt_id=?
        `).run(utcNow(), attemptId);
        return {
          attemptId,
          featureId: manifest.featureId,
          featureVersion: manifest.version,
          packageDigest: digest,
          documentationPath: current.documentationPath,
          activationGeneration: current.activationGeneration,
          runtimeEnabled: current.runtimeEnabled,
          runtimeReason: current.runtimeReason,
          idempotent: true
        };
      }
      if (existing) {
        throw new AppError(
          'FEATURE.VERSION_ALREADY_INSTALLED',
          'This immutable Feature version is already installed; use the explicit rollback command to activate it.'
        );
      }
      let operationHandoffSource: {
        head: ActivationHead;
        operation: ValidatedOperationPackage;
      } | null = null;
      if (current) {
        const sourceInstalled = this.loadInstalled(current);
        const sourceOperation = this.loadInstalledOperation(sourceInstalled);
        if (sourceOperation.digest !== operationPackage.digest) {
          assertCompatibleOperationHandoff(sourceOperation, operationPackage);
          operationHandoffSource = { head: current, operation: sourceOperation };
        }
      }
      this.assertRecoveryActivationAllowed(manifest);
      const digestSegment = digest.slice('sha256:'.length);
      const relativeInstalled = path.posix.join('packages', 'installed', manifest.featureId, manifest.version, digestSegment);
      const installed = path.join(this.paths.data, ...relativeInstalled.split('/'));
      fs.mkdirSync(staging, { recursive: false });
      for (const member of envelope.files) {
        const output = path.join(staging, ...member.path.split('/'));
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, Buffer.from(member.contentBase64, 'base64'), { flag: 'wx' });
      }
      fs.writeFileSync(path.join(staging, '.official-package-envelope.json'), JSON.stringify(envelope), { flag: 'wx' });
      const featureStoreDirectory = path.join(this.paths.data, 'features', manifest.featureId);
      fs.mkdirSync(featureStoreDirectory, { recursive: true });
      const featureStore = new DatabaseSync(path.join(featureStoreDirectory, 'store.sqlite'));
      try {
        featureStore.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        applyPrivateMigration(featureStore, parsePrivateMigration(envelope, manifest.storeNamespace));
      } finally {
        featureStore.close();
      }
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      if (fs.existsSync(installed)) {
        const orphan = verifyOfficialPackage(
          JSON.parse(fs.readFileSync(path.join(installed, '.official-package-envelope.json'), 'utf8')) as unknown,
          'omnia-feature'
        );
        if (packageDigest(orphan) !== digest) {
          throw new AppError('FEATURE.IMMUTABLE_PATH_COLLISION', 'An immutable package path exists with different bytes.');
        }
        fs.rmSync(staging, { recursive: true, force: true });
      } else {
        fs.renameSync(staging, installed);
      }
      this.faultInjector?.('after_immutable_move_before_activation');
      const documentationPath = this.projectDocumentation(envelope, manifest, digest, attemptId);
      const generation = (current?.activationGeneration ?? 0) + 1;
      const now = utcNow();
      const isOperationHandoffCandidate = operationHandoffSource !== null;
      const operationHandoffId = isOperationHandoffCandidate ? randomUUID() : '';
      const operationHandoffPendingReason = isOperationHandoffCandidate
        ? `Feature ${manifest.version} is staged; the active ${operationHandoffSource!.head.featureVersion} runtime remains authoritative until the Connector accepts the exact signed Operation resource-owner handoff.`
        : '';
      const runtimePendingReason = manifest.requiredIsolation === 'process'
        ? '安装完成；启动 Omnia Agent v5 Shell 后将自动加载 Feature 运行时。'
        : 'Legacy Feature package requires an unavailable runtime contract.';
      const initialHealth = isOperationHandoffCandidate
        ? 'pending_operation_handoff'
        : manifest.requiredIsolation === 'process' ? 'pending_start' : 'legacy_runtime_unavailable';
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        assertNoActiveOperationHandoff(this.database, manifest.featureId, 'Feature install');
        if (!isOperationHandoffCandidate) {
          this.database.prepare(`
            UPDATE feature_registry SET lifecycle='previous'
            WHERE feature_id=? AND feature_version<>?
          `).run(manifest.featureId, manifest.version);
          this.database.prepare(`
            UPDATE documentation_registry SET lifecycle='previous'
            WHERE feature_id=? AND feature_version<>?
          `).run(manifest.featureId, manifest.version);
        }
        this.database.prepare(`
          INSERT INTO feature_registry(
            feature_id, feature_version, lifecycle, package_digest, publisher_key_id, health, activated_at
          ) VALUES(?, ?, 'candidate', ?, 'omnia-v5-official-feature-2026-01', ?, ?)
          ON CONFLICT(feature_id, feature_version) DO UPDATE SET
            lifecycle='candidate', health=excluded.health, activated_at=excluded.activated_at
        `).run(manifest.featureId, manifest.version, digest, initialHealth, now);
        this.database.prepare(`
          INSERT INTO documentation_registry(
            feature_id, feature_version, documentation_digest, lifecycle, activated_at, physical_path
          ) VALUES(?, ?, ?, 'candidate', ?, ?)
          ON CONFLICT(feature_id, feature_version) DO UPDATE SET
            documentation_digest=excluded.documentation_digest, lifecycle='candidate',
            activated_at=excluded.activated_at, physical_path=excluded.physical_path
        `).run(manifest.featureId, manifest.version, documentationDigest, now, documentationPath);
        for (const asset of manifest.assets || []) {
          this.database.prepare(`
            INSERT INTO feature_managed_assets(
              feature_id, feature_version, package_digest, member_path, member_digest,
              asset_kind, managed_path, imported_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(feature_id, feature_version, member_path) DO UPDATE SET
              package_digest=excluded.package_digest,
              member_digest=excluded.member_digest,
              asset_kind=excluded.asset_kind,
              managed_path=excluded.managed_path,
              imported_at=excluded.imported_at
          `).run(
            manifest.featureId, manifest.version, digest, asset.path, asset.sha256, asset.kind,
            path.posix.join(relativeInstalled, asset.path), now
          );
        }
        if (isOperationHandoffCandidate) {
          this.database.prepare(`
            INSERT INTO feature_operation_handoffs(
              handoff_id,feature_id,source_feature_version,source_package_digest,
              source_operation_package_digest,source_activation_generation,target_feature_version,target_package_digest,
              target_operation_package_digest,target_activation_generation,registration_token,replaced_package_digests_json,
              phase,created_at,updated_at,last_error
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'[]','staged',?,?,'')
          `).run(
            operationHandoffId, manifest.featureId,
            operationHandoffSource!.head.featureVersion, operationHandoffSource!.head.packageDigest,
            operationHandoffSource!.operation.digest, operationHandoffSource!.head.activationGeneration,
            manifest.version, digest, operationPackage.digest, generation, '', now, now
          );
        }
        if (!isOperationHandoffCandidate) {
          this.database.prepare(`
            INSERT INTO feature_activation_heads(
            feature_id, feature_version, activation_generation, runtime_enabled, runtime_reason,
            package_path, package_digest, updated_at, documentation_path
          ) VALUES(?, ?, ?, 0, ?, ?, ?, ?, ?)
          ON CONFLICT(feature_id) DO UPDATE SET
            feature_version=excluded.feature_version,
            activation_generation=excluded.activation_generation,
            runtime_enabled=0,
            runtime_reason=excluded.runtime_reason,
            package_path=excluded.package_path,
            package_digest=excluded.package_digest,
            updated_at=excluded.updated_at,
            documentation_path=excluded.documentation_path
          `).run(
            manifest.featureId,
            manifest.version,
            generation,
            runtimePendingReason,
            relativeInstalled,
            digest,
            now,
            documentationPath
          );
          this.database.prepare(`
            INSERT INTO feature_activation_events(
            event_id, feature_id, from_version, to_version, event_type,
            activation_generation, package_digest, occurred_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            manifest.featureId,
            current?.featureVersion ?? '',
            manifest.version,
            current ? 'upgrade' : 'install',
            generation,
            digest,
            now
          );
        }
        this.database.prepare(`
          INSERT INTO feature_publisher_sequences(feature_id, highest_sequence, updated_at)
          VALUES(?, ?, ?)
          ON CONFLICT(feature_id) DO UPDATE SET
            highest_sequence=MAX(highest_sequence, excluded.highest_sequence), updated_at=excluded.updated_at
        `).run(manifest.featureId, manifest.sequence, now);
        this.database.prepare(`
          UPDATE feature_install_attempts
          SET status='completed', completed_at=?, reason_code=?, reason=?
          WHERE attempt_id=?
        `).run(
          now,
          isOperationHandoffCandidate ? 'INSTALL.OPERATION_HANDOFF_STAGED' : '',
          isOperationHandoffCandidate ? operationHandoffPendingReason : '',
          attemptId
        );
        this.database.exec('COMMIT;');
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw error;
      }
      this.installedPackages.delete(manifest.featureId);
      return {
        attemptId,
        featureId: manifest.featureId,
        featureVersion: manifest.version,
        packageDigest: digest,
        documentationPath,
        activationGeneration: isOperationHandoffCandidate ? operationHandoffSource!.head.activationGeneration : generation,
        runtimeEnabled: isOperationHandoffCandidate ? operationHandoffSource!.head.runtimeEnabled : false,
        runtimeReason: isOperationHandoffCandidate ? operationHandoffPendingReason : runtimePendingReason,
        idempotent: false
      };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      this.database.prepare(`
        UPDATE feature_install_attempts
        SET status=?, reason_code=?, reason=?, completed_at=?
        WHERE attempt_id=?
      `).run(
        error instanceof AppError ? 'rejected' : 'failed',
        error instanceof AppError ? error.code : 'FEATURE.PACKAGE_INVALID',
        error instanceof Error ? error.message : 'Feature package installation failed.',
        utcNow(),
        attemptId
      );
      throw error;
    }
  }

  rollback(featureId: string, targetVersion: string): FeatureInstallResult {
    assertNoActiveOperationHandoff(this.database, featureId, 'Feature rollback');
    const target = this.database.prepare(`
      SELECT f.feature_version, f.package_digest, d.physical_path
      FROM feature_registry f
      JOIN documentation_registry d
        ON d.feature_id=f.feature_id AND d.feature_version=f.feature_version
      WHERE f.feature_id=? AND f.feature_version=? AND f.lifecycle IN ('previous','candidate')
    `).get(featureId, targetVersion) as {
      feature_version: string;
      package_digest: string;
      physical_path: string;
    } | undefined;
    if (!target) throw new AppError('FEATURE.ROLLBACK_TARGET_UNAVAILABLE', 'The requested installed Feature version is unavailable.');
    const current = this.head(featureId);
    if (!current) throw new AppError('FEATURE.NOT_INSTALLED', 'The Feature has no activation head.');
    const relativeInstalled = path.posix.join(
      'packages',
      'installed',
      featureId,
      targetVersion,
      target.package_digest.slice('sha256:'.length)
    );
    const installed = path.join(this.paths.data, ...relativeInstalled.split('/'));
    if (!fs.existsSync(installed)) throw new AppError('FEATURE.PACKAGE_MISSING', 'The immutable Feature package directory is missing.');
    const generation = current.activationGeneration + 1;
    const targetHead: ActivationHead = {
      featureId,
      featureVersion: targetVersion,
      activationGeneration: generation,
      runtimeEnabled: false,
      runtimeReason: '',
      packagePath: relativeInstalled,
      packageDigest: target.package_digest,
      documentationPath: target.physical_path
    };
    const sourceOperation = this.loadInstalledOperation(this.loadInstalled(current));
    const targetOperation = this.loadInstalledOperation(this.loadInstalled(targetHead));
    if (targetOperation.manifest.sequence <= sourceOperation.manifest.sequence) throw new AppError(
      'FEATURE.OPERATION_ROLLBACK_UNPROVEN',
      'Rollback is blocked before activation because the active signed Operation package does not authorize this exact reverse handoff.'
    );
    assertCompatibleOperationHandoff(sourceOperation, targetOperation);
    const now = utcNow();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      assertNoActiveOperationHandoff(this.database, featureId, 'Feature rollback');
      this.database.prepare(`UPDATE feature_registry SET lifecycle='previous' WHERE feature_id=?`).run(featureId);
      this.database.prepare(`UPDATE documentation_registry SET lifecycle='previous' WHERE feature_id=?`).run(featureId);
      this.database.prepare(`
        UPDATE feature_registry SET lifecycle='candidate', health='blocked_isolation_and_canary', activated_at=?
        WHERE feature_id=? AND feature_version=?
      `).run(now, featureId, targetVersion);
      this.database.prepare(`
        UPDATE documentation_registry SET lifecycle='candidate', activated_at=?
        WHERE feature_id=? AND feature_version=?
      `).run(now, featureId, targetVersion);
      this.database.prepare(`
        UPDATE feature_activation_heads
        SET feature_version=?, activation_generation=?, runtime_enabled=0, runtime_reason=?,
            package_path=?, package_digest=?, updated_at=?, documentation_path=?
        WHERE feature_id=?
      `).run(
        targetVersion,
        generation,
        `已回滚到 ${targetVersion}；当前缺少 Windows 强隔离认证和 Omnia 实机 canary，功能保持禁用。`,
        relativeInstalled,
        target.package_digest,
        now,
        target.physical_path,
        featureId
      );
      this.database.prepare(`
        INSERT INTO feature_activation_events(
          event_id, feature_id, from_version, to_version, event_type,
          activation_generation, package_digest, occurred_at
        ) VALUES(?, ?, ?, ?, 'rollback', ?, ?, ?)
      `).run(randomUUID(), featureId, current.featureVersion, targetVersion, generation, target.package_digest, now);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
    this.installedPackages.delete(featureId);
    return {
      attemptId: '',
      featureId,
      featureVersion: targetVersion,
      packageDigest: target.package_digest,
      documentationPath: target.physical_path,
      activationGeneration: generation,
      runtimeEnabled: false,
      runtimeReason: `已回滚到 ${targetVersion}；当前缺少 Windows 强隔离认证和 Omnia 实机 canary，功能保持禁用。`,
      idempotent: false
    };
  }

  private head(featureId: string): ActivationHead | null {
    const row = this.database.prepare(`
      SELECT feature_id, feature_version, activation_generation, runtime_enabled, runtime_reason,
             package_path, package_digest, documentation_path
      FROM feature_activation_heads WHERE feature_id=?
    `).get(featureId) as Record<string, unknown> | undefined;
    return row ? {
      featureId: String(row.feature_id),
      featureVersion: String(row.feature_version),
      activationGeneration: Number(row.activation_generation),
      runtimeEnabled: row.runtime_enabled === 1,
      runtimeReason: String(row.runtime_reason),
      packagePath: String(row.package_path),
      packageDigest: String(row.package_digest),
      documentationPath: String(row.documentation_path)
    } : null;
  }

  private loadInstalled(head: ActivationHead): InstalledFeaturePackage {
    const root = path.resolve(this.paths.data, ...head.packagePath.split('/'));
    const installedRoot = path.resolve(this.paths.data, 'packages', 'installed');
    if (!root.startsWith(`${installedRoot}${path.sep}`)) {
      throw new AppError('FEATURE.PACKAGE_PATH_INVALID', 'The Feature activation path escaped the immutable package root.');
    }
    const identity = `${root}\u0000${head.featureVersion}\u0000${head.packageDigest}`;
    const cached = this.installedPackages.get(head.featureId);
    if (cached?.identity === identity) return cached.value;
    const envelope = verifyOfficialPackage(
      JSON.parse(fs.readFileSync(path.join(root, '.official-package-envelope.json'), 'utf8')) as unknown,
      'omnia-feature'
    );
    if (packageDigest(envelope) !== head.packageDigest) {
      throw new AppError('FEATURE.PACKAGE_INTEGRITY', 'The active Feature package digest changed.');
    }
    const manifest = parseManifest(envelope);
    const surface = parseSurface(envelope, manifest);
    // New candidates pass the strict Feature-unique path policy in validate().
    // This installed-package path additionally admits the one historical,
    // officially signed shared pair so an old active head can participate in
    // rollback and Operation handoff without making that pair installable again.
    const runtimeContract = manifest.contractsPath && manifest.implementationMapPath && manifest.testsManifestPath
      ? validateFeatureBundleContracts(envelope, manifest, true)
      : null;
    const pythonSidecar = runtimeContract?.pythonSidecar || null;
    const value = { manifest, surface, envelope, root, pythonSidecar, runtimeContract };
    this.installedPackages.set(head.featureId, { identity, value });
    return value;
  }

  private loadInstalledOperation(installed: InstalledFeaturePackage): ValidatedOperationPackage {
    return validateOperationPackage(
      JSON.parse(fs.readFileSync(path.join(installed.root, installed.manifest.operationPackagePath), 'utf8')) as unknown,
      installed.manifest
    );
  }

  private pendingOperationHandoffCandidate(active: ActivationHead): ActivationHead | null {
    const ledger = activeOperationHandoff(this.database, active.featureId);
    if (!ledger || ['abort_pending', 'finalize_pending'].includes(ledger.phase)) return null;
    if (ledger.sourceFeatureVersion !== active.featureVersion
      || ledger.sourcePackageDigest !== active.packageDigest
      || ledger.sourceActivationGeneration !== active.activationGeneration) {
      throw new AppError(
        'FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH',
        'The durable Operation handoff source no longer matches the authoritative activation head.'
      );
    }
    const row = this.database.prepare(`
      SELECT f.feature_version,f.package_digest,d.physical_path
      FROM feature_registry f
      JOIN documentation_registry d
        ON d.feature_id=f.feature_id AND d.feature_version=f.feature_version
      WHERE f.feature_id=? AND f.feature_version=? AND f.package_digest=? AND f.lifecycle='candidate'
        AND d.lifecycle='candidate'
    `).get(active.featureId, ledger.targetFeatureVersion, ledger.targetPackageDigest) as {
      feature_version: string;
      package_digest: string;
      physical_path: string;
    } | undefined;
    if (!row) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_CANDIDATE_CAS_MISMATCH',
      'The durable Operation handoff target package or documentation candidate is unavailable.'
    );
    const packagePath = path.posix.join(
      'packages', 'installed', active.featureId, row.feature_version,
      row.package_digest.slice('sha256:'.length)
    );
    const candidate: ActivationHead = {
      featureId: active.featureId,
      featureVersion: row.feature_version,
      activationGeneration: ledger.targetActivationGeneration,
      runtimeEnabled: false,
      runtimeReason: `Operation resource-owner handoff from ${active.featureVersion} is pending.`,
      packagePath,
      packageDigest: row.package_digest,
      documentationPath: row.physical_path
    };
    const sourceOperation = this.loadInstalledOperation(this.loadInstalled(active));
    const targetOperation = this.loadInstalledOperation(this.loadInstalled(candidate));
    assertCompatibleOperationHandoff(sourceOperation, targetOperation);
    return candidate;
  }

  private pendingOperationHandoffFinalize(active: ActivationHead): OperationHandoffLedger | null {
    const ledger = activeOperationHandoff(this.database, active.featureId);
    if (!ledger || ledger.phase !== 'finalize_pending') return null;
    if (ledger.targetFeatureVersion !== active.featureVersion
      || ledger.targetPackageDigest !== active.packageDigest
      || ledger.targetActivationGeneration !== active.activationGeneration
      || !active.runtimeEnabled
      || !/^[0-9a-f]{64}$/u.test(ledger.registrationToken)) {
      throw new AppError(
        'FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH',
        'Finalize-pending Operation handoff no longer matches the authoritative target head.'
      );
    }
    return ledger;
  }

  private operationHandoffTarget(ledger: OperationHandoffLedger): ActivationHead {
    const row = this.database.prepare(`
      SELECT f.package_digest,d.physical_path
      FROM feature_registry f
      JOIN documentation_registry d ON d.feature_id=f.feature_id AND d.feature_version=f.feature_version
      WHERE f.feature_id=? AND f.feature_version=? AND f.package_digest=?
    `).get(
      ledger.featureId, ledger.targetFeatureVersion, ledger.targetPackageDigest
    ) as { package_digest: string; physical_path: string } | undefined;
    if (!row) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_CANDIDATE_CAS_MISMATCH',
      'The durable Operation handoff target package is unavailable for reconciliation.'
    );
    return {
      featureId: ledger.featureId,
      featureVersion: ledger.targetFeatureVersion,
      activationGeneration: ledger.targetActivationGeneration,
      runtimeEnabled: false,
      runtimeReason: '',
      packagePath: path.posix.join(
        'packages', 'installed', ledger.featureId, ledger.targetFeatureVersion,
        ledger.targetPackageDigest.slice('sha256:'.length)
      ),
      packageDigest: ledger.targetPackageDigest,
      documentationPath: row.physical_path
    };
  }

  private async reconcileAbortPendingOperationHandoff(
    active: ActivationHead,
    ledger: OperationHandoffLedger
  ): Promise<void> {
    if (!this.runtime || ledger.phase !== 'abort_pending'
      || ledger.sourceFeatureVersion !== active.featureVersion
      || ledger.sourcePackageDigest !== active.packageDigest
      || ledger.sourceActivationGeneration !== active.activationGeneration) throw new AppError(
        'FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH',
        'Abort-pending Operation handoff no longer matches its authoritative source head.'
      );
    const target = this.operationHandoffTarget(ledger);
    const operation = this.loadInstalledOperation(this.loadInstalled(target));
    if (operation.digest !== ledger.targetOperationPackageDigest) throw new AppError(
      'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH',
      'Abort-pending target Operation digest differs from its durable handoff ledger.'
    );
    await abortExactOperationHandoff(this.runtime.connector, {
      featureId: target.featureId,
      featureVersion: target.featureVersion,
      operationPackageDigest: ledger.targetOperationPackageDigest,
      registrationToken: ledger.registrationToken,
      operationManifest: operation.manifest,
      sourceOperationPackageDigest: ledger.sourceOperationPackageDigest
    });
    completeAbortedOperationHandoff(this.database, ledger, utcNow());
  }

  async initializeRuntime(): Promise<void> {
    if (!this.runtime) return;
    const deferredOperationHandoffs = new Set(
      String(process.env.OMNIA_AGENT_DEFER_FEATURE_HANDOFFS || '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(value))
    );
    for (const head of this.list()) {
      let target = head;
      let handoffSource: ActivationHead | null = null;
      try {
        const durable = activeOperationHandoff(this.database, head.featureId);
        if (durable?.phase === 'abort_pending') {
          try {
            await this.reconcileAbortPendingOperationHandoff(head, durable);
          } catch (abortError) {
            this.database.prepare(`UPDATE feature_operation_handoffs SET updated_at=?,last_error=?
              WHERE handoff_id=? AND phase='abort_pending'`).run(
                utcNow(), abortError instanceof Error ? abortError.message.slice(0, 1000) : 'Connector abort response is uncertain.',
                durable.handoffId
              );
          }
          await this.startRuntime(head);
          continue;
        }
        const pending = deferredOperationHandoffs.has(head.featureId)
          ? null
          : this.pendingOperationHandoffCandidate(head);
        if (pending) {
          target = pending;
          handoffSource = head;
        }
        await this.startRuntime(target, handoffSource);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Feature runtime startup failed.';
        const durable = activeOperationHandoff(this.database, head.featureId);
        if (handoffSource) {
          // The old activation head and Worker remain authoritative. Keep the
          // immutable candidate pending so a later Connector capability
          // upgrade can retry the same signed handoff without reinstalling.
          if (durable) this.database.prepare(`UPDATE feature_operation_handoffs SET updated_at=?,last_error=?
            WHERE handoff_id=? AND phase IN ('staged','prepared','committed','abort_pending','finalize_pending')`)
            .run(utcNow(), reason.slice(0, 1000), durable.handoffId);
          const currentHead = this.head(handoffSource.featureId);
          const oldHeadStillAuthoritative = currentHead?.featureVersion === handoffSource.featureVersion
            && currentHead.packageDigest === handoffSource.packageDigest;
          if (oldHeadStillAuthoritative && !this.supervisors.has(handoffSource.featureId)) {
            try {
              await this.startRuntime(handoffSource);
            } catch (fallbackError) {
              const fallbackReason = fallbackError instanceof Error
                ? fallbackError.message : 'Previous Feature runtime startup failed.';
              if (durable) this.database.prepare(`UPDATE feature_operation_handoffs SET updated_at=?,last_error=?
                WHERE handoff_id=? AND phase IN ('staged','prepared','committed','abort_pending','finalize_pending')`)
                .run(utcNow(), `${reason} Previous runtime recovery also failed: ${fallbackReason}`.slice(0, 1000), durable.handoffId);
              else this.database.prepare(`
                  UPDATE feature_activation_heads SET runtime_enabled=0,runtime_reason=?,updated_at=?
                  WHERE feature_id=? AND feature_version=? AND package_digest=?
                `).run(
                  `${reason} Previous runtime recovery also failed: ${fallbackReason}`,
                  utcNow(), handoffSource.featureId, handoffSource.featureVersion, handoffSource.packageDigest
                );
            }
          }
          continue;
        }
        if (this.supervisors.has(head.featureId)) continue;
        if (durable) {
          this.database.prepare(`UPDATE feature_operation_handoffs SET updated_at=?,last_error=?
            WHERE handoff_id=? AND phase IN ('staged','prepared','committed','abort_pending','finalize_pending')`)
            .run(utcNow(), reason.slice(0, 1000), durable.handoffId);
          continue;
        }
        this.database.prepare(`
          UPDATE feature_activation_heads SET runtime_enabled=0, runtime_reason=?, updated_at=? WHERE feature_id=?
        `).run(reason, utcNow(), head.featureId);
        this.database.prepare(`
          UPDATE feature_registry SET health='worker_start_failed'
          WHERE feature_id=? AND feature_version=? AND package_digest=?
        `).run(head.featureId, head.featureVersion, head.packageDigest);
      }
    }
  }

  async disposeRuntime(): Promise<void> {
    await Promise.allSettled([...this.supervisors.values()].map((supervisor) => supervisor.stop()));
    this.supervisors.clear();
    this.operationRegistrations.clear();
  }

  takePendingRuntimeEvents(): string[] {
    const values = [...this.pendingRuntimeEvents];
    this.pendingRuntimeEvents.clear();
    return values;
  }

  completeRuntimeEvents(eventIds: string[], error = ''): void {
    const status = error ? 'failed' : 'completed';
    for (const eventId of eventIds) {
      this.database.prepare(`
        UPDATE feature_runtime_events SET status=?, completed_at=?, error=? WHERE event_id=? AND status='pending'
      `).run(status, utcNow(), error, eventId);
    }
  }

  /**
   * Projects receipt-backed Return progress while the owning Worker mutation is
   * still running. This is intentionally a disposable Surface: changing the
   * authoritative runtime Surface (or its optimistic stateVersion) here would
   * race the final Worker result. The read occurs in the same port call and
   * never invokes the Worker a second time.
   */
  private publishLiveReturnProgress(
    featureId: string,
    featureVersion: string,
    runId: string,
    context: FeatureWorkerPortContext
  ): void {
    const publish = this.runtime?.publishSurfaceProjection;
    const head = this.head(featureId);
    const surface = this.runtimeSurfaces.get(featureId);
    if (!publish || !head || head.featureVersion !== featureVersion || !surface?.progress
      || surface.workflow?.currentStepId !== 'return') return;
    try {
      const rows = this.runtimeStore.call('loadReturnProgress', { runId }, {
        ...context,
        allowMutation: false
      }) as ReturnProgressRow[];
      const signatureKey = `${featureId}\u0000${featureVersion}\u0000${runId}`;
      const cached = this.liveReturnProgressSnapshots.get(signatureKey);
      const progress = buildLiveReturnProgress(
        surface.progress,
        rows,
        cached?.stateVersion === surface.stateVersion ? cached.progress : undefined
      );
      if (!progress) return;
      const signature = JSON.stringify(progress);
      if (cached?.stateVersion === surface.stateVersion && cached.signature === signature) return;
      const { manifest } = this.loadInstalled(head);
      const projection = validateSurface({ ...surface, progress }, manifest);
      this.liveReturnProgressSnapshots.set(signatureKey, { stateVersion: surface.stateVersion, signature, progress });
      publish(projection);
    } catch {
      // A disposable projection can never fail or alter the owning mutation.
      // The final Worker result remains the authoritative Surface transition.
    }
  }

  private async startRuntime(head: ActivationHead, handoffSource: ActivationHead | null = null): Promise<void> {
    if (!this.runtime) throw new Error('Feature runtime dependencies are unavailable.');
    const installed = this.loadInstalled(head);
    const managedRuntime = resolveManagedPythonRuntime(this.paths, installed);
    if (installed.manifest.requiredIsolation !== 'process') {
      throw new Error('This legacy Feature package has no process runtime contract.');
    }
    const operationPackage = JSON.parse(
      fs.readFileSync(path.join(installed.root, installed.manifest.operationPackagePath), 'utf8')
    ) as unknown;
    const validatedOperationPackage = validateOperationPackage(operationPackage, installed.manifest);
    const operationPackageDigest = validatedOperationPackage.digest;
    const operationManifest = validatedOperationPackage.manifest;
    const operationEffects = new Map(operationManifest.operations.map((operation) => [operation.operationId, operation.effect]));
    const supervisor = new FeatureWorkerSupervisor(
      this.runtime.workerHostEntrypoint,
      path.join(installed.root, installed.manifest.workerPath),
      head.featureId,
      head.featureVersion,
      {
        connectorInvoke: async (input, context) => {
          await this.flushConnectorDeliveryAcks();
          const invocation = input as Record<string, any>;
          if (
            invocation?.schemaVersion !== 'omnia.operation-invocation/v1'
            || invocation.featureId !== context.featureId
            || invocation.featureVersion !== context.featureVersion
          ) throw new AppError('FEATURE.OPERATION_IDENTITY_MISMATCH', 'Feature Operation identity is invalid.');
          const sessionGeneration = Number(invocation.request?.connectorBinding?.sessionGeneration || 0);
          if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 1) {
            throw new AppError('FEATURE.OPERATION_BINDING_MISSING', 'Remote Operation requires a frozen session generation.');
          }
          const registrationKey = `${context.featureId}|${context.featureVersion}|${operationPackageDigest}`;
          const cachedRegistration = this.operationRegistrations.get(registrationKey);
          if (!cachedRegistration || cachedRegistration.sessionGeneration !== sessionGeneration) {
            let registration = await this.runtime!.connector.registerOperation({
              schemaVersion: 'omnia.operation-registration/v1',
              featureId: context.featureId,
              featureVersion: context.featureVersion,
              operationPackage
            });
            if (
              registration.schemaVersion !== 'omnia.operation-registration-result/v1'
              || registration.featureId !== context.featureId
              || registration.featureVersion !== context.featureVersion
              || registration.packageId !== operationManifest.packageId
              || registration.packageDigest !== operationPackageDigest
              || !Array.isArray(registration.operationIds)
              || canonicalJson([...registration.operationIds].sort())
                !== canonicalJson(operationManifest.operations.map((operation) => operation.operationId).sort())
              || !/^[0-9a-f]{64}$/u.test(registration.registrationToken)
              || !Array.isArray(registration.replacedPackageDigests)
              || canonicalJson([...new Set(registration.replacedPackageDigests)].sort())
                !== canonicalJson(registration.replacedPackageDigests)
            ) {
              throw new AppError('FEATURE.OPERATION_REGISTRATION_DRIFT', 'Remote Connector registered another Operation package digest.');
            }
            if (registration.registrationState === 'prepared') {
              const registrationToken = registration.registrationToken;
              registration = await this.runtime!.connector.registerOperation({
                schemaVersion: 'omnia.operation-registration-commit/v1',
                featureId: context.featureId,
                featureVersion: context.featureVersion,
                operationPackageDigest,
                registrationToken
              });
              if (
                registration.schemaVersion !== 'omnia.operation-registration-result/v1'
                || registration.featureId !== context.featureId
                || registration.featureVersion !== context.featureVersion
                || registration.packageId !== operationManifest.packageId
                || registration.packageDigest !== operationPackageDigest
                || registration.registrationState !== 'committed'
                || registration.registrationToken !== registrationToken
                || !Array.isArray(registration.replacedPackageDigests)
                || canonicalJson([...new Set(registration.replacedPackageDigests)].sort())
                  !== canonicalJson(registration.replacedPackageDigests)
                || !Array.isArray(registration.operationIds)
                || canonicalJson([...registration.operationIds].sort())
                  !== canonicalJson(operationManifest.operations.map((operation) => operation.operationId).sort())
              ) throw new AppError(
                'FEATURE.OPERATION_REGISTRATION_COMMIT_DRIFT',
                'Remote Connector committed another Operation registration identity.'
              );
            } else if (registration.registrationState !== 'committed') {
              throw new AppError(
                'FEATURE.OPERATION_REGISTRATION_PROTOCOL_UNAVAILABLE',
                'The Connector does not support two-phase signed Operation registration.'
              );
            }
            if (registration.replacedPackageDigests.length > 0) {
              const ledger = operationHandoffByToken(
                this.database, context.featureId, registration.registrationToken
              );
              const exactHandoff = ledger
                && ['finalize_pending', 'finalized'].includes(ledger.phase)
                && ledger.targetFeatureVersion === context.featureVersion
                && ledger.targetOperationPackageDigest === operationPackageDigest
                && canonicalJson(ledger.replacedPackageDigests)
                  === canonicalJson(registration.replacedPackageDigests);
              if (exactHandoff) {
                try {
                  if (ledger.phase === 'finalize_pending') {
                    await finalizeExactOperationHandoff(this.runtime!.connector, {
                      featureId: context.featureId,
                      featureVersion: context.featureVersion,
                      operationPackageDigest,
                      registrationToken: registration.registrationToken,
                      operationManifest,
                      replacedPackageDigests: ledger.replacedPackageDigests
                    });
                    completeFinalizedOperationHandoff(this.database, ledger, utcNow());
                  }
                } catch {
                  // Core already names this exact digest as active and commit keeps
                  // both registrations callable. Cleanup is retried without
                  // blocking the user's signed invocation.
                }
              } else {
                const activeHead = this.head(context.featureId);
                if (!activeHead
                  || activeHead.featureVersion !== context.featureVersion
                  || !activeHead.runtimeEnabled) {
                  throw new AppError(
                    'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH',
                    'A replacement Operation registration is not owned by the exact active Feature head.'
                  );
                }
                await finalizeExactBaselineOperationAdoption(this.database, this.runtime!.connector, {
                  featureId: context.featureId,
                  featureVersion: context.featureVersion,
                  packageDigest: activeHead.packageDigest,
                  activationGeneration: activeHead.activationGeneration,
                  operationPackageDigest,
                  registrationToken: registration.registrationToken,
                  operationManifest,
                  replacedPackageDigests: registration.replacedPackageDigests
                });
              }
            }
            this.operationRegistrations.set(registrationKey, { sessionGeneration, packageDigest: operationPackageDigest });
          }
          let durableMutationDispatchAttempted = false;
          try {
            const operationId = String(invocation.operationId || '');
            const receiptContext = invocation.request?.receiptContext as Record<string, unknown> | undefined;
            const recoveryContext = invocation.request?.recoveryContext as Record<string, unknown> | undefined;
            if (receiptContext !== undefined && recoveryContext !== undefined) {
              throw new AppError('FEATURE.RECOVERY_RECEIPT_CONTEXT_INVALID', 'Normal and cross-generation recovery receipt contexts are mutually exclusive.');
            }
            const operationRequest = { ...(invocation.request as Record<string, unknown>) };
            delete operationRequest.receiptContext;
            delete operationRequest.recoveryContext;
            const signedCommand = operationRequest.command as Record<string, any> | undefined;
            const mutationTarget = operationRequest.target as Record<string, any> | undefined;
            const mutationBinding = operationRequest.connectorBinding as Record<string, any> | undefined;
            const declaresDurableMutationProtocol = operationEffects.get(operationId) === 'omnia_mutation'
              && Boolean(signedCommand && mutationTarget && mutationBinding && String(operationRequest.planDigest || ''));
            let mutationCommandRow: Record<string, any> | null = null;
            if (declaresDurableMutationProtocol) {
              if (this.runtime!.connector.supportsDurableDelivery?.() !== true) {
                throw new AppError(
                  'REMOTE.DURABLE_DELIVERY_CAPABILITY_REQUIRED',
                  'The authenticated Remote Connector is below the durable delivery baseline; mutation admission remains closed.'
                );
              }
              const candidateCommandRow = this.database.prepare(`
                SELECT c.run_id,c.operation_id,c.idempotency_key,c.plan_digest,c.request_digest,c.state,c.evidence_target_identity_key,
                  c.connector_request_id,c.connector_execution_generation,c.connector_session_generation,
                  f.credential_digest,f.authority_instance_id,f.tenant_or_org_id,f.pack_id,f.engagement_id,
                  s.workspace_ids_json,s.global_enabled,s.global_workspace_ids_json,i.intended_revision_json,
                  EXISTS(SELECT 1 FROM feature_mutation_reservations mr WHERE mr.owner_command_id=c.command_id AND mr.lifecycle='active') AS owns_reservation
                FROM feature_commands c
                JOIN feature_runs r ON r.run_id=c.run_id
                JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id
                JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
                JOIN workspace_safety s ON s.singleton=1
                WHERE c.command_id=? AND r.feature_id=?
                ORDER BY f.created_at DESC LIMIT 1
              `).get(String(signedCommand?.commandId || ''),context.featureId) as Record<string,any>|undefined;
              const commandRow = candidateCommandRow
                && this.currentActivationOwnsRun(String(candidateCommandRow.run_id), context.featureId, context.featureVersion)
                ? candidateCommandRow : undefined;
              mutationCommandRow = commandRow || null;
              const workspaceIds=commandRow?JSON.parse(String(commandRow.workspace_ids_json)) as string[]:[];
              const allowedWorkspaceIds=commandRow?[...new Set([...workspaceIds,...(Number(commandRow.global_enabled)===1?JSON.parse(String(commandRow.global_workspace_ids_json)) as string[]:[])])]:[];
              const authorityDigest=mutationBinding?crypto.createHash('sha256').update(canonicalJson({
                connectorId:mutationBinding.connectorId,sessionGeneration:Number(mutationBinding.sessionGeneration),engagementId:mutationBinding.engagementId,
                authorityInstanceId:mutationBinding.authorityInstanceId,tenantOrOrgId:mutationBinding.tenantOrOrgId,packId:mutationBinding.packId,workspaceIds
              })).digest('hex'):'';
              const commandIntent=commandRow?JSON.parse(String(commandRow.intended_revision_json)) as Record<string,unknown>:{};
              const reservationRequired=String(commandIntent.kind)==='object'&&String(commandIntent.disposition)==='create';
              if(!commandRow||commandRow.state!=='submitted'||operationId!==String(commandRow.operation_id)
                ||String(signedCommand?.idempotencyKey||'')!==String(commandRow.idempotency_key)
                ||String(operationRequest.planDigest||'')!==String(commandRow.plan_digest)
                ||crypto.createHash('sha256').update(canonicalJson(signedCommand?.payload)).digest('hex')!==String(commandRow.request_digest)
                ||String(mutationTarget?.targetIdentityKey||'')!==String(commandRow.evidence_target_identity_key)
                ||!allowedWorkspaceIds.includes(String(mutationTarget?.workspaceId||''))||authorityDigest!==String(commandRow.credential_digest)
                ||String(mutationBinding?.authorityInstanceId||'')!==String(commandRow.authority_instance_id)
                ||String(mutationBinding?.tenantOrOrgId||'')!==String(commandRow.tenant_or_org_id)
                ||String(mutationBinding?.packId||'')!==String(commandRow.pack_id)
                ||String(mutationBinding?.engagementId||'')!==String(commandRow.engagement_id)
                ||(reservationRequired&&Number(commandRow.owns_reservation)!==1)) {
                throw new AppError('FEATURE.MUTATION_COMMAND_DRIFT','Signed mutation differs from the immutable confirmed command, target, plan, payload, or authority.');
              }
            }
            let recoveryRow: Record<string, any> | null = null;
            let recoveryWorkspaceId = '';
            let recoveryTargetIdentityKey = '';
            let recoveryRequestDigest = '';
            if (recoveryContext !== undefined) {
              if (recoveryContext.schemaVersion!=='omnia.feature-return-recovery-receipt-context/v1'
                || operationEffects.get(operationId)!=='read_only' || operationRequest.command!==undefined || operationRequest.planDigest!==undefined) {
                throw new AppError('FEATURE.RECOVERY_RECEIPT_CONTEXT_INVALID', 'Cross-generation recovery permits only an exact signed read-only Operation.');
              }
              const authorizationId=String(recoveryContext.authorizationId||'');
              const recoveryRunId=String(recoveryContext.runId||'');
              const recoveryCommandId=String(recoveryContext.commandId||'');
              recoveryRow=this.database.prepare(`
                SELECT a.*,t.evidence_operation_ids_json,t.target_identity_key,t.reconcile_spec_json,
                  r.state AS run_state,r.state_revision AS run_state_revision,r.feature_version AS run_feature_version,
                  s.enabled,s.connector_id AS safety_connector_id,s.session_generation AS safety_session_generation,
                  s.authority_instance_id AS safety_authority_instance_id,s.tenant_or_org_id AS safety_tenant_or_org_id,
                  s.pack_id AS safety_pack_id,s.engagement_id AS safety_engagement_id,
                  s.workspace_ids_json AS safety_workspace_ids_json,s.state_version AS safety_state_version,
                  EXISTS(SELECT 1 FROM feature_return_recovery_outcomes o WHERE o.authorization_id=a.authorization_id AND o.command_id=t.command_id) AS has_outcome,
                  EXISTS(SELECT 1 FROM feature_return_partial_closures p WHERE p.authorization_id=a.authorization_id) AS has_closure
                FROM feature_return_recovery_authorizations a
                JOIN feature_return_recovery_targets t ON t.authorization_id=a.authorization_id AND t.run_id=a.run_id
                JOIN feature_runs r ON r.run_id=a.run_id
                JOIN workspace_safety s ON s.singleton=1
                WHERE a.authorization_id=? AND a.run_id=? AND t.command_id=? AND a.feature_id=? AND a.successor_feature_version=?
              `).get(authorizationId,recoveryRunId,recoveryCommandId,context.featureId,context.featureVersion) as Record<string,any>|undefined || null;
              const binding=operationRequest.connectorBinding as Record<string,unknown>|undefined;
              const target=operationRequest.target as Record<string,unknown>|undefined;
              if(!recoveryRow||!binding||!target||Date.parse(String(recoveryRow.expires_at))<=Date.now()
                ||String(recoveryRow.run_state)!=='returning'||Number(recoveryRow.run_state_revision)!==Number(recoveryRow.expected_run_revision)
                ||String(recoveryRow.run_feature_version)!==String(recoveryRow.source_feature_version)
                ||Number(recoveryRow.has_outcome)!==0||Number(recoveryRow.has_closure)!==0
                ||Number(recoveryRow.enabled)!==1||Number(recoveryRow.safety_state_version)!==Number(recoveryRow.safety_revision)
                ||String(binding.connectorId||'')!==String(recoveryRow.connector_id)||Number(binding.sessionGeneration)!==Number(recoveryRow.to_session_generation)
                ||String(binding.authorityInstanceId||'')!==String(recoveryRow.authority_instance_id)
                ||String(binding.tenantOrOrgId||'')!==String(recoveryRow.tenant_or_org_id)||String(binding.packId||'')!==String(recoveryRow.pack_id)
                ||String(binding.engagementId||'')!==String(recoveryRow.engagement_id)
                ||String(recoveryRow.safety_connector_id)!==String(recoveryRow.connector_id)
                ||Number(recoveryRow.safety_session_generation)!==Number(recoveryRow.to_session_generation)
                ||String(recoveryRow.safety_authority_instance_id)!==String(recoveryRow.authority_instance_id)
                ||String(recoveryRow.safety_tenant_or_org_id)!==String(recoveryRow.tenant_or_org_id)
                ||String(recoveryRow.safety_pack_id)!==String(recoveryRow.pack_id)||String(recoveryRow.safety_engagement_id)!==String(recoveryRow.engagement_id)
                ||canonicalJson(JSON.parse(String(recoveryRow.safety_workspace_ids_json)))!==canonicalJson(JSON.parse(String(recoveryRow.workspace_ids_json)))) {
                throw new AppError('FEATURE.RECOVERY_RECEIPT_AUTHORITY_DRIFT', 'Recovery authorization, source Run, connector authority, or current safety lock drifted.');
              }
              recoveryWorkspaceId=String(target.workspaceId||'');
              recoveryTargetIdentityKey=String(target.targetIdentityKey||'');
              const allowedWorkspaces=JSON.parse(String(recoveryRow.workspace_ids_json)) as string[];
              const evidenceOperations=JSON.parse(String(recoveryRow.evidence_operation_ids_json)) as string[];
              const spec=JSON.parse(String(recoveryRow.reconcile_spec_json)) as Record<string,unknown>;
              let expectedRequest:unknown=null;
              if(operationId===String(spec.reconcileOperation||''))expectedRequest=spec.reconcileRequest;
              else if(operationId===String(spec.preflightOperation||''))expectedRequest=spec.preflightRequest;
              else if(spec.readRequest!==null&&spec.readRequest!==undefined&&operationId===String(spec.readOperation||''))expectedRequest=spec.readRequest;
              else if(operationId===String(spec.readOperation||'')){
                const prior=this.database.prepare(`SELECT response_json FROM feature_return_recovery_receipts WHERE authorization_id=? AND run_id=? AND command_id=? AND operation_id=? ORDER BY created_at,receipt_id`)
                  .all(authorizationId,recoveryRunId,recoveryCommandId,String(spec.preflightOperation||'')) as Array<{response_json:string}>;
                const conclusive=prior.map((row)=>JSON.parse(row.response_json) as Record<string,any>).filter((value)=>value.found===true&&value.item&&typeof value.item==='object'&&!Array.isArray(value.item)&&Number(value.evidence?.directoryMatches)===1);
                const ids=[...new Set(conclusive.map((value)=>String(value.item.id||value.item.riskAssessmentId||value.evidence?.assessmentId||'').toLowerCase()).filter((value)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)))];
                const preflight=spec.preflightRequest as Record<string,any>;const mutation=spec.mutationPayload as Record<string,any>;
                if(conclusive.length<1||ids.length!==1)throw new AppError('FEATURE.RECOVERY_RECEIPT_PREREQUISITE_INVALID','Recovery read-back requires one exact prior preflight identity.');
                expectedRequest={target:preflight.target,riskAssessmentId:ids[0],query:{entityId:preflight.query?.entityId,name:preflight.query?.name,itElementType:preflight.query?.itElementType,inkContentId:mutation?.inkContentId,typeId:mutation?.typeId}};
              }
              const frozenRequest={...(expectedRequest as Record<string,unknown>||{}),connectorBinding:binding};
              if(!expectedRequest||!evidenceOperations.includes(operationId)||!allowedWorkspaces.includes(recoveryWorkspaceId)
                ||recoveryTargetIdentityKey!==String(recoveryRow.target_identity_key)
                ||canonicalJson(operationRequest)!==canonicalJson(frozenRequest)) {
                throw new AppError('FEATURE.RECOVERY_RECEIPT_REQUEST_DRIFT', 'Recovery Operation differs from the frozen read-only evidence request, target, or workspace.');
              }
              recoveryRequestDigest=crypto.createHash('sha256').update(canonicalJson(operationRequest)).digest('hex');
            }
            const deliveryBinding = operationRequest.connectorBinding as Record<string, unknown> | undefined;
            const deliveryRunId = declaresDurableMutationProtocol ? String(mutationCommandRow?.run_id || '')
              : String(receiptContext?.runId || recoveryContext?.runId || '');
            const deliveryCommandId = declaresDurableMutationProtocol ? String(signedCommand?.commandId || '')
              : String(receiptContext?.commandId || recoveryContext?.commandId || '');
            const needsDurableDelivery = declaresDurableMutationProtocol || receiptContext !== undefined || recoveryContext !== undefined;
            let deliveryRequestId = '';
            let deliveryAlreadyPrepared = false;
            let abandonReadOnlyRequestId = '';
            let recoveredDelivery: import('../connector/connector-transport.js').ConnectorInvocationDelivery | null = null;
            let deliveryPurpose: 'mutation' | 'readback' | 'reconcile' | 'recovery' = declaresDurableMutationProtocol
              ? 'mutation' : recoveryContext !== undefined ? 'recovery' : 'readback';
            let reconcileOf: import('../../shared/operation-contracts.js').OperationInvocationRequest['reconcileOf'];
            if (needsDurableDelivery) {
              if (!deliveryBinding || !deliveryRunId || !deliveryCommandId) {
                throw new AppError('FEATURE.DELIVERY_IDENTITY_INVALID', 'Durable Connector delivery is missing its verified binding, Run, or command identity.');
              }
              if (!this.runtime!.connector.invokeOperationWithWitness) {
                throw new AppError('REMOTE.DELIVERY_CONTRACT_UNAVAILABLE', 'Remote Connector does not support durable Operation delivery witnesses.');
              }
              const recoverExisting = async (existing: Record<string, unknown>) => {
                if (!this.runtime!.connector.deliveryStatus) throw new AppError(
                  'REMOTE.DELIVERY_STATUS_UNAVAILABLE', 'Connector cannot recover the prior durable Operation response.'
                );
                const recovered = await this.runtime!.connector.deliveryStatus({
                  schemaVersion: 'omnia.connector-delivery-status-request/v1',
                  requestId: String(existing.request_id), featureId: String(existing.feature_id),
                  featureVersion: String(existing.feature_version), operationId: String(existing.operation_id),
                  operationPackageDigest: String(existing.operation_package_digest), runId: String(existing.run_id),
                  commandId: String(existing.command_id), connectorId: String(existing.connector_id),
                  sessionGeneration: Number(existing.session_generation)
                });
                if (recovered.state === 'not_found') {
                  if (String(existing.purpose) === 'mutation') {
                    const uncertainAt = utcNow();
                    this.database.exec('BEGIN IMMEDIATE;');
                    try {
                      const changed = this.database.prepare(`
                        UPDATE feature_commands SET state='uncertain',last_error=?,completed_at=?
                        WHERE run_id=? AND command_id=? AND connector_request_id=?
                          AND state IN ('submitted','committed','verifying','uncertain')
                      `).run(
                        'Connector durable mutation journal is absent; automatic replay is forbidden.',
                        uncertainAt,
                        String(existing.run_id),
                        String(existing.command_id),
                        String(existing.request_id)
                      );
                      if (Number(changed.changes) !== 1) {
                        throw new AppError(
                          'REMOTE.MUTATION_DELIVERY_IDENTITY_INVALID',
                          'Missing mutation delivery is not bound to one exact durable command.'
                        );
                      }
                      this.database.exec('COMMIT;');
                    } catch (error) {
                      this.database.exec('ROLLBACK;');
                      throw error;
                    }
                    throw new AppError('REMOTE.MUTATION_UNCERTAIN', 'Mutation delivery journal is absent from Connector durable state; replay is forbidden.');
                  }
                  abandonReadOnlyRequestId = String(existing.request_id);
                  return false;
                }
                if (!recovered.responseJson || !recovered.resultDigest) throw new AppError(
                  'REMOTE.MUTATION_UNCERTAIN', 'Prior Connector effect has no recoverable delivered response; exact read-only reconcile is required.'
                );
                const wireResponse = JSON.parse(recovered.responseJson) as Record<string, any>;
                if (wireResponse.id !== recovered.requestId || connectorResultDigest(wireResponse) !== recovered.resultDigest) {
                  throw new AppError('REMOTE.DELIVERY_RECOVERY_INVALID', 'Recovered Connector response differs from its durable wire digest.');
                }
                recoveredDelivery = {
                  ok: wireResponse.ok === true,
                  value: wireResponse.value,
                  ...(wireResponse.ok === false && wireResponse.error ? { error: wireResponse.error } : {}),
                  wireResponse,
                  witness: {
                    schemaVersion: 'omnia.connector-delivery-witness/v1', requestId: recovered.requestId,
                    resultDigest: recovered.resultDigest, sessionGeneration: recovered.sessionGeneration,
                    executionGeneration: recovered.executionGeneration
                  }
                };
                deliveryRequestId = recovered.requestId;
                deliveryAlreadyPrepared = true;
                return true;
              };
              if (declaresDurableMutationProtocol) {
                const existingRequestId = String(mutationCommandRow?.connector_request_id || '');
                if (existingRequestId) {
                  const existing = this.database.prepare(`SELECT * FROM connector_delivery_requests WHERE request_id=?`)
                    .get(existingRequestId) as Record<string, unknown> | undefined;
                  if (!existing) throw new AppError('REMOTE.MUTATION_UNCERTAIN', 'Mutation delivery journal is missing and cannot be replayed.');
                  await recoverExisting(existing);
                } else {
                  deliveryRequestId = randomUUID();
                }
              } else {
                const existing = this.database.prepare(`
                  SELECT * FROM connector_delivery_requests
                  WHERE run_id=? AND command_id=? AND feature_id=? AND feature_version=? AND operation_id=?
                    AND state IN ('prepared','witnessed')
                    AND abandoned_at=''
                  ORDER BY created_at,request_id LIMIT 1
                `).get(deliveryRunId,deliveryCommandId,context.featureId,context.featureVersion,operationId) as Record<string,unknown>|undefined;
                if(existing){
                  const recovered=await recoverExisting(existing);
                  if(!recovered)deliveryRequestId=randomUUID();
                }else deliveryRequestId = randomUUID();
                const source = this.database.prepare(`
                  SELECT c.connector_request_id,c.connector_execution_generation,c.connector_session_generation,
                    c.connector_id,c.connector_operation_package_digest,c.connector_feature_version,c.operation_id,
                    r.feature_id
                  FROM feature_commands c JOIN feature_runs r ON r.run_id=c.run_id
                  WHERE c.run_id=? AND c.command_id=?
                `).get(deliveryRunId, deliveryCommandId) as Record<string, unknown> | undefined;
                if (source?.connector_request_id) {
                  let sourceExecutionGeneration = String(source.connector_execution_generation || '');
                  if (!sourceExecutionGeneration) {
                    if (!this.runtime!.connector.deliveryStatus) {
                      throw new AppError('REMOTE.DELIVERY_STATUS_UNAVAILABLE', 'Connector cannot recover the original mutation execution generation.');
                    }
                    const deliveryStatus = await this.runtime!.connector.deliveryStatus({
                      schemaVersion: 'omnia.connector-delivery-status-request/v1',
                      requestId: String(source.connector_request_id),
                      featureId: String(source.feature_id),
                      featureVersion: String(source.connector_feature_version),
                      operationId: String(source.operation_id),
                      operationPackageDigest: String(source.connector_operation_package_digest),
                      runId: deliveryRunId,
                      commandId: deliveryCommandId,
                      connectorId: String(source.connector_id),
                      sessionGeneration: Number(source.connector_session_generation)
                    });
                    sourceExecutionGeneration = deliveryStatus.executionGeneration;
                    this.database.prepare(`UPDATE feature_commands SET connector_execution_generation=? WHERE run_id=? AND command_id=? AND connector_execution_generation=''`)
                      .run(sourceExecutionGeneration, deliveryRunId, deliveryCommandId);
                  }
                  deliveryPurpose = recoveryContext !== undefined ? 'recovery' : 'reconcile';
                  reconcileOf = {
                    requestId: String(source.connector_request_id),
                    featureId: String(source.feature_id),
                    featureVersion: String(source.connector_feature_version),
                    runId: deliveryRunId,
                    commandId: deliveryCommandId,
                    operationId: String(source.operation_id),
                    operationPackageDigest: String(source.connector_operation_package_digest),
                    connectorId: String(source.connector_id),
                    sessionGeneration: Number(source.connector_session_generation),
                    executionGeneration: sourceExecutionGeneration
                  };
                }
              }
              const now = utcNow();
              if (!deliveryAlreadyPrepared) this.database.exec('BEGIN IMMEDIATE;');
              try {
                if (!deliveryAlreadyPrepared && abandonReadOnlyRequestId) {
                  const abandonedAt = utcNow();
                  const abandoned = this.database.prepare(`
                    UPDATE connector_delivery_requests SET abandoned_at=?,updated_at=?
                    WHERE request_id=? AND state IN ('prepared','witnessed') AND purpose<>'mutation'
                      AND abandoned_at=''
                  `).run(abandonedAt, abandonedAt, abandonReadOnlyRequestId);
                  if (Number(abandoned.changes) !== 1) {
                    throw new AppError('REMOTE.DELIVERY_RECOVERY_CAS_FAILED', 'Read-only delivery recovery changed concurrently.');
                  }
                }
                if (!deliveryAlreadyPrepared && declaresDurableMutationProtocol) {
                  const changed = this.database.prepare(`
                    UPDATE feature_commands SET connector_request_id=?,connector_session_generation=?,connector_id=?,
                      connector_operation_package_digest=?,connector_feature_version=?
                    WHERE run_id=? AND command_id=? AND connector_request_id=''
                  `).run(deliveryRequestId, Number(deliveryBinding.sessionGeneration), String(deliveryBinding.connectorId),
                    operationPackageDigest, context.featureVersion, deliveryRunId, deliveryCommandId);
                  if (Number(changed.changes) !== 1) throw new AppError('REMOTE.MUTATION_UNCERTAIN', 'Mutation delivery identity was already allocated.');
                }
                if (!deliveryAlreadyPrepared) this.database.prepare(`
                  INSERT INTO connector_delivery_requests(
                    request_id,feature_id,feature_version,operation_id,operation_package_digest,run_id,command_id,
                    connector_id,session_generation,purpose,state,wire_result_digest,execution_generation,created_at,updated_at
                  ) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared','','',?,?)
                `).run(deliveryRequestId, context.featureId, context.featureVersion, operationId, operationPackageDigest,
                  deliveryRunId, deliveryCommandId, String(deliveryBinding.connectorId), Number(deliveryBinding.sessionGeneration),
                  deliveryPurpose, now, now);
                if (!deliveryAlreadyPrepared) this.database.exec('COMMIT;');
              } catch (error) {
                if (!deliveryAlreadyPrepared) this.database.exec('ROLLBACK;');
                throw error;
              }
            }
            const invocationInput: import('../../shared/operation-contracts.js').OperationInvocationRequest = {
              schemaVersion: 'omnia.operation-invocation/v1',
              featureId: context.featureId,
              featureVersion: context.featureVersion,
              operationId,
              request: operationRequest,
              operationPackageDigest,
              mutationAuthorized: operationEffects.get(operationId) === 'omnia_mutation' && context.allowMutation,
              ...(needsDurableDelivery ? { deliveryContext: {
                schemaVersion: 'omnia.connector-delivery-context/v1',
                requestId: deliveryRequestId,
                featureId: context.featureId,
                featureVersion: context.featureVersion,
                operationId,
                operationPackageDigest,
                runId: deliveryRunId,
                commandId: deliveryCommandId,
                connectorId: String(deliveryBinding!.connectorId),
                sessionGeneration: Number(deliveryBinding!.sessionGeneration),
                purpose: deliveryPurpose
              } } : {}),
              ...(reconcileOf ? { reconcileOf } : {})
            };
            let deliveryWitness: import('../../shared/connector-delivery.js').ConnectorDeliveryWitness | null = null;
            const invokeRemote = async () => {
              if (!needsDurableDelivery) return this.runtime!.connector.invokeOperation(invocationInput);
              if (declaresDurableMutationProtocol) durableMutationDispatchAttempted = true;
              const delivered = recoveredDelivery ?? await this.runtime!.connector.invokeOperationWithWitness!(invocationInput);
              if (delivered.witness.requestId !== deliveryRequestId
                || delivered.witness.sessionGeneration !== Number(deliveryBinding!.sessionGeneration)) {
                throw new AppError('REMOTE.DELIVERY_WITNESS_INVALID', 'Connector delivery witness differs from the durable request identity.');
              }
              this.database.prepare(`
                UPDATE connector_delivery_requests SET state='witnessed',wire_result_digest=?,execution_generation=?,updated_at=?
                WHERE request_id=? AND state IN ('prepared','witnessed')
              `).run(delivered.witness.resultDigest, delivered.witness.executionGeneration, utcNow(), deliveryRequestId);
              if (declaresDurableMutationProtocol) {
                this.database.prepare(`UPDATE feature_commands SET connector_execution_generation=? WHERE run_id=? AND command_id=? AND connector_request_id=?`)
                  .run(delivered.witness.executionGeneration, deliveryRunId, deliveryCommandId, deliveryRequestId);
              }
              deliveryWitness = delivered.witness;
              if (!delivered.ok) {
                if(delivered.error?.code==='CONNECTOR_NEXT.MUTATION_NOT_STARTED'
                  &&declaresDurableMutationProtocol&&deliveryBinding){
                  await this.closeConnectorNextMutationNotStarted({
                    requestId:deliveryRequestId,runId:deliveryRunId,commandId:deliveryCommandId,
                    featureId:context.featureId,featureVersion:context.featureVersion,operationId,operationPackageDigest,
                    connectorId:String(deliveryBinding.connectorId),sessionGeneration:Number(deliveryBinding.sessionGeneration),
                    witness:delivered.witness,message:delivered.error.message||'Connector Next proved the mutation did not start.'
                  });
                  return {__connectorMutationNotStarted:true,requestId:deliveryRequestId};
                }
                throw new AppError(
                  delivered.error?.code || 'REMOTE.CONNECTOR_ERROR',
                  delivered.error?.message || 'Remote Connector Operation failed.',
                  delivered.error?.retryable === true
                );
              }
              return delivered.value;
            };
            const semanticStage = operationId.includes('.preflight.') ? 'preflight'
              : operationId.includes('.reconcile.') ? 'reconcile'
                : operationId.includes('.readback.') || operationId.includes('.read.') ? 'readback'
                  : operationEffects.get(operationId) === 'omnia_mutation' ? 'execute' : 'read';
            const command = operationRequest.command as Record<string, unknown> | undefined;
            const response = this.interactionLogs ? await this.interactionLogs.run({
              plane: 'connector', component: 'signed-operation', surface: `feature.${context.featureId}`,
              action: semanticStage, failurePoint: `connector.operation.${semanticStage}.${operationId}`,
              operationId, runId: String(receiptContext?.runId || recoveryContext?.runId || ''), commandId: String(command?.commandId || receiptContext?.commandId || recoveryContext?.commandId || ''),
              requestId: String(command?.idempotencyKey || ''),
              details: { featureId: context.featureId, featureVersion: context.featureVersion, operationId,
                effect: operationEffects.get(operationId) || 'read_only', runId: receiptContext?.runId || recoveryContext?.runId,
                commandId: command?.commandId || recoveryContext?.commandId, sessionGeneration }
            }, invokeRemote, context.interactionContext) : await invokeRemote();
            const witnessedDelivery = deliveryWitness as unknown as import('../../shared/connector-delivery.js').ConnectorDeliveryWitness | null;
            if (receiptContext !== undefined) {
              if (operationEffects.get(operationId) !== 'read_only') {
                throw new AppError('FEATURE.RECEIPT_EFFECT_INVALID', 'Only signed read-only Operations may issue authoritative receipts.');
              }
              const runId = String(receiptContext.runId || '');
              const commandId = String(receiptContext.commandId || '');
              const receiptBinding = operationRequest.connectorBinding as Record<string, unknown> | undefined;
              const target = operationRequest.target as Record<string, unknown> | undefined;
              const candidateReceiptRow = this.database.prepare(`
                SELECT c.plan_digest,c.state,c.evidence_operation_ids_json,c.evidence_target_identity_key,c.evidence_request_digest,
                  i.target_key,i.intended_revision_json,
                  f.credential_digest,f.connector_id,f.session_generation,f.engagement_id,
                  f.authority_instance_id,f.tenant_or_org_id,f.pack_id,
                  s.enabled,s.engagement_id AS safety_engagement_id,s.workspace_ids_json,s.global_enabled,s.global_workspace_ids_json,s.state_version,f.safety_revision
                FROM feature_commands c
                JOIN feature_runs r ON r.run_id=c.run_id
                JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
                JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
                JOIN workspace_safety s ON s.singleton=1
                WHERE c.command_id=? AND c.run_id=? AND r.feature_id=?
                ORDER BY f.created_at DESC LIMIT 1
              `).get(commandId, runId, context.featureId) as Record<string, any> | undefined;
              const receiptRow = candidateReceiptRow
                && this.currentActivationOwnsRun(runId, context.featureId, context.featureVersion)
                ? candidateReceiptRow : undefined;
              if (!receiptRow || !['prepared','committed','verifying','uncertain'].includes(String(receiptRow.state))) {
                throw new AppError('FEATURE.RECEIPT_COMMAND_INVALID', 'Authoritative receipt is not bound to an eligible frozen Return command.');
              }
              const workspaceIds = JSON.parse(String(receiptRow.workspace_ids_json)) as string[];
              const allowedWorkspaceIds = [...new Set([...workspaceIds,...(Number(receiptRow.global_enabled)===1?JSON.parse(String(receiptRow.global_workspace_ids_json)) as string[]:[])])];
              const authorityDigest = crypto.createHash('sha256').update(canonicalJson({
                connectorId: receiptBinding?.connectorId,
                sessionGeneration: Number(receiptBinding?.sessionGeneration),
                engagementId: receiptBinding?.engagementId,
                authorityInstanceId: receiptBinding?.authorityInstanceId,
                tenantOrOrgId: receiptBinding?.tenantOrOrgId,
                packId: receiptBinding?.packId,
                workspaceIds
              })).digest('hex');
              const intended = JSON.parse(String(receiptRow.intended_revision_json)) as Record<string, unknown>;
              const targetIdentityKey = String(target?.targetIdentityKey || '');
              const workspaceId = String(target?.workspaceId || '');
              const exactRequestDigest = crypto.createHash('sha256').update(canonicalJson(operationRequest)).digest('hex');
              if (
                !receiptBinding || !targetIdentityKey || !workspaceId
                || !(JSON.parse(String(receiptRow.evidence_operation_ids_json)) as string[]).includes(operationId)
                || targetIdentityKey !== String(receiptRow.evidence_target_identity_key)
                || (intended.operationTargetIdentityMode !== 'resolved_relation' && targetIdentityKey !== String(intended.operationTargetIdentityKey || ''))
                || !String(receiptRow.evidence_request_digest)
                || exactRequestDigest !== String(receiptRow.evidence_request_digest)
                || authorityDigest !== String(receiptRow.credential_digest)
                || String(receiptBinding.connectorId) !== String(receiptRow.connector_id)
                || Number(receiptBinding.sessionGeneration) !== Number(receiptRow.session_generation)
                || String(receiptBinding.engagementId) !== String(receiptRow.engagement_id)
                || String(receiptBinding.authorityInstanceId || '') !== String(receiptRow.authority_instance_id)
                || String(receiptBinding.tenantOrOrgId || '') !== String(receiptRow.tenant_or_org_id)
                || String(receiptBinding.packId || '') !== String(receiptRow.pack_id)
                || Number(receiptRow.enabled) !== 1
                || String(receiptRow.safety_engagement_id) !== String(receiptRow.engagement_id)
                || Number(receiptRow.state_version) !== Number(receiptRow.safety_revision)
                || !allowedWorkspaceIds.includes(workspaceId)
                || String(intended.workspace || '') !== workspaceId
              ) throw new AppError('FEATURE.RECEIPT_AUTHORITY_DRIFT', 'Authoritative receipt scope differs from the frozen authority, safety, or target identity.');
              if (!response || typeof response !== 'object' || Array.isArray(response)) {
                throw new AppError('FEATURE.RECEIPT_RESPONSE_INVALID', 'Authoritative read Operation response is not a JSON object.');
              }
              const receiptId = randomUUID();
              const responseJson = canonicalJson(response);
              const responseDigest = crypto.createHash('sha256').update(responseJson).digest('hex');
              if (!witnessedDelivery) throw new AppError('REMOTE.DELIVERY_WITNESS_MISSING', 'Authoritative receipt lacks its durable Connector witness.');
              const ackId = randomUUID();
              const ack = {
                schemaVersion: 'omnia.connector-delivery-ack/v1',
                ackId,
                deliveredRequestId: deliveryRequestId,
                resultDigest: witnessedDelivery.resultDigest,
                connectorId: String(receiptBinding.connectorId),
                sessionGeneration: witnessedDelivery.sessionGeneration,
                executionGeneration: witnessedDelivery.executionGeneration,
                featureId: context.featureId,
                featureVersion: context.featureVersion,
                operationId,
                operationPackageDigest,
                runId,
                commandId,
                receiptId,
                receiptResponseDigest: responseDigest,
                resolution: 'receipt_committed',
                effectOutcome: null,
                reconciles: null
              } satisfies import('../../shared/connector-delivery.js').ConnectorDeliveryAck;
              this.database.exec('BEGIN IMMEDIATE;');
              try {
                this.database.prepare(`
                  INSERT INTO feature_operation_receipts(
                  receipt_id,run_id,command_id,feature_id,feature_version,operation_package_digest,operation_id,
                  authority_digest,connector_id,session_generation,engagement_id,
                  authority_instance_id,tenant_or_org_id,pack_id,frozen_target_key,target_identity_key,
                  workspace_ids_json,plan_digest,request_digest,response_digest,response_json,created_at,
                  connector_request_id,connector_wire_result_digest,connector_execution_generation
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                `).run(
                receiptId, runId, commandId, context.featureId, context.featureVersion, operationPackageDigest, operationId,
                authorityDigest, String(receiptBinding.connectorId), Number(receiptBinding.sessionGeneration),
                String(receiptBinding.engagementId), String(receiptBinding.authorityInstanceId),
                String(receiptBinding.tenantOrOrgId), String(receiptBinding.packId),
                String(receiptRow.target_key), targetIdentityKey,
                canonicalJson(workspaceIds), String(receiptRow.plan_digest),
                exactRequestDigest,
                responseDigest, responseJson, utcNow(), deliveryRequestId, witnessedDelivery.resultDigest, witnessedDelivery.executionGeneration
                );
                this.database.prepare(`
                  UPDATE connector_delivery_requests SET state='receipt_committed',updated_at=?
                  WHERE request_id=? AND state='witnessed'
                `).run(utcNow(), deliveryRequestId);
                this.database.prepare(`
                  INSERT INTO connector_delivery_ack_outbox(
                    ack_id,request_id,transaction_kind,payload_json,state,attempts,last_error,created_at,updated_at,delivered_at
                  ) VALUES(?,?,'receipt_committed',?,'pending',0,'',?,?,'')
                `).run(ackId, deliveryRequestId, canonicalJson(ack), utcNow(), utcNow());
                this.database.exec('COMMIT;');
              } catch (error) {
                this.database.exec('ROLLBACK;');
                throw error;
              }
              this.scheduleConnectorDeliveryAckFlush();
              return { ...(response as Record<string, unknown>), __operationReceiptId: receiptId };
            }
            if(recoveryContext!==undefined&&recoveryRow){
              if(!response||typeof response!=='object'||Array.isArray(response))throw new AppError('FEATURE.RECOVERY_RECEIPT_RESPONSE_INVALID','Recovery read Operation response is not a JSON object.');
              const receiptId=randomUUID();const responseJson=canonicalJson(response);
              if(!witnessedDelivery)throw new AppError('REMOTE.DELIVERY_WITNESS_MISSING','Recovery receipt lacks its durable Connector witness.');
              const responseDigest=crypto.createHash('sha256').update(responseJson).digest('hex');const ackId=randomUUID();
              const ack={schemaVersion:'omnia.connector-delivery-ack/v1',ackId,deliveredRequestId:deliveryRequestId,resultDigest:witnessedDelivery.resultDigest,
                connectorId:String(recoveryRow.connector_id),sessionGeneration:witnessedDelivery.sessionGeneration,executionGeneration:witnessedDelivery.executionGeneration,
                featureId:context.featureId,featureVersion:context.featureVersion,operationId,operationPackageDigest,runId:String(recoveryContext.runId),commandId:String(recoveryContext.commandId),
                receiptId,receiptResponseDigest:responseDigest,resolution:'receipt_committed',effectOutcome:null,reconciles:null} satisfies import('../../shared/connector-delivery.js').ConnectorDeliveryAck;
              this.database.exec('BEGIN IMMEDIATE;');try{
              this.database.prepare(`INSERT INTO feature_return_recovery_receipts(receipt_id,authorization_id,run_id,command_id,source_feature_version,executor_feature_version,operation_package_digest,operation_id,connector_id,session_generation,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,target_identity_key,request_digest,response_digest,response_json,created_at,connector_request_id,connector_wire_result_digest,connector_execution_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(receiptId,String(recoveryContext.authorizationId),String(recoveryContext.runId),String(recoveryContext.commandId),String(recoveryRow.source_feature_version),context.featureVersion,operationPackageDigest,operationId,String(recoveryRow.connector_id),Number(recoveryRow.to_session_generation),String(recoveryRow.authority_instance_id),String(recoveryRow.tenant_or_org_id),String(recoveryRow.pack_id),String(recoveryRow.engagement_id),recoveryWorkspaceId,recoveryTargetIdentityKey,recoveryRequestDigest,responseDigest,responseJson,utcNow(),deliveryRequestId,witnessedDelivery.resultDigest,witnessedDelivery.executionGeneration);
              this.database.prepare(`UPDATE connector_delivery_requests SET state='receipt_committed',updated_at=? WHERE request_id=? AND state='witnessed'`).run(utcNow(),deliveryRequestId);
              this.database.prepare(`INSERT INTO connector_delivery_ack_outbox(ack_id,request_id,transaction_kind,payload_json,state,attempts,last_error,created_at,updated_at,delivered_at) VALUES(?,?,'receipt_committed',?,'pending',0,'',?,?,'')`)
                .run(ackId,deliveryRequestId,canonicalJson(ack),utcNow(),utcNow());this.database.exec('COMMIT;');}catch(error){this.database.exec('ROLLBACK;');throw error;}
              await this.flushConnectorDeliveryAcks();
              return{...(response as Record<string,unknown>),__recoveryReceiptId:receiptId};
            }
            return response;
          } catch (error) {
            if (operationEffects.get(String(invocation.operationId || '')) === 'omnia_mutation'
              && context.allowMutation && durableMutationDispatchAttempted
              && !(error instanceof AppError && ['CONNECTOR_NEXT.MUTATION_NOT_STARTED','CONNECTOR_NEXT.MUTATION_NOT_STARTED_ACK_PENDING'].includes(error.code))) {
              throw new AppError(
                'CONNECTOR.RESPONSE_LOST',
                'Remote mutation 的响应或连接已丢失；effect 状态未知，禁止自动重放，只允许只读 reconcile。'
              );
            }
            throw error;
          }
        },
        storeCall: async (method, input, context) => {
          assertDeclaredStorePort(installed.runtimeContract,method);
          const value = this.runtimeStore.call(method, input, context);
          if (method === 'recordReturnEvidence') this.scheduleConnectorDeliveryAckFlush();
          else if (method === 'recordLegacyReturnRecoveryOutcome') await this.flushConnectorDeliveryAcks();
          if (context.allowMutation && shouldPublishLiveReturnProgress(method, input)) {
            const runId = input && typeof input === 'object' && !Array.isArray(input)
              ? String((input as Record<string, unknown>).runId || '')
              : '';
            if (runId) this.publishLiveReturnProgress(context.featureId, context.featureVersion, runId, context);
          }
          return value;
        },
        featureReview: async (input, context) => {
          if (!this.runtime?.featureReview) {
            throw new AppError('FEATURE.AI_REVIEW_UNAVAILABLE', 'Feature AI review port is unavailable.');
          }
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new AppError('FEATURE.AI_REVIEW_REQUEST_INVALID', 'Feature AI review request must be an object.');
          }
          const request = input as Record<string, unknown>;
          const capability = installed.runtimeContract?.aiReviewCapabilities.find(
            (candidate)=>candidate.capabilityId===String(request.capabilityId||'')
          );
          if (!capability || request.schemaVersion !== capability.requestSchemaVersion) {
            throw new AppError('FEATURE.AI_REVIEW_CAPABILITY_DENIED', 'Feature AI review capability is not allowed.');
          }
          const runId = String(request.runId || '');
          const run = this.database.prepare('SELECT feature_id,feature_version FROM feature_runs WHERE run_id=?').get(runId) as Record<string, unknown> | undefined;
          if (!run || String(run.feature_id) !== context.featureId || String(run.feature_version) !== context.featureVersion) {
            throw new AppError('FEATURE.AI_REVIEW_RUN_MISMATCH', 'Feature AI review Run identity differs from the active Worker context.');
          }
          if (Buffer.byteLength(JSON.stringify(input), 'utf8') > capability.maxRequestBytes) {
            throw new AppError('FEATURE.AI_REVIEW_REQUEST_TOO_LARGE', 'Feature AI review request exceeds its signed capability limit.');
          }
          return this.runtime.featureReview(input, context);
        },
        emitEvent: async (input, context) => {
          const eventId = this.runtimeStore.emit(input, context);
          this.pendingRuntimeEvents.add(eventId);
          return eventId;
        },
        recoverInterruption: async (input, context) => this.runtimeStore.recoverWorkerInterruption(input, context)
      },
      managedRuntime
    );
    let supervisorActivated = false;
    try {
    await supervisor.start();
    const health = await supervisor.invoke('health', null, { timeoutMs: 10_000 }) as Record<string, unknown>;
    if (
      health?.ready !== true
      || health.featureId !== head.featureId
      || health.featureVersion !== head.featureVersion
    ) throw new Error('Feature worker health identity is invalid.');
    // Worker health is not an ownership authority. In particular, a legacy
    // orphan whose creator receipt predates durable Connector metadata must
    // remain quarantined instead of being auto-claimed from a Feature-private
    // plan. A separately confirmed Core forensic workflow may supply generic
    // attestations in the future; normal signed handoff relies only on the
    // Connector's durable creator metadata and exact source registration.
    const persisted = this.database.prepare(`
      SELECT feature_version, surface_id, state_revision, payload_json
      FROM feature_surface_states WHERE feature_id=?
    `).get(head.featureId) as {
      feature_version: string; surface_id: string; state_revision: number; payload_json: string;
    } | undefined;
    let restored = installed.surface;
    let restoredPersistedState = false;
    if (persisted && persisted.feature_version === head.featureVersion && persisted.surface_id === installed.surface.surfaceId) {
      try {
        const candidate = validateSurface(JSON.parse(persisted.payload_json) as unknown, installed.manifest);
        if (
          candidate.featureId === head.featureId
          && candidate.featureVersion === head.featureVersion
          && candidate.surfaceId === installed.surface.surfaceId
          && candidate.stateVersion === persisted.state_revision
          && candidate.stateVersion >= installed.surface.stateVersion
        ) {
          restored = candidate;
          restoredPersistedState = true;
        }
      } catch { /* incompatible/corrupt projection is discarded; durable Run and evidence remain untouched */ }
    }
    if (health.recoveredSurfacePatch) {
      // A persisted Surface is only a disposable projection. Rebuild it from the immutable
      // package declaration plus the worker's current durable Run projection so an old UI
      // shape can never poison Feature activation or overwrite Run/Artifact/evidence state.
      restored = applyWorkerSurfacePatch(installed.surface, health.recoveredSurfacePatch, installed.manifest);
      this.persistSurface(restored);
    } else if (!restoredPersistedState) {
      this.persistSurface(restored);
    }
    if (health.recoveredMessageCard) {
      const message=health.recoveredMessageCard as import('../../shared/feature-contracts.js').FeatureMessageCard;
      if(message.featureId!==head.featureId||message.featureVersion!==head.featureVersion||message.surfaceId!==installed.surface.surfaceId) throw new Error('Recovered Feature message identity is invalid.');
      this.database.prepare(`INSERT INTO feature_runtime_messages(message_id,feature_id,feature_version,surface_id,state_version,payload_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET state_version=excluded.state_version,payload_json=excluded.payload_json,updated_at=excluded.updated_at WHERE excluded.state_version>feature_runtime_messages.state_version`).run(message.messageId,message.featureId,message.featureVersion,message.surfaceId,message.stateVersion,JSON.stringify(message),utcNow());
    }
    let preparedHandoff: {
      registrationState: 'prepared' | 'committed';
      registrationToken: string;
      replacedPackageDigests: string[];
    } | null = null;
    let finalizeLedger = handoffSource ? null : this.pendingOperationHandoffFinalize(head);
    if (finalizeLedger && finalizeLedger.targetOperationPackageDigest !== operationPackageDigest) {
      throw new AppError(
        'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH',
        'Finalize-pending Operation digest differs from the active signed package.'
      );
    }
    if (!handoffSource) {
      let registration: Awaited<ReturnType<ConnectorTransport['registerOperation']>> | null = null;
      try {
        registration = await this.runtime.connector.registerOperation({
          schemaVersion: 'omnia.operation-registration/v1',
          featureId: head.featureId,
          featureVersion: head.featureVersion,
          operationPackage
        });
      } catch (error) {
        const nextPackDeferred = error instanceof AppError
          && error.code === 'CONNECTOR_NEXT.PACK_NOT_CONNECTED'
          && this.runtime.connector.unavailableSnapshot('').adapter === 'connector_next_v3'
          && !finalizeLedger;
        if (!nextPackDeferred) throw error;
        // Connector Next has no current Pack binding yet. The worker remains
        // available and connectorInvoke performs the exact signed two-phase
        // registration immediately before its first real invocation. Active
        // handoff/finalize ledgers are never eligible for this deferral.
      }
      if (registration) {
      const expectedOperationIds = operationManifest.operations.map((operation) => operation.operationId).sort();
      const rawRegistration = registration as unknown as Record<string, unknown>;
      const exactCommonIdentity = registration.schemaVersion === 'omnia.operation-registration-result/v1'
        && registration.featureId === head.featureId
        && registration.featureVersion === head.featureVersion
        && registration.packageId === operationManifest.packageId
        && registration.packageDigest === operationPackageDigest
        && Array.isArray(registration.operationIds)
        && canonicalJson([...registration.operationIds].sort()) === canonicalJson(expectedOperationIds);
      const exactModernRegistration = registration.registrationState === 'committed'
        && /^[0-9a-f]{64}$/u.test(registration.registrationToken)
        && Array.isArray(registration.replacedPackageDigests)
        && canonicalJson([...new Set(registration.replacedPackageDigests)].sort())
          === canonicalJson(registration.replacedPackageDigests);
      const exactLegacyRegistration = !Object.hasOwn(rawRegistration, 'registrationState')
        && !Object.hasOwn(rawRegistration, 'registrationToken')
        && !Object.hasOwn(rawRegistration, 'replacedPackageDigests');
      if (!exactCommonIdentity
        || (!exactModernRegistration && !exactLegacyRegistration)
        || (exactLegacyRegistration && Boolean(finalizeLedger))) {
        throw new AppError(
          'FEATURE.OPERATION_REGISTRATION_DRIFT',
          'Connector did not eagerly restore the exact active signed Operation package.'
        );
      }
      if (exactModernRegistration && registration.replacedPackageDigests.length > 0) {
        const ledger = operationHandoffByToken(
          this.database, head.featureId, registration.registrationToken
        );
        const exactHandoff = ledger
          && ['finalize_pending', 'finalized'].includes(ledger.phase)
          && ledger.targetFeatureVersion === head.featureVersion
          && ledger.targetOperationPackageDigest === operationPackageDigest
          && canonicalJson(ledger.replacedPackageDigests)
            === canonicalJson(registration.replacedPackageDigests);
        if (!exactHandoff) {
          await finalizeExactBaselineOperationAdoption(this.database, this.runtime.connector, {
            featureId: head.featureId,
            featureVersion: head.featureVersion,
            packageDigest: head.packageDigest,
            activationGeneration: head.activationGeneration,
            operationPackageDigest,
            registrationToken: registration.registrationToken,
            operationManifest,
            replacedPackageDigests: registration.replacedPackageDigests
          });
        }
      }
      }
    }
    if (handoffSource) {
      const sourceOperation = this.loadInstalledOperation(this.loadInstalled(handoffSource));
      assertCompatibleOperationHandoff(sourceOperation, validatedOperationPackage);
      const stagedLedger = activeOperationHandoff(this.database, head.featureId);
      if (!stagedLedger
        || !['staged', 'prepared', 'committed'].includes(stagedLedger.phase)
        || stagedLedger.sourceOperationPackageDigest !== sourceOperation.digest
        || stagedLedger.targetOperationPackageDigest !== operationPackageDigest) {
        throw new AppError(
          'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH',
          'Signed source/target Operation digests differ from the durable handoff ledger.'
        );
      }
      try {
        await ensureExactSourceOperationRegistration(this.database, this.runtime.connector, {
          featureId: handoffSource.featureId,
          featureVersion: handoffSource.featureVersion,
          operationPackage: sourceOperation.envelope,
          validatedOperationPackage: sourceOperation
        });
        preparedHandoff = await registerExactOperationHandoff(this.runtime.connector, {
          featureId: head.featureId,
          featureVersion: head.featureVersion,
          operationPackage,
          operationManifest,
          operationPackageDigest,
          sourceOperationPackageDigest: sourceOperation.digest
        });
      } catch (error) {
        throw new AppError(
          'FEATURE.OPERATION_HANDOFF_REFUSED',
          `The active Feature runtime and frozen Operation resources were preserved because the Connector refused the exact signed handoff: ${error instanceof Error ? error.message : 'unknown Connector refusal'}`,
          true
        );
      }
      persistPreparedOperationHandoff(
        this.database, handoffSource, head, preparedHandoff.registrationToken,
        preparedHandoff.replacedPackageDigests, utcNow()
      );
      if (preparedHandoff.registrationState === 'prepared') {
        try {
          await commitExactOperationHandoff(this.runtime.connector, {
            featureId: head.featureId,
            featureVersion: head.featureVersion,
            operationPackageDigest,
            registrationToken: preparedHandoff.registrationToken,
            operationManifest,
            replacedPackageDigests: preparedHandoff.replacedPackageDigests
          });
        } catch (error) {
          throw new AppError(
            'FEATURE.OPERATION_HANDOFF_COMMIT_UNCERTAIN',
            `The exact Connector registration token remains pending and will be retried idempotently: ${error instanceof Error ? error.message : 'unknown commit response'}`,
            true
          );
        }
      }
      try {
        persistCommittedOperationHandoff(
          this.database, handoffSource, head, preparedHandoff.registrationToken,
          preparedHandoff.replacedPackageDigests, utcNow()
        );
        finalizePreparedOperationHandoff(
          this.database, handoffSource, head, preparedHandoff.registrationToken, utcNow()
        );
        finalizeLedger = activeOperationHandoff(this.database, head.featureId);
        if (!finalizeLedger || finalizeLedger.phase !== 'finalize_pending') throw new AppError(
          'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH',
          'Core activation committed without the exact finalize-pending handoff ledger.'
        );
      } catch (activationError) {
        const currentLedger = activeOperationHandoff(this.database, head.featureId);
        const currentHead = this.head(head.featureId);
        if (currentLedger?.phase === 'finalize_pending'
          && currentHead?.featureVersion === currentLedger.targetFeatureVersion
          && currentHead.packageDigest === currentLedger.targetPackageDigest
          && currentHead.activationGeneration === currentLedger.targetActivationGeneration) {
          finalizeLedger = currentLedger;
        } else if (currentLedger && ['prepared', 'committed'].includes(currentLedger.phase)
          && currentHead?.featureVersion === currentLedger.sourceFeatureVersion
          && currentHead.packageDigest === currentLedger.sourcePackageDigest
          && currentHead.activationGeneration === currentLedger.sourceActivationGeneration) {
          markOperationHandoffAbortPending(this.database, currentLedger, activationError, utcNow());
          const abortLedger = activeOperationHandoff(this.database, head.featureId)!;
          try {
            await abortExactOperationHandoff(this.runtime.connector, {
              featureId: head.featureId,
              featureVersion: head.featureVersion,
              operationPackageDigest,
              registrationToken: abortLedger.registrationToken,
              operationManifest,
              sourceOperationPackageDigest: abortLedger.sourceOperationPackageDigest
            });
            completeAbortedOperationHandoff(this.database, abortLedger, utcNow());
          } catch (abortError) {
            this.database.prepare(`UPDATE feature_operation_handoffs SET updated_at=?,last_error=?
              WHERE handoff_id=? AND phase='abort_pending'`).run(
                utcNow(), abortError instanceof Error ? abortError.message.slice(0, 1000) : 'Connector abort response is uncertain.',
                abortLedger.handoffId
              );
          }
          throw activationError;
        } else {
          throw new AppError(
            'FEATURE.OPERATION_HANDOFF_RECONCILIATION_REQUIRED',
            `Operation handoff cannot choose abort or roll-forward because Core identity drifted: ${activationError instanceof Error ? activationError.message : 'unknown activation error'}`,
            true
          );
        }
      }
    }
    const finalizeToken = finalizeLedger?.registrationToken || '';
    const now = utcNow();
    if (!handoffSource) {
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        const enabled = this.database.prepare(`
          UPDATE feature_activation_heads SET runtime_enabled=1,runtime_reason='',updated_at=?
          WHERE feature_id=? AND feature_version=? AND package_digest=?
        `).run(now, head.featureId, head.featureVersion, head.packageDigest);
        if (enabled.changes !== 1) {
          throw new AppError('FEATURE.ACTIVATION_HEAD_CAS_MISMATCH', 'Feature activation head changed during Worker startup.');
        }
        if (!finalizeToken) this.database.prepare(`
          UPDATE feature_registry SET lifecycle='active', health='ready', activated_at=?
          WHERE feature_id=? AND feature_version=? AND package_digest=?
        `).run(now, head.featureId, head.featureVersion, head.packageDigest);
        this.database.prepare(`
          UPDATE documentation_registry SET lifecycle='active', activated_at=?
          WHERE feature_id=? AND feature_version=?
        `).run(now, head.featureId, head.featureVersion);
        this.database.exec('COMMIT;');
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw error;
      }
    }
    for (const key of this.operationRegistrations.keys()) {
      if (key.startsWith(`${head.featureId}|`)) this.operationRegistrations.delete(key);
    }
    const old = this.supervisors.get(head.featureId);
    this.supervisors.set(head.featureId, supervisor);
    this.runtimeSurfaces.set(head.featureId, restored);
    supervisorActivated = true;
    if (old) await Promise.allSettled([old.stop()]);
    if (finalizeToken) {
      try {
        await restoreExactCommittedOperationHandoff(this.runtime.connector, {
          featureId: head.featureId,
          featureVersion: head.featureVersion,
          operationPackage,
          operationManifest,
          operationPackageDigest,
          sourceOperationPackageDigest: finalizeLedger!.sourceOperationPackageDigest,
          registrationToken: finalizeToken
        });
        await finalizeExactOperationHandoff(this.runtime.connector, {
          featureId: head.featureId,
          featureVersion: head.featureVersion,
          operationPackageDigest,
          registrationToken: finalizeToken,
          operationManifest,
          replacedPackageDigests: finalizeLedger!.replacedPackageDigests
        });
        completeFinalizedOperationHandoff(this.database, finalizeLedger!, utcNow());
      } catch (finalizeError) {
        // The active head already points at an invokable new digest and commit
        // deliberately kept the previous exact registration. Retain the
        // durable token and retry cleanup after restart; never roll back the
        // authoritative runtime or discard frozen resources on response loss.
        this.database.prepare(`UPDATE feature_operation_handoffs SET updated_at=?,last_error=?
          WHERE handoff_id=? AND phase='finalize_pending' AND registration_token=?`).run(
            utcNow(), finalizeError instanceof Error
              ? finalizeError.message.slice(0, 1000) : 'Connector finalize response is uncertain.',
            finalizeLedger!.handoffId, finalizeToken
          );
      }
    }
    } finally {
      if (!supervisorActivated) await Promise.allSettled([supervisor.stop()]);
    }
  }

  list(): ActivationHead[] {
    return (this.database.prepare(`
      SELECT feature_id, feature_version, activation_generation, runtime_enabled, runtime_reason,
             package_path, package_digest, documentation_path
      FROM feature_activation_heads ORDER BY feature_id
    `).all() as Array<Record<string, unknown>>).map((row) => ({
      featureId: String(row.feature_id),
      featureVersion: String(row.feature_version),
      activationGeneration: Number(row.activation_generation),
      runtimeEnabled: row.runtime_enabled === 1,
      runtimeReason: String(row.runtime_reason),
      packagePath: String(row.package_path),
      packageDigest: String(row.package_digest),
      documentationPath: String(row.documentation_path)
    }));
  }

  installedVersion(featureId: string, featureVersion: string): { packageDigest: string; documentationPath: string } | null {
    const row = this.database.prepare(`
      SELECT f.package_digest, d.physical_path
      FROM feature_registry f
      JOIN documentation_registry d
        ON d.feature_id=f.feature_id AND d.feature_version=f.feature_version
      WHERE f.feature_id=? AND f.feature_version=?
    `).get(featureId, featureVersion) as { package_digest: string; physical_path: string } | undefined;
    return row ? { packageDigest: row.package_digest, documentationPath: row.physical_path } : null;
  }

  select(featureId: string): FeatureRuntimeSnapshot {
    if (featureId === '') {
      this.selectedFeatureId = '';
      return this.snapshot();
    }
    if (!this.head(featureId)) throw new AppError('FEATURE.NOT_INSTALLED', 'The Feature is not installed.');
    this.selectedFeatureId = featureId;
    return this.snapshot();
  }

  private runtimeBlockReason(head: ActivationHead): string {
    if (!head.runtimeEnabled) return head.runtimeReason;
    return '';
  }

  private isDeclaredRecoveryAction(
    head: ActivationHead,
    action: import('../../shared/feature-contracts.js').DeclarativeFeatureAction
  ): boolean {
    const installed = this.loadInstalled(head);
    const declaration = installed.manifest.recoveryCompatibility;
    if (!declaration || action.actionId !== declaration.actionId) return false;
    const legacy = this.legacyRecoveryRun(
      head.featureId,
      head.featureVersion,
      declaration.sourceFeatureVersions
    );
    if (!legacy || !declaration.sourceFeatureVersions.includes(String(legacy.feature_version))) return false;
    if (declaration.mode === 'partial_close_no_reuse') return String(legacy.state) === 'returning';
    return declaration.mode === 'frozen_input_finalize'
      && String(legacy.state) === 'processing';
  }

  private actionBlockReason(
    head: ActivationHead,
    action: import('../../shared/feature-contracts.js').DeclarativeFeatureAction,
    context?: FeatureRuntimeContext
  ): string {
    const runtimeReason = this.runtimeBlockReason(head);
    if (runtimeReason) return runtimeReason;
    const installed = this.loadInstalled(head);
    const declaration=installed.manifest.recoveryCompatibility;
    const legacy = this.legacyRecoveryRun(head.featureId, head.featureVersion, declaration?.sourceFeatureVersions || []);
    if (legacy) {
      const stateEligible=declaration?.mode==='partial_close_no_reuse'
        ? String(legacy.state)==='returning'
        : declaration?.mode==='frozen_input_finalize'
          ? String(legacy.state)==='processing'
          : false;
      if(!declaration||!declaration.sourceFeatureVersions.includes(String(legacy.feature_version))
        ||!stateEligible||action.actionId!==declaration.actionId) {
        return 'A legacy Run is open; only its explicitly declared recovery action is available.';
      }
      const inFlight=(this.database.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state IN ('submitted','committed','verifying','uncertain')`).get(String(legacy.run_id)) as {count:number}).count;
      const uncertain=(this.database.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state='uncertain'`).get(String(legacy.run_id)) as {count:number}).count;
      if(inFlight||uncertain)return 'The legacy partial Return has in-flight or uncertain state and cannot be closed automatically.';
    }
    if (!context) return '';
    const dependencies = effectiveActionDependencies(action);
    if (dependencies.includes('remote_connector')) {
      if (!context.connection.connected) return '请先连接当前 Omnia Pack。';
      if (!context.connection.sessionGeneration || context.connection.sessionGeneration < 1) {
        return 'Connector 会话标识不可用，请重新连接。';
      }
    }
    if (dependencies.includes('safety_lock') && (!context.safetyLock.enabled || !context.safetyLock.validForCurrentConnection)) {
      return context.safetyLock.invalidReason || '请先启用当前 Pack 的安全锁。';
    }
    if (dependencies.includes('verified_canary')) {
      if (!context.connection.authorityInstanceId || !context.connection.tenantOrOrgId || !context.connection.packId) {
        return '生产回传未开放：当前 Connector 缺少实时 canonical authority instance、tenant/org 或 Pack identity；真实 Omnia canary 也尚未完成。';
      }
      const harnessVerified = process.env.NODE_ENV === 'test' && context.verifiedCanaryCapabilities?.some((capability) =>
        capability.featureId === head.featureId
        && capability.scenarioId === action.canaryCapability?.scenarioId
        && capability.capabilityId === action.canaryCapability?.capabilityId
      ) === true;
      const installed = this.loadInstalled(head);
      const operationPackage = JSON.parse(packageFile(installed.envelope, installed.manifest.operationPackagePath).toString('utf8')) as unknown;
      const operationDigest = packageDigest(verifyOfficialPackage(operationPackage, 'omnia-connector-operation'));
      const workspaceId = context.safetyLock.workspaceIds.length === 1 ? context.safetyLock.workspaceIds[0] : '';
      const authorityInstanceId = context.connection.authorityInstanceId || '';
      const tenantOrOrgId = context.connection.tenantOrOrgId || '';
      const packId = context.connection.packId || '';
      const engagementId = context.connection.engagementId || '';
      const durableEvidence = authorityInstanceId && tenantOrOrgId && packId && engagementId && workspaceId ? this.database.prepare(`
        SELECT 1 FROM feature_capability_evidence
        WHERE feature_id=? AND feature_version=? AND operation_package_digest=?
          AND scenario_id=? AND capability_id=?
          AND authority_instance_id=? AND tenant_or_org_id=? AND pack_contract_id=? AND engagement_id=? AND workspace_id=?
          AND automated_status='passed' AND portable_status='passed'
          AND canary_status='passed' AND readback_status='passed' AND verified=1
          AND revoked_at='' AND expires_at>?
        LIMIT 1
      `).get(
        head.featureId, head.featureVersion, operationDigest,
        action.canaryCapability?.scenarioId || '', action.canaryCapability?.capabilityId || '',
        authorityInstanceId, tenantOrOrgId, packId, engagementId, workspaceId, utcNow()
      ) : null;
      if (!harnessVerified && !durableEvidence) {
        return '生产回传未开放：该场景/能力组合的真实 Omnia canary 与读回证据尚未通过。';
      }
    }
    return '';
  }

  private persistSurface(surface: DeclarativeFeatureSurface): void {
    this.database.prepare(`
      INSERT INTO feature_surface_states(feature_id, feature_version, surface_id, state_revision, payload_json, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(feature_id) DO UPDATE SET
        feature_version=excluded.feature_version,
        surface_id=excluded.surface_id,
        state_revision=excluded.state_revision,
        payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
      WHERE excluded.state_revision > feature_surface_states.state_revision
         OR excluded.feature_version != feature_surface_states.feature_version
    `).run(surface.featureId, surface.featureVersion, surface.surfaceId, surface.stateVersion, JSON.stringify(surface), utcNow());
  }

  actionDependencies(request: FeatureActionRequest): ReadonlyArray<'remote_connector' | 'safety_lock' | 'verified_canary'> {
    const head = this.head(request.featureId);
    if (!head || head.featureVersion !== request.featureVersion) return [];
    const { manifest, surface: installedSurface } = this.loadInstalled(head);
    this.assertRecoveryModeAction(manifest, request.actionId);
    const surface = this.runtimeSurfaces.get(head.featureId) || installedSurface;
    if (surface.surfaceId !== request.surfaceId) return [];
    const surfaceAction = surface.actions.find((candidate) => candidate.actionId === request.actionId);
    if (surfaceAction) return effectiveActionDependencies(surfaceAction);
    const cardAction = this.messageCards().find((candidate) =>
      candidate.featureId === request.featureId
      && candidate.featureVersion === request.featureVersion
      && candidate.surfaceId === request.surfaceId
      && candidate.runId === request.payload.runId
      && candidate.confirmationId === request.payload.confirmationId
    )?.actions.find((candidate) => candidate.actionId === request.actionId);
    return cardAction ? effectiveActionDependencies(cardAction) : [];
  }

  private messageCards(): import('../../shared/feature-contracts.js').FeatureMessageCard[] {
    return (this.database.prepare(`
      SELECT m.payload_json
      FROM feature_runtime_messages m
      JOIN feature_activation_heads h ON h.feature_id=m.feature_id AND h.feature_version=m.feature_version
      ORDER BY m.updated_at
    `).all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json));
  }

  snapshot(context?: FeatureRuntimeContext): FeatureRuntimeSnapshot {
    const heads = this.list();
    const groupMap = new Map<string, FeatureNavigationGroup>();
    const navigation: FeatureNavigationLeaf[] = [];
    let selectedSurface: DeclarativeFeatureSurface | null = null;
    for (const head of heads) {
      const { manifest, surface } = this.loadInstalled(head);
      for (const group of manifest.navigation.groups) if (!groupMap.has(group.id)) groupMap.set(group.id, group);
      const blockReason = this.runtimeBlockReason(head);
      navigation.push(...manifest.navigation.leaves.map((leaf) => ({
        ...leaf,
        availability: head.runtimeEnabled ? 'available' as const : 'disabled' as const,
        reason: head.runtimeReason
      })));
      if (head.featureId === this.selectedFeatureId) {
        const current = this.runtimeSurfaces.get(head.featureId) || surface;
        selectedSurface = {
          ...current,
          status: blockReason ? 'blocked' : current.status,
          statusMessage: blockReason || current.statusMessage,
          actions: current.actions.map((action) => {
            const actionReason = this.actionBlockReason(head, action, context);
            const recoveryAction = this.isDeclaredRecoveryAction(head, action);
            return {
              ...action,
              enabled: !actionReason && (action.enabled || recoveryAction),
              reason: actionReason || (recoveryAction ? '' : action.reason),
              ...(recoveryAction ? { selectionMode: 'none' as const } : {})
            };
          })
        };
      }
    }
    const cards = this.messageCards().map((card) => {
      const head = heads.find((item) => item.featureId === card.featureId);
      return {
        ...card,
        actions: card.actions.map((action) => ({
          ...action,
          enabled: Boolean(head) && !this.actionBlockReason(head!, action, context) && action.enabled,
          reason: head ? (this.actionBlockReason(head, action, context) || action.reason) : 'Feature is not active.'
        }))
      };
    });
    return {
      schemaVersion: 'omnia.feature-runtime-snapshot/v1',
      snapshotId: randomUUID(),
      stateVersion: Math.max(1, ...heads.map((head) => head.activationGeneration)),
      groups: [...groupMap.values()],
      navigation,
      selectedFeatureId: this.selectedFeatureId,
      surface: selectedSurface,
      messageCards: cards
    };
  }

  async action(request: FeatureActionRequest, context: FeatureRuntimeContext): Promise<FeatureRuntimeSnapshot> {
    const head = this.head(request.featureId);
    if (!head) throw new AppError('FEATURE.NOT_INSTALLED', 'The Feature is not installed.');
    if (head.featureVersion !== request.featureVersion) {
      throw new AppError('FEATURE.VERSION_MISMATCH', 'The requested Feature version is not the active activation head.', true);
    }
    const { manifest, surface: installedSurface } = this.loadInstalled(head);
    this.assertRecoveryModeAction(manifest, request.actionId);
    const surface = this.runtimeSurfaces.get(head.featureId) || installedSurface;
    if (surface.surfaceId !== request.surfaceId) {
      throw new AppError('FEATURE.SURFACE_MISMATCH', 'The requested surface is not owned by the active Feature version.');
    }
    if (request.actionId === 'runtime.set-selection') {
      if (surface.stateVersion !== request.expectedStateVersion) {
        throw new AppError('FEATURE.STATE_CONFLICT', 'Feature state changed; refresh before retrying.', true);
      }
      const selectedItemIds = request.payload.selectedItemIds;
      const modes = surface.actions.map((item) => item.selectionMode || 'none');
      const maximum = modes.includes('multiple') ? Number.MAX_SAFE_INTEGER : modes.includes('single') ? 1 : 0;
      if (!Array.isArray(selectedItemIds) || selectedItemIds.length > maximum) {
        throw new AppError('FEATURE.SELECTION_INVALID', 'The selected item count exceeds this runtime surface contract.');
      }
      const selectable = new Set(surface.items.filter((item) => item.selectable).map((item) => item.id));
      if (selectedItemIds.some((id) => typeof id !== 'string' || !selectable.has(id))) {
        throw new AppError('FEATURE.SELECTION_INVALID', 'Feature selection contains a blocked or stale item.');
      }
      const next = {
        ...surface,
        stateVersion: surface.stateVersion + 1,
        selectedItemIds: [...selectedItemIds]
      };
      this.runtimeSurfaces.set(head.featureId, next);
      this.persistSurface(next);
      return this.snapshot(context);
    }
    let action = surface.actions.find((item) => item.actionId === request.actionId);
    let card = null as import('../../shared/feature-contracts.js').FeatureMessageCard | null;
    if (!action) {
      card = this.messageCards().find((candidate) =>
        candidate.featureId === request.featureId
        && candidate.featureVersion === request.featureVersion
        && candidate.surfaceId === request.surfaceId
        && candidate.runId === request.payload.runId
        && candidate.confirmationId === request.payload.confirmationId
        && candidate.actions.some((candidateAction) => candidateAction.actionId === request.actionId)
      ) || null;
      action = card?.actions.find((item) => item.actionId === request.actionId);
    }
    if (!action) throw new AppError('FEATURE.ACTION_UNKNOWN', 'The active Feature runtime did not declare this action.');
    const actualStateVersion = card?.stateVersion ?? surface.stateVersion;
    if (actualStateVersion !== request.expectedStateVersion) {
      throw new AppError('FEATURE.STATE_CONFLICT', 'Feature state changed; refresh before retrying.', true);
    }
    if (action.presentation === 'recover') {
      const recordingId = String(request.payload.recordingId || '').trim().toLowerCase();
      const projectedRecordingId = String(surface.recorder?.recordingId || '').trim().toLowerCase();
      if (
        !surface.recorder
        || surface.recorder.state !== 'stopped'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(recordingId)
        || recordingId !== projectedRecordingId
        || Object.keys(request.payload).length !== 1
      ) throw new AppError('FEATURE.RECOVERY_IDENTITY_INVALID', 'Recorder recovery requires the exact refreshed stopped recordingId.');
    }
    const blockReason = this.actionBlockReason(head, action, context);
    const recoveryAction = this.isDeclaredRecoveryAction(head, action);
    if (blockReason || (!action.enabled && !recoveryAction)) {
      throw new AppError('FEATURE.RUNTIME_DISABLED', blockReason || action.reason);
    }
    const supervisor = this.supervisors.get(request.featureId);
    if (!supervisor) throw new AppError('FEATURE.WORKER_UNAVAILABLE', 'Feature worker is not running.', true);
    const selectionMode = recoveryAction ? 'none' : (action.selectionMode || 'none');
    if (selectionMode !== 'none') {
      if (!Array.isArray(request.payload.targetIds)) {
        throw new AppError('FEATURE.SELECTION_REQUIRED', 'This action requires an explicit current selection.');
      }
      const allowed = new Set(surface.items.filter((item) => item.selectable).map((item) => item.id));
      if (request.payload.targetIds.some((id) => typeof id !== 'string' || !allowed.has(id))) {
        throw new AppError('FEATURE.SELECTION_INVALID', 'Feature selection contains a blocked or stale item.');
      }
      if (
        request.payload.targetIds.length !== surface.selectedItemIds.length
        || request.payload.targetIds.some((id) => !surface.selectedItemIds.includes(id as string))
      ) throw new AppError('FEATURE.SELECTION_STALE', 'Feature selection changed; choose the target again.', true);
      if (selectionMode === 'single' && request.payload.targetIds.length !== 1) {
        throw new AppError('FEATURE.SELECTION_REQUIRED', 'This action requires exactly one selected item.');
      }
      if (selectionMode === 'multiple' && request.payload.targetIds.length < 1) {
        throw new AppError('FEATURE.SELECTION_REQUIRED', 'This action requires at least one selected item.');
      }
    }
    const invokeWorker = () => supervisor.invoke('handleAction', {
      actionId: request.actionId,
      expectedStateVersion: request.expectedStateVersion,
      payload: request.payload,
      context: {
        connectorBinding: {
          connectorId: context.connection.connectorId,
          sessionGeneration: context.connection.sessionGeneration,
          engagementId: context.connection.engagementId,
          authorityInstanceId: context.connection.authorityInstanceId || '',
          tenantOrOrgId: context.connection.tenantOrOrgId || '',
          packId: context.connection.packId || ''
        },
        safetyLock: context.safetyLock
      }
    }, {
      allowMutation: action.effect === 'omnia_mutation',
      ...(action.effect === 'omnia_mutation' ? { timeoutMs: OMNIA_MUTATION_WORKER_TIMEOUT_MS } : {}),
      ...(action.effect === 'omnia_mutation' ? { recovery: {
        actionId: request.actionId,
        runId: String(request.payload.runId || card?.runId || ''),
        commandId: String(request.payload.commandId || '')
      } } : {}),
      ...(this.interactionLogs?.current() ? { interactionContext: this.interactionLogs.current()! } : {})
    }) as Promise<Record<string, any>>;
    let result: Record<string, any>;
    try {
      result = this.interactionLogs ? await this.interactionLogs.run({
        plane: 'middle', component: 'feature-worker', surface: request.surfaceId, action: request.actionId,
        failurePoint: `feature-worker.${request.featureId}.${request.actionId}`,
        runId: String(request.payload.runId || ''), commandId: String(request.payload.commandId || ''),
        details: { featureId: request.featureId, featureVersion: request.featureVersion, surfaceId: request.surfaceId,
          actionId: request.actionId, expectedStateVersion: request.expectedStateVersion, runId: request.payload.runId,
          commandId: request.payload.commandId, effect: action.effect }
      }, invokeWorker) : await invokeWorker();
    } catch (error) {
      if (action.effect === 'omnia_mutation'
        && error instanceof AppError
        && ['FEATURE.WORKER_TIMEOUT', 'FEATURE.WORKER_EXITED'].includes(error.code)) {
        // The durable Run is authoritative after a mutation Worker interruption.
        // Start a fresh Worker only to rebuild the disposable Surface projection;
        // health performs read-only recovery and never replays a mutation.
        try {
          await supervisor.start();
          const health = await supervisor.invoke('health', null, { timeoutMs: 10_000 }) as Record<string, unknown>;
          if (health.ready === true
            && health.featureId === head.featureId
            && health.featureVersion === head.featureVersion
            && health.recoveredSurfacePatch) {
            const recovered = applyWorkerSurfacePatch(installedSurface, health.recoveredSurfacePatch, manifest);
            this.runtimeSurfaces.set(head.featureId, recovered);
            this.persistSurface(recovered);
          }
        } catch { /* original interruption remains the user-facing error */ }
      }
      if (action.presentation === 'background') {
        const message = error instanceof Error ? error.message : 'Feature background action failed.';
        const lifecycleFailure = surface.lifecycle?.onReopenActionId === request.actionId;
        const failed = {
          ...surface,
          stateVersion: surface.stateVersion + 1,
          status: 'error' as const,
          statusMessage: message,
          ...(surface.workflow ? {
            workflow: {
              ...surface.workflow,
              revision: surface.workflow.revision + 1,
              steps: surface.workflow.steps.map((step) =>
                step.stepId === surface.workflow!.currentStepId
                  ? { ...step, state: 'failed' as const, detail: message }
                  : step
              )
            }
          } : {}),
          ...(surface.progress ? {
            progress: { ...surface.progress, state: 'failed' as const, message }
          } : {}),
          actions: surface.actions.map((declared) => {
            if (declared.actionId === request.actionId) return { ...declared, enabled: false, reason: message };
            if (declared.actionId === 'restart-run' || declared.actionId === 'back-to-upload') {
              if (lifecycleFailure) return { ...declared, enabled: false, reason: message };
              return { ...declared, enabled: true, reason: '' };
            }
            return declared;
          })
        } satisfies DeclarativeFeatureSurface;
        this.runtimeSurfaces.set(head.featureId, failed);
        this.persistSurface(failed);
      }
      throw error;
    }
    if (result?.surfacePatch) {
      const clearFields = result.surfacePatch.clearFields;
      const clearable = new Set(['recorder', 'workflow', 'progress', 'issues', 'review', 'artifacts', 'editors']);
      if (clearFields !== undefined && (
        !Array.isArray(clearFields)
        || clearFields.length > clearable.size
        || new Set(clearFields).size !== clearFields.length
        || clearFields.some((field: unknown) => typeof field !== 'string' || !clearable.has(field))
      )) throw new AppError('FEATURE.SURFACE_PATCH_INVALID', 'Feature worker requested invalid Surface field clearing.');
      const patchedActions = Array.isArray(result.surfacePatch.actions)
        ? surface.actions.map((declared) => {
          const patch = result.surfacePatch.actions.find((candidate: Record<string, unknown>) => candidate?.actionId === declared.actionId);
          return patch ? {
            ...declared,
            enabled: patch.enabled === true,
            reason: typeof patch.reason === 'string' ? patch.reason : declared.reason,
            label: typeof patch.label === 'string' && patch.label ? patch.label : declared.label
          } : declared;
        })
        : surface.actions;
      const { clearFields: _clearFields, ...surfacePatch } = result.surfacePatch;
      const next = {
        ...surface,
        ...surfacePatch,
        schemaVersion: surface.schemaVersion,
        featureId: surface.featureId,
        featureVersion: surface.featureVersion,
        surfaceId: surface.surfaceId,
        stateVersion: surface.stateVersion + 1,
        actions: patchedActions
      } as DeclarativeFeatureSurface;
      // Lifecycle dispatch is part of the verified package declaration. A
      // Worker patch may change the referenced action's enabled/reason state,
      // but it cannot add, remove, or retarget the Shell lifecycle hook.
      if (surface.lifecycle) next.lifecycle = surface.lifecycle;
      else delete next.lifecycle;
      for (const field of clearFields || []) delete (next as unknown as Record<string, unknown>)[field];
      this.runtimeSurfaces.set(head.featureId, next);
      this.persistSurface(next);
    }
    if (result?.messageCard) {
      const message = result.messageCard as import('../../shared/feature-contracts.js').FeatureMessageCard;
      if (
        message.featureId !== head.featureId
        || message.featureVersion !== head.featureVersion
        || message.surfaceId !== surface.surfaceId
      ) throw new AppError('FEATURE.MESSAGE_IDENTITY_MISMATCH', 'Feature worker returned another message identity.');
      this.database.prepare(`
        INSERT INTO feature_runtime_messages(
          message_id, feature_id, feature_version, surface_id, state_version, payload_json, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          state_version=excluded.state_version, payload_json=excluded.payload_json, updated_at=excluded.updated_at
        WHERE excluded.state_version>feature_runtime_messages.state_version
      `).run(
        message.messageId, message.featureId, message.featureVersion, message.surfaceId,
        message.stateVersion, JSON.stringify(message), utcNow()
      );
    }
    return this.snapshot(context);
  }
}

export const _test = {
  activeOperationHandoff,
  abortExactOperationHandoff,
  assertDeclaredStorePort,
  assertCompatibleOperationHandoff,
  assertNoActiveOperationHandoff,
  commitExactOperationHandoff,
  completeAbortedOperationHandoff,
  completeFinalizedOperationHandoff,
  ensureOperationHandoffLedger,
  ensureExactSourceOperationRegistration,
  featurePythonSidecarPaths,
  finalizeExactOperationHandoff,
  finalizePreparedOperationHandoff,
  markOperationHandoffAbortPending,
  operationHandoffByToken,
  persistCommittedOperationHandoff,
  persistPreparedOperationHandoff,
  registerExactOperationHandoff,
  restoreExactCommittedOperationHandoff,
  resourceOwnerIdentity
};
