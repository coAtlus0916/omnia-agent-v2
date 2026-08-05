import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'feature-packages', 'create-associate', 'source');
const output = path.join(root, 'feature-packages', 'create-associate', 'candidates');
const externalV8 = path.resolve(root, '..', 'outputs', 'sap_ecc_phase1_master_update', 'phase1_系统信息填写V8_SAP_ECC_v4录制证据补充.xlsx');
const managedSource = path.join(source, 'managed');
const managedV8 = path.join(managedSource, 'phase1-system-information-v8.xlsx');
const managedImportMetadata = path.join(managedSource, 'phase1-system-information-v8.import.json');
const userTemplatePath = path.join(root, 'source_files', 'Phase1-用户填写模板V3.xlsx');
const signingRoot = process.env.OMNIA_V5_SIGNING_ROOT || path.join(process.env.USERPROFILE || '', '.omnia-agent-v5', 'signing');
const featurePrivateKey = await readFile(path.join(signingRoot, 'feature-ed25519-private.pem'), 'utf8');
const operationPrivateKey = await readFile(path.join(signingRoot, 'operation-ed25519-private.pem'), 'utf8');
const workerModule = createRequire(import.meta.url)(path.join(source, 'middle', 'worker.cjs'));

const canonical = (value) => value === null || ['boolean', 'string', 'number'].includes(typeof value)
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const file = (pathname, content) => { const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content); return { path: pathname, size: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') }; };
const envelope = ({ product, packageId, version, sequence, keyId, privateKey, files }) => {
  const unsigned = { schemaVersion: 'omnia.official-package-envelope/v1', product, packageId, version, sequence,
    publisher: { keyId, algorithm: 'Ed25519' }, files: [...files].sort((left, right) => left.path.localeCompare(right.path)) };
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') };
};

const expectedV8Sha256 = workerModule.V8_SHA256;
await mkdir(managedSource, { recursive: true });
let v8Bytes;
let importMetadata;
try {
  v8Bytes = await readFile(managedV8);
  importMetadata = JSON.parse(await readFile(managedImportMetadata, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  const sourceBytes = await readFile(externalV8);
  if (sha256(sourceBytes).toUpperCase() !== expectedV8Sha256) throw new Error('External V8 governance source digest is not the audited digest.');
  importMetadata = {
    schemaVersion: 'omnia.governance-import/v1', sourceVersion: 'V8', sourceSha256: expectedV8Sha256,
    importedAt: new Date().toISOString(), sourceReadOnlyPath: path.relative(root, externalV8).replaceAll('\\', '/')
  };
  await writeFile(managedV8, sourceBytes, { flag: 'wx' });
  await writeFile(managedImportMetadata, `${JSON.stringify(importMetadata, null, 2)}\n`, { flag: 'wx' });
  v8Bytes = sourceBytes;
}
if (sha256(v8Bytes).toUpperCase() !== expectedV8Sha256 || importMetadata.sourceSha256 !== expectedV8Sha256
  || importMetadata.sourceVersion !== 'V8' || !Number.isFinite(Date.parse(importMetadata.importedAt))) {
  throw new Error('Managed V8 governance import bytes or metadata drifted.');
}
const parsed = workerModule.parseV8(v8Bytes);
const fieldIds = new Set(parsed.fields.map((row) => row.values.field_id));
const aliases = {
  APP: { '系统ID': 'P1.APP.IT.ELEMENT_ID', 'APP类型': 'P1.APP.GRA.GRA_CONTENT', 'Omnia工作区': 'P1.APP.IT.WORKSPACE', 'System Risk Classification': 'P1.APP.GRA.RAIT_CONCLUSION', 'Factors Considered': 'P1.APP.GRA.FACTORS_CONSIDERED' },
  DB: { '数据库ID': 'P1.DB.IT.ELEMENT_ID', 'DB 类型': 'P1.DB.GRA.GRA_CONTENT', 'Omnia工作区': 'P1.DB.IT.WORKSPACE', '关联系统ID': 'P1.DB.IT.APPLICATION_RELATION' },
  OS: { '服务器ID': 'P1.OS.IT.ELEMENT_ID', 'OS 类型': 'P1.OS.GRA.GRA_CONTENT', 'Omnia工作区': 'P1.OS.IT.WORKSPACE', '关联系统ID': 'P1.OS.IT.APPLICATION_RELATION' },
  TOOL: { 'IT TOOL ID': 'P1.TOOL.IT.ELEMENT_ID', 'Tool 类型': 'P1.TOOL.GRA.GRA_CONTENT', 'Omnia工作区': 'P1.TOOL.IT.WORKSPACE', 'System Risk Classification': 'P1.TOOL.GRA.RAIT_CONCLUSION' }
};
for (const mapping of Object.values(aliases)) for (const fieldId of Object.values(mapping)) {
  if (!fieldIds.has(fieldId)) throw new Error(`Governance alias is not a V8 field_id: ${fieldId}`);
}
const governance = {
  schemaVersion: 'omnia.create-associate.governance/v1', sourceVersion: 'V8', sourceSha256: workerModule.V8_SHA256,
  importedAt: importMetadata.importedAt, sourceRef: 'ofp-member:backend/governance-source-v8.xlsx',
  sheetCount: 9, fieldCount: 187, relationCount: 68, traceCount: 180, evidenceCount: 21,
  sap: { higherRelations: 18, lowerRelations: 17, higherOnlyRelationId: 'REL.APP.SAP_ECC.RAITCOR001.SAP_03' },
  scoring: { items: 15, higherVerifiedWrites: 14, notApplicableItem: 'SAP_ECC.RF.DISPLAY_ORDER_13' },
  fieldAliases: aliases,
  fieldIds: [...fieldIds].sort(),
  fields: parsed.fields.map(({ sourceRow, values }) => ({
    sourceRow,
    fieldId: values.field_id, phase: values.Phase, objectType: values['场景/对象类型'], section: values['对象子类型/区段'],
    higherApplicable: values['Higher适用'], lowerApplicable: values['Lower适用'], label: values['Omnia UI标准字段名'],
    purpose: values['字段用途'], responsibility: values['填写责任/方式'], requiredRule: values['必填规则'],
    allowedValues: values['允许值'], evidenceType: values.evidence_type, v4Path: values['v4 JSON key/path'],
    operation: values['v4 endpoint+method / connector'], requestResponse: values['请求/响应位置'],
    evidenceStatus: values['证据状态/置信度'], validationRule: values['校验规则'], sourceTraceId: values.source_trace_id,
    notes: values['备注']
  })),
  relations: parsed.relations.map(({ values }) => ({
    relationId: values.relation_id, riskFieldId: values.risk_field_id, riskName: values['Risk标准名'],
    controlFieldId: values.control_field_id, controlName: values['Control标准名'], direction: values['关系类型/方向'],
    catalogPresentHigher: values.catalog_present_higher, catalogPresentLower: values.catalog_present_lower,
    linkRequiredHigher: values.link_required_higher, linkRequiredLower: values.link_required_lower,
    classificationHigher: values.classification_higher, classificationLower: values.classification_lower,
    applicability: values['执行适用层级'], objectType: values['适用场景/对象类型'], required: values['是否必需'],
    missingDataPolicy: values['无资料时策略'], evidenceType: values['v4 evidence_type'], operation: values['v4 JSON/API/DOM/connector路径'],
    evidenceLocation: values['证据文件+行号'], evidenceStatus: values['确认状态'], sourceTraceId: values.source_trace_id,
    notes: values['备注']
  })),
  scoringItems: parsed.scoreItems.map(({ values }) => ({
    itemId: values.item_id, label: values['UI标签'], objectType: values['适用对象/场景'],
    higherApplicable: values['Higher适用'], lowerApplicable: values['Lower适用'], allowedScores: values['allowed scores'],
    maxSource: values['max source'], jsonContract: values['JSON字段'], operation: values['endpoint+method'],
    requestEvidence: values['request位置'], readbackEvidence: values['response/read-back位置'], recordingEvidence: values['录制事件'],
    evidenceStatus: values['证据状态'], blocker: values.blocker, notes: values['备注']
  }))
};
const isRelevantDeclaration = governance.fields.find((item) => item.fieldId === 'P1.APP.IT.IS_RELEVANT');
if (!isRelevantDeclaration || isRelevantDeclaration.sourceRow !== 9 || isRelevantDeclaration.sourceTraceId !== 'SRC.IT元素.011') {
  throw new Error('V8 APP isRelevant declaration identity drifted.');
}
Object.assign(isRelevantDeclaration, { defaultRuleId: 'v8.app-is-relevant-false.v1', defaultValue: false });
const isDataAvailableDeclaration = governance.fields.find((item) => item.fieldId === 'P1.APP.IT.IS_DATA_AVAILABLE');
if (!isDataAvailableDeclaration) throw new Error('V8 APP isDataAvailable declaration identity drifted.');
Object.assign(isDataAvailableDeclaration, { defaultRuleId: 'v4.app-is-data-available-false.v1', defaultValue: false });
governance.derivationRules = [{
  ruleId: 'v8.app-description-from-element-id.v1', targetFieldId: 'P1.APP.IT.DESCRIPTION',
  dependencyFieldId: 'P1.APP.IT.ELEMENT_ID', algorithm: 'canonical_element_id', sourceTraceId: 'SRC.IT元素.010'
}, {
  ruleId: 'v4.db-description-from-element-id.v1', targetFieldId: 'P1.DB.IT.DESCRIPTION',
  dependencyFieldId: 'P1.DB.IT.ELEMENT_ID', algorithm: 'canonical_element_id', sourceTraceId: 'v4:template-contract.js:phase1OfficialDerivedValues'
}, {
  ruleId: 'v4.os-description-from-element-id.v1', targetFieldId: 'P1.OS.IT.DESCRIPTION',
  dependencyFieldId: 'P1.OS.IT.ELEMENT_ID', algorithm: 'canonical_element_id', sourceTraceId: 'v4:template-contract.js:phase1OfficialDerivedValues'
}, {
  ruleId: 'v4.tool-description-from-element-id.v1', targetFieldId: 'P1.TOOL.IT.DESCRIPTION',
  dependencyFieldId: 'P1.TOOL.IT.ELEMENT_ID', algorithm: 'canonical_element_id', sourceTraceId: 'v4:template-contract.js:phase1OfficialDerivedValues'
}, {
  ruleId: 'v8.app-is-relevant-false.v1', targetFieldId: 'P1.APP.IT.IS_RELEVANT',
  algorithm: 'constant_boolean_false', constantValue: false, sourceTraceId: 'SRC.IT元素.011'
}, {
  ruleId: 'v4.app-is-data-available-false.v1', targetFieldId: 'P1.APP.IT.IS_DATA_AVAILABLE',
  algorithm: 'constant_boolean_false', constantValue: false, sourceTraceId: 'v4:phase1:application:isDataAvailable=false'
}, {
  ruleId: 'v4.phase1-gra-name-from-element-id.v1', targetFieldId: 'P1.RUNTIME.GRA.NAME',
  dependencyFieldId: 'P1.RUNTIME.IT.ELEMENT_ID', algorithm: 'prefix_literal', prefix: 'GRA-', sourceTraceId: 'v4:omnia-phase1.js:716'
}];
governance.semanticDigest = sha256(Buffer.from(canonical({ fields: governance.fields, relations: governance.relations, scoringItems: governance.scoringItems, derivationRules: governance.derivationRules })));
governance.managedGovernanceRef = 'ofp-member:backend/governance.json';
const finalGovernanceBytes = Buffer.from(JSON.stringify(governance, null, 2));
const runtimeBaseBytes = workerModule.buildRuntimeWorkbook(
  { rows: [], candidates: [], issues: [] },
  { runId: 'runtime-template-base', sourceArtifactId: 'none', governanceDigest: expectedV8Sha256 }
).bytes;

const userTemplateBytes = await readFile(userTemplatePath);
if (userTemplateBytes.length < 1 || userTemplateBytes.length > 64 * 1024 * 1024) throw new Error('Phase1 user template V3 size is invalid.');
const version = '0.2.39'; const sequence = 41;
const route = (stepId, method, routeTemplate, parameters, bodyMode = 'none', bodyParameter = '') => ({ stepId, method, routeTemplate, parameters, bodyMode, bodyParameter });
const applicationIdentityRoutes = () => [
  route('workitem-directory', 'POST', '/work/v1/WorkQueries/getWorkitemDetails', [], 'signed_json'),
  route('gra-directory', 'POST', '/rapr/v0/engagements/{engagementId}/riskassessments/commonAccounts', [], 'signed_json'),
  route('application-search', 'POST', '/rapr/v0/engagements/{engagementId}/applications/search', [], 'signed_json'),
  route('object-detail', 'GET', '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', [{ name: 'objectId', type: 'guid' }]),
  route('object-identity-workspace', 'GET', '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', [{ name: 'workItemId', type: 'guid' }]),
  route('gra-detail', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])
];
const operations = [
  { operationId: 'omnia.create-associate.authority.resolve.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.authority-resolve-request/v1', responseSchema: 'omnia.create-associate.authority-resolve-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('authority-hierarchy', 'GET', '/engagements/v1/{engagementId}/headers/hierarchy', []),
    route('authority-directory', 'POST', '/engagements/v1/facets/byEngagementIds', [{ name: 'engagementId', type: 'guid' }], 'parameter_array', 'engagementId'),
    route('authority-gra-directory', 'GET', '/rapr/v0/engagements/{engagementId}/content/reference-list-byLatestDate?typeId={catalogType}&releaseDate={releaseDate}', [
      { name: 'catalogType', type: 'string' }, { name: 'releaseDate', type: 'string' }
    ])
  ] },
  { operationId: 'omnia.create-associate.risk-control.catalog.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-control-catalog-request/v1', responseSchema: 'omnia.create-associate.risk-control-catalog-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('risk-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('control-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/controls/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-assessment-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-detail', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/GetPlanResponseDetailByRiskRiskScopeId?riskriskScopeId={riskRiskScopeId}&reviewMode=false&controlExpanded=false&procedureExpanded=false', [{ name: 'riskRiskScopeId', type: 'guid' }])
  ] },
  { operationId: 'omnia.create-associate.object.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.object-preflight-request/v1', responseSchema: 'omnia.create-associate.object-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('workitem-directory', 'POST', '/work/v1/WorkQueries/getWorkitemDetails', [], 'signed_json'),
    route('gra-directory', 'POST', '/rapr/v0/engagements/{engagementId}/riskassessments/commonAccounts', [], 'signed_json'),
    route('application-search', 'POST', '/rapr/v0/engagements/{engagementId}/applications/search', [], 'signed_json'),
    route('infrastructure-search', 'POST', '/rapr/v0/engagements/{engagementId}/infrastructures/search', [], 'signed_json'),
    route('tool-search', 'POST', '/rapr/v0/engagements/{engagementId}/itelement/search', [], 'signed_json'),
    route('object-detail', 'GET', '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', [{ name: 'objectId', type: 'guid' }]),
    route('object-identity-workspace', 'GET', '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', [{ name: 'workItemId', type: 'guid' }])
  ] },
  { operationId: 'omnia.create-associate.object.identity.resolve.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.object-identity-resolve-request/v1', responseSchema: 'omnia.create-associate.object-identity-resolve-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: applicationIdentityRoutes() },
  { operationId: 'omnia.create-associate.object.create-preflight.v2', effect: 'read_only', requestSchema: 'omnia.create-associate.object-create-preflight-request/v2', responseSchema: 'omnia.create-associate.object-create-preflight-response/v2', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.object.create.v1', routes: [
    ...applicationIdentityRoutes(),
    route('infrastructure-search', 'POST', '/rapr/v0/engagements/{engagementId}/infrastructures/search', [], 'signed_json'),
    route('tool-search', 'POST', '/rapr/v0/engagements/{engagementId}/itelement/search', [], 'signed_json')
  ] },
  { operationId: 'omnia.create-associate.object.create.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.object-create-request/v1', responseSchema: 'omnia.create-associate.object-create-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [route('object-create', 'POST', '/rapr/v0/engagements/{engagementId}/itelement', [], 'signed_json')] },
  { operationId: 'omnia.create-associate.object.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.object-reconcile-request/v1', responseSchema: 'omnia.create-associate.object-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('object-readback', 'GET', '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', [{ name: 'objectId', type: 'guid' }]),
    route('object-readback-workspace', 'GET', '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', [{ name: 'workItemId', type: 'guid' }])
  ] },
  { operationId: 'omnia.create-associate.object-settings.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.object-settings-preflight-request/v1', responseSchema: 'omnia.create-associate.object-settings-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.object-settings.patch.v1', routes: [
    route('object-settings-read','GET','/rapr/v0/engagements/{engagementId}/itelement/{objectId}',[{name:'objectId',type:'guid'}]),
    route('object-settings-workspace','GET','/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}',[{name:'workItemId',type:'guid'}])
  ] },
  { operationId: 'omnia.create-associate.object-settings.patch.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.object-settings-patch-request/v1', responseSchema: 'omnia.create-associate.object-settings-patch-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [
    route('object-settings-mutation-read','GET','/rapr/v0/engagements/{engagementId}/itelement/{objectId}',[{name:'objectId',type:'guid'}]),
    route('object-settings-mutation-workspace','GET','/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}',[{name:'workItemId',type:'guid'}]),
    route('object-settings-type-patch','PATCH','/rapr/v0/engagements/{engagementId}/itelement/{objectId}',[{name:'objectId',type:'guid'}],'signed_json'),
    route('object-settings-data-patch','PATCH','/rapr/v0/engagements/{engagementId}/itelement/{objectId}',[{name:'objectId',type:'guid'}],'signed_json')
  ] },
  { operationId: 'omnia.create-associate.object-settings.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.object-settings-reconcile-request/v1', responseSchema: 'omnia.create-associate.object-settings-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('object-settings-read','GET','/rapr/v0/engagements/{engagementId}/itelement/{objectId}',[{name:'objectId',type:'guid'}]),
    route('object-settings-workspace','GET','/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}',[{name:'workItemId',type:'guid'}])
  ] },
  { operationId: 'omnia.create-associate.relation.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.relation-preflight-request/v1', responseSchema: 'omnia.create-associate.relation-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.relation.associate.v1', routes: [
    route('relation-source-detail', 'GET', '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', [{ name: 'objectId', type: 'guid' }]),
    route('relation-source-workspace', 'GET', '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', [{ name: 'workItemId', type: 'guid' }]),
    route('relation-target-detail', 'GET', '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', [{ name: 'objectId', type: 'guid' }]),
    route('relation-target-workspace', 'GET', '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', [{ name: 'workItemId', type: 'guid' }]),
    route('applications-search', 'POST', '/rapr/v0/engagements/{engagementId}/applications/search', [], 'signed_json'),
    route('infrastructures-search', 'POST', '/rapr/v0/engagements/{engagementId}/infrastructures/search', [], 'signed_json'),
    route('tool-relation-search', 'POST', '/rapr/v0/engagements/{engagementId}/itelement/search', [], 'signed_json')
  ] },
  { operationId: 'omnia.create-associate.relation.associate.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.relation-associate-request/v1', responseSchema: 'omnia.create-associate.relation-associate-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [route('relation-associate', 'POST', '/rapr/v0/engagements/{engagementId}/itelement/associate', [], 'signed_json')] },
  { operationId: 'omnia.create-associate.relation.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.relation-reconcile-request/v1', responseSchema: 'omnia.create-associate.relation-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('relation-source-detail', 'GET', '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', [{ name: 'objectId', type: 'guid' }]),
    route('relation-source-workspace', 'GET', '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', [{ name: 'workItemId', type: 'guid' }]),
    route('relation-target-detail', 'GET', '/rapr/v0/engagements/{engagementId}/itelement/{objectId}', [{ name: 'objectId', type: 'guid' }]),
    route('relation-target-workspace', 'GET', '/work/v1/engagements/{engagementId}/WorkItemFacetMapping/workitem/{workItemId}', [{ name: 'workItemId', type: 'guid' }]),
    route('applications-search', 'POST', '/rapr/v0/engagements/{engagementId}/applications/search', [], 'signed_json'),
    route('infrastructures-search', 'POST', '/rapr/v0/engagements/{engagementId}/infrastructures/search', [], 'signed_json'),
    route('tool-relation-search', 'POST', '/rapr/v0/engagements/{engagementId}/itelement/search', [], 'signed_json')
  ] },
  { operationId: 'omnia.create-associate.gra.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.gra-preflight-request/v1', responseSchema: 'omnia.create-associate.gra-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.gra.create.v1', routes: [
    route('workitem-directory', 'POST', '/work/v1/WorkQueries/getWorkitemDetails', [], 'signed_json'),
    route('gra-directory', 'POST', '/rapr/v0/engagements/{engagementId}/riskassessments/commonAccounts', [], 'signed_json'),
    route('gra-detail', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])
  ] },
  { operationId: 'omnia.create-associate.gra.create.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.gra-create-request/v1', responseSchema: 'omnia.create-associate.gra-create-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [route('gra-create', 'POST', '/rapr/v0/engagements/{engagementId}/riskassessments/create', [], 'signed_json')] },
  { operationId: 'omnia.create-associate.gra.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.gra-reconcile-request/v1', responseSchema: 'omnia.create-associate.gra-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('gra-readback', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('workitem-directory', 'POST', '/work/v1/WorkQueries/getWorkitemDetails', [], 'signed_json'),
    route('gra-directory', 'POST', '/rapr/v0/engagements/{engagementId}/riskassessments/commonAccounts', [], 'signed_json')
  ] },
  { operationId: 'omnia.create-associate.gra-state.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.gra-state-preflight-request/v1', responseSchema: 'omnia.create-associate.gra-state-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.gra-state.patch.v1', routes: [route('gra-state-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])] },
  { operationId: 'omnia.create-associate.gra-state.patch.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.gra-state-patch-request/v1', responseSchema: 'omnia.create-associate.gra-state-patch-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [route('gra-state-patch', 'PATCH', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }], 'signed_json')] },
  { operationId: 'omnia.create-associate.gra-state.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.gra-state-reconcile-request/v1', responseSchema: 'omnia.create-associate.gra-state-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [route('gra-state-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])] },
  { operationId: 'omnia.create-associate.risk-factor.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-factor-preflight-request/v1', responseSchema: 'omnia.create-associate.risk-factor-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.risk-factor.patch.v1', routes: [route('risk-factor-directory', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factors/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false&includeDeletedSuffix=false', [{ name: 'riskAssessmentId', type: 'guid' }])] },
  { operationId: 'omnia.create-associate.risk-factor.patch.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.risk-factor-patch-request/v1', responseSchema: 'omnia.create-associate.risk-factor-patch-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [route('risk-factor-directory', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factors/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false&includeDeletedSuffix=false', [{ name: 'riskAssessmentId', type: 'guid' }]), route('risk-factor-patch', 'PATCH', '/rapr/v0/engagements/{engagementId}/risk-factors/{factorId}', [{ name: 'factorId', type: 'guid' }], 'signed_json')] },
  { operationId: 'omnia.create-associate.risk-factor.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-factor-reconcile-request/v1', responseSchema: 'omnia.create-associate.risk-factor-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [route('risk-factor-directory', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factors/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false&includeDeletedSuffix=false', [{ name: 'riskAssessmentId', type: 'guid' }])] },
  { operationId: 'omnia.create-associate.documentation.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.documentation-preflight-request/v1', responseSchema: 'omnia.create-associate.documentation-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.documentation.patch.v1', routes: [route('documentation-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])] },
  { operationId: 'omnia.create-associate.documentation.patch.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.documentation-patch-request/v1', responseSchema: 'omnia.create-associate.documentation-patch-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [
    route('documentation-mutation-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('documentation-patch', 'PATCH', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }], 'signed_json')
  ] },
  { operationId: 'omnia.create-associate.documentation.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.documentation-reconcile-request/v1', responseSchema: 'omnia.create-associate.documentation-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [route('documentation-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])] },
  { operationId: 'omnia.create-associate.evaluation.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.evaluation-preflight-request/v1', responseSchema: 'omnia.create-associate.evaluation-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.evaluation.submit.v1', routes: [route('evaluation-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])] },
  { operationId: 'omnia.create-associate.evaluation.submit.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.evaluation-submit-request/v1', responseSchema: 'omnia.create-associate.evaluation-submit-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [route('evaluation-submit', 'POST', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}/submit-riskfactor-evaluation?skipValidation=false', [{ name: 'riskAssessmentId', type: 'guid' }], 'signed_json')] },
  { operationId: 'omnia.create-associate.evaluation.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.evaluation-reconcile-request/v1', responseSchema: 'omnia.create-associate.evaluation-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [route('evaluation-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])] },
  { operationId: 'omnia.create-associate.risk-control.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-control-preflight-request/v1', responseSchema: 'omnia.create-associate.risk-control-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.risk-control.associate.v1', routes: [route('risk-control-validation', 'POST', '/rapr/v0/engagements/{engagementId}/controls/validateHiddenDataForRiskAssociation?riskId={riskId}&operation=AddAssociation&riskClassification={riskClassification}', [{ name: 'riskId', type: 'guid' }, { name: 'riskClassification', type: 'string' }], 'signed_json')] },
  { operationId: 'omnia.create-associate.risk-control.associate.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.risk-control-associate-request/v1', responseSchema: 'omnia.create-associate.risk-control-associate-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [
    route('risk-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('control-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/controls/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-assessment-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-detail', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/GetPlanResponseDetailByRiskRiskScopeId?riskriskScopeId={riskRiskScopeId}&reviewMode=false&controlExpanded=false&procedureExpanded=false', [{ name: 'riskRiskScopeId', type: 'guid' }]),
    route('risk-control-associate', 'POST', '/rapr/v0/engagements/{engagementId}/controls/controlrisks/associate', [], 'signed_json')
  ] },
  { operationId: 'omnia.create-associate.risk-control.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-control-reconcile-request/v1', responseSchema: 'omnia.create-associate.risk-control-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [route('risk-control-detail', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/GetPlanResponseDetailByRiskRiskScopeId?riskriskScopeId={riskRiskScopeId}&reviewMode=false&controlExpanded=false&procedureExpanded=false', [{ name: 'riskRiskScopeId', type: 'guid' }])] }
];
const operationManifest = { schemaVersion: 'omnia.connector-operation-manifest/v1', packageId: 'omnia.create-associate.operation', version, sequence, featureId: 'omnia.create-associate', operations };
const operationPackage = envelope({
  product: 'omnia-connector-operation', packageId: operationManifest.packageId, version, sequence,
  keyId: 'omnia-v5-official-operation-2026-01', privateKey: operationPrivateKey,
  files: [
    file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'connector-operation', keyId: 'omnia-v5-official-operation-2026-01' })),
    file('docs/OPERATION.md', await readFile(path.join(source, 'docs', 'OPERATION.md'))),
    file('manifest.json', JSON.stringify(operationManifest, null, 2)),
    file('operation/handler.cjs', await readFile(path.join(source, 'connector-capability', 'operation', 'handler.cjs'))),
    file('operation/policy.json', JSON.stringify({ schemaVersion: 'omnia.connector-operation-policy/v1', packageId: operationManifest.packageId, operationDigests: Object.fromEntries(operations.map((operation) => [operation.operationId, sha256(Buffer.from(JSON.stringify(operation))) ])) }, null, 2)),
    file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: operationManifest.packageId, version } }, components: [] }))
  ]
});
const docs = ['FEATURE', 'IMPLEMENTATION_MAP', 'PRODUCT', 'TECHNICAL', 'CONTRACT', 'TESTING', 'OPERATIONS', 'VERSION'];
const documentationFiles = await Promise.all(docs.map(async (name) => ({ path: `docs/${name}.md`, bytes: await readFile(path.join(source, 'docs', `${name}.md`)), purpose: name.toLowerCase() })));
const docsManifest = { schemaVersion: 'omnia.feature-documentation/v1', featureId: 'omnia.create-associate', featureVersion: version, documents: documentationFiles.map((document) => ({ path: document.path, sha256: sha256(document.bytes), purpose: document.purpose })) };
const testIds=['v8-governance-ooxml','signed-v3-source-template','staged-source-acquiring','confirm-before-background-validation','background-action-non-mutation','acquiring-recovery','staged-replacement-audit','v3-no-user-is-data-available','v4-is-data-available-false-rule','canonical-eleven-checks','canonical-four-kind-review-matrix','four-kind-derived-description','excluded-row-no-issue-order','empty-kind-disabled','review-reimport-dirty-guard','save-and-full-revalidate','remove-row-full-live-revalidate','remove-row-cas-persistence','live-revalidate-recovery','warnings-do-not-block-return','unexecuted-checks-not-passed','app-identity-recycle-resolution','non-app-identity-state-resolution','app-create-only-permit','uncertain-identity-reconcile-no-replay','three-step-durable-workflow','full-return-operation-loop','bootstrap-capability-evidence','crash-recovery-monotonic'];
const runtimeContract={schemaVersion:'omnia.feature-runtime-contract/v1',featureId:'omnia.create-associate',featureVersion:version,
  inputs:['staged_xlsx_artifact','upload_confirmation','background_validation','issue_revisions','return_confirmation','connector_binding','workspace_safety'],outputs:['template_instance_xlsx','surface_patch','confirmation_card','managed_object_revisions','managed_relation_revisions'],
  events:['artifact.staging_replaced','workbook.upload_confirmed','run.transition','run.offline_crash_recovered','run.restart_requested','return.confirmed_in_comments','return.readback_verified','return.uncertain'],
  errors:['WORKBOOK.*','GOVERNANCE.*','RETURN.*','CONNECTOR.RESPONSE_LOST'],
  storePorts:['createRun','readArtifactBytes','readManagedAssetBytes','commitArtifact','transitionRun','recordFieldRevisions','recordIssues','loadRunReview','commitReviewValidation','proveOwnedCreatedObject','prepareReturnIntent','approveReturnIntent','prepareReturnCommand','freezeReturnEvidenceSpec','recordReturnEvidence','projectVerifiedReturn','recordBootstrapCapabilityEvidence','getCapabilityEvidenceState','finishReturn','savePlan','loadPlan']};
