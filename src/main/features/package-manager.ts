import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DeclarativeFeatureSurface,
  FeatureActionRequest,
  FeatureNavigationGroup,
  FeatureNavigationLeaf,
  FeatureRuntimeSnapshot
} from '../../shared/feature-contracts.js';
import { AppError } from '../../shared/errors.js';
import type { ProductPaths } from '../paths.js';
import type { ConnectionSnapshot, WorkspaceSafetySnapshot } from '../../shared/contracts.js';
import type { ConnectorTransport } from '../connector/connector-transport.js';
import {
  packageDigest,
  packageFile,
  verifyOfficialPackage,
  type OfficialPackageEnvelope
} from './official-package.js';
import { FeatureRuntimeStore } from './feature-runtime-store.js';
import { FeatureWorkerSupervisor } from './worker-supervisor.js';

const PRODUCT_VERSION = '0.4.1';
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
  routes: Array<{
    stepId: string;
    method: 'GET' | 'POST' | 'PATCH';
    routeTemplate: string;
    parameters?: Array<{ name: string; type: 'guid' | 'string' }>;
    bodyMode: 'none' | 'single_id_array' | 'information_search' | 'parameter_array';
    bodyParameter?: string;
  }>;
}

interface OperationManifest {
  schemaVersion: 'omnia.connector-operation-manifest/v1';
  packageId: string;
  version: string;
  sequence: number;
  featureId: string;
  operations: OperationDescriptor[];
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
}

export interface FeatureRuntimeDependencies {
  connector: ConnectorTransport;
  workerHostEntrypoint: string;
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
    'navigation'
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
  exactKeys(manifest.navigation, ['groups', 'leaves'], 'Feature navigation');
  if (!Array.isArray(manifest.navigation.groups) || !Array.isArray(manifest.navigation.leaves)) {
    throw new Error('Feature navigation arrays are invalid.');
  }
  if (
    manifest.navigation.groups.length < 1
    || manifest.navigation.groups.length > 12
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
    if (
      allNavigationIds.has(leaf.id)
      || !parent
      || (leaf.level === 2 && parent.level !== 1)
      || (leaf.level === 3 && parent.level !== 2)
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
  return manifest;
}

function parseSurface(envelope: OfficialPackageEnvelope, manifest: FeatureManifest): DeclarativeFeatureSurface {
  const value = parseJson(packageFile(envelope, manifest.surfacePath), 'Declarative Feature surface');
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
    'actions'
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
  ) throw new Error('Declarative Feature surface contract is invalid.');
  for (const action of surface.actions) {
    if (
      !action
      || typeof action !== 'object'
      || Array.isArray(action)
      || typeof action.actionId !== 'string'
      || typeof action.label !== 'string'
      || !['read_only', 'local_state_write', 'omnia_mutation'].includes(action.effect)
      || typeof action.enabled !== 'boolean'
      || typeof action.reason !== 'string'
      || (action.selectionMode !== undefined && !['none', 'single', 'multiple'].includes(action.selectionMode))
    ) throw new Error('Declarative Feature action is invalid.');
    exactKeys(action, Object.hasOwn(action, 'selectionMode')
      ? ['actionId', 'label', 'effect', 'enabled', 'reason', 'selectionMode']
      : ['actionId', 'label', 'effect', 'enabled', 'reason'], 'Declarative Feature action');
  }
  if (
    surface.title.length < 1
    || surface.title.length > 100
    || surface.description.length > 500
    || surface.statusMessage.length > 500
    || surface.search.length > 200
    || surface.scopes.length > 100
    || surface.items.length > 2_000
    || surface.selectedItemIds.length > 2_000
    || surface.actions.length > 20
  ) throw new Error('Declarative Feature surface exceeds product limits.');
  const scopeIds = new Set<string>();
  for (const scope of surface.scopes) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('Declarative Feature scope is invalid.');
    exactKeys(scope, ['id', 'parentId', 'label', 'parentLabel', 'selected'], 'Declarative Feature scope');
    if (
      typeof scope.id !== 'string'
      || scope.id.length < 1
      || scope.id.length > 200
      || scopeIds.has(scope.id)
      || typeof scope.parentId !== 'string'
      || scope.parentId.length < 1
      || scope.parentId.length > 200
      || typeof scope.label !== 'string'
      || scope.label.length < 1
      || scope.label.length > 120
      || typeof scope.parentLabel !== 'string'
      || scope.parentLabel.length < 1
      || scope.parentLabel.length > 120
      || typeof scope.selected !== 'boolean'
    ) throw new Error('Declarative Feature scope fields are invalid.');
    scopeIds.add(scope.id);
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
  return surface;
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
  for (const document of docs.documents) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Documentation entry is invalid.');
    exactKeys(document, ['path', 'sha256', 'purpose'], 'Documentation entry');
    if (
      !['docs/FEATURE.md', 'docs/IMPLEMENTATION_MAP.md'].includes(document.path)
      || !/^[0-9a-f]{64}$/u.test(document.sha256)
      || typeof document.purpose !== 'string'
      || crypto.createHash('sha256').update(packageFile(envelope, document.path)).digest('hex') !== document.sha256
    ) throw new Error('Documentation entry digest or path is invalid.');
  }
  return crypto.createHash('sha256').update(packageFile(envelope, 'docs/manifest.json')).digest('hex');
}

