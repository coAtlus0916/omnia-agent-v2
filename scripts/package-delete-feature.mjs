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
          stepId: 'gra-workitem-index',
          method: 'POST',
          routeTemplate: '/work/v1/WorkQueries/getWorkitemDetails',
          bodyMode: 'signed_json'
        },
        {
          stepId: 'gra-common-account-index',
          method: 'POST',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/riskassessments/commonAccounts',
          bodyMode: 'signed_json'
        },
        {
          stepId: 'gra-catalog-detail',
          method: 'GET',
          routeTemplate: '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}',
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
          stepId: 'tool-relation-search', method: 'POST',
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
        { stepId: 'it-element-blocking-relationships', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/getBlockingRelationships', bodyMode: 'object_id_array' },
        { stepId: 'preflight-tool-search', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/search', bodyMode: 'signed_json' },
        { stepId: 'preflight-tool-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none' },
        { stepId: 'preflight-tool-facet-mapping', method: 'GET', routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none' },
        { stepId: 'preflight-tool-relation-search', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/search', bodyMode: 'signed_json' },
        { stepId: 'preflight-partner-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none' },
        { stepId: 'preflight-partner-facet-mapping', method: 'GET', routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none' }
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
        { stepId: 'risk-catalog', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false', bodyMode: 'none' },
        { stepId: 'control-catalog', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/controls/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false', bodyMode: 'none' },
        { stepId: 'risk-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/plannedresponse/GetPlanResponseDetailByRiskRiskScopeId?riskriskScopeId={riskRiskScopeId}&reviewMode=false&controlExpanded=false&procedureExpanded=false', bodyMode: 'none' }
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
      routes: [
        { stepId: 'gra-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', bodyMode: 'none' },
        { stepId: 'risk-catalog', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false', bodyMode: 'none' },
        { stepId: 'control-catalog', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/controls/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false', bodyMode: 'none' },
        { stepId: 'risk-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/plannedresponse/GetPlanResponseDetailByRiskRiskScopeId?riskriskScopeId={riskRiskScopeId}&reviewMode=false&controlExpanded=false&procedureExpanded=false', bodyMode: 'none' }
      ]
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
    },
    {
      operationId: 'omnia.delete.it-tool-application.preflight.v1', effect: 'read_only',
      requestSchema: 'omnia.delete.it-tool-application-preflight-request/v1', responseSchema: 'omnia.delete.it-tool-application-preflight-response/v1', enabledByDefault: true,
      routes: [
        { stepId: 'relation-object-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none' },
        { stepId: 'relation-facet-mapping', method: 'GET', routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none' },
        { stepId: 'relation-tool-search', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/search', bodyMode: 'signed_json' }
      ]
    },
    {
      operationId: 'omnia.delete.it-tool-application.disassociate.v1', effect: 'omnia_mutation',
      requestSchema: 'omnia.delete.it-tool-application-disassociate-request/v1', responseSchema: 'omnia.delete.it-tool-application-disassociate-response/v1', enabledByDefault: false,
      routes: [{ stepId: 'relation-disassociate', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/disassociate', bodyMode: 'signed_json' }]
    },
    {
      operationId: 'omnia.delete.it-tool-application.reconcile.v1', effect: 'read_only',
      requestSchema: 'omnia.delete.it-tool-application-reconcile-request/v1', responseSchema: 'omnia.delete.it-tool-application-reconcile-response/v1', enabledByDefault: true,
      routes: [
        { stepId: 'relation-object-detail', method: 'GET', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', bodyMode: 'none' },
        { stepId: 'relation-facet-mapping', method: 'GET', routeTemplate: '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', bodyMode: 'none' },
        { stepId: 'relation-tool-search', method: 'POST', routeTemplate: '/rapr/v0/engagements/{engagementId}/itelement/search', bodyMode: 'signed_json' }
      ]
    }
  ].map((operation) => ({
    ...operation,
    grantsMutationPermit: ['omnia.delete.information.preflight.v1', 'omnia.delete.it-element.preflight.v1', 'omnia.delete.gra.preflight.v1', 'omnia.delete.infrastructure-application.preflight.v1', 'omnia.delete.it-tool-application.preflight.v1'].includes(operation.operationId),
    ...(operation.operationId === 'omnia.delete.information.preflight.v1'
      ? { permitsOperationId: 'omnia.delete.information.direct.v1' }
      : operation.operationId === 'omnia.delete.it-element.preflight.v1'
        ? { permitsOperationId: 'omnia.delete.it-element.direct.v1' }
      : operation.operationId === 'omnia.delete.gra.preflight.v1'
        ? { permitsOperationId: 'omnia.delete.gra.direct.v1' }
      : operation.operationId === 'omnia.delete.infrastructure-application.preflight.v1'
        ? { permitsOperationId: 'omnia.delete.infrastructure-application.disassociate.v1' }
      : operation.operationId === 'omnia.delete.it-tool-application.preflight.v1'
        ? { permitsOperationId: 'omnia.delete.it-tool-application.disassociate.v1' }
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
  const versionNote = version === '0.3.20'
    ? '0.3.20 将真实权威目录工作台声明为固定状态/动作底栏与双独立滚动目录列：底栏只显示同一后端 Surface 投影的状态、已选数和已声明 action；窗口收窄后目录列受控上下重排。该布局是通用 selectionBrowser 合同，不按 Feature ID 硬编码，不引入前端业务状态或 Comments。'
    : version === '0.3.19'
    ? '0.3.19 将对象预检完成后的纯删除准备图编译迁入 release 内置 CPython 3.13.14：输入仅为最多 200 个已验证目标和对象预检，输出仅为确定性的 GRA seeds、关系描述和依赖骨架。Worker 对完整集合、ID、Workspace、排序、上限与 digest 再次严格复核后才保存 checkpoint；Python 缺失、失败或输出篡改均 fail-close，且没有 JS fallback。Operation、Store/CAS、Core intent、确认、mutation、receipt、readback 与 reconcile 仍留在 Worker/Core，v4 仅复用 single-flight 与有界纯调度，不迁移 mutation 并发。'
    : version === '0.3.18'
    ? '0.3.18 将删除计划冻结改为可恢复的分阶段 checkpoint：创建 action 只消费两分钟内、精确绑定当前 Connector 与安全锁的权威目录快照，快速创建 ready_for_review Core Run 和 preparing 私有计划；隐藏 background action 每次最多完成 8 个同类只读预检，完整批次成功后才原子推进游标。对象、派生 GRA、关系组完成后才一次 prepareReturnIntent 并进入 pending_confirmation。失败批次不部分落盘、不推进，显式重试只重做该只读批次；preparing 取消使用 ready_for_review 精确 revision CAS。确认前 mutation 始终为 0。'
    : version === '0.3.17'
    ? '0.3.17 移除 Delete Worker 最后一条旧 0.3.14 pending 计划迁移时的 Comments 终态投影。迁移仍精确执行一次 returnRunToReview 与一次 Core 关闭、且不调用任何 Operation 或 mutation，但 action 只返回 cancelled/skipped 的 Feature Surface patch。历史 0.3.14 Comments 卡由 package-manager 的 activation-head feature_version join 过滤，不由新 Feature 写卡清理。minimumShellVersion 保持 0.4.15。'
    : version === '0.3.16'
    ? '0.3.16 在同一保留 Delete Surface 从 closed 变为 open 时重新读取当前 Connector authority、安全锁和 Pack 目录，绝不使用历史目录快照。pending_confirmation、executing 或 uncertain 冻结计划只会在读取后重新投影；读取失败时保留计划并失败关闭，pending 仅保留本地取消。绝不自动创建、确认、执行或核验删除。该生命周期需要 Shell 0.4.15，当前 0.4.14 release 不安装此候选。'
    : version === '0.3.15'
    ? '0.3.15 将删除计划的确认、执行、只读核验和结果全部投影到 Delete Feature 工作台，新计划不再写 Comments；旧 0.3.14 pending Comments 计划只允许一次迁移取消。156 项对象/GRA 预检采用峰值 8 的有界并发并保持确定性顺序。同一 relationType + source 的完整 APP 目标集冻结为一个关系组、一次 source-tab token、一次批量 disassociate 与逐端点读回。'
    : version === '0.3.14'
    ? '0.3.14 的 GRA 级联预检仅冻结删除所需的 Risk、Control 与 Risk-Control 精确远端身份，不再错误要求 create-associate assertion 元数据；删除后仍逐项证明冻结级联全部缺席。'
    : version === '0.3.13'
    ? '0.3.13 移除签名 Operation 对 CommonJS require/node:crypto 的运行时依赖，使用包内确定性 SHA-256 校验 GRA cascade snapshot；真实 Connector sandbox 可直接加载，同时保留 0.3.12 的空 tenant 与 DB/OS/Network 类型识别修复。'
    : version === '0.3.12'
    ? '0.3.12 修复真实 Remote Workspace 的 tenantOrOrgId 合法为空时被 Delete Feature 误判为非法输入，并从 indexed/detail 全部语义字段一致识别 DB、OS 与 Network；opaque typeId 不再遮蔽真实 subtype，冲突仍失败关闭。'
    : version === '0.3.11'
    ? '0.3.11 保存空 tenant authority 修复，但候选包自检仍引用旧类型分类源码文本，未作为可用运行版本启动。'
    : version === '0.3.10'
    ? '0.3.10 修复权威读取超时后的同范围重抓取假等待：底层请求仍在收尾时立即投影 busy，不再挂满第二轮 90 秒，也不启动并发扫描；旧读取结束后才允许新的真实读取。'
    : version === '0.3.9'
    ? '0.3.9 修复权威目录首次加载长期停留：真实 detail 已精确证明安全锁外 Workspace 后，跳过该对象后续 Facet/blocker 重读；锁内对象仍完整读取。交互式目录读取 90 秒有界失败并显示可重抓取错误，不展示缓存或假目录，也不并发启动不同授权范围的扫描。'
    : version === '0.3.8'
    ? '0.3.8 修复 Core 失败终态响应不确定时的真实状态：进入 core_terminal 只读核验，仅重试 finishReturn 或读取同一 Run；未权威证明 Core failed 前不显示本地失败，且绝不重放 mutation。包含 0.3.7 混合 Infrastructure 目录修复。真实 Pack canary 未完成前不声称稳定上线。'
    : version === '0.3.7'
    ? '0.3.7 让混合 Infrastructure 目录只排除明确不支持的 subtype，避免其拖垮 APP/DB/OS/DCNO/Tool 整批真实目录；缺失或模糊 subtype 仍失败关闭。新增 TEST 六类混合计划合同，验证关系优先、二次确认、参数化 Python 图与确定性删除顺序。真实 Pack canary 未完成前不声称稳定上线。'
    : version === '0.3.6'
    ? '0.3.6 将 Infrastructure/Network 作为 DCNO 参数接入现有 IT Element 删除合同：与 DB/OS 共用 InfrastructureApplication tab 602 预检、解除和双向读回，并共用一次 softdelete + detail/Workspace 读回。Python 仍只调度参数化图，未增加 DCNO 分支引擎。真实 TEST Pack canary 未完成前不声称稳定上线。'
    : version === '0.3.5'
    ? '0.3.5 修正声明式目录 item 合同，并把 Infrastructure/Network 权威规范化为只读 DCNO。DCNO 类型和条目明确禁用；Worker 计划入口与 Operation preflight 双重拒绝其 mutation，不借用 OS 合同。目录存在 DCNO 不再阻断 GRA/APP/DB/OS/Tool 的真实加载。'
    : version === '0.3.4'
    ? '0.3.4 将 v4 已实跑的 GRA 双索引、assessment/relationship/delete-validator、单次 softdelete 与严格 readback 合同接入独立选择；独立/派生 GRA 合并为同一 cascade step。所有图步骤终止后再次读取当前 Connector authority 与真实 Pack catalog；只有所有 readback-verified 对象及 GRA 根均从最终目录消失才关闭 Core Run。目录矛盾、authority/safety 漂移或最终读取失败进入只读 final-catalog reconcile，不重放任何 mutation。'
    : version === '0.3.3'
    ? '0.3.3 接受 Omnia 非零 .NET GUID 而不误加 RFC version/variant 约束；权威目录拒绝跨 Engagement、空/重复/非法 Workspace scope 与重复 Section/Workspace identity。Python 调度器拆分为输入、图、outcome 与 dependency 单责函数；Worker 在确认已批准后的 authority 失败时可靠关闭 Run，并区分 command prepare 与 request evidence 失败。'
    : version === '0.3.2'
    ? '0.3.2 严格校验权威目录 Engagement、2000 项上限与重复/跨类型身份；保存 Core confirmation expiresAt，并在取消、过期、目录或整图漂移时通过 returnRunToReview 原子失效 Confirmation 和 frozen intents。终态卡只投影真实 outcome、对象 ID、错误码与原因。'
    : version === '0.3.1'
    ? '0.3.1 使用发布托管 CPython 3.13.14 对冻结删除图和持久结果账本做纯确定性调度；Worker 仍独占 Core Run、一次性确认、签名 Operation、证据、投影和只读调和。首次目录读取自动执行；提交前已知失败按依赖隔离，任何已提交或结果不确定步骤立即停批且绝不重放。'
    : version === '0.3.0'
    ? '0.3.0 冻结并先解除 InfrastructureApplication 与 ItToolApplication 完整关系图；Tool→APP 使用已录制的 tab 802 合同。GRA 只提交一次 soft delete，并以完整 Risk、Control、Risk-Control 冻结快照做权威只读调和与 Core 级联投影。'
    : version === '0.2.1'
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
  const pythonMemberPaths = ['python/engine.py'];
  const runtimeContract = {
    schemaVersion: 'omnia.feature-runtime-contract/v1',
    featureId: 'omnia.delete-elements',
    featureVersion: version,
    inputs: ['connector_binding', 'workspace_safety', 'authoritative_catalog_selection', 'delete_confirmation', 'read_only_reconcile'],
    outputs: ['surface_patch', 'durable_outcome_ledger', 'verified_deletion_projection', 'authoritative_final_catalog_verification'],
    events: ['workspace.authoritative_refresh_requested', 'return.reconcile_resolved', 'return.reconcile_not_applied'],
    errors: ['DELETE.*', 'PYTHON.*', 'CONNECTOR.RESPONSE_LOST'],
    storePorts: ['savePlan', 'loadPlan', 'createMutationRun', 'prepareReturnIntent', 'approveReturnIntent', 'validateReturnAuthority',
      'returnRunToReview', 'prepareDeletionCommand', 'freezeReturnEvidenceSpec', 'recordReturnEvidence', 'projectVerifiedDeletion',
      'projectVerifiedDeletionCascade', 'loadLatestRun', 'transitionRun', 'finishReturn'],
    pythonSidecar: {
      schemaVersion: 'omnia.python-sidecar-runtime/v1', implementation: 'cpython', version: '3.13.14', architecture: 'win32-x64',
      protocol: 'omnia.python-sidecar-rpc/v1', bridgePath: 'middle/python-bridge.cjs', entryPath: 'python/engine.py', members: pythonMemberPaths,
      maxFrameBytes: 1024 * 1024, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 15000
    }
  };
  const implementationContract = {
    schemaVersion: 'omnia.feature-implementation-map/v1', featureId: 'omnia.delete-elements', featureVersion: version,
    planes: {
      surface: ['frontend/surface.json'], worker: ['middle/worker.cjs', 'middle/python-bridge.cjs', ...pythonMemberPaths],
      store: ['backend/migrations/001.json', 'contracts/feature-runtime.json'], connector: ['connector-capability/operation.ofop']
    },
    operations: operations.map(({ operationId, effect }) => ({ operationId, effect }))
  };
  const testIds = ['package-structure-static-check', 'final-authoritative-catalog-absence', 'signed-operation-readback-contract', 'recorded-gra-deletion-contract', 'dcno-parameterized-delete-contract', 'mixed-type-authoritative-catalog', 'core-terminal-truthfulness', 'bounded-authoritative-catalog-loading',
    'feature-local-delete-plan-surface', 'bounded-plan-preflight-concurrency', 'staged-plan-preparation-checkpoint', 'grouped-relation-mutation-readback', 'reopen-authoritative-catalog', 'no-comments-projection',
    'managed-python-preparation-compiler', 'compiler-output-tamper-fail-close'];
  const testVectors = { schemaVersion: 'omnia.feature-test-vectors/v1', featureId: 'omnia.delete-elements',
    vectors: testIds.map((testId) => ({ testId, inputRef: 'tests/self-test.cjs', expected: 'pass' })) };
  const testsManifest = { schemaVersion: 'omnia.feature-tests-manifest/v1', featureId: 'omnia.delete-elements', featureVersion: version,
    testIds, vectorsPath: 'tests/vectors.json', selfTestPath: 'tests/self-test.cjs', status: 'declared',
    command: 'node tests/self-test.cjs' };
  const selfTest = `'use strict';\nconst fs=require('node:fs'),path=require('node:path');\nconst root=path.resolve(__dirname,'..');\nconst manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));\nconst runtime=JSON.parse(fs.readFileSync(path.join(root,'contracts','feature-runtime.json'),'utf8'));\nconst implementation=JSON.parse(fs.readFileSync(path.join(root,'contracts','implementation-map.json'),'utf8'));\nconst vectors=JSON.parse(fs.readFileSync(path.join(root,'tests','vectors.json'),'utf8'));\nconst surface=JSON.parse(fs.readFileSync(path.join(root,'frontend','surface.json'),'utf8'));\nconst graFixture=JSON.parse(fs.readFileSync(path.join(root,'tests','fixtures','gra-delete-v4-live-contract.json'),'utf8'));\nconst engine=fs.readFileSync(path.join(root,'python','engine.py'),'utf8');\nconst worker=require(path.join(root,'middle','worker.cjs'));\nif(manifest.featureId!=='omnia.delete-elements'||manifest.version!=='${version}'||runtime.pythonSidecar?.version!=='3.13.14'||runtime.pythonSidecar?.members?.join(',')!=='python/engine.py')throw new Error('signed runtime identity failed');\nif(!implementation.planes?.worker?.includes('middle/python-bridge.cjs')||vectors.vectors?.length!==4||!vectors.vectors?.some((item)=>item.testId==='final-authoritative-catalog-absence')||!vectors.vectors?.some((item)=>item.testId==='signed-operation-readback-contract')||!vectors.vectors?.some((item)=>item.testId==='recorded-gra-deletion-contract')||graFixture.liveRun?.deletedCount!==40||graFixture.liveRun?.allItemsVerified!==true||surface.status!=='loading'||surface.actions?.find((item)=>item.actionId==='bootstrap-authoritative-catalog')?.presentation!=='background')throw new Error('deletion package declaration failed');\nif(!engine.includes('schedule_deletion')||!engine.includes('DELETE.SCHEDULER_DEADLOCK')||!engine.includes('normalize_steps')||!engine.includes('normalize_outcomes'))throw new Error('pure scheduler inventory failed');\nconst verified=worker.finalCatalogVerification({steps:[{key:'cascade:g1',kind:'cascade',objectType:'GRA',objectId:'g1'},{key:'object:app-1',kind:'object',objectType:'APP',objectId:'app-1'}],outcomes:[{stepId:'cascade:g1',state:'succeeded'},{stepId:'object:app-1',state:'succeeded'}]},[],'2026-01-01T00:00:00.000Z');\nif(verified.verifiedAbsentTargetIds?.join(',')!=='APP|app-1,GRA|g1')throw new Error('final authoritative absence contract failed');\nlet contradiction=false;try{worker.finalCatalogVerification({steps:[{key:'cascade:g1',kind:'cascade',objectType:'GRA',objectId:'g1'}],outcomes:[{stepId:'cascade:g1',state:'succeeded'}]},[{identity:'GRA|g1',raw:{objectType:'GRA',objectId:'g1'}}]);}catch(error){contradiction=error?.code==='DELETE.FINAL_CATALOG_CONTRADICTION';}if(!contradiction)throw new Error('final authoritative contradiction must fail closed');\nprocess.stdout.write('omnia.delete-elements package self-test passed\\n');\n`;
  const packageSelfTest = `'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=(member)=>fs.readFileSync(path.join(root,...member.split('/')),'utf8');
const manifest=JSON.parse(read('manifest.json'));
const runtime=JSON.parse(read('contracts/feature-runtime.json'));
const implementation=JSON.parse(read('contracts/implementation-map.json'));
const vectors=JSON.parse(read('tests/vectors.json'));
const surface=JSON.parse(read('frontend/surface.json'));
const engine=read('python/engine.py');
const bridgeSource=read('middle/python-bridge.cjs');
const workerSource=read('middle/worker.cjs');
const operation=JSON.parse(read('connector-capability/operation.ofop'));
const handlerMember=operation.files.find((member)=>member.path==='operation/handler.cjs');
const handlerSource=handlerMember&&Buffer.from(handlerMember.contentBase64,'base64').toString('utf8');
const worker=require(path.join(root,'middle','worker.cjs'));
if(manifest.featureId!=='omnia.delete-elements'||manifest.version!=='${version}'||runtime.pythonSidecar?.version!=='3.13.14'||runtime.pythonSidecar?.members?.join(',')!=='python/engine.py')throw new Error('signed runtime identity failed');
if(!implementation.planes?.worker?.includes('middle/python-bridge.cjs')||vectors.vectors?.length!==16||!vectors.vectors?.every((item)=>item.inputRef==='tests/self-test.cjs'&&item.expected==='pass')||!vectors.vectors?.some((item)=>item.testId==='feature-local-delete-plan-surface')||!vectors.vectors?.some((item)=>item.testId==='bounded-plan-preflight-concurrency')||!vectors.vectors?.some((item)=>item.testId==='staged-plan-preparation-checkpoint')||!vectors.vectors?.some((item)=>item.testId==='grouped-relation-mutation-readback')||!vectors.vectors?.some((item)=>item.testId==='reopen-authoritative-catalog')||!vectors.vectors?.some((item)=>item.testId==='no-comments-projection')||!vectors.vectors?.some((item)=>item.testId==='managed-python-preparation-compiler')||!vectors.vectors?.some((item)=>item.testId==='compiler-output-tamper-fail-close')||surface.status!=='loading'||surface.selectionBrowser?.layout?.mode!=='fixed_footer_split'||surface.actions?.find((item)=>item.actionId==='bootstrap-authoritative-catalog')?.presentation!=='background'||surface.actions?.find((item)=>item.actionId==='continue-delete-plan-preparation')?.presentation!=='background'||surface.actions?.find((item)=>item.actionId==='continue-delete-plan-preparation')?.visible===false||surface.actions?.find((item)=>item.actionId==='continue-delete-plan-preparation')?.effect!=='local_state_write'||surface.actions?.find((item)=>item.actionId==='retry-delete-plan-preparation')?.effect!=='local_state_write'||surface.lifecycle?.schemaVersion!=='omnia.declarative-feature-surface-lifecycle/v1'||surface.lifecycle?.onReopenActionId!=='refresh-on-reopen'||surface.actions?.find((item)=>item.actionId==='refresh-on-reopen')?.visible!==false||surface.actions?.find((item)=>item.actionId==='refresh-on-reopen')?.presentation!=='background')throw new Error('deletion package declaration failed');
if(!engine.includes('compile_delete_preparation')||!engine.includes('omnia.delete-preparation-compile-input/v1')||!engine.includes('omnia.delete-preparation-compile-output/v1')||!engine.includes('schedule_deletion')||!engine.includes('DELETE.SCHEDULER_DEADLOCK')||!engine.includes('normalize_steps')||!engine.includes('normalize_outcomes')||!bridgeSource.includes("['compile_delete_preparation', 'schedule_deletion']"))throw new Error('pure compiler/scheduler inventory failed');
if(!workerSource.includes("const MUTATION_TYPES = Object.freeze(['Information', 'GRA', 'APP', 'DB', 'OS', 'DCNO', 'TOOL'])")||workerSource.includes('graphDependencyCount')||!workerSource.includes("['DB', 'OS', 'DCNO'].includes(selected.objectType)")||!workerSource.includes("phase: 'core_terminal'")||!workerSource.includes("plan.uncertain.phase === 'core_terminal'"))throw new Error('DCNO Worker parameterization or truthful Core terminal reconcile failed');
if(!handlerSource||!handlerSource.includes("if (value === 'network') return 'DCNO'")||!handlerSource.includes('objectTypeClassification')||!handlerSource.includes('typeEvidence(detail, indexed)')||!handlerSource.includes("sourceTypes: ['DB', 'OS', 'DCNO']")||!handlerSource.includes("['APP', 'DB', 'OS', 'DCNO', 'TOOL'].includes(objectType)")||!handlerSource.includes('explicitlyUnsupportedInfrastructure')||!handlerSource.includes('outsideRequestedWorkspace'))throw new Error('DCNO/mixed Infrastructure or bounded Workspace catalog parameterization failed');
const forbiddenProjectionKey=['message','Card'].join('');
if(!workerSource.includes('INTERACTIVE_CATALOG_TIMEOUT_MS = 90_000')||!workerSource.includes('PLAN_PREFLIGHT_CONCURRENCY = 8')||!workerSource.includes('PLAN_PREPARATION_BATCH_SIZE = 8')||!workerSource.includes("state: 'preparing'")||!workerSource.includes('settlePreparationBatch')||!workerSource.includes('loadCatalogSnapshot')||!workerSource.includes('continuePlanPreparation')||!workerSource.includes('compilePreparationGraph')||!workerSource.includes('verifyCompiledPreparation')||!workerSource.includes('verifiedCheckpointCompilation')||!workerSource.includes('compilationDigest')||workerSource.includes('derivePreparationGraph')||!workerSource.includes("toState: 'cancelled'")||!workerSource.includes('planSurface(plan)')||workerSource.includes(forbiddenProjectionKey)||workerSource.includes(['function ','card('].join(''))||!workerSource.includes('catalogReadInFlight')||!workerSource.includes("input.actionId === 'refresh-on-reopen'")||!workerSource.includes('latestPlanForReopen')||!workerSource.includes('frozenPlanRefreshFailureProjection'))throw new Error('staged Python-compiled bounded plan preflight, Feature-only Surface, no-Comments, or reopen catalog contract failed');
if(!handlerSource.includes('AssociatingEntityIds: payloadTargetIds')||!handlerSource.includes('relationGroupKey')||!handlerSource.includes('targetObjectIds'))throw new Error('grouped relation mutation/readback contract failed');
const verified=worker.finalCatalogVerification({steps:[{key:'cascade:g1',kind:'cascade',objectType:'GRA',objectId:'g1'},{key:'object:app-1',kind:'object',objectType:'APP',objectId:'app-1'}],outcomes:[{stepId:'cascade:g1',state:'succeeded'},{stepId:'object:app-1',state:'succeeded'}]},[],'2026-01-01T00:00:00.000Z');
if(verified.verifiedAbsentTargetIds?.join(',')!=='APP|app-1,GRA|g1')throw new Error('final authoritative absence contract failed');
let contradiction=false;try{worker.finalCatalogVerification({steps:[{key:'cascade:g1',kind:'cascade',objectType:'GRA',objectId:'g1'}],outcomes:[{stepId:'cascade:g1',state:'succeeded'}]},[{identity:'GRA|g1',raw:{objectType:'GRA',objectId:'g1'}}]);}catch(error){contradiction=error?.code==='DELETE.FINAL_CATALOG_CONTRADICTION';}
if(!contradiction)throw new Error('final authoritative contradiction must fail closed');
process.stdout.write('omnia.delete-elements package self-test passed\\n');
`;
  const featureManifest = {
    schemaVersion: 'omnia.feature-manifest/v1',
    featureId: 'omnia.delete-elements',
    version,
    sequence,
    displayName: '删除元素',
    minimumShellVersion: ['0.3.16', '0.3.17', '0.3.18', '0.3.19', '0.3.20'].includes(version) ? '0.4.15' : ['0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.4', '0.3.5', '0.3.6', '0.3.7', '0.3.8', '0.3.9', '0.3.10', '0.3.11', '0.3.12', '0.3.13', '0.3.14', '0.3.15'].includes(version) ? '0.4.14' : ['0.2.0','0.2.1'].includes(version) ? '0.4.12' : version === '0.1.5' ? '0.4.10' : '0.4.0',
    requiredIsolation: 'process',
    storeNamespace: 'delete_elements',
    migrationPath: 'backend/migrations/001.json',
    surfacePath: 'frontend/surface.json',
    workerPath: 'middle/worker.cjs',
    operationPackagePath: 'connector-capability/operation.ofop',
    contractsPath: 'contracts/feature-runtime.json',
    implementationMapPath: 'contracts/implementation-map.json',
    testsManifestPath: 'tests/manifest.json',
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
    statusMessage: '正在读取当前 Pack 的真实权威目录；安全锁内目标会完整核对 Workspace、关系与 blocker，最长等待 90 秒。',
    scopes: [],
    items: [],
    selectedItemIds: [],
    search: '',
    lifecycle: { schemaVersion: 'omnia.declarative-feature-surface-lifecycle/v1', onReopenActionId: 'refresh-on-reopen' },
    actions: [
      {
        actionId: 'refresh-on-reopen',
        label: '重新打开时读取当前目录',
        effect: 'read_only',
        visible: false,
        enabled: true,
        reason: '',
        selectionMode: 'none',
        presentation: 'background',
        dependencies: []
      },
      {
        actionId: 'bootstrap-authoritative-catalog',
        label: '首次权威读取',
        effect: 'read_only',
        enabled: true,
        reason: '',
        selectionMode: 'none',
        presentation: 'background',
        dependencies: ['remote_connector', 'safety_lock']
      },
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
      },
      {
        actionId: 'continue-delete-plan-preparation', label: '继续冻结删除计划', effect: 'local_state_write', enabled: false,
        reason: '当前没有正在冻结的删除计划。', selectionMode: 'none', presentation: 'background',
        dependencies: ['remote_connector', 'safety_lock']
      },
      {
        actionId: 'retry-delete-plan-preparation', label: '重试当前冻结批次', effect: 'local_state_write', enabled: false,
        reason: '当前没有失败的只读冻结批次。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock']
      },
      {
        actionId: 'cancel-delete-plan', label: '取消计划', effect: 'local_state_write', enabled: false,
        reason: '当前未显示待确认删除计划。', selectionMode: 'none', dependencies: []
      },
      {
        actionId: 'confirm-delete-plan', label: '确认删除', effect: 'omnia_mutation', enabled: false,
        reason: '当前未显示待确认删除计划。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock']
      },
      {
        actionId: 'reconcile-delete-plan', label: '只读核验', effect: 'read_only', enabled: false,
        reason: '当前没有只读核验义务。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock']
      }
    ],
    selectionBrowser: {
      schemaVersion: 'omnia.declarative-selection-browser/v1',
      layout: { schemaVersion: 'omnia.selection-browser-layout/v1', mode: 'fixed_footer_split' },
      hierarchyLabel: '所在部分 / Workspace / 元素类型',
      resultsLabel: '当前权威目录',
      searchPlaceholder: '搜索编号、名称、类型或权威 ID',
      emptyMessage: '当前范围没有可显示的元素',
      allScopesLabel: '全部当前范围',
      selectVisibleLabel: '全选当前可选结果',
      clearSelectionLabel: '取消选择当前结果',
      footerActionIds: ['refresh-authoritative-catalog', 'create-delete-plan', 'retry-delete-plan-preparation', 'cancel-delete-plan', 'confirm-delete-plan', 'reconcile-delete-plan'],
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
  if (worker.includes('messageCard') || /\bfunction\s+card\s*\(/u.test(worker)) {
    throw new Error('Delete Worker must not contain a Comments projection path.');
  }
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
      file('contracts/feature-runtime.json', JSON.stringify(runtimeContract, null, 2)),
      file('contracts/implementation-map.json', JSON.stringify(implementationContract, null, 2)),
      file('docs/FEATURE.md', featureDocs),
      file('docs/IMPLEMENTATION_MAP.md', implementationMap),
      file('docs/manifest.json', JSON.stringify(documentationManifest, null, 2)),
      file('frontend/surface.json', JSON.stringify(surface, null, 2)),
      file('manifest.json', JSON.stringify(featureManifest, null, 2)),
      file('middle/worker.cjs', worker),
      file('middle/python-bridge.cjs', await readFile(path.join(source, 'middle', 'python-bridge.cjs'))),
      file('python/engine.py', await readFile(path.join(source, 'python', 'engine.py'))),
      file('tests/manifest.json', JSON.stringify(testsManifest, null, 2)),
      file('tests/vectors.json', JSON.stringify(testVectors, null, 2)),
      file('tests/self-test.cjs', packageSelfTest),
      file('sbom.json', JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        metadata: {
          component: { type: 'application', name: featureManifest.featureId, version }
        },
        components: [{ type: 'application', name: 'CPython embeddable runtime', version: '3.13.14', scope: 'required' }]
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
results.push(await buildVersion('0.3.20', 29));
for (const result of results) console.log(`${path.relative(root, result.filename)} ${result.digest}`);
