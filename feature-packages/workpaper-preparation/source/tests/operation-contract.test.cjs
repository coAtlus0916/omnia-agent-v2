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
const GENERIC_CONTENT = 'generic-content';
const SAP_CONTENT = 'sap-ecc-content';
const CONTROL = '77777777-7777-7777-7777-777777777777';
const CONTROL_WORK = '88888888-8888-8888-8888-888888888888';
const OE = '99999999-9999-9999-9999-999999999999';
const CORE_UPDATED = '2026-08-09T01:00:00.000Z';
const OE_UPDATED = '2026-08-09T01:00:01.000Z';

function fixture(initial = {}) {
  let opened = initial.opened === true;
  let planningCommonControlTesting = initial.planningCommonControlTesting === false ? false : true;
  let priorEvidenceDeclined = initial.priorEvidenceDeclined === true;
  let coreMaterialized = initial.missingCoreTab !== true;
  const calls = [];
  const gra = { id: GRA, workItemId: GRA_WORK, workspaceId: WORKSPACE, riskAssessmentType: 'Application',
    name: 'GRA-APP', referenceNumber: 'GRA-1', status: 'EvaluationComplete', updatedOn: '2026-08-09T00:00:00.000Z',
    inkContentId: initial.graContentName === 'SAP ECC' ? SAP_CONTENT : GENERIC_CONTENT,
    riskScopes: [{ riskScopeType: 'Application', entityId: APP }] };
  const app = { id: APP, workItemId: APP_WORK, itElementType: 'Application', name: 'TEST APP', number: 'APP-1',
    graContent: { name: initial.graContentName || 'Generic' } };
  const control = () => ({ id: CONTROL, workItemId: CONTROL_WORK, controlNumber: 'CTRL.01', name: 'Control 1',
    updatedOn: opened ? OE_UPDATED : CORE_UPDATED, planningOperatingEffectivenessTesting: opened,
    planningCommonControlTesting,
    usePreviousAuditEvidence: priorEvidenceDeclined ? false : null,
    controlRiskScopes: initial.unassociated === true ? [] : [{
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', controlId: CONTROL,
      enabled: true, entityStatus: 'Active', isDeleted: false
    }],
    ...(initial.rootCoreToken === true ? { concurrencyTabId: 201, concurrencyTabUpdatedOn: CORE_UPDATED } : {}),
    ...(initial.priorEvidenceNotApplicable === true ? { controlPriorYearEvidenceWorkPapers: [] } : {}),
    concurrencyTabs: !opened && !coreMaterialized ? [] : opened
      ? [{ entityTabTypeId: 201, updatedOn: CORE_UPDATED }, ...(initial.missingOeTab === true ? [] : [{ entityTabTypeId: 209, updatedOn: OE_UPDATED }])]
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
      if (stepId === 'directory-gra-content-authority') return [{ engagementId: ENGAGEMENT, typeName: 'Standardized Accounts List', items: [{
        engagementId: ENGAGEMENT, parentListName: 'Standardized Accounts List', key: GENERIC_CONTENT, name: 'Generic',
        subItems: [{ engagementId: ENGAGEMENT, parentListName: 'Application type', name: 'Application' }]
      }] }];
      if (stepId.endsWith('gra-detail')) return gra;
      if (stepId.endsWith('app-detail')) return app;
      if (stepId.endsWith('app-facet-mapping')) return [{ facetId: WORKSPACE }];
      if (stepId === 'control-catalog') return [{ id: CONTROL, workItemId: CONTROL_WORK }];
      if (stepId.endsWith('control-detail') || stepId === 'mutation-stage-one-readback') return control();
      if (stepId === 'validate-hidden-data') return {};
      if (stepId === 'open-hidden-tab') {
        if (body.some((item) => item.path === '/planningOperatingEffectivenessTesting')) opened = true;
        const common = body.find((item) => item.path === '/planningCommonControlTesting');
        if (common) {
          planningCommonControlTesting = common.value;
          if (common.value === true) coreMaterialized = true;
        }
        if (body.some((item) => item.path === '/usePreviousAuditEvidence' && item.value === false)) priorEvidenceDeclined = true;
        return {};
      }
      throw new Error(`Unexpected step ${stepId}`);
    }
  };
  return { sdk, calls, isOpened: () => opened, isCommonControlTesting: () => planningCommonControlTesting,
    isPriorEvidenceDeclined: () => priorEvidenceDeclined };
}
function contextRequest() {
  return { riskAssessmentId: GRA, graWorkItemId: GRA_WORK, appId: APP, appWorkItemId: APP_WORK, workspaceId: WORKSPACE,
    graContentId: GENERIC_CONTENT };
}

