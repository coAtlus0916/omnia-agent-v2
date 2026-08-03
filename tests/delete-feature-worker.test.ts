import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const candidate = path.join(repo, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.2.ofp');

function loadWorker(): any {
  const envelope = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
    files: Array<{ path: string; contentBase64: string }>;
  };
  const worker = envelope.files.find((file) => file.path === 'middle/worker.cjs')!;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-delete-worker-'));
  const filename = path.join(directory, 'worker.cjs');
  fs.writeFileSync(filename, Buffer.from(worker.contentBase64, 'base64'));
  return createRequire(import.meta.url)(filename);
}

function fixture() {
  const calls: string[] = [];
  const evidence: any[] = [];
  const managed: any[] = [];
  const emitted: any[] = [];
  const persisted = new Map<string, any>();
  let deleted = false;
  let responseLost = false;
  let responseLostApplied = true;
  let changedPreflight = false;
  let preflightCount = 0;
  let reconcileReadFails = false;
  const binding = { connectorId: 'connector-1', sessionGeneration: 7, engagementId: 'pack-1' };
  const safetyLock = {
    enabled: true,
    engagementId: 'pack-1',
    stateVersion: 3,
    authorityObservationId: 'observation-1',
    workspaceIds: ['workspace-1']
  };
  const item = {
    objectId: 'object-1',
    informationId: 'information-1',
    workItemId: 'workitem-1',
    objectType: 'Information',
    workspaceIds: ['workspace-1'],
    updatedAt: '2026-07-31T00:00:00.000Z'
  };
  const connector = {
    invoke: async (envelope: any) => {
      calls.push(envelope.operationId);
      switch (envelope.operationId) {
        case 'omnia.delete.scope.read.v1':
          return { ...binding, workspaceIds: ['workspace-1'] };
        case 'omnia.delete.catalog.heavy-read.v1':
          return { items: [item] };
        case 'omnia.delete.information.preflight.v1':
          preflightCount += 1;
          return {
            informationId: item.informationId,
            workItemId: item.workItemId,
            workspaceIds: item.workspaceIds,
            updatedAt: changedPreflight && preflightCount > 1 ? '2026-08-01T00:00:00.000Z' : item.updatedAt,
            blockers: []
          };
        case 'omnia.delete.information.direct.v1': {
          deleted = !responseLost || responseLostApplied;
          if (responseLost) {
            const error: any = new Error('response lost');
            error.code = 'CONNECTOR.RESPONSE_LOST';
            throw error;
          }
          return { accepted: true };
        }
        case 'omnia.delete.information.reconcile.v1':
          if (reconcileReadFails) {
            const error: any = new Error('reconcile read timed out');
            error.code = 'CONNECTOR.OPERATION_TIMEOUT';
            throw error;
          }
          return { informationId: item.informationId, deleted };
        default:
          throw new Error(`Unexpected operation ${envelope.operationId}`);
      }
    }
  };
  const store = {
    append: async (entry: any) => { evidence.push(entry); },
    upsertManagedContent: async (entry: any) => { managed.push(entry); },
    savePlan: async (plan: any) => { persisted.set(plan.planId, structuredClone(plan)); },
    loadPlan: async (planId: string) => structuredClone(persisted.get(planId) || null)
  };
  const events = { emit: async (entry: any) => { emitted.push(entry); } };
  return {
    calls,
    evidence,
    managed,
    emitted,
    binding,
    safetyLock,
    connector,
    store,
    events,
    setDeleted: (value: boolean) => { deleted = value; },
    loseResponse: (applied = true) => { responseLost = true; responseLostApplied = applied; },
    changePreflight: () => { changedPreflight = true; },
    failReconcileRead: () => { reconcileReadFails = true; }
  };
}

test('worker freezes identity, checkpoints commit, reconciles and writes managed-content tombstone', async () => {
  const module = loadWorker();
  const state = fixture();
  const worker = module.createDeleteElementsWorker({
    connector: state.connector,
    store: state.store,
    events: state.events,
    uuid: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })()
  });
  const plan = await worker.createPlan({
    connectorBinding: state.binding,
    safetyLock: state.safetyLock,
    targetIds: ['object-1']
  });
  const card = worker.messageCard(plan);
  assert.equal(card.featureVersion, '0.1.2');
  assert.equal(card.surfaceId, 'delete-elements.workbench');
  assert.equal(card.runId, plan.planId);
  assert.equal(card.confirmationId, plan.confirmationId);
  assert.equal(card.stateVersion, plan.stateVersion);
  assert.equal(card.actions[0].actionId, 'confirm-delete-plan');
  const result = await worker.confirm({
    planId: plan.planId,
    confirmationId: plan.confirmationId,
    expectedStateVersion: plan.stateVersion,
    safetyLock: state.safetyLock
  });
  assert.equal(result.state, 'completed');
  assert.equal(state.calls.filter((call) => call === 'omnia.delete.information.direct.v1').length, 1);
  assert.ok(state.evidence.find((entry) => entry.checkpoint === 'commit_attempted'));
  assert.ok(state.evidence.find((entry) => entry.checkpoint === 'response_received'));
  assert.ok(state.evidence.find((entry) => entry.checkpoint === 'post_read'));
  assert.equal(state.managed[0].status, 'deleted');
  assert.equal(state.emitted[0].type, 'workspace.authoritative_refresh_requested');
});

