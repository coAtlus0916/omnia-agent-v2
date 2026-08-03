import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'feature-packages', 'delete-elements', 'source');
const output = path.join(root, 'feature-packages', 'delete-elements', 'candidates');
const signingRoot = process.env.OMNIA_V5_SIGNING_ROOT
  || path.join(process.env.USERPROFILE || '', '.omnia-agent-v5', 'signing');
const featurePrivateKey = await readFile(path.join(signingRoot, 'feature-ed25519-private.pem'), 'utf8');
const operationPrivateKey = await readFile(path.join(signingRoot, 'operation-ed25519-private.pem'), 'utf8');

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot sign a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Cannot sign a non-JSON value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function file(pathname, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    path: pathname,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    contentBase64: bytes.toString('base64')
  };
}

function envelope({ product, packageId, version, sequence, keyId, privateKey, files }) {
  const unsigned = {
    schemaVersion: 'omnia.official-package-envelope/v1',
    product,
    packageId,
    version,
    sequence,
    publisher: { keyId, algorithm: 'Ed25519' },
    files: [...files].sort((left, right) => left.path.localeCompare(right.path))
  };
  const signature = crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64');
  return { ...unsigned, signature };
}

function operationDescriptors() {
  return [
    {
      operationId: 'omnia.delete.scope.read.v1',
      effect: 'read_only',
      requestSchema: 'omnia.delete.scope-read-request/v1',
      responseSchema: 'omnia.delete.scope-read-response/v1',
      enabledByDefault: true,
      routes: [
        {
          stepId: 'pack-hierarchy',
          method: 'GET',
          routeTemplate: '/engagements/v1/{engagementId}/headers/hierarchy',
          bodyMode: 'none'
        },
        {
          stepId: 'workspace-sections',
          method: 'GET',
          routeTemplate: '/work/v1/engagements/{engagementId}/liveindex/menu/sections',
          bodyMode: 'none'
        },
        {
          stepId: 'workspace-facets',
          method: 'GET',
          routeTemplate: '/engagements/v1/engagements/{engagementId}/facets/byFacetType/{workspaceFacetType}/?includeDeleted=true',
          bodyMode: 'none'
        }
      ]
    },
    {
      operationId: 'omnia.delete.catalog.heavy-read.v1',
      effect: 'read_only',
      requestSchema: 'omnia.delete.catalog-heavy-read-request/v1',
      responseSchema: 'omnia.delete.catalog-heavy-read-response/v1',
      enabledByDefault: true,
      routes: [
        {
          stepId: 'information-collection',
          method: 'GET',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/information',
          bodyMode: 'none'
        },
        {
          stepId: 'information-detail',
          method: 'GET',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/information/{informationId}',
          bodyMode: 'none'
        },
        {
          stepId: 'work-item',
          method: 'GET',
          routeTemplate: '/work/v1/engagements/{engagementId}/workitems/{workItemId}',
          bodyMode: 'none'
        },
        {
          stepId: 'facet-mapping',
          method: 'GET',
          routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}',
          bodyMode: 'none'
        },
        {
          stepId: 'blocking-relationships',
          method: 'POST',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/information/getblockingrelationships',
          bodyMode: 'single_id_array'
        }
      ]
    },
    {
      operationId: 'omnia.delete.information.preflight.v1',
      effect: 'read_only',
      requestSchema: 'omnia.delete.information-preflight-request/v1',
      responseSchema: 'omnia.delete.information-preflight-response/v1',
      enabledByDefault: true,
      routes: [
        {
          stepId: 'information-detail',
          method: 'GET',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/information/{informationId}',
          bodyMode: 'none'
        },
        {
          stepId: 'work-item',
          method: 'GET',
          routeTemplate: '/work/v1/engagements/{engagementId}/workitems/{workItemId}',
          bodyMode: 'none'
        },
        {
          stepId: 'facet-mapping',
          method: 'GET',
          routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}',
          bodyMode: 'none'
        },
        {
          stepId: 'blocking-relationships',
          method: 'POST',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/information/getblockingrelationships',
          bodyMode: 'single_id_array'
        }
      ]
    },
    {
      operationId: 'omnia.delete.information.direct.v1',
      effect: 'omnia_mutation',
      requestSchema: 'omnia.delete.information-direct-request/v1',
      responseSchema: 'omnia.delete.information-direct-response/v1',
      enabledByDefault: false,
      routes: [
        {
          stepId: 'soft-delete',
          method: 'PATCH',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/information/{informationId}/softDelete',
          bodyMode: 'none'
        }
      ]
    },
    {
      operationId: 'omnia.delete.information.reconcile.v1',
      effect: 'read_only',
      requestSchema: 'omnia.delete.information-reconcile-request/v1',
      responseSchema: 'omnia.delete.information-reconcile-response/v1',
      enabledByDefault: true,
      routes: [
        {
          stepId: 'information-detail',
          method: 'GET',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/information/{informationId}',
          bodyMode: 'none'
        }
      ]
    }
  ].map((operation) => ({
    ...operation,
    grantsMutationPermit: operation.operationId === 'omnia.delete.information.preflight.v1',
    routes: operation.routes.map((route) => {
      const routeTemplate = route.routeTemplate.replace(
        '{workspaceFacetType}',
        '8dba1267-9c45-4d88-a2e3-a1619bd905c2'
      );
      const parameterNames = [...routeTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)]
        .map((match) => match[1])
        .filter((name) => name !== 'engagementId');
      if (route.bodyMode === 'single_id_array') parameterNames.push('informationId');
      const parameters = [...new Set(parameterNames)]
        .map((name) => ({ name, type: 'guid' }));
      return {
        stepId: route.stepId,
        method: route.method,
        routeTemplate,
        parameters,
        bodyMode: route.bodyMode === 'single_id_array' ? 'parameter_array' : 'none',
        bodyParameter: route.bodyMode === 'single_id_array' ? 'informationId' : ''
      };
    })
  }));
}