function validateOperationPackage(input: unknown, featureManifest: FeatureManifest): void {
  const envelope = verifyOfficialPackage(input, 'omnia-connector-operation');
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
  exactKeys(raw, ['schemaVersion', 'packageId', 'version', 'sequence', 'featureId', 'operations'], 'Connector Operation manifest');
  const manifest = raw as OperationManifest;
  if (
    manifest.schemaVersion !== 'omnia.connector-operation-manifest/v1'
    || manifest.packageId !== envelope.packageId
    || manifest.version !== envelope.version
    || manifest.sequence !== envelope.sequence
    || manifest.featureId !== featureManifest.featureId
    || !Array.isArray(manifest.operations)
    || manifest.operations.length < 1
    || manifest.operations.length > 32
  ) throw new Error('Connector Operation manifest identity is invalid.');
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
        || !['none', 'single_id_array', 'information_search', 'parameter_array'].includes(route.bodyMode)
        || (route.bodyMode !== 'none' && route.method !== 'POST')
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
  const policy = parseJson(packageFile(envelope, 'operation/policy.json'), 'Connector Operation policy');
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

function readEnvelope(filename: string): unknown {
  const stats = fs.statSync(filename);
  if (!stats.isFile() || stats.size < 1 || stats.size > 96 * 1024 * 1024) {
    throw new Error('Official package file size is invalid.');
  }
  return JSON.parse(fs.readFileSync(filename, 'utf8')) as unknown;
}

export class FeaturePackageManager {
  private selectedFeatureId = '';
  private readonly supervisors = new Map<string, FeatureWorkerSupervisor>();
  private readonly runtimeSurfaces = new Map<string, DeclarativeFeatureSurface>();
  private readonly pendingRuntimeEvents = new Set<string>();
  private readonly runtimeStore: FeatureRuntimeStore;

  constructor(
    private readonly database: DatabaseSync,
    private readonly paths: ProductPaths,
    private readonly faultInjector?: (point: 'after_immutable_move_before_activation') => void,
    private readonly runtime?: FeatureRuntimeDependencies
  ) {
    this.runtimeStore = new FeatureRuntimeStore(database, paths);
    fs.mkdirSync(path.join(paths.data, 'packages', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'packages', 'installed'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'features'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'documentation', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'documentation', 'features'), { recursive: true });
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
    for (const memberPath of ['docs/manifest.json', 'docs/FEATURE.md', 'docs/IMPLEMENTATION_MAP.md']) {
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
  } {
    const members = [...envelope.files.map((member) => member.path)].sort();
    const required = [...REQUIRED_FEATURE_MEMBERS].sort();
    if (members.length !== required.length || members.some((member, index) => member !== required[index])) {
      throw new Error('Feature package member inventory is incomplete or contains undeclared files.');
    }
    const manifest = parseManifest(envelope);
    const surface = parseSurface(envelope, manifest);
    const documentationDigest = validateDocumentation(envelope, manifest);
    parsePrivateMigration(envelope, manifest.storeNamespace);
    const operationInput = parseJson(packageFile(envelope, manifest.operationPackagePath), 'Connector Operation package');
    validateOperationPackage(operationInput, manifest);
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
    return { manifest, surface, documentationDigest };
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
      const { manifest, documentationDigest } = this.validate(envelope);
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
      const runtimePendingReason = manifest.requiredIsolation === 'process'
        ? '安装完成；启动 Omnia Agent v5 Shell 后将自动加载 Feature 运行时。'
        : 'Legacy Feature package requires an unavailable runtime contract.';
      const initialHealth = manifest.requiredIsolation === 'process' ? 'pending_start' : 'legacy_runtime_unavailable';
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        this.database.prepare(`
          UPDATE feature_registry SET lifecycle='previous'
          WHERE feature_id=? AND feature_version<>?
        `).run(manifest.featureId, manifest.version);
        this.database.prepare(`
          UPDATE documentation_registry SET lifecycle='previous'
          WHERE feature_id=? AND feature_version<>?
        `).run(manifest.featureId, manifest.version);
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
        this.database.prepare(`
          INSERT INTO feature_publisher_sequences(feature_id, highest_sequence, updated_at)
          VALUES(?, ?, ?)
          ON CONFLICT(feature_id) DO UPDATE SET
            highest_sequence=MAX(highest_sequence, excluded.highest_sequence), updated_at=excluded.updated_at
        `).run(manifest.featureId, manifest.sequence, now);
        this.database.prepare(`
          UPDATE feature_install_attempts
          SET status='completed', completed_at=?, reason_code='', reason=''
          WHERE attempt_id=?
        `).run(now, attemptId);
        this.database.exec('COMMIT;');
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw error;
      }
      return {
        attemptId,
        featureId: manifest.featureId,
        featureVersion: manifest.version,
        packageDigest: digest,
        documentationPath,
        activationGeneration: generation,
        runtimeEnabled: false,
        runtimeReason: runtimePendingReason,
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
    const now = utcNow();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
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

  private loadInstalled(head: ActivationHead): {
    manifest: FeatureManifest;
    surface: DeclarativeFeatureSurface;
    envelope: OfficialPackageEnvelope;
    root: string;
  } {
    const root = path.resolve(this.paths.data, ...head.packagePath.split('/'));
    const installedRoot = path.resolve(this.paths.data, 'packages', 'installed');
    if (!root.startsWith(`${installedRoot}${path.sep}`)) {
      throw new AppError('FEATURE.PACKAGE_PATH_INVALID', 'The Feature activation path escaped the immutable package root.');
    }
    const envelope = verifyOfficialPackage(
      JSON.parse(fs.readFileSync(path.join(root, '.official-package-envelope.json'), 'utf8')) as unknown,
      'omnia-feature'
    );
    if (packageDigest(envelope) !== head.packageDigest) {
      throw new AppError('FEATURE.PACKAGE_INTEGRITY', 'The active Feature package digest changed.');
    }
    const manifest = parseManifest(envelope);
    const surface = parseSurface(envelope, manifest);
    return { manifest, surface, envelope, root };
  }

  async initializeRuntime(): Promise<void> {
    if (!this.runtime) return;
    for (const head of this.list()) {
      const existing = this.supervisors.get(head.featureId);
      if (existing) {
        await existing.stop();
        this.supervisors.delete(head.featureId);
      }
      try {
        await this.startRuntime(head);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Feature runtime startup failed.';
        this.database.prepare(`
          UPDATE feature_activation_heads SET runtime_enabled=0, runtime_reason=?, updated_at=? WHERE feature_id=?
        `).run(reason, utcNow(), head.featureId);
        this.database.prepare(`
          UPDATE feature_registry SET lifecycle='candidate', health='worker_start_failed'
          WHERE feature_id=? AND feature_version=?
        `).run(head.featureId, head.featureVersion);
      }
    }
  }

  async disposeRuntime(): Promise<void> {
    await Promise.allSettled([...this.supervisors.values()].map((supervisor) => supervisor.stop()));
    this.supervisors.clear();
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

  private async startRuntime(head: ActivationHead): Promise<void> {
    if (!this.runtime) throw new Error('Feature runtime dependencies are unavailable.');
    const installed = this.loadInstalled(head);
    if (installed.manifest.requiredIsolation !== 'process') {
      throw new Error('This legacy Feature package has no process runtime contract.');
    }
    const operationPackage = JSON.parse(
      fs.readFileSync(path.join(installed.root, installed.manifest.operationPackagePath), 'utf8')
    ) as unknown;
    const registration = await this.runtime.connector.registerOperation({
      schemaVersion: 'omnia.operation-registration/v1',
      featureId: head.featureId,
      featureVersion: head.featureVersion,
      operationPackage
    });
    const supervisor = new FeatureWorkerSupervisor(
      this.runtime.workerHostEntrypoint,
      path.join(installed.root, installed.manifest.workerPath),
      head.featureId,
      head.featureVersion,
      {
        connectorInvoke: async (input, context) => {
          const invocation = input as Record<string, any>;
          if (invocation?.schemaVersion === 'omnia.v5.recording-command/v1') {
            if (context.featureId !== 'omnia.recording' || invocation.featureId !== context.featureId || invocation.featureVersion !== context.featureVersion) {
              throw new AppError('FEATURE.RECORDING_IDENTITY_MISMATCH', 'Recording command identity is invalid.');
            }
            return this.runtime!.connector.recordingCommand({
              schemaVersion: 'omnia.v5.recording-command/v1',
              featureId: 'omnia.recording',
              featureVersion: context.featureVersion,
              kind: invocation.kind,
              connectorBinding: invocation.connectorBinding,
              ...(invocation.recordingId ? { recordingId: String(invocation.recordingId) } : {})
            });
          }
          if (
            invocation?.schemaVersion !== 'omnia.operation-invocation/v1'
            || invocation.featureId !== context.featureId
            || invocation.featureVersion !== context.featureVersion
          ) throw new AppError('FEATURE.OPERATION_IDENTITY_MISMATCH', 'Feature Operation identity is invalid.');
          return this.runtime!.connector.invokeOperation({
            schemaVersion: 'omnia.operation-invocation/v1',
            featureId: context.featureId,
            featureVersion: context.featureVersion,
            operationId: String(invocation.operationId || ''),
            request: invocation.request as Record<string, unknown>,
            operationPackageDigest: registration.packageDigest,
            mutationAuthorized: context.allowMutation
          });
        },
        storeCall: async (method, input, context) => this.runtimeStore.call(method, input, context),
        emitEvent: async (input, context) => {
          const eventId = this.runtimeStore.emit(input, context);
          this.pendingRuntimeEvents.add(eventId);
          return eventId;
        }
      }
    );
    await supervisor.start();
    const health = await supervisor.invoke('health', null, { timeoutMs: 10_000 }) as Record<string, unknown>;
    if (
      health?.ready !== true
      || health.featureId !== head.featureId
      || health.featureVersion !== head.featureVersion
    ) throw new Error('Feature worker health identity is invalid.');
    const old = this.supervisors.get(head.featureId);
    this.supervisors.set(head.featureId, supervisor);
    if (old) await old.stop();
    this.runtimeSurfaces.set(head.featureId, installed.surface);
    const now = utcNow();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare(`
        UPDATE feature_activation_heads SET runtime_enabled=1, runtime_reason='', updated_at=? WHERE feature_id=?
      `).run(now, head.featureId);
      this.database.prepare(`
        UPDATE feature_registry SET lifecycle='active', health='ready', activated_at=?
        WHERE feature_id=? AND feature_version=?
      `).run(now, head.featureId, head.featureVersion);
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

  private runtimeBlockReason(head: ActivationHead, context?: FeatureRuntimeContext): string {
    if (!head.runtimeEnabled) return head.runtimeReason;
    if (!context) return '';
    if (head.featureId === 'omnia.recording') {
      if (!context.connection.connected) return '请先连接 Omnia Pack。';
      if (!context.connection.sessionGeneration || context.connection.sessionGeneration < 1) return 'Connector 会话标识不可用，请重新连接。';
      return '';
    }
    if (context.connection.transport === 'remote') return 'Remote Connector Operation host 尚未发布；请切换为本地连接。';
    if (!context.connection.connected) return '请先连接 Omnia Pack。';
    if (!context.connection.sessionGeneration || context.connection.sessionGeneration < 1) return 'Connector 会话标识不可用，请重新连接。';
    if (!context.safetyLock.enabled || !context.safetyLock.validForCurrentConnection) {
      return context.safetyLock.invalidReason || '请先启用当前 Pack 的安全锁。';
    }
    return '';
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
      const blockReason = this.runtimeBlockReason(head, context);
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
          actions: current.actions.map((action) => ({
            ...action,
            enabled: !blockReason && action.enabled,
            reason: blockReason || action.reason
          }))
        };
      }
    }
    const cards = this.messageCards().map((card) => {
      const head = heads.find((item) => item.featureId === card.featureId);
      const reason = head ? this.runtimeBlockReason(head, context) : 'Feature is not active.';
      return {
        ...card,
        actions: card.actions.map((action) => ({
          ...action,
          enabled: !reason && action.enabled,
          reason: reason || action.reason
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
    const { surface: installedSurface } = this.loadInstalled(head);
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
      this.runtimeSurfaces.set(head.featureId, {
        ...surface,
        stateVersion: surface.stateVersion + 1,
        selectedItemIds: [...selectedItemIds]
      });
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
    const blockReason = this.runtimeBlockReason(head, context);
    if (blockReason || !action.enabled) throw new AppError('FEATURE.RUNTIME_DISABLED', blockReason || action.reason);
    const supervisor = this.supervisors.get(request.featureId);
    if (!supervisor) throw new AppError('FEATURE.WORKER_UNAVAILABLE', 'Feature worker is not running.', true);
    const selectionMode = action.selectionMode || 'none';
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
    const result = await supervisor.invoke('handleAction', {
      actionId: request.actionId,
      expectedStateVersion: request.expectedStateVersion,
      payload: request.payload,
      context: {
        connectorBinding: {
          connectorId: context.connection.connectorId,
          sessionGeneration: context.connection.sessionGeneration,
          engagementId: context.connection.engagementId
        },
        safetyLock: context.safetyLock
      }
    }, { allowMutation: action.effect === 'omnia_mutation' }) as Record<string, any>;
    if (result?.surfacePatch) {
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
      const next = {
        ...surface,
        ...result.surfacePatch,
        schemaVersion: surface.schemaVersion,
        featureId: surface.featureId,
        featureVersion: surface.featureVersion,
        surfaceId: surface.surfaceId,
        stateVersion: surface.stateVersion + 1,
        actions: patchedActions
      } as DeclarativeFeatureSurface;
      this.runtimeSurfaces.set(head.featureId, next);
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
      `).run(
        message.messageId, message.featureId, message.featureVersion, message.surfaceId,
        message.stateVersion, JSON.stringify(message), utcNow()
      );
    }
    return this.snapshot(context);
  }
}
