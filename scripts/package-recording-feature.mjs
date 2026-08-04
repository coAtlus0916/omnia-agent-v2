import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'feature-packages', 'recording', 'source');
const output = path.join(root, 'feature-packages', 'recording', 'candidates');
const version = '0.3.0';
const sequence = 4;
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

const operation = {
  operationId: 'omnia.recording.registration-probe.v1', effect: 'read_only',
  requestSchema: 'omnia.recording.registration-probe-request/v1', responseSchema: 'omnia.recording.registration-probe-response/v1',
  enabledByDefault: true, grantsMutationPermit: false,
  routes: [{ stepId: 'pack-hierarchy', method: 'GET', routeTemplate: '/engagements/v1/{engagementId}/headers/hierarchy', parameters: [], bodyMode: 'none', bodyParameter: '' }]
};
const operationManifest = {
  schemaVersion: 'omnia.connector-operation-manifest/v1', packageId: 'omnia.recording.operation', version, sequence,
  featureId: 'omnia.recording', operations: [operation]
};
const operationPackage = envelope('omnia-connector-operation', operationManifest.packageId, 'omnia-v5-official-operation-2026-01', operationPrivateKey, [
  file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'connector-operation', keyId: 'omnia-v5-official-operation-2026-01' }, null, 2)),
  file('docs/OPERATION.md', await readFile(path.join(source, 'docs', 'OPERATION.md'))),
  file('manifest.json', JSON.stringify(operationManifest, null, 2)),
  file('operation/handler.cjs', await readFile(path.join(source, 'connector-capability', 'operation', 'handler.cjs'))),
  file('operation/policy.json', JSON.stringify({ schemaVersion: 'omnia.connector-operation-policy/v1', packageId: operationManifest.packageId, operationDigests: { [operation.operationId]: sha256(Buffer.from(JSON.stringify(operation))) } }, null, 2)),
  file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: operationManifest.packageId, version } }, components: [] }, null, 2))
]);

const manifest = {
  schemaVersion: 'omnia.feature-manifest/v1', featureId: 'omnia.recording', version, sequence,
  displayName: '录制', minimumShellVersion: '0.4.0', requiredIsolation: 'process', storeNamespace: 'recording',
  migrationPath: 'backend/migrations/001.json', surfacePath: 'frontend/surface.json', workerPath: 'middle/worker.cjs',
  operationPackagePath: 'connector-capability/operation.ofop',
  navigation: {
    groups: [],
    leaves: [{ id: 'recording', parentId: '', level: 2, label: '录制', order: 10, featureId: 'omnia.recording', featureVersion: version, route: 'feature:omnia.recording/workbench' }]
  }
};
const surface = {
  schemaVersion: 'omnia.declarative-feature-surface/v1', featureId: 'omnia.recording', featureVersion: version,
  surfaceId: 'recording.workbench', stateVersion: 1, title: '录制',
  description: '像播放器一样控制当前 Pack 的真实录制；当前页面中的 GRA、Risk 与 Control 会由 Connector 自动识别和采集。',
  density: 'compact', status: 'idle', statusMessage: '连接 Pack 后开始录制；无需另点 Risk/Control 采集按钮。',
  scopes: [], items: [], selectedItemIds: [], search: '',
  recorder: {
    state: 'idle', recordingId: '', startedAt: '', updatedAt: '', elapsedMs: 0,
    eventCount: 0, interactionCount: 0, networkRequestCount: 0, riskCount: 0, controlCount: 0,
    captureState: 'idle', captureMessage: '开始录制后将自动采集当前页 Risk 与 Control。', exportAvailable: false
  },
  actions: [
    { actionId: 'refresh-status', label: '刷新真实状态', presentation: 'refresh', effect: 'read_only', enabled: true, reason: '', selectionMode: 'none' },
    { actionId: 'start-recording', label: '开始录制', presentation: 'record', effect: 'local_state_write', enabled: true, reason: '', selectionMode: 'none' },
    { actionId: 'pause-recording', label: '暂停', presentation: 'pause', effect: 'local_state_write', enabled: false, reason: '只有正在进行的录制可以暂停。', selectionMode: 'none' },
    { actionId: 'stop-recording', label: '停止', presentation: 'stop', effect: 'local_state_write', enabled: false, reason: '当前没有可停止的录制。', selectionMode: 'none' },
    { actionId: 'export-recording', label: '导出录制记录', presentation: 'export', effect: 'local_state_write', enabled: false, reason: '请先停止录制。', selectionMode: 'none' }
  ]
};
const migration = {
  schemaVersion: 'omnia.feature-private-migration/v1', namespace: 'recording', version: 1,
  tables: [{ name: 'recording_evidence_index', columns: [
    { name: 'evidence_id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'recording_id', type: 'TEXT', notNull: true, primaryKey: false },
    { name: 'kind', type: 'TEXT', notNull: true, primaryKey: false },
    { name: 'path', type: 'TEXT', notNull: true, primaryKey: false },
    { name: 'created_at', type: 'TEXT', notNull: true, primaryKey: false }
  ] }]
};
const featureDoc = (await readFile(path.join(source, 'docs', 'FEATURE.md'), 'utf8')).replaceAll('__FEATURE_VERSION__', version);
const implementationDoc = await readFile(path.join(source, 'docs', 'IMPLEMENTATION_MAP.md'));
const docs = [
  { path: 'docs/FEATURE.md', content: Buffer.from(featureDoc), purpose: 'product-safety-and-live-validation-contract' },
  { path: 'docs/IMPLEMENTATION_MAP.md', content: implementationDoc, purpose: 'four-plane-implementation-map' }
];
const featurePackage = envelope('omnia-feature', manifest.featureId, 'omnia-v5-official-feature-2026-01', featurePrivateKey, [
  file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'feature', keyId: 'omnia-v5-official-feature-2026-01' }, null, 2)),
  file('backend/migrations/001.json', JSON.stringify(migration, null, 2)),
  file('connector-capability/operation.ofop', JSON.stringify(operationPackage)),
  ...docs.map((doc) => file(doc.path, doc.content)),
  file('docs/manifest.json', JSON.stringify({ schemaVersion: 'omnia.feature-documentation/v1', featureId: manifest.featureId, featureVersion: version, documents: docs.map((doc) => ({ path: doc.path, sha256: sha256(doc.content), purpose: doc.purpose })) }, null, 2)),
  file('frontend/surface.json', JSON.stringify(surface, null, 2)),
  file('manifest.json', JSON.stringify(manifest, null, 2)),
  file('middle/worker.cjs', (await readFile(path.join(source, 'middle', 'worker.cjs'), 'utf8')).replaceAll('__FEATURE_VERSION__', version)),
  file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: manifest.featureId, version } }, components: [] }, null, 2))
]);
await mkdir(output, { recursive: true });
const filename = path.join(output, `recording-${version}.ofp`);
const serialized = JSON.stringify(featurePackage);
let current = ''; try { current = await readFile(filename, 'utf8'); } catch { }
if (current && current !== serialized) throw new Error(`Refusing to overwrite immutable Feature package: ${filename}`);
if (!current) await writeFile(filename, serialized, { flag: 'wx' });
console.log(`${path.relative(root, filename)} sha256:${sha256(Buffer.from(serialized))}`);
