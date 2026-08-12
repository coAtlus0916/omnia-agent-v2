'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createFeatureWorker } = require('../middle/worker.cjs');

const workspaceId = '11111111-1111-1111-1111-111111111111';
const sectionId = '22222222-2222-2222-2222-222222222222';
const connectorBinding = { connectorId: 'connector-scale', sessionGeneration: 3,
  engagementId: '33333333-3333-3333-3333-333333333333', authorityInstanceId: 'https://authority.example.invalid',
  tenantOrOrgId: 'tenant-scale', packId: 'pack-scale' };
const safetyLock = { enabled: true, validForCurrentConnection: true, globalEnabled: false,
  ...connectorBinding, stateVersion: 7, authorityObservationId: 'observation-scale', workspaceIds: [workspaceId] };
const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
const packageRoot = path.resolve(__dirname, '..');
const managedTempRoot = path.join(repositoryRoot, '.codex-tmp', `delete-preparation-scale-${process.pid}`);
process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = path.join(repositoryRoot, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(packageRoot, 'python', 'delete-elements-engine.py');
process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
process.env.OMNIA_FEATURE_TEMP_ROOT = managedTempRoot;
test.after(() => fs.rmSync(managedTempRoot, { recursive: true, force: true }));

function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function scope() {
  return { ...connectorBinding, workspaceIds: [workspaceId], sections: [{ id: sectionId, name: 'TEST' }],
    workspaces: [{ id: workspaceId, name: 'TEST Workspace', parentSectionId: sectionId }] };
}
function createHarness({ runId, items, invoke }) {
  const plans = new Map(); const calls = []; let latestRun = null; let prepareCount = 0; let mutationCount = 0;
  const store = { call: async (name, payload) => {
    calls.push({ name, payload });
    if (name === 'savePlan') { plans.set(payload.planId, payload); if (payload.planId === runId) latestRun = payload; return payload; }
    if (name === 'loadPlan') return plans.get(String(payload));
    if (name === 'createMutationRun') return { runId, state: 'ready_for_review', stateRevision: 1 };
    if (name === 'prepareReturnIntent') {
      prepareCount += 1;
      return { stateVersion: 2, confirmationId: `confirmation-${runId}`, confirmationToken: 'confirmation-token',
        planDigest: `plan-digest-${runId}`, expiresAt: '2099-01-01T00:00:00.000Z' };
    }
    if (name === 'loadLatestRun') return { run: { run_id: runId, state: latestRun && latestRun.state === 'preparing' ? 'ready_for_review' : 'waiting_confirmation', state_revision: 1 } };
    if (name === 'transitionRun') return { stateRevision: Number(payload.expectedRevision) + 1 };
    throw new Error(`unexpected store call: ${name}`);
  } };
  const connector = { invoke: async (request) => {
    if (request.operationId.includes('.direct.')) mutationCount += 1;
    return invoke(request);
  } };
  const seedSnapshot = () => store.call('savePlan', { schemaVersion: 'omnia.delete-catalog-snapshot/v1',
    planId: `catalog:${digest({ connectorId: connectorBinding.connectorId, sessionGeneration: connectorBinding.sessionGeneration,
      engagementId: connectorBinding.engagementId, authorityInstanceId: connectorBinding.authorityInstanceId,
      tenantOrOrgId: connectorBinding.tenantOrOrgId, packId: connectorBinding.packId, workspaceIds: [workspaceId] })}`,
    capturedAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z', binding: connectorBinding,
    safetyRevision: safetyLock.stateVersion, items });
  return { store, connector, calls, seedSnapshot, plan: () => latestRun, prepareCount: () => prepareCount, mutationCount: () => mutationCount };
}
async function continueUntilPending(worker, harness, context, perInvocation = []) {
  for (let index = 0; index < 100; index += 1) {
    const plan = harness.plan();
    if (plan.state === 'pending_confirmation') return plan;
    const before = perInvocation.length;
    perInvocation.push({ action: index, object: 0, gra: 0, relation: 0 });
    const actionId = plan.preparation.failure ? 'retry-delete-plan-preparation' : 'continue-delete-plan-preparation';
    await worker.handleAction({ actionId, expectedStateVersion: plan.surfaceStateVersion,
      context, payload: { runId: plan.runId } });
    assert.equal(perInvocation.length, before + 1);
  }
  throw new Error('preparation did not reach pending_confirmation');
}

test('worker source has no Comments message-card projection path', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'middle', 'worker.cjs'), 'utf8');
  assert.equal(workerSource.includes('messageCard'), false);
  assert.equal(/\bfunction\s+card\s*\(/u.test(workerSource), false);
});

