'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }

const bridgePath = require.resolve('../middle/delete-elements-python-bridge.cjs');
const workerPath = require.resolve('../middle/worker.cjs');
const realBridge = require(bridgePath);
let compilerCalls = 0;
const tamperedBridge = {
  start: async () => undefined,
  close: async () => undefined,
  invoke: async (method, payload) => {
    assert.equal(method, 'compile_delete_preparation');
    compilerCalls += 1;
    const rogueId = '99999999-9999-9999-9999-999999999999';
    const rogueSeed = { key: `GRA|${workspaceId}|${rogueId}`, riskAssessmentId: rogueId,
      workspace: workspaceId, affectedTargetKeys: [`Information|${workspaceId}|${informationId}`] };
    const body = { schemaVersion: 'omnia.delete-preparation-compile-output/v1', planId: payload.planId, runId: payload.runId,
      graSeeds: [rogueSeed], derivedGraSeeds: [rogueSeed], relationDescriptors: [], dependencySkeleton: [] };
    return { ...body, compilationDigest: digest(body) };
  }
};
require.cache[bridgePath].exports = Object.freeze({ ...realBridge, createPythonSidecarBridge: () => tamperedBridge });
delete require.cache[workerPath];
const { createFeatureWorker } = require(workerPath);

const workspaceId = '11111111-1111-1111-1111-111111111111';
const informationId = '22222222-2222-2222-2222-222222222222';
const workItemId = '33333333-3333-3333-3333-333333333333';
const connectorBinding = { connectorId: 'connector-tamper', sessionGeneration: 4,
  engagementId: '44444444-4444-4444-4444-444444444444', authorityInstanceId: 'https://authority.example.invalid',
  tenantOrOrgId: 'tenant-tamper', packId: 'pack-tamper' };
const safetyLock = { enabled: true, validForCurrentConnection: true, globalEnabled: false, ...connectorBinding,
  stateVersion: 9, authorityObservationId: 'observation-tamper', workspaceIds: [workspaceId] };

test.after(() => {
  require.cache[bridgePath].exports = realBridge;
  delete require.cache[workerPath];
});

test('Worker rejects a valid-digest Python compiler output with an extra identity before Core intent or mutation', async (t) => {
  const runId = 'run-compiler-tamper'; const plans = new Map(); let currentPlan = null; let prepareCount = 0; let mutationCount = 0;
  const store = { call: async (name, payload) => {
    if (name === 'savePlan') { plans.set(payload.planId, payload); if (payload.planId === runId) currentPlan = payload; return payload; }
    if (name === 'loadPlan') return plans.get(String(payload));
    if (name === 'createMutationRun') return { runId, state: 'ready_for_review', stateRevision: 1 };
    if (name === 'prepareReturnIntent') { prepareCount += 1; throw new Error('Core intent must not be prepared for tampered compiler output.'); }
    throw new Error(`unexpected store call: ${name}`);
  } };
  const connector = { invoke: async ({ operationId }) => {
    if (operationId.includes('.direct.')) mutationCount += 1;
    if (operationId === 'omnia.delete.information.preflight.v1') {
      return { objectId: informationId, informationId, objectType: 'Information', workItemId, workspaceIds: [workspaceId],
        updatedAt: '2026-08-09T00:00:00.000Z', riskAssessmentId: '', blockers: [], relations: [] };
    }
    throw new Error(`unexpected operation: ${operationId}`);
  } };
  const worker = createFeatureWorker({ connector, store, events: { emit: async () => undefined } });
  t.after(() => worker.shutdown());
  const snapshotId = `catalog:${digest({ connectorId: connectorBinding.connectorId, sessionGeneration: connectorBinding.sessionGeneration,
    engagementId: connectorBinding.engagementId, authorityInstanceId: connectorBinding.authorityInstanceId,
    tenantOrOrgId: connectorBinding.tenantOrOrgId, packId: connectorBinding.packId, workspaceIds: [workspaceId] })}`;
  await store.call('savePlan', { schemaVersion: 'omnia.delete-catalog-snapshot/v1', planId: snapshotId,
    capturedAt: '2026-08-09T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', binding: connectorBinding,
    safetyRevision: safetyLock.stateVersion, items: [{ objectType: 'Information', objectId: informationId, informationId,
      workItemId, workspaceIds: [workspaceId], number: 'INFO-TAMPER', name: 'Compiler tamper',
      updatedAt: '2026-08-09T00:00:00.000Z', blockers: [], relations: [] }] });
  const context = { connectorBinding, safetyLock };
  await worker.handleAction({ actionId: 'create-delete-plan', expectedStateVersion: 3, context,
    payload: { targetIds: [`Information|${informationId}`] } });
  const result = await worker.handleAction({ actionId: 'continue-delete-plan-preparation', expectedStateVersion: currentPlan.surfaceStateVersion,
    context, payload: { runId } });
  assert.equal(compilerCalls, 1);
  assert.equal(currentPlan.state, 'preparing');
  assert.equal(currentPlan.preparation.objectCursor, 0);
  assert.deepEqual(currentPlan.preparation.objectPreflights, []);
  assert.equal(currentPlan.preparation.failure.code, 'DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT');
  assert.equal(prepareCount, 0);
  assert.equal(mutationCount, 0);
  assert.equal(JSON.stringify(result).includes('messageCard'), false);
});
