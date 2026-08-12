import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { canonicalJson, packageDigest, packageFile, verifyOfficialPackage } from '../main/features/official-package.js';
import type {
  ConnectorBinding,
  OperationRegistrationAbortRequest,
  OperationRegistrationCommand,
  OperationRegistrationCommitRequest,
  OperationRegistrationFinalizeRequest,
  OperationInvocationRequest,
  OperationRegistrationResult
} from '../shared/operation-contracts.js';
import { assertConnectorDeliveryContext } from '../shared/connector-delivery.js';
import { CURRENT_PACK_PAGE_OBSERVATION_POLICY } from '../shared/page-observation-contracts.js';
import { isGuid } from './omnia-origin.js';
import {
  MANAGED_STREAM_FROZEN_TTL_MS,
  ManagedStreamHost,
  type ManagedStreamOwner
} from './managed-stream-host.js';
import { PageObservationHost, type PageObservationContext } from './page-observation-host.js';

type Route = {
  stepId: string;
  method: 'GET' | 'POST' | 'PATCH';
  routeTemplate: string;
  parameters: Array<{ name: string; type: 'guid' | 'string' }>;
  bodyMode: 'none' | 'parameter_array' | 'signed_json';
  bodyParameter: string;
};
type Descriptor = {
  operationId: string;
  effect: 'read_only' | 'omnia_mutation';
  requestSchema: string;
  responseSchema: string;
  enabledByDefault: boolean;
  grantsMutationPermit: boolean;
  permitsOperationId?: string;
  routes: Route[];
};
type ResourceOwnerClaim = {
  schemaVersion: 'omnia.operation-resource-owner/v1';
  ownerId: string;
  compatibilityVersion: number;
  capabilities: string[];
  compatibleSourcePackageDigests: string[];
};
type Registered = {
  featureId: string;
  featureVersion: string;
  packageId: string;
  packageSequence: number;
  digest: string;
  capabilityFingerprint: string;
  operations: Map<string, Descriptor>;
  resourceOwner: ResourceOwnerClaim | null;
  run(operationId: string, input: Record<string, unknown>, sdk: object): Promise<unknown>;
};
type RegistrationTransaction = {
  token: string;
  bindingKey: string;
  featureId: string;
  featureVersion: string;
  packageDigest: string;
  packageSequence: number;
  replacedPackageDigests: string[];
  expiresAt: number;
  result: OperationRegistrationResult;
  registered: Registered;
  finalized: boolean;
};
type DurableRegistrationTransaction = {
  schemaVersion: 'omnia.operation-registration-ledger/v1';
  token: string;
  featureId: string;
  featureVersion: string;
  packageId: string;
  packageDigest: string;
  packageSequence: number;
  capabilityFingerprint: string;
  operationIds: string[];
  replacedPackageDigests: string[];
  binding: ConnectorBinding;
  phase: 'prepared' | 'committed' | 'finalized' | 'aborted';
  committedAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

const FORBIDDEN_INPUT = new Set(['url', 'method', 'headers', 'body', 'route', 'path']);

function signedJsonBody(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 16) throw new Error('Signed Operation JSON body exceeds the nesting limit.');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (Array.isArray(current)) {
      if (current.length > 2_000) throw new Error('Signed Operation JSON array exceeds the item limit.');
      return current.map((item) => visit(item, depth + 1));
    }
    if (!current || typeof current !== 'object' || Object.prototype.toString.call(current) !== '[object Object]') {
      throw new Error('Signed Operation body must contain only JSON values.');
    }
    if (seen.has(current)) throw new Error('Signed Operation JSON body cannot contain cycles.');
    seen.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Reflect.ownKeys(current).some((key) => typeof key !== 'string')
      || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
      throw new Error('Signed Operation JSON body cannot contain symbols or accessors.');
    }
    const entries = Object.entries(current);
    if (entries.length > 500) throw new Error('Signed Operation JSON object exceeds the property limit.');
    return Object.fromEntries(entries.map(([key, item]) => {
      if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(key)) throw new Error('Signed Operation JSON property name is invalid.');
      return [key, visit(item, depth + 1)];
    }));
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024) throw new Error('Signed Operation JSON body exceeds 256 KiB.');
  return result;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unknown or missing fields.`);
  }
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, any>;
}

function loadHandler(source: string): Registered['run'] {
  const module = { exports: {} as any };
  let nextTimerId = 1;
  const timers = new Map<number, NodeJS.Timeout>();
  const sandboxSetTimeout = (callback: unknown, delay: unknown, ...args: unknown[]): number => {
    if (typeof callback !== 'function' || !Number.isFinite(Number(delay))) throw new Error('Signed Operation timer is invalid.');
    if (timers.size >= 128) throw new Error('Signed Operation timer limit exceeded.');
    const timerId = nextTimerId++;
    const boundedDelay = Math.max(0, Math.min(30_000, Math.trunc(Number(delay))));
    const timer = setTimeout(() => {
      timers.delete(timerId);
      callback(...args);
    }, boundedDelay);
    timers.set(timerId, timer);
    return timerId;
  };
  const sandboxClearTimeout = (timerId: unknown): void => {
    if (!Number.isSafeInteger(timerId)) return;
    const timer = timers.get(Number(timerId));
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(Number(timerId));
  };
  const context = vm.createContext({
    module,
    exports: module.exports,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Promise,
    Map,
    Set,
    structuredClone,
    setTimeout: sandboxSetTimeout,
    clearTimeout: sandboxClearTimeout
  });
  const script = new vm.Script(`'use strict';\n${source}`, { filename: 'signed-operation-handler.cjs' });
  script.runInContext(context, { timeout: 1_000 });
  if (typeof module.exports.createOperationHandler !== 'function') {
    throw new Error('Signed Operation handler must export createOperationHandler().');
  }
  const handler = module.exports.createOperationHandler();
  if (!handler || typeof handler.run !== 'function') throw new Error('Signed Operation handler does not expose run().');
  return handler.run.bind(handler);
}

export class OperationHost {
  private readonly registered = new Map<string, Registered>();
  private readonly permits = new Map<string, { expiresAt: number; consumed: boolean }>();
  private readonly managedStreams: ManagedStreamHost;
  private readonly pageObservations: PageObservationHost;
  private readonly preparedRegistrations = new Map<string, RegistrationTransaction>();
  private readonly committedRegistrations = new Map<string, RegistrationTransaction>();
  private readonly durableRegistrations = new Map<string, DurableRegistrationTransaction>();
  private readonly registrationLedgerRoot: string;
  private registrationLedgerCorrupt = false;

  constructor(managedStreamRoot = path.join(os.tmpdir(), `omnia-v5-operation-streams-${process.pid}-${crypto.randomUUID()}`)) {
    this.managedStreams = new ManagedStreamHost(managedStreamRoot);
    this.pageObservations = new PageObservationHost(this.managedStreams);
    this.registrationLedgerRoot = path.join(managedStreamRoot, 'operation-registration-ledger');
    this.loadRegistrationLedger();
  }

  maintenanceSnapshot(): {
    state: 'known' | 'unknown';
    activeResources: number;
    pendingRegistrations: number;
    detail: Record<string, number>;
  } {
    const streams = this.managedStreams.maintenanceSnapshot();
    const observations = this.pageObservations.maintenanceSnapshot();
    const pendingRegistrationTokens = new Set([
      ...this.preparedRegistrations.keys(),
      ...[...this.committedRegistrations.entries()].filter(([, transaction]) => !transaction.finalized).map(([token]) => token),
      ...[...this.durableRegistrations.entries()].filter(([, transaction]) => (
        ['prepared', 'committed'].includes(transaction.phase)
      )).map(([token]) => token)
    ]);
    const pendingRegistrations = pendingRegistrationTokens.size;
    const state = this.registrationLedgerCorrupt || streams.integrityErrors > 0
      || streams.inventoryUnknownCount > 0 || observations.inventoryUnknownCount > 0 ? 'unknown' : 'known';
    const activeResources = streams.activeStreams + streams.pendingOwnerAdoptions
      + observations.activeObservations + observations.finishingObservations;
    return {
      state,
      activeResources,
      pendingRegistrations,
      detail: {
        activeStreams: streams.activeStreams,
        pendingOwnerAdoptions: streams.pendingOwnerAdoptions,
        activeObservations: observations.activeObservations,
        finishingObservations: observations.finishingObservations,
        integrityErrors: streams.integrityErrors,
        inventoryUnknownCount: streams.inventoryUnknownCount + observations.inventoryUnknownCount
      }
    };
  }

  register(input: OperationRegistrationCommand, binding: ConnectorBinding): OperationRegistrationResult {
    if (input?.schemaVersion === 'omnia.operation-registration-commit/v1') {
      return this.commitRegistration(input, binding);
    }
    if (input?.schemaVersion === 'omnia.operation-registration-finalize/v1') {
      return this.finalizeRegistration(input, binding);
    }
    if (input?.schemaVersion === 'omnia.operation-registration-abort/v1') {
      return this.abortRegistration(input, binding);
    }
    exactKeys(input, ['schemaVersion', 'featureId', 'featureVersion', 'operationPackage'], 'Operation registration');
    if (input.schemaVersion !== 'omnia.operation-registration/v1') throw new Error('Operation registration schema is invalid.');
    const bindingKey = this.registrationBindingKey(binding);
    if (this.registrationLedgerCorrupt) {
      throw new Error('Operation registration ledger failed integrity validation; registration is fail-closed.');
    }
    this.pruneRegistrationTransactions();
    const envelope = verifyOfficialPackage(input.operationPackage, 'omnia-connector-operation');
    const manifest = record(JSON.parse(packageFile(envelope, 'manifest.json').toString('utf8')), 'Operation manifest');
    exactKeys(manifest, [
      'schemaVersion', 'packageId', 'version', 'sequence', 'featureId', 'operations',
      ...(Object.hasOwn(manifest, 'resourceOwner') ? ['resourceOwner'] : [])
    ], 'Operation manifest');
    if (
      manifest.schemaVersion !== 'omnia.connector-operation-manifest/v1'
      || manifest.packageId !== envelope.packageId
      || manifest.version !== envelope.version
      || manifest.sequence !== envelope.sequence
      || manifest.featureId !== input.featureId
      || manifest.version !== input.featureVersion
      || !Array.isArray(manifest.operations)
    ) throw new Error('Operation manifest identity does not match the active Feature.');
    const digest = packageDigest(envelope);
    const handlerBytes = packageFile(envelope, 'operation/handler.cjs');
    const policyBytes = packageFile(envelope, 'operation/policy.json');
    const capabilityFingerprint = crypto.createHash('sha256').update(canonicalJson({
      publisherKeyId: envelope.publisher.keyId,
      featureId: manifest.featureId,
      packageId: manifest.packageId,
      operations: [...manifest.operations].sort((left, right) => (
        String(left?.operationId || '').localeCompare(String(right?.operationId || ''))
      )),
      handlerSha256: crypto.createHash('sha256').update(handlerBytes).digest('hex'),
      policySha256: crypto.createHash('sha256').update(policyBytes).digest('hex')
    })).digest('hex');
    let resourceOwner: ResourceOwnerClaim | null = null;
    if (Object.hasOwn(manifest, 'resourceOwner')) {
      const rawOwner = record(manifest.resourceOwner, 'Operation resource owner');
      exactKeys(rawOwner, [
        'schemaVersion', 'ownerId', 'compatibilityVersion', 'capabilities', 'compatibleSourcePackageDigests'
      ], 'Operation resource owner');
      if (rawOwner.schemaVersion !== 'omnia.operation-resource-owner/v1'
        || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(rawOwner.ownerId)
        || !Number.isSafeInteger(rawOwner.compatibilityVersion) || rawOwner.compatibilityVersion < 1
        || !Array.isArray(rawOwner.capabilities) || rawOwner.capabilities.length < 1 || rawOwner.capabilities.length > 16
        || rawOwner.capabilities.some((value: unknown, index: number) => (
          typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value)
          || (index > 0 && rawOwner.capabilities[index - 1] >= value)
        ))
        || !Array.isArray(rawOwner.compatibleSourcePackageDigests)
        || rawOwner.compatibleSourcePackageDigests.length > 16
        || rawOwner.compatibleSourcePackageDigests.some((value: unknown, index: number) => (
          typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value) || value === digest
          || (index > 0 && rawOwner.compatibleSourcePackageDigests[index - 1] >= value)
        ))) {
        throw new Error('Operation resource owner declaration is invalid.');
      }
      resourceOwner = {
        schemaVersion: rawOwner.schemaVersion,
        ownerId: rawOwner.ownerId,
        compatibilityVersion: rawOwner.compatibilityVersion,
        capabilities: [...rawOwner.capabilities],
        compatibleSourcePackageDigests: [...rawOwner.compatibleSourcePackageDigests]
      };
    }
    const operations = new Map<string, Descriptor>();
    for (const raw of manifest.operations) {
      const operation = record(raw, 'Operation descriptor') as Descriptor;
      exactKeys(operation, [
        'operationId', 'effect', 'requestSchema', 'responseSchema', 'enabledByDefault',
        'grantsMutationPermit', 'routes', ...(Object.hasOwn(operation, 'permitsOperationId') ? ['permitsOperationId'] : [])
      ], 'Operation descriptor');
      if (!Array.isArray(operation.routes) || operations.has(operation.operationId)) throw new Error('Operation descriptor is invalid.');
      for (const route of operation.routes) {
        exactKeys(route, ['stepId', 'method', 'routeTemplate', 'parameters', 'bodyMode', 'bodyParameter'], 'Operation route');
        if (!['GET', 'POST', 'PATCH'].includes(route.method) || !route.routeTemplate.startsWith('/')) {
          throw new Error('Operation route is invalid.');
        }
        if (!Array.isArray(route.parameters) || route.parameters.some((parameter) => {
          exactKeys(parameter, ['name', 'type'], 'Operation route parameter');
          return !/^[A-Za-z][A-Za-z0-9]*$/u.test(parameter.name) || !['guid', 'string'].includes(parameter.type);
        })) throw new Error('Operation route parameters are invalid.');
        if (!['none', 'parameter_array', 'signed_json'].includes(route.bodyMode)) throw new Error('Operation body mode is invalid.');
        if (route.bodyMode === 'parameter_array' && !route.parameters.some((value) => value.name === route.bodyParameter)) {
          throw new Error('Operation body parameter is not declared.');
        }
      }
      operations.set(operation.operationId, operation);
    }
    const mutationOperations = [...operations.values()].filter((operation) => operation.effect === 'omnia_mutation');
    for (const operation of operations.values()) {
      if (!operation.grantsMutationPermit) continue;
      if (!operation.permitsOperationId && mutationOperations.length === 1) operation.permitsOperationId = mutationOperations[0]!.operationId;
      if (!operation.permitsOperationId || operations.get(operation.permitsOperationId)?.effect !== 'omnia_mutation') {
        throw new Error('Preflight must bind its permit to one declared mutation Operation.');
      }
    }
    const previousOwners = [...this.registered.values()].filter((registered) => (
      registered.featureId === input.featureId && registered.digest !== digest
    ));
    const nextRegistered: Registered = {
      featureId: input.featureId,
      featureVersion: input.featureVersion,
      packageId: envelope.packageId,
      packageSequence: envelope.sequence,
      digest,
      capabilityFingerprint,
      operations,
      resourceOwner,
      run: loadHandler(handlerBytes.toString('utf8'))
    };
    this.assertRegistrationHighWater(nextRegistered, binding);
    const durable = [...this.durableRegistrations.values()].find((transaction) => (
      transaction.phase !== 'aborted'
      &&
      transaction.featureId === input.featureId
      && transaction.featureVersion === input.featureVersion
      && transaction.packageDigest === digest
      && this.sameStableBinding(transaction.binding, binding)
    ));
    if (durable) {
      this.assertDurableRegistrationMatches(durable, nextRegistered);
      const result = this.durableRegistrationResult(durable);
      const restored: RegistrationTransaction = {
        token: durable.token,
        bindingKey,
        featureId: durable.featureId,
        featureVersion: durable.featureVersion,
        packageDigest: durable.packageDigest,
        packageSequence: durable.packageSequence,
        replacedPackageDigests: [...durable.replacedPackageDigests],
        expiresAt: Number.MAX_SAFE_INTEGER,
        result,
        registered: nextRegistered,
        finalized: durable.phase === 'finalized'
      };
      if (durable.phase === 'prepared') {
        this.preparedRegistrations.set(durable.token, restored);
      } else {
        this.registered.set(digest, nextRegistered);
        this.committedRegistrations.set(durable.token, restored);
      }
      return result;
    }
    const exactCommittedTransaction = [...this.committedRegistrations.values()].find((transaction) => (
      transaction.bindingKey === bindingKey
      && transaction.featureId === input.featureId
      && transaction.featureVersion === input.featureVersion
      && transaction.packageDigest === digest
    ));
    if (exactCommittedTransaction) return exactCommittedTransaction.result;
    const sameDigest = this.registered.get(digest);
    if (sameDigest) {
      if (sameDigest.featureId !== nextRegistered.featureId
        || sameDigest.featureVersion !== nextRegistered.featureVersion
        || sameDigest.packageId !== nextRegistered.packageId
        || sameDigest.packageSequence !== nextRegistered.packageSequence) {
        throw new Error('Registered Operation digest identity is inconsistent.');
      }
      return this.committedResult(nextRegistered, []);
    }
    const pendingSource = [...this.committedRegistrations.values()].find((transaction) => (
      !transaction.finalized
      && transaction.featureId === input.featureId
      && transaction.replacedPackageDigests.includes(digest)
    )) || [...this.durableRegistrations.values()].find((transaction) => (
      transaction.phase === 'committed'
      && transaction.featureId === input.featureId
      && transaction.replacedPackageDigests.includes(digest)
      && this.sameStableBinding(transaction.binding, binding)
    ));
    if (pendingSource) {
      this.managedStreams.preflightOwnerRegistration(this.managedStreamOwner(nextRegistered, binding));
      this.registered.set(digest, nextRegistered);
      return this.committedResult(nextRegistered, []);
    }
    const durablePendingFinalize = [...this.durableRegistrations.values()].find((transaction) => (
      transaction.phase === 'committed'
      && transaction.featureId === input.featureId
      && this.sameStableBinding(transaction.binding, binding)
    ));
    if (durablePendingFinalize) {
      throw new Error('A committed Operation registration for this Feature is awaiting explicit finalization or abort.');
    }
    const abortedLineage = [...this.durableRegistrations.values()].find((transaction) => (
      transaction.phase === 'aborted'
      && transaction.featureId === input.featureId
      && this.sameStableBinding(transaction.binding, binding)
    ));
    if (abortedLineage && previousOwners.length === 0
      && !abortedLineage.replacedPackageDigests.includes(digest)) {
      throw new Error('An aborted Operation handoff requires the exact source package to be registered before retry.');
    }
    const pendingFinalize = [...this.committedRegistrations.values()].find((transaction) => (
      transaction.featureId === input.featureId && !transaction.finalized
    ));
    if (pendingFinalize) {
      throw new Error('A committed Operation registration for this Feature is awaiting explicit finalization.');
    }
    for (const previous of previousOwners) {
      if (previous.packageId !== nextRegistered.packageId) {
        throw new Error('Operation package replacement cannot change the signed package family.');
      }
      if (nextRegistered.packageSequence <= previous.packageSequence) {
        throw new Error('Operation package replacement sequence must increase monotonically.');
      }
    }
    for (const previous of previousOwners) {
      if (!resourceOwner) {
        if (previous.resourceOwner) {
          throw new Error('A signed Operation resource owner cannot be removed by package replacement.');
        }
        this.assertNoDurableResources(previous.digest, binding);
      } else {
        this.pageObservations.preflightOwnerReplacement(previous.digest, binding, (resourceBinding) => (
          this.managedStreamOwner(nextRegistered, resourceBinding)
        ));
      }
    }
    const existingPrepared = [...this.preparedRegistrations.values()].find((item) => item.featureId === input.featureId);
    if (existingPrepared) {
      if (existingPrepared.packageDigest !== digest || existingPrepared.bindingKey !== bindingKey
        || existingPrepared.featureVersion !== input.featureVersion) {
        throw new Error('Another Operation registration transaction is already prepared for this Feature.');
      }
      return existingPrepared.result;
    }
    const registrationToken = crypto.randomBytes(32).toString('hex');
    const replacedPackageDigests = previousOwners.map((item) => item.digest).sort();
    const result: OperationRegistrationResult = {
      schemaVersion: 'omnia.operation-registration-result/v1',
      featureId: input.featureId,
      featureVersion: input.featureVersion,
      packageId: envelope.packageId,
      packageDigest: digest,
      operationIds: [...operations.keys()].sort(),
      registrationState: 'prepared',
      registrationToken,
      replacedPackageDigests
    };
    if (previousOwners.length === 0) {
      this.managedStreams.preflightOwnerRegistration(this.managedStreamOwner(nextRegistered, binding));
      this.registered.set(digest, nextRegistered);
      return { ...result, registrationState: 'committed' };
    }
    const prepared: RegistrationTransaction = {
      token: registrationToken,
      bindingKey,
      featureId: input.featureId,
      featureVersion: input.featureVersion,
      packageDigest: digest,
      packageSequence: envelope.sequence,
      replacedPackageDigests,
      expiresAt: Number.MAX_SAFE_INTEGER,
      result,
      registered: nextRegistered,
      finalized: false
    };
    const timestamp = new Date().toISOString();
    const durablePrepared: DurableRegistrationTransaction = {
      schemaVersion: 'omnia.operation-registration-ledger/v1',
      token: registrationToken,
      featureId: input.featureId,
      featureVersion: input.featureVersion,
      packageId: nextRegistered.packageId,
      packageDigest: digest,
      packageSequence: nextRegistered.packageSequence,
      capabilityFingerprint: nextRegistered.capabilityFingerprint,
      operationIds: [...nextRegistered.operations.keys()].sort(),
      replacedPackageDigests,
      binding: this.durableBinding(binding),
      phase: 'prepared',
      committedAt: timestamp,
      updatedAt: timestamp,
      expiresAt: null
    };
    this.persistRegistrationLedger(durablePrepared);
    this.durableRegistrations.set(registrationToken, durablePrepared);
    this.preparedRegistrations.set(registrationToken, prepared);
    return result;
  }

  async invoke(
    input: OperationInvocationRequest,
    currentBinding: ConnectorBinding,
    invokeHttpStep: (
      route: Route,
      routePath: string,
      body: unknown,
      execution: { effect: Descriptor['effect']; commitStep: boolean }
    ) => Promise<unknown>,
    observationContext?: PageObservationContext
  ): Promise<unknown> {
    exactKeys(input, [
      'schemaVersion', 'featureId', 'featureVersion', 'operationId', 'request',
      'operationPackageDigest', 'mutationAuthorized',
      ...((input as OperationInvocationRequest).reconcileOf === undefined ? [] : ['reconcileOf']),
      ...((input as OperationInvocationRequest).deliveryContext === undefined ? [] : ['deliveryContext'])
    ], 'Operation invocation');
    if (input.schemaVersion !== 'omnia.operation-invocation/v1') throw new Error('Operation invocation schema is invalid.');
    const registered = this.registered.get(input.operationPackageDigest);
    if (!registered || registered.featureId !== input.featureId || registered.featureVersion !== input.featureVersion) {
      throw new Error('Operation package is not the active registered package for this Feature version.');
    }
    const operation = registered.operations.get(input.operationId);
    if (!operation) throw new Error('Operation is not declared by the signed package.');
    if (input.deliveryContext !== undefined) {
      assertConnectorDeliveryContext(input.deliveryContext);
      if (input.deliveryContext.featureId !== input.featureId
        || input.deliveryContext.featureVersion !== input.featureVersion
        || input.deliveryContext.operationId !== input.operationId
        || input.deliveryContext.operationPackageDigest !== input.operationPackageDigest
        || input.deliveryContext.connectorId !== currentBinding.connectorId
        || input.deliveryContext.sessionGeneration !== currentBinding.sessionGeneration
        || (input.deliveryContext.purpose === 'mutation') !== (operation.effect === 'omnia_mutation')) {
        throw new Error('Operation delivery identity differs from the signed Operation, binding, or effect.');
      }
    } else if (operation.effect === 'omnia_mutation') {
      throw new Error('Mutation Operation is not authorized without its Core-authored durable delivery identity.');
    }
    if (input.reconcileOf !== undefined) {
      exactKeys(input.reconcileOf, [
        'requestId', 'featureId', 'featureVersion', 'runId', 'commandId', 'operationId', 'operationPackageDigest',
        'connectorId', 'sessionGeneration', 'executionGeneration'
      ], 'Operation reconcile identity');
      if (operation.effect !== 'read_only'
        || input.mutationAuthorized
        || !/^[0-9a-f-]{36}$/iu.test(input.reconcileOf.requestId)
        || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(input.reconcileOf.featureId)
        || !/^\d+\.\d+\.\d+$/u.test(input.reconcileOf.featureVersion)
        || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.reconcileOf.runId)
        || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.reconcileOf.commandId)
        || !/^[a-z0-9][a-z0-9._-]{2,191}$/u.test(input.reconcileOf.operationId)
        || !/^sha256:[0-9a-f]{64}$/u.test(input.reconcileOf.operationPackageDigest)
        || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.reconcileOf.connectorId)
        || !Number.isSafeInteger(input.reconcileOf.sessionGeneration) || input.reconcileOf.sessionGeneration <= 0
        || !/^[a-f0-9]{48}$/u.test(input.reconcileOf.executionGeneration)) {
        throw new Error('Operation reconcile identity is invalid or was supplied to a mutation.');
      }
    }
    const request = record(input.request, 'Operation request');
    if (Object.keys(request).some((key) => FORBIDDEN_INPUT.has(key.toLowerCase()))) {
      throw new Error('Operation request attempted to supply transport fields.');
    }
    const binding = record(request.connectorBinding, 'Connector binding') as ConnectorBinding;
    if (
      binding.connectorId !== currentBinding.connectorId
      || Number(binding.sessionGeneration) !== currentBinding.sessionGeneration
      || binding.engagementId !== currentBinding.engagementId
      || String(binding.authorityInstanceId || '') !== String(currentBinding.authorityInstanceId || '')
      || String(binding.tenantOrOrgId || '') !== String(currentBinding.tenantOrOrgId || '')
      || String(binding.packId || '') !== String(currentBinding.packId || '')
    ) throw new Error('Operation binding no longer matches the current Connector session.');
    if (operation.effect === 'omnia_mutation') {
      if (!input.mutationAuthorized) throw new Error('Mutation Operation was not authorized by the confirmed Feature action.');
      const target = record(request.target, 'Mutation target');
      const workspaceScope = this.targetWorkspaceScope(target);
      const permitKey = this.permitKey(
        input.operationPackageDigest,
        binding,
        this.targetIdentity(target),
        workspaceScope,
        String(request.planDigest || ''),
        operation.operationId
      );
      if (!permitKey) throw new Error('Mutation target identity or plan digest is invalid.');
      const permit = this.permits.get(permitKey);
      if (!permit || permit.consumed || permit.expiresAt < Date.now()) throw new Error('Mutation commit permit is missing, expired, or already consumed.');
      permit.consumed = true;
    }
    const routes = new Map(operation.routes.map((route) => [route.stepId, route]));
    const requireReadOnlyObservation = () => {
      if (operation.effect !== 'read_only') throw new Error('Page observation is available only to read-only signed Operations.');
    };
    const observationSdk = Object.freeze({
      open: async (request: Parameters<PageObservationHost['open']>[1]) => {
        requireReadOnlyObservation();
        if (!observationContext) throw new Error('Current Pack page observation context is unavailable.');
        return this.pageObservations.open(this.managedStreamOwner(registered, currentBinding), request, observationContext);
      },
      status: (request: Parameters<PageObservationHost['status']>[1]) => {
        requireReadOnlyObservation();
        return this.pageObservations.status(this.managedStreamOwner(registered, currentBinding), request);
      },
      pause: (request: Parameters<PageObservationHost['pause']>[1]) => {
        requireReadOnlyObservation();
        return this.pageObservations.pause(this.managedStreamOwner(registered, currentBinding), request);
      },
      resume: async (request: Parameters<PageObservationHost['resume']>[1]) => {
        requireReadOnlyObservation();
        if (!observationContext) throw new Error('Current Pack page observation context is unavailable.');
        return this.pageObservations.resume(this.managedStreamOwner(registered, currentBinding), request, observationContext);
      },
      stop: (request: Parameters<PageObservationHost['stop']>[1]) => {
        requireReadOnlyObservation();
        return this.pageObservations.stop(this.managedStreamOwner(registered, currentBinding), request);
      },
      readChunk: (request: Parameters<PageObservationHost['readChunk']>[1]) => {
        requireReadOnlyObservation();
        return this.pageObservations.readChunk(this.managedStreamOwner(registered, currentBinding), request);
      }
    });
    const sdk = Object.freeze({
      binding: Object.freeze({ ...currentBinding }),
      pageObservation: observationSdk,
      invokeStep: async (stepId: string, parameters: Record<string, unknown> = {}, signedBody?: unknown) => {
        const route = routes.get(stepId);
        if (!route) throw new Error(`Signed Operation handler requested undeclared step: ${stepId}`);
        const declared = new Map(route.parameters.map((value) => [value.name, value]));
        if (Object.keys(parameters).some((name) => !declared.has(name))) {
          throw new Error('Signed Operation handler supplied an undeclared step parameter.');
        }
        const values: Record<string, string> = { engagementId: currentBinding.engagementId };
        for (const parameter of route.parameters) {
          const value = String(parameters[parameter.name] || '');
          if (!value || (parameter.type === 'guid' && !isGuid(value))) {
            throw new Error(`Operation step parameter is invalid: ${parameter.name}`);
          }
          values[parameter.name] = value;
        }
        const routePath = route.routeTemplate.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, key: string) => {
          const value = values[key];
          if (!value) throw new Error(`Operation route parameter is not declared: ${key}`);
          return encodeURIComponent(value);
        });
        if (route.bodyMode !== 'signed_json' && signedBody !== undefined) {
          throw new Error('Signed Operation handler supplied a body to a route that does not allow one.');
        }
        const body = route.bodyMode === 'parameter_array'
          ? [values[route.bodyParameter]]
          : route.bodyMode === 'signed_json'
            ? signedJsonBody(signedBody)
            : undefined;
        return invokeHttpStep(route, routePath, body, {
          effect: operation.effect,
          commitStep: operation.effect === 'omnia_mutation'
        });
      }
    });
    const result = await registered.run(input.operationId, structuredClone(request), sdk);
    if (operation.effect === 'read_only' && operation.grantsMutationPermit && typeof request.planDigest === 'string' && request.target) {
      const target = record(request.target, 'Preflight target');
      const workspaceScope = this.targetWorkspaceScope(target);
      const key = this.permitKey(
        input.operationPackageDigest,
        binding,
        this.targetIdentity(target),
        workspaceScope,
        request.planDigest,
        operation.permitsOperationId || ''
      );
      if (!key) throw new Error('Preflight cannot grant a permit for an invalid target identity or plan digest.');
      this.permits.set(key, { expiresAt: Date.now() + 120_000, consumed: false });
    }
    return result;
  }

  async close(): Promise<void> {
    await this.pageObservations.close();
    this.managedStreams.close();
  }

  private commitRegistration(
    input: OperationRegistrationCommitRequest,
    binding: ConnectorBinding
  ): OperationRegistrationResult {
    exactKeys(input, [
      'schemaVersion', 'featureId', 'featureVersion', 'operationPackageDigest', 'registrationToken'
    ], 'Operation registration commit');
    if (input.schemaVersion !== 'omnia.operation-registration-commit/v1'
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(input.featureId)
      || !/^\d+\.\d+\.\d+$/u.test(input.featureVersion)
      || !/^sha256:[0-9a-f]{64}$/u.test(input.operationPackageDigest)
      || !/^[0-9a-f]{64}$/u.test(input.registrationToken)) {
      throw new Error('Operation registration commit request is invalid.');
    }
    const bindingKey = this.registrationBindingKey(binding);
    const durableCompleted = this.durableRegistrations.get(input.registrationToken);
    if (durableCompleted && durableCompleted.phase !== 'prepared') {
      if (durableCompleted.phase === 'aborted') {
        throw new Error('Operation registration was durably aborted before activation.');
      }
      this.assertDurableCommand(durableCompleted, input, binding);
      const restored = this.committedRegistrations.get(input.registrationToken);
      if (restored) return restored.result;
      const preparedRecovery = this.preparedRegistrations.get(input.registrationToken);
      const registered = this.registered.get(durableCompleted.packageDigest) ?? preparedRecovery?.registered;
      if (!registered) {
        throw new Error('Committed Operation registration must be restored by exact signed package registration before replay.');
      }
      this.assertDurableRegistrationMatches(durableCompleted, registered);
      const result = this.durableRegistrationResult(durableCompleted);
      const transaction: RegistrationTransaction = {
        token: durableCompleted.token,
        bindingKey,
        featureId: durableCompleted.featureId,
        featureVersion: durableCompleted.featureVersion,
        packageDigest: durableCompleted.packageDigest,
        packageSequence: durableCompleted.packageSequence,
        replacedPackageDigests: [...durableCompleted.replacedPackageDigests],
        expiresAt: Number.MAX_SAFE_INTEGER,
        result,
        registered,
        finalized: durableCompleted.phase === 'finalized'
      };
      this.registered.set(durableCompleted.packageDigest, registered);
      this.preparedRegistrations.delete(input.registrationToken);
      this.committedRegistrations.set(transaction.token, transaction);
      return result;
    }
    const completed = this.committedRegistrations.get(input.registrationToken);
    if (completed) {
      this.assertRegistrationTransaction(completed, input, bindingKey);
      return completed.result;
    }
    const prepared = this.preparedRegistrations.get(input.registrationToken);
    if (!prepared) throw new Error('Operation registration token is unavailable or expired.');
    this.assertRegistrationTransaction(prepared, input, bindingKey);
    if (prepared.expiresAt < Date.now()) {
      this.preparedRegistrations.delete(prepared.token);
      throw new Error('Operation registration token is unavailable or expired.');
    }
    const registered = prepared.registered;
    if (registered.featureId !== prepared.featureId || registered.featureVersion !== prepared.featureVersion
      || registered.digest !== prepared.packageDigest || registered.packageSequence !== prepared.packageSequence) {
      throw new Error('Prepared Operation package identity is invalid.');
    }
    const durablePrepared = this.durableRegistrations.get(prepared.token);
    if (!durablePrepared || durablePrepared.phase !== 'prepared') {
      throw new Error('Prepared Operation registration lacks its exact durable ledger identity.');
    }
    this.assertDurableRegistrationMatches(durablePrepared, registered);
    if (this.committedRegistrations.size >= 128) {
      for (const [token, transaction] of this.committedRegistrations) {
        if (!transaction.finalized) continue;
        this.committedRegistrations.delete(token);
        if (this.committedRegistrations.size < 128) break;
      }
      if (this.committedRegistrations.size >= 128) {
        throw new Error('Operation registration commit ledger is full of unfinalized transactions.');
      }
    }
    for (const digest of prepared.replacedPackageDigests) {
      if (!registered.resourceOwner) {
        this.assertNoDurableResources(digest, binding);
      } else {
        this.pageObservations.commitOwnerReplacement(digest, binding, (resourceBinding) => (
          this.managedStreamOwner(registered, resourceBinding)
        ));
      }
    }
    const result: OperationRegistrationResult = {
      ...prepared.result,
      registrationState: 'committed'
    };
    const committed = { ...prepared, result, expiresAt: Number.MAX_SAFE_INTEGER };
    const timestamp = new Date().toISOString();
    const durable: DurableRegistrationTransaction = {
      ...durablePrepared,
      phase: 'committed',
      updatedAt: timestamp,
      expiresAt: null
    };
    this.persistRegistrationLedger(durable);
    this.durableRegistrations.set(durable.token, durable);
    this.registered.set(prepared.packageDigest, registered);
    this.preparedRegistrations.delete(prepared.token);
    this.committedRegistrations.set(prepared.token, committed);
    return result;
  }

  private finalizeRegistration(
    input: OperationRegistrationFinalizeRequest,
    binding: ConnectorBinding
  ): OperationRegistrationResult {
    exactKeys(input, [
      'schemaVersion', 'featureId', 'featureVersion', 'operationPackageDigest', 'registrationToken'
    ], 'Operation registration finalize');
    if (input.schemaVersion !== 'omnia.operation-registration-finalize/v1'
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(input.featureId)
      || !/^\d+\.\d+\.\d+$/u.test(input.featureVersion)
      || !/^sha256:[0-9a-f]{64}$/u.test(input.operationPackageDigest)
      || !/^[0-9a-f]{64}$/u.test(input.registrationToken)) {
      throw new Error('Operation registration finalize request is invalid.');
    }
    const transaction = this.committedRegistrations.get(input.registrationToken);
    if (!transaction) throw new Error('Committed Operation registration token is unavailable.');
    this.assertRegistrationTransaction(transaction, input, this.registrationBindingKey(binding));
    if (transaction.finalized) return transaction.result;
    for (const digest of transaction.replacedPackageDigests) {
      this.pageObservations.finalizeOwnerReplacement(digest, binding, (resourceBinding) => (
        this.managedStreamOwner(transaction.registered, resourceBinding)
      ));
    }
    const durable = this.durableRegistrations.get(transaction.token);
    if (!durable || durable.phase === 'aborted') {
      throw new Error('Committed Operation registration ledger entry is unavailable.');
    }
    const timestamp = new Date().toISOString();
    const finalized: DurableRegistrationTransaction = {
      ...durable,
      phase: 'finalized',
      updatedAt: timestamp,
      expiresAt: new Date(Date.now() + MANAGED_STREAM_FROZEN_TTL_MS).toISOString()
    };
    this.persistRegistrationLedger(finalized);
    this.durableRegistrations.set(finalized.token, finalized);
    for (const digest of transaction.replacedPackageDigests) {
      const previous = this.registered.get(digest);
      if (previous?.featureId === transaction.featureId) this.registered.delete(digest);
    }
    transaction.finalized = true;
    return transaction.result;
  }

  private abortRegistration(
    input: OperationRegistrationAbortRequest,
    binding: ConnectorBinding
  ): OperationRegistrationResult {
    exactKeys(input, [
      'schemaVersion', 'featureId', 'featureVersion', 'operationPackageDigest', 'registrationToken'
    ], 'Operation registration abort');
    if (input.schemaVersion !== 'omnia.operation-registration-abort/v1'
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(input.featureId)
      || !/^\d+\.\d+\.\d+$/u.test(input.featureVersion)
      || !/^sha256:[0-9a-f]{64}$/u.test(input.operationPackageDigest)
      || !/^[0-9a-f]{64}$/u.test(input.registrationToken)) {
      throw new Error('Operation registration abort request is invalid.');
    }
    const durable = this.durableRegistrations.get(input.registrationToken);
    if (!durable) throw new Error('Committed Operation registration token is unavailable.');
    this.assertDurableCommand(durable, input, binding);
    if (durable.phase === 'finalized') {
      throw new Error('Finalized Operation registration cannot be aborted.');
    }
    if (durable.phase === 'aborted') return this.durableRegistrationResult(durable);
    if (durable.phase === 'committed') {
      this.pageObservations.abortOwnerReplacement(durable.packageDigest, binding);
    }
    const timestamp = new Date().toISOString();
    const aborted: DurableRegistrationTransaction = {
      ...durable,
      phase: 'aborted',
      updatedAt: timestamp,
      expiresAt: new Date(Date.now() + MANAGED_STREAM_FROZEN_TTL_MS).toISOString()
    };
    this.persistRegistrationLedger(aborted);
    this.durableRegistrations.set(aborted.token, aborted);
    const target = this.registered.get(aborted.packageDigest);
    if (target?.featureId === aborted.featureId) this.registered.delete(aborted.packageDigest);
    this.committedRegistrations.delete(aborted.token);
    return this.durableRegistrationResult(aborted);
  }

  private assertRegistrationTransaction(
    transaction: RegistrationTransaction,
    input: OperationRegistrationCommitRequest | OperationRegistrationFinalizeRequest,
    bindingKey: string
  ): void {
    if (transaction.bindingKey !== bindingKey
      || transaction.featureId !== input.featureId
      || transaction.featureVersion !== input.featureVersion
      || transaction.packageDigest !== input.operationPackageDigest) {
      throw new Error('Operation registration token does not match the current Connector session or package identity.');
    }
  }

  private registrationBindingKey(binding: ConnectorBinding): string {
    if (!binding || typeof binding !== 'object' || !binding.connectorId
      || !Number.isSafeInteger(binding.sessionGeneration) || binding.sessionGeneration < 0
      || !binding.engagementId || !binding.authorityInstanceId || !binding.packId) {
      throw new Error('Operation registration requires the current verified Connector and Pack binding.');
    }
    return crypto.createHash('sha256').update(JSON.stringify([
      'omnia.operation-registration-binding/v1', binding.connectorId, binding.sessionGeneration,
      binding.engagementId, binding.authorityInstanceId, String(binding.tenantOrOrgId || ''), binding.packId
    ])).digest('hex');
  }

  private pruneRegistrationTransactions(): void {
    const timestamp = Date.now();
    for (const [token, transaction] of this.preparedRegistrations) {
      if (transaction.expiresAt < timestamp) this.preparedRegistrations.delete(token);
    }
  }

  private committedResult(registered: Registered, replacedPackageDigests: string[]): OperationRegistrationResult {
    return {
      schemaVersion: 'omnia.operation-registration-result/v1',
      featureId: registered.featureId,
      featureVersion: registered.featureVersion,
      packageId: registered.packageId,
      packageDigest: registered.digest,
      operationIds: [...registered.operations.keys()].sort(),
      registrationState: 'committed',
      registrationToken: crypto.randomBytes(32).toString('hex'),
      replacedPackageDigests: [...replacedPackageDigests].sort()
    };
  }

  private sameStableBinding(left: ConnectorBinding, right: ConnectorBinding): boolean {
    return left.connectorId === right.connectorId
      && left.engagementId === right.engagementId
      && String(left.authorityInstanceId || '') === String(right.authorityInstanceId || '')
      && String(left.tenantOrOrgId || '') === String(right.tenantOrOrgId || '')
      && String(left.packId || '') === String(right.packId || '');
  }

  private assertNoDurableResources(packageDigest: string, binding: ConnectorBinding): void {
    const streams = this.managedStreams.ownedResourceSnapshot(packageDigest, binding);
    const observations = this.pageObservations.ownedResourceSnapshot(packageDigest, binding);
    if (streams.state !== 'known' || observations.state !== 'known') {
      throw new Error('Operation package replacement cannot prove an exact zero durable-resource inventory.');
    }
    if (streams.count !== 0 || observations.count !== 0) {
      throw new Error('Operation package replacement without a signed resource owner is blocked by durable resources.');
    }
  }

  private assertRegistrationHighWater(registered: Registered, binding: ConnectorBinding): void {
    const finalized = [...this.durableRegistrations.values()].filter((transaction) => (
      transaction.phase === 'finalized'
      && transaction.featureId === registered.featureId
      && transaction.packageId === registered.packageId
      && this.sameStableBinding(transaction.binding, binding)
    ));
    const highest = finalized.reduce((value, transaction) => Math.max(value, transaction.packageSequence), 0);
    if (registered.packageSequence === highest
      && finalized.some((transaction) => transaction.packageDigest === registered.digest)) return;
    if (registered.packageSequence <= highest) {
      throw new Error(
        `Operation package sequence ${registered.packageSequence} is below or conflicts with durable finalized registration high-water ${highest}.`
      );
    }
  }

  private assertDurableRegistrationMatches(
    durable: DurableRegistrationTransaction,
    registered: Registered
  ): void {
    if (durable.featureId !== registered.featureId
      || durable.featureVersion !== registered.featureVersion
      || durable.packageId !== registered.packageId
      || durable.packageDigest !== registered.digest
      || durable.packageSequence !== registered.packageSequence
      || durable.capabilityFingerprint !== registered.capabilityFingerprint
      || JSON.stringify(durable.operationIds) !== JSON.stringify([...registered.operations.keys()].sort())) {
      throw new Error('Signed Operation package does not match its durable registration ledger identity.');
    }
  }

  private durableBinding(binding: ConnectorBinding): Required<ConnectorBinding> {
    this.registrationBindingKey(binding);
    return {
      connectorId: binding.connectorId,
      sessionGeneration: binding.sessionGeneration,
      engagementId: binding.engagementId,
      authorityInstanceId: String(binding.authorityInstanceId || ''),
      tenantOrOrgId: String(binding.tenantOrOrgId || ''),
      packId: String(binding.packId || '')
    };
  }

  private assertDurableCommand(
    durable: DurableRegistrationTransaction,
    input: OperationRegistrationCommitRequest | OperationRegistrationFinalizeRequest | OperationRegistrationAbortRequest,
    binding: ConnectorBinding
  ): void {
    this.registrationBindingKey(binding);
    if (durable.featureId !== input.featureId
      || durable.featureVersion !== input.featureVersion
      || durable.packageDigest !== input.operationPackageDigest
      || durable.token !== input.registrationToken
      || !this.sameStableBinding(durable.binding, binding)) {
      throw new Error('Operation registration token does not match the current Connector scope or package identity.');
    }
  }

  private durableRegistrationResult(durable: DurableRegistrationTransaction): OperationRegistrationResult {
    return {
      schemaVersion: 'omnia.operation-registration-result/v1',
      featureId: durable.featureId,
      featureVersion: durable.featureVersion,
      packageId: durable.packageId,
      packageDigest: durable.packageDigest,
      operationIds: [...durable.operationIds],
      registrationState: durable.phase === 'prepared'
        ? 'prepared'
        : durable.phase === 'aborted' ? 'aborted' : 'committed',
      registrationToken: durable.token,
      replacedPackageDigests: [...durable.replacedPackageDigests]
    };
  }

  private loadRegistrationLedger(): void {
    fs.mkdirSync(this.registrationLedgerRoot, { recursive: true, mode: 0o700 });
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.registrationLedgerRoot, { withFileTypes: true }); }
    catch {
      this.registrationLedgerCorrupt = true;
      return;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) continue;
      const filename = path.join(this.registrationLedgerRoot, entry.name);
      try {
        const value = record(JSON.parse(fs.readFileSync(filename, 'utf8')), 'Operation registration ledger') as DurableRegistrationTransaction;
        exactKeys(value, [
          'schemaVersion', 'token', 'featureId', 'featureVersion', 'packageId', 'packageDigest',
          'packageSequence', 'capabilityFingerprint', 'operationIds', 'replacedPackageDigests',
          'binding', 'phase', 'committedAt', 'updatedAt', 'expiresAt'
        ], 'Operation registration ledger');
        exactKeys(record(value.binding, 'Operation registration ledger binding'), [
          'connectorId', 'sessionGeneration', 'engagementId', 'authorityInstanceId', 'tenantOrOrgId', 'packId'
        ], 'Operation registration ledger binding');
        const sortedUnique = (items: unknown[], test: RegExp) => items.every((item, index) => (
          typeof item === 'string' && test.test(item) && (index === 0 || String(items[index - 1]) < item)
        ));
        const expiry = value.expiresAt === null ? null : Date.parse(value.expiresAt);
        if (value.schemaVersion !== 'omnia.operation-registration-ledger/v1'
          || value.token !== entry.name.slice(0, -5) || !/^[0-9a-f]{64}$/u.test(value.token)
          || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value.featureId)
          || !/^\d+\.\d+\.\d+$/u.test(value.featureVersion)
          || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value.packageId)
          || !/^sha256:[0-9a-f]{64}$/u.test(value.packageDigest)
          || !Number.isSafeInteger(value.packageSequence) || value.packageSequence < 1
          || !/^[0-9a-f]{64}$/u.test(value.capabilityFingerprint)
          || !Array.isArray(value.operationIds) || !sortedUnique(value.operationIds, /^[a-z0-9][a-z0-9._-]{2,127}$/u)
          || !Array.isArray(value.replacedPackageDigests)
          || !sortedUnique(value.replacedPackageDigests, /^sha256:[0-9a-f]{64}$/u)
          || !['prepared', 'committed', 'finalized', 'aborted'].includes(value.phase)
          || !Number.isFinite(Date.parse(value.committedAt)) || !Number.isFinite(Date.parse(value.updatedAt))
          || (['prepared', 'committed'].includes(value.phase)
            ? value.expiresAt !== null
            : !Number.isFinite(expiry))
          || !value.binding || typeof value.binding !== 'object') {
          throw new Error('Operation registration ledger fields are invalid.');
        }
        this.registrationBindingKey(value.binding);
        if (expiry !== null && expiry <= now) {
          fs.rmSync(filename, { force: true });
          this.managedStreams.audit('operation_registration', value.token, 'registration_ledger_expired', {
            phase: value.phase,
            packageDigest: value.packageDigest
          });
          continue;
        }
        this.durableRegistrations.set(value.token, structuredClone(value));
      } catch (error) {
        this.registrationLedgerCorrupt = true;
        this.managedStreams.audit('operation_registration', entry.name, 'registration_ledger_fail_closed', {
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        });
      }
    }
    if (this.durableRegistrations.size > 256) this.registrationLedgerCorrupt = true;
  }

  private persistRegistrationLedger(value: DurableRegistrationTransaction): void {
    if (this.registrationLedgerCorrupt) {
      throw new Error('Operation registration ledger failed integrity validation; persistence is fail-closed.');
    }
    if (!this.durableRegistrations.has(value.token) && this.durableRegistrations.size >= 256) {
      throw new Error('Operation registration durable ledger quota is exhausted.');
    }
    fs.mkdirSync(this.registrationLedgerRoot, { recursive: true, mode: 0o700 });
    const filename = path.join(this.registrationLedgerRoot, `${value.token}.json`);
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(value));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, filename);
  }

  private targetIdentity(target: Record<string, unknown>): string {
    const objectId = String(target.objectId || '');
    if (isGuid(objectId)) return `object:${objectId.toLowerCase()}`;
    const identity = String(target.targetIdentityKey || '').normalize('NFC').trim();
    if (!/^[A-Za-z0-9:|._@/-]{3,512}$/u.test(identity)) return '';
    return `logical:${identity}`;
  }

  private targetWorkspaceScope(target: Record<string, unknown>): string[] {
    const singular = String(target.workspaceId || '').trim().toLowerCase();
    const plural = target.workspaceIds;
    if (singular) {
      if (!isGuid(singular)) throw new Error('Mutation target workspaceId must be a GUID.');
      if (plural !== undefined && (!Array.isArray(plural) || plural.length !== 1 || String(plural[0]).toLowerCase() !== singular)) {
        throw new Error('Mutation target workspaceId and workspaceIds disagree.');
      }
      return [singular];
    }
    if (!Array.isArray(plural) || plural.length < 1 || plural.length > 50) {
      throw new Error('Mutation target must declare a non-empty Workspace scope.');
    }
    const normalized = plural.map((value) => String(value || '').trim().toLowerCase());
    if (normalized.some((value) => !isGuid(value))
      || new Set(normalized).size !== normalized.length
      || normalized.some((value, index) => index > 0 && normalized[index - 1]! > value)) {
      throw new Error('Mutation target workspaceIds must be unique, sorted GUIDs.');
    }
    return normalized;
  }

  private permitKey(
    digest: string,
    binding: ConnectorBinding,
    targetIdentity: string,
    workspaceScope: string[],
    planDigest: string,
    mutationOperationId: string
  ): string {
    if (!targetIdentity || workspaceScope.length < 1 || workspaceScope.some((value) => !isGuid(value))
      || !/^[0-9a-f]{64}$/u.test(planDigest) || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(mutationOperationId)) return '';
    return crypto.createHash('sha256').update(JSON.stringify([
      digest, binding.connectorId, binding.sessionGeneration, binding.engagementId,
      targetIdentity, workspaceScope, planDigest, mutationOperationId
    ])).digest('hex');
  }

  private managedStreamOwner(registered: Registered, binding: ConnectorBinding): ManagedStreamOwner {
    const claim = registered.resourceOwner;
    if (claim && !claim.capabilities.includes(CURRENT_PACK_PAGE_OBSERVATION_POLICY)) {
      throw new Error('Page observation capability is not declared by this signed Operation resource owner.');
    }
    const stableKey = claim
      ? this.resourceOwnerKey(
        registered.featureId,
        registered.packageId,
        claim.ownerId,
        claim.compatibilityVersion,
        CURRENT_PACK_PAGE_OBSERVATION_POLICY
      )
      : this.legacyResourceOwnerKey(
        registered.featureId,
        registered.packageId,
        registered.digest,
        CURRENT_PACK_PAGE_OBSERVATION_POLICY
      );
    const compatibleSourceOwners = claim?.compatibleSourcePackageDigests.map((digest) => ({
      packageDigest: digest,
      ownerKey: this.legacyResourceOwnerKey(
        registered.featureId,
        registered.packageId,
        digest,
        CURRENT_PACK_PAGE_OBSERVATION_POLICY
      )
    }));
    return {
      ownerKey: stableKey,
      packageDigest: registered.digest,
      packageSequence: registered.packageSequence,
      capabilityFingerprint: registered.capabilityFingerprint,
      binding: { ...binding },
      ...(compatibleSourceOwners?.length ? { compatibleSourceOwners } : {})
    };
  }

  private resourceOwnerKey(
    featureId: string,
    packageId: string,
    ownerId: string,
    compatibilityVersion: number,
    capabilityId: string
  ): string {
    return crypto.createHash('sha256').update(JSON.stringify([
      'omnia.operation-resource-owner/v1', featureId, packageId, ownerId, compatibilityVersion, capabilityId
    ])).digest('hex');
  }

  private legacyResourceOwnerKey(featureId: string, packageId: string, digest: string, capabilityId: string): string {
    return crypto.createHash('sha256').update(JSON.stringify([
      'omnia.operation-resource-owner/legacy-v1', featureId, packageId, digest, capabilityId
    ])).digest('hex');
  }
}
