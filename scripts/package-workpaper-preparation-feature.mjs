import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'feature-packages', 'workpaper-preparation', 'source');
const output = path.join(root, 'feature-packages', 'workpaper-preparation', 'candidates');
const version = '0.1.35';
const sequence = 36;
const signingRoot = process.env.OMNIA_V5_SIGNING_ROOT || path.join(process.env.USERPROFILE || '', '.omnia-agent-v5', 'signing');
const featurePrivateKey = await readFile(path.join(signingRoot, 'feature-ed25519-private.pem'), 'utf8');
const operationPrivateKey = await readFile(path.join(signingRoot, 'operation-ed25519-private.pem'), 'utf8');

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Cannot sign non-finite JSON.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Cannot sign a non-JSON value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function file(memberPath, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { path: memberPath, size: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') };
}
function envelope({ product, packageId, keyId, privateKey, files }) {
  const unsigned = { schemaVersion: 'omnia.official-package-envelope/v1', product, packageId, version, sequence,
    publisher: { keyId, algorithm: 'Ed25519' }, files: [...files].sort((left, right) => left.path.localeCompare(right.path)) };
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') };
}
const route = (stepId, method, routeTemplate, parameters = [], bodyMode = 'none', bodyParameter = '') =>
  ({ stepId, method, routeTemplate, parameters, bodyMode, bodyParameter });
const graContextRoutes = (prefix) => [
  route(`${prefix}-gra-detail`, 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
  route(`${prefix}-app-detail`, 'GET', '/rapr/v0/engagements/{engagementId}/itelement/{appId}', [{ name: 'appId', type: 'guid' }]),
  route(`${prefix}-app-facet-mapping`, 'GET', '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', [{ name: 'workItemId', type: 'guid' }])
];
const operations = [
  {
    operationId: 'omnia.workpaper.directory.read.v1', effect: 'read_only',
    requestSchema: 'omnia.workpaper.directory-read-request/v1', responseSchema: 'omnia.workpaper.directory-read-response/v1',
    enabledByDefault: true, grantsMutationPermit: false, routes: [
      route('pack-hierarchy', 'GET', '/engagements/v1/{engagementId}/headers/hierarchy'),
      route('authority-directory', 'POST', '/engagements/v1/facets/byEngagementIds', [{ name: 'engagementId', type: 'guid' }], 'parameter_array', 'engagementId'),
      route('gra-workitem-index', 'POST', '/work/v1/WorkQueries/getWorkitemDetails', [], 'signed_json'),
      route('gra-common-account-index', 'POST', '/rapr/v0/engagements/{engagementId}/riskassessments/commonAccounts', [], 'signed_json'),
      route('directory-gra-content-authority', 'GET', '/rapr/v0/engagements/{engagementId}/content/reference-list-byLatestDate?typeId={catalogType}&releaseDate={releaseDate}', [
        { name: 'catalogType', type: 'string' }, { name: 'releaseDate', type: 'string' }
      ]),
      ...graContextRoutes('directory')
    ]
  },
  {
    operationId: 'omnia.workpaper.controls.read.v1', effect: 'read_only',
    requestSchema: 'omnia.workpaper.controls-read-request/v1', responseSchema: 'omnia.workpaper.controls-read-response/v1',
    enabledByDefault: true, grantsMutationPermit: false, routes: [
      ...graContextRoutes('controls'),
      route('control-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/controls/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
      route('controls-control-detail', 'GET', '/rapr/v0/engagements/{engagementId}/controls/{controlId}', [{ name: 'controlId', type: 'guid' }])
    ]
  },
  {
    operationId: 'omnia.workpaper.control.preflight.v1', effect: 'read_only',
    requestSchema: 'omnia.workpaper.control-preflight-request/v1', responseSchema: 'omnia.workpaper.control-preflight-response/v1',
    enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.workpaper.control.open-hidden-tab.v1', routes: [
      ...graContextRoutes('preflight'),
      route('preflight-control-detail', 'GET', '/rapr/v0/engagements/{engagementId}/controls/{controlId}', [{ name: 'controlId', type: 'guid' }])
    ]
  },
  {
    operationId: 'omnia.workpaper.control.open-hidden-tab.v1', effect: 'omnia_mutation',
    requestSchema: 'omnia.workpaper.control-open-hidden-tab-request/v1', responseSchema: 'omnia.workpaper.control-open-hidden-tab-response/v1',
    enabledByDefault: false, grantsMutationPermit: false, routes: [
      ...graContextRoutes('mutation'),
      route('mutation-control-detail', 'GET', '/rapr/v0/engagements/{engagementId}/controls/{controlId}', [{ name: 'controlId', type: 'guid' }]),
      route('validate-hidden-data', 'POST', '/rapr/v0/engagements/{engagementId}/controls/{controlId}/validateHiddenData', [{ name: 'controlId', type: 'guid' }], 'signed_json'),
      route('mutation-stage-one-readback', 'GET', '/rapr/v0/engagements/{engagementId}/controls/{controlId}', [{ name: 'controlId', type: 'guid' }]),
      route('open-hidden-tab', 'PATCH', '/rapr/v0/engagements/{engagementId}/controls/{controlId}', [{ name: 'controlId', type: 'guid' }], 'signed_json')
    ]
  },
  {
    operationId: 'omnia.workpaper.control.reconcile.v1', effect: 'read_only',
    requestSchema: 'omnia.workpaper.control-reconcile-request/v1', responseSchema: 'omnia.workpaper.control-reconcile-response/v1',
    enabledByDefault: true, grantsMutationPermit: false, routes: [
      ...graContextRoutes('reconcile'),
      route('reconcile-control-detail', 'GET', '/rapr/v0/engagements/{engagementId}/controls/{controlId}', [{ name: 'controlId', type: 'guid' }])
    ]
  }
];

const operationManifest = { schemaVersion: 'omnia.connector-operation-manifest/v1', packageId: 'omnia.workpaper-preparation.operation',
  version, sequence, featureId: 'omnia.workpaper-preparation', operations };
const operationPolicy = { schemaVersion: 'omnia.connector-operation-policy/v1', packageId: operationManifest.packageId,
  operationDigests: Object.fromEntries(operations.map((operation) => [operation.operationId, sha256(Buffer.from(JSON.stringify(operation)))])) };
const operationDocs = (await readFile(path.join(source, 'docs', 'OPERATION.md'), 'utf8')).replaceAll('__FEATURE_VERSION__', version);
const operationPackage = envelope({ product: 'omnia-connector-operation', packageId: operationManifest.packageId,
  keyId: 'omnia-v5-official-operation-2026-01', privateKey: operationPrivateKey, files: [
    file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'connector-operation', keyId: 'omnia-v5-official-operation-2026-01' }, null, 2)),
    file('docs/OPERATION.md', operationDocs), file('manifest.json', JSON.stringify(operationManifest, null, 2)),
    file('operation/handler.cjs', await readFile(path.join(source, 'connector-capability', 'operation', 'handler.cjs'))),
    file('operation/policy.json', JSON.stringify(operationPolicy, null, 2)),
    file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
      metadata: { component: { type: 'application', name: operationManifest.packageId, version } }, components: [] }, null, 2))
  ] });

