'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createFeatureWorker } = require('../middle/worker.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
const packageRoot = path.resolve(__dirname, '..');
const managedTempRoot = path.join(repositoryRoot, '.codex-tmp', `delete-preparation-core-terminal-${process.pid}`);
process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = path.join(repositoryRoot, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(packageRoot, 'python', 'engine.py');
process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
process.env.OMNIA_FEATURE_TEMP_ROOT = managedTempRoot;
test.after(() => fs.rmSync(managedTempRoot, { recursive: true, force: true }));

function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }

test('Core terminal write failure remains uncertain until read-only terminal reconcile verifies failed', async (t) => {
  const workspaceId = '11111111-1111-1111-1111-111111111111';
  const graId = '22222222-2222-2222-2222-222222222222';
  const workItemId = '33333333-3333-3333-3333-333333333333';
  const connectorBinding = { connectorId: 'connector-core-terminal', sessionGeneration: 3,
    engagementId: '44444444-4444-4444-4444-444444444444', authorityInstanceId: 'https://authority.example.invalid',
    tenantOrOrgId: 'tenant-core-terminal', packId: 'pack-core-terminal' };
  const safetyLock = { enabled: true, validForCurrentConnection: true, globalEnabled: false,
    connectorId: connectorBinding.connectorId, sessionGeneration: connectorBinding.sessionGeneration,
    engagementId: connectorBinding.engagementId, authorityInstanceId: connectorBinding.authorityInstanceId,
    tenantOrOrgId: connectorBinding.tenantOrOrgId, packId: connectorBinding.packId,
    stateVersion: 3, authorityObservationId: 'observation-core-terminal', workspaceIds: [workspaceId] };
  const assessment = { riskAssessmentId: graId, workItemId, workspaceId, updatedOn: '2026-08-07T01:00:00.000Z' };
  const cascadeSnapshot = { schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1', assessment, risks: [], controls: [], riskControls: [] };
  cascadeSnapshot.snapshotDigest = digest(cascadeSnapshot);
  const gra = { objectId: graId, riskAssessmentId: graId, objectType: 'GRA', workItemId, workspaceIds: [workspaceId],
    number: 'TEST-GRA', name: 'TEST GRA', updatedAt: assessment.updatedOn, blockers: [], relations: [] };
  const plans = new Map(); let plan = null; let allowFinish = false;
  const worker = createFeatureWorker({ connector: { invoke: async ({ operationId }) => {
    if (operationId === 'omnia.delete.scope.read.v1') return { ...connectorBinding, workspaceIds: [workspaceId],
      sections: [{ id: 'section-test', name: 'TEST' }], workspaces: [{ id: workspaceId, name: 'TEST', parentSectionId: 'section-test' }] };
    if (operationId === 'omnia.delete.catalog.heavy-read.v1') return { engagementId: connectorBinding.engagementId, items: [gra] };
    if (operationId === 'omnia.delete.gra.preflight.v1') return { objectId: graId, riskAssessmentId: graId, objectType: 'GRA', workItemId,
      workspaceIds: [workspaceId], updatedAt: assessment.updatedOn, blockers: [], relations: [], cascadeSnapshot };
    throw new Error(`unexpected operation: ${operationId}`);
  } }, store: { call: async (name, payload) => {
    if (name === 'createMutationRun') return { runId: 'run-core-terminal' };
    if (name === 'prepareReturnIntent') return { stateVersion: 2, confirmationId: 'confirmation-core-terminal',
      confirmationToken: 'confirmation-token', planDigest: 'core-plan-digest', expiresAt: '2099-01-01T00:00:00.000Z' };
    if (name === 'savePlan') { plans.set(payload.planId, payload); if (payload.schemaVersion === 'omnia.delete-plan/v5') plan = payload; return payload; }
    if (name === 'loadPlan') return plans.get(String(payload));
    if (name === 'approveReturnIntent') return { approved: true };
    if (name === 'validateReturnAuthority') throw Object.assign(new Error('Core authority validation failed.'), { code: 'CORE.AUTHORITY_FAILED' });
    if (name === 'finishReturn') {
      if (!allowFinish) throw Object.assign(new Error('Core terminal response unavailable.'), { code: 'CORE.TERMINAL_UNAVAILABLE' });
      return { state: 'failed' };
    }
    if (name === 'loadLatestRun') return { run: { run_id: 'run-core-terminal', state: 'returning', state_revision: 5 } };
    throw new Error(`unexpected store call: ${name}`);
  } }, events: { emit: async () => undefined } });
  t.after(() => worker.shutdown());
  const context = { connectorBinding, safetyLock };
  await worker.refreshCatalog(context);
  await worker.handleAction({ actionId: 'create-delete-plan', context, payload: { targetIds: [`GRA|${graId}`] } });
  while (plan.state === 'preparing') await worker.handleAction({ actionId: 'continue-delete-plan-preparation',
    expectedStateVersion: plan.surfaceStateVersion, context, payload: { runId: plan.runId } });
  const afterConfirm = await worker.handleAction({ actionId: 'confirm-delete-plan', expectedStateVersion: plan.surfaceStateVersion,
    context, payload: { runId: plan.runId } });
  assert.equal(plan.state, 'uncertain');
  assert.equal(plan.uncertain.phase, 'core_terminal');
  assert.match(afterConfirm.surfacePatch.statusMessage, /uncertain/u);
  assert.equal(afterConfirm.surfacePatch.actions.find((action) => action.actionId === 'reconcile-delete-plan').label, '重试 Core 终态核验');
  allowFinish = true;
  const reconciled = await worker.handleAction({ actionId: 'reconcile-delete-plan', context, payload: { runId: plan.runId } });
  assert.equal(plan.state, 'failed');
  assert.equal(plan.uncertain, undefined);
  assert.equal(reconciled.surfacePatch.progress.state, 'failed');
  assert.match(reconciled.surfacePatch.progress.message, /真实结果/u);
});
