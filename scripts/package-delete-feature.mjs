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
          stepId: 'authority-directory',
          method: 'POST',
          routeTemplate: '/engagements/v1/facets/byEngagementIds',
          bodyMode: 'engagement_id_array'
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
        },
        {
          stepId: 'application-search', method: 'POST',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/applications/search', bodyMode: 'signed_json'
        },
        {
          stepId: 'infrastructure-search', method: 'POST',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/infrastructures/search', bodyMode: 'signed_json'
        },
        {
          stepId: 'tool-search', method: 'POST',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/search', bodyMode: 'signed_json'
        },
        {
          stepId: 'it-element-detail', method: 'GET',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none'
        },
        {
          stepId: 'it-element-facet-mapping', method: 'GET',
          routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none'
        },
        {
          stepId: 'it-element-blocking-relationships', method: 'POST',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/getBlockingRelationships', bodyMode: 'object_id_array'
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
        },
        {
          stepId: 'facet-mapping',
          method: 'GET',
          routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}',
          bodyMode: 'none'
        }
      ]
    },
    {
      operationId: 'omnia.delete.it-element.preflight.v1', effect: 'read_only',
      requestSchema: 'omnia.delete.it-element-preflight-request/v1', responseSchema: 'omnia.delete.it-element-preflight-response/v1',
      enabledByDefault: true,
      routes: [
        { stepId: 'it-element-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none' },
        { stepId: 'it-element-facet-mapping', method: 'GET', routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none' },
        { stepId: 'it-element-blocking-relationships', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/getBlockingRelationships', bodyMode: 'object_id_array' }
      ]
    },
    {
      operationId: 'omnia.delete.it-element.direct.v1', effect: 'omnia_mutation',
      requestSchema: 'omnia.delete.it-element-direct-request/v1', responseSchema: 'omnia.delete.it-element-direct-response/v1',
      enabledByDefault: false,
      routes: [{ stepId: 'it-element-soft-delete', method: 'PATCH', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}/softdelete', bodyMode: 'none' }]
    },
    {
      operationId: 'omnia.delete.it-element.reconcile.v1', effect: 'read_only',
      requestSchema: 'omnia.delete.it-element-reconcile-request/v1', responseSchema: 'omnia.delete.it-element-reconcile-response/v1',
      enabledByDefault: true,
      routes: [
        { stepId: 'it-element-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none' },
        { stepId: 'it-element-facet-mapping', method: 'GET', routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none' }
      ]
    },
    {
      operationId: 'omnia.delete.gra.preflight.v1', effect: 'read_only',
      requestSchema: 'omnia.delete.gra-preflight-request/v1', responseSchema: 'omnia.delete.gra-preflight-response/v1', enabledByDefault: true,
      routes: [
        { stepId: 'gra-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', bodyMode: 'none' },
        { stepId: 'gra-relationship', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/relationship/byWorkItemId/{workItemId}/workItemType/RiskFactorEvaluation', bodyMode: 'none' },
        { stepId: 'gra-delete-validation', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}/validate-riskfactor-evaluation?op=Delete', bodyMode: 'none' },
        { stepId: 'gra-controls', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/controls/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false', bodyMode: 'none' }
      ]
    },
    {
      operationId: 'omnia.delete.gra.direct.v1', effect: 'omnia_mutation',
      requestSchema: 'omnia.delete.gra-direct-request/v1', responseSchema: 'omnia.delete.gra-direct-response/v1', enabledByDefault: false,
      routes: [{ stepId: 'gra-soft-delete', method: 'PATCH', routeTemplate: '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}/softdelete', bodyMode: 'none' }]
    },
    {
      operationId: 'omnia.delete.gra.reconcile.v1', effect: 'read_only',
      requestSchema: 'omnia.delete.gra-reconcile-request/v1', responseSchema: 'omnia.delete.gra-reconcile-response/v1', enabledByDefault: true,
      routes: [{ stepId: 'gra-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', bodyMode: 'none' }]
    },
    {
      operationId: 'omnia.delete.infrastructure-application.preflight.v1', effect: 'read_only',
      requestSchema: 'omnia.delete.infrastructure-application-preflight-request/v1', responseSchema: 'omnia.delete.infrastructure-application-preflight-response/v1', enabledByDefault: true,
      routes: [
        { stepId: 'relation-object-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none' },
        { stepId: 'relation-facet-mapping', method: 'GET', routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none' },
        { stepId: 'relation-applications-search', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/applications/search', bodyMode: 'signed_json' },
        { stepId: 'relation-infrastructures-search', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/infrastructures/search', bodyMode: 'signed_json' }
      ]
    },
    {
      operationId: 'omnia.delete.infrastructure-application.disassociate.v1', effect: 'omnia_mutation',
      requestSchema: 'omnia.delete.infrastructure-application-disassociate-request/v1', responseSchema: 'omnia.delete.infrastructure-application-disassociate-response/v1', enabledByDefault: false,
      routes: [{ stepId: 'relation-disassociate', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/disassociate', bodyMode: 'signed_json' }]
    },
    {
      operationId: 'omnia.delete.infrastructure-application.reconcile.v1', effect: 'read_only',
      requestSchema: 'omnia.delete.infrastructure-application-reconcile-request/v1', responseSchema: 'omnia.delete.infrastructure-application-reconcile-response/v1', enabledByDefault: true,
      routes: [
        { stepId: 'relation-object-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none' },
        { stepId: 'relation-facet-mapping', method: 'GET', routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none' },
        { stepId: 'relation-applications-search', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/applications/search', bodyMode: 'signed_json' },
        { stepId: 'relation-infrastructures-search', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/infrastructures/search', bodyMode: 'signed_json' }
      ]
    }
  ].map((operation) => ({
    ...operation,
    grantsMutationPermit: ['omnia.delete.information.preflight.v1', 'omnia.delete.it-element.preflight.v1', 'omnia.delete.gra.preflight.v1', 'omnia.delete.infrastructure-application.preflight.v1'].includes(operation.operationId),
    ...(operation.operationId === 'omnia.delete.information.preflight.v1'
      ? { permitsOperationId: 'omnia.delete.information.direct.v1' }
      : operation.operationId === 'omnia.delete.it-element.preflight.v1'
        ? { permitsOperationId: 'omnia.delete.it-element.direct.v1' }
      : operation.operationId === 'omnia.delete.gra.preflight.v1'
        ? { permitsOperationId: 'omnia.delete.gra.direct.v1' }
      : operation.operationId === 'omnia.delete.infrastructure-application.preflight.v1'
        ? { permitsOperationId: 'omnia.delete.infrastructure-application.disassociate.v1' }
      : {}),
    routes: operation.routes.map((route) => {
      const routeTemplate = route.routeTemplate.replace(
        '{workspaceFacetType}',
        'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0'
      );
      const parameterNames = [...routeTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)]
        .map((match) => match[1])
        .filter((name) => name !== 'engagementId');
      if (route.bodyMode === 'single_id_array') parameterNames.push('informationId');
      if (route.bodyMode === 'object_id_array') parameterNames.push('objectId');
      if (route.bodyMode === 'engagement_id_array') parameterNames.push('engagementId');
      const parameters = [...new Set(parameterNames)]
        .map((name) => ({ name, type: 'guid' }));
      return {
        stepId: route.stepId,
        method: route.method,
        routeTemplate,
        parameters,
        bodyMode: ['single_id_array', 'object_id_array', 'engagement_id_array'].includes(route.bodyMode) ? 'parameter_array' : route.bodyMode,
        bodyParameter: route.bodyMode === 'single_id_array' ? 'informationId' : route.bodyMode === 'object_id_array' ? 'objectId' : route.bodyMode === 'engagement_id_array' ? 'engagementId' : ''
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
  const versionNote = version === '0.2.1'
    ? '0.2.1 增加 APP、DB、OS、TOOL 真实删除闭环，并将派生 GRA、GRA Control 级联快照及 DB/OS–APP 双向解关联作为独立 Core 图步骤冻结、确认、提交和读回。'
    : version === '0.2.0'
    ? '0.2.0 以声明式目录工作台恢复真实 Section、Workspace 与元素类型层级，提供当前权威快照搜索、复选多选和批量选择；计划确认、执行与终态仍只由 Comments 消息卡持有。'
    : version === '0.1.5'
    ? '0.1.5 将 0.1.4 的 Omnia 权威 Section 全局关联安全范围纳入 Shell builtin 自动升级；删除目标仍必须命中显式 Workspace 锁，Section 展开结果随安全快照冻结。'
    : version === '0.1.3'
      ? '0.1.3 修正 Workspace Facet 权威类型为 v4 已验证值；其余删除范围与 0.1.2 相同。'
    : '0.1.2 接通 Shell 0.4.0 Local 运行时、签名 Operation handler、真实重抓取/单选/右侧确认、一次性 permit、持久证据与写后读回；对象范围仍仅为单个零 blocker Information。';
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
    minimumShellVersion: ['0.2.0','0.2.1'].includes(version) ? '0.4.12' : version === '0.1.5' ? '0.4.10' : '0.4.0',
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
    status: 'loading',
    statusMessage: '正在核对当前 Remote Connector、Pack 与安全锁状态。',
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
        selectionMode: 'none',
        dependencies: ['remote_connector', 'safety_lock']
      },
      {
        actionId: 'create-delete-plan',
        label: '创建删除计划',
        effect: 'local_state_write',
        enabled: true,
        reason: '',
        selectionMode: 'multiple',
        dependencies: ['remote_connector', 'safety_lock']
      }
    ],
    selectionBrowser: {
      schemaVersion: 'omnia.declarative-selection-browser/v1',
      hierarchyLabel: '所在部分 / Workspace / 元素类型',
      resultsLabel: '当前权威目录',
      searchPlaceholder: '搜索编号、名称、类型或权威 ID',
      emptyMessage: '当前范围没有可显示的元素',
      allScopesLabel: '全部当前范围',
      selectVisibleLabel: '全选当前可选结果',
      clearSelectionLabel: '取消选择当前结果',
      footerActionIds: ['refresh-authoritative-catalog', 'create-delete-plan'],
      primaryActionId: 'create-delete-plan'
    }
  };
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
results.push(await buildVersion('0.2.1', 8));
for (const result of results) console.log(`${path.relative(root, result.filename)} ${result.digest}`);
