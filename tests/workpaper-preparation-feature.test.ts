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
const phase2Fields = JSON.parse(fs.readFileSync(path.join(source, 'docs', 'PHASE2_GENERIC_APP_FIELDS.json'), 'utf8'));
const phase2Template = JSON.parse(fs.readFileSync(path.join(source, 'managed', 'phase2-template-data.json'), 'utf8'));
// The source worker.cjs reads __PHASE2_FIELDS__ / __PHASE2_TEMPLATE__ globals,
// which are injected at packaging time. Populate them so a direct require can
// exercise the full write-back flow (generate → upload → confirm).
(globalThis as Record<string, unknown>).__PHASE2_FIELDS__ = phase2Fields.fields;
(globalThis as Record<string, unknown>).__PHASE2_TEMPLATE__ = phase2Template;

// A minimal but valid ZIP (one stored empty entry "empty.txt" plus central
// directory) so the policy-upload path can extract to an empty document list.
function emptyZipBase64(): string {
  const name = Buffer.from('empty.txt', 'utf8');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method (stored)
  local.writeUInt32LE(0, 10); // crc32 (empty)
  local.writeUInt32LE(0, 14); // compressed size
  local.writeUInt32LE(0, 18); // uncompressed size
  local.writeUInt16LE(name.length, 26); // name length
  local.writeUInt16LE(0, 28); // extra length
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); // central directory header signature
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10); // method
  central.writeUInt32LE(0, 16); // crc32
  central.writeUInt32LE(0, 20); // compressed size
  central.writeUInt32LE(0, 24); // uncompressed size
  central.writeUInt16LE(name.length, 28); // name length
  central.writeUInt16LE(0, 30); // extra length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt32LE(0, 38); // local header offset
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(1, 8); // entry count
  eocd.writeUInt16LE(1, 10); // entry count
  eocd.writeUInt32LE(central.length, 12); // central dir size
  eocd.writeUInt32LE(local.length, 16); // central dir offset
  return Buffer.concat([local, central, eocd]).toString('base64');
}

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
  assert.match(packager, /actionId: 'select-elements'[\s\S]*?selectionMode: 'multiple'/u);
  assert.match(packager, /stepId: 'select'[\s\S]*?stepId: 'upload'/u);
  assert.match(packager, /actionId: 'select-elements'/u);
  assert.match(packager, /actionId: 'restart-run'[\s\S]*?presentation: 'restart'/u);
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
  assert.match(worker, /input\.actionId === 'select-elements'/);
  assert.doesNotMatch(worker, /async function reconcile\(/);
  assert.match(handler, /planningOperatingEffectivenessTesting/);
  assert.match(handler, /usePreviousAuditEvidence/);
  assert.match(handler, /validate-hidden-data/);
  assert.match(handler, /CONTROL_CORE_TAB_ID = 201/);
  assert.match(handler, /CONTROL_OE_TAB_ID = 209/);
  assert.match(worker, /function workflowSurface\(plan\)/);
  assert.match(worker, /async function forceEnd\(plan, context\)/);
  assert.match(worker, /async function freezeHiddenTabPlan\(plan, context\)/);
  assert.match(worker, /actionId === 'restart-run'/);
  assert.match(worker, /actionId === 'select-elements'/);
    assert.match(crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'), /^[0-9a-f]{64}$/u);
});

