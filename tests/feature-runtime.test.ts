import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { CoreDatabase } from '../src/main/database.js';
import { FeaturePackageManager } from '../src/main/features/package-manager.js';
import { packageDigest, verifyOfficialPackage } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const repository = path.resolve(import.meta.dirname, '..');
const packageFilename = path.join(repository, 'feature-packages/delete-elements/candidates/delete-elements-0.1.2.ofp');
const engagementId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const informationId = '33333333-3333-4333-8333-333333333333';
const blockedInformationId = '55555555-5555-4555-8555-555555555555';
const workItemId = '44444444-4444-4444-8444-444444444444';

test('installed 0.1.2 starts a real worker, persists selection/card/evidence, and authorizes only card mutation', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-feature-runtime-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, { encrypt: (v) => v, decrypt: (v) => v });
  const hostEntrypoint = path.join(temporary, 'feature-worker-host.cjs');
  await build({
    entryPoints: [path.join(repository, 'src/main/features/feature-worker-host.ts')],
    outfile: hostEntrypoint,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24'
  });
  const installer = new FeaturePackageManager(database.db, paths);
  installer.install(packageFilename);
  let deleted = false;
  let reconcileFails = false;
  let mutationErrorCode = '';
  const mutations: boolean[] = [];
  const connector: any = {
    mode: 'remote', start: async () => undefined, stop: async () => undefined,
    unavailableSnapshot: () => ({}), load: async () => ({}), connect: async () => ({}), refresh: async () => ({}),
    lightRead: async () => ({}),
    registerOperation: async (input: any) => {
      const envelope = verifyOfficialPackage(input.operationPackage, 'omnia-connector-operation');
      return {
        schemaVersion: 'omnia.operation-registration-result/v1',
        featureId: input.featureId,
        featureVersion: input.featureVersion,
        packageId: envelope.packageId,
        packageDigest: packageDigest(envelope),
        operationIds: []
      };
    },
    invokeOperation: async (input: any) => {
      if (input.operationId === 'omnia.delete.scope.read.v1') return {
        connectorId: 'connector-1', sessionGeneration: 9, engagementId, workspaceIds: [workspaceId]
      };
      if (input.operationId === 'omnia.delete.catalog.heavy-read.v1') return {
        items: [
          {
            objectId: informationId, informationId, workItemId, objectType: 'Information',
            workspaceIds: [workspaceId], updatedAt: '2026-08-01T00:00:00Z', number: 'IPE-001',
            name: 'Payroll report', blockers: []
          },
          {
            objectId: blockedInformationId, informationId: blockedInformationId,
            workItemId: '66666666-6666-4666-8666-666666666666', objectType: 'Information',
            workspaceIds: [workspaceId], updatedAt: '2026-08-01T00:00:00Z', number: 'IPE-002',
            name: 'Blocked report', blockers: [{ type: 'Control', id: 'blocker-1' }]
          }
        ]
      };
      if (input.operationId === 'omnia.delete.information.preflight.v1') return {
        informationId, workItemId, workspaceIds: [workspaceId],
        updatedAt: '2026-08-01T00:00:00Z', blockers: []
      };
      if (input.operationId === 'omnia.delete.information.direct.v1') {
        mutations.push(input.mutationAuthorized);
        deleted = true;
        if (mutationErrorCode) throw Object.assign(new Error('remote mutation response lost'), { code: mutationErrorCode });
        return { accepted: true };
      }
      if (input.operationId === 'omnia.delete.information.reconcile.v1') {
        if (reconcileFails) throw Object.assign(new Error('read failed'), { code: 'CONNECTOR.OPERATION_TIMEOUT' });
        return { informationId, deleted };
      }
      throw new Error(`Unexpected Operation ${input.operationId}`);
    }
  };
  const runtime = new FeaturePackageManager(database.db, paths, undefined, { connector, workerHostEntrypoint: hostEntrypoint });
  const context: any = {
    connection: {
      transport: 'remote', connected: true, connectorId: 'connector-1', sessionGeneration: 9, engagementId
    },
    safetyLock: {
      enabled: true, engagementId, workspaceIds: [workspaceId], authorityObservationId: 'observation-1',
      stateVersion: 1, validForCurrentConnection: true, invalidReason: ''
    }
  };
  try {
    await runtime.initializeRuntime();
    runtime.select('omnia.delete-elements');
    let snapshot = runtime.snapshot(context);
    assert.equal(snapshot.navigation[0]?.availability, 'available');
    snapshot = await runtime.action({
      featureId: 'omnia.delete-elements', featureVersion: '0.1.2', surfaceId: 'delete-elements.workbench',
      actionId: 'refresh-authoritative-catalog', expectedStateVersion: 1, payload: {}
    }, context);
    assert.equal(snapshot.surface?.items.length, 2);
    assert.equal(snapshot.surface?.items.find((item) => item.id === blockedInformationId)?.selectable, false);
    snapshot = await runtime.action({
      featureId: 'omnia.delete-elements', featureVersion: '0.1.2', surfaceId: 'delete-elements.workbench',
      actionId: 'runtime.set-selection', expectedStateVersion: snapshot.surface!.stateVersion,
      payload: { selectedItemIds: [informationId] }
    }, context);
    assert.deepEqual(snapshot.surface?.selectedItemIds, [informationId]);
    snapshot = await runtime.action({
      featureId: 'omnia.delete-elements', featureVersion: '0.1.2', surfaceId: 'delete-elements.workbench',
      actionId: 'create-delete-plan', expectedStateVersion: snapshot.surface!.stateVersion,
      payload: { targetIds: [informationId] }
    }, context);
    const card = snapshot.messageCards[0]!;
    assert.equal(card.state, 'pending_confirmation');
    assert.equal(mutations.length, 0);
    snapshot = await runtime.action({
      featureId: 'omnia.delete-elements', featureVersion: '0.1.2', surfaceId: 'delete-elements.workbench',
      actionId: 'confirm-delete-plan', expectedStateVersion: card.stateVersion,
      payload: { runId: card.runId, confirmationId: card.confirmationId }
    }, context);
    assert.equal(snapshot.messageCards[0]?.state, 'completed');
    assert.deepEqual(mutations, [true]);
    assert.equal((database.db.prepare('SELECT COUNT(*) AS count FROM managed_content_records').get() as any).count, 1);
    assert.equal((database.db.prepare('SELECT COUNT(*) AS count FROM feature_runtime_events').get() as any).count, 1);
    assert.equal(runtime.takePendingRuntimeEvents().length, 1);

    deleted = false;
    reconcileFails = true;
    mutationErrorCode = 'REMOTE.MUTATION_UNCERTAIN';
    snapshot = await runtime.action({
      featureId: 'omnia.delete-elements', featureVersion: '0.1.2', surfaceId: 'delete-elements.workbench',
      actionId: 'runtime.set-selection', expectedStateVersion: snapshot.surface!.stateVersion,
      payload: { selectedItemIds: [informationId] }
    }, context);
    snapshot = await runtime.action({
      featureId: 'omnia.delete-elements', featureVersion: '0.1.2', surfaceId: 'delete-elements.workbench',
      actionId: 'create-delete-plan', expectedStateVersion: snapshot.surface!.stateVersion,
      payload: { targetIds: [informationId] }
    }, context);
    const pending = snapshot.messageCards.find((item) => item.state === 'pending_confirmation')!;
    const mutationCount = mutations.length;
    snapshot = await runtime.action({
      featureId: 'omnia.delete-elements', featureVersion: '0.1.2', surfaceId: 'delete-elements.workbench',
      actionId: 'confirm-delete-plan', expectedStateVersion: pending.stateVersion,
      payload: { runId: pending.runId, confirmationId: pending.confirmationId }
    }, context);
    const uncertain = snapshot.messageCards.find((item) => item.runId === pending.runId)!;
    assert.equal(uncertain.state, 'uncertain');
    assert.deepEqual(uncertain.actions.map((item) => [item.actionId, item.effect]), [
      ['reconcile-delete-plan', 'read_only']
    ]);
    assert.equal(mutations.length, mutationCount + 1);
  } finally {
    await runtime.disposeRuntime();
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
