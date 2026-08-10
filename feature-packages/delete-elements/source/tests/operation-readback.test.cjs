'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function operationExports() {
  const sourceHandler = path.join(__dirname, '..', 'connector-capability', 'operation', 'handler.cjs');
  if (fs.existsSync(sourceHandler)) return require(sourceHandler);
  const operationPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'connector-capability', 'operation.ofop'), 'utf8'));
  const member = operationPackage.files.find((file) => file.path === 'operation/handler.cjs');
  if (!member || !member.contentBase64) throw new Error('Signed operation handler member is unavailable.');
  const moduleRecord = { exports: {} }; const filename = path.join(__dirname, '..', 'connector-capability', 'operation', 'handler.cjs');
  Function('require', 'module', 'exports', '__filename', '__dirname', Buffer.from(member.contentBase64, 'base64').toString('utf8'))(
    require, moduleRecord, moduleRecord.exports, filename, path.dirname(filename));
  return moduleRecord.exports;
}
const { createOperationHandler } = operationExports();

test('signed Operation handler loads in the Connector sandbox without CommonJS require', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'connector-capability', 'operation', 'handler.cjs'), 'utf8');
  const moduleRecord = { exports: {} };
  Function('module', 'exports', source)(moduleRecord, moduleRecord.exports);
  assert.equal(typeof moduleRecord.exports.createOperationHandler, 'function');
});

const handler = createOperationHandler();
const graFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gra-delete-v4-live-contract.json'), 'utf8'));
const informationId = '11111111-1111-1111-1111-111111111111';
const objectId = '22222222-2222-2222-2222-222222222222';
const workItemId = '33333333-3333-3333-3333-333333333333';
const workspaceId = '44444444-4444-4444-4444-444444444444';
const binding = {
  connectorId: 'connector-1', sessionGeneration: 1,
  engagementId: '55555555-5555-5555-5555-555555555555',
  authorityInstanceId: 'https://api.example.invalid', tenantOrOrgId: 'tenant-1', packId: 'pack-1'
};

function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }

test('Information reconcile treats an exact 404 detail as authoritative absence', async () => {
  const calls = [];
  const sdk = {
    binding,
    invokeStep: async (stepId) => {
      calls.push(stepId);
      if (stepId === 'information-detail') throw Object.assign(new Error('not found'), { status: 404 });
      throw new Error(`unexpected step: ${stepId}`);
    }
  };
  const value = await handler.run('omnia.delete.information.reconcile.v1', {
    informationId, workItemId, workspaceId
  }, sdk);
  assert.deepEqual(value, { informationId, objectId: informationId, objectType: 'Information', workspaceIds: [workspaceId], deleted: true, absent: true });
  assert.deepEqual(calls, ['information-detail']);
});

test('IT Element reconcile proves exact identity, type, Workspace and deleted state', async () => {
  const sdk = {
    binding,
    invokeStep: async (stepId) => {
      if (stepId === 'it-element-detail') return { id: objectId, workItemId, itElementType: 'Application', isDeleted: true };
      if (stepId === 'it-element-facet-mapping') return [{ facetId: workspaceId }];
      throw new Error(`unexpected step: ${stepId}`);
    }
  };
  const value = await handler.run('omnia.delete.it-element.reconcile.v1', {
    objectId, objectType: 'APP', workItemId, workspaceId
  }, sdk);
  assert.deepEqual(value, { objectId, objectType: 'APP', workspaceIds: [workspaceId], deleted: true });
});

