'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createFeatureWorker } = require('../middle/worker.cjs');

const graFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gra-delete-v4-live-contract.json'), 'utf8'));
function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }

test('selected GRA freezes as one cascade step and confirmation drift fails before mutation', async () => {
  const sample = graFixture.liveRun.recordedSample; const workspaceId = graFixture.liveRun.workspaceId;
  const connectorBinding = {
    connectorId: 'connector-gra', sessionGeneration: 4, engagementId: graFixture.liveRun.engagementId,
    authorityInstanceId: 'https://authority.example.invalid', tenantOrOrgId: 'tenant-gra', packId: 'pack-gra'
  };
  const safetyLock = { enabled: true, validForCurrentConnection: true, globalEnabled: false,
    connectorId: connectorBinding.connectorId, sessionGeneration: connectorBinding.sessionGeneration,
    engagementId: connectorBinding.engagementId, authorityInstanceId: connectorBinding.authorityInstanceId,
    tenantOrOrgId: connectorBinding.tenantOrOrgId, packId: connectorBinding.packId,
    stateVersion: 7, authorityObservationId: 'observation-gra', workspaceIds: [workspaceId] };
  const assessment = { riskAssessmentId: sample.riskAssessmentId, workItemId: sample.workItemId, workspaceId, updatedOn: '2026-07-25T04:39:45.892Z' };
  const cascadeSnapshot = { schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1', assessment, risks: [], controls: [], riskControls: [] };
  cascadeSnapshot.snapshotDigest = digest(cascadeSnapshot);
  const gra = { objectId: sample.riskAssessmentId, riskAssessmentId: sample.riskAssessmentId, objectType: 'GRA',
    workItemId: sample.workItemId, workspaceIds: [workspaceId], number: sample.referenceNumber, name: '',
    updatedAt: assessment.updatedOn, blockers: [], relations: [] };
  let capturedPlan = null; let frozenPlan = null; let confirmationResult = null; let driftGraPreflight = false; const operationCalls = []; const plans = new Map();
  const managedKeys = ['OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT', 'OMNIA_FEATURE_TEMP_ROOT'];
  const previousManaged = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..'); const packageRoot = path.resolve(__dirname, '..');
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = path.join(repositoryRoot, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(packageRoot, 'python', 'engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = path.join(repositoryRoot, '.codex-tmp', 'delete-elements-worker-contract');
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId, request }) => {
      operationCalls.push(operationId);
      if (operationId === 'omnia.delete.scope.read.v1') return { ...connectorBinding,
        workspaceIds: [workspaceId], sections: [{ id: 'section-test', name: 'TEST' }],
        workspaces: [{ id: workspaceId, name: graFixture.liveRun.workspaceName, parentSectionId: 'section-test' }] };
      if (operationId === 'omnia.delete.catalog.heavy-read.v1') return { engagementId: connectorBinding.engagementId, items: [gra] };
      if (operationId === 'omnia.delete.gra.preflight.v1') return { objectId: sample.riskAssessmentId,
        riskAssessmentId: sample.riskAssessmentId, objectType: 'GRA', workItemId: sample.workItemId,
        workspaceIds: [workspaceId], updatedAt: driftGraPreflight ? '2026-07-25T04:39:45.893Z' : assessment.updatedOn,
        blockers: [], relations: [], cascadeSnapshot };
      throw new Error(`unexpected operation: ${operationId} ${JSON.stringify(request)}`);
    } },
    store: { call: async (name, payload) => {
      if (name === 'createMutationRun') return { runId: 'run-gra' };
      if (name === 'prepareReturnIntent') return { stateVersion: 3, confirmationId: 'confirmation-gra',
        confirmationToken: 'token-gra', planDigest: 'core-plan-digest', expiresAt: '2099-01-01T00:00:00.000Z' };
      if (name === 'loadPlan') return plans.get(String(payload));
      if (name === 'loadLatestRun') return { run: { run_id: 'run-gra', state_revision: 5 } };
      if (name === 'returnRunToReview') return { stateVersion: 6 };
      if (name === 'transitionRun') return { stateVersion: 7 };
      if (name === 'savePlan') { plans.set(payload.planId, payload); if (payload.schemaVersion === 'omnia.delete-plan/v5') capturedPlan = payload; return payload; }
      throw new Error(`unexpected store call: ${name}`);
    } },
    events: { emit: async () => {} }
  });
  try {
    const context = { connectorBinding, safetyLock };
    await worker.refreshCatalog(context);
    await worker.handleAction({ actionId: 'create-delete-plan', context,
      payload: { targetIds: [`GRA|${sample.riskAssessmentId}`] } });
    while (capturedPlan.state === 'preparing') await worker.handleAction({ actionId: 'continue-delete-plan-preparation',
      expectedStateVersion: capturedPlan.surfaceStateVersion, context, payload: { runId: capturedPlan.runId } });
    frozenPlan = capturedPlan;
    assert.ok(frozenPlan);
    assert.equal(frozenPlan.targets.length, 1);
    assert.equal(frozenPlan.steps.length, 1);
    assert.equal(frozenPlan.steps[0].kind, 'cascade');
    assert.equal(frozenPlan.steps[0].objectType, 'GRA');
    assert.equal(frozenPlan.steps[0].operations.direct, 'omnia.delete.gra.direct.v1');
    assert.deepEqual(frozenPlan.steps[0].mutationPayload, { riskAssessmentId: sample.riskAssessmentId });
    assert.equal(frozenPlan.scheduleGraph[0].dependsOn.length, 0);
    assert.equal(operationCalls.filter((operationId) => operationId === 'omnia.delete.gra.preflight.v1').length, 1);
    driftGraPreflight = true;
    confirmationResult = await worker.handleAction({ actionId: 'confirm-delete-plan', expectedStateVersion: frozenPlan.surfaceStateVersion,
      context, payload: { runId: frozenPlan.runId } });
  } finally {
    await worker.shutdown();
    for (const key of managedKeys) {
      if (previousManaged[key] === undefined) delete process.env[key]; else process.env[key] = previousManaged[key];
    }
  }
  assert.equal(capturedPlan.state, 'cancelled');
  assert.match(capturedPlan.invalidatedReason, /DELETE\.PREFLIGHT_DRIFT/u);
  assert.equal(confirmationResult.surfacePatch.progress.state, 'skipped');
  assert.equal(confirmationResult.messageCard, undefined);
  assert.equal(operationCalls.filter((operationId) => operationId === 'omnia.delete.gra.preflight.v1').length, 2);
  assert.equal(operationCalls.filter((operationId) => operationId === 'omnia.delete.gra.direct.v1').length, 0);
});