const implementationMap={schemaVersion:'omnia.feature-implementation-map/v1',featureId:'omnia.create-associate',featureVersion:version,planes:{
  surface:['frontend/surface.json'],worker:['middle/worker.cjs'],store:['backend/migrations/001.json','contracts/feature-runtime.json'],connector:['connector-capability/operation.ofop']},
  operations:operations.map(({operationId,effect})=>({operationId,effect}))};
const testVectors={schemaVersion:'omnia.feature-test-vectors/v1',featureId:'omnia.create-associate',vectors:testIds.map((testId)=>({testId,inputRef:'tests/self-test.cjs',expected:'pass'}))};
const testsManifest={schemaVersion:'omnia.feature-tests-manifest/v1',featureId:'omnia.create-associate',featureVersion:version,testIds,vectorsPath:'tests/vectors.json',selfTestPath:'tests/self-test.cjs',status:'declared',command:'node tests/self-test.cjs'};
const selfTest=`'use strict';\nconst fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');\nconst root=path.resolve(__dirname,'..'),worker=require(path.join(root,'middle','worker.cjs'));\nconst v8=fs.readFileSync(path.join(root,'backend','governance-source-v8.xlsx')),governance=JSON.parse(fs.readFileSync(path.join(root,'backend','governance.json'),'utf8')),operation=JSON.parse(fs.readFileSync(path.join(root,'connector-capability','operation.ofop'),'utf8'));\nconst digest=crypto.createHash('sha256').update(v8).digest('hex').toUpperCase(),parsed=worker.parseV8(v8);\nif(digest!==worker.V8_SHA256||parsed.fields.length!==187||parsed.relations.length!==68||parsed.traces.length!==180||parsed.evidence.length!==21)throw new Error('managed V8 contract failed');\nif(governance.derivationRules?.[0]?.ruleId!=='v8.app-description-from-element-id.v1'||governance.derivationRules?.[1]?.ruleId!=='v8.app-is-relevant-false.v1'||governance.derivationRules?.[1]?.constantValue!==false||governance.derivationRules?.[2]?.ruleId!=='v4.app-is-data-available-false.v1'||governance.derivationRules?.[2]?.constantValue!==false||governance.derivationRules?.[3]?.ruleId!=='v4.phase1-gra-name-from-element-id.v1'||governance.derivationRules?.[3]?.prefix!=='GRA-'||governance.inputSchema?.APP?.aliases?.includes('isDataAvailable')||operation.product!=='omnia-connector-operation'||operation.packageId!=='omnia.create-associate.operation'||operation.version!=='${version}')throw new Error('signed package identity failed');\nif(!fs.statSync(path.join(root,'backend','runtime-template-base.xlsx')).isFile())throw new Error('runtime base missing');\nprocess.stdout.write('omnia.create-associate package self-test passed\\n');\n`;
const packagedSelfTest=selfTest
  .replace("governance.derivationRules?.[0]?.ruleId!=='v8.app-description-from-element-id.v1'", "!governance.derivationRules?.some((rule)=>rule.ruleId==='v8.app-description-from-element-id.v1')||!['db','os','tool'].every((kind)=>governance.derivationRules.some((rule)=>rule.ruleId===`v4.${kind}-description-from-element-id.v1`))")
  .replace("governance.derivationRules?.[1]?.ruleId!=='v8.app-is-relevant-false.v1'||governance.derivationRules?.[1]?.constantValue!==false", "governance.derivationRules?.find((rule)=>rule.ruleId==='v8.app-is-relevant-false.v1')?.constantValue!==false")
  .replace("governance.derivationRules?.[2]?.ruleId!=='v4.app-is-data-available-false.v1'||governance.derivationRules?.[2]?.constantValue!==false", "governance.derivationRules?.find((rule)=>rule.ruleId==='v4.app-is-data-available-false.v1')?.constantValue!==false")
  .replace("governance.derivationRules?.[3]?.ruleId!=='v4.phase1-gra-name-from-element-id.v1'||governance.derivationRules?.[3]?.prefix!=='GRA-'", "governance.derivationRules?.find((rule)=>rule.ruleId==='v4.phase1-gra-name-from-element-id.v1')?.prefix!=='GRA-'");
