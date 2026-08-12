import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'feature-packages', 'recording', 'source');
const output = path.join(root, 'feature-packages', 'recording', 'candidates');
const version = '0.4.21';
const sequence = 34;
const legacyOperationDigests = [
  'sha256:27218281da622b4bf3ec7ae64fa97e4f5cc3988a34abf659aff415bc71bb5d0f',
  'sha256:671ce107badb4d94600af7290c2b08c922088a2e8e2f56cd9d2d2f75869480db',
  'sha256:ec1ce1cfb3c33ce3b56257477fbb48866e790a158da570f4bbbe593e5abf01e9'
];
const legacyOperationHandlerSha256 = '43b48912e09d66a413e2af831fbc40ab22df8a09119bc8ca40ceb8b4ada47ef7';
const signingRoot = process.env.OMNIA_V5_SIGNING_ROOT || path.join(process.env.USERPROFILE || '', '.omnia-agent-v5', 'signing');
const featurePrivateKey = await readFile(path.join(signingRoot, 'feature-ed25519-private.pem'), 'utf8');
const operationPrivateKey = await readFile(path.join(signingRoot, 'operation-ed25519-private.pem'), 'utf8');

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function file(memberPath, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { path: memberPath, size: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') };
}
function envelope(product, packageId, keyId, privateKey, files) {
  const unsigned = { schemaVersion: 'omnia.official-package-envelope/v1', product, packageId, version, sequence, publisher: { keyId, algorithm: 'Ed25519' }, files: [...files].sort((a, b) => a.path.localeCompare(b.path)) };
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') };
}

const packHierarchyRoute = {
  stepId: 'pack-hierarchy', method: 'GET', routeTemplate: '/engagements/v1/{engagementId}/headers/hierarchy',
  parameters: [], bodyMode: 'none', bodyParameter: ''
};
const readOnlyOperation = (operationId, requestSchema, responseSchema, routes = [packHierarchyRoute]) => ({
  operationId, effect: 'read_only', requestSchema, responseSchema,
  enabledByDefault: true, grantsMutationPermit: false, routes
});
const operations = [
  readOnlyOperation(
    'omnia.recording.pack.read.v1', 'omnia.recording.pack-read-request/v1', 'omnia.recording.pack-read-result/v1',
    [packHierarchyRoute]
  ),
  readOnlyOperation('omnia.recording.observation.open.v1', 'omnia.recording.observation-open-request/v1', 'omnia.page-observation-status/v1'),
  readOnlyOperation('omnia.recording.observation.status.v1', 'omnia.recording.observation-control-request/v1', 'omnia.page-observation-status/v1'),
  readOnlyOperation('omnia.recording.observation.pause.v1', 'omnia.recording.observation-control-request/v1', 'omnia.page-observation-status/v1'),
  readOnlyOperation('omnia.recording.observation.resume.v1', 'omnia.recording.observation-control-request/v1', 'omnia.page-observation-status/v1'),
  readOnlyOperation('omnia.recording.observation.stop.v1', 'omnia.recording.observation-control-request/v1', 'omnia.page-observation-status/v1'),
  readOnlyOperation('omnia.recording.observation.read-chunk.v1', 'omnia.recording.managed-stream-read-request/v1', 'omnia.managed-stream-chunk/v1')
];
const operationHandler = await readFile(path.join(source, 'connector-capability', 'operation', 'handler.cjs'));
if (sha256(operationHandler) !== legacyOperationHandlerSha256) {
  throw new Error('Recording Operation handler drifted from the exact 0.4.18/0.4.19 ABI bytes.');
}
const operationManifest = {
  schemaVersion: 'omnia.connector-operation-manifest/v1', packageId: 'omnia.recording.operation', version, sequence,
  featureId: 'omnia.recording',
  resourceOwner: {
    schemaVersion: 'omnia.operation-resource-owner/v1',
    ownerId: 'omnia.page-observation.current-pack',
    compatibilityVersion: 1,
    capabilities: ['omnia.page-observation.current-pack.v1'],
    compatibleSourcePackageDigests: legacyOperationDigests
  },
  operations
};
const operationPackage = envelope('omnia-connector-operation', operationManifest.packageId, 'omnia-v5-official-operation-2026-01', operationPrivateKey, [
  file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'connector-operation', keyId: 'omnia-v5-official-operation-2026-01' }, null, 2)),
  file('docs/OPERATION.md', await readFile(path.join(source, 'docs', 'OPERATION.md'))),
  file('manifest.json', JSON.stringify(operationManifest, null, 2)),
  file('operation/handler.cjs', operationHandler),
  file('operation/policy.json', JSON.stringify({ schemaVersion: 'omnia.connector-operation-policy/v1', packageId: operationManifest.packageId, operationDigests: Object.fromEntries(operations.map((operation) => [operation.operationId, sha256(Buffer.from(JSON.stringify(operation)))])) }, null, 2)),
  file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: operationManifest.packageId, version } }, components: [] }, null, 2))
]);

