import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageFile, verifyOfficialPackage } from '../src/main/features/official-package.ts';

/**
 * Candidate-only offline contract acceptance.
 *
 * This suite proves deterministic planner and signed Operation behavior without
 * network access. It does not claim that a live Pack Return has succeeded.
 */

const repository = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const candidatePath = path.join(repository, 'feature-packages', 'create-associate', 'candidates', 'create-associate-0.2.99.ofp');
const independentOperationPath = path.join(repository, 'feature-packages', 'create-associate', 'candidates', 'create-associate-operation-0.2.99.ofop');
const releasePython = path.join(repository, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
const fixtureRunnerPath = path.join(repository, 'feature-packages', 'create-associate', 'source', 'tests', 'capability_contract.py');

const engagementId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const sourceObjectId = '33333333-3333-4333-8333-333333333333';
const targetObjectId = '44444444-4444-4444-8444-444444444444';

type PackageMember = { path: string; contentBase64: string };
type PackageEnvelope = { files: PackageMember[] };
type OperationDefinition = { operationId: string };
type OperationManifest = { operations: OperationDefinition[] };
type OperationHandler = {
  run(operationId: string, request: Record<string, unknown>, sdk: unknown): Promise<unknown>;
};
type Invocation = { stepId: string; params: unknown; body: unknown };

function readVerifiedFeatureCandidate() {
  return verifyOfficialPackage(JSON.parse(fs.readFileSync(candidatePath, 'utf8')), 'omnia-feature');
}

function unpackEnvelope(envelope: PackageEnvelope, targetRoot: string): void {
  const resolvedRoot = path.resolve(targetRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  for (const member of envelope.files) {
    const target = path.resolve(resolvedRoot, ...member.path.split('/'));
    assert.equal(target.startsWith(`${resolvedRoot}${path.sep}`), true, `unsafe package member path: ${member.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(member.contentBase64, 'base64'));
  }
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

function plannerCases(): Array<Record<string, unknown>> {
  const app = (id: string, rait: 'Higher' | 'Lower', row = 23) => ({
    [`B${row}`]: id,
    [`C${row}`]: 'Generic',
    [`D${row}`]: rait,
    [`E${row}`]: `${rait} offline contract basis.`,
    [`F${row}`]: 'WS-A'
  });
  const expected = (elementId: string, kind: string, rait: 'Higher' | 'Lower', dependencies?: string[]) => ({
    elementId,
    kind,
    status: 'ready_for_remote_preflight',
    rait,
    ...(dependencies ? { dependencies } : {})
  });
  const inherited = (
    testId: string,
    kind: 'DB' | 'OS' | 'DCNO',
    row: number,
    content: string,
    firstRait: 'Higher' | 'Lower',
    expectedRait: 'Higher' | 'Lower'
  ) => {
    const first = `${kind}-${expectedRait}-Parent-A`;
    const second = `${kind}-${expectedRait}-Parent-B`;
    const elementId = `${kind}-${expectedRait}-Child`;
    return {
      testId,
      kind: 'workbook',
      cells: {
        ...app(first, firstRait, 23),
        ...app(second, 'Lower', 24),
        [`B${row}`]: elementId,
        [`C${row}`]: content,
        [`D${row}`]: 'WS-A',
        [`E${row}`]: `${first}、${second}`
      },
      expectedRows: [expected(elementId, kind, expectedRait, [first, second])]
    };
  };
  const tool = (rait: 'Higher' | 'Lower') => {
    const parent = `TOOL-${rait}-Parent`;
    const elementId = `TOOL-${rait}-Direct`;
    return {
      testId: `planner-tool-direct-${rait.toLowerCase()}`,
      kind: 'workbook',
      cells: {
        ...app(parent, 'Lower'),
        B46: elementId,
        C46: '工单工具',
        D46: rait,
        E46: 'WS-A',
        F46: parent
      },
      expectedRows: [expected(elementId, 'TOOL', rait, [parent])]
    };
  };
  return [
    {
      testId: 'planner-app-direct-higher',
      kind: 'workbook',
      cells: app('APP-Higher-Direct', 'Higher'),
      expectedRows: [expected('APP-Higher-Direct', 'APP', 'Higher')]
    },
    {
      testId: 'planner-app-direct-lower',
      kind: 'workbook',
      cells: app('APP-Lower-Direct', 'Lower'),
      expectedRows: [expected('APP-Lower-Direct', 'APP', 'Lower')]
    },
    inherited('planner-db-any-higher', 'DB', 30, 'Generic', 'Higher', 'Higher'),
    inherited('planner-db-all-lower', 'DB', 30, 'Generic', 'Lower', 'Lower'),
    inherited('planner-os-any-higher', 'OS', 35, 'Generic', 'Higher', 'Higher'),
    inherited('planner-os-all-lower', 'OS', 35, 'Generic', 'Lower', 'Lower'),
    tool('Higher'),
    tool('Lower'),
    inherited('planner-dcno-any-higher', 'DCNO', 40, '网络', 'Higher', 'Higher'),
    inherited('planner-dcno-all-lower', 'DCNO', 40, '网络', 'Lower', 'Lower')
  ];
}

test('offline contract verifies the frozen candidate, managed CPython, and all Higher/Lower planner modes', (t) => {
  assert.equal(fs.existsSync(releasePython), true, 'the release-managed CPython executable is required');
  const envelope = readVerifiedFeatureCandidate();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-associate-all-modes-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const candidateRoot = path.join(temporary, 'candidate');
  unpackEnvelope(envelope, candidateRoot);

  const version = spawnSync(releasePython, ['-I', '-S', '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(`${version.stdout}${version.stderr}`, /^Python 3\.13\.14\s*$/u);

  const selfTest = spawnSync(process.execPath, [path.join(candidateRoot, 'tests', 'self-test.cjs')], {
    cwd: candidateRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNIA_PYTHON_EXECUTABLE: releasePython,
      OMNIA_MANAGED_PYTHON_EXECUTABLE: releasePython,
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1'
    }
  });
  assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
  assert.match(selfTest.stdout, /package self-test passed \(5 declared checks; CPython 3\.13\.14\)/u);

  const runnerTarget = path.join(candidateRoot, 'tests', 'capability_contract.py');
  fs.copyFileSync(fixtureRunnerPath, runnerTarget);
  const payload = {
    governance: JSON.parse(fs.readFileSync(path.join(candidateRoot, 'backend', 'governance.json'), 'utf8')),
    fixtures: {
      schemaVersion: 'omnia.create-associate.capability-fixtures/v1',
      pythonCases: plannerCases(),
      workerCases: []
    },
    templateBase64: fs.readFileSync(path.join(candidateRoot, 'backend', 'Phase1-用户填写模板V5.xlsx')).toString('base64')
  };
  const planner = spawnSync(releasePython, ['-X', 'utf8', '-I', '-S', runnerTarget], {
    cwd: candidateRoot,
    encoding: 'utf8',
    input: Buffer.from(JSON.stringify(payload), 'utf8'),
    env: {
      SystemRoot: process.env.SystemRoot ?? '',
      WINDIR: process.env.WINDIR ?? '',
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1'
    }
  });
  assert.equal(planner.status, 0, planner.stderr || planner.stdout);
  const result = JSON.parse(planner.stdout) as { schemaVersion: string; results: Array<{ testId: string; status: string }> };
  assert.equal(result.schemaVersion, 'omnia.create-associate.fixture-results/v1');
  assert.deepEqual(
    result.results,
    plannerCases().map((fixture) => ({ testId: fixture.testId, status: 'passed' }))
  );
});

test('offline contract proves 37 signed Operations use one candidate handler and the standalone ofop is identical', (t) => {
  const featureEnvelope = readVerifiedFeatureCandidate();
  const embeddedBytes = packageFile(featureEnvelope, 'connector-capability/operation.ofop');
  const independentBytes = fs.readFileSync(independentOperationPath);
  assert.deepEqual(embeddedBytes, independentBytes, 'embedded and standalone 0.2.99 Operation candidates must be byte-identical');

  const operationEnvelope = verifyOfficialPackage(JSON.parse(embeddedBytes.toString('utf8')), 'omnia-connector-operation');
  const independentEnvelope = verifyOfficialPackage(JSON.parse(independentBytes.toString('utf8')), 'omnia-connector-operation');
  assert.equal(operationEnvelope.packageId, independentEnvelope.packageId);
  assert.equal(operationEnvelope.version, '0.2.99');
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

test('offline contract executes all object and relation modes through the real candidate handler with exact payloads', async (t) => {
  const featureEnvelope = readVerifiedFeatureCandidate();
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
