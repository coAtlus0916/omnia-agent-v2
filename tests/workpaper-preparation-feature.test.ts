import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { CoreDatabase } from '../src/main/database.js';
import { FeaturePackageManager } from '../src/main/features/package-manager.js';
import { packageDigest, verifyOfficialPackage } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const repository = path.resolve(import.meta.dirname, '..');
const source = path.join(repository, 'feature-packages', 'workpaper-preparation', 'source');
const candidate = path.join(repository, 'feature-packages', 'workpaper-preparation', 'candidates', 'workpaper-preparation-0.1.14.ofp');
const operationCandidate = path.join(repository, 'feature-packages', 'workpaper-preparation', 'candidates', 'workpaper-preparation-operation-0.1.14.ofop');
const releasePython = [
  path.join(repository, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe'),
  path.join(repository, 'data', 'remote-shell-product', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe')
].find((candidatePath) => fs.existsSync(candidatePath)) || '';
const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };
const require = createRequire(import.meta.url);

function unpack(envelope: { files: Array<{ path: string; contentBase64: string }> }, targetRoot: string): void {
  for (const member of envelope.files) {
    const target = path.resolve(targetRoot, ...member.path.split('/'));
    assert.equal(target.startsWith(`${path.resolve(targetRoot)}${path.sep}`), true);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(member.contentBase64, 'base64'));
  }
}