test('select-elements then confirm-writeback opens the hidden Tab and writes back the intersection', async () => {
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
    oe: '99999999-9999-9999-9999-999999999999'
  };
  const opened = new Set<string>(); const directRequests: any[] = []; const writebackRequests: any[] = []; const order: string[] = []; const plans = new Map<string, any>();
  const binding = { connectorId: 'connector-1', sessionGeneration: 2, engagementId: ids.engagement,
    authorityInstanceId: 'authority-1', tenantOrOrgId: '', packId: 'pack-1' };
  const safety = { enabled: true, validForCurrentConnection: true, globalEnabled: false, globalSectionIds: [], globalWorkspaceIds: [],
    connectorId: 'connector-1', sessionGeneration: 2, engagementId: ids.engagement, authorityInstanceId: 'authority-1', tenantOrOrgId: '',
    packId: 'pack-1', stateVersion: 9, authorityObservationId: 'authority-observation-1', workspaceIds: [ids.workspace] };
  const selected = { riskAssessmentId: ids.gra, graWorkItemId: ids.graWork, appId: ids.app, appWorkItemId: ids.appWork,
    workspaceId: ids.workspace, workspaceName: 'Workspace 1', graName: 'GRA APP', graReferenceNumber: 'GRA-1', graContentId: 'generic-content',
    graStatus: 'EvaluationComplete', graUpdatedOn: '2026-08-09T00:00:00.000Z', appName: 'APP 1', appNumber: 'APP-1',
    graContentName: 'Generic' };
  const preflight = (openedValue = false) => ({ ...selected, controlId: ids.control, workItemId: ids.controlWork,
    controlNumber: 'APP.01 - GRA APP', name: 'Control 1',
    updatedOn: openedValue ? '2026-08-09T00:00:01.000Z' : '2026-08-09T00:00:00.000Z', opened: openedValue, openVerified: openedValue,
    associated: true,
    planningCommonControlTesting: false, usePreviousAuditEvidence: openedValue ? false : null,
    priorEvidenceDeclined: openedValue, priorEvidenceNotApplicable: false, priorEvidenceComplete: openedValue,
    coreConcurrency: { entityTabTypeId: 201, updatedOn: '2026-08-09T00:00:00.000Z' },
    oeConcurrency: openedValue ? { entityTabTypeId: 209, updatedOn: '2026-08-09T00:00:01.000Z' } : null,
    operatingEffectivenessId: ids.oe, absent: false, deleted: false });
  const snapshot = () => ({ controlId: ids.control, workItemId: ids.controlWork, controlNumber: 'APP.01 - GRA APP',
    procedures: [{ id: 'proc-1', phaseType: 'TestOfDesign', documentProcedureResults: '【政策名称】原始文本' }] });
  const connector = { async invoke(input: any) {
    order.push(`operation:${input.operationId}`);
    if (input.operationId.endsWith('directory.read.v1')) return { ...binding, workspaces: [{ id: ids.workspace, name: 'Workspace 1' }], gras: [selected] };
    if (input.operationId.endsWith('controls.read.v1')) return { ...selected, controls: [preflight(opened.has(ids.control))] };
    if (input.operationId.endsWith('control.preflight.v1')) return preflight(opened.has(ids.control));
    if (input.operationId.endsWith('open-hidden-tab.v1')) { directRequests.push(input.request); opened.add(input.request.controlId); return { accepted: true }; }
    if (input.operationId.endsWith('control.reconcile.v1')) return { ...preflight(true), outcome: 'applied', __operationReceiptId: 'receipt-1' };
    if (input.operationId.endsWith('phase2.snapshot.read.v1')) return snapshot();
    if (input.operationId.endsWith('phase2.writeback.v1')) { writebackRequests.push(input.request); return { controlId: ids.control, accepted: true, ledger: [{ path: 'x', valueKind: 'editor', confirmed: true }] } };
    throw new Error(`unexpected operation ${input.operationId}`);
  } };
  const store = { async call(method: string, input: any) {
    order.push(`store:${method}`);
    if (method === 'savePlan') { plans.set(input.planId, JSON.parse(JSON.stringify(input))); return true; }
    if (method === 'loadPlan') return plans.get(input) || null;
    if (method === 'loadOpenRun') return null;
    if (method === 'createMutationRun') return { runId: 'run-1', stateRevision: 1 };
    if (method === 'prepareReturnIntent') return { planDigest: 'a'.repeat(64), confirmationId: 'confirm-1', confirmationToken: 'token-1', stateVersion: 1, expiresAt: '2099-01-01T00:00:00.000Z' };
    if (method === 'approveReturnIntent') return { runId: 'run-1', stateRevision: 3 };
    if (method === 'validateReturnAuthority' || method === 'freezeReturnEvidenceSpec' || method === 'projectVerifiedReturn' || method === 'finishReturn') return true;
    if (method === 'prepareDeletionCommand') return { commandId: 'command-1', idempotencyKey: crypto.randomUUID() };
    if (method === 'recordReturnEvidence') return { evidenceId: crypto.randomUUID() };
    if (method === 'commitStandaloneArtifact') return { artifactId: 'artifact-1', sha256: crypto.createHash('sha256').update(Buffer.from(input.contentBase64, 'base64')).digest('hex') };
    if (method === 'readArtifactBytes') return { contentBase64: emptyZipBase64(), sha256: 'zip-sha', runId: 'run-1', originalName: 'policy.zip', sizeBytes: 0 };
    if (method === 'openPythonArtifactHandle') return { handleId: 'handle-1', runId: input.runId, path: path.resolve(repository, '.codex-tmp', 'template-test2.xlsx'), sha256: 'a'.repeat(64), sizeBytes: 0 };
    if (method === 'releasePythonArtifactHandles') return true;
    throw new Error(`unexpected store method ${method}`);
  } };
  const workerModule = require(path.join(source, 'middle', 'worker.cjs'));
  const worker = workerModule.createFeatureWorker({ connector, store, events: { emit() {} }, ai: { review: async () => ({ output: { resolutions: [] } }) } });
  const actionById = (patch: any): Map<string, any> => new Map(patch.actions.map((action: any) => [action.actionId, action]));
  try {
    const health = await worker.health(); assert.equal(health.ready, true);
    const refreshed = await worker.handleAction({ actionId: 'bootstrap-workpaper-directory', expectedStateVersion: 1, context: { connectorBinding: binding, safetyLock: safety } });
    assert.equal(refreshed.surfacePatch.items.length, 1);
    // Step 1: select elements and advance (selects + generates the template
    // and jumps straight to the upload step).
    const selectedPlan = await worker.handleAction({ actionId: 'select-elements', expectedStateVersion: 2,
      payload: { targetIds: [ids.gra] }, context: { connectorBinding: binding, safetyLock: safety } });
    assert.equal(selectedPlan.surfacePatch.workflow.currentStepId, 'upload');
    assert.equal(actionById(selectedPlan.surfacePatch).get('upload-filled-workbook').enabled, true);
    assert.equal(opened.size, 0, 'selecting must not open any hidden Tab');
    // Simulate policy resolution to `resolved`: the plan moves straight to
    // resolved with no placeholders to write. Resolution now needs BOTH the
    // filled workbook and the policy archive; the upload that lands second
    // triggers it. Seed the replacement so the policy upload converges.
    let current: any = null; for (const value of plans.values()) { if (value.schemaVersion === 'omnia.workpaper-plan/v1') current = value; }
    assert.ok(current, 'a workpaper plan must be saved');
    current.workpaper.policy = { documents: [], state: 'extracted' };
    current.workpaper.replacement = { replacements: [], state: 'filled' };
    await store.call('savePlan', current);
    const uploaded = await worker.handleAction({ actionId: 'upload-policy', expectedStateVersion: 3,
      payload: { artifact: { schemaVersion: 'omnia.feature-artifact/v1', featureId: 'omnia.workpaper-preparation', kind: 'source', artifactId: 'artifact-1' } },
      context: { connectorBinding: binding, safetyLock: safety } });
    assert.equal(uploaded.surfacePatch.workflow.currentStepId, 'upload');
    assert.equal(actionById(uploaded.surfacePatch).get('next-to-writeback').enabled, true);
    assert.equal(actionById(uploaded.surfacePatch).get('confirm-writeback').enabled, false);
    // Step 3: 下一步 advances to the writeback step; confirm-writeback is
    // enabled only after that transition.
    const advanced = await worker.handleAction({ actionId: 'next-to-writeback', expectedStateVersion: 4,
      context: { connectorBinding: binding, safetyLock: safety } });
    assert.equal(advanced.surfacePatch.workflow.currentStepId, 'writeback');
    assert.equal(actionById(advanced.surfacePatch).get('confirm-writeback').enabled, true);
    // Seed a resolved row whose final text differs from the live snapshot so
    // the write-back loop must emit a real PATCH (not a no-op skip). The
    // controlNumber code APP.01 matches the single read-back Control.
    current = null; for (const value of plans.values()) { if (value.schemaVersion === 'omnia.workpaper-plan/v1') current = value; }
    assert.ok(current, 'an awaiting-writeback plan must be saved');
    current.workpaper.resolution = { state: 'resolved', resolutions: [{
      controlNumber: 'APP.01 - 系统A', resolvedText: '写回后的完整 TestOfDesign 文本', placeholders: [
        { placeholderId: 'ph-1', originalPlaceholder: '【政策名称】', index: 0, state: 'evidence_supported', value: '写回后的完整', evidenceRefs: [], reason: '' }
      ]
    }], resolvedAt: new Date().toISOString() };
    await store.call('savePlan', current);
    // Step 4: confirm-writeback opens the hidden Tab then writes back.
    const written = await worker.handleAction({ actionId: 'confirm-writeback', expectedStateVersion: 5,
      context: { connectorBinding: binding, safetyLock: safety } });
    assert.equal(written.surfacePatch.workflow.currentStepId, 'writeback');
    assert.equal(opened.size, 1, 'confirm-writeback must open the hidden Tab');
    assert.equal(directRequests.length, 1);
    assert.equal(writebackRequests.length, 1, 'writeback must emit exactly one PATCH');
    const patchChanges = writebackRequests[0]?.command?.payload?.changes;
    assert.ok(Array.isArray(patchChanges) && patchChanges.length === 1, 'writeback PATCH must carry one change');
    assert.equal(patchChanges[0].value, '写回后的完整 TestOfDesign 文本', 'writeback PATCH must carry the assembled resolved text');
  } finally {
    await worker.shutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('three-step workflow rail drives select, upload, and writeback navigation', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-workpaper-nav-'));
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
  const control = { ...selected, controlId: ids.control, workItemId: ids.controlWork, controlNumber: 'APP.01 - GRA APP',
    name: 'Control 1', updatedOn: '2026-08-09T00:00:00.000Z', opened: false, openVerified: false, associated: true,
    planningCommonControlTesting: false, usePreviousAuditEvidence: null, priorEvidenceDeclined: false,
    priorEvidenceNotApplicable: false, priorEvidenceComplete: false,
    coreConcurrency: { entityTabTypeId: 201, updatedOn: '2026-08-09T00:00:00.000Z' }, oeConcurrency: null,
    operatingEffectivenessId: ids.oe, absent: false, deleted: false };
  const plans = new Map<string, any>();
  const connector = { async invoke(input: any) {
    if (input.operationId.endsWith('directory.read.v1')) return { ...binding, workspaces: [{ id: ids.workspace, name: 'Workspace 1' }], gras: [selected] };
    if (input.operationId.endsWith('controls.read.v1')) return { ...selected, controls: [control] };
    if (input.operationId.endsWith('control.preflight.v1')) return control;
    throw new Error(`unexpected operation ${input.operationId}`);
  } };
  const store = { async call(method: string, input: any) {
    if (method === 'savePlan') { plans.set(input.planId, JSON.parse(JSON.stringify(input))); return true; }
    if (method === 'loadPlan') return plans.get(input) || null;
    if (method === 'loadOpenRun') return null;
    if (method === 'createMutationRun') return { runId: 'run-1', stateRevision: 1 };
    if (method === 'prepareReturnIntent') return { planDigest: 'a'.repeat(64), confirmationId: 'confirm-1', confirmationToken: 'token-1', stateVersion: 1, expiresAt: '2099-01-01T00:00:00.000Z' };
    if (method === 'commitStandaloneArtifact') return { artifactId: 'artifact-1', sha256: crypto.createHash('sha256').update(Buffer.from(input.contentBase64, 'base64')).digest('hex') };
    throw new Error(`unexpected store method ${method}`);
  } };
  const workerModule = require(path.join(source, 'middle', 'worker.cjs'));
  const worker = workerModule.createFeatureWorker({ connector, store, events: { emit() {} } });
  const stepById = (patch: any): Map<string, any> => new Map(patch.workflow.steps.map((step: any) => [step.stepId, step]));
  const actionById = (patch: any): Map<string, any> => new Map(patch.actions.map((action: any) => [action.actionId, action]));
  try {
    assert.equal((await worker.health()).ready, true);
    const boot = await worker.handleAction({ actionId: 'bootstrap-workpaper-directory', expectedStateVersion: 1, context: { connectorBinding: binding, safetyLock: safety } });
    assert.equal(boot.surfacePatch.workflow.currentStepId, 'select');
    assert.equal(stepById(boot.surfacePatch).get('select').state, 'current');
    assert.equal(stepById(boot.surfacePatch).get('upload').state, 'pending');
    assert.equal(stepById(boot.surfacePatch).get('writeback').state, 'pending');
    assert.equal(actionById(boot.surfacePatch).get('select-elements').enabled, true);
    assert.equal(actionById(boot.surfacePatch).get('restart-run').enabled, false);
    const selectedPlan = await worker.handleAction({ actionId: 'select-elements', expectedStateVersion: 2,
      payload: { targetIds: [ids.gra] }, context: { connectorBinding: binding, safetyLock: safety } });
    assert.equal(selectedPlan.surfacePatch.workflow.currentStepId, 'upload');
    assert.equal(stepById(selectedPlan.surfacePatch).get('select').state, 'completed');
    assert.equal(stepById(selectedPlan.surfacePatch).get('upload').state, 'current');
    assert.equal(actionById(selectedPlan.surfacePatch).get('restart-run').enabled, true);
  } finally {
    await worker.shutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
