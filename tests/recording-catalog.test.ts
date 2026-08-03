import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  captureCurrentGraCatalog,
  mergeRiskControlCatalogs,
  observedRiskAssessmentId,
  RecordingService
} from '../src/connector/recording/recording-service.js';

const engagementId = '11111111-1111-4111-8111-111111111111';
const assessmentId = '22222222-2222-4222-8222-222222222222';
const elementId = '33333333-3333-4333-8333-333333333333';
const riskId = '44444444-4444-4444-8444-444444444444';
const riskScopeId = '55555555-5555-4555-8555-555555555555';
const controlId = '66666666-6666-4666-8666-666666666666';
const origin = 'https://p4omniaapim2zz010cnn3.aaps.deloitte.com.cn';

test('only verified directory endpoint shapes yield an observed current GRA identity', () => {
  assert.equal(observedRiskAssessmentId(`${origin}/rapr/v0/engagements/${engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId=${assessmentId}&reviewMode=false`), assessmentId);
  assert.equal(observedRiskAssessmentId(`${origin}/rapr/v0/engagements/${engagementId}/controls/byRiskAssessmentId/${assessmentId}?includeContentDeleted=false`), assessmentId);
  assert.equal(observedRiskAssessmentId(`${origin}/unverified/gra/${assessmentId}`), '');
});