const manifest = {
  schemaVersion: 'omnia.feature-manifest/v1', featureId: 'omnia.recording', version, sequence,
  displayName: '录制', minimumShellVersion: '0.4.15', requiredIsolation: 'process', storeNamespace: 'recording',
  migrationPath: 'backend/migrations/001.json', surfacePath: 'frontend/surface.json', workerPath: 'middle/worker.cjs',
  operationPackagePath: 'connector-capability/operation.ofop',
  contractsPath: 'contracts/feature-runtime.json', implementationMapPath: 'contracts/implementation-map.json', testsManifestPath: 'tests/manifest.json',
  recoveryCompatibility: {
    schemaVersion: 'omnia.feature-recovery-compatibility/v1', mode: 'frozen_input_finalize',
    sourceFeatureVersions: ['0.4.16', '0.4.17', '0.4.18', '0.4.19', '0.4.20'], actionId: 'retry-finalization'
  },
  navigation: {
    groups: [{ id: 'other', parentId: null, level: 1, label: '其他', order: 90 }],
    leaves: [{ id: 'recording', parentId: 'other', level: 2, label: '录制', order: 10,
      featureId: 'omnia.recording', featureVersion: version, route: 'feature:omnia.recording/workbench' }]
  }
};
const surface = {
  schemaVersion: 'omnia.declarative-feature-surface/v1', featureId: 'omnia.recording', featureVersion: version,
  surfaceId: 'recording.workbench', stateVersion: 1, title: '录制',
  description: '像播放器一样控制当前 Pack 的真实录制；停止时自动将记录固化到 Core Artifact Store。',
  density: 'compact', status: 'idle', statusMessage: '连接 Pack 后开始录制；每次开始使用独立 recordingId，旧记录不会阻塞新录制。',
  scopes: [], items: [], selectedItemIds: [], search: '',
  recorder: {
    state: 'idle', recordingId: '', startedAt: '', updatedAt: '', elapsedMs: 0,
    eventCount: 0, interactionCount: 0, networkRequestCount: 0, riskCount: 0, controlCount: 0,
    captureState: 'idle', captureMessage: '开始录制后将自动采集当前页 Risk 与 Control。', exportAvailable: false
  },
  actions: [
    { actionId: 'refresh-status', label: '刷新真实状态', presentation: 'refresh', effect: 'read_only', enabled: true, reason: '', selectionMode: 'none', dependencies: ['remote_connector'] },
    { actionId: 'start-recording', label: '开始录制', presentation: 'record', effect: 'local_state_write', enabled: true, reason: '', selectionMode: 'none', dependencies: ['remote_connector'] },
    { actionId: 'pause-recording', label: '暂停', presentation: 'pause', effect: 'local_state_write', enabled: false, reason: '只有正在进行的录制可以暂停。', selectionMode: 'none', dependencies: ['remote_connector'] },
    { actionId: 'stop-recording', label: '停止', presentation: 'stop', effect: 'local_state_write', enabled: false, reason: '当前没有可停止的录制。', selectionMode: 'none', dependencies: ['remote_connector'] },
    { actionId: 'restart-recording', label: '重新开始录制', presentation: 'record', effect: 'local_state_write', enabled: false, reason: '停止后的固化失败、录制失败或导出完成后可以重新开始。', selectionMode: 'none', dependencies: ['remote_connector'] },
    { actionId: 'finalize-recording', label: '后台固化', presentation: 'background', effect: 'local_state_write', enabled: false, reason: '停止确认后自动从同一冻结观察流固化。', selectionMode: 'none', dependencies: ['remote_connector'] },
    { actionId: 'retry-finalization', label: '重试固化', presentation: 'recover', effect: 'local_state_write', enabled: false, reason: '只有已经刷新确认 stopped recordingId 但尚未固化的录制可以重试。', selectionMode: 'none', dependencies: ['remote_connector'] },
    { actionId: 'export-recording', label: '导出录制记录', presentation: 'export', effect: 'read_only', enabled: false, reason: '当前录制尚无已提交的 Core Artifact。', selectionMode: 'none', dependencies: [] }
  ]
};
const migration = {
  schemaVersion: 'omnia.feature-private-migration/v1', namespace: 'recording', version: 1,
  tables: [
    { name: 'recording_sessions', columns: [
      { name: 'recording_id', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'run_id', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'state', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'started_at', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'stopped_at', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'finalized_at', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'purge_after', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'event_count', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'catalog_count', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'metadata_json', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'artifact_json', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'error_message', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'created_at', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'updated_at', type: 'TEXT', notNull: true, primaryKey: false }
    ] },
    { name: 'recording_events', columns: [
      { name: 'event_key', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'recording_id', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'sequence', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'event_json', type: 'TEXT', notNull: true, primaryKey: false }
    ] },
    { name: 'recording_catalogs', columns: [
      { name: 'catalog_key', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'recording_id', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'stable_id', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'sequence', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'metadata_json', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'catalog_json', type: 'TEXT', notNull: true, primaryKey: false }
    ] }
  ]
};
const featureDoc = (await readFile(path.join(source, 'docs', 'FEATURE.md'), 'utf8')).replaceAll('__FEATURE_VERSION__', version);
const implementationDoc = await readFile(path.join(source, 'docs', 'IMPLEMENTATION_MAP.md'));
const docs = [
  { path: 'docs/FEATURE.md', content: Buffer.from(featureDoc), purpose: 'product-safety-and-live-validation-contract' },
  { path: 'docs/IMPLEMENTATION_MAP.md', content: implementationDoc, purpose: 'four-plane-implementation-map' },
  { path: 'docs/CONTRACT.md', content: await readFile(path.join(source, 'docs', 'CONTRACT.md')), purpose: 'runtime-contract' },
  { path: 'docs/TESTING.md', content: await readFile(path.join(source, 'docs', 'TESTING.md')), purpose: 'acceptance-contract' },
  { path: 'docs/OPERATIONS.md', content: await readFile(path.join(source, 'docs', 'OPERATIONS.md')), purpose: 'operations-contract' },
  { path: 'docs/SUPPORT_MATRIX.md', content: await readFile(path.join(source, 'docs', 'SUPPORT_MATRIX.md')), purpose: 'supported-recording-and-gra-read-capabilities' },
  { path: 'docs/VERSION.md', content: await readFile(path.join(source, 'docs', 'VERSION.md')), purpose: 'version-contract' },
  { path: 'docs/TRANSPORT_GAP.md', content: await readFile(path.join(source, 'docs', 'TRANSPORT_GAP.md')), purpose: 'generic-transport-contract-gap' }
];
const pythonMemberPaths = ['python/export.py', 'python/gra_catalog.py', 'python/protocol.py', 'python/recording-engine.py', 'python/recording_store.py'];
const pythonFiles = await Promise.all(pythonMemberPaths.map(async (memberPath) => ({
  path: memberPath,
  bytes: await readFile(path.join(source, ...memberPath.split('/')))
})));
const runtimeContract = {
  schemaVersion: 'omnia.feature-runtime-contract/v1', featureId: manifest.featureId, featureVersion: version,
  inputs: ['connector_binding', 'current_pack_hierarchy', 'processing_run', 'page_observation_status', 'managed_observation_ndjson_stream', 'raw_gra_read_response_evidence', 'python_input_handle', 'python_output_handle'],
  outputs: ['surface_patch', 'recording_history', 'feature_freeze_evidence', 'feature_rebuilt_gra_catalog', 'managed_recording_json_artifact'],
  events: ['recording.started', 'recording.paused', 'recording.stopped', 'recording.finalized', 'recording.finalization_failed'],
  errors: ['RECORDING.*', 'PYTHON.*'],
  storePorts: [
    'createProcessingRun', 'createSuccessorProcessingRun', 'loadProcessingRun', 'finishProcessingRun', 'failProcessingRun',
    'beginPythonInputTransfer', 'appendPythonInputTransferChunk', 'commitPythonInputTransfer', 'abortPythonInputTransfer',
    'createPythonOutputHandle', 'commitPythonOutputHandle', 'releasePythonArtifactHandles',
    'appendEvidence', 'compareAndSwapPlan', 'savePlan', 'loadPlan'
  ],
  pythonSidecar: {
    schemaVersion: 'omnia.python-sidecar-runtime/v1', implementation: 'cpython', version: '3.13.14', architecture: 'win32-x64',
    protocol: 'omnia.python-sidecar-rpc/v1', bridgePath: 'middle/recording-python-bridge.cjs', entryPath: 'python/recording-engine.py',
    members: pythonMemberPaths, maxFrameBytes: 1024 * 1024, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 15000
  }
};
const implementationMap = {
  schemaVersion: 'omnia.feature-implementation-map/v1', featureId: manifest.featureId, featureVersion: version,
  planes: {
    surface: ['frontend/surface.json'],
    worker: ['middle/worker.cjs', 'middle/recording-python-bridge.cjs', ...pythonMemberPaths],
    store: ['backend/migrations/001.json', 'contracts/feature-runtime.json'],
    connector: ['connector-capability/operation.ofop']
  },
  operations: operationManifest.operations.map(({ operationId, effect }) => ({ operationId, effect }))
};
const testIds = [
  'signed-python-members-present',
  'release-python-contract-pinned',
  'generic-page-observation-only',
  'failed-run-successor-frozen-input-recovery'
];
const testVectors = { schemaVersion: 'omnia.feature-test-vectors/v1', featureId: manifest.featureId, vectors: testIds.map((testId) => ({ testId, inputRef: 'tests/self-test.cjs', expected: 'pass' })) };
const testsManifest = { schemaVersion: 'omnia.feature-tests-manifest/v1', featureId: manifest.featureId, featureVersion: version, testIds, vectorsPath: 'tests/vectors.json', selfTestPath: 'tests/self-test.cjs', status: 'declared', command: 'node tests/self-test.cjs' };
const selfTest = `'use strict';\nconst fs=require('node:fs'),path=require('node:path');\nconst root=path.resolve(__dirname,'..');\nconst contract=JSON.parse(fs.readFileSync(path.join(root,'contracts','feature-runtime.json'),'utf8'));\nfor(const member of contract.pythonSidecar.members)if(!fs.statSync(path.join(root,...member.split('/'))).isFile())throw new Error('missing signed Python member: '+member);\nif(contract.featureId!=='omnia.recording'||contract.featureVersion!=='${version}'||contract.pythonSidecar.version!=='3.13.14'||!contract.storePorts.includes('createSuccessorProcessingRun'))throw new Error('recording runtime contract mismatch');\nconst bridge=fs.readFileSync(path.join(root,'middle','recording-python-bridge.cjs'),'utf8');\nconst protocol=fs.readFileSync(path.join(root,'python','protocol.py'),'utf8');\nif(!bridge.includes('cpython-3.13.14-embed-amd64')||!bridge.includes('PATH/system Python fallback is forbidden')||!bridge.includes('adopt_successor_run')||!protocol.includes('adopt_successor_run'))throw new Error('recording managed Python recovery contract is absent');\nconst envelope=JSON.parse(fs.readFileSync(path.join(root,'connector-capability','operation.ofop'),'utf8'));\nconst manifestMember=envelope.files.find((item)=>item.path==='manifest.json');\nconst operationManifest=manifestMember?JSON.parse(Buffer.from(manifestMember.contentBase64,'base64').toString('utf8')):null;\nif(!operationManifest||operationManifest.resourceOwner?.ownerId!=='omnia.page-observation.current-pack'||operationManifest.resourceOwner?.compatibilityVersion!==1||JSON.stringify(operationManifest.resourceOwner?.capabilities)!==JSON.stringify(['omnia.page-observation.current-pack.v1'])||JSON.stringify(operationManifest.resourceOwner?.compatibleSourcePackageDigests)!==JSON.stringify(${JSON.stringify(legacyOperationDigests)}))throw new Error('recording Operation resource-owner handoff contract is absent');\nconst member=envelope.files.find((item)=>item.path==='operation/handler.cjs');\nconst operation=member?Buffer.from(member.contentBase64,'base64').toString('utf8'):'';\nif(!operation.includes('sdk.pageObservation')||/recordingCommand|recording_command/.test(operation))throw new Error('recording operation escaped the generic PageObservation boundary');\nprocess.stdout.write('omnia.recording package contract self-test passed\\n');\n`;
const featurePackage = envelope('omnia-feature', manifest.featureId, 'omnia-v5-official-feature-2026-01', featurePrivateKey, [
  file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'feature', keyId: 'omnia-v5-official-feature-2026-01' }, null, 2)),
  file('backend/migrations/001.json', JSON.stringify(migration, null, 2)),
  file('connector-capability/operation.ofop', JSON.stringify(operationPackage)),
  file('contracts/feature-runtime.json', JSON.stringify(runtimeContract, null, 2)),
  file('contracts/implementation-map.json', JSON.stringify(implementationMap, null, 2)),
  ...docs.map((doc) => file(doc.path, doc.content)),
  file('docs/manifest.json', JSON.stringify({ schemaVersion: 'omnia.feature-documentation/v1', featureId: manifest.featureId, featureVersion: version, documents: docs.map((doc) => ({ path: doc.path, sha256: sha256(doc.content), purpose: doc.purpose })) }, null, 2)),
  file('frontend/surface.json', JSON.stringify(surface, null, 2)),
  file('manifest.json', JSON.stringify(manifest, null, 2)),
  file('middle/worker.cjs', (await readFile(path.join(source, 'middle', 'worker.cjs'), 'utf8')).replaceAll('__FEATURE_VERSION__', version)),
  file('middle/recording-python-bridge.cjs', await readFile(path.join(source, 'middle', 'recording-python-bridge.cjs'))),
  ...pythonFiles.map((member) => file(member.path, member.bytes)),
  file('tests/manifest.json', JSON.stringify(testsManifest, null, 2)),
  file('tests/vectors.json', JSON.stringify(testVectors, null, 2)),
  file('tests/self-test.cjs', selfTest),
  file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: manifest.featureId, version } }, components: [{ type: 'application', name: 'CPython embeddable runtime', version: '3.13.14', scope: 'required' }] }, null, 2))
]);
await mkdir(output, { recursive: true });
async function immutableWrite(filename, value, label) {
  const serialized = JSON.stringify(value);
  let current = null;
  try { current = await readFile(filename, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (current !== null && current !== serialized) {
    throw new Error(`Refusing to overwrite immutable ${label} package: ${filename}`);
  }
  if (current === null) await writeFile(filename, serialized, { flag: 'wx' });
  return serialized;
}

const operationFilename = path.join(output, `recording-operation-${version}.ofop`);
const featureFilename = path.join(output, `recording-${version}.ofp`);
const serializedOperation = await immutableWrite(operationFilename, operationPackage, 'Operation');
const serializedFeature = await immutableWrite(featureFilename, featurePackage, 'Feature');
console.log(`${path.relative(root, operationFilename)} sha256:${sha256(Buffer.from(serializedOperation))}`);
console.log(`${path.relative(root, featureFilename)} sha256:${sha256(Buffer.from(serializedFeature))}`);
