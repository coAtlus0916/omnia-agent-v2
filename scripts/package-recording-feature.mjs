import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'feature-packages', 'recording', 'source');
const output = path.join(root, 'feature-packages', 'recording', 'candidates');
const version = '0.1.1';
const sequence = 2;
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
    groups: [{ id: 'other', parentId: null, level: 1, label: '其他', order: 10 }],
    leaves: [{ id: 'recording', parentId: 'other', level: 2, label: '录制', order: 10, featureId: 'omnia.recording', featureVersion: version, route: 'feature:omnia.recording/workbench' }]
  }
};
const surface = {
  schemaVersion: 'omnia.declarative-feature-surface/v1', featureId: 'omnia.recording', featureVersion: version,
  surfaceId: 'recording.workbench', stateVersion: 1, title: '录制',
  description: '记录当前 Pack 的真实浏览器交互和网络证据，并只读抓取当前 GRA 的完整 Risk/Control 目录。',
  density: 'compact', status: 'idle', statusMessage: '连接 Pack 后可开始详细录制；完整目录抓取要求当前页面已加载唯一目标 GRA。',
  scopes: [], items: [], selectedItemIds: [], search: '',
  actions: [
    { actionId: 'refresh-status', label: '刷新真实状态', effect: 'read_only', enabled: true, reason: '', selectionMode: 'none' },
    { actionId: 'start-recording', label: '开始详细录制', effect: 'local_state_write', enabled: true, reason: '', selectionMode: 'none' },
    { actionId: 'stop-export', label: '停止并导出', effect: 'local_state_write', enabled: false, reason: '当前没有正在进行的录制。', selectionMode: 'none' },
    { actionId: 'cancel-recording', label: '取消录制', effect: 'local_state_write', enabled: false, reason: '当前没有正在进行的录制。', selectionMode: 'none' },
    { actionId: 'capture-current-gra-catalog', label: '抓取当前 GRA Risk/Control 完整目录', effect: 'read_only', enabled: true, reason: '', selectionMode: 'none' }
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