test('read-only current GRA capture emits a complete catalog and keeps relationships observational', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-catalog-'));
  const calls: Array<{ method: string; path: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: String(init?.method || 'GET'), path: `${url.pathname}${url.search}` });
    let body: unknown;
    if (url.pathname.endsWith(`/riskassessments/${assessmentId}`)) body = {
      id: assessmentId, name: 'Payroll GRA', referenceNumber: 'GRA-12', workspaceId: '77777777-7777-4777-8777-777777777777',
      workItemId: '88888888-8888-4888-8888-888888888888', applicationId: elementId, type: 'Application',
      itElementRaitConclusionLevelName: 'Higher', graContentName: 'IT risk assessment'
    };
    else if (url.pathname.endsWith(`/itelement/${elementId}`)) body = { id: elementId, workItemId: '99999999-9999-4999-8999-999999999999', number: 'APP-025', name: 'Payroll', type: 'Application', subtype: 'ERP' };
    else if (url.pathname.endsWith('/plannedresponse/byRiskAssessmentId')) body = [{ id: riskId, riskNumber: '001', description: 'Unauthorized access', classificationType: 'Higher', riskRiskScopeId: riskScopeId }];
    else if (url.pathname.endsWith(`/controls/byRiskAssessmentId/${assessmentId}`)) body = [{ id: controlId, controlNumber: 'APP.01', name: 'Access review' }];
    else if (url.pathname.endsWith('/plannedresponse/GetPlanResponseDetailByRiskRiskScopeId')) body = { planResponseRisk: [{ id: riskId, riskNumber: '001', description: 'Unauthorized access', classificationType: 'Higher', riskScopes: [{ id: riskScopeId, assertions: ['AS'] }] }] };
    else if (url.pathname.endsWith(`/controls/${controlId}`)) body = { id: controlId, controlNumber: 'APP.01', name: 'Access review', description: 'Quarterly review', currentRiskScopes: [{ riskId, riskScopeId, assertions: ['AS'], enabled: true }] };
    else return new Response(JSON.stringify({ error: 'unexpected' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await captureCurrentGraCatalog({ fetchImpl, apiOrigin: origin, headers: { authorization: 'Bearer fixture' }, engagementId, riskAssessmentId: assessmentId, pack: { name: 'FY26 Audit', clientName: 'Client' }, outputRoot: root });
    assert.equal(result.status, 'complete');
    assert.equal(result.catalog.identity.capturedRait, 'Higher');
    assert.equal(result.catalog.risks[0]?.riskNumber, '001');
    assert.equal(result.catalog.controls[0]?.controlNumber, 'APP.01');
    assert.equal(result.catalog.observedRelations[0]?.catalogPresenceDoesNotImplyTemplateLink, true);
    assert.equal(result.catalog.applicability.linkRequired, null);
    assert.equal(result.catalog.applicability.inferredOtherRait, false);
    assert.equal(result.catalog.completeness.riskDetailCovered, 1);
    assert.equal(result.catalog.completeness.controlDetailCovered, 1);
    assert.ok(fs.existsSync(result.catalogPath));
    assert.ok(fs.existsSync(result.manifestPath));
    assert.ok(calls.every((call) => call.method === 'GET'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing required detail stays incomplete and Higher/Lower merge never infers applicability', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-incomplete-catalog-'));
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    let body: unknown = [];
    if (url.pathname.endsWith(`/riskassessments/${assessmentId}`)) body = { id: assessmentId, name: 'Payroll GRA', workspaceId: '77777777-7777-4777-8777-777777777777', applicationId: elementId, type: 'Application', graContentName: 'IT risk assessment', itElementRaitConclusionLevelName: 'Lower' };
    else if (url.pathname.endsWith(`/itelement/${elementId}`)) body = { id: elementId, type: 'Application' };
    else if (url.pathname.endsWith('/plannedresponse/byRiskAssessmentId')) body = [{ id: riskId, riskNumber: '001' }];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const incomplete = await captureCurrentGraCatalog({ fetchImpl, apiOrigin: origin, headers: { authorization: 'Bearer fixture' }, engagementId, riskAssessmentId: assessmentId, pack: { name: 'FY26 Audit' }, outputRoot: root });
    assert.equal(incomplete.status, 'incomplete');
    assert.equal(incomplete.catalog.completeness.requiredReadsComplete, false);
    assert.equal(incomplete.catalog.completeness.missingReasons.some((reason: string) => reason.includes('risk-scope-detail')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const merged = mergeRiskControlCatalogs([
    { identity: { capturedRait: 'Higher' }, risks: [{ riskNumber: '001', id: riskId }], controls: [{ controlNumber: 'APP.01', id: controlId }], observedRelations: [] },
    { identity: { capturedRait: 'Lower' }, risks: [{ riskNumber: '001', id: riskId }], controls: [], observedRelations: [] }
  ]);
  assert.deepEqual(merged.risks[0]?.capturedRaits, ['Higher', 'Lower']);
  assert.equal(merged.risks[0]?.linkRequired, null);
  assert.equal(merged.controls[0]?.linkRequired, null);
});

test('detailed recorder captures real CDP network/interaction events and stop exports integrity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-detailed-recording-'));
  class FakeCdp extends EventEmitter {
    async send(method: string): Promise<any> {
      if (method === 'Network.getResponseBody') return { body: JSON.stringify([{ id: riskId, riskNumber: '001' }]), base64Encoded: false };
      return {};
    }
    async detach(): Promise<void> { }
  }
  class FakeContext extends EventEmitter {
    readonly cdp = new FakeCdp();
    page: any;
    pages(): any[] { return [this.page]; }
    async newCDPSession(): Promise<any> { return this.cdp; }
  }
  const context = new FakeContext();
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    url: () => `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/gra/current`,
    context: () => context
  });
  context.page = page;
  const service = new RecordingService(root);
  try {
    const started = await service.start({ page, engagementId, sessionGeneration: 4 });
    const riskUrl = `${origin}/rapr/v0/engagements/${engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId=${assessmentId}&reviewMode=false`;
    context.cdp.emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: riskUrl, method: 'GET' } });
    context.cdp.emit('Network.responseReceived', { requestId: 'r1', response: { url: riskUrl, status: 200, mimeType: 'application/json' } });
    context.cdp.emit('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 120 });
    context.cdp.emit('Runtime.bindingCalled', { name: '__omniaV5RecordingEvent', payload: JSON.stringify({ action: 'click', selector: 'button:nth-of-type(1)', buttonLabel: 'Save', pageUrl: page.url() }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopped = await service.stopExport(started.recordingId);
    assert.ok(fs.existsSync(stopped.exportPath));
    const exported = JSON.parse(fs.readFileSync(stopped.exportPath, 'utf8'));
    assert.equal(exported.integrity.complete, true);
    assert.equal(exported.integrity.critical.endpoints['risk-list'].captured, 1);
    assert.equal(exported.events.some((event: any) => event.type === 'interaction' && event.buttonLabel === 'Save'), true);
    assert.equal(exported.security.credentialsRecorded, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
