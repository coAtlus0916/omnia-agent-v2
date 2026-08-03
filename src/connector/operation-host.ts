import crypto from 'node:crypto';
import vm from 'node:vm';
import { packageDigest, packageFile, verifyOfficialPackage } from '../main/features/official-package.js';
import type {
  ConnectorBinding,
  OperationInvocationRequest,
  OperationRegistrationRequest,
  OperationRegistrationResult
} from '../shared/operation-contracts.js';
import { isGuid } from './omnia-origin.js';

type Route = {
  stepId: string;
  method: 'GET' | 'POST' | 'PATCH';
  routeTemplate: string;
  parameters: Array<{ name: string; type: 'guid' | 'string' }>;
  bodyMode: 'none' | 'parameter_array';
  bodyParameter: string;
};
type Descriptor = {
  operationId: string;
  effect: 'read_only' | 'omnia_mutation';
  requestSchema: string;
  responseSchema: string;
  enabledByDefault: boolean;
  grantsMutationPermit: boolean;
  routes: Route[];
};
type Registered = {
  featureId: string;
  featureVersion: string;
  packageId: string;
  digest: string;
  operations: Map<string, Descriptor>;
  run(operationId: string, input: Record<string, unknown>, sdk: object): Promise<unknown>;
};

const FORBIDDEN_INPUT = new Set(['url', 'method', 'headers', 'body', 'route', 'path']);

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
    structuredClone
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

  register(input: OperationRegistrationRequest): OperationRegistrationResult {
    exactKeys(input, ['schemaVersion', 'featureId', 'featureVersion', 'operationPackage'], 'Operation registration');
    if (input.schemaVersion !== 'omnia.operation-registration/v1') throw new Error('Operation registration schema is invalid.');
    const envelope = verifyOfficialPackage(input.operationPackage, 'omnia-connector-operation');
    const manifest = record(JSON.parse(packageFile(envelope, 'manifest.json').toString('utf8')), 'Operation manifest');
    exactKeys(manifest, ['schemaVersion', 'packageId', 'version', 'sequence', 'featureId', 'operations'], 'Operation manifest');
    if (
      manifest.schemaVersion !== 'omnia.connector-operation-manifest/v1'
      || manifest.packageId !== envelope.packageId
      || manifest.version !== envelope.version
      || manifest.sequence !== envelope.sequence
      || manifest.featureId !== input.featureId
      || manifest.version !== input.featureVersion
      || !Array.isArray(manifest.operations)
    ) throw new Error('Operation manifest identity does not match the active Feature.');
    const operations = new Map<string, Descriptor>();
    for (const raw of manifest.operations) {
      const operation = record(raw, 'Operation descriptor') as Descriptor;
      exactKeys(operation, [
        'operationId', 'effect', 'requestSchema', 'responseSchema', 'enabledByDefault',
        'grantsMutationPermit', 'routes'
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
        if (!['none', 'parameter_array'].includes(route.bodyMode)) throw new Error('Operation body mode is invalid.');
        if (route.bodyMode === 'parameter_array' && !route.parameters.some((value) => value.name === route.bodyParameter)) {
          throw new Error('Operation body parameter is not declared.');
        }
      }
      operations.set(operation.operationId, operation);
    }
    const digest = packageDigest(envelope);
    this.registered.set(digest, {
      featureId: input.featureId,
      featureVersion: input.featureVersion,
      packageId: envelope.packageId,
      digest,
      operations,
      run: loadHandler(packageFile(envelope, 'operation/handler.cjs').toString('utf8'))
    });
    return {
      schemaVersion: 'omnia.operation-registration-result/v1',
      featureId: input.featureId,
      featureVersion: input.featureVersion,
      packageId: envelope.packageId,
      packageDigest: digest,
      operationIds: [...operations.keys()]
    };
  }

  async invoke(
    input: OperationInvocationRequest,
    currentBinding: ConnectorBinding,
    invokeHttpStep: (route: Route, routePath: string, body: unknown) => Promise<unknown>
  ): Promise<unknown> {
    exactKeys(input, [
      'schemaVersion', 'featureId', 'featureVersion', 'operationId', 'request',
      'operationPackageDigest', 'mutationAuthorized'
    ], 'Operation invocation');
    if (input.schemaVersion !== 'omnia.operation-invocation/v1') throw new Error('Operation invocation schema is invalid.');
    const registered = this.registered.get(input.operationPackageDigest);
    if (!registered || registered.featureId !== input.featureId || registered.featureVersion !== input.featureVersion) {
      throw new Error('Operation package is not the active registered package for this Feature version.');
    }
    const operation = registered.operations.get(input.operationId);
    if (!operation) throw new Error('Operation is not declared by the signed package.');
    const request = record(input.request, 'Operation request');
    if (Object.keys(request).some((key) => FORBIDDEN_INPUT.has(key.toLowerCase()))) {
      throw new Error('Operation request attempted to supply transport fields.');
    }
    const binding = record(request.connectorBinding, 'Connector binding') as ConnectorBinding;
    if (
      binding.connectorId !== currentBinding.connectorId
      || Number(binding.sessionGeneration) !== currentBinding.sessionGeneration
      || binding.engagementId !== currentBinding.engagementId
    ) throw new Error('Operation binding no longer matches the current Connector session.');
    if (operation.effect === 'omnia_mutation') {
      if (!input.mutationAuthorized) throw new Error('Mutation Operation was not authorized by the confirmed Feature action.');
      const target = record(request.target, 'Mutation target');
      const permitKey = this.permitKey(
        input.operationPackageDigest,
        binding,
        String(target.objectId || ''),
        String(request.planDigest || '')
      );
      const permit = this.permits.get(permitKey);
      if (!permit || permit.consumed || permit.expiresAt < Date.now()) throw new Error('Mutation commit permit is missing, expired, or already consumed.');
      permit.consumed = true;
    }
    const routes = new Map(operation.routes.map((route) => [route.stepId, route]));
    const sdk = Object.freeze({
      binding: Object.freeze({ ...currentBinding }),
      invokeStep: async (stepId: string, parameters: Record<string, unknown> = {}) => {
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
        const body = route.bodyMode === 'parameter_array' ? [values[route.bodyParameter]] : undefined;
        return invokeHttpStep(route, routePath, body);
      }
    });
    const result = await registered.run(input.operationId, structuredClone(request), sdk);
    if (operation.effect === 'read_only' && operation.grantsMutationPermit && typeof request.planDigest === 'string' && request.target) {
      const target = record(request.target, 'Preflight target');
      const key = this.permitKey(
        input.operationPackageDigest,
        binding,
        String(target.objectId || ''),
        request.planDigest
      );
      this.permits.set(key, { expiresAt: Date.now() + 120_000, consumed: false });
    }
    return result;
  }

  private permitKey(digest: string, binding: ConnectorBinding, objectId: string, planDigest: string): string {
    if (!isGuid(objectId) || !/^[0-9a-f]{64}$/u.test(planDigest)) return '';
    return crypto.createHash('sha256').update(JSON.stringify([
      digest, binding.connectorId, binding.sessionGeneration, binding.engagementId, objectId, planDigest
    ])).digest('hex');
  }
}