const featureDocs = (await readFile(path.join(source, 'docs', 'FEATURE.md'), 'utf8')).replaceAll('__FEATURE_VERSION__', version);
const implementationDocs = (await readFile(path.join(source, 'docs', 'IMPLEMENTATION_MAP.md'), 'utf8')).replaceAll('__FEATURE_VERSION__', version);
const genericAppDocs = await readFile(path.join(source, 'docs', 'PHASE2_GENERIC_APP.md'), 'utf8');
const documentationFiles = [
  { path: 'docs/FEATURE.md', bytes: Buffer.from(featureDocs), purpose: 'product-safety-and-evidence-contract' },
  { path: 'docs/IMPLEMENTATION_MAP.md', bytes: Buffer.from(implementationDocs), purpose: 'four-plane-implementation-map' },
  { path: 'docs/PHASE2_GENERIC_APP.md', bytes: Buffer.from(genericAppDocs), purpose: 'phase2-generic-app-field-contract' }
];
const runtimeContract = {
  schemaVersion: 'omnia.feature-runtime-contract/v1', featureId: 'omnia.workpaper-preparation', featureVersion: version,
  inputs: ['connector_binding', 'workspace_safety', 'single_application_gra_selection', 'hidden_tab_confirmation', 'read_only_reconcile'],
  outputs: ['surface_patch', 'durable_control_plan', 'operation_receipt', 'verified_control_projection'],
  events: ['workpaper.hidden_tab_plan_cancelled', 'workpaper.hidden_tab_reconcile_started', 'workpaper.hidden_tab_reconcile_resolved'],
  errors: ['WORKPAPER.*', 'PYTHON.*', 'CONNECTOR.RESPONSE_LOST'],
  storePorts: ['savePlan', 'loadPlan', 'createMutationRun', 'prepareReturnIntent', 'approveReturnIntent', 'validateReturnAuthority',
    'returnRunToReview', 'prepareDeletionCommand', 'freezeReturnEvidenceSpec', 'recordReturnEvidence', 'projectVerifiedReturn',
    'loadLatestRun', 'transitionRun', 'finishReturn'],
  pythonSidecar: { schemaVersion: 'omnia.python-sidecar-runtime/v1', implementation: 'cpython', version: '3.13.14', architecture: 'win32-x64',
    protocol: 'omnia.python-sidecar-rpc/v1', bridgePath: 'middle/workpaper-preparation-python-bridge.cjs', entryPath: 'python/workpaper-preparation-engine.py', members: ['python/workpaper-preparation-engine.py'],
    maxFrameBytes: 1024 * 1024, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 15000 }
};
const implementationContract = { schemaVersion: 'omnia.feature-implementation-map/v1', featureId: 'omnia.workpaper-preparation', featureVersion: version,
  planes: { surface: ['frontend/surface.json'], worker: ['middle/worker.cjs', 'middle/workpaper-preparation-python-bridge.cjs', 'python/workpaper-preparation-engine.py'],
    store: ['backend/migrations/001.json', 'contracts/feature-runtime.json'], connector: ['connector-capability/operation.ofop'] },
  operations: operations.map(({ operationId, effect }) => ({ operationId, effect })) };