test('156-target begin is fast and 20+ revisions freeze at most eight object preflights before one Core intent', async (t) => {
  const items = Array.from({ length: 156 }, (_, index) => {
    const suffix = String(index + 1).padStart(12, '0');
    return { objectType: 'Information', objectId: `44444444-4444-4444-4444-${suffix}`, informationId: `44444444-4444-4444-4444-${suffix}`,
      workItemId: `55555555-5555-5555-5555-${suffix}`, workspaceIds: [workspaceId], number: `INFO-${String(index + 1).padStart(3, '0')}`,
      name: `Information ${index + 1}`, updatedAt: `2026-08-09T00:00:${String(index % 60).padStart(2, '0')}.000Z`, blockers: [], relations: [] };
  });
  const byId = new Map(items.map((item) => [item.objectId, item])); const invocations = []; let currentInvocation = null;
  const harness = createHarness({ runId: 'run-scale', items, invoke: async ({ operationId, request }) => {
    if (operationId === 'omnia.delete.information.preflight.v1') {
      currentInvocation.object += 1; const item = byId.get(request.informationId);
      await new Promise((resolve) => setTimeout(resolve, Number(item.objectId.slice(-2)) % 4));
      return { objectId: item.objectId, informationId: item.informationId, objectType: item.objectType, workItemId: item.workItemId,
        workspaceIds: item.workspaceIds, updatedAt: item.updatedAt, riskAssessmentId: '', blockers: [], relations: [] };
    }
    throw new Error(`unexpected operation: ${operationId}`);
  } });
  await harness.seedSnapshot();
  const worker = createFeatureWorker({ connector: harness.connector, store: harness.store, events: { emit: async () => undefined } });
  t.after(() => worker.shutdown());
  const targetIds = [...items].reverse().map((item) => `Information|${item.objectId}`); const context = { connectorBinding, safetyLock };
  const started = Date.now();
  const begin = await worker.handleAction({ actionId: 'create-delete-plan', expectedStateVersion: 12, context, payload: { targetIds } });
  assert.ok(Date.now() - started < 500, 'begin must only consume the saved snapshot and create local/Core state');
  assert.equal(harness.plan().state, 'preparing');
  assert.equal(begin.surfacePatch.stateVersion, 13);
  assert.equal(begin.surfacePatch.progress.completed, 0);
  assert.equal(harness.prepareCount(), 0);
  for (let index = 0; index < 100 && harness.plan().state !== 'pending_confirmation'; index += 1) {
    const record = { object: 0, gra: 0, relation: 0 }; currentInvocation = record; invocations.push(record);
    const plan = harness.plan();
    await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: plan.surfaceStateVersion,
      context, payload: { runId: plan.runId } });
  }
  const plan = harness.plan();
  assert.equal(plan.state, 'pending_confirmation');
  assert.ok(invocations.length >= 21, `expected 20 object batches plus finalization, got ${invocations.length}`);
  assert.ok(invocations.every((entry) => entry.object <= 8 && entry.gra === 0 && entry.relation === 0));
  assert.equal(invocations.reduce((total, entry) => total + entry.object, 0), 156);
  assert.deepEqual(plan.targets.map((item) => item.objectId), [...items].reverse().map((item) => item.objectId));
  assert.deepEqual(plan.steps.map((step) => step.objectId), items.map((item) => item.objectId));
  assert.equal(harness.prepareCount(), 1);
  assert.equal(harness.mutationCount(), 0);
  assert.equal(plan.preparation.checkpointRevision, invocations.length);
});

