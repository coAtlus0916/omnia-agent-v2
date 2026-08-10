'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFeatureWorker, finalCatalogVerification, frozenSafetyMatches } = require('../middle/worker.cjs');

const connectorBinding = {
  connectorId: 'connector-1', sessionGeneration: 1,
  engagementId: '55555555-5555-5555-5555-555555555555',
  authorityInstanceId: 'https://api.example.invalid', tenantOrOrgId: 'tenant-1', packId: 'pack-1'
};
const workspaceId = '44444444-4444-4444-4444-444444444444';
const sectionId = '33333333-3333-3333-3333-333333333333';
const safetyLock = {
  enabled: true, validForCurrentConnection: true, engagementId: connectorBinding.engagementId, stateVersion: 7,
  globalEnabled: false, globalSectionIds: [], globalWorkspaceIds: [], workspaceIds: [workspaceId],
  connectorId: connectorBinding.connectorId, sessionGeneration: connectorBinding.sessionGeneration,
  authorityInstanceId: connectorBinding.authorityInstanceId, tenantOrOrgId: connectorBinding.tenantOrOrgId,
  packId: connectorBinding.packId, authorityObservationId: 'observation-1'
};

function plan(outcomes) {
  return {
    steps: [
      { key: 'relation:r1', kind: 'relation', objectType: 'InfrastructureApplication', objectId: 'relation-1' },
      { key: 'cascade:g1', kind: 'cascade', objectType: 'GRA', objectId: 'gra-1' },
      { key: 'object:app-1', kind: 'object', objectType: 'APP', objectId: 'app-1' },
      { key: 'object:db-1', kind: 'object', objectType: 'DB', objectId: 'db-1' }
    ],
    outcomes
  };
}

test('final authoritative verification proves every succeeded object and GRA cascade root absent', () => {
  const value = finalCatalogVerification(plan([
    { stepId: 'relation:r1', state: 'succeeded' },
    { stepId: 'cascade:g1', state: 'succeeded' },
    { stepId: 'object:app-1', state: 'succeeded' },
    { stepId: 'object:db-1', state: 'failed' }
  ]), [{ identity: 'DB|db-1', raw: { objectType: 'DB', objectId: 'db-1' } }], '2026-08-06T00:00:00.000Z');
  assert.deepEqual(value.expectedDeletedTargetIds, ['APP|app-1', 'GRA|gra-1']);
  assert.deepEqual(value.verifiedAbsentTargetIds, ['APP|app-1', 'GRA|gra-1']);
  assert.equal(value.catalogItemCount, 1);
  assert.match(value.catalogDigest, /^[0-9a-f]{64}$/u);
});

test('final authoritative verification rejects a GRA cascade root that reappears', () => {
  assert.throws(() => finalCatalogVerification(plan([
    { stepId: 'cascade:g1', state: 'succeeded' }
  ]), [{ identity: 'GRA|gra-1', raw: { objectType: 'GRA', objectId: 'gra-1' } }]), (error) => {
    assert.equal(error.code, 'DELETE.FINAL_CATALOG_CONTRADICTION');
    return true;
  });
});

test('final authoritative verification rejects a target that reappears', () => {
  assert.throws(() => finalCatalogVerification(plan([
    { stepId: 'object:app-1', state: 'succeeded' }
  ]), [{ identity: 'APP|app-1', raw: { objectType: 'APP', objectId: 'app-1' } }]), (error) => {
    assert.equal(error.code, 'DELETE.FINAL_CATALOG_CONTRADICTION');
    return true;
  });
});

test('final safety comparison requires the exact frozen revision and membership', () => {
  const frozen = {
    stateVersion: 7,
    authorityObservationId: 'observation-1',
    workspaceIds: ['workspace-b', 'workspace-a'],
    globalSectionIds: ['section-a'],
    globalWorkspaceIds: ['workspace-c'],
    allowedWorkspaceIds: ['workspace-a', 'workspace-b', 'workspace-c']
  };
  assert.equal(frozenSafetyMatches({ ...frozen, workspaceIds: ['workspace-a', 'workspace-b'] }, frozen), true);
  assert.equal(frozenSafetyMatches({ ...frozen, stateVersion: 8 }, frozen), false);
  assert.equal(frozenSafetyMatches({ ...frozen, allowedWorkspaceIds: ['workspace-a', 'workspace-b'] }, frozen), false);
});

