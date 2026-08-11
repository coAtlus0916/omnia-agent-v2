'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationHandler } = require('../connector-capability/operation/handler.cjs');

const ENGAGEMENT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const GRA = '33333333-3333-3333-3333-333333333333';
const GRA_WORK = '44444444-4444-4444-4444-444444444444';
const APP = '55555555-5555-5555-5555-555555555555';
const APP_WORK = '66666666-6666-6666-6666-666666666666';
const CONTROL = '77777777-7777-7777-7777-777777777777';
const CONTROL_WORK = '88888888-8888-8888-8888-888888888888';
const OE = '99999999-9999-9999-9999-999999999999';
const CORE_UPDATED = '2026-08-09T01:00:00.000Z';
const OE_UPDATED = '2026-08-09T01:00:01.000Z';

function fixture() {
  let opened = false;
  const calls = [];
  const gra = { id: GRA, workItemId: GRA_WORK, workspaceId: WORKSPACE, riskAssessmentType: 'Application',
    name: 'GRA-APP', referenceNumber: 'GRA-1', status: 'EvaluationComplete', updatedOn: '2026-08-09T00:00:00.000Z',
    riskScopes: [{ riskScopeType: 'Application', entityId: APP }] };
  const app = { id: APP, workItemId: APP_WORK, itElementType: 'Application', name: 'TEST APP', number: 'APP-1' };
  const control = () => ({ id: CONTROL, workItemId: CONTROL_WORK, controlNumber: 'CTRL.01', name: 'Control 1',
    updatedOn: opened ? OE_UPDATED : CORE_UPDATED, planningOperatingEffectivenessTesting: opened,
    concurrencyTabs: opened
      ? [{ entityTabTypeId: 201, updatedOn: CORE_UPDATED }, { entityTabTypeId: 209, updatedOn: OE_UPDATED }]
      : [{ entityTabTypeId: 201, updatedOn: CORE_UPDATED }],
    ...(opened ? { controlOperatingEffectiveness: { id: OE } } : {}) });
  const sdk = {
    binding: { connectorId: 'connector-1', sessionGeneration: 7, engagementId: ENGAGEMENT,
      authorityInstanceId: 'authority-1', tenantOrOrgId: '', packId: 'pack-1' },
    async invokeStep(stepId, parameters, body) {
      calls.push({ stepId, parameters, body });
      if (stepId === 'pack-hierarchy') return {};
      if (stepId === 'authority-directory') return [{ engagementId: ENGAGEMENT, facets: [
        { id: WORKSPACE, engagementId: ENGAGEMENT, facetTypeId: 'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0', name: 'Workspace 1' }
      ] }];
      if (stepId === 'gra-workitem-index') return [{ id: GRA_WORK, externalId: GRA, workspaceId: WORKSPACE, riskAssessmentType: 'Application', name: 'GRA-APP' }];
      if (stepId === 'gra-common-account-index') return [{ id: GRA, workItemId: GRA_WORK, workspaceId: WORKSPACE, riskAssessmentType: 'Application' }];
      if (stepId.endsWith('gra-detail')) return gra;
      if (stepId.endsWith('app-detail')) return app;
      if (stepId.endsWith('app-facet-mapping')) return [{ facetId: WORKSPACE }];
      if (stepId === 'control-catalog') return [{ id: CONTROL, workItemId: CONTROL_WORK }];
      if (stepId.endsWith('control-detail')) return control();
      if (stepId === 'open-hidden-tab') { opened = true; return {}; }
      throw new Error(`Unexpected step ${stepId}`);
    }
  };
  return { sdk, calls, isOpened: () => opened };
}
function contextRequest() {
  return { riskAssessmentId: GRA, graWorkItemId: GRA_WORK, appId: APP, appWorkItemId: APP_WORK, workspaceId: WORKSPACE };
}

test('directory exposes only exact Application GRA and controls freeze Tab 201', async () => {
  const { sdk, calls } = fixture(); const handler = createOperationHandler();
  const directory = await handler.run('omnia.workpaper.directory.read.v1', { workspaceIds: [WORKSPACE] }, sdk);
  assert.equal(directory.gras.length, 1);
  assert.deepEqual(directory.gras[0], {
    riskAssessmentId: GRA, graWorkItemId: GRA_WORK, appId: APP, appWorkItemId: APP_WORK, workspaceId: WORKSPACE,
    workspaceName: 'Workspace 1', graName: 'GRA-APP', graReferenceNumber: 'GRA-1', graStatus: 'EvaluationComplete',
    graUpdatedOn: '2026-08-09T00:00:00.000Z', appName: 'TEST APP', appNumber: 'APP-1', selectable: true, disabledReason: ''
  });
  assert.deepEqual(calls.find((item) => item.stepId === 'gra-workitem-index').body,
    { workItemIds: [], engagementIds: [ENGAGEMENT], workItemTypes: ['RiskFactorEvaluation'] });
  assert.deepEqual(calls.find((item) => item.stepId === 'gra-common-account-index').body, { riskAssessmentType: [] });
  const catalog = await handler.run('omnia.workpaper.controls.read.v1', contextRequest(), sdk);
  assert.equal(catalog.controls.length, 1);
  assert.equal(catalog.controls[0].opened, false);
  assert.deepEqual(catalog.controls[0].coreConcurrency, { entityTabTypeId: 201, updatedOn: CORE_UPDATED });
  const before = await handler.run('omnia.workpaper.control.preflight.v1', { ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK }, sdk);
  assert.equal(before.openVerified, false);
});
test('direct PATCH uses frozen Tab 201 and reconcile requires OE entity plus Tab 209', async () => {
  const { sdk, calls, isOpened } = fixture(); const handler = createOperationHandler();
  const payload = { controlId: CONTROL, planningOperatingEffectivenessTesting: true, concurrencyTabId: 201, concurrencyTabUpdatedOn: CORE_UPDATED };
  const response = await handler.run('omnia.workpaper.control.open-hidden-tab.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, command: { payload }
  }, sdk);
  assert.equal(response.accepted, true);
  assert.equal(isOpened(), true);
  assert.deepEqual(calls.find((item) => item.stepId === 'open-hidden-tab').body, [
    { op: 'replace', path: '/planningOperatingEffectivenessTesting', value: true },
    { op: 'replace', path: '/concurrencyTabId', value: 201 },
    { op: 'replace', path: '/concurrencyTabUpdatedOn', value: CORE_UPDATED }
  ]);
  const observed = await handler.run('omnia.workpaper.control.reconcile.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, baselineCoreUpdatedOn: CORE_UPDATED
  }, sdk);
  assert.equal(observed.outcome, 'applied');
  assert.equal(observed.operatingEffectivenessId, OE);
  assert.deepEqual(observed.oeConcurrency, { entityTabTypeId: 209, updatedOn: OE_UPDATED });
});

test('reconcile proves not-applied without replaying the PATCH', async () => {
  const { sdk, calls } = fixture(); const handler = createOperationHandler();
  const observed = await handler.run('omnia.workpaper.control.reconcile.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, baselineCoreUpdatedOn: CORE_UPDATED
  }, sdk);
  assert.equal(observed.outcome, 'not_applied');
  assert.equal(calls.some((item) => item.stepId === 'open-hidden-tab'), false);
});
