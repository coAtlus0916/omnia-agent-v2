'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createFeatureWorker } = require('../middle/worker.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
const packageRoot = path.resolve(__dirname, '..');
const managedTempRoot = path.join(repositoryRoot, '.codex-tmp', `delete-final-catalog-resume-${process.pid}`);
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

test('final authoritative GRA absence is checkpointed before recapture and resumes read-only after Worker restart', async (t) => {
  const workspaceId = '11111111-1111-1111-1111-111111111111';
  const graId = '22222222-2222-2222-2222-222222222222';
  const workItemId = '33333333-3333-3333-3333-333333333333';
  const runId = 'run-final-catalog-resume';
  const connectorBinding = { connectorId: 'connector-final-resume', sessionGeneration: 8,
    engagementId: '44444444-4444-4444-4444-444444444444', authorityInstanceId: 'https://authority.example.invalid',
    tenantOrOrgId: 'tenant-final-resume', packId: 'pack-final-resume' };
  const safetyLock = { enabled: true, validForCurrentConnection: true, globalEnabled: false, ...connectorBinding,
    stateVersion: 12, authorityObservationId: 'observation-final-resume', workspaceIds: [workspaceId] };
  const assessment = { riskAssessmentId: graId, workItemId, workspaceId, updatedOn: '2026-08-10T00:00:00.000Z' };
  const cascadeSnapshot = { schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1', assessment, risks: [], controls: [], riskControls: [] };
  cascadeSnapshot.snapshotDigest = digest(cascadeSnapshot);
  const gra = { objectId: graId, riskAssessmentId: graId, objectType: 'GRA', workItemId, workspaceIds: [workspaceId],
    number: 'GRA-RESUME', name: 'GRA final catalog resume', updatedAt: assessment.updatedOn, blockers: [], relations: [] };
  const plans = new Map(); let currentPlan = null; let catalogReads = 0; let directMutations = 0; let cascadeProjections = 0;
  const connector = { invoke: async ({ operationId }) => {
    if (operationId === 'omnia.delete.scope.read.v1') return { ...connectorBinding,
      sections: [{ id: 'section-final-resume', name: 'TEST' }],
      workspaces: [{ id: workspaceId, name: 'TEST', parentSectionId: 'section-final-resume' }] };
    if (operationId === 'omnia.delete.catalog.heavy-read.v1') {
      catalogReads += 1;
      if (catalogReads === 1) return { engagementId: connectorBinding.engagementId, items: [gra] };
      assert.equal(currentPlan.state, 'uncertain', 'final catalog must be recoverable before the remote read starts');
      assert.deepEqual(currentPlan.uncertain, { phase: 'final_catalog', terminal: 'succeeded' });
      if (catalogReads === 2) throw Object.assign(new Error('temporary final catalog read failure'), { code: 'DELETE.CATALOG_TEMPORARY' });
      return { engagementId: connectorBinding.engagementId, items: [] };
    }
    if (operationId === 'omnia.delete.gra.preflight.v1') return { objectId: graId, riskAssessmentId: graId,
      objectType: 'GRA', workItemId, workspaceIds: [workspaceId], updatedAt: assessment.updatedOn,
      blockers: [], relations: [], cascadeSnapshot };
    if (operationId === 'omnia.delete.gra.direct.v1') { directMutations += 1; return { accepted: true }; }
    if (operationId === 'omnia.delete.gra.reconcile.v1') return { objectId: graId, riskAssessmentId: graId,
      objectType: 'GRA', workspaceIds: [workspaceId], deleted: true, verifiedCascade: true, cascadeSnapshot };
    throw new Error(`unexpected operation: ${operationId}`);
  } };
  const store = { call: async (name, payload) => {
    if (name === 'savePlan') { plans.set(payload.planId, payload); if (payload.planId === runId) currentPlan = payload; return payload; }
    if (name === 'loadPlan') return plans.get(String(payload));
    if (name === 'createMutationRun') return { runId, state: 'ready_for_review', stateRevision: 1 };
    if (name === 'prepareReturnIntent') return { stateVersion: 2, confirmationId: 'confirmation-final-resume',
      confirmationToken: 'confirmation-token', planDigest: 'plan-digest-final-resume', expiresAt: '2099-01-01T00:00:00.000Z' };
    if (name === 'approveReturnIntent' || name === 'validateReturnAuthority' || name === 'recordReturnEvidence'
      || name === 'freezeReturnEvidenceSpec') return { ok: true };
    if (name === 'prepareDeletionCommand') return { commandId: 'command-final-resume', idempotencyKey: 'idempotency-final-resume' };
    if (name === 'projectVerifiedDeletionCascade') { cascadeProjections += 1; return { projected: true }; }
    if (name === 'finishReturn') return { state: payload.outcome };
    throw new Error(`unexpected store call: ${name}`);
  } };
  const ports = { connector, store, events: { emit: async () => undefined } };
  const firstWorker = createFeatureWorker(ports); t.after(() => firstWorker.shutdown());
  const context = { connectorBinding, safetyLock };
  await firstWorker.refreshCatalog(context);
  await firstWorker.handleAction({ actionId: 'create-delete-plan', expectedStateVersion: 1, context,
    payload: { targetIds: [`GRA|${graId}`] } });
  while (currentPlan.state === 'preparing') await firstWorker.handleAction({ actionId: 'continue-delete-plan-preparation',
    expectedStateVersion: currentPlan.surfaceStateVersion, context, payload: { runId } });
  const firstResult = await firstWorker.handleAction({ actionId: 'confirm-delete-plan', expectedStateVersion: currentPlan.surfaceStateVersion,
    context, payload: { runId } });
  assert.equal(currentPlan.state, 'uncertain');
  assert.equal(currentPlan.uncertain.phase, 'final_catalog');
  assert.equal(currentPlan.finalVerification.state, 'pending');
  assert.equal(firstResult.surfacePatch.actions.find((action) => action.actionId === 'reconcile-delete-plan').enabled, true);
  assert.equal(directMutations, 1);
  assert.equal(cascadeProjections, 1);

  await firstWorker.shutdown();
  const resumedWorker = createFeatureWorker(ports); t.after(() => resumedWorker.shutdown());
  const resumed = await resumedWorker.handleAction({ actionId: 'reconcile-delete-plan', expectedStateVersion: currentPlan.surfaceStateVersion,
    context, payload: { runId } });
  assert.equal(currentPlan.state, 'completed');
  assert.equal(currentPlan.uncertain, undefined);
  assert.equal(currentPlan.finalVerification.state, 'verified');
  assert.deepEqual(currentPlan.finalVerification.expectedDeletedTargetIds, [`GRA|${graId}`]);
  assert.deepEqual(currentPlan.finalVerification.verifiedAbsentTargetIds, [`GRA|${graId}`]);
  assert.equal(resumed.surfacePatch.progress.state, 'passed');
  assert.equal(directMutations, 1, 'final catalog resume must not replay the GRA mutation');
  assert.equal(cascadeProjections, 1, 'final catalog resume must not duplicate the cascade projection');
});
