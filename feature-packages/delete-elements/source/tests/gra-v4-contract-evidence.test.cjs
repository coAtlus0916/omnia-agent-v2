'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
const workspaceRoot = path.dirname(repositoryRoot);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gra-delete-v4-live-contract.json'), 'utf8'));

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function evidenceFile(relativePath) { return path.join(workspaceRoot, ...relativePath.split('/')); }

test('recorded v4 live GRA run provenance is intact and proves 40 verified TEST deletions', () => {
  const planPath = evidenceFile(fixture.provenance.planEvidence.path);
  const executePath = evidenceFile(fixture.provenance.executeEvidence.path);
  assert.equal(sha256(planPath), fixture.provenance.planEvidence.sha256);
  assert.equal(sha256(executePath), fixture.provenance.executeEvidence.sha256);
  const planned = JSON.parse(fs.readFileSync(planPath, 'utf8')).plan;
  const executed = JSON.parse(fs.readFileSync(executePath, 'utf8')).plan;
  assert.equal(planned.id, fixture.liveRun.runId);
  assert.equal(planned.status, 'pending_confirmation');
  assert.equal(planned.items.length, fixture.liveRun.plannedCount);
  assert.equal(planned.items.every((item) => item.type === 'risk-assessment-guidance'
    && item.workspaceId === fixture.liveRun.workspaceId && item.workspaceName === fixture.liveRun.workspaceName), true);
  assert.equal(executed.status, fixture.liveRun.terminalState);
  assert.deepEqual(executed.counts, { requested: 40, deleted: 40, failed: 0, skipped: 0 });
  assert.equal(executed.results.length, fixture.liveRun.deletedCount);
  assert.equal(executed.results.every((item) => item.status === 'deleted' && item.verified === true), true);
  assert.deepEqual(executed.results[0], {
    type: 'risk-assessment-guidance', informationId: '', riskAssessmentId: fixture.liveRun.recordedSample.riskAssessmentId,
    applicationId: '', infrastructureId: '', workItemId: fixture.liveRun.recordedSample.workItemId,
    workspaceId: fixture.liveRun.workspaceId, number: fixture.liveRun.recordedSample.referenceNumber,
    name: executed.results[0].name, status: 'deleted', verified: true, relationshipWrites: 0, error: ''
  });
});

test('v4 source and v5 signed operation retain the same no-replay GRA API contract', () => {
  const v4Gateway = fs.readFileSync(path.join(workspaceRoot, 'omnia-agent-v4', 'connector', 'src', 'omnia-gateway.js'), 'utf8');
  const v5Handler = fs.readFileSync(path.join(repositoryRoot, 'feature-packages', 'delete-elements', 'source', 'connector-capability', 'operation', 'handler.cjs'), 'utf8');
  const packager = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'package-delete-feature.mjs'), 'utf8');
  const worker = fs.readFileSync(path.join(repositoryRoot, 'feature-packages', 'delete-elements', 'source', 'middle', 'worker.cjs'), 'utf8');
  for (const route of [
    '/work/v1/WorkQueries/getWorkitemDetails',
    '/riskassessments/commonAccounts',
    '/relationship/byWorkItemId/${workItemId}/workItemType/RiskFactorEvaluation',
    '/validate-riskfactor-evaluation?op=Delete',
    '/riskassessments/${riskAssessmentId}/softdelete'
  ]) assert.equal(v4Gateway.includes(route), true, `v4 evidence missing ${route}`);
  assert.equal(v4Gateway.includes('Never replay the destructive request'), true);
  for (const contract of [...fixture.contract.catalog, ...fixture.contract.preflight, fixture.contract.mutation]) {
    assert.equal(packager.includes(contract.stepId), true, `signed descriptor missing ${contract.stepId}`);
    assert.equal(packager.includes(contract.routeTemplate), true, `signed descriptor missing ${contract.routeTemplate}`);
  }
  assert.equal(v5Handler.includes("sdk.invokeStep('gra-workitem-index'"), true);
  assert.equal(v5Handler.includes("await sdk.invokeStep('gra-soft-delete', { riskAssessmentId })"), true);
  assert.equal(worker.includes("const CATALOG_TYPES = Object.freeze(['Information', 'GRA', 'APP', 'DB', 'OS', 'DCNO', 'TOOL'])"), true);
  assert.equal(worker.includes("const MUTATION_TYPES = Object.freeze(['Information', 'GRA', 'APP', 'DB', 'OS', 'DCNO', 'TOOL'])"), true);
  assert.equal(worker.includes(".filter(({ selected }) => selected.objectType !== 'GRA')"), true);
  assert.equal(worker.includes("step.kind === 'cascade' && step.objectType === 'GRA'"), true);
});