test('directory exposes only exact Application GRA and controls freeze Tab 201', async () => {
  const { sdk, calls } = fixture(); const handler = createOperationHandler();
  const directory = await handler.run('omnia.workpaper.directory.read.v1', { workspaceIds: [WORKSPACE] }, sdk);
  assert.equal(directory.gras.length, 1);
  assert.deepEqual(directory.gras[0], {
    riskAssessmentId: GRA, graWorkItemId: GRA_WORK, appId: APP, appWorkItemId: APP_WORK, workspaceId: WORKSPACE,
    graContentId: GENERIC_CONTENT,
    workspaceName: 'Workspace 1', graName: 'GRA-APP', graReferenceNumber: 'GRA-1', graStatus: 'EvaluationComplete',
    graUpdatedOn: '2026-08-09T00:00:00.000Z', appName: 'TEST APP', appNumber: 'APP-1', graContentName: 'Generic',
    selectable: true, disabledReason: ''
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
test('directory and execution context exclude non-Generic Application GRA', async () => {
  const { sdk } = fixture({ graContentName: 'SAP ECC' });
  const handler = createOperationHandler();
  const directory = await handler.run('omnia.workpaper.directory.read.v1', { workspaceIds: [WORKSPACE] }, sdk);
  assert.deepEqual(directory.gras, []);
  await assert.rejects(
    handler.run('omnia.workpaper.controls.read.v1', contextRequest(), sdk),
    /identity\/type\/Work Item\/Workspace drifted/iu
  );
});
test('unassociated catalog Controls are excluded before any mutation plan can be built', async () => {
  const { sdk, calls } = fixture({ unassociated: true });
  const handler = createOperationHandler();
  const catalog = await handler.run('omnia.workpaper.controls.read.v1', contextRequest(), sdk);
  assert.deepEqual(catalog.controls, []);
  await assert.rejects(
    handler.run('omnia.workpaper.control.preflight.v1', {
      ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK
    }, sdk),
    /no longer associated/iu
  );
  assert.equal(calls.some((item) => item.stepId === 'open-hidden-tab'), false);
});
test('an untouched closed Control never promotes entity updatedOn into a Tab 201 token', async () => {
  const { sdk } = fixture({ missingCoreTab: true }); const handler = createOperationHandler();
  const before = await handler.run('omnia.workpaper.control.preflight.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK
  }, sdk);
  assert.equal(before.opened, false);
  assert.equal(before.coreConcurrency, null);
});
test('an exact Control root tab id and token pair is accepted without promoting entity updatedOn', async () => {
  const { sdk, calls } = fixture({ missingCoreTab: true, rootCoreToken: true,
    planningCommonControlTesting: false });
  const handler = createOperationHandler();
  const before = await handler.run('omnia.workpaper.control.preflight.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK
  }, sdk);
  assert.deepEqual(before.coreConcurrency, { entityTabTypeId: 201, updatedOn: CORE_UPDATED });
  await handler.run('omnia.workpaper.control.open-hidden-tab.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK,
    command: { payload: { controlId: CONTROL, planningOperatingEffectivenessTesting: true,
      planningCommonControlTesting: false, usePreviousAuditEvidence: false,
      concurrencyTabId: 201, concurrencyTabUpdatedOn: CORE_UPDATED,
      baselinePlanningCommonControlTesting: false } }
  }, sdk);
  const patches = calls.filter((item) => item.stepId === 'open-hidden-tab');
  assert.equal(patches.length, 2);
  assert.equal(patches.some((item) => item.body.some((operation) =>
    operation.path === '/planningCommonControlTesting' && operation.value === true)), false);
});
test('direct update follows the recorded two-stage validation/PATCH flow and final reconcile proves both settings', async () => {
  const { sdk, calls, isOpened, isCommonControlTesting, isPriorEvidenceDeclined } = fixture(); const handler = createOperationHandler();
  const payload = { controlId: CONTROL, planningOperatingEffectivenessTesting: true, planningCommonControlTesting: false, usePreviousAuditEvidence: false,
    concurrencyTabId: 201, concurrencyTabUpdatedOn: CORE_UPDATED, baselinePlanningCommonControlTesting: true };
  const response = await handler.run('omnia.workpaper.control.open-hidden-tab.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, command: { payload }
  }, sdk);
  assert.equal(response.accepted, true);
  assert.equal(isOpened(), true);
  assert.equal(isCommonControlTesting(), false);
  assert.equal(isPriorEvidenceDeclined(), true);
  const validations = calls.filter((item) => item.stepId === 'validate-hidden-data');
  const patches = calls.filter((item) => item.stepId === 'open-hidden-tab');
  assert.deepEqual(validations.map((item) => item.body), [
    [
      { op: 'replace', path: '/planningOperatingEffectivenessTesting', value: true },
      { op: 'replace', path: '/planningCommonControlTesting', value: false }
    ],
    [{ op: 'replace', path: '/usePreviousAuditEvidence', value: false }]
  ]);
  assert.deepEqual(patches[0].body, [
    { op: 'replace', path: '/planningOperatingEffectivenessTesting', value: true },
    { op: 'replace', path: '/planningCommonControlTesting', value: false },
    { op: 'replace', path: '/concurrencyTabId', value: 201 },
    { op: 'replace', path: '/concurrencyTabUpdatedOn', value: CORE_UPDATED },
    { op: 'replace', path: '/isPurgeHiddenData', value: true }
  ]);
  assert.deepEqual(patches[1].body, [
    { op: 'replace', path: '/usePreviousAuditEvidence', value: false },
    { op: 'replace', path: '/concurrencyTabId', value: 209 },
    { op: 'replace', path: '/concurrencyTabUpdatedOn', value: OE_UPDATED },
    { op: 'replace', path: '/isPurgeHiddenData', value: true }
  ]);
  const observed = await handler.run('omnia.workpaper.control.reconcile.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, baselineCoreUpdatedOn: CORE_UPDATED
  }, sdk);
  assert.equal(observed.outcome, 'applied');
  assert.equal(observed.usePreviousAuditEvidence, false);
  assert.equal(observed.operatingEffectivenessId, OE);
  assert.deepEqual(observed.oeConcurrency, { entityTabTypeId: 209, updatedOn: OE_UPDATED });
});