test('failed read-only batch saves no partial result, keeps its cursor, and explicit retry only repeats that batch', async (t) => {
  const items = Array.from({ length: 12 }, (_, index) => ({ objectType: 'Information',
    objectId: `64444444-4444-4444-4444-${String(index + 1).padStart(12, '0')}`,
    informationId: `64444444-4444-4444-4444-${String(index + 1).padStart(12, '0')}`,
    workItemId: `65555555-5555-5555-5555-${String(index + 1).padStart(12, '0')}`,
    workspaceIds: [workspaceId], number: `FAIL-${index + 1}`, name: `Failure ${index + 1}`,
    updatedAt: '2026-08-09T00:00:00.000Z', blockers: [], relations: [] }));
  const byId = new Map(items.map((item) => [item.objectId, item])); let failOnce = true; let mutationCalls = 0;
  const harness = createHarness({ runId: 'run-retry', items, invoke: async ({ operationId, request }) => {
    if (operationId.includes('.direct.')) mutationCalls += 1;
    if (operationId === 'omnia.delete.information.preflight.v1') {
      const item = byId.get(request.informationId); await new Promise((resolve) => setTimeout(resolve, 2));
      if (failOnce && item === items[9]) throw Object.assign(new Error('temporary read failure'), { code: 'DELETE.READ_TEMPORARY' });
      return { ...item, riskAssessmentId: '' };
    }
    throw new Error(`unexpected operation: ${operationId}`);
  } });
  await harness.seedSnapshot();
  const worker = createFeatureWorker({ connector: harness.connector, store: harness.store, events: { emit: async () => undefined } });
  t.after(() => worker.shutdown()); const context = { connectorBinding, safetyLock };
  await worker.handleAction({ actionId: 'create-delete-plan', expectedStateVersion: 2, context,
    payload: { targetIds: items.map((item) => `Information|${item.objectId}`) } });
  let plan = harness.plan();
  await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: plan.surfaceStateVersion, context, payload: { runId: plan.runId } });
  plan = harness.plan(); assert.equal(plan.preparation.objectCursor, 8); assert.equal(plan.preparation.objectPreflights.length, 8);
  await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: plan.surfaceStateVersion, context, payload: { runId: plan.runId } });
  plan = harness.plan();
  assert.equal(plan.preparation.objectCursor, 8);
  assert.equal(plan.preparation.objectPreflights.length, 8);
  assert.equal(plan.preparation.failure.batchStart, 8);
  assert.equal(plan.preparation.failure.batchSize, 4);
  const failedSurfaceVersion = plan.surfaceStateVersion;
  assert.equal(plan.state, 'preparing'); assert.equal(harness.prepareCount(), 0); assert.equal(mutationCalls, 0);
  failOnce = false;
  await worker.handleAction({ actionId: 'retry-delete-plan-preparation', expectedStateVersion: failedSurfaceVersion, context, payload: { runId: plan.runId } });
  plan = harness.plan();
  assert.equal(plan.preparation.objectCursor, 12);
  assert.equal(plan.preparation.objectPreflights.length, 12);
  assert.equal(plan.preparation.failure, undefined);
  await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: plan.surfaceStateVersion, context, payload: { runId: plan.runId } });
  assert.equal(harness.plan().state, 'pending_confirmation'); assert.equal(harness.prepareCount(), 1); assert.equal(mutationCalls, 0);
});

test('one source and two APP edges freeze in a later single relation-group batch', async (t) => {
  const db = { objectType: 'DB', objectId: '66666666-6666-6666-6666-666666666666', workItemId: '76666666-6666-6666-6666-666666666666' };
  const apps = [
    { objectType: 'APP', objectId: '86666666-6666-6666-6666-666666666662', workItemId: '96666666-6666-6666-6666-666666666662' },
    { objectType: 'APP', objectId: '86666666-6666-6666-6666-666666666661', workItemId: '96666666-6666-6666-6666-666666666661' }
  ];
  const edge = (app) => ({ relationType: 'InfrastructureApplication', sourceObjectId: db.objectId, targetObjectId: app.objectId,
    sourceObjectType: 'DB', targetObjectType: 'APP', sourceWorkItemId: db.workItemId, targetWorkItemId: app.workItemId,
    sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId });
  const items = [db, ...apps].map((item) => ({ ...item, workspaceIds: [workspaceId], number: item.objectType, name: item.objectId,
    updatedAt: '2026-08-09T00:00:00.000Z', blockers: item.objectType === 'DB' ? apps.map((app) => ({ type: 'Application', id: app.objectId, workItemId: app.workItemId }))
      : [{ type: 'Infrastructure', id: db.objectId, workItemId: db.workItemId }], relations: apps.map(edge) }));
  const byId = new Map(items.map((item) => [item.objectId, item])); let groupPreflights = 0;
  const harness = createHarness({ runId: 'run-group', items, invoke: async ({ operationId, request }) => {
    if (operationId === 'omnia.delete.it-element.preflight.v1') {
      const item = byId.get(request.objectId); return { objectId: item.objectId, objectType: item.objectType, workItemId: item.workItemId,
        workspaceIds: item.workspaceIds, updatedAt: item.updatedAt, riskAssessmentId: '', blockers: item.blockers, relations: item.relations };
    }
    if (operationId === 'omnia.delete.infrastructure-application.preflight.v1') {
      groupPreflights += 1; return { relationGroupKey: request.target.targetIdentityKey, relationType: request.relationType,
        targetObjectIds: request.targetObjectIds, source: { objectId: db.objectId, objectType: 'DB', workItemId: db.workItemId, workspaceId },
        targets: request.targets.map((target) => ({ ...target, updatedAt: '2026-08-09T00:00:00.000Z', associated: true, inconsistent: false, deleted: false })),
        concurrency: { entityTabTypeId: 602, updatedOn: '2026-08-09T00:00:01.000Z' }, associated: true, inconsistent: false, deleted: false };
    }
    throw new Error(`unexpected operation: ${operationId}`);
  } });
  await harness.seedSnapshot();
  const worker = createFeatureWorker({ connector: harness.connector, store: harness.store, events: { emit: async () => undefined } });
  t.after(() => worker.shutdown()); const context = { connectorBinding, safetyLock };
  await worker.handleAction({ actionId: 'create-delete-plan', expectedStateVersion: 4, context,
    payload: { targetIds: items.map((item) => `${item.objectType}|${item.objectId}`) } });
  let plan = harness.plan();
  await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: plan.surfaceStateVersion, context, payload: { runId: plan.runId } });
  plan = harness.plan(); assert.equal(plan.preparation.phase, 'relation_preflight'); assert.equal(groupPreflights, 0);
  await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: plan.surfaceStateVersion, context, payload: { runId: plan.runId } });
  plan = harness.plan(); assert.equal(plan.preparation.phase, 'finalizing'); assert.equal(groupPreflights, 1);
  await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: plan.surfaceStateVersion, context, payload: { runId: plan.runId } });
  plan = harness.plan(); const relationSteps = plan.steps.filter((step) => step.kind === 'relation');
  assert.equal(relationSteps.length, 1);
  assert.deepEqual(relationSteps[0].request.targetObjectIds, apps.map((app) => app.objectId).sort());
  assert.equal(relationSteps[0].affectedTargetKeys.length, 3);
  assert.equal(plan.scheduleGraph.filter((step) => step.dependsOn.includes(relationSteps[0].key)).length, 3);
  assert.equal(harness.mutationCount(), 0);
});