test('real catalog patch matches the Shell item schema and exposes Network as parameterized DCNO', async (t) => {
  const calls = [];
  const catalogItems = [
    { objectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workItemId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', objectType: 'APP',
      number: 'APP-001', name: 'Payroll', updatedAt: '2026-08-06T00:00:00.000Z', workspaceIds: [workspaceId], blockers: [], relations: [] },
    { objectId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', workItemId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', objectType: 'DCNO',
      number: 'DCNO-001', name: 'Primary network', updatedAt: '2026-08-06T00:00:00.000Z', workspaceIds: [workspaceId], blockers: [], relations: [] }
  ];
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId }) => {
      calls.push(operationId);
      if (operationId === 'omnia.delete.scope.read.v1') return { ...connectorBinding,
        sections: [{ id: sectionId, name: 'IT' }], workspaces: [{ id: workspaceId, name: 'Technology', parentSectionId: sectionId }] };
      if (operationId === 'omnia.delete.catalog.heavy-read.v1') return { engagementId: connectorBinding.engagementId, items: catalogItems };
      throw new Error(`unexpected operation: ${operationId}`);
    } },
    store: { call: async (name) => { calls.push(`store:${name}`); return undefined; } },
    events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());
  const context = { connectorBinding, safetyLock };
  const patch = await worker.refreshCatalog(context);
  const app = patch.items.find((item) => item.type === 'APP');
  const dcno = patch.items.find((item) => item.type === 'DCNO');
  assert.deepEqual(Object.keys(app).sort(), ['concurrencyToken', 'disabledReason', 'id', 'scopeId', 'selectable', 'subtitle', 'title', 'type']);
  assert.equal(app.selectable, true);
  assert.equal(dcno.selectable, true);
  assert.equal(dcno.disabledReason, '');
  assert.equal(patch.scopes.find((scope) => scope.id === `type:${workspaceId}:DCNO`).disabledReason, dcno.disabledReason);
  assert.equal(calls.includes('store:createMutationRun'), false);
});

test('empty tenant identity remains a valid exact authority value and does not block catalog reads', async (t) => {
  const calls = [];
  const tenantlessBinding = { ...connectorBinding, tenantOrOrgId: '' };
  const tenantlessSafety = { ...safetyLock, tenantOrOrgId: '' };
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId }) => {
      calls.push(operationId);
      if (operationId === 'omnia.delete.scope.read.v1') return { ...tenantlessBinding,
        sections: [{ id: sectionId, name: 'IT' }], workspaces: [{ id: workspaceId, name: 'Technology', parentSectionId: sectionId }] };
      if (operationId === 'omnia.delete.catalog.heavy-read.v1') return { engagementId: tenantlessBinding.engagementId, items: [] };
      throw new Error(`unexpected operation: ${operationId}`);
    } },
    store: { call: async () => undefined },
    events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());
  const patch = await worker.refreshCatalog({ connectorBinding: tenantlessBinding, safetyLock: tenantlessSafety });
  assert.equal(patch.status, 'empty');
  assert.deepEqual(calls, ['omnia.delete.scope.read.v1', 'omnia.delete.catalog.heavy-read.v1']);
});