test('a closed Control without Tab 201 follows the recorded bootstrap, validate, OE, and prior-evidence sequence', async () => {
  const { sdk, calls, isOpened, isPriorEvidenceDeclined } = fixture({ missingCoreTab: true, planningCommonControlTesting: false });
  const handler = createOperationHandler();
  const payload = { controlId: CONTROL, planningOperatingEffectivenessTesting: true,
    planningCommonControlTesting: false, usePreviousAuditEvidence: false,
    concurrencyTabId: 201, concurrencyTabUpdatedOn: '', baselinePlanningCommonControlTesting: false };
  const response = await handler.run('omnia.workpaper.control.open-hidden-tab.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, command: { payload }
  }, sdk);
  assert.equal(response.accepted, true);
  assert.equal(isOpened(), true);
  assert.equal(isPriorEvidenceDeclined(), true);
  const validations = calls.filter((item) => item.stepId === 'validate-hidden-data').map((item) => item.body);
  const patches = calls.filter((item) => item.stepId === 'open-hidden-tab').map((item) => item.body);
  assert.deepEqual(validations, [
    [{ op: 'replace', path: '/planningCommonControlTesting', value: false }],
    [
      { op: 'replace', path: '/planningOperatingEffectivenessTesting', value: true },
      { op: 'replace', path: '/planningCommonControlTesting', value: false }
    ],
    [{ op: 'replace', path: '/usePreviousAuditEvidence', value: false }]
  ]);
  assert.deepEqual(patches[0], [
    { op: 'replace', path: '/planningCommonControlTesting', value: true },
    { op: 'replace', path: '/concurrencyTabId', value: 201 },
    { op: 'replace', path: '/concurrencyTabUpdatedOn' },
    { op: 'replace', path: '/isPurgeHiddenData', value: true }
  ]);
  assert.deepEqual(patches[1], [
    { op: 'replace', path: '/planningOperatingEffectivenessTesting', value: true },
    { op: 'replace', path: '/planningCommonControlTesting', value: false },
    { op: 'replace', path: '/concurrencyTabId', value: 201 },
    { op: 'replace', path: '/concurrencyTabUpdatedOn', value: CORE_UPDATED },
    { op: 'replace', path: '/isPurgeHiddenData', value: true }
  ]);
  assert.deepEqual(patches[2], [
    { op: 'replace', path: '/usePreviousAuditEvidence', value: false },
    { op: 'replace', path: '/concurrencyTabId', value: 209 },
    { op: 'replace', path: '/concurrencyTabUpdatedOn', value: OE_UPDATED },
    { op: 'replace', path: '/isPurgeHiddenData', value: true }
  ]);
});