test('Infrastructure/Network uses the parameterized IT Element preflight, mutation and readback contract as DCNO', async () => {
  const networkId = '77777777-7777-7777-7777-777777777777';
  const networkWorkItemId = '88888888-8888-8888-8888-888888888888';
  const calls = []; let networkDeleted = false;
  const sdk = {
    binding,
    invokeStep: async (stepId, parameters) => {
      calls.push(stepId);
      if (stepId === 'information-collection' || stepId === 'gra-workitem-index' || stepId === 'gra-common-account-index') return [];
      if (stepId === 'application-search' || stepId === 'tool-search' || stepId === 'preflight-tool-search') return { results: [], totalResults: 0 };
      if (stepId === 'infrastructure-search') return { results: [{ id: networkId, workItemId: networkWorkItemId, itElementType: 'Infrastructure', infrastructureType: 'Network' }], totalResults: 1 };
      if (stepId === 'it-element-detail') return { id: networkId, workItemId: networkWorkItemId, itElementType: 'Infrastructure', infrastructureType: 'Network', number: 'DCNO-001', name: 'Primary network', updatedOn: '2026-08-06T01:02:03.000Z', isDeleted: networkDeleted };
      if (stepId === 'it-element-facet-mapping') return [{ facetId: workspaceId }];
      if (stepId === 'it-element-blocking-relationships') return { blockingEntities: [], convertingEntities: [], blockingControlEntities: [], accountContents: [], showDeleteAccountProcedureMappingPrompt: false };
      if (stepId === 'it-element-soft-delete') { networkDeleted = true; return {}; }
      throw new Error(`unexpected step: ${stepId} ${JSON.stringify(parameters)}`);
    }
  };
  const catalog = await handler.run('omnia.delete.catalog.heavy-read.v1', {
    engagementId: binding.engagementId, workspaceIds: [workspaceId]
  }, sdk);
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].objectType, 'DCNO');
  assert.equal(catalog.items[0].objectId, networkId);
  const preflight = await handler.run('omnia.delete.it-element.preflight.v1', { target: { objectId: networkId } }, sdk);
  assert.equal(preflight.objectType, 'DCNO');
  assert.deepEqual(preflight.workspaceIds, [workspaceId]);
  assert.deepEqual(preflight.blockers, []);
  const direct = await handler.run('omnia.delete.it-element.direct.v1', { objectId: networkId, objectType: 'DCNO',
    command: { payload: { objectId: networkId, objectType: 'DCNO' } } }, sdk);
  assert.deepEqual(direct, { objectId: networkId, objectType: 'DCNO', accepted: true });
  const reconciled = await handler.run('omnia.delete.it-element.reconcile.v1', {
    objectId: networkId, objectType: 'DCNO', workItemId: networkWorkItemId, workspaceId
  }, sdk);
  assert.equal(reconciled.deleted, true);
  assert.equal(calls.includes('it-element-soft-delete'), true);
});