test('timed-out authoritative read projects busy immediately on retry without a second scan', async (t) => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (callback) => {
    queueMicrotask(callback);
    return { unref() {} };
  };
  global.clearTimeout = () => undefined;
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  let catalogCalls = 0;
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId }) => {
      if (operationId === 'omnia.delete.scope.read.v1') return { ...connectorBinding,
        sections: [{ id: sectionId, name: 'IT' }], workspaces: [{ id: workspaceId, name: 'Technology', parentSectionId: sectionId }] };
      if (operationId === 'omnia.delete.catalog.heavy-read.v1') {
        catalogCalls += 1;
        return new Promise(() => undefined);
      }
      throw new Error(`unexpected operation: ${operationId}`);
    } },
    store: { call: async () => undefined },
    events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());

  const context = { connectorBinding, safetyLock };
  const first = await worker.handleAction({ actionId: 'bootstrap-authoritative-catalog', context });
  const second = await worker.handleAction({ actionId: 'refresh-authoritative-catalog', context });
  assert.match(first.surfacePatch.statusMessage, /超过 90 秒/u);
  assert.match(second.surfacePatch.statusMessage, /上一轮真实权威目录读取仍在收尾/u);
  assert.equal(catalogCalls, 1);
});

test('reopen lifecycle rereads current authority and catalog while preserving pending and uncertain frozen plans', async (t) => {
  let currentPlan = null; let scopeReads = 0; let catalogReads = 0; const snapshots = [];
  const makePlan = (state) => ({ featureId: 'omnia.delete-elements', featureVersion: '0.3.16', planId: `plan-${state}`,
    runId: `run-${state}`, state, stateVersion: 7, surfaceStateVersion: 19, planDigest: `digest-${state}`,
    binding: connectorBinding, safety: { ...safetyLock, allowedWorkspaceIds: [workspaceId] },
    targets: [{ objectType: 'APP', objectId: `app-${state}`, workItemId: `work-${state}`, workspace: workspaceId,
      number: `APP-${state}`, name: `App ${state}`, updatedAt: '2026-08-09T00:00:00.000Z' }],
    steps: [], outcomes: [], results: [], uncertain: state === 'uncertain' ? { phase: 'final_catalog' } : undefined });
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId }) => {
      if (operationId === 'omnia.delete.scope.read.v1') {
        scopeReads += 1;
        return { ...connectorBinding, sections: [{ id: sectionId, name: 'IT' }], workspaces: [{ id: workspaceId, name: 'Technology', parentSectionId: sectionId }] };
      }
      if (operationId === 'omnia.delete.catalog.heavy-read.v1') {
        catalogReads += 1;
        return { engagementId: connectorBinding.engagementId, items: [{ objectType: 'APP', objectId: `fresh-${catalogReads}`,
          workItemId: `work-fresh-${catalogReads}`, workspaceIds: [workspaceId], number: `FRESH-${catalogReads}`,
          name: `Fresh ${catalogReads}`, updatedAt: '2026-08-09T00:00:00.000Z', blockers: [], relations: [] }] };
      }
      throw new Error(`unexpected operation: ${operationId}`);
    } },
    store: { call: async (name, payload) => {
      if (name === 'loadLatestRun') return { run: { run_id: currentPlan.runId } };
      if (name === 'loadPlan') return currentPlan;
      if (name === 'savePlan') { snapshots.push(payload); return payload; }
      throw new Error(`unexpected store call: ${name}`);
    } }, events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());

  for (const state of ['pending_confirmation', 'uncertain']) {
    currentPlan = makePlan(state); const before = structuredClone(currentPlan);
    const result = await worker.handleAction({ actionId: 'refresh-on-reopen', context: { connectorBinding, safetyLock } });
    assert.equal(result.surfacePatch.status, 'ready');
    assert.equal(result.surfacePatch.items[0].id, 'plan-target:0');
    assert.equal(result.surfacePatch.items[0].title, before.targets[0].number);
    assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'create-delete-plan').enabled, false);
    assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'confirm-delete-plan').enabled, state === 'pending_confirmation');
    assert.deepEqual(currentPlan, before, 'a reopen refresh must not overwrite frozen plan state or audit');
  }
  assert.equal(scopeReads, 2);
  assert.equal(catalogReads, 2);
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every((snapshot) => snapshot.schemaVersion === 'omnia.delete-catalog-snapshot/v1'));
});