test('reconcile proves not-applied without replaying the PATCH', async () => {
  const { sdk, calls } = fixture(); const handler = createOperationHandler();
  const observed = await handler.run('omnia.workpaper.control.reconcile.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, baselineCoreUpdatedOn: CORE_UPDATED
  }, sdk);
  assert.equal(observed.outcome, 'not_applied');
  assert.equal(calls.some((item) => item.stepId === 'open-hidden-tab'), false);
});

test('a verified partial first stage repairs the recorded common-control state before declining prior evidence', async () => {
  const { sdk, calls, isCommonControlTesting, isPriorEvidenceDeclined } = fixture({ opened: true, missingOeTab: true });
  const handler = createOperationHandler();
  const partial = await handler.run('omnia.workpaper.control.reconcile.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, baselineCoreUpdatedOn: CORE_UPDATED
  }, sdk);
  assert.equal(partial.outcome, 'partial_applied');
  assert.equal(partial.oeConcurrency, null);
  const response = await handler.run('omnia.workpaper.control.open-hidden-tab.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK,
    command: { payload: { controlId: CONTROL, planningOperatingEffectivenessTesting: true,
      planningCommonControlTesting: false, usePreviousAuditEvidence: false,
      concurrencyTabId: 201, concurrencyTabUpdatedOn: CORE_UPDATED, baselinePlanningCommonControlTesting: true } }
  }, sdk);
  assert.equal(response.accepted, true);
  assert.equal(isCommonControlTesting(), false);
  assert.equal(isPriorEvidenceDeclined(), true);
  assert.deepEqual(calls.filter((item) => item.stepId === 'validate-hidden-data').map((item) => item.body), [
    [{ op: 'replace', path: '/planningCommonControlTesting', value: false }],
    [{ op: 'replace', path: '/usePreviousAuditEvidence', value: false }]
  ]);
  assert.equal(calls.filter((item) => item.stepId === 'open-hidden-tab').length, 2);
  assert.equal(calls.some((item) => item.stepId === 'mutation-stage-one-readback'), true);
});

test('an empty prior-year inventory remains diagnostic and still records the explicit decline', async () => {
  const { sdk, calls } = fixture({ opened: true, planningCommonControlTesting: false, priorEvidenceNotApplicable: true });
  const handler = createOperationHandler();
  const observed = await handler.run('omnia.workpaper.control.reconcile.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK, baselineCoreUpdatedOn: CORE_UPDATED
  }, sdk);
  assert.equal(observed.outcome, 'partial_applied');
  assert.equal(observed.priorEvidenceNotApplicable, true);
  assert.equal(observed.priorEvidenceComplete, false);
  const response = await handler.run('omnia.workpaper.control.open-hidden-tab.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK,
    command: { payload: { controlId: CONTROL, planningOperatingEffectivenessTesting: true,
      planningCommonControlTesting: false, usePreviousAuditEvidence: false,
      concurrencyTabId: 201, concurrencyTabUpdatedOn: CORE_UPDATED, baselinePlanningCommonControlTesting: false } }
  }, sdk);
  assert.equal(response.accepted, true);
  assert.deepEqual(calls.filter((item) => item.stepId === 'validate-hidden-data').map((item) => item.body), [
    [{ op: 'replace', path: '/usePreviousAuditEvidence', value: false }]
  ]);
});