test('response-lost becomes uncertain and only read-only reconcile can resolve it', async () => {
  const module = loadWorker();
  const state = fixture();
  state.loseResponse();
  const worker = module.createDeleteElementsWorker({
    connector: state.connector,
    store: state.store,
    events: state.events
  });
  const plan = await worker.createPlan({
    connectorBinding: state.binding,
    safetyLock: state.safetyLock,
    targetIds: ['object-1']
  });
  const result = await worker.confirm({
    planId: plan.planId,
    confirmationId: plan.confirmationId,
    expectedStateVersion: plan.stateVersion,
    safetyLock: state.safetyLock
  });
  assert.equal(result.state, 'completed');
  assert.ok(state.evidence.find((entry) => entry.checkpoint === 'response_lost'));
  assert.equal(state.calls.filter((call) => call === 'omnia.delete.information.direct.v1').length, 1);
  assert.equal(state.calls.at(-1), 'omnia.delete.information.reconcile.v1');
});

test('post-commit reconcile failures persist uncertain and expose only read-only reconcile', async () => {
  const module = loadWorker();
  for (const responseLost of [false, true]) {
    const state = fixture();
    if (responseLost) state.loseResponse();
    state.failReconcileRead();
    const worker = module.createDeleteElementsWorker({
      connector: state.connector,
      store: state.store,
      events: state.events
    });
    const plan = await worker.createPlan({
      connectorBinding: state.binding,
      safetyLock: state.safetyLock,
      targetIds: ['object-1']
    });
    const uncertain = await worker.confirm({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      expectedStateVersion: plan.stateVersion,
      safetyLock: state.safetyLock
    });
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(state.calls.filter((call) => call === 'omnia.delete.information.direct.v1').length, 1);
    assert.ok(state.evidence.find((entry) => entry.checkpoint === 'reconcile_read_failed'));
    const card = worker.messageCard(uncertain);
    assert.deepEqual(card.actions.map((action: any) => action.actionId), ['reconcile-delete-plan']);
    assert.equal(card.actions[0].effect, 'read_only');
  }
});

test('uncertain plan is recovered from persistent Store port after worker restart', async () => {
  const module = loadWorker();
  const state = fixture();
  state.loseResponse(false);
  const firstWorker = module.createDeleteElementsWorker({
    connector: state.connector,
    store: state.store,
    events: state.events
  });
  const plan = await firstWorker.createPlan({
    connectorBinding: state.binding,
    safetyLock: state.safetyLock,
    targetIds: ['object-1']
  });
  const uncertain = await firstWorker.confirm({
    planId: plan.planId,
    confirmationId: plan.confirmationId,
    expectedStateVersion: plan.stateVersion,
    safetyLock: state.safetyLock
  });
  assert.equal(uncertain.state, 'uncertain');
  state.setDeleted(true);
  const recoveredWorker = module.createDeleteElementsWorker({
    connector: state.connector,
    store: state.store,
    events: state.events
  });
  const completed = await recoveredWorker.reconcile(plan.planId);
  assert.equal(completed.state, 'completed');
  assert.equal(state.managed[0].status, 'deleted');
});

test('plan created by worker A is loaded, confirmed and reconciled by worker B', async () => {
  const module = loadWorker();
  const state = fixture();
  const workerA = module.createDeleteElementsWorker({
    connector: state.connector,
    store: state.store,
    events: state.events
  });
  const plan = await workerA.createPlan({
    connectorBinding: state.binding,
    safetyLock: state.safetyLock,
    targetIds: ['object-1']
  });
  const workerB = module.createDeleteElementsWorker({
    connector: state.connector,
    store: state.store,
    events: state.events
  });
  const completed = await workerB.confirm({
    planId: plan.planId,
    confirmationId: plan.confirmationId,
    expectedStateVersion: plan.stateVersion,
    safetyLock: state.safetyLock
  });
  assert.equal(completed.state, 'completed');
  assert.equal(state.calls.filter((call) => call === 'omnia.delete.information.direct.v1').length, 1);
});

test('second preflight or safety-lock change blocks mutation', async () => {
  const module = loadWorker();
  const state = fixture();
  const worker = module.createDeleteElementsWorker({
    connector: state.connector,
    store: state.store,
    events: state.events
  });
  const plan = await worker.createPlan({
    connectorBinding: state.binding,
    safetyLock: state.safetyLock,
    targetIds: ['object-1']
  });
  state.changePreflight();
  await assert.rejects(
    worker.confirm({
      planId: plan.planId,
      confirmationId: plan.confirmationId,
      expectedStateVersion: plan.stateVersion,
      safetyLock: state.safetyLock
    }),
    /Target identity, blockers, Workspace impact, or concurrency token changed/
  );
  assert.equal(state.calls.includes('omnia.delete.information.direct.v1'), false);

  const second = fixture();
  const secondWorker = module.createDeleteElementsWorker({
    connector: second.connector,
    store: second.store,
    events: second.events
  });
  const secondPlan = await secondWorker.createPlan({
    connectorBinding: second.binding,
    safetyLock: second.safetyLock,
    targetIds: ['object-1']
  });
  await assert.rejects(
    secondWorker.confirm({
      planId: secondPlan.planId,
      confirmationId: secondPlan.confirmationId,
      expectedStateVersion: secondPlan.stateVersion,
      safetyLock: { ...second.safetyLock, stateVersion: 4 }
    }),
    /Safety lock changed/
  );
  assert.equal(second.calls.includes('omnia.delete.information.direct.v1'), false);
});