const featureManifest = {
  schemaVersion: 'omnia.feature-manifest/v1', featureId: 'omnia.workpaper-preparation', version, sequence, displayName: '底稿编制',
  minimumShellVersion: '0.4.15', requiredIsolation: 'process', storeNamespace: 'workpaper_preparation',
  migrationPath: 'backend/migrations/001.json', surfacePath: 'frontend/surface.json', workerPath: 'middle/worker.cjs',
  operationPackagePath: 'connector-capability/operation.ofop', contractsPath: 'contracts/feature-runtime.json',
  implementationMapPath: 'contracts/implementation-map.json', testsManifestPath: 'tests/manifest.json',
  recoveryCompatibility: { schemaVersion: 'omnia.feature-recovery-compatibility/v1', mode: 'authoritative_reconcile_continue',
    sourceFeatureVersions: ['0.1.24','0.1.25','0.1.26','0.1.27','0.1.28','0.1.29','0.1.30','0.1.31'], actionId: 'reconcile-hidden-tabs' },
  navigation: { groups: [{ id: 'workpaper', parentId: null, level: 1, label: '底稿', order: 50 }],
    leaves: [{ id: 'workpaper-preparation', parentId: 'workpaper', level: 2, label: '底稿编制', order: 10,
      featureId: 'omnia.workpaper-preparation', featureVersion: version, route: 'feature:omnia.workpaper-preparation/workbench' }] }
};
const actions = [
  { actionId: 'bootstrap-workpaper-directory', label: '首次读取 APP GRA', effect: 'read_only', enabled: true, reason: '', selectionMode: 'none', presentation: 'background', dependencies: ['remote_connector', 'safety_lock'] },
  { actionId: 'refresh-workpaper-directory', label: '重新读取 APP GRA', effect: 'read_only', enabled: true, reason: '', selectionMode: 'none', presentation: 'refresh', dependencies: ['remote_connector', 'safety_lock'] },
  { actionId: 'prepare-hidden-tabs', label: '读取 Control 并创建计划', effect: 'local_state_write', enabled: true, reason: '', selectionMode: 'multiple', dependencies: ['remote_connector', 'safety_lock'] },
  { actionId: 'cancel-hidden-tab-plan', label: '取消计划', effect: 'local_state_write', enabled: false, reason: '当前没有待确认计划。', selectionMode: 'none', dependencies: [] },
  { actionId: 'confirm-hidden-tabs', label: '确认打开隐藏 Tab', effect: 'omnia_mutation', enabled: false, reason: '当前没有待确认计划。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] },
  { actionId: 'reconcile-hidden-tabs', label: '核验并继续未完成步骤', effect: 'omnia_mutation', enabled: false, reason: '当前没有待核验 command。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] },
  { actionId: 'back-to-upload', label: '返回上一步', effect: 'local_state_write', enabled: false, reason: '当前已是第一步，没有可返回的上一步。', selectionMode: 'none', dependencies: [] },
  { actionId: 'restart-run', label: '强制结束流程', effect: 'local_state_write', enabled: false, reason: '当前没有可结束的流程。', presentation: 'restart', selectionMode: 'none', dependencies: [] }
];
const surface = {
  schemaVersion: 'omnia.declarative-feature-surface/v1', featureId: 'omnia.workpaper-preparation', featureVersion: version,
  surfaceId: 'workpaper-preparation.workbench', stateVersion: 1, title: '底稿编制',
  description: '选择一个或多个 Generic Application GRA，并为这些 GRA 的真实 Control 打开经营有效性隐藏 Tab。', density: 'compact',
  status: 'loading', statusMessage: '正在读取当前 Pack 的真实 Application GRA。', scopes: [], items: [], selectedItemIds: [], search: '', actions,
  workflow: { revision: 1, currentStepId: 'select', steps: [
    { stepId: 'select', label: '选择元素', state: 'current', detail: '选择 Generic Application GRA' },
    { stepId: 'open', label: '打开隐藏 Tab', state: 'pending', detail: '等待选择元素' }
  ] },
  selectionBrowser: { schemaVersion: 'omnia.declarative-selection-browser/v1',
    layout: { schemaVersion: 'omnia.selection-browser-layout/v1', mode: 'fixed_footer_split' },
    hierarchyLabel: 'Workspace / Application GRA',
    resultsLabel: '当前 Application GRA', searchPlaceholder: '搜索 GRA 编号、名称或 APP', emptyMessage: '当前范围没有 Application GRA',
    allScopesLabel: '全部当前 Workspace', selectVisibleLabel: '选择当前结果', clearSelectionLabel: '取消当前选择',
    footerActionIds: actions.map((item) => item.actionId).filter((item) => item !== 'bootstrap-workpaper-directory' && item !== 'back-to-upload' && item !== 'restart-run'), primaryActionId: 'prepare-hidden-tabs' }
};
const migration = { schemaVersion: 'omnia.feature-private-migration/v1', namespace: 'workpaper_preparation', version: 1, tables: [
  { name: 'workpaper_preparation_plans', columns: [
    { name: 'plan_id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'payload_json', type: 'TEXT', notNull: true, primaryKey: false },
    { name: 'updated_at', type: 'TEXT', notNull: true, primaryKey: false }
  ] }
] };
const tests = ['python-hidden-tab-plan', 'application-gra-directory', 'tab-201-patch-contract', 'tab-209-readback-contract', 'no-comments-surface', 'no-replay-reconcile'];
const testsManifest = { schemaVersion: 'omnia.feature-tests-manifest/v1', featureId: featureManifest.featureId, featureVersion: version,
  testIds: tests, vectorsPath: 'tests/vectors.json', selfTestPath: 'tests/self-test.cjs', status: 'declared', command: 'node tests/self-test.cjs' };
const testVectors = { schemaVersion: 'omnia.feature-test-vectors/v1', featureId: featureManifest.featureId,
  vectors: tests.map((testId) => ({ testId, inputRef: 'tests/self-test.cjs', expected: 'pass' })) };
const packageSelfTest = `'use strict';
const fs=require('node:fs'),path=require('node:path');const root=path.resolve(__dirname,'..');
const read=(member)=>fs.readFileSync(path.join(root,...member.split('/')),'utf8');
const manifest=JSON.parse(read('manifest.json')),surface=JSON.parse(read('frontend/surface.json')),runtime=JSON.parse(read('contracts/feature-runtime.json'));
const operation=JSON.parse(read('connector-capability/operation.ofop'));const handlerMember=operation.files.find((item)=>item.path==='operation/handler.cjs');
const handler=handlerMember&&Buffer.from(handlerMember.contentBase64,'base64').toString('utf8');const worker=read('middle/worker.cjs'),engine=read('python/workpaper-preparation-engine.py');
if(manifest.featureId!=='omnia.workpaper-preparation'||manifest.version!=='${version}'||runtime.pythonSidecar?.version!=='3.13.14')throw new Error('runtime identity failed');
if(surface.actions.some((item)=>item.actionId.includes('comment'))||worker.includes('messageCard')||!surface.selectionBrowser||surface.selectionBrowser.layout?.mode!=='fixed_footer_split'||surface.actions.find((item)=>item.actionId==='prepare-hidden-tabs')?.selectionMode!=='multiple')throw new Error('Feature-only two-step Surface failed');
if(!surface.workflow||surface.workflow.steps.length!==2||surface.workflow.steps[0].stepId!=='select'||surface.workflow.steps[1].stepId!=='open'||!surface.actions.some((item)=>item.actionId==='back-to-upload')||!surface.actions.some((item)=>item.actionId==='restart-run'&&item.presentation==='restart'))throw new Error('Declarative three-column workflow Surface failed');
if(!handler||!handler.includes("path: '/planningOperatingEffectivenessTesting'")||!handler.includes("path: '/planningCommonControlTesting'")||!handler.includes("path: '/usePreviousAuditEvidence'")||!handler.includes("'validate-hidden-data'")||!handler.includes('CONTROL_CORE_TAB_ID = 201')||!handler.includes('CONTROL_OE_TAB_ID = 209')||!handler.includes("outcome: 'not_applied'"))throw new Error('signed hidden-tab Operation failed');
if(!worker.includes("finishReturn', { runId: plan.runId, outcome: 'uncertain'")||!worker.includes("operationId: OPERATIONS.reconcile")
  ||!worker.includes('currentPreflight(step, b, plan.planDigest, plan.runId)')||!worker.includes('planDigest: plan.planDigest')
  ||!worker.includes('workflowSurface(plan)')||!worker.includes('forceEnd(plan, context)')||!worker.includes('backToSelect(plan, context)')
  ||!engine.includes('select_hidden_tab_controls')||!engine.includes('build_hidden_tab_plan')||!engine.includes('classify_control_observation'))throw new Error('permit, delivery, no-replay, workflow navigation, or Python planner contract failed');
process.stdout.write('omnia.workpaper-preparation package self-test passed\\n');`;
const documentationManifest = { schemaVersion: 'omnia.feature-documentation/v1', featureId: featureManifest.featureId, featureVersion: version,
  documents: documentationFiles.map((item) => ({ path: item.path, sha256: sha256(item.bytes), purpose: item.purpose })) };
const worker = (await readFile(path.join(source, 'middle', 'worker.cjs'), 'utf8')).replaceAll('__FEATURE_VERSION__', version);
const featurePackage = envelope({ product: 'omnia-feature', packageId: featureManifest.featureId,
  keyId: 'omnia-v5-official-feature-2026-01', privateKey: featurePrivateKey, files: [
    file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'feature', keyId: 'omnia-v5-official-feature-2026-01' }, null, 2)),
    file('backend/migrations/001.json', JSON.stringify(migration, null, 2)),
    file('connector-capability/operation.ofop', JSON.stringify(operationPackage)),
    file('contracts/feature-runtime.json', JSON.stringify(runtimeContract, null, 2)),
    file('contracts/implementation-map.json', JSON.stringify(implementationContract, null, 2)),
    file('docs/FEATURE.md', featureDocs), file('docs/IMPLEMENTATION_MAP.md', implementationDocs), file('docs/PHASE2_GENERIC_APP.md', genericAppDocs),
    file('docs/manifest.json', JSON.stringify(documentationManifest, null, 2)),
    file('frontend/surface.json', JSON.stringify(surface, null, 2)), file('manifest.json', JSON.stringify(featureManifest, null, 2)),
    file('middle/worker.cjs', worker), file('middle/workpaper-preparation-python-bridge.cjs', await readFile(path.join(source, 'middle', 'workpaper-preparation-python-bridge.cjs'))),
    file('python/workpaper-preparation-engine.py', await readFile(path.join(source, 'python', 'workpaper-preparation-engine.py'))),
    file('tests/manifest.json', JSON.stringify(testsManifest, null, 2)), file('tests/vectors.json', JSON.stringify(testVectors, null, 2)),
    file('tests/self-test.cjs', packageSelfTest),
    file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
      metadata: { component: { type: 'application', name: featureManifest.featureId, version } },
      components: [{ type: 'application', name: 'CPython embeddable runtime', version: '3.13.14', scope: 'required' }] }, null, 2))
  ] });

await mkdir(output, { recursive: true });
async function immutableWrite(filename, value) {
  const serialized = JSON.stringify(value); let existing = null;
  try { existing = await readFile(filename, 'utf8'); } catch (error) { if (error && error.code !== 'ENOENT') throw error; }
  if (existing !== null && existing !== serialized) throw new Error(`Refusing to overwrite immutable package: ${filename}`);
  if (existing === null) await writeFile(filename, serialized, { flag: 'wx' });
  return serialized;
}
const operationFilename = path.join(output, `workpaper-preparation-operation-${version}.ofop`);
const featureFilename = path.join(output, `workpaper-preparation-${version}.ofp`);
const operationBytes = await immutableWrite(operationFilename, operationPackage);
const featureBytes = await immutableWrite(featureFilename, featurePackage);
console.log(`${path.relative(root, operationFilename)} sha256:${sha256(Buffer.from(operationBytes))}`);
console.log(`${path.relative(root, featureFilename)} sha256:${sha256(Buffer.from(featureBytes))}`);