test('workpaper candidate is immutable Feature-only and installs in isolation', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-workpaper-package-'));
  const unpacked = path.join(temporary, 'unpacked');
  const productRoot = path.join(temporary, 'product');
  try {
    const envelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(candidate, 'utf8')), 'omnia-feature');
    assert.equal(envelope.packageId, 'omnia.workpaper-preparation');
    assert.equal(envelope.version, '0.1.14');
    assert.equal(envelope.sequence, 15);
    const operation = verifyOfficialPackage(JSON.parse(fs.readFileSync(operationCandidate, 'utf8')), 'omnia-connector-operation');
    assert.equal(operation.packageId, 'omnia.workpaper-preparation.operation');
    assert.equal(operation.version, '0.1.14');
    unpack(envelope, unpacked);
    const selfTest = spawnSync(process.execPath, [path.join(unpacked, 'tests', 'self-test.cjs')], {
      cwd: unpacked, encoding: 'utf8', windowsHide: true
    });
    assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
    assert.match(selfTest.stdout, /package self-test passed/);
    assert.match(fs.readFileSync(path.join(unpacked, 'middle', 'worker.cjs'), 'utf8'), /omnia\.workpaper-preparation/u);
    assert.match(fs.readFileSync(path.join(unpacked, 'python', 'workpaper-preparation-engine.py'), 'utf8'), /build_hidden_tab_plan/u);
    const surface = JSON.parse(fs.readFileSync(path.join(unpacked, 'frontend', 'surface.json'), 'utf8'));
    assert.equal(surface.selectionBrowser.primaryActionId, 'prepare-hidden-tabs');
    assert.equal(surface.actions.find((item: any) => item.actionId === 'prepare-hidden-tabs').selectionMode, 'single');
    assert.equal(surface.actions.some((item: any) => item.actionId.toLowerCase().includes('comment')), false);
    assert.doesNotMatch(fs.readFileSync(path.join(unpacked, 'middle', 'worker.cjs'), 'utf8'), /messageCard/);
    const paths = resolveProductPaths(productRoot); const database = new CoreDatabase(paths.database, cipher);
    try {
      const manager = new FeaturePackageManager(database.db, paths);
      const installed = manager.install(candidate);
      assert.equal(installed.featureId, 'omnia.workpaper-preparation');
      assert.equal(installed.featureVersion, '0.1.14');
      assert.equal(installed.packageDigest, packageDigest(envelope));
    } finally { database.close(); }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('next Workpaper package declares the generic fixed-footer split catalog layout', () => {
  const packager = fs.readFileSync(path.join(repository, 'scripts', 'package-workpaper-preparation-feature.mjs'), 'utf8');
  assert.match(packager, /schemaVersion: 'omnia\.selection-browser-layout\/v1',\s*mode: 'fixed_footer_split'/u);
  assert.match(packager, /actionId: 'prepare-hidden-tabs'[\s\S]*?selectionMode: 'multiple'/u);
  assert.doesNotMatch(packager, /featureId\s*===\s*['"]omnia\.workpaper-preparation/u);
});

test('release CPython 3.13.14 builds a deterministic Tab 201 to Tab 209 plan', () => {
  assert.equal(fs.existsSync(releasePython), true);
  const result = spawnSync(releasePython, ['-I', '-S', '-E', path.join(source, 'python', 'workpaper-preparation-engine.py'), '--self-check'], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.WINDIR || 'C:\\Windows',
      PATH: path.dirname(releasePython), PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', NO_PROXY: '*', no_proxy: '*' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /planner self-check passed/);
});

test('source contract is no-replay and leaves Connector business-free', () => {
  const worker = fs.readFileSync(path.join(source, 'middle', 'worker.cjs'), 'utf8');
  const handler = fs.readFileSync(path.join(source, 'connector-capability', 'operation', 'handler.cjs'), 'utf8');
  assert.match(worker, /finishReturn', \{ runId: plan\.runId, outcome: 'uncertain'/);
  assert.match(worker, /input\.actionId === 'reconcile-hidden-tabs'/);
  const reconcileBody = worker.slice(worker.indexOf('async function reconcile('), worker.indexOf('async function handleAction('));
  assert.doesNotMatch(reconcileBody, /OPERATIONS\.direct/);
  assert.match(handler, /planningOperatingEffectivenessTesting/);
  assert.match(handler, /usePreviousAuditEvidence/);
  assert.match(handler, /validate-hidden-data/);
  assert.match(handler, /CONTROL_CORE_TAB_ID = 201/);
  assert.match(handler, /CONTROL_OE_TAB_ID = 209/);
    assert.match(crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'), /^[0-9a-f]{64}$/u);
});

test('Feature multi-GRA batch reaches one exact mutation and receipt-backed projection per selected GRA', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-workpaper-worker-'));
  const previous = Object.fromEntries(['OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT', 'OMNIA_FEATURE_TEMP_ROOT']
    .map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(source, 'python', 'workpaper-preparation-engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = source;
  process.env.OMNIA_FEATURE_TEMP_ROOT = temporary;
  const ids = {
    engagement: '11111111-1111-1111-1111-111111111111', workspace: '22222222-2222-2222-2222-222222222222',
    gra: '33333333-3333-3333-3333-333333333333', graWork: '44444444-4444-4444-4444-444444444444',
    app: '55555555-5555-5555-5555-555555555555', appWork: '66666666-6666-6666-6666-666666666666',
    control: '77777777-7777-7777-7777-777777777777', controlWork: '88888888-8888-8888-8888-888888888888',
    oe: '99999999-9999-9999-9999-999999999999',
    gra2: 'a1111111-1111-1111-1111-111111111111', graWork2: 'a2222222-2222-2222-2222-222222222222',
    app2: 'a3333333-3333-3333-3333-333333333333', appWork2: 'a4444444-4444-4444-4444-444444444444',
    control2: 'a5555555-5555-5555-5555-555555555555', controlWork2: 'a6666666-6666-6666-6666-666666666666',
    oe2: 'a7777777-7777-7777-7777-777777777777'
  };
  const opened = new Set<string>(); const directRequests: any[] = []; const order: string[] = []; const plans = new Map<string, any>();
  const binding = { connectorId: 'connector-1', sessionGeneration: 2, engagementId: ids.engagement,
    authorityInstanceId: 'authority-1', tenantOrOrgId: '', packId: 'pack-1' };
  const safety = { enabled: true, validForCurrentConnection: true, globalEnabled: false, globalSectionIds: [], globalWorkspaceIds: [],
    connectorId: 'connector-1', sessionGeneration: 2, engagementId: ids.engagement, authorityInstanceId: 'authority-1', tenantOrOrgId: '',
    packId: 'pack-1', stateVersion: 9, authorityObservationId: 'authority-observation-1', workspaceIds: [ids.workspace] };
  const selected = { riskAssessmentId: ids.gra, graWorkItemId: ids.graWork, appId: ids.app, appWorkItemId: ids.appWork,
    workspaceId: ids.workspace, workspaceName: 'Workspace 1', graName: 'GRA APP', graReferenceNumber: 'GRA-1', graContentId: 'generic-content',
    graStatus: 'EvaluationComplete', graUpdatedOn: '2026-08-09T00:00:00.000Z', appName: 'APP 1', appNumber: 'APP-1',
    graContentName: 'Generic' };
  const selected2 = { ...selected, riskAssessmentId: ids.gra2, graWorkItemId: ids.graWork2, appId: ids.app2,
    appWorkItemId: ids.appWork2, graName: 'GRA APP 2', graReferenceNumber: 'GRA-2', appName: 'APP 2', appNumber: 'APP-2' };
  const preflight = (selectedValue = selected, controlId = ids.control, workItemId = ids.controlWork, oeId = ids.oe) => {
    const isOpened = opened.has(controlId);
    return ({ ...selectedValue, controlId, workItemId, controlNumber: selectedValue === selected ? 'APP.01 - GRA APP' : 'APP.02 - GRA APP 2', name: 'Control 1',
    updatedOn: isOpened ? '2026-08-09T00:00:01.000Z' : '2026-08-09T00:00:00.000Z', opened: isOpened, openVerified: isOpened,
    associated: true,
    planningCommonControlTesting: false, usePreviousAuditEvidence: isOpened ? false : null,
    priorEvidenceDeclined: isOpened, priorEvidenceNotApplicable: false, priorEvidenceComplete: isOpened,
    coreConcurrency: { entityTabTypeId: 201, updatedOn: '2026-08-09T00:00:00.000Z' },
    oeConcurrency: isOpened ? { entityTabTypeId: 209, updatedOn: '2026-08-09T00:00:01.000Z' } : null,
    operatingEffectivenessId: isOpened ? oeId : '', absent: false, deleted: false });
  };
  const connector = { async invoke(input: any) {
    order.push(`operation:${input.operationId}`);
    if (input.operationId.endsWith('directory.read.v1')) return { ...binding, workspaces: [{ id: ids.workspace, name: 'Workspace 1' }], gras: [selected, selected2] };
    if (input.operationId.endsWith('controls.read.v1')) {
      const selectedValue = input.request.riskAssessmentId === ids.gra2 ? selected2 : selected;
      const main = selectedValue === selected ? preflight() : preflight(selected2, ids.control2, ids.controlWork2, ids.oe2);
      return { ...selectedValue, controls: [main,
      { ...preflight(), controlId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workItemId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        controlNumber: 'DCNO.17 - GRA APP', opened: false, openVerified: false, coreConcurrency: null, oeConcurrency: null }
    ] };
    }
    if (input.operationId.endsWith('control.preflight.v1')) return input.request.controlId === ids.control2
      ? preflight(selected2, ids.control2, ids.controlWork2, ids.oe2) : preflight();
    if (input.operationId.endsWith('open-hidden-tab.v1')) { directRequests.push(input.request); opened.add(input.request.controlId); return { accepted: true }; }
    if (input.operationId.endsWith('control.reconcile.v1')) return input.request.controlId === ids.control2
      ? { ...preflight(selected2, ids.control2, ids.controlWork2, ids.oe2), outcome: 'applied', __operationReceiptId: 'receipt-2' }
      : { ...preflight(), outcome: 'applied', __operationReceiptId: 'receipt-1' };
    throw new Error(`unexpected operation ${input.operationId}`);
  } };
  const store = { async call(method: string, input: any) {
    order.push(`store:${method}`);
    if (method === 'savePlan') { plans.set(input.planId, JSON.parse(JSON.stringify(input))); return true; }
    if (method === 'loadPlan') return plans.get(input) || null;
    if (method === 'createMutationRun') return { runId: 'run-1', stateRevision: 1 };
    if (method === 'prepareReturnIntent') return { planDigest: 'a'.repeat(64), confirmationId: 'confirm-1', confirmationToken: 'token-1', stateVersion: 1, expiresAt: '2099-01-01T00:00:00.000Z' };
    if (method === 'approveReturnIntent') return { runId: 'run-1', stateRevision: 3 };
    if (method === 'validateReturnAuthority' || method === 'freezeReturnEvidenceSpec' || method === 'projectVerifiedReturn' || method === 'finishReturn') return true;
    if (method === 'prepareDeletionCommand') return { commandId: 'command-1', idempotencyKey: crypto.randomUUID() };
    if (method === 'recordReturnEvidence') return { evidenceId: crypto.randomUUID() };
    throw new Error(`unexpected store method ${method}`);
  } };
  const workerModule = require(path.join(source, 'middle', 'worker.cjs'));
  const worker = workerModule.createFeatureWorker({ connector, store, events: { emit() {} } });
  try {
    const health = await worker.health(); assert.equal(health.ready, true);
    const refreshed = await worker.handleAction({ actionId: 'bootstrap-workpaper-directory', expectedStateVersion: 1, context: { connectorBinding: binding, safetyLock: safety } });
    assert.equal(refreshed.surfacePatch.items.length, 2);
    const prepared = await worker.handleAction({ actionId: 'prepare-hidden-tabs', expectedStateVersion: 2,
      payload: { targetIds: [ids.gra, ids.gra2] }, context: { connectorBinding: binding, safetyLock: safety } });
    assert.match(prepared.surfacePatch.statusMessage, /Generic APP GRA 2 个/);
    assert.match(prepared.surfacePatch.statusMessage, /待打开 2 个/);
    const completed = await worker.handleAction({ actionId: 'confirm-hidden-tabs', expectedStateVersion: 3,
      context: { connectorBinding: binding, safetyLock: safety } });
    assert.match(completed.surfacePatch.statusMessage, /状态 completed/);
    assert.equal(directRequests.length, 2);
    assert.equal(directRequests.every((request) => request.planDigest === 'a'.repeat(64)), true);
    assert.deepEqual(new Set(directRequests.map((request) => request.riskAssessmentId)), new Set([ids.gra, ids.gra2]));
    assert.ok(order.indexOf('store:recordReturnEvidence') < order.indexOf('operation:omnia.workpaper.control.open-hidden-tab.v1'));
    assert.ok(order.indexOf('operation:omnia.workpaper.control.reconcile.v1') < order.indexOf('store:projectVerifiedReturn'));
    assert.equal('messageCard' in completed, false);
  } finally {
    await worker.shutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('partial hidden-Tab effect reconciles into pending_continuation and resumes the prior-evidence stage', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-workpaper-partial-'));
  const previous = Object.fromEntries(['OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT', 'OMNIA_FEATURE_TEMP_ROOT']
    .map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(source, 'python', 'workpaper-preparation-engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = source;
  process.env.OMNIA_FEATURE_TEMP_ROOT = temporary;
  const ids = {
    engagement: '11111111-1111-1111-1111-111111111111', workspace: '22222222-2222-2222-2222-222222222222',
    gra: '33333333-3333-3333-3333-333333333333', graWork: '44444444-4444-4444-4444-444444444444',
    app: '55555555-5555-5555-5555-555555555555', appWork: '66666666-6666-6666-6666-666666666666',
    control: '77777777-7777-7777-7777-777777777777', controlWork: '88888888-8888-8888-8888-888888888888',
    oe: '99999999-9999-9999-9999-999999999999'
  };
  const binding = { connectorId: 'connector-1', sessionGeneration: 2, engagementId: ids.engagement,
    authorityInstanceId: 'authority-1', tenantOrOrgId: '', packId: 'pack-1' };
  const safety = { enabled: true, validForCurrentConnection: true, globalEnabled: false, globalSectionIds: [], globalWorkspaceIds: [],
    connectorId: 'connector-1', sessionGeneration: 2, engagementId: ids.engagement, authorityInstanceId: 'authority-1', tenantOrOrgId: '',
    packId: 'pack-1', stateVersion: 9, authorityObservationId: 'authority-observation-1', workspaceIds: [ids.workspace] };
  const selected = { riskAssessmentId: ids.gra, graWorkItemId: ids.graWork, appId: ids.app, appWorkItemId: ids.appWork,
    workspaceId: ids.workspace, workspaceName: 'Workspace 1', graName: 'GRA APP', graReferenceNumber: 'GRA-1', graContentId: 'generic-content',
    graStatus: 'EvaluationComplete', graUpdatedOn: '2026-08-09T00:00:00.000Z', appName: 'APP 1', appNumber: 'APP-1',
    graContentName: 'Generic' };
  // Live Control state. A previous run already opened the OE Tab (opened=true)
  // but left prior evidence unset, so the 0.1.x plan is built against this
  // partial state and the resume PATCH carries resumeOperatingEffectivenessId.
  // The first resume attempt does not stick on Omnia (simulating the recorded
  // partial effect); the continuation attempt completes the prior-evidence decline.
  const live = { opened: true, usePreviousAuditEvidence: null as null | boolean, resumeAttempts: 0 };
  const buildControlState = () => ({ ...selected, controlId: ids.control, workItemId: ids.controlWork,
    controlNumber: 'APP.01 - GRA APP', name: 'Control 1',
    updatedOn: live.opened ? '2026-08-09T00:00:01.000Z' : '2026-08-09T00:00:00.000Z',
    opened: live.opened, openVerified: live.opened && live.usePreviousAuditEvidence === false, associated: true,
    planningCommonControlTesting: false, usePreviousAuditEvidence: live.usePreviousAuditEvidence,
    priorEvidenceDeclined: live.usePreviousAuditEvidence === false, priorEvidenceNotApplicable: false,
    priorEvidenceComplete: live.usePreviousAuditEvidence === false,
    coreConcurrency: { entityTabTypeId: 201, updatedOn: '2026-08-09T00:00:00.000Z' },
    oeConcurrency: live.opened ? { entityTabTypeId: 209, updatedOn: '2026-08-09T00:00:01.000Z' } : null,
    operatingEffectivenessId: ids.oe, absent: false, deleted: false });
  const directRequests: any[] = []; const order: string[] = []; const plans = new Map<string, any>();
  const runState = { run_id: 'run-1', state: 'returning', state_revision: 1 };
  let approveCount = 0; let commandCounter = 0;
  const connector = { async invoke(input: any) {
    order.push(`operation:${input.operationId}`);
    if (input.operationId.endsWith('directory.read.v1')) return { ...binding, workspaces: [{ id: ids.workspace, name: 'Workspace 1' }], gras: [selected] };
    if (input.operationId.endsWith('controls.read.v1')) return { ...selected, controls: [buildControlState()] };
    if (input.operationId.endsWith('control.preflight.v1')) return buildControlState();
    if (input.operationId.endsWith('open-hidden-tab.v1')) {
      directRequests.push(input.request);
      live.resumeAttempts += 1;
      if (live.resumeAttempts >= 2) live.usePreviousAuditEvidence = false;
      return { accepted: true };
    }
    if (input.operationId.endsWith('control.reconcile.v1')) return { ...buildControlState(), __operationReceiptId: 'receipt-1' };
    throw new Error(`unexpected operation ${input.operationId}`);
  } };
  const store = { async call(method: string, input: any) {
    order.push(`store:${method}`);
    if (method === 'savePlan') { plans.set(input.planId, JSON.parse(JSON.stringify(input))); return true; }
    if (method === 'loadPlan') return plans.get(input) || null;
    if (method === 'createMutationRun') return { runId: 'run-1', stateRevision: 1 };
    if (method === 'prepareReturnIntent') return { planDigest: 'a'.repeat(64), confirmationId: 'confirm-1', confirmationToken: 'token-1', stateVersion: 1, expiresAt: '2099-01-01T00:00:00.000Z' };
    if (method === 'approveReturnIntent') { approveCount += 1; return { runId: 'run-1', stateRevision: 3 }; }
    if (method === 'prepareDeletionCommand') { commandCounter += 1; return { commandId: `command-${commandCounter}`, idempotencyKey: crypto.randomUUID() }; }
    if (method === 'recordReturnEvidence') return { evidenceId: crypto.randomUUID() };
    if (method === 'validateReturnAuthority' || method === 'freezeReturnEvidenceSpec' || method === 'projectVerifiedReturn') return true;
    if (method === 'finishReturn') { runState.state = input.outcome === 'succeeded' ? 'succeeded' : input.outcome === 'failed' ? 'failed' : 'uncertain'; return true; }
    if (method === 'transitionRun') { runState.state = input.toState; runState.state_revision = input.expectedRevision + 1; return runState.state_revision; }
    if (method === 'loadLatestRun') return { run: { ...runState } };
    throw new Error(`unexpected store method ${method}`);
  } };
  const workerModule = require(path.join(source, 'middle', 'worker.cjs'));
  const worker = workerModule.createFeatureWorker({ connector, store, events: { emit() {} } });
  try {
    assert.equal((await worker.health()).ready, true);
    await worker.handleAction({ actionId: 'bootstrap-workpaper-directory', expectedStateVersion: 1, context: { connectorBinding: binding, safetyLock: safety } });
    const prepared = await worker.handleAction({ actionId: 'prepare-hidden-tabs', expectedStateVersion: 2,
      payload: { targetIds: [ids.gra] }, context: { connectorBinding: binding, safetyLock: safety } });
    assert.match(prepared.surfacePatch.statusMessage, /待打开 1 个/);
    // Stage 1: the OE PATCH applies but prior evidence does not, so the
    // readback is classified partial_applied and the run goes uncertain.
    const confirmed = await worker.handleAction({ actionId: 'confirm-hidden-tabs', expectedStateVersion: 3,
      context: { connectorBinding: binding, safetyLock: safety } });
    assert.match(confirmed.surfacePatch.statusMessage, /状态 uncertain/);
    assert.equal(approveCount, 1);
    assert.equal(directRequests.length, 1);
    // Stage 2: the read-only reconcile proves the partial effect, records the
    // observed digest, and freezes the plan into pending_continuation.
    const reconciled = await worker.handleAction({ actionId: 'reconcile-hidden-tabs', expectedStateVersion: 4,
      context: { connectorBinding: binding, safetyLock: safety } });
    assert.match(reconciled.surfacePatch.statusMessage, /状态 pending_continuation/);
    const frozen = plans.get('run-1');
    assert.equal(frozen.outcomes[0].state, 'partial_recovered');
    assert.match(frozen.partialRecovery.observedDigest, /^[0-9a-f]{64}$/u);
    assert.equal(frozen.partialRecovery.priorCommandId, 'command-1');
    // Stage 3: the continuation skips re-approval, matches the frozen digest,
    // and resumes only the remaining prior-evidence PATCH to reach completed.
    const resumed = await worker.handleAction({ actionId: 'reconcile-hidden-tabs', expectedStateVersion: 5,
      context: { connectorBinding: binding, safetyLock: safety } });
    assert.match(resumed.surfacePatch.statusMessage, /状态 completed/);
    assert.equal(approveCount, 1, 'continuation must not re-approve the return intent');
    assert.equal(directRequests.length, 2);
    assert.equal(directRequests[1].command.payload.resumeOperatingEffectivenessId, ids.oe);
    assert.equal(live.usePreviousAuditEvidence, false, 'the resume PATCH must decline prior evidence');
    assert.equal(plans.get('run-1').outcomes[0].state, 'succeeded');
  } finally {
    await worker.shutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
