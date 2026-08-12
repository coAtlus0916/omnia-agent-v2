'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createFeatureWorker } = require('../middle/worker.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
const packageRoot = path.resolve(__dirname, '..');
const managedTempRoot = path.join(repositoryRoot, '.codex-tmp', `delete-preparation-all-types-${process.pid}`);
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

test('TEST mixed GRA APP DB OS DCNO Tool selection freezes one confirmed relation-first parameterized graph', async (t) => {
  const workspaceId = '11111111-1111-1111-1111-111111111111';
  const sectionId = '22222222-2222-2222-2222-222222222222';
  const connectorBinding = { connectorId: 'connector-test', sessionGeneration: 9,
    engagementId: '33333333-3333-3333-3333-333333333333', authorityInstanceId: 'https://authority.example.invalid',
    tenantOrOrgId: 'tenant-test', packId: 'pack-test' };
  const safetyLock = { enabled: true, validForCurrentConnection: true, globalEnabled: false,
    connectorId: connectorBinding.connectorId, sessionGeneration: connectorBinding.sessionGeneration,
    engagementId: connectorBinding.engagementId, authorityInstanceId: connectorBinding.authorityInstanceId,
    tenantOrOrgId: connectorBinding.tenantOrOrgId, packId: connectorBinding.packId,
    stateVersion: 11, authorityObservationId: 'observation-test', workspaceIds: [workspaceId] };
  const definitions = [
    ['GRA', '44444444-4444-4444-4444-444444444441', '55555555-5555-5555-5555-555555555551'],
    ['APP', '44444444-4444-4444-4444-444444444442', '55555555-5555-5555-5555-555555555552'],
    ['DB', '44444444-4444-4444-4444-444444444443', '55555555-5555-5555-5555-555555555553'],
    ['OS', '44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555554'],
    ['DCNO', '44444444-4444-4444-4444-444444444445', '55555555-5555-5555-5555-555555555555'],
    ['TOOL', '44444444-4444-4444-4444-444444444446', '55555555-5555-5555-5555-555555555556']
  ];
  const items = definitions.map(([objectType, objectId, workItemId]) => ({ objectType, objectId, workItemId,
    ...(objectType === 'GRA' ? { riskAssessmentId: objectId } : {}), workspaceIds: [workspaceId], number: `TEST-${objectType}`,
    name: `TEST ${objectType}`, updatedAt: '2026-08-07T00:00:00.000Z', blockers: [], relations: [] }));
  const byType = new Map(items.map((item) => [item.objectType, item]));
  const app = byType.get('APP'); const tool = byType.get('TOOL');
  const infra = ['DB', 'OS', 'DCNO'].map((kind) => byType.get(kind));
  const relation = (relationType, source, target) => ({ relationType, sourceObjectId: source.objectId, targetObjectId: target.objectId,
    sourceObjectType: source.objectType, targetObjectType: target.objectType, sourceWorkItemId: source.workItemId,
    targetWorkItemId: target.workItemId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId });
  const toolEdge = relation('ItToolApplication', tool, app);
  const objectPreflight = (item) => ({ objectId: item.objectId, objectType: item.objectType, workItemId: item.workItemId,
    workspaceIds: [workspaceId], updatedAt: item.updatedAt, riskAssessmentId: '',
    blockers: item.objectType === 'APP'
      ? [...infra.map((source) => ({ type: 'Infrastructure', id: source.objectId, workItemId: source.workItemId })),
        { type: 'ITTool', id: tool.objectId, workItemId: tool.workItemId }]
      : infra.includes(item) || item.objectType === 'TOOL'
        ? [{ type: 'Application', id: app.objectId, workItemId: app.workItemId }] : [],
    relations: item.objectType === 'APP' || item.objectType === 'TOOL' ? [toolEdge] : [] });
  const assessment = { riskAssessmentId: byType.get('GRA').objectId, workItemId: byType.get('GRA').workItemId,
    workspaceId, updatedOn: '2026-08-07T00:00:00.000Z' };
  const cascadeSnapshot = { schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1', assessment, risks: [], controls: [], riskControls: [] };
  cascadeSnapshot.snapshotDigest = digest(cascadeSnapshot);
  let capturedPlan = null; const plans = new Map();
  const worker = createFeatureWorker({
    connector: { invoke: async ({ operationId, request }) => {
      if (operationId === 'omnia.delete.scope.read.v1') return { ...connectorBinding, workspaceIds: [workspaceId],
        sections: [{ id: sectionId, name: 'TEST Section' }], workspaces: [{ id: workspaceId, name: 'TEST', parentSectionId: sectionId }] };
      if (operationId === 'omnia.delete.catalog.heavy-read.v1') return { engagementId: connectorBinding.engagementId, items };
      if (operationId === 'omnia.delete.gra.preflight.v1') return { objectId: byType.get('GRA').objectId,
        riskAssessmentId: byType.get('GRA').objectId, objectType: 'GRA', workItemId: byType.get('GRA').workItemId,
        workspaceIds: [workspaceId], updatedAt: assessment.updatedOn, blockers: [], relations: [], cascadeSnapshot };
      if (operationId === 'omnia.delete.it-element.preflight.v1') return objectPreflight(byType.get(request.objectType));
      if (operationId.endsWith('.preflight.v1')) return { relationGroupKey: request.target.targetIdentityKey, targetObjectIds: request.targetObjectIds,
        relationType: request.relationType,
        source: { objectId: request.sourceObjectId, objectType: request.sourceObjectType, workItemId: request.sourceWorkItemId, workspaceId },
        targets: request.targets.map((target) => ({ ...target, updatedAt: '2026-08-07T00:00:00.000Z', associated: true, inconsistent: false, deleted: false })),
        concurrency: { entityTabTypeId: request.relationType === 'ItToolApplication' ? 802 : 602, updatedOn: '2026-08-07T00:00:00.000Z' },
        associated: true, inconsistent: false, deleted: false };
      throw new Error(`unexpected operation: ${operationId}`);
    } },
    store: { call: async (name, payload) => {
      if (name === 'createMutationRun') return { runId: 'run-all-types', stateRevision: 1 };
      if (name === 'prepareReturnIntent') return { stateVersion: 4, confirmationId: 'confirmation-all-types',
        confirmationToken: 'confirmation-token', planDigest: 'core-plan-digest', expiresAt: '2099-01-01T00:00:00.000Z' };
      if (name === 'savePlan') { plans.set(payload.planId, payload); if (payload.schemaVersion === 'omnia.delete-plan/v5') capturedPlan = payload; return payload; }
      if (name === 'loadPlan') return plans.get(String(payload));
      throw new Error(`unexpected store call: ${name}`);
    } }, events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());
  const targetIds = items.map((item) => `${item.objectType}|${item.objectId}`);
  const context = { connectorBinding, safetyLock };
  await worker.refreshCatalog(context);
  let result = await worker.handleAction({ actionId: 'create-delete-plan', context, payload: { targetIds } });
  while (capturedPlan.state === 'preparing') {
    result = await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: capturedPlan.surfaceStateVersion,
      context, payload: { runId: capturedPlan.runId } });
  }
  assert.equal(capturedPlan.state, 'pending_confirmation');
  assert.deepEqual(capturedPlan.targets.map((item) => item.objectType).sort(), ['APP', 'DB', 'DCNO', 'GRA', 'OS', 'TOOL']);
  assert.deepEqual(capturedPlan.steps.map((step) => step.kind), ['relation', 'relation', 'relation', 'relation', 'cascade', 'object', 'object', 'object', 'object', 'object']);
  assert.deepEqual(capturedPlan.steps.filter((step) => step.kind === 'object').map((step) => step.objectType), ['DB', 'OS', 'DCNO', 'TOOL', 'APP']);
  const appSchedule = capturedPlan.scheduleGraph.find((step) => step.stepId.startsWith('APP|'));
  assert.equal(appSchedule.dependsOn.length, 4);
  for (const kind of ['DB', 'OS', 'DCNO', 'TOOL']) {
    const objectStep = capturedPlan.scheduleGraph.find((step) => step.stepId.startsWith(`${kind}|`));
    assert.equal(objectStep.dependsOn.length, 1);
  }
  assert.equal(capturedPlan.scheduleGraph.find((step) => step.stepId.startsWith('GRA|')).dependsOn.length, 0);
  assert.equal(result.messageCard, undefined);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'confirm-delete-plan').enabled, true);
  assert.equal(result.surfacePatch.actions.find((action) => action.actionId === 'refresh-authoritative-catalog').enabled, false);
  assert.equal(result.surfacePatch.items.filter((item) => item.id.startsWith('plan-target:')).length, items.length);
  assert.equal(result.surfacePatch.progress.total, capturedPlan.steps.length);
});