test('preparing cancellation uses one exact ready_for_review Core CAS and no mutation or prepare intent', async (t) => {
  const item = { objectType: 'Information', objectId: 'a4444444-4444-4444-4444-444444444444', informationId: 'a4444444-4444-4444-4444-444444444444',
    workItemId: 'a5555555-5555-5555-5555-555555555555', workspaceIds: [workspaceId], number: 'CANCEL', name: 'Cancel',
    updatedAt: '2026-08-09T00:00:00.000Z', blockers: [], relations: [] };
  const harness = createHarness({ runId: 'run-cancel', items: [item], invoke: async ({ operationId }) => { throw new Error(`unexpected operation: ${operationId}`); } });
  await harness.seedSnapshot(); const worker = createFeatureWorker({ connector: harness.connector, store: harness.store, events: { emit: async () => undefined } });
  t.after(() => worker.shutdown()); const context = { connectorBinding, safetyLock };
  await worker.handleAction({ actionId: 'create-delete-plan', expectedStateVersion: 6, context, payload: { targetIds: [`Information|${item.objectId}`] } });
  const plan = harness.plan(); const result = await worker.handleAction({ actionId: 'cancel-delete-plan', expectedStateVersion: plan.surfaceStateVersion,
    context, payload: { runId: plan.runId } });
  const transitions = harness.calls.filter((call) => call.name === 'transitionRun');
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0].payload, { runId: 'run-cancel', expectedRevision: 1, toState: 'cancelled',
    eventType: 'delete.preparation_cancelled', error: 'DELETE.USER_CANCELLED: User cancelled deletion plan preparation before confirmation or mutation.' });
  assert.equal(harness.calls.some((call) => call.name === 'returnRunToReview'), false);
  assert.equal(harness.prepareCount(), 0); assert.equal(harness.mutationCount(), 0);
  assert.equal(result.surfacePatch.progress.state, 'skipped');
});

test('begin rejects missing, expired, or binding-drifted snapshot before Core Run creation', async (t) => {
  const item = { objectType: 'Information', objectId: 'b4444444-4444-4444-4444-444444444444', informationId: 'b4444444-4444-4444-4444-444444444444',
    workItemId: 'b5555555-5555-5555-5555-555555555555', workspaceIds: [workspaceId], number: 'STALE', name: 'Stale',
    updatedAt: '2026-08-09T00:00:00.000Z', blockers: [], relations: [] };
  const harness = createHarness({ runId: 'run-stale', items: [item], invoke: async ({ operationId }) => { throw new Error(`unexpected operation: ${operationId}`); } });
  const worker = createFeatureWorker({ connector: harness.connector, store: harness.store, events: { emit: async () => undefined } });
  t.after(() => worker.shutdown()); const context = { connectorBinding, safetyLock };
  await assert.rejects(worker.handleAction({ actionId: 'create-delete-plan', expectedStateVersion: 1, context,
    payload: { targetIds: [`Information|${item.objectId}`] } }), /权威重抓取/u);
  assert.equal(harness.calls.some((call) => call.name === 'createMutationRun'), false);
});
