import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageFile, verifyOfficialPackage } from '../src/main/features/official-package.ts';

/**
 * Current-source offline contract plus immutable historical candidate coverage.
 *
 * The source self-check is the current-version assertion for 0.2.150. The
 * 0.2.109 assertions below remain explicitly historical and prove the last
 * immutable candidate rather than silently reusing source bytes.
 */

const repository = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const historicalCandidatePath = path.join(repository, 'feature-packages', 'create-associate', 'candidates', 'create-associate-0.2.109.ofp');
const historicalOperationPath = path.join(repository, 'feature-packages', 'create-associate', 'candidates', 'create-associate-operation-0.2.109.ofop');
const releasePython = path.join(repository, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
const packageScript = path.join(repository, 'scripts', 'package-create-associate-feature.mjs');

const engagementId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const sourceObjectId = '33333333-3333-4333-8333-333333333333';
const targetObjectId = '44444444-4444-4444-8444-444444444444';

type OperationDefinition = { operationId: string };
type OperationManifest = { operations: OperationDefinition[] };
type OperationHandler = {
  run(operationId: string, request: Record<string, unknown>, sdk: unknown): Promise<unknown>;
};
type Invocation = { stepId: string; params: unknown; body: unknown };

function readVerifiedHistoricalCandidate() {
  return verifyOfficialPackage(JSON.parse(fs.readFileSync(historicalCandidatePath, 'utf8')), 'omnia-feature');
}

function loadCandidateHandler(candidateRoot: string): OperationHandler {
  const loaded = require(path.join(candidateRoot, 'connector-capability', 'operation-handler.cjs')) as {
    createOperationHandler(): OperationHandler;
  };
  return loaded.createOperationHandler();
}

function strictSdk(expected: Invocation, result: unknown): { sdk: unknown; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const sdk = new Proxy({
    binding: { engagementId },
    invokeStep: async (stepId: string, params?: unknown, body?: unknown) => {
      const observed = { stepId, params, body };
      calls.push(observed);
      assert.deepEqual(observed, expected, `unexpected signed Operation invocation for ${expected.stepId}`);
      return result;
    }
  }, {
    get(target, property, receiver) {
      if (property !== 'binding' && property !== 'invokeStep') {
        throw new Error(`offline strict SDK forbids capability ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    }
  });
  return { sdk, calls };
}

function commandRequest(kind: string, payload: Record<string, unknown>, targetIdentityKey: string): Record<string, unknown> {
  return {
    target: { targetIdentityKey, workspaceId },
    command: {
      commandId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'a'.repeat(64),
      kind,
      payload
    }
  };
}

test('0.2.150 current source self-check runs release CPython and all 37 independent fixtures without changing a candidate', () => {
  assert.equal(fs.existsSync(releasePython), true, 'the release-managed CPython executable is required');
  const version = spawnSync(releasePython, ['-I', '-S', '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(`${version.stdout}${version.stderr}`, /^Python 3\.13\.14\s*$/u);
  const candidatePath = path.join(repository, 'feature-packages', 'create-associate', 'candidates', 'create-associate-0.2.150.ofp');
  const operationPath = path.join(repository, 'feature-packages', 'create-associate', 'candidates', 'create-associate-operation-0.2.150.ofop');
  const candidateBefore = fs.existsSync(candidatePath) ? fs.readFileSync(candidatePath) : null;
  const operationBefore = fs.existsSync(operationPath) ? fs.readFileSync(operationPath) : null;
  const selfCheck = spawnSync(process.execPath, [packageScript, '--self-check'], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNIA_PYTHON_EXECUTABLE: releasePython,
      OMNIA_MANAGED_PYTHON_EXECUTABLE: releasePython,
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1'
    }
  });
  assert.equal(selfCheck.status, 0, selfCheck.stderr || selfCheck.stdout);
  assert.match(selfCheck.stdout, /omnia\.create-associate 0\.2\.150\/152 package self-check passed \(37 independent fixtures; no candidate written\)/u);
  assert.deepEqual(fs.existsSync(candidatePath) ? fs.readFileSync(candidatePath) : null, candidateBefore, 'source self-check must not write or change the Feature candidate');
  assert.deepEqual(fs.existsSync(operationPath) ? fs.readFileSync(operationPath) : null, operationBefore, 'source self-check must not write or change the Operation candidate');
});

test('immutable 0.2.109 history proves 37 signed Operations use one candidate handler and the standalone ofop is identical', (t) => {
  const featureEnvelope = readVerifiedHistoricalCandidate();
  const embeddedBytes = packageFile(featureEnvelope, 'connector-capability/operation.ofop');
  const independentBytes = fs.readFileSync(historicalOperationPath);
  assert.deepEqual(embeddedBytes, independentBytes, 'embedded and standalone 0.2.109 Operation candidates must be byte-identical');

  const operationEnvelope = verifyOfficialPackage(JSON.parse(embeddedBytes.toString('utf8')), 'omnia-connector-operation');
  const independentEnvelope = verifyOfficialPackage(JSON.parse(independentBytes.toString('utf8')), 'omnia-connector-operation');
  assert.equal(operationEnvelope.packageId, independentEnvelope.packageId);
  assert.equal(operationEnvelope.version, '0.2.109');
  const manifest = JSON.parse(packageFile(operationEnvelope, 'manifest.json').toString('utf8')) as OperationManifest;
  assert.equal(manifest.operations.length, 37);
  assert.equal(new Set(manifest.operations.map((operation) => operation.operationId)).size, 37);
  assert.deepEqual(
    operationEnvelope.files.filter((member) => member.path.endsWith('.cjs')).map((member) => member.path),
    ['operation/handler.cjs'],
    'all signed Operations must share the one package-level candidate handler'
  );

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-associate-handler-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporary, 'connector-capability'), { recursive: true });
  fs.writeFileSync(path.join(temporary, 'connector-capability', 'operation-handler.cjs'), packageFile(operationEnvelope, 'operation/handler.cjs'));
  assert.equal(typeof loadCandidateHandler(temporary).run, 'function');
});

test('immutable 0.2.109 history executes all object and relation modes through its real candidate handler with exact payloads', async (t) => {
  const featureEnvelope = readVerifiedHistoricalCandidate();
  const operationEnvelope = verifyOfficialPackage(
    JSON.parse(packageFile(featureEnvelope, 'connector-capability/operation.ofop').toString('utf8')),
    'omnia-connector-operation'
  );
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-associate-operation-runtime-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporary, 'connector-capability'), { recursive: true });
  fs.writeFileSync(path.join(temporary, 'connector-capability', 'operation-handler.cjs'), packageFile(operationEnvelope, 'operation/handler.cjs'));
  const handler = loadCandidateHandler(temporary);

  const appDescription = JSON.stringify({
    editorData: '<p>APP-OFFLINE</p>',
    suggestionsData: [],
    trackChangesEnableFlagInEditor: false,
    plainText: 'APP-OFFLINE'
  });
  const objectVectors = [
    { kind: 'APP', payload: { name: 'APP-OFFLINE', workspaceId, engagementId, number: 'APP-OFFLINE', itElementType: 'Application', description: appDescription } },
    { kind: 'DB', payload: { name: 'DB-OFFLINE', workspaceId, engagementId, number: 'DB-OFFLINE', itElementType: 'Infrastructure', description: 'DB-OFFLINE', typeId: 'Database' } },
    { kind: 'OS', payload: { name: 'OS-OFFLINE', workspaceId, engagementId, number: 'OS-OFFLINE', itElementType: 'Infrastructure', description: 'OS-OFFLINE', typeId: 'OperatingSystem' } },
    { kind: 'TOOL', payload: { name: 'TOOL-OFFLINE', workspaceId, engagementId, number: 'TOOL-OFFLINE', itElementType: 'ITTool', typeId: 'Tool' } },
    { kind: 'DCNO', payload: { name: 'DCNO-OFFLINE', workspaceId, engagementId, number: 'DCNO-OFFLINE', itElementType: 'Infrastructure', description: 'DCNO-OFFLINE', typeId: 'Network' } }
  ];
  for (const vector of objectVectors) {
    let baseline: Invocation[] | undefined;
    for (const mode of ['Higher', 'Lower'] as const) {
      const expected = { stepId: 'object-create', params: {}, body: vector.payload };
      const { sdk, calls } = strictSdk(expected, { id: sourceObjectId });
      const result = await handler.run(
        'omnia.create-associate.object.create.v1',
        commandRequest('create_object', vector.payload, `${vector.kind}|${vector.payload.number}`),
        sdk
      );
      assert.deepEqual(result, { id: sourceObjectId });
      assert.deepEqual(calls, [expected]);
      if (baseline) assert.deepEqual(calls, baseline, `${vector.kind} ${mode} must not select another handler/Operation branch`);
      else baseline = calls;
    }
  }

  const relationVectors = [
    { kind: 'DB', associationType: 'InfrastructureApplication', concurrencyTabId: 602 },
    { kind: 'OS', associationType: 'InfrastructureApplication', concurrencyTabId: 602 },
    { kind: 'DCNO', associationType: 'InfrastructureApplication', concurrencyTabId: 602 },
    { kind: 'TOOL', associationType: 'ItToolApplication', concurrencyTabId: 802 }
  ];
  for (const vector of relationVectors) {
    const payload = {
      ItElementId: sourceObjectId,
      AssociatingEntityIds: [targetObjectId],
      associationType: vector.associationType,
      ConcurrencyTabId: vector.concurrencyTabId,
      workspaceId,
      engagementId
    };
    const transportBody = {
      ItElementId: sourceObjectId,
      AssociatingEntityIds: [targetObjectId],
      associationType: vector.associationType,
      ConcurrencyTabId: vector.concurrencyTabId
    };
    let baseline: Invocation[] | undefined;
    for (const mode of ['Higher', 'Lower'] as const) {
      const expected = { stepId: 'relation-associate', params: {}, body: transportBody };
      const { sdk, calls } = strictSdk(expected, { associated: true });
      const result = await handler.run(
        'omnia.create-associate.relation.associate.v1',
        commandRequest('associate_relation', payload, `${vector.kind}|relation`),
        sdk
      );
      assert.deepEqual(result, { associated: true });
      assert.deepEqual(calls, [expected]);
      if (baseline) assert.deepEqual(calls, baseline, `${vector.kind} ${mode} relation must not select another handler/Operation branch`);
      else baseline = calls;
    }
  }

  const wrongSubtype = {
    name: 'DCNO-WRONG', workspaceId, engagementId, number: 'DCNO-WRONG',
    itElementType: 'Infrastructure', description: 'DCNO-WRONG', typeId: 'Server'
  };
  const subtypeSdk = strictSdk({ stepId: 'must-not-run', params: {}, body: {} }, null);
  await assert.rejects(
    handler.run('omnia.create-associate.object.create.v1', commandRequest('create_object', wrongSubtype, 'DCNO|wrong-subtype'), subtypeSdk.sdk),
    /typeId must match the recorded DB\/OS\/DCNO contract/u
  );
  assert.deepEqual(subtypeSdk.calls, [], 'wrong subtype must fail closed before invokeStep');

  const wrongTabPayload = {
    ItElementId: sourceObjectId,
    AssociatingEntityIds: [targetObjectId],
    associationType: 'InfrastructureApplication',
    ConcurrencyTabId: 802,
    workspaceId,
    engagementId
  };
  const tabSdk = strictSdk({ stepId: 'must-not-run', params: {}, body: {} }, null);
  await assert.rejects(
    handler.run('omnia.create-associate.relation.associate.v1', commandRequest('associate_relation', wrongTabPayload, 'DB|wrong-tab'), tabSdk.sdk),
    /Relationship payload does not match the recorded Omnia contract/u
  );
  assert.deepEqual(tabSdk.calls, [], 'wrong relation tab must fail closed before invokeStep');
});