const featureManifest = {
  schemaVersion: 'omnia.feature-manifest/v1', featureId: 'omnia.create-associate', version, sequence, displayName: '新建与关联', minimumShellVersion: '0.4.9',
  requiredIsolation: 'process', storeNamespace: 'create_associate', migrationPath: 'backend/migrations/001.json', surfacePath: 'frontend/surface.json', workerPath: 'middle/worker.cjs', operationPackagePath: 'connector-capability/operation.ofop',
  contractsPath:'contracts/feature-runtime.json',implementationMapPath:'contracts/implementation-map.json',testsManifestPath:'tests/manifest.json',
  assets: [
    { path: 'backend/governance.json', sha256: sha256(finalGovernanceBytes), kind: 'governance' },
    { path: 'backend/governance-source-v8.xlsx', sha256: sha256(v8Bytes), kind: 'governance' },
    { path: 'backend/runtime-template-base.xlsx', sha256: sha256(runtimeBaseBytes), kind: 'runtime_template_base' }
    ,{ path: 'backend/Phase1-用户填写模板V3.xlsx', sha256: sha256(userTemplateBytes), kind: 'source_template' }
  ],
  navigation: { groups: [], leaves: [{ id: 'create-associate', parentId: '', level: 2, label: '新建与关联', order: 20, featureId: 'omnia.create-associate', featureVersion: version, route: 'feature:omnia.create-associate/workbench' }] }
};
const surface = {
  schemaVersion: 'omnia.declarative-feature-surface/v1', featureId: 'omnia.create-associate', featureVersion: version, surfaceId: 'create-associate.workbench', stateVersion: 1,
  title: '新建与关联', description: '导入真实 Phase 1 用户资料，完成本地校验后按确认回传当前 Pack。', density: 'compact', status: 'idle', statusMessage: '上传与本地校验无需 Remote 或安全锁；只有回传写入需要连接与安全锁。', scopes: [], items: [], selectedItemIds: [], search: '', artifacts: [], editors: [], issues: [],
  workflow:{revision:1,currentStepId:'upload',steps:[{stepId:'upload',label:'上传资料',state:'current',detail:'上传系统信息'},{stepId:'validate',label:'校验',state:'pending',detail:'等待上传'},{stepId:'return',label:'回传',state:'pending',detail:'等待校验通过'}]},
  actions: [
    { actionId: 'download-source-template', label: '下载模板', effect: 'read_only', enabled: true, reason: '', presentation: 'upload', selectionMode: 'none', dependencies: [], output: { kind: 'save_managed_asset', memberPath: 'backend/Phase1-用户填写模板V3.xlsx', suggestedName: 'Phase1-用户填写模板V3.xlsx' } },
    { actionId: 'stage-source-workbook', label: '选择系统信息', effect: 'local_state_write', enabled: true, reason: '', presentation: 'file_input', selectionMode: 'none', dependencies: [], input: { kind: 'open_file', accept: ['.xlsx'], label: '选择 Phase 1 系统信息' } },
    { actionId: 'confirm-upload', label: '确认上传', effect: 'local_state_write', enabled: false, reason: '请先选择或拖入一个 .xlsx 文件。', presentation: 'upload', selectionMode: 'none', dependencies: [] },
    { actionId: 'validate-staged-upload', label: '后台校验', effect: 'local_state_write', enabled: false, reason: '等待确认上传。', presentation: 'background', selectionMode: 'none', dependencies: [] },
    { actionId: 'apply-revisions', label: '保存修改并重新检查', effect: 'local_state_write', enabled: false, reason: '等待 Review。', selectionMode: 'none', dependencies: [] },
    { actionId: 'remove-batch-row', label: '仅从本批移除当前行', effect: 'local_state_write', enabled: false, reason: '等待 Review。', selectionMode: 'none', dependencies: [] },
    { actionId: 'revalidate-all', label: '重新检查全部', effect: 'local_state_write', enabled: false, reason: '等待 Review。', selectionMode: 'none', dependencies: [] },
    { actionId: 'back-to-upload', label: '返回上传', effect: 'local_state_write', enabled: false, reason: '等待 Review。', selectionMode: 'none', dependencies: [] },
    { actionId: 'restart-run', label: '重新开始', effect: 'local_state_write', enabled: false, reason: '当前没有可重置的可编辑 Run。', presentation: 'restart', selectionMode: 'none', dependencies: [] },
    { actionId: 'prepare-return', label: '提交审核', effect: 'local_state_write', enabled: false, reason: '完成处理与问题修订后可用。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] },
    { actionId: 'confirm-return', label: '确认回传', effect: 'omnia_mutation', enabled: false, reason: '请先提交审核并冻结回传计划。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] },
    { actionId: 'continue-return', label: '继续回传', effect: 'omnia_mutation', enabled: false, reason: '当前没有可继续的冻结计划。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] },
    { actionId: 'reconcile-return', label: '只读核验', effect: 'read_only', enabled: false, reason: '当前没有待核验的写入结果。', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] }
  ]
};
const migration = { schemaVersion: 'omnia.feature-private-migration/v1', namespace: 'create_associate', version: 1, tables: [{ name: 'create_associate_runtime_plans', columns: [{ name: 'plan_id', type: 'TEXT', notNull: true, primaryKey: true }, { name: 'payload_json', type: 'TEXT', notNull: true, primaryKey: false }, { name: 'updated_at', type: 'TEXT', notNull: true, primaryKey: false }] }] };
let worker = await readFile(path.join(source, 'middle', 'worker.cjs'), 'utf8');
worker = worker.replaceAll('__FEATURE_VERSION__', version).replace('__GOVERNANCE_JSON__', JSON.stringify(governance).replaceAll('\\', '\\\\').replaceAll("'", "\\'"));
const featurePackage = envelope({
  product: 'omnia-feature', packageId: featureManifest.featureId, version, sequence, keyId: 'omnia-v5-official-feature-2026-01', privateKey: featurePrivateKey,
  files: [
    file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'feature', keyId: 'omnia-v5-official-feature-2026-01' })),
    file('backend/migrations/001.json', JSON.stringify(migration, null, 2)),
    file('backend/governance.json', finalGovernanceBytes), file('backend/governance-source-v8.xlsx', v8Bytes),
    file('backend/runtime-template-base.xlsx', runtimeBaseBytes),
    file('backend/Phase1-用户填写模板V3.xlsx', userTemplateBytes),
    file('connector-capability/operation.ofop', JSON.stringify(operationPackage)),
    file('contracts/feature-runtime.json',JSON.stringify(runtimeContract,null,2)),file('contracts/implementation-map.json',JSON.stringify(implementationMap,null,2)),
    ...documentationFiles.map((document) => file(document.path, document.bytes)), file('docs/manifest.json', JSON.stringify(docsManifest, null, 2)),
    file('frontend/surface.json', JSON.stringify(surface, null, 2)), file('manifest.json', JSON.stringify(featureManifest, null, 2)), file('middle/worker.cjs', worker),
    file('tests/manifest.json',JSON.stringify(testsManifest,null,2)),file('tests/vectors.json',JSON.stringify(testVectors,null,2)),file('tests/self-test.cjs',packagedSelfTest),
    file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: featureManifest.featureId, version } }, components: [] }))
  ]
});
await mkdir(output, { recursive: true });
const operationFilename = path.join(output, `create-associate-operation-${version}.ofop`);
const serializedOperation = JSON.stringify(operationPackage);
let existingOperation = null; try { existingOperation = await readFile(operationFilename, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (existingOperation !== null && existingOperation !== serializedOperation) throw new Error(`Refusing to overwrite immutable Operation package: ${operationFilename}`);
if (existingOperation === null) await writeFile(operationFilename, serializedOperation, { flag: 'wx' });
const filename = path.join(output, `create-associate-${version}.ofp`); const serialized = JSON.stringify(featurePackage);
let existing = null; try { existing = await readFile(filename, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (existing !== null && existing !== serialized) throw new Error(`Refusing to overwrite immutable Feature package: ${filename}`);
if (existing === null) await writeFile(filename, serialized, { flag: 'wx' });
const { signature: _signature, ...unsigned } = featurePackage;
console.log(`${path.relative(root, filename)} sha256:${sha256(Buffer.from(canonical(unsigned)))}`);
