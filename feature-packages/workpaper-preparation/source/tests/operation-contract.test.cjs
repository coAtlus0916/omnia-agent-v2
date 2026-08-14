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

test('phase2 writeback groups every recorded Tab and confirms all Control fields via readback', async () => {
  const { sdk, calls } = fixture({ opened: true, planningCommonControlTesting: false });
  const handler = createOperationHandler();
  const editor = (value) => JSON.stringify({ editorData: `<p>${value}</p>`, suggestionsData: [],
    trackChangesEnableFlagInEditor: false, plainText: '' });
  let riskDescription = 'old risk';
  let competenceAndAuthorityDocumentation = 'old competence';
  let frequencyAndConsistency = 'old frequency';
  let levelOfAggregation = 'old aggregation';
  let criteriaForInvestigation = 'old criteria';
  let appropriatenessAndCorrelation = 'old appropriateness';
  let designProcedure = 'old design procedure';
  const oeProcedures = ['old OE 1', 'old OE 2', 'old OE 3', 'old OE 4'];
  let procedureTiming = '';
  let procedureTimingRationale = '';
  let frequencyOfPerformance = null;
  let frequencyOfPerformanceExplanation = '';
  let operatingEffectively = null;
  const concurrencyTokens = new Map([[205, '2026-08-09T00:00:00.000Z'], [210, '2026-08-09T00:00:00.000Z'],
    [214, '2026-08-09T00:00:00.000Z']]);
  let tokenSequence = 0;
  const writableSdk = {
    ...sdk,
    async invokeStep(stepId, parameters, body) {
      calls.push({ stepId, parameters, body });
      if (stepId === 'writeback-control-detail' || stepId === 'writeback-readback') {
        return {
          id: CONTROL, workItemId: CONTROL_WORK, controlNumber: 'APP.01 - GRA-APP', name: 'Control 1',
          description: 'old description', approach: 'Preventive', riskAssociationDescription: riskDescription,
          controlDesignEvaluation: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
            competenceAndAuthorityDocumentation, frequencyAndConsistency, levelOfAggregation, criteriaForInvestigation },
          gitcNonDetailedTestingProcedures: [
            { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', phaseType: 'TestOfDesign', documentProcedureResults: designProcedure },
            { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', phaseType: 'OperatingEffectiveness', documentProcedureResults: oeProcedures[0] },
            { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3', phaseType: 'OperatingEffectiveness', documentProcedureResults: oeProcedures[1] },
            { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4', phaseType: 'OperatingEffectiveness', documentProcedureResults: oeProcedures[2] },
            { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb5', phaseType: 'OperatingEffectiveness', documentProcedureResults: oeProcedures[3] }
          ],
          controlRiskScopes: [{ id: 'cccccccc-cccc-cccc-cccc-ccccccccccc1', riskId: 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
            controlRiskScopeDetails: { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', appropriatenessAndCorrelation } }],
          controlOperatingEffectiveness: { id: OE, procedureTiming, procedureTimingRationale,
            frequencyOfPerformance, frequencyOfPerformanceExplanation, operatingEffectively },
          concurrencyTabs: [...concurrencyTokens].map(([entityTabTypeId, updatedOn]) => ({ entityTabTypeId, updatedOn }))
        };
      }
      if (stepId === 'writeback-patch') {
        for (const op of body) {
          if (op.path === '/riskAssociationDescription') riskDescription = op.value;
          if (op.path.endsWith('/competenceAndAuthorityDocumentation')) competenceAndAuthorityDocumentation = op.value;
          if (op.path.endsWith('/frequencyAndConsistency')) frequencyAndConsistency = op.value;
          if (op.path.endsWith('/levelOfAggregation')) levelOfAggregation = op.value;
          if (op.path.endsWith('/criteriaForInvestigation')) criteriaForInvestigation = op.value;
          if (op.path.endsWith('/controlRiskScopeDetails')) appropriatenessAndCorrelation = op.value.appropriatenessAndCorrelation;
          if (op.path.endsWith('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1/documentProcedureResults')) designProcedure = op.value;
          if (op.path.endsWith('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2/documentProcedureResults')) oeProcedures[0] = op.value;
          if (op.path.endsWith('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3/documentProcedureResults')) oeProcedures[1] = op.value;
          if (op.path.endsWith('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4/documentProcedureResults')) oeProcedures[2] = op.value;
          if (op.path.endsWith('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb5/documentProcedureResults')) oeProcedures[3] = op.value;
          if (op.path.endsWith('/procedureTiming')) procedureTiming = op.value;
          if (op.path.endsWith('/procedureTimingRationale')) procedureTimingRationale = op.value;
          if (op.path.endsWith('/frequencyOfPerformance')) frequencyOfPerformance = op.value;
          if (op.path.endsWith('/frequencyOfPerformanceExplanation')) frequencyOfPerformanceExplanation = op.value;
          if (op.path.endsWith('/operatingEffectively')) operatingEffectively = op.value;
        }
        const tab = body.find((op) => op.path === '/concurrencyTabId').value;
        if ([204, 211, 212].includes(tab)) {
          tokenSequence += 1;
          concurrencyTokens.set(tab, `2026-08-09T00:00:0${tokenSequence}.000Z`);
        }
        return {};
      }
      return sdk.invokeStep(stepId, parameters, body);
    }
  };
  const response = await handler.run('omnia.workpaper.phase2.writeback.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK,
    command: { payload: { controlId: CONTROL, changes: [
      { backendKey: 'controlDesignEvaluation.competenceAndAuthorityDocumentation', sourceHeader: 'competenceAndAuthorityDocumentation',
        writePath: '/controlDesignEvaluation/{designEvaluationId}/competenceAndAuthorityDocumentation', value: editor('new competence'),
        expectedValue: 'old competence', valueKind: 'editor', concurrencyTab: 205, concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'controlDesignEvaluation.frequencyAndConsistency', sourceHeader: 'frequencyAndConsistency',
        writePath: '/controlDesignEvaluation/{designEvaluationId}/frequencyAndConsistency', value: editor('new frequency'),
        expectedValue: 'old frequency', valueKind: 'editor', concurrencyTab: 205, concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'controlDesignEvaluation.levelOfAggregation', sourceHeader: 'levelOfAggregation',
        writePath: '/controlDesignEvaluation/{designEvaluationId}/levelOfAggregation', value: editor('new aggregation'),
        expectedValue: 'old aggregation', valueKind: 'editor', concurrencyTab: 205, concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'controlDesignEvaluation.criteriaForInvestigation', sourceHeader: 'criteriaForInvestigation',
        writePath: '/controlDesignEvaluation/{designEvaluationId}/criteriaForInvestigation', value: editor('new criteria'),
        expectedValue: 'old criteria', valueKind: 'editor', concurrencyTab: 205, concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'controlRiskScopes[].controlRiskScopeDetails.appropriatenessAndCorrelation',
        writePath: '/controlRiskScopes/{riskScopeId}/controlRiskScopeDetails', wireShape: 'risk_scope_details_object',
        value: editor('new appropriateness'), expectedValue: 'old appropriateness', valueKind: 'editor',
        concurrencyTab: 205, concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'riskAssociationDescription', writePath: '/riskAssociationDescription', value: editor('new risk'),
        expectedValue: 'old risk', valueKind: 'editor', concurrencyTab: 210, concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'design procedure', writePath: '/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults',
        value: editor('new design procedure'), expectedValue: 'old design procedure', valueKind: 'editor',
        concurrencyTab: 204, concurrencyMode: 'current_or_remove', purgeHiddenData: false, phaseType: 'TestOfDesign', procedureIndex: 0 },
      { backendKey: 'controlOperatingEffectiveness.procedureTiming',
        writePath: '/controlOperatingEffectiveness/{operatingEffectivenessId}/procedureTiming',
        value: 'Apportion', expectedValue: '', valueKind: 'enum', concurrencyTab: 211,
        concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'controlOperatingEffectiveness.procedureTimingRationale',
        writePath: '/controlOperatingEffectiveness/{operatingEffectivenessId}/procedureTimingRationale',
        value: 'new timing rationale', expectedValue: '', valueKind: 'text', concurrencyTab: 211,
        concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'controlOperatingEffectiveness.frequencyOfPerformance',
        writePath: '/controlOperatingEffectiveness/{operatingEffectivenessId}/frequencyOfPerformance',
        value: 11, expectedValue: null, valueKind: 'number', concurrencyTab: 211,
        concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'controlOperatingEffectiveness.frequencyOfPerformanceExplanation',
        writePath: '/controlOperatingEffectiveness/{operatingEffectivenessId}/frequencyOfPerformanceExplanation',
        value: 'new frequency explanation', expectedValue: '', valueKind: 'text', concurrencyTab: 211,
        concurrencyMode: 'current_or_remove', purgeHiddenData: true },
      { backendKey: 'OE procedure 1', writePath: '/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults',
        value: editor('new OE 1'), expectedValue: 'old OE 1', valueKind: 'editor', concurrencyTab: 212,
        concurrencyMode: 'current_or_remove', purgeHiddenData: false, phaseType: 'OperatingEffectiveness', procedureIndex: 0 },
      { backendKey: 'OE procedure 2', writePath: '/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults',
        value: editor('new OE 2'), expectedValue: 'old OE 2', valueKind: 'editor', concurrencyTab: 212,
        concurrencyMode: 'current_or_remove', purgeHiddenData: false, phaseType: 'OperatingEffectiveness', procedureIndex: 1 },
      { backendKey: 'OE procedure 3', writePath: '/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults',
        value: editor('new OE 3'), expectedValue: 'old OE 3', valueKind: 'editor', concurrencyTab: 212,
        concurrencyMode: 'current_or_remove', purgeHiddenData: false, phaseType: 'OperatingEffectiveness', procedureIndex: 2 },
      { backendKey: 'OE procedure 4', writePath: '/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults',
        value: editor('new OE 4'), expectedValue: 'old OE 4', valueKind: 'editor', concurrencyTab: 212,
        concurrencyMode: 'current_or_remove', purgeHiddenData: false, phaseType: 'OperatingEffectiveness', procedureIndex: 3 },
      { backendKey: 'controlOperatingEffectiveness.operatingEffectively',
        writePath: '/controlOperatingEffectiveness/{operatingEffectivenessId}/operatingEffectively',
        value: 1, expectedValue: null, valueKind: 'choice', concurrencyTab: 214,
        concurrencyMode: 'current_or_remove', purgeHiddenData: true }
    ] } }
  }, writableSdk);
  assert.equal(response.accepted, true);
  assert.equal(response.ledger.length, 16);
  assert.ok(response.ledger.every((item) => item.confirmed));
  assert.equal(competenceAndAuthorityDocumentation, editor('new competence'));
  assert.equal(frequencyAndConsistency, editor('new frequency'));
  assert.equal(appropriatenessAndCorrelation, editor('new appropriateness'));
  assert.equal(procedureTiming, 'Apportion');
  assert.equal(procedureTimingRationale, 'new timing rationale');
  assert.equal(frequencyOfPerformance, 11);
  assert.equal(frequencyOfPerformanceExplanation, 'new frequency explanation');
  assert.deepEqual(oeProcedures, [editor('new OE 1'), editor('new OE 2'), editor('new OE 3'), editor('new OE 4')]);
  assert.equal(operatingEffectively, 1);
  const patchCalls = calls.filter((item) => item.stepId === 'writeback-patch');
  assert.equal(patchCalls.length, 9);
  const patchesForTab = (tab) => patchCalls.filter((item) => item.body.some((op) => op.path === '/concurrencyTabId' && op.value === tab));
  const patchByTab = new Map(patchCalls.map((item) => [item.body.find((op) => op.path === '/concurrencyTabId').value, item.body]));
  assert.equal(patchByTab.get(205).filter((op) => !op.path.startsWith('/concurrency') && op.path !== '/isPurgeHiddenData').length, 5);
  assert.equal(Object.hasOwn(patchByTab.get(204).find((op) => op.path === '/concurrencyTabUpdatedOn'), 'value'), false);
  assert.equal(Object.hasOwn(patchByTab.get(211).find((op) => op.path === '/concurrencyTabUpdatedOn'), 'value'), false);
  for (const tab of [205, 210, 214]) {
    assert.equal(patchByTab.get(tab).find((op) => op.path === '/concurrencyTabUpdatedOn').value,
      '2026-08-09T00:00:00.000Z');
  }
  assert.equal(patchesForTab(212).length, 4);
  assert.equal(patchesForTab(212).every((item) => !item.body.some((op) => op.path === '/isPurgeHiddenData')), true);
  assert.equal(Object.hasOwn(patchesForTab(212)[0].body.find((op) => op.path === '/concurrencyTabUpdatedOn'), 'value'), false);
  assert.equal(patchesForTab(212)[1].body.find((op) => op.path === '/concurrencyTabUpdatedOn').value, '2026-08-09T00:00:03.000Z');
  assert.equal(patchesForTab(212)[2].body.find((op) => op.path === '/concurrencyTabUpdatedOn').value, '2026-08-09T00:00:04.000Z');
  assert.equal(patchesForTab(212)[3].body.find((op) => op.path === '/concurrencyTabUpdatedOn').value, '2026-08-09T00:00:05.000Z');
  assert.deepEqual(patchesForTab(212).map((item) => item.body.find((op) => op.path.includes('/documentProcedureResults')).path), [
    '/gitcNonDetailedTestingProcedures/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2/documentProcedureResults',
    '/gitcNonDetailedTestingProcedures/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3/documentProcedureResults',
    '/gitcNonDetailedTestingProcedures/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4/documentProcedureResults',
    '/gitcNonDetailedTestingProcedures/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb5/documentProcedureResults'
  ]);
  const oePatchIndexes = patchesForTab(212).map((item) => calls.indexOf(item));
  for (let index = 0; index < oePatchIndexes.length - 1; index += 1) {
    assert.ok(calls.some((item, callIndex) => item.stepId === 'writeback-readback'
      && callIndex > oePatchIndexes[index] && callIndex < oePatchIndexes[index + 1]));
  }
  await assert.rejects(handler.run('omnia.workpaper.phase2.writeback.v1', {
    ...contextRequest(), controlId: CONTROL, controlWorkItemId: CONTROL_WORK,
    command: { payload: { controlId: CONTROL, changes: [{
      writePath: '/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults', value: 'bare text',
      expectedValue: designProcedure, valueKind: 'editor', concurrencyTab: 204, concurrencyMode: 'current_or_remove',
      purgeHiddenData: false, phaseType: 'TestOfDesign'
    }] } }
  }, writableSdk), /not valid Omnia rich-editor JSON/u);
  assert.equal(calls.filter((item) => item.stepId === 'writeback-patch').length, 9);
});
