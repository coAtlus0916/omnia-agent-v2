import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { OperationHost } from '../src/connector/operation-host.js';
import { packageFile, verifyOfficialPackage } from '../src/main/features/official-package.js';

const root = path.resolve(import.meta.dirname, '..');
const featurePackage = verifyOfficialPackage(
  JSON.parse(fs.readFileSync(path.join(root, 'feature-packages/delete-elements/candidates/delete-elements-0.1.2.ofp'), 'utf8')),
  'omnia-feature'
);
const operationPackage = JSON.parse(packageFile(featurePackage, 'connector-capability/operation.ofop').toString('utf8'));
const engagementId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const informationId = '33333333-3333-4333-8333-333333333333';
const workItemId = '44444444-4444-4444-8444-444444444444';
const secondInformationId = '55555555-5555-4555-8555-555555555555';
const secondWorkItemId = '66666666-6666-4666-8666-666666666666';
const binding = { connectorId: 'connector-test', sessionGeneration: 7, engagementId };

test('signed Operation host exposes only declared steps and consumes a generic one-time mutation permit', async () => {
  const host = new OperationHost();
  const registration = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.delete-elements',
    featureVersion: '0.1.2',
    operationPackage
  });
  const calls: Array<{ stepId: string; method: string; path: string; body: unknown }> = [];
  let deleted = false;
  const invoke = (operationId: string, request: Record<string, unknown>, mutationAuthorized = false) => host.invoke({
    schemaVersion: 'omnia.operation-invocation/v1',
    featureId: 'omnia.delete-elements',
    featureVersion: '0.1.2',
    operationId,
    request,
    operationPackageDigest: registration.packageDigest,
    mutationAuthorized
  }, binding, async (route, routePath, body) => {
    calls.push({ stepId: route.stepId, method: route.method, path: routePath, body });
    if (route.stepId === 'information-collection') return [
      { id: informationId, workItemId },
      { id: secondInformationId, workItemId: secondWorkItemId }
    ];
    if (route.stepId === 'information-detail') {
      const second = routePath.endsWith(secondInformationId);
      if (!second) await new Promise((resolve) => setTimeout(resolve, 15));
      return {
      id: second ? secondInformationId : informationId,
      workItemId: second ? secondWorkItemId : workItemId,
      number: second ? 'IPE-002' : 'IPE-001', name: second ? 'Treasury report' : 'Payroll report',
      updatedOn: '2026-08-01T00:00:00Z', isDeleted: deleted
    };
    }
    if (route.stepId === 'work-item') return { id: routePath.endsWith(secondWorkItemId) ? secondWorkItemId : workItemId, referenceNumber: 'IPE', name: 'Report' };
    if (route.stepId === 'facet-mapping') return [{ facetId: workspaceId }];
    if (route.stepId === 'blocking-relationships') return { blockingEntities: [] };
    if (route.stepId === 'soft-delete') { deleted = true; return null; }
    throw new Error(`Unexpected step ${route.stepId}`);
  });
  const planDigest = 'a'.repeat(64);
  const target = { objectId: informationId, informationId, workItemId };
  const catalog = await invoke('omnia.delete.catalog.heavy-read.v1', {
    connectorBinding: binding,
    workspaceIds: [workspaceId]
  }) as any;
  assert.deepEqual([...catalog.items].map((item: any) => item.objectId), [informationId, secondInformationId]);
  const preflight = await invoke('omnia.delete.information.preflight.v1', {
    connectorBinding: binding,
    target,
    planDigest
  }) as any;
  assert.equal(preflight.informationId, informationId);
  assert.deepEqual([...preflight.workspaceIds], [workspaceId]);
  assert.deepEqual(calls.filter((call) => call.stepId === 'blocking-relationships').at(-1)?.body, [informationId]);
  await assert.rejects(
    invoke('omnia.delete.information.direct.v1', { connectorBinding: binding, target, planDigest }, false),
    /not authorized/
  );
  await invoke('omnia.delete.information.direct.v1', { connectorBinding: binding, target, planDigest }, true);
  assert.equal(deleted, true);
  await assert.rejects(
    invoke('omnia.delete.information.direct.v1', { connectorBinding: binding, target, planDigest }, true),
    /already consumed/
  );
  assert.equal(calls.filter((call) => call.stepId === 'soft-delete').length, 1);
  assert.equal(calls.find((call) => call.stepId === 'soft-delete')?.body, undefined);
});

test('Operation host rejects transport fields and stale Connector binding before the handler', async () => {
  const host = new OperationHost();
  const registration = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.delete-elements',
    featureVersion: '0.1.2',
    operationPackage
  });
  const base = {
    schemaVersion: 'omnia.operation-invocation/v1' as const,
    featureId: 'omnia.delete-elements',
    featureVersion: '0.1.2',
    operationId: 'omnia.delete.scope.read.v1',
    operationPackageDigest: registration.packageDigest,
    mutationAuthorized: false
  };
  await assert.rejects(
    host.invoke({ ...base, request: { connectorBinding: binding, url: 'https://example.com' } }, binding, async () => null),
    /transport fields/
  );
  await assert.rejects(
    host.invoke({ ...base, request: { connectorBinding: { ...binding, sessionGeneration: 8 } } }, binding, async () => null),
    /no longer matches/
  );
});