test('reopen lifecycle retains a pending plan fail-closed when current authority read fails', async (t) => {
  const pendingPlan = { featureId: 'omnia.delete-elements', featureVersion: '0.3.16', planId: 'plan-reopen-failure', runId: 'run-reopen-failure',
    state: 'pending_confirmation', stateVersion: 3, surfaceStateVersion: 8, planDigest: 'digest-reopen-failure', binding: connectorBinding,
    safety: { ...safetyLock, allowedWorkspaceIds: [workspaceId] }, targets: [{ objectType: 'APP', objectId: 'app-failure', workItemId: 'work-failure',
      workspace: workspaceId, number: 'APP-FAILURE', name: 'Failure app', updatedAt: '2026-08-09T00:00:00.000Z' }], steps: [], outcomes: [], results: [] };
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId }) => {
      if (operationId === 'omnia.delete.scope.read.v1') throw Object.assign(new Error('current authority is unavailable'), { code: 'DELETE.AUTHORITY_DRIFT' });
      throw new Error(`unexpected operation: ${operationId}`);
    } },
    store: { call: async (name) => {
      if (name === 'loadLatestRun') return { run: { run_id: pendingPlan.runId } };
      if (name === 'loadPlan') return pendingPlan;
      throw new Error(`unexpected store call: ${name}`);
    } }, events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());
  const result = await worker.handleAction({ actionId: 'refresh-on-reopen', context: { connectorBinding, safetyLock } });
  assert.equal(result.surfacePatch.status, 'error');
  assert.match(result.surfacePatch.statusMessage, /DELETE\.REOPEN_REFRESH_FAILED/u);
  assert.equal(result.surfacePatch.items[0].id, 'plan-target:0');
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'cancel-delete-plan').enabled, true);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'confirm-delete-plan').enabled, false);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'reconcile-delete-plan').enabled, false);
});

test('reopen projects the same preparing checkpoint immediately and re-enables background continuation without catalog reread', async (t) => {
  const preparingPlan = { schemaVersion: 'omnia.delete-plan/v5', featureId: 'omnia.delete-elements', featureVersion: '0.3.18',
    planId: 'plan-preparing-reopen', runId: 'plan-preparing-reopen', state: 'preparing', stateVersion: 1, surfaceStateVersion: 11,
    preparationDigest: 'preparation-digest', planDigest: '', graphDigest: '', binding: connectorBinding,
    safety: { ...safetyLock, allowedWorkspaceIds: [workspaceId] },
    targets: [{ objectType: 'APP', objectId: 'app-preparing', workItemId: 'work-preparing', workspace: workspaceId,
      workspaceIds: [workspaceId], informationId: '', riskAssessmentId: '', number: 'APP-PREPARING', name: 'Preparing app',
      updatedAt: '2026-08-09T00:00:00.000Z', blockers: [], relations: [] }],
    steps: [], intents: [], scheduleGraph: [], outcomes: [], results: [], nextIndex: 0,
    preparation: { schemaVersion: 'omnia.delete-plan-preparation/v1', phase: 'object_preflight', checkpointRevision: 0,
      objectCursor: 0, objectPreflights: [], graSeeds: [], derivedGraSeeds: [], derivedGraCursor: 0,
      derivedGraPreflights: [], relationDescriptors: [], relationCursor: 0, relationPreflights: [] },
    createdAt: '2026-08-09T00:00:00.000Z' };
  let connectorCalls = 0;
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId }) => { connectorCalls += 1; throw new Error(`unexpected operation: ${operationId}`); } },
    store: { call: async (name) => {
      if (name === 'loadLatestRun') return { run: { run_id: preparingPlan.runId } };
      if (name === 'loadPlan') return preparingPlan;
      throw new Error(`unexpected store call: ${name}`);
    } }, events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());
  const result = await worker.handleAction({ actionId: 'refresh-on-reopen', context: { connectorBinding, safetyLock } });
  assert.equal(connectorCalls, 0);
  assert.equal(result.surfacePatch.stateVersion, 11);
  assert.match(result.surfacePatch.statusMessage, /状态 preparing/u);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'continue-delete-plan-preparation').enabled, true);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'retry-delete-plan-preparation').enabled, false);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'cancel-delete-plan').enabled, true);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'confirm-delete-plan').enabled, false);
});