test('authoritative mixed IT Element catalog retains APP DB OS DCNO Tool and excludes only explicit unsupported Infrastructure subtypes', async () => {
  const definitions = [
    ['66666666-6666-6666-6666-666666666661', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'Application', '', 'APP'],
    ['66666666-6666-6666-6666-666666666662', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'Infrastructure', 'Database', 'DB'],
    ['66666666-6666-6666-6666-666666666663', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', 'Infrastructure', 'OperatingSystem', 'OS'],
    ['66666666-6666-6666-6666-666666666664', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4', 'Infrastructure', 'Network', 'DCNO'],
    ['66666666-6666-6666-6666-666666666665', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5', 'ITTool', 'Tool', 'TOOL'],
    ['66666666-6666-6666-6666-666666666666', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6', 'Infrastructure', 'Server', 'unsupported']
  ];
  const byId = new Map(definitions.map(([id, workItemId, itElementType, infrastructureType]) => [id, {
    id, workItemId, itElementType, infrastructureType, number: id.slice(-4), name: id,
    updatedOn: '2026-08-07T00:00:00.000Z'
  }]));
  const searchPayload = (types) => ({ results: definitions.filter((entry) => types.includes(entry[2]))
    .map(([id, workItemId, itElementType, infrastructureType]) => ({ id, workItemId, itElementType, infrastructureType })),
  totalResults: definitions.filter((entry) => types.includes(entry[2])).length });
  const sdk = { binding, invokeStep: async (stepId, parameters) => {
    if (stepId === 'information-collection' || stepId === 'gra-workitem-index' || stepId === 'gra-common-account-index') return [];
    if (stepId === 'application-search') return searchPayload(['Application']);
    if (stepId === 'infrastructure-search') return searchPayload(['Infrastructure']);
    if (stepId === 'tool-search') return searchPayload(['ITTool']);
    if (stepId === 'tool-relation-search') return { results: [], totalResults: 0 };
    if (stepId === 'it-element-detail') return byId.get(parameters.objectId);
    if (stepId === 'it-element-facet-mapping') return [{ facetId: workspaceId }];
    if (stepId === 'it-element-blocking-relationships') return { blockingEntities: [], convertingEntities: [], blockingControlEntities: [], accountContents: [], showDeleteAccountProcedureMappingPrompt: false };
    throw new Error(`unexpected step: ${stepId}`);
  } };
  const catalog = await handler.run('omnia.delete.catalog.heavy-read.v1', {
    engagementId: binding.engagementId, workspaceIds: [workspaceId]
  }, sdk);
  assert.deepEqual(catalog.items.map((item) => item.objectType).sort(), ['APP', 'DB', 'DCNO', 'OS', 'TOOL']);
  assert.equal(catalog.items.some((item) => item.objectId === '66666666-6666-6666-6666-666666666666'), false);
});

test('authoritative catalog classifies recorded DB OS and Network shapes without opaque typeId shadowing semantic evidence', async () => {
  const definitions = [
    {
      id: '67666666-6666-6666-6666-666666666661', workItemId: 'abaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', expected: 'DB',
      indexed: { typeId: 'opaque-database-type-id' }, detail: { infrastructureType: 'Database' }
    },
    {
      id: '67666666-6666-6666-6666-666666666662', workItemId: 'abaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', expected: 'OS',
      indexed: {}, detail: { type: 'OperatingSystem' }
    },
    {
      id: '67666666-6666-6666-6666-666666666663', workItemId: 'abaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', expected: 'OS',
      indexed: { itElementType: 'Infrastructure' }, detail: { typeId: 'opaque-os-type-id', infrastructureType: 'Operating System' }
    },
    {
      id: '67666666-6666-6666-6666-666666666664', workItemId: 'abaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4', expected: 'DCNO',
      indexed: {}, detail: { infrastructureType: 'Network' }
    }
  ];
  const byId = new Map(definitions.map((item) => [item.id, {
    id: item.id, workItemId: item.workItemId, ...item.detail,
    number: item.id.slice(-4), name: item.id, updatedOn: '2026-08-07T00:00:00.000Z'
  }]));
  const sdk = { binding, invokeStep: async (stepId, parameters) => {
    if (stepId === 'information-collection' || stepId === 'gra-workitem-index' || stepId === 'gra-common-account-index') return [];
    if (stepId === 'application-search' || stepId === 'tool-search' || stepId === 'tool-relation-search') return { results: [], totalResults: 0 };
    if (stepId === 'infrastructure-search') return { results: definitions.map((item) => ({ id: item.id, workItemId: item.workItemId, ...item.indexed })), totalResults: definitions.length };
    if (stepId === 'it-element-detail') return byId.get(parameters.objectId);
    if (stepId === 'it-element-facet-mapping') return [{ facetId: workspaceId }];
    if (stepId === 'it-element-blocking-relationships') return { blockingEntities: [], convertingEntities: [], blockingControlEntities: [], accountContents: [], showDeleteAccountProcedureMappingPrompt: false };
    throw new Error(`unexpected step: ${stepId}`);
  } };
  const catalog = await handler.run('omnia.delete.catalog.heavy-read.v1', {
    engagementId: binding.engagementId, workspaceIds: [workspaceId]
  }, sdk);
  assert.deepEqual(catalog.items.map((item) => [item.objectId, item.objectType]), definitions.map((item) => [item.id, item.expected]));
});

test('authoritative catalog fails closed when indexed and detail type evidence conflict', async () => {
  const conflictingId = '68666666-6666-6666-6666-666666666661';
  const conflictingWorkItemId = 'acaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
  const sdk = { binding, invokeStep: async (stepId, parameters) => {
    if (stepId === 'information-collection' || stepId === 'gra-workitem-index' || stepId === 'gra-common-account-index') return [];
    if (stepId === 'application-search' || stepId === 'tool-search') return { results: [], totalResults: 0 };
    if (stepId === 'infrastructure-search') return { results: [{
      id: conflictingId, workItemId: conflictingWorkItemId, type: 'OperatingSystem'
    }], totalResults: 1 };
    if (stepId === 'it-element-detail') return {
      id: conflictingId, workItemId: conflictingWorkItemId, infrastructureType: 'Database',
      updatedOn: '2026-08-07T00:00:00.000Z'
    };
    if (stepId === 'it-element-facet-mapping') return [{ facetId: workspaceId }];
    if (stepId === 'it-element-blocking-relationships') return { blockingEntities: [], convertingEntities: [], blockingControlEntities: [], accountContents: [], showDeleteAccountProcedureMappingPrompt: false };
    throw new Error(`unexpected step: ${stepId} ${JSON.stringify(parameters)}`);
  } };
  await assert.rejects(handler.run('omnia.delete.catalog.heavy-read.v1', {
    engagementId: binding.engagementId, workspaceIds: [workspaceId]
  }, sdk), /type\/subtype is missing, ambiguous, or outside/u);
});

test('authoritative catalog performs detail-first Workspace pruning before expensive mapping and blocker reads', async () => {
  const outsideWorkspaceId = '44444444-4444-4444-4444-444444444445';
  const insideId = '66666666-6666-6666-6666-666666666671';
  const outsideId = '66666666-6666-6666-6666-666666666672';
  const insideWorkItemId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaab1';
  const outsideWorkItemId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaab2';
  const calls = [];
  const sdk = { binding, invokeStep: async (stepId, parameters) => {
    calls.push({ stepId, objectId: parameters && parameters.objectId });
    if (stepId === 'information-collection' || stepId === 'gra-workitem-index' || stepId === 'gra-common-account-index') return [];
    if (stepId === 'application-search') return { results: [
      { id: insideId, workItemId: insideWorkItemId, itElementType: 'Application' },
      { id: outsideId, workItemId: outsideWorkItemId, itElementType: 'Application' }
    ], totalResults: 2 };
    if (stepId === 'infrastructure-search' || stepId === 'tool-search' || stepId === 'tool-relation-search') return { results: [], totalResults: 0 };
    if (stepId === 'it-element-detail') return parameters.objectId === insideId
      ? { id: insideId, workItemId: insideWorkItemId, workspaceId, itElementType: 'Application', number: 'APP-IN', updatedOn: '2026-08-07T00:00:00.000Z' }
      : { id: outsideId, workItemId: outsideWorkItemId, workspaceId: outsideWorkspaceId, itElementType: 'Application', number: 'APP-OUT', updatedOn: '2026-08-07T00:00:00.000Z' };
    if (stepId === 'it-element-facet-mapping') return [{ facetId: workspaceId }];
    if (stepId === 'it-element-blocking-relationships') return { blockingEntities: [], convertingEntities: [], blockingControlEntities: [], accountContents: [], showDeleteAccountProcedureMappingPrompt: false };
    throw new Error(`unexpected step: ${stepId}`);
  } };
  const catalog = await handler.run('omnia.delete.catalog.heavy-read.v1', {
    engagementId: binding.engagementId, workspaceIds: [workspaceId]
  }, sdk);
  assert.deepEqual(catalog.items.map((item) => item.objectId), [insideId]);
  assert.equal(calls.filter((call) => call.stepId === 'it-element-detail').length, 2);
  assert.equal(calls.filter((call) => call.stepId === 'it-element-facet-mapping').length, 1);
  assert.equal(calls.filter((call) => call.stepId === 'it-element-blocking-relationships').length, 1);
});

test('InfrastructureApplication accepts a frozen DCNO source with tab 602 and exact dual-sided readback', async () => {
  const networkId = '77777777-7777-7777-7777-777777777777';
  const networkWorkItemId = '88888888-8888-8888-8888-888888888888';
  const applicationId = '99999999-9999-9999-9999-999999999999';
  const applicationWorkItemId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const sourceDetail = { id: networkId, workItemId: networkWorkItemId, itElementType: 'Infrastructure', infrastructureType: 'Network',
    updatedOn: '2026-08-06T01:02:03.000Z', concurrencyTabs: [{ entityTabTypeId: 602, updatedOn: '2026-08-06T01:02:04.000Z' }] };
  const targetDetail = { id: applicationId, workItemId: applicationWorkItemId, itElementType: 'Application', updatedOn: '2026-08-06T01:02:03.000Z' };
  let associated = true; const calls = [];
  const sdk = { binding, invokeStep: async (stepId, parameters, body) => {
    calls.push({ stepId, parameters, body });
    if (stepId === 'relation-object-detail') return parameters.objectId === networkId ? sourceDetail : targetDetail;
    if (stepId === 'relation-facet-mapping') return [{ facetId: workspaceId }];
    if (stepId === 'relation-applications-search') return { results: associated ? [{ id: applicationId }] : [], totalResults: associated ? 1 : 0 };
    if (stepId === 'relation-infrastructures-search') return { results: associated ? [{ id: networkId }] : [], totalResults: associated ? 1 : 0 };
    if (stepId === 'relation-disassociate') { associated = false; return {}; }
    throw new Error(`unexpected step: ${stepId}`);
  } };
  const request = { relationType: 'InfrastructureApplication', sourceObjectId: networkId, targetObjectIds: [applicationId],
    sourceObjectType: 'DCNO', sourceWorkItemId: networkWorkItemId, sourceWorkspaceId: workspaceId,
    targets: [{ objectId: applicationId, objectType: 'APP', workItemId: applicationWorkItemId, workspaceId }] };
  const before = await handler.run('omnia.delete.infrastructure-application.preflight.v1', request, sdk);
  assert.equal(before.source.objectType, 'DCNO');
  assert.deepEqual(before.concurrency, { entityTabTypeId: 602, updatedOn: '2026-08-06T01:02:04.000Z' });
  await handler.run('omnia.delete.infrastructure-application.disassociate.v1', { ...request,
    command: { payload: { relationType: request.relationType, sourceObjectId: networkId, targetObjectIds: [applicationId], concurrency: before.concurrency } } }, sdk);
  const after = await handler.run('omnia.delete.infrastructure-application.reconcile.v1', request, sdk);
  assert.equal(after.deleted, true);
  assert.equal(after.associated, false);
  assert.equal(calls.filter((call) => call.stepId === 'relation-disassociate').length, 1);
});

test('one source with multiple APP targets uses one signed mutation and proves every edge absent', async () => {
  const sourceId = '71777777-7777-7777-7777-777777777777';
  const sourceWorkItemId = '81888888-8888-8888-8888-888888888888';
  const targetIds = ['91999999-9999-9999-9999-999999999991', '91999999-9999-9999-9999-999999999992'];
  const workItemIds = ['a1aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a2aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];
  const associated = new Set(targetIds); const calls = [];
  const sdk = { binding, invokeStep: async (stepId, parameters, body) => {
    calls.push({ stepId, parameters, body });
    if (stepId === 'relation-object-detail') {
      if (parameters.objectId === sourceId) return { id: sourceId, workItemId: sourceWorkItemId, itElementType: 'Infrastructure', infrastructureType: 'Database',
        updatedOn: '2026-08-09T00:00:00.000Z', concurrencyTabs: [{ entityTabTypeId: 602, updatedOn: '2026-08-09T00:00:01.000Z' }] };
      const index = targetIds.indexOf(parameters.objectId); if (index < 0) throw Object.assign(new Error('missing endpoint'), { status: 404 });
      return { id: targetIds[index], workItemId: workItemIds[index], itElementType: 'Application', updatedOn: '2026-08-09T00:00:00.000Z' };
    }
    if (stepId === 'relation-facet-mapping') return [{ facetId: workspaceId }];
    if (stepId === 'relation-applications-search') return { results: targetIds.filter((targetId) => associated.has(targetId)).map((id) => ({ id })), totalResults: associated.size };
    if (stepId === 'relation-infrastructures-search') return { results: associated.has(body.associatedWithApplicationId) ? [{ id: sourceId }] : [], totalResults: associated.has(body.associatedWithApplicationId) ? 1 : 0 };
    if (stepId === 'relation-disassociate') { for (const targetId of body.AssociatingEntityIds) associated.delete(targetId); return {}; }
    throw new Error(`unexpected step: ${stepId}`);
  } };
  const request = { relationType: 'InfrastructureApplication', sourceObjectId: sourceId, targetObjectIds: targetIds,
    sourceObjectType: 'DB', sourceWorkItemId, sourceWorkspaceId: workspaceId,
    targets: targetIds.map((objectId, index) => ({ objectId, objectType: 'APP', workItemId: workItemIds[index], workspaceId })) };
  const before = await handler.run('omnia.delete.infrastructure-application.preflight.v1', request, sdk);
  assert.deepEqual(before.targetObjectIds, targetIds);
  await handler.run('omnia.delete.infrastructure-application.disassociate.v1', { ...request,
    command: { payload: { relationType: request.relationType, sourceObjectId: sourceId, targetObjectIds: targetIds, concurrency: before.concurrency } } }, sdk);
  const after = await handler.run('omnia.delete.infrastructure-application.reconcile.v1', request, sdk);
  assert.equal(after.deleted, true);
  assert.deepEqual(after.targets.map((target) => [target.objectId, target.associated, target.deleted]), targetIds.map((targetId) => [targetId, false, true]));
  const mutations = calls.filter((call) => call.stepId === 'relation-disassociate');
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].body.AssociatingEntityIds, targetIds);
});

test('relation group preflight fails closed for a partial edge set or missing endpoint', async () => {
  const sourceId = '72777777-7777-7777-7777-777777777777'; const sourceWorkItemId = '82888888-8888-8888-8888-888888888888';
  const targetIds = ['92999999-9999-9999-9999-999999999991', '92999999-9999-9999-9999-999999999992'];
  const workItemIds = ['b1aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b2aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];
  const request = { relationType: 'InfrastructureApplication', sourceObjectId: sourceId, targetObjectIds: targetIds,
    sourceObjectType: 'DB', sourceWorkItemId, sourceWorkspaceId: workspaceId,
    targets: targetIds.map((objectId, index) => ({ objectId, objectType: 'APP', workItemId: workItemIds[index], workspaceId })) };
  const sdk = { binding, invokeStep: async (stepId, parameters, body) => {
    if (stepId === 'relation-object-detail') return parameters.objectId === sourceId
      ? { id: sourceId, workItemId: sourceWorkItemId, itElementType: 'Infrastructure', infrastructureType: 'Database', concurrencyTabs: [{ entityTabTypeId: 602, updatedOn: '2026-08-09T00:00:01.000Z' }] }
      : { id: parameters.objectId, workItemId: workItemIds[targetIds.indexOf(parameters.objectId)], itElementType: 'Application' };
    if (stepId === 'relation-facet-mapping') return [{ facetId: workspaceId }];
    if (stepId === 'relation-applications-search') return { results: [{ id: targetIds[0] }], totalResults: 1 };
    if (stepId === 'relation-infrastructures-search') return { results: body.associatedWithApplicationId === targetIds[0] ? [{ id: sourceId }] : [], totalResults: body.associatedWithApplicationId === targetIds[0] ? 1 : 0 };
    throw new Error(`unexpected step: ${stepId}`);
  } };
  await assert.rejects(handler.run('omnia.delete.infrastructure-application.preflight.v1', request, sdk), /partial, absent, or inconsistent/u);
  await assert.rejects(handler.run('omnia.delete.infrastructure-application.preflight.v1', {
    ...request, targets: [...request.targets, { objectId: '93999999-9999-9999-9999-999999999999', objectType: 'APP', workItemId: workItemIds[0], workspaceId }]
  }, sdk), /empty, duplicate, unsorted, or incomplete/u);
});

test('direct Information mutation accepts only the Core-frozen identity', async () => {
  const calls = [];
  const sdk = { binding, invokeStep: async (stepId, parameters) => { calls.push({ stepId, parameters }); return {}; } };
  const value = await handler.run('omnia.delete.information.direct.v1', {
    informationId,
    command: { payload: { informationId } }
  }, sdk);
  assert.equal(value.accepted, true);
  assert.deepEqual(calls, [{ stepId: 'soft-delete', parameters: { informationId } }]);
  await assert.rejects(handler.run('omnia.delete.information.direct.v1', {
    informationId,
    command: { payload: { informationId: '66666666-6666-6666-6666-666666666666' } }
  }, sdk), /drifted from the Core command/u);
});

test('recorded v4 GRA catalog contract exposes the exact active TEST Workspace target', async () => {
  const sample = graFixture.liveRun.recordedSample; const graWorkspaceId = graFixture.liveRun.workspaceId;
  const graBinding = { ...binding, engagementId: graFixture.liveRun.engagementId };
  const calls = [];
  const sdk = {
    binding: graBinding,
    invokeStep: async (stepId, parameters, body) => {
      calls.push({ stepId, parameters, body });
      if (stepId === 'information-collection') return [];
      if (stepId === 'gra-workitem-index') return [{ id: sample.workItemId, externalId: sample.riskAssessmentId,
        workItemType: 'RiskFactorEvaluation', workspaceId: graWorkspaceId, referenceNumber: sample.referenceNumber,
        status: 'EvaluationComplete' }];
      if (stepId === 'gra-common-account-index') return [];
      if (stepId === 'gra-catalog-detail') return { id: sample.riskAssessmentId, riskAssessmentId: sample.riskAssessmentId,
        engagementId: graBinding.engagementId, workspaceId: graWorkspaceId, workItemId: sample.workItemId,
        referenceNumber: sample.referenceNumber, status: 'EvaluationComplete', updatedOn: '2026-07-25T04:39:45.892Z' };
      if (['application-search', 'infrastructure-search', 'tool-search'].includes(stepId)) return { results: [], totalResults: 0 };
      throw new Error(`unexpected step: ${stepId}`);
    }
  };
  const value = await handler.run('omnia.delete.catalog.heavy-read.v1', {
    engagementId: graBinding.engagementId, workspaceIds: [graWorkspaceId]
  }, sdk);
  assert.equal(value.items.length, 1);
  assert.deepEqual(value.items[0], { objectId: sample.riskAssessmentId, riskAssessmentId: sample.riskAssessmentId,
    workItemId: sample.workItemId, objectType: 'GRA', number: sample.referenceNumber, name: '',
    updatedAt: '2026-07-25T04:39:45.892Z', workspaceIds: [graWorkspaceId], blockers: [], relations: [], deleted: false });
  assert.deepEqual(calls.find((call) => call.stepId === 'gra-workitem-index').body,
    { workItemIds: [], engagementIds: [graBinding.engagementId], workItemTypes: ['RiskFactorEvaluation'] });
  assert.deepEqual(calls.find((call) => call.stepId === 'gra-common-account-index').body, { riskAssessmentType: [] });
});

test('GRA preflight freezes a live Risk-Control deletion identity without requiring create-associate assertion metadata', async () => {
  const riskAssessmentId = '77777777-7777-4777-8777-777777777777';
  const graWorkItemId = '88888888-8888-4888-8888-888888888888';
  const riskId = '99999999-9999-4999-8999-999999999999';
  const riskRiskScopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const riskScopeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const controlId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const controlWorkItemId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const clearValidation = { blockingEntities: [], convertingEntities: [], blockingControlEntities: [], accountContents: [], showDeleteAccountProcedureMappingPrompt: false };
  const sdk = { binding, invokeStep: async (stepId) => {
    if (stepId === 'gra-detail') return { id: riskAssessmentId, workItemId: graWorkItemId, workspaceId, updatedOn: '2026-08-09T00:00:00.000Z' };
    if (stepId === 'gra-relationship') return { id: riskAssessmentId };
    if (stepId === 'gra-delete-validation') return clearValidation;
    if (stepId === 'risk-catalog') return { plannedResponses: [{ riskId, riskRiskScopeId, updatedOn: '2026-08-09T00:00:00.000Z' }] };
    if (stepId === 'control-catalog') return { controls: [{ controlId, workItemId: controlWorkItemId }] };
    if (stepId === 'risk-detail') return { planResponseRisk: [{ riskId, riskRiskScopes: [{ id: riskRiskScopeId, riskScopeId }] }],
      planResponseSelectedControl: [{ controlId, currentRiskScopes: [{ riskId, riskRiskScopeId, riskScopeId, enabled: true }] }] };
    throw new Error(`unexpected step: ${stepId}`);
  } };
  const value = await handler.run('omnia.delete.gra.preflight.v1', { riskAssessmentId, workspaceId }, sdk);
  assert.deepEqual(value.cascadeSnapshot.riskControls, [{ riskId, riskRiskScopeId, riskScopeId, controlId }]);
  assert.equal(value.cascadeSnapshot.snapshotDigest, digest({ schemaVersion: value.cascadeSnapshot.schemaVersion,
    assessment: value.cascadeSnapshot.assessment, risks: value.cascadeSnapshot.risks,
    controls: value.cascadeSnapshot.controls, riskControls: value.cascadeSnapshot.riskControls }));
});

test('GRA direct mutation uses one Core-frozen soft-delete step and reconcile proves the frozen cascade', async () => {
  const sample = graFixture.liveRun.recordedSample; const graWorkspaceId = graFixture.liveRun.workspaceId;
  const directCalls = [];
  const direct = await handler.run('omnia.delete.gra.direct.v1', {
    riskAssessmentId: sample.riskAssessmentId,
    command: { payload: { riskAssessmentId: sample.riskAssessmentId } }
  }, { binding, invokeStep: async (stepId, parameters) => { directCalls.push({ stepId, parameters }); return {}; } });
  assert.equal(direct.accepted, true);
  assert.deepEqual(directCalls, [{ stepId: 'gra-soft-delete', parameters: { riskAssessmentId: sample.riskAssessmentId } }]);

  const assessment = { riskAssessmentId: sample.riskAssessmentId, workItemId: sample.workItemId, workspaceId: graWorkspaceId, updatedOn: '2026-07-25T04:39:45.892Z' };
  const frozen = { schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1', assessment, risks: [], controls: [], riskControls: [] };
  frozen.snapshotDigest = digest(frozen);
  const reconciled = await handler.run('omnia.delete.gra.reconcile.v1', {
    riskAssessmentId: sample.riskAssessmentId, workspaceId: graWorkspaceId, frozenCascadeSnapshot: frozen
  }, { binding, invokeStep: async (stepId) => {
    if (stepId === 'gra-detail') return { id: sample.riskAssessmentId, workspaceId: graWorkspaceId, isDeleted: true };
    if (stepId === 'risk-catalog' || stepId === 'control-catalog') return [];
    throw new Error(`unexpected step: ${stepId}`);
  } });
  assert.equal(reconciled.deleted, true);
  assert.equal(reconciled.verifiedCascade, true);
  assert.equal(reconciled.cascadeSnapshot.snapshotDigest, frozen.snapshotDigest);
});
