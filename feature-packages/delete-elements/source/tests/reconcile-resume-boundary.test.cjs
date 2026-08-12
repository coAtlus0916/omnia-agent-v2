'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFeatureWorker } = require('../middle/worker.cjs');

test('read-only reconcile stops before pending mutations and requires explicit mutation resume', async (t) => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const commandId = '22222222-2222-4222-8222-222222222222';
  const objectId = '33333333-3333-4333-8333-333333333333';
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const binding = {
    connectorId: 'connector-test', sessionGeneration: 7,
    engagementId: '55555555-5555-4555-8555-555555555555',
    authorityInstanceId: 'https://example.invalid', tenantOrOrgId: '', packId: 'pack-test'
  };
  const safety = {
    enabled: true, validForCurrentConnection: true, engagementId: binding.engagementId,
    connectorId: binding.connectorId, sessionGeneration: binding.sessionGeneration,
    authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId,
    authorityObservationId: '66666666-6666-4666-8666-666666666666', workspaceIds: [workspaceId],
    globalEnabled: false, globalSectionIds: [], globalWorkspaceIds: [], allowedWorkspaceIds: [workspaceId], stateVersion: 3
  };
  const stepKey = `APP|${workspaceId}|${objectId}`;
  const step = {
    kind: 'object', key: stepKey, workspace: workspaceId, objectType: 'APP', objectId,
    operations: {
      preflight: 'omnia.delete.it-element.preflight.v1',
      direct: 'omnia.delete.it-element.direct.v1',
      reconcile: 'omnia.delete.it-element.reconcile.v1'
    },
    request: { objectId, objectType: 'APP', workItemId: 'work-item', workspaceId },
    operationTarget: { targetIdentityKey: stepKey, workspaceId, objectId, workItemId: 'work-item', objectType: 'APP' },
    affectedTargetKeys: [stepKey]
  };
  const plan = {
    schemaVersion: 'omnia.delete-plan/v5', planId: runId, runId,
    featureId: 'omnia.delete-elements', featureVersion: '__FEATURE_VERSION__',
    state: 'uncertain', stateVersion: 4, surfaceStateVersion: 4,
    planDigest: 'a'.repeat(64), graphDigest: 'b'.repeat(64), binding, safety,
    targets: [{ objectId, objectType: 'APP', workspace: workspaceId, workspaceIds: [workspaceId], name: 'APP', number: 'APP', updatedAt: '2026-08-12T00:00:00.000Z' }],
    steps: [step], intents: [{ kind: 'object', key: stepKey, workspace: workspaceId }],
    scheduleGraph: [{ stepId: stepKey, kind: 'object', affectedTargetKeys: [stepKey], dependsOn: [] }],
    outcomes: [{ stepId: stepKey, state: 'uncertain', phase: 'readback', commandId, code: 'CONNECTOR.RESPONSE_LOST', message: 'lost' }],
    results: [{ key: stepKey, kind: 'object', objectId, objectType: 'APP', state: 'uncertain', commandId, code: 'CONNECTOR.RESPONSE_LOST', error: 'lost' }],
    nextIndex: 1,
    uncertain: { stepId: stepKey, commandId, intent: { kind: 'object', key: stepKey, workspace: workspaceId }, phase: 'readback' },
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z'
  };
  const storeCalls = [];
  const connectorCalls = [];
  const worker = createFeatureWorker({
    connector: { invoke: async (request) => {
      connectorCalls.push(request.operationId);
      assert.equal(request.operationId, step.operations.reconcile);
      return { objectId, objectType: 'APP', workspaceIds: [workspaceId], deleted: true, __operationReceiptId: 'receipt-1' };
    } },
    store: { call: async (method, input) => {
      storeCalls.push(method);
      if (method === 'loadPlan') return plan;
      if (method === 'loadLatestRun') return { run_id: runId, state: 'uncertain', state_revision: 4 };
      if (['transitionRun', 'freezeReturnEvidenceSpec', 'recordReturnEvidence', 'projectVerifiedDeletion'].includes(method)) return true;
      if (method === 'savePlan') { Object.assign(plan, input); return true; }
      throw new Error(`unexpected store method: ${method}`);
    } },
    events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());

  const result = await worker.handleAction({
    actionId: 'reconcile-delete-plan', expectedStateVersion: 4,
    payload: { runId }, context: { connectorBinding: binding, safetyLock: safety }
  });

  assert.equal(plan.state, 'resume_required');
  assert.equal(plan.uncertain, undefined);
  assert.deepEqual(connectorCalls, [step.operations.reconcile]);
  assert.equal(storeCalls.includes('prepareDeletionCommand'), false);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'resume-delete-plan').enabled, true);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'reconcile-delete-plan').enabled, false);
});