test('a completed OE read-back remains authoritative when the recorded Tab 209 timestamp is absent', async () => {
  const { sdk, calls } = fixture({ opened: true, planningCommonControlTesting: false,
    priorEvidenceDeclined: true, missingOeTab: true });
  const handler = createOperationHandler();
  const before = await handler.run('omnia.workpaper.control.preflight.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK
  }, sdk);
  assert.equal(before.openVerified, true);
  assert.equal(before.oeConcurrency, null);
  const observed = await handler.run('omnia.workpaper.control.reconcile.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK,
    baselineCoreUpdatedOn: CORE_UPDATED
  }, sdk);
  assert.equal(observed.outcome, 'applied');
  const response = await handler.run('omnia.workpaper.control.open-hidden-tab.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK,
    command: { payload: { controlId: CONTROL, planningOperatingEffectivenessTesting: true,
      planningCommonControlTesting: false, usePreviousAuditEvidence: false,
      concurrencyTabId: 201, concurrencyTabUpdatedOn: CORE_UPDATED, baselinePlanningCommonControlTesting: false } }
  }, sdk);
  assert.equal(response.mutation, 'already_applied');
  assert.equal(calls.some((item) => item.stepId === 'validate-hidden-data'), false);
  assert.equal(calls.some((item) => item.stepId === 'open-hidden-tab'), false);
});

test('phase2 writeback resolves sub-entity paths and confirms each stage via readback', async () => {
  const { sdk, calls } = fixture({ opened: true, planningCommonControlTesting: false });
  const handler = createOperationHandler();
  let description = 'old description';
  let procedureResult = 'old procedure result';
  const writableSdk = {
    ...sdk,
    async invokeStep(stepId, parameters, body) {
      calls.push({ stepId, parameters, body });
      if (stepId === 'writeback-control-detail' || stepId === 'writeback-readback') {
        return {
          id: CONTROL, workItemId: CONTROL_WORK, controlNumber: 'APP.01 - GRA-APP', name: 'Control 1',
          description, approach: 'Preventive',
          controlDesignEvaluation: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', competenceAndAuthorityDocumentation: '' },
          gitcNonDetailedTestingProcedures: [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', phaseType: 'TestOfDesign', documentProcedureResults: procedureResult }],
          controlRiskScopes: [{ id: 'cccccccc-cccc-cccc-cccc-ccccccccccc1', riskId: 'dddddddd-dddd-dddd-dddd-ddddddddddd1', controlRiskScopeDetails: [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', appropriatenessAndCorrelation: '' }] }],
          controlOperatingEffectiveness: { id: OE },
          concurrencyTabs: [{ entityTabTypeId: 201, updatedOn: '2026-08-09T00:00:00.000Z' }]
        };
      }
      if (stepId === 'writeback-patch') {
        for (const op of body) {
          if (op.path === '/description') description = op.value;
          if (op.path === '/gitcNonDetailedTestingProcedures/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1/documentProcedureResults') procedureResult = op.value;
        }
        return {};
      }
      return sdk.invokeStep(stepId, parameters, body);
    }
  };
  const response = await handler.run('omnia.workpaper.phase2.writeback.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK,
    command: { payload: { controlId: CONTROL, changes: [
      { writePath: '/description', value: 'new description', valueKind: 'text', concurrencyTab: 201 },
      { writePath: '/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults', value: 'new procedure', valueKind: 'editor', concurrencyTab: 201, phaseType: 'TestOfDesign' }
    ] } }
  }, writableSdk);
  assert.equal(response.accepted, true);
  assert.equal(response.ledger.length, 2);
  assert.deepEqual(response.ledger.map((item) => item.confirmed), [true, true]);
  assert.equal(description, 'new description');
  assert.equal(procedureResult, 'new procedure');
  const patchCalls = calls.filter((item) => item.stepId === 'writeback-patch');
  assert.equal(patchCalls.length, 2);
  assert.ok(patchCalls.every((item) => item.body.some((op) => op.path === '/concurrencyTabId' && op.value === 201)));
});