async function buildVersion(version, sequence) {
  const operations = operationDescriptors();
  const operationManifest = {
    schemaVersion: 'omnia.connector-operation-manifest/v1',
    packageId: 'omnia.delete-elements.operation',
    version,
    sequence,
    featureId: 'omnia.delete-elements',
    operations
  };
  const operationPolicy = {
    schemaVersion: 'omnia.connector-operation-policy/v1',
    packageId: operationManifest.packageId,
    operationDigests: Object.fromEntries(operations.map((operation) => [
      operation.operationId,
      sha256(Buffer.from(JSON.stringify(operation)))
    ]))
  };
  const operationDocs = (await readFile(path.join(source, 'docs', 'OPERATION.md'), 'utf8'))
    .replaceAll('__FEATURE_VERSION__', version);
  const operationPackage = envelope({
    product: 'omnia-connector-operation',
    packageId: operationManifest.packageId,
    version,
    sequence,
    keyId: 'omnia-v5-official-operation-2026-01',
    privateKey: operationPrivateKey,
    files: [
      file('SIGNATURE.json', JSON.stringify({
        schemaVersion: 'omnia.package-signature-metadata/v1',
        scope: 'connector-operation',
        keyId: 'omnia-v5-official-operation-2026-01'
      }, null, 2)),
      file('docs/OPERATION.md', operationDocs),
      file('manifest.json', JSON.stringify(operationManifest, null, 2)),
      file('operation/handler.cjs', await readFile(path.join(source, 'connector-capability', 'operation', 'handler.cjs'))),
      file('operation/policy.json', JSON.stringify(operationPolicy, null, 2)),
      file('sbom.json', JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        metadata: {
          component: { type: 'application', name: operationManifest.packageId, version }
        },
        components: []
      }, null, 2))
    ]
  });
  const versionNote = '0.1.2 接通 Shell 0.4.0 Local 运行时、签名 Operation handler、真实重抓取/单选/右侧确认、一次性 permit、持久证据与写后读回；对象范围仍仅为单个零 blocker Information。';
  const featureDocs = (await readFile(path.join(source, 'docs', 'FEATURE.md'), 'utf8'))
    .replaceAll('__FEATURE_VERSION__', version)
    .replaceAll('__VERSION_NOTE__', versionNote);
  const implementationMap = (await readFile(path.join(source, 'docs', 'IMPLEMENTATION_MAP.md'), 'utf8'))
    .replaceAll('__FEATURE_VERSION__', version);
  const documentationFiles = [
    { path: 'docs/FEATURE.md', bytes: Buffer.from(featureDocs), purpose: 'product-and-safety-contract' },
    { path: 'docs/IMPLEMENTATION_MAP.md', bytes: Buffer.from(implementationMap), purpose: 'four-plane-implementation-map' }
  ];
  const documentationManifest = {
    schemaVersion: 'omnia.feature-documentation/v1',
    featureId: 'omnia.delete-elements',
    featureVersion: version,
    documents: documentationFiles.map((document) => ({
      path: document.path,
      sha256: sha256(document.bytes),
      purpose: document.purpose
    }))
  };
  const featureManifest = {
    schemaVersion: 'omnia.feature-manifest/v1',
    featureId: 'omnia.delete-elements',
    version,
    sequence,
    displayName: '删除元素',
    minimumShellVersion: '0.4.0',
    requiredIsolation: 'process',
    storeNamespace: 'delete_elements',
    migrationPath: 'backend/migrations/001.json',
    surfacePath: 'frontend/surface.json',
    workerPath: 'middle/worker.cjs',
    operationPackagePath: 'connector-capability/operation.ofop',
    navigation: {
      groups: [
        { id: 'other', parentId: null, level: 1, label: '其他', order: 90 }
      ],
      leaves: [
        {
          id: 'delete-elements',
          parentId: 'other',
          level: 2,
          label: '删除元素',
          order: 10,
          featureId: 'omnia.delete-elements',
          featureVersion: version,
          route: 'feature:omnia.delete-elements/workbench'
        }
      ]
    }
  };
  const surface = {
    schemaVersion: 'omnia.declarative-feature-surface/v1',
    featureId: 'omnia.delete-elements',
    featureVersion: version,
    surfaceId: 'delete-elements.workbench',
    stateVersion: 1,
    title: '删除元素',
    description: '仅处理安全锁范围内、经权威重抓取与二次预检确认的元素。',
    density: 'compact',
    status: 'idle',
    statusMessage: '候选包已安装；Windows 强隔离和当前 Omnia canary 尚未认证，运行与写入保持禁用。',
    scopes: [],
    items: [],
    selectedItemIds: [],
    search: '',
    actions: [
      {
        actionId: 'refresh-authoritative-catalog',
        label: '权威重抓取',
        effect: 'read_only',
        enabled: true,
        reason: '',
        selectionMode: 'none'
      },
      {
        actionId: 'create-delete-plan',
        label: '创建删除计划',
        effect: 'local_state_write',
        enabled: true,
        reason: '',
        selectionMode: 'single'
      }
    ]
  };
  surface.statusMessage = '连接 Pack 并启用安全锁后，执行权威重抓取。';
  const migration = {
    schemaVersion: 'omnia.feature-private-migration/v1',
    namespace: 'delete_elements',
    version: 1,
    tables: [
      {
        name: 'delete_elements_plans',
        columns: [
          { name: 'plan_id', type: 'TEXT', notNull: true, primaryKey: true },
          { name: 'state', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'plan_digest', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'payload_json', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'updated_at', type: 'TEXT', notNull: true, primaryKey: false }
        ]
      },
      {
        name: 'delete_elements_evidence',
        columns: [
          { name: 'evidence_id', type: 'TEXT', notNull: true, primaryKey: true },
          { name: 'plan_id', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'checkpoint', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'payload_json', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'occurred_at', type: 'TEXT', notNull: true, primaryKey: false }
        ]
      },
      {
        name: 'delete_elements_managed_content',
        columns: [
          { name: 'object_id', type: 'TEXT', notNull: true, primaryKey: true },
          { name: 'object_type', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'status', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'tombstone_at', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'plan_id', type: 'TEXT', notNull: true, primaryKey: false }
        ]
      }
    ]
  };
  let worker = await readFile(path.join(source, 'middle', 'worker.cjs'), 'utf8');
  worker = worker
    .replaceAll('__FEATURE_VERSION__', version)
    .replaceAll(
      '__HEALTH_OBSERVABILITY__',
      version === '0.1.1' ? ",\n      observabilityContract: 'checkpoint-v1'" : ''
    );
  const featurePackage = envelope({
    product: 'omnia-feature',
    packageId: featureManifest.featureId,
    version,
    sequence,
    keyId: 'omnia-v5-official-feature-2026-01',
    privateKey: featurePrivateKey,
    files: [
      file('SIGNATURE.json', JSON.stringify({
        schemaVersion: 'omnia.package-signature-metadata/v1',
        scope: 'feature',
        keyId: 'omnia-v5-official-feature-2026-01'
      }, null, 2)),
      file('backend/migrations/001.json', JSON.stringify(migration, null, 2)),
      file('connector-capability/operation.ofop', JSON.stringify(operationPackage)),
      file('docs/FEATURE.md', featureDocs),
      file('docs/IMPLEMENTATION_MAP.md', implementationMap),
      file('docs/manifest.json', JSON.stringify(documentationManifest, null, 2)),
      file('frontend/surface.json', JSON.stringify(surface, null, 2)),
      file('manifest.json', JSON.stringify(featureManifest, null, 2)),
      file('middle/worker.cjs', worker),
      file('sbom.json', JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        metadata: {
          component: { type: 'application', name: featureManifest.featureId, version }
        },
        components: []
      }, null, 2))
    ]
  });
  await mkdir(output, { recursive: true });
  const filename = path.join(output, `delete-elements-${version}.ofp`);
  const serialized = JSON.stringify(featurePackage);
  let existing = null;
  try { existing = await readFile(filename, 'utf8'); } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  if (existing !== null && existing !== serialized) {
    throw new Error(`Refusing to overwrite immutable Feature package: ${filename}`);
  }
  if (existing === null) await writeFile(filename, serialized, { flag: 'wx' });
  const { signature: _signature, ...unsignedFeaturePackage } = featurePackage;
  void _signature;
  return { filename, digest: `sha256:${sha256(Buffer.from(canonical(unsignedFeaturePackage)))}` };
}

const results = [];
results.push(await buildVersion('0.1.2', 3));
for (const result of results) console.log(`${path.relative(root, result.filename)} ${result.digest}`);
