'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createFeatureWorker } = require('../middle/worker.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
const packageRoot = path.resolve(__dirname, '..');
const managedTempRoot = path.join(repositoryRoot, '.codex-tmp', `delete-one-side-${process.pid}`);
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

const workspaceId = '11111111-1111-1111-1111-111111111111';
const sectionId = '22222222-2222-2222-2222-222222222222';
const connectorBinding = { connectorId: 'connector-one-side', sessionGeneration: 9,
  engagementId: '33333333-3333-3333-3333-333333333333', authorityInstanceId: 'https://authority.example.invalid',
  tenantOrOrgId: 'tenant-one-side', packId: 'pack-one-side' };
const safetyLock = { enabled: true, validForCurrentConnection: true, globalEnabled: false,
  connectorId: connectorBinding.connectorId, sessionGeneration: connectorBinding.sessionGeneration,
  engagementId: connectorBinding.engagementId, authorityInstanceId: connectorBinding.authorityInstanceId,
  tenantOrOrgId: connectorBinding.tenantOrOrgId, packId: connectorBinding.packId,
  stateVersion: 11, authorityObservationId: 'observation-one-side', workspaceIds: [workspaceId] };

const db = { objectType: 'DB', objectId: '44444444-4444-4444-4444-444444444443',
  workItemId: '55555555-5555-5555-5555-555555555553', workspaceIds: [workspaceId], number: 'TEST-DB', name: 'TEST DB', updatedAt: '2026-08-07T00:00:00.000Z' };
const app = { objectType: 'APP', objectId: '44444444-4444-4444-4444-444444444442',
  workItemId: '55555555-5555-5555-5555-555555555552', workspaceIds: [workspaceId], number: 'TEST-APP', name: 'TEST APP', updatedAt: '2026-08-07T00:00:00.000Z' };

function buildWorker() {
  const plans = new Map(); let capturedPlan = null;
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId, request }) => {
      if (operationId === 'omnia.delete.scope.read.v1') return { ...connectorBinding, workspaceIds: [workspaceId],
        sections: [{ id: sectionId, name: 'TEST Section' }], workspaces: [{ id: workspaceId, name: 'TEST', parentSectionId: sectionId }] };
      if (operationId === 'omnia.delete.catalog.heavy-read.v1') return { engagementId: connectorBinding.engagementId, items: [db, app] };
      if (operationId === 'omnia.delete.it-element.preflight.v1') {
        const target = request.objectType || request.target.objectType;
        if (target === 'DB') {
          return { objectId: db.objectId, objectType: 'DB', workItemId: db.workItemId, workspaceIds: [workspaceId],
            updatedAt: db.updatedAt, riskAssessmentId: '', relations: [],
            blockers: [{ type: 'Application', id: app.objectId, workItemId: app.workItemId, objectType: 'APP', workspaceId }] };
        }
        if (target === 'APP') {
          return { objectId: app.objectId, objectType: 'APP', workItemId: app.workItemId, workspaceIds: [workspaceId],
            updatedAt: app.updatedAt, riskAssessmentId: '', relations: [],
            blockers: [{ type: 'Infrastructure', id: db.objectId, workItemId: db.workItemId, objectType: 'DB', workspaceId }] };
        }
        throw new Error(`unexpected it-element preflight target: ${target}`);
      }
      if (operationId.endsWith('.preflight.v1')) return { relationGroupKey: request.target.targetIdentityKey, targetObjectIds: request.targetObjectIds,
        relationType: request.relationType,
        source: { objectId: request.sourceObjectId, objectType: request.sourceObjectType, workItemId: request.sourceWorkItemId, workspaceId },
        targets: request.targets.map((target) => ({ ...target, updatedAt: '2026-08-07T00:00:00.000Z', associated: true, inconsistent: false, deleted: false })),
        concurrency: { entityTabTypeId: 602, updatedOn: '2026-08-07T00:00:00.000Z' },
        associated: true, inconsistent: false, deleted: false };
      throw new Error(`unexpected operation: ${operationId}`);
    } },
    store: { call: async (name, payload) => {
      if (name === 'createMutationRun') return { runId: 'run-one-side', stateRevision: 1 };
      if (name === 'prepareReturnIntent') return { stateVersion: 4, confirmationId: 'confirmation-one-side',
        confirmationToken: 'confirmation-token', planDigest: 'core-plan-digest', expiresAt: '2099-01-01T00:00:00.000Z' };
      if (name === 'savePlan') { plans.set(payload.planId, payload); if (payload.schemaVersion === 'omnia.delete-plan/v5') capturedPlan = payload; return payload; }
      if (name === 'loadPlan') return plans.get(String(payload));
      throw new Error(`unexpected store call: ${name}`);
    } }, events: { emit: async () => undefined }
  });
  return { worker, getPlan: () => capturedPlan };
}

test('DB-only selection deletes only the DB: the paired APP is unlinked but produces no object step', async (t) => {
  const { worker, getPlan } = buildWorker();
  t.after(() => worker.shutdown());
  const context = { connectorBinding, safetyLock };
  await worker.refreshCatalog(context);
  await worker.handleAction({ actionId: 'create-delete-plan', context, payload: { targetIds: [`${db.objectType}|${db.objectId}`] } });
  while (getPlan().state === 'preparing') {
    await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: getPlan().surfaceStateVersion,
      context, payload: { runId: getPlan().runId } });
  }
  const capturedPlan = getPlan();
  assert.equal(capturedPlan.state, 'pending_confirmation');
  // Exactly one relation step and one object step (DB). No APP object step.
  assert.deepEqual(capturedPlan.steps.map((step) => step.kind), ['relation', 'object']);
  assert.deepEqual(capturedPlan.steps.filter((step) => step.kind === 'object').map((step) => step.objectType), ['DB']);
  const relationStep = capturedPlan.steps.find((step) => step.kind === 'relation');
  assert.equal(relationStep.request.sourceObjectId, db.objectId);
  assert.deepEqual(relationStep.request.targetObjectIds, [app.objectId]);
  // The relation group affects only the selected DB endpoint.
  assert.deepEqual(relationStep.affectedTargetKeys, [`${db.objectType}|${workspaceId}|${db.objectId}`]);
});

test('APP-only selection deletes only the APP: the Infrastructure relation is unlinked but the DB is retained', async (t) => {
  const { worker, getPlan } = buildWorker();
  t.after(() => worker.shutdown());
  const context = { connectorBinding, safetyLock };
  await worker.refreshCatalog(context);
  await worker.handleAction({ actionId: 'create-delete-plan', context, payload: { targetIds: [`${app.objectType}|${app.objectId}`] } });
  while (getPlan().state === 'preparing') {
    await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: getPlan().surfaceStateVersion,
      context, payload: { runId: getPlan().runId } });
  }
  const capturedPlan = getPlan();
  assert.equal(capturedPlan.state, 'pending_confirmation');
  assert.deepEqual(capturedPlan.steps.map((step) => step.kind), ['relation', 'object']);
  assert.deepEqual(capturedPlan.steps.filter((step) => step.kind === 'object').map((step) => step.objectType), ['APP']);
});
