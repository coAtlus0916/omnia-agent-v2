import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DeclarativeFeatureSurface,
  FeatureArtifactDescriptor,
  FeatureArtifactInputRequest,
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
  canonicalJson,
  packageDigest,
  packageFile,
  verifyOfficialPackage,
  type OfficialPackageEnvelope
} from './official-package.js';
import { FeatureRuntimeStore } from './feature-runtime-store.js';
import { FeatureWorkerSupervisor } from './worker-supervisor.js';
import type { InteractionLogService } from '../services/interaction-log-service.js';

const PRODUCT_VERSION = '0.4.12';
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

interface InstalledFeaturePackage {
  manifest: FeatureManifest;
  surface: DeclarativeFeatureSurface;
  envelope: OfficialPackageEnvelope;
  root: string;
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
    ...(Object.hasOwn(value, 'assets') ? ['assets'] : [])
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
      'allScopesLabel', 'selectVisibleLabel', 'clearSelectionLabel', 'footerActionIds', 'primaryActionId'
    ], 'Declarative selection browser');
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
      || typeof action.enabled !== 'boolean'
      || typeof action.reason !== 'string'
      || (action.presentation !== undefined && !['default', 'record', 'pause', 'stop', 'export', 'refresh', 'restart', 'upload', 'file_input', 'background'].includes(action.presentation))
      || (action.selectionMode !== undefined && !['none', 'single', 'multiple'].includes(action.selectionMode))
    ) throw new Error('Declarative Feature action is invalid.');
    if (action.presentation === 'background' && action.effect === 'omnia_mutation') {
      throw new Error('Declarative Feature background actions cannot perform Omnia mutations.');
    }
    const actionKeys = ['actionId', 'label', 'effect', 'enabled', 'reason'];
    if (Object.hasOwn(action, 'presentation')) actionKeys.push('presentation');
    if (Object.hasOwn(action, 'selectionMode')) actionKeys.push('selectionMode');
    if (Object.hasOwn(action, 'dependencies')) actionKeys.push('dependencies');
    if (Object.hasOwn(action, 'canaryCapability')) actionKeys.push('canaryCapability');
    if (Object.hasOwn(action, 'input')) actionKeys.push('input');
    if (Object.hasOwn(action, 'output')) actionKeys.push('output');
    exactKeys(action, actionKeys, 'Declarative Feature action');
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
      exactKeys(action.input, ['kind', 'accept', 'label'], 'Declarative Feature action input');
      if (
        action.input.kind !== 'open_file'
        || !Array.isArray(action.input.accept)
        || action.input.accept.length < 1
        || action.input.accept.length > 8
        || action.input.accept.some((item) => typeof item !== 'string' || !/^\.[a-z0-9]{1,12}$/u.test(item))
        || typeof action.input.label !== 'string'
        || action.input.label.length < 1
        || action.input.label.length > 80
      ) throw new Error('Declarative Feature action input fields are invalid.');
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
    if (!['APP', 'DB', 'OS', 'TOOL'].includes(review.selectedKind)
      || typeof review.selectedRowKey !== 'string'
      || !Array.isArray(review.elementTypes) || review.elementTypes.length > 4
      || !Array.isArray(review.elements) || review.elements.length > 2_000
      || !Array.isArray(review.fields) || review.fields.length > 20_000
      || !Array.isArray(review.issueOrder) || review.issueOrder.length > 2_000) throw new Error('Declarative review fields are invalid.');
    const kinds = new Set<string>();
    for (const type of review.elementTypes) {
      exactKeys(type, ['kind', 'label', 'count', 'issueCount', 'warningCount', 'disabled', 'reason'], 'Declarative review element type');
      if (!['APP', 'DB', 'OS', 'TOOL'].includes(type.kind) || kinds.has(type.kind)
        || typeof type.label !== 'string' || type.label.length < 1 || type.label.length > 80
        || !Number.isSafeInteger(type.count) || type.count < 0
        || !Number.isSafeInteger(type.issueCount) || type.issueCount < 0
        || !Number.isSafeInteger(type.warningCount) || type.warningCount < 0
        || typeof type.disabled !== 'boolean' || typeof type.reason !== 'string' || type.reason.length > 500) throw new Error('Declarative review element type fields are invalid.');
      kinds.add(type.kind);
    }
    const rowKeys = new Set<string>();
    for (const element of review.elements) {
      exactKeys(element, ['rowKey', 'kind', 'elementId', 'label', 'sourceSheet', 'sourceRow', 'issueCount', 'warningCount', 'derivedDisplay', 'blocking', 'excluded'], 'Declarative review element');
      if (typeof element.rowKey !== 'string' || element.rowKey.length < 1 || rowKeys.has(element.rowKey)
        || !['APP', 'DB', 'OS', 'TOOL'].includes(element.kind)
        || typeof element.elementId !== 'string' || element.elementId.length > 200
        || typeof element.label !== 'string' || element.label.length < 1 || element.label.length > 500
        || typeof element.sourceSheet !== 'string' || element.sourceSheet.length > 200
        || !Number.isSafeInteger(element.sourceRow) || element.sourceRow < 0
        || !Number.isSafeInteger(element.issueCount) || element.issueCount < 0
        || !Number.isSafeInteger(element.warningCount) || element.warningCount < 0
        || typeof element.derivedDisplay !== 'string' || element.derivedDisplay.length > 500
        || typeof element.blocking !== 'boolean' || typeof element.excluded !== 'boolean') throw new Error('Declarative review element fields are invalid.');
      rowKeys.add(element.rowKey);
    }
    if (review.selectedRowKey && !rowKeys.has(review.selectedRowKey)) throw new Error('Declarative review selected row is invalid.');
    const fieldKeys = new Set<string>();
    for (const field of review.fields) {
      exactKeys(field, ['rowKey', 'kind', 'fieldKey', 'rawFieldKey', 'label', 'expectedRevision', 'inputKind', 'currentValue', 'allowedValues', 'required', 'maxLength', 'editable', 'message', 'sourceSheet', 'sourceRow', 'derivation'], 'Declarative review field');
      if (!rowKeys.has(field.rowKey) || !['APP', 'DB', 'OS', 'TOOL'].includes(field.kind)
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
      || (surface.selectionBrowser !== undefined && !['section', 'workspace', 'element_type'].includes(scope.kind))
      || (surface.selectionBrowser !== undefined && ![1, 2, 3].includes(scope.level))
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
    const parent = scope.parentId === null ? undefined : surface.scopes.find((candidate) => candidate.id === scope.parentId);
    if ((scope.level === 1 && (scope.parentId !== null || scope.kind !== 'section'))
      || (scope.level > 1 && (!parent || parent.level !== scope.level - 1))
      || (scope.level === 2 && scope.kind !== 'workspace')
      || (scope.level === 3 && scope.kind !== 'element_type')) {
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
  'recorder', 'workflow', 'progress', 'issues', 'review', 'artifacts', 'editors', 'clearFields'
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
  const { clearFields: _clearFields, actions: _actions, stateVersion: requestedStateVersion, ...surfacePatch } = patch;
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

function validateFeatureBundleContracts(envelope: OfficialPackageEnvelope, manifest: FeatureManifest): void {
  if(!manifest.contractsPath||!manifest.implementationMapPath||!manifest.testsManifestPath) throw new Error('Feature bundle contract extension is absent.');
  const runtime=parseJson(packageFile(envelope,manifest.contractsPath),'Feature runtime contract') as Record<string,unknown>;
  const mapping=parseJson(packageFile(envelope,manifest.implementationMapPath),'Feature implementation map') as Record<string,unknown>;
  const tests=parseJson(packageFile(envelope,manifest.testsManifestPath),'Feature tests manifest') as Record<string,unknown>;
  const vectors=parseJson(packageFile(envelope,'tests/vectors.json'),'Feature test vectors') as Record<string,unknown>;
  if(runtime?.schemaVersion!=='omnia.feature-runtime-contract/v1'||runtime.featureId!==manifest.featureId||runtime.featureVersion!==manifest.version
    ||!Array.isArray(runtime.inputs)||!Array.isArray(runtime.outputs)||!Array.isArray(runtime.events)||!Array.isArray(runtime.errors)||!Array.isArray(runtime.storePorts)) throw new Error('Feature runtime contract is invalid.');
  if(mapping?.schemaVersion!=='omnia.feature-implementation-map/v1'||mapping.featureId!==manifest.featureId||mapping.featureVersion!==manifest.version
    ||!mapping.planes||typeof mapping.planes!=='object'||Array.isArray(mapping.planes)) throw new Error('Feature implementation map is invalid.');
  const planes=mapping.planes as Record<string,unknown>;
  for(const plane of ['surface','worker','store','connector']) if(!Array.isArray(planes[plane])||(planes[plane] as unknown[]).length<1) throw new Error('Feature implementation map omits a required Plane.');
  if(tests?.schemaVersion!=='omnia.feature-tests-manifest/v1'||tests.featureId!==manifest.featureId||tests.featureVersion!==manifest.version
    ||!Array.isArray(tests.testIds)||(tests.testIds as unknown[]).length<1||tests.vectorsPath!=='tests/vectors.json'||tests.selfTestPath!=='tests/self-test.cjs'||tests.status!=='declared') throw new Error('Feature tests manifest is invalid.');
  if(vectors?.schemaVersion!=='omnia.feature-test-vectors/v1'||vectors.featureId!==manifest.featureId||!Array.isArray(vectors.vectors)||(vectors.vectors as unknown[]).length<1) throw new Error('Feature test vectors are invalid.');
  const ids=new Set((tests.testIds as unknown[]).map(String));
  if((vectors.vectors as Array<Record<string,unknown>>).some((vector)=>!ids.has(String(vector.testId||''))||!Object.hasOwn(vector,'expected'))) throw new Error('Feature test vectors differ from the signed test inventory.');
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

export class FeaturePackageManager {
  private selectedFeatureId = '';
  private readonly supervisors = new Map<string, FeatureWorkerSupervisor>();
  private readonly runtimeSurfaces = new Map<string, DeclarativeFeatureSurface>();
  private readonly operationRegistrations = new Map<string, { sessionGeneration: number; packageDigest: string }>();
  private readonly installedPackages = new Map<string, { identity: string; value: InstalledFeaturePackage }>();
  private readonly pendingRuntimeEvents = new Set<string>();
  private readonly runtimeStore: FeatureRuntimeStore;

  constructor(
    private readonly database: DatabaseSync,
    private readonly paths: ProductPaths,
    private readonly faultInjector?: (point: 'after_immutable_move_before_activation') => void,
    private readonly runtime?: FeatureRuntimeDependencies,
    private readonly interactionLogs?: InteractionLogService
  ) {
    this.runtimeStore = new FeatureRuntimeStore(database, paths);
    fs.mkdirSync(path.join(paths.data, 'packages', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'packages', 'installed'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'features'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'documentation', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(paths.data, 'documentation', 'features'), { recursive: true });
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
    const { surface } = this.loadInstalled(head);
    if (surface.surfaceId !== request.surfaceId) throw new AppError('FEATURE.SURFACE_MISMATCH', 'Feature artifact surface drifted.');
    const action = surface.actions.find((candidate) => candidate.actionId === request.actionId);
    if (!action?.input || action.input.kind !== 'open_file') throw new AppError('FEATURE.INPUT_NOT_DECLARED', 'This action has no file input contract.');
    if (
      request.accept.length !== action.input.accept.length
      || request.accept.some((extension) => !action.input!.accept.includes(extension))
    ) throw new AppError('FEATURE.INPUT_CONTRACT_MISMATCH', 'Feature input accept list drifted.');
    if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) {
      throw new AppError('FEATURE.ARTIFACT_SIZE_INVALID', 'Feature input must be a non-empty file no larger than 64 MiB.');
    }
    if (typeof originalName !== 'string' || originalName !== path.basename(originalName) || originalName.length > 255) {
      throw new AppError('FEATURE.ARTIFACT_NAME_INVALID', 'Feature input name is invalid.');
    }
    const extension = path.extname(originalName).toLowerCase();
    if (!action.input.accept.includes(extension)) throw new AppError('FEATURE.ARTIFACT_TYPE_INVALID', 'Selected file type is not allowed.');
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
  } {
    const manifest = parseManifest(envelope);
    const surface = parseSurface(envelope, manifest);
    const documentationDigest = validateDocumentation(envelope, manifest);
    if (manifest.contractsPath || manifest.implementationMapPath || manifest.testsManifestPath) {
      validateFeatureBundleContracts(envelope, manifest);
    }
    const docs = parseJson(packageFile(envelope, 'docs/manifest.json'), 'Documentation manifest') as DocumentationManifest;
    const members = [...envelope.files.map((member) => member.path)].sort();
    const required = [...new Set([
      ...REQUIRED_FEATURE_MEMBERS,
      ...docs.documents.map((document) => document.path),
      ...(manifest.assets || []).map((asset) => asset.path),
      ...(manifest.contractsPath?[manifest.contractsPath]:[]),
      ...(manifest.implementationMapPath?[manifest.implementationMapPath]:[]),
      ...(manifest.testsManifestPath?[manifest.testsManifestPath,'tests/vectors.json','tests/self-test.cjs']:[])
    ])].sort();
    if (members.length !== required.length || members.some((member, index) => member !== required[index])) {
      throw new Error('Feature package member inventory is incomplete or contains undeclared files.');
    }
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
      this.installedPackages.delete(manifest.featureId);
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
    const value = { manifest, surface, envelope, root };
    this.installedPackages.set(head.featureId, { identity, value });
    return value;
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

  private async startRuntime(head: ActivationHead): Promise<void> {
    if (!this.runtime) throw new Error('Feature runtime dependencies are unavailable.');
    const installed = this.loadInstalled(head);
    if (installed.manifest.requiredIsolation !== 'process') {
      throw new Error('This legacy Feature package has no process runtime contract.');
    }
    const operationPackage = JSON.parse(
      fs.readFileSync(path.join(installed.root, installed.manifest.operationPackagePath), 'utf8')
    ) as unknown;
    const operationEnvelope = verifyOfficialPackage(operationPackage, 'omnia-connector-operation');
    const operationPackageDigest = packageDigest(operationEnvelope);
    const operationManifest = parseJson(packageFile(operationEnvelope, 'manifest.json'), 'Connector Operation manifest') as OperationManifest;
    const operationEffects = new Map(operationManifest.operations.map((operation) => [operation.operationId, operation.effect]));
    for (const key of this.operationRegistrations.keys()) {
      if (key.startsWith(`${head.featureId}|`)) this.operationRegistrations.delete(key);
    }
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
            const recording = () => this.runtime!.connector.recordingCommand({
              schemaVersion: 'omnia.v5.recording-command/v1',
              featureId: 'omnia.recording',
              featureVersion: context.featureVersion,
              kind: invocation.kind,
              connectorBinding: invocation.connectorBinding,
              ...(invocation.recordingId ? { recordingId: String(invocation.recordingId) } : {}),
              ...(Number.isSafeInteger(invocation.chunkIndex) ? { chunkIndex: Number(invocation.chunkIndex) } : {})
            });
            return this.interactionLogs ? this.interactionLogs.run({
              plane: 'connector', component: 'remote-operation', surface: 'feature.recording',
              action: String(invocation.kind || 'recording-command'), failurePoint: `connector.recording.${String(invocation.kind || 'unknown')}`,
              operationId: String(invocation.kind || ''), details: { featureId: context.featureId, featureVersion: context.featureVersion }
            }, recording, context.interactionContext) : recording();
          }
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
            const registration = await this.runtime!.connector.registerOperation({
              schemaVersion: 'omnia.operation-registration/v1',
              featureId: context.featureId,
              featureVersion: context.featureVersion,
              operationPackage
            });
            if (registration.packageDigest !== operationPackageDigest) {
              throw new AppError('FEATURE.OPERATION_REGISTRATION_DRIFT', 'Remote Connector registered another Operation package digest.');
            }
            this.operationRegistrations.set(registrationKey, { sessionGeneration, packageDigest: operationPackageDigest });
          }
          try {
            const operationId = String(invocation.operationId || '');
            const receiptContext = invocation.request?.receiptContext as Record<string, unknown> | undefined;
            const operationRequest = { ...(invocation.request as Record<string, unknown>) };
            delete operationRequest.receiptContext;
            const signedCommand = operationRequest.command as Record<string, any> | undefined;
            const mutationTarget = operationRequest.target as Record<string, any> | undefined;
            const mutationBinding = operationRequest.connectorBinding as Record<string, any> | undefined;
            const declaresDurableMutationProtocol = operationEffects.get(operationId) === 'omnia_mutation'
              && Boolean(signedCommand && mutationTarget && mutationBinding && String(operationRequest.planDigest || ''));
            if (declaresDurableMutationProtocol) {
              const commandRow = this.database.prepare(`
                SELECT c.operation_id,c.idempotency_key,c.plan_digest,c.request_digest,c.state,c.evidence_target_identity_key,
                  f.credential_digest,f.authority_instance_id,f.tenant_or_org_id,f.pack_id,f.engagement_id,
                  s.workspace_ids_json,s.global_enabled,s.global_workspace_ids_json,i.intended_revision_json,
                  EXISTS(SELECT 1 FROM feature_mutation_reservations mr WHERE mr.owner_command_id=c.command_id AND mr.lifecycle='active') AS owns_reservation
                FROM feature_commands c
                JOIN feature_runs r ON r.run_id=c.run_id
                JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id
                JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
                JOIN workspace_safety s ON s.singleton=1
                WHERE c.command_id=? AND r.feature_id=? AND r.feature_version=?
                ORDER BY f.created_at DESC LIMIT 1
              `).get(String(signedCommand?.commandId || ''),context.featureId,context.featureVersion) as Record<string,any>|undefined;
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
            const invokeRemote = () => this.runtime!.connector.invokeOperation({
              schemaVersion: 'omnia.operation-invocation/v1',
              featureId: context.featureId,
              featureVersion: context.featureVersion,
              operationId,
              request: operationRequest,
              operationPackageDigest,
              mutationAuthorized: operationEffects.get(operationId) === 'omnia_mutation' && context.allowMutation
            });
            const semanticStage = operationId.includes('.preflight.') ? 'preflight'
              : operationId.includes('.reconcile.') ? 'reconcile'
                : operationId.includes('.readback.') || operationId.includes('.read.') ? 'readback'
                  : operationEffects.get(operationId) === 'omnia_mutation' ? 'execute' : 'read';
            const command = operationRequest.command as Record<string, unknown> | undefined;
            const response = this.interactionLogs ? await this.interactionLogs.run({
              plane: 'connector', component: 'signed-operation', surface: `feature.${context.featureId}`,
              action: semanticStage, failurePoint: `connector.operation.${semanticStage}.${operationId}`,
              operationId, runId: String(receiptContext?.runId || ''), commandId: String(command?.commandId || receiptContext?.commandId || ''),
              requestId: String(command?.idempotencyKey || ''),
              details: { featureId: context.featureId, featureVersion: context.featureVersion, operationId,
                effect: operationEffects.get(operationId) || 'read_only', runId: receiptContext?.runId,
                commandId: command?.commandId, sessionGeneration }
            }, invokeRemote, context.interactionContext) : await invokeRemote();
            if (receiptContext !== undefined) {
              if (operationEffects.get(operationId) !== 'read_only') {
                throw new AppError('FEATURE.RECEIPT_EFFECT_INVALID', 'Only signed read-only Operations may issue authoritative receipts.');
              }
              const runId = String(receiptContext.runId || '');
              const commandId = String(receiptContext.commandId || '');
              const receiptBinding = operationRequest.connectorBinding as Record<string, unknown> | undefined;
              const target = operationRequest.target as Record<string, unknown> | undefined;
              const receiptRow = this.database.prepare(`
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
                WHERE c.command_id=? AND c.run_id=? AND r.feature_id=? AND r.feature_version=?
                ORDER BY f.created_at DESC LIMIT 1
              `).get(commandId, runId, context.featureId, context.featureVersion) as Record<string, any> | undefined;
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
              this.database.prepare(`
                INSERT INTO feature_operation_receipts(
                  receipt_id,run_id,command_id,feature_id,feature_version,operation_package_digest,operation_id,
                  authority_digest,connector_id,session_generation,engagement_id,
                  authority_instance_id,tenant_or_org_id,pack_id,frozen_target_key,target_identity_key,
                  workspace_ids_json,plan_digest,request_digest,response_digest,response_json,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              `).run(
                receiptId, runId, commandId, context.featureId, context.featureVersion, operationPackageDigest, operationId,
                authorityDigest, String(receiptBinding.connectorId), Number(receiptBinding.sessionGeneration),
                String(receiptBinding.engagementId), String(receiptBinding.authorityInstanceId),
                String(receiptBinding.tenantOrOrgId), String(receiptBinding.packId),
                String(receiptRow.target_key), targetIdentityKey,
                canonicalJson(workspaceIds), String(receiptRow.plan_digest),
                exactRequestDigest,
                crypto.createHash('sha256').update(responseJson).digest('hex'), responseJson, utcNow()
              );
              return { ...(response as Record<string, unknown>), __operationReceiptId: receiptId };
            }
            return response;
          } catch (error) {
            const code = error instanceof AppError ? error.code : String((error as any)?.code || '');
            if (operationEffects.get(String(invocation.operationId || '')) === 'omnia_mutation' && context.allowMutation && [
              'REMOTE.MUTATION_UNCERTAIN',
              'REMOTE.CONNECTOR_DISCONNECTED',
              'REMOTE.IN_FLIGHT_DISCONNECTED'
            ].includes(code)) {
              throw new AppError(
                'CONNECTOR.RESPONSE_LOST',
                'Remote mutation 的响应或连接已丢失；effect 状态未知，禁止自动重放，只允许只读 reconcile。'
              );
            }
            throw error;
          }
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
    const old = this.supervisors.get(head.featureId);
    this.supervisors.set(head.featureId, supervisor);
    if (old) await old.stop();
    this.runtimeSurfaces.set(head.featureId, restored);
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

  private runtimeBlockReason(head: ActivationHead): string {
    if (!head.runtimeEnabled) return head.runtimeReason;
    return '';
  }

  private actionBlockReason(
    head: ActivationHead,
    action: import('../../shared/feature-contracts.js').DeclarativeFeatureAction,
    context?: FeatureRuntimeContext
  ): string {
    const runtimeReason = this.runtimeBlockReason(head);
    if (runtimeReason) return runtimeReason;
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
    const { surface: installedSurface } = this.loadInstalled(head);
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
          actions: current.actions.map((action) => ({
            ...action,
            enabled: !this.actionBlockReason(head, action, context) && action.enabled,
            reason: this.actionBlockReason(head, action, context) || action.reason
          }))
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
    const blockReason = this.actionBlockReason(head, action, context);
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
      ...(this.interactionLogs?.current() ? { interactionContext: this.interactionLogs.current()! } : {})
    }) as Promise<Record<string, any>>;
    const result = this.interactionLogs ? await this.interactionLogs.run({
      plane: 'middle', component: 'feature-worker', surface: request.surfaceId, action: request.actionId,
      failurePoint: `feature-worker.${request.featureId}.${request.actionId}`,
      runId: String(request.payload.runId || ''), commandId: String(request.payload.commandId || ''),
      details: { featureId: request.featureId, featureVersion: request.featureVersion, surfaceId: request.surfaceId,
        actionId: request.actionId, expectedStateVersion: request.expectedStateVersion, runId: request.payload.runId,
        commandId: request.payload.commandId, effect: action.effect }
    }, invokeWorker) : await invokeWorker();
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
