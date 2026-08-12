import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
const managedUserTemplatePath = path.join(managedSource, 'Phase1-用户填写模板V5.xlsx');
const managedCatalogIdentityPath = path.join(managedSource, 'risk-control-catalog-identities.json');
const testSource = path.join(source, 'tests');
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
const managedPython = process.env.OMNIA_PYTHON_EXECUTABLE
  || path.join(root, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
const buildRuntimeBaseWithPython = (kindRegistry, metadata) => {
  const pythonRoot=path.join(source,'python');
  const code=`import base64,json,pathlib,sys\nassert sys.version_info[:3]==(3,13,14),sys.version\nsys.path.insert(0,sys.argv[1])\nfrom workbook_compile import build_runtime_base\npayload=json.load(sys.stdin)\noutput,descriptor=build_runtime_base(kind_registry=payload['kindRegistry'],metadata=payload['metadata'])\njson.dump({'workbookBase64':base64.b64encode(output).decode('ascii'),'descriptor':descriptor},sys.stdout,separators=(',',':'))`;
  const result=spawnSync(managedPython,['-I','-S','-c',code,pythonRoot],{cwd:root,input:JSON.stringify({kindRegistry,metadata}),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
  if(result.status!==0)throw new Error(`Managed CPython runtime-base compiler failed.\n${result.stderr||result.stdout}`);
  const parsed=JSON.parse(result.stdout);
  const bytes=Buffer.from(String(parsed.workbookBase64||''),'base64');
  if(parsed.descriptor?.schemaVersion!=='omnia.create-associate.runtime-workbook-base/v1'||parsed.descriptor.sha256!==sha256(bytes)||parsed.descriptor.sizeBytes!==bytes.length)throw new Error('Managed CPython runtime-base descriptor drifted.');
  return bytes;
};
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
const catalogIdentityRegistryBytes=await readFile(managedCatalogIdentityPath);
const catalogIdentityRegistry=JSON.parse(catalogIdentityRegistryBytes.toString('utf8'));
if(catalogIdentityRegistry?.schemaVersion!=='omnia.create-associate.risk-control-catalog-identities/v1'
  ||!Array.isArray(catalogIdentityRegistry.families)||!catalogIdentityRegistry.families.length){
  throw new Error('Managed Risk-Control catalog identity registry is invalid.');
}
if(!Array.isArray(catalogIdentityRegistry.compatibleFrozenGovernanceDigests)
  ||catalogIdentityRegistry.compatibleFrozenGovernanceDigests.some((entry)=>
    !entry||!/^[0-9a-f]{64}$/u.test(String(entry.semanticDigest||''))
      ||entry.scope!=='execution_catalog_alias_only'
      ||!String(entry.relationIdPrefix||'').trim()
      ||!String(entry.evidenceRef||'').trim())){
  throw new Error('Managed frozen-governance compatibility evidence is invalid.');
}
const relationIdInventory=new Set(parsed.relations.map((row)=>String(row.values.relation_id||'')));
const catalogIdentityByRelation=new Map();
const familyPrefixes=new Set();
for(const family of catalogIdentityRegistry.families){
  const prefix=String(family?.relationIdPrefix||'').trim();
  if(!prefix||familyPrefixes.has(prefix)||typeof family?.requiresExplicitCatalogControlNumber!=='boolean'
    ||!String(family?.status||'').trim()||!Array.isArray(family?.identities)){
    throw new Error(`Managed Risk-Control catalog identity family is invalid: ${prefix||'(missing)'}.`);
  }
  familyPrefixes.add(prefix);
  for(const identity of family.identities){
    const relationId=String(identity?.relationId||'').trim();
    const catalogControlNumber=String(identity?.catalogControlNumber||'').normalize('NFKC').trim();
    if(!relationId.startsWith(prefix)||!relationIdInventory.has(relationId)||catalogIdentityByRelation.has(relationId)
      ||!/^[\p{L}\p{N}][\p{L}\p{N} /_-]*\.\d{1,4}$/u.test(catalogControlNumber)
      ||!String(identity?.evidenceRef||'').trim()||!String(identity?.sourceTraceId||'').trim()){
      throw new Error(`Managed exact live Control identity is invalid: ${relationId||'(missing)'}.`);
    }
    catalogIdentityByRelation.set(relationId,{catalogControlNumber,evidenceRef:String(identity.evidenceRef).trim(),sourceTraceId:String(identity.sourceTraceId).trim()});
  }
  if(family.requiresExplicitCatalogControlNumber===true){
    const requiredIds=parsed.relations.filter((row)=>String(row.values.relation_id||'').startsWith(prefix)
      &&(row.values.link_required_higher==='Y'||row.values.link_required_lower==='Y')).map((row)=>String(row.values.relation_id)).sort();
    const suppliedIds=family.identities.map((identity)=>String(identity.relationId||'')).sort();
    const suppliedSet=new Set(suppliedIds);
    const complete=requiredIds.every((relationId)=>suppliedSet.has(relationId));
    if(suppliedIds.length>0&&!complete)throw new Error(`Managed exact live Control identity family is missing a required relation: ${prefix}.`);
    if(complete&&requiredIds.length>0&&family.status!=='signed_live_exact')throw new Error(`Complete live Control identity family is not marked signed_live_exact: ${prefix}.`);
    if(!suppliedIds.length&&!String(family.status).startsWith('blocked_'))throw new Error(`Empty live Control identity family must be explicitly blocked: ${prefix}.`);
  }
}
for(const entry of catalogIdentityRegistry.compatibleFrozenGovernanceDigests){
  const family=catalogIdentityRegistry.families.find((candidate)=>candidate.relationIdPrefix===entry.relationIdPrefix);
  if(!family||family.status!=='signed_live_exact'||!family.requiresExplicitCatalogControlNumber||!family.identities.length){
    throw new Error(`Frozen-governance compatibility scope has no complete signed live identity family: ${entry.relationIdPrefix}.`);
  }
}
const catalogIdentityFamilyFor=(relationId)=>{
  const matches=catalogIdentityRegistry.families.filter((family)=>relationId.startsWith(String(family.relationIdPrefix)));
  if(matches.length>1)throw new Error(`Risk-Control relation matches multiple catalog identity families: ${relationId}.`);
  return matches[0]||null;
};
const pendingRecordingContentValues = Object.freeze({
  APP: Object.freeze([{
    inputValue: 'Oracle EBS', expectedOmniaContentName: 'Oracle eBusiness Suite',
    status: 'recorded_exact_content_live_relation_readback_pending',
    evidenceRef: 'artifact:1c864692-7b02-498c-be5f-bf38adcab14f#sha256=b143e180ed8a59fdbf78e7d6170503739f0f3e320cc9632eb9af1383018d9801'
  }]),
  OS: Object.freeze([{
    inputValue: 'AD', expectedOmniaContentName: '通用操作系统', status: 'recorded_exact_content_and_relations',
    evidenceRef: 'artifact:7695dde4-5e93-4a10-acae-fc8a67087a35#sha256=e307939bf33a066e1218cded0e22955ce9cb47322d8f57a334011e84fb56045c'
  }]),
  TOOL: Object.freeze([{
    inputValue: '代码迁移工具', expectedOmniaContentName: '代码迁移工具', status: 'recorded_exact_content_and_relations',
    evidenceRef: 'artifact:04a5e0aa-bdcd-4b0c-8e6d-469425300633#sha256=6b65ff2db328bc72b7970a43dcfea40d90fa27a6af162fd9adaf8ef53e8f2597'
  }])
});
const pendingValuesByFieldId = new Map([
  ['P1.APP.GRA.GRA_CONTENT', pendingRecordingContentValues.APP.map((item) => item.inputValue)],
  ['P1.OS.GRA.GRA_CONTENT', pendingRecordingContentValues.OS.map((item) => item.inputValue)],
  ['P1.TOOL.GRA.GRA_CONTENT', pendingRecordingContentValues.TOOL.map((item) => item.inputValue)]
]);
const allowedValues = (fieldId) => [...new Set([
  ...String(parsed.fields.find((row) => row.values.field_id === fieldId)?.values['允许值'] || '')
    .split('|').map((value) => value.replace(/[（(].*$/u, '').trim()).filter(Boolean),
  ...(pendingValuesByFieldId.get(fieldId) || [])
])];
const governedAllowedValueDeclaration = (fieldId, rawValue) => {
  const additions = pendingValuesByFieldId.get(fieldId) || [];
  if (!additions.length) return rawValue;
  return [...new Set([...String(rawValue || '').split('|').map((value) => value.trim()).filter(Boolean), ...additions])].join('|');
};
const reviewField = (rawFieldKey, canonicalFieldId, label, inputKind, required, maxLength, allowed = []) =>
  ({ rawFieldKey, canonicalFieldId, label, inputKind, required, maxLength, allowedValues: allowed });
const kindRegistry = {
  APP: { objectType:'Application', objectSubtype:'Application', returnSupport:'supported', inheritRait:false, riskControlRequired:true, pendingRecordingContentValues:pendingRecordingContentValues.APP, id:'系统ID', relation:'', aliases:{'系统ID':'P1.APP.IT.ELEMENT_ID','APP类型':'P1.APP.GRA.GRA_CONTENT','Omnia工作区':'P1.APP.IT.WORKSPACE','System Risk Classification':'P1.APP.GRA.RAIT_CONCLUSION','Factors Considered':'P1.APP.GRA.FACTORS_CONSIDERED'}, reviewFields:[reviewField('系统ID','P1.APP.IT.ELEMENT_ID','元素ID','text',true,200),reviewField('APP类型','P1.APP.GRA.GRA_CONTENT','APP子类型','enum',true,120,allowedValues('P1.APP.GRA.GRA_CONTENT')),reviewField('System Risk Classification','P1.APP.GRA.RAIT_CONCLUSION','RAIT','enum',true,20,['Higher','Lower']),reviewField('Factors Considered','P1.APP.GRA.FACTORS_CONSIDERED','Factors Considered','text',true,8000),reviewField('Omnia工作区','P1.APP.IT.WORKSPACE','Omnia工作区','text',true,200)]},
  DB: { objectType:'Infrastructure', objectSubtype:'Database', returnSupport:'supported', inheritRait:true, riskControlRequired:false, id:'数据库ID', relation:'关联系统ID', aliases:{'数据库ID':'P1.DB.IT.ELEMENT_ID','DB 类型':'P1.DB.GRA.GRA_CONTENT','Omnia工作区':'P1.DB.IT.WORKSPACE','关联系统ID':'P1.DB.IT.APPLICATION_RELATION'}, reviewFields:[reviewField('数据库ID','P1.DB.IT.ELEMENT_ID','元素ID','text',true,200),reviewField('DB 类型','P1.DB.GRA.GRA_CONTENT','DB子类型','enum',true,120,allowedValues('P1.DB.GRA.GRA_CONTENT')),reviewField('Omnia工作区','P1.DB.IT.WORKSPACE','Omnia工作区','text',true,200),reviewField('关联系统ID','P1.DB.IT.APPLICATION_RELATION','关联系统ID','text',true,500),reviewField('Inherited System Risk Classification','P1.DB.GRA.RAIT_CONCLUSION','RAIT（只读继承）','readonly',false,20,['Higher','Lower'])]},
  OS: { objectType:'Infrastructure', objectSubtype:'OperatingSystem', returnSupport:'supported', inheritRait:true, riskControlRequired:false, pendingRecordingContentValues:pendingRecordingContentValues.OS, id:'服务器ID', relation:'关联系统ID', aliases:{'服务器ID':'P1.OS.IT.ELEMENT_ID','OS 类型':'P1.OS.GRA.GRA_CONTENT','Omnia工作区':'P1.OS.IT.WORKSPACE','关联系统ID':'P1.OS.IT.APPLICATION_RELATION'}, reviewFields:[reviewField('服务器ID','P1.OS.IT.ELEMENT_ID','元素ID','text',true,200),reviewField('OS 类型','P1.OS.GRA.GRA_CONTENT','OS子类型','enum',true,120,allowedValues('P1.OS.GRA.GRA_CONTENT')),reviewField('Omnia工作区','P1.OS.IT.WORKSPACE','Omnia工作区','text',true,200),reviewField('关联系统ID','P1.OS.IT.APPLICATION_RELATION','关联系统ID','text',true,500),reviewField('Inherited System Risk Classification','P1.OS.GRA.RAIT_CONCLUSION','RAIT（只读继承）','readonly',false,20,['Higher','Lower'])]},
  TOOL: { objectType:'ITTool', objectSubtype:'Tool', returnSupport:'supported', inheritRait:false, riskControlRequired:false, pendingRecordingContentValues:pendingRecordingContentValues.TOOL, id:'IT TOOL ID', relation:'关联APP系统ID', aliases:{'IT TOOL ID':'P1.TOOL.IT.ELEMENT_ID','Tool 类型':'P1.TOOL.GRA.GRA_CONTENT','Omnia工作区':'P1.TOOL.IT.WORKSPACE','System Risk Classification':'P1.TOOL.GRA.RAIT_CONCLUSION','关联APP系统ID':'P1.TOOL.IT.APPLICATION_RELATION'}, reviewFields:[reviewField('IT TOOL ID','P1.TOOL.IT.ELEMENT_ID','元素ID','text',true,200),reviewField('Tool 类型','P1.TOOL.GRA.GRA_CONTENT','Tool子类型','enum',true,120,allowedValues('P1.TOOL.GRA.GRA_CONTENT')),reviewField('System Risk Classification','P1.TOOL.GRA.RAIT_CONCLUSION','RAIT','enum',true,20,['Higher','Lower']),reviewField('Omnia工作区','P1.TOOL.IT.WORKSPACE','Omnia工作区','text',true,200),reviewField('关联APP系统ID','P1.TOOL.IT.APPLICATION_RELATION','关联 APP 系统 ID','text',true,500)]},
  DCNO: { objectType:'Infrastructure', objectSubtype:'Network', returnSupport:'supported', inheritRait:true, riskControlRequired:true, riskControlSupportedRaitValues:['Higher','Lower'], id:'DCNO ID', relation:'关联系统ID', aliases:{'DCNO ID':'P1.DCNO.IT.ELEMENT_ID','DCNO 类型':'P1.DCNO.GRA.GRA_CONTENT','Omnia工作区':'P1.DCNO.IT.WORKSPACE','关联系统ID':'P1.DCNO.IT.APPLICATION_RELATION'}, reviewFields:[reviewField('DCNO ID','P1.DCNO.IT.ELEMENT_ID','元素ID','text',true,200),reviewField('DCNO 类型','P1.DCNO.GRA.GRA_CONTENT','基础设施子类型','enum',true,120,['网络']),reviewField('Omnia工作区','P1.DCNO.IT.WORKSPACE','Omnia工作区','text',true,200),reviewField('关联系统ID','P1.DCNO.IT.APPLICATION_RELATION','关联系统ID','text',true,500),reviewField('Inherited System Risk Classification','P1.DCNO.GRA.RAIT_CONCLUSION','RAIT（只读继承）','readonly',false,20,['Higher','Lower'])]}
};
const kindCapabilityProfiles = {
  APP: { capabilities:{object:true,gra:true,settings:true,relation:false,directRait:true,inheritedRait:false,appScoring:true,riskControl:true,evaluation:true,aiReview:true}, stageNodes:['object','settings','gra','gra_state','app_category','app_scoring','documentation','risk_classification','risk_control','evaluation'] },
  DB: { capabilities:{object:true,gra:true,settings:false,relation:true,directRait:false,inheritedRait:true,appScoring:false,riskControl:true,evaluation:true,aiReview:false}, relationPolicy:{targetKind:'APP',min:1,max:200,relationType:'InfrastructureApplication',concurrencyTabId:602}, stageNodes:['object','relation','gra','inherited_rait','risk_classification','risk_control','evaluation'] },
  OS: { capabilities:{object:true,gra:true,settings:false,relation:true,directRait:false,inheritedRait:true,appScoring:false,riskControl:true,evaluation:true,aiReview:false}, relationPolicy:{targetKind:'APP',min:1,max:200,relationType:'InfrastructureApplication',concurrencyTabId:602}, stageNodes:['object','relation','gra','inherited_rait','risk_classification','risk_control','evaluation'] },
  TOOL: { capabilities:{object:true,gra:true,settings:false,relation:true,directRait:true,inheritedRait:false,appScoring:false,riskControl:true,evaluation:true,aiReview:false}, relationPolicy:{targetKind:'APP',min:1,max:200,relationType:'ItToolApplication',concurrencyTabId:802}, stageNodes:['object','relation','gra','gra_state','risk_classification','risk_control','evaluation'] },
  DCNO: { capabilities:{object:true,gra:true,settings:false,relation:true,directRait:false,inheritedRait:true,appScoring:false,riskControl:true,evaluation:true,aiReview:false}, relationPolicy:{targetKind:'APP',min:1,max:200,relationType:'InfrastructureApplication',concurrencyTabId:602}, stageNodes:['object','relation','gra','inherited_rait','risk_classification','risk_control','evaluation'] }
};
for (const [kind, spec] of Object.entries(kindRegistry)) {
  Object.assign(spec, kindCapabilityProfiles[kind]);
  spec.riskControlRequired = spec.capabilities.riskControl;
  spec.derivations = [{
    rawFieldKey: kind === 'APP' ? 'Derived Application Description' : `Derived ${kind} Description`,
    fieldId: `P1.${kind}.IT.DESCRIPTION`,
    ruleId: kind === 'APP' ? 'v8.app-description-from-element-id.v1' : `v4.${kind.toLocaleLowerCase('en-US')}-description-from-element-id.v1`,
    valueSource: 'element_id', sourceSheet: '字段母版'
  }];
}
kindRegistry.APP.derivations.push(
  {rawFieldKey:'Derived Application Is Relevant',fieldId:'P1.APP.IT.IS_RELEVANT',ruleId:'phase1.app-is-relevant-true.v2',valueSource:'constant_true',sourceSheet:'字段母版'},
  {rawFieldKey:'Derived Application Is Data Available',fieldId:'P1.APP.IT.IS_DATA_AVAILABLE',ruleId:'v4.app-is-data-available-false.v1',valueSource:'constant_false',sourceSheet:'V4接口证据'}
);
for (const spec of Object.values(kindRegistry)) for (const fieldId of Object.values(spec.aliases)) {
  if (!fieldIds.has(fieldId)) throw new Error(`Governance alias is not a V8 field_id: ${fieldId}`);
}
const governance = {
  schemaVersion: 'omnia.create-associate.governance/v1', sourceVersion: 'V8', sourceSha256: workerModule.V8_SHA256,
  importedAt: importMetadata.importedAt, sourceRef: 'ofp-member:backend/governance-source-v8.xlsx',
  sourceTemplateContract: { version:'V5', memberPath:'backend/Phase1-用户填写模板V5.xlsx', pendingRecordingContentValues },
  sheetCount: 9, fieldCount: parsed.fields.length, relationCount: parsed.relations.length, traceCount: parsed.traces.length, evidenceCount: parsed.evidence.length,
  sap: { higherRelations: 18, lowerRelations: 17, higherOnlyRelationId: 'REL.APP.SAP_ECC.RAITCOR001.SAP_03' },
  sapS4Hana: { higherRelations: 18, lowerRelations: 17, catalogModesShareExactIdentities: true, recordingId: '34ea8734-0d21-4ef2-88a5-6455ae94b8bd', eventCount: 1587 },
  oracleEbs: {
    higherRelations: 11, lowerRelations: 7, catalogRelations: 12,
    contentName: 'Oracle eBusiness Suite', recordedEvidenceCatalogKey: '66176468',
    recordedAppCategoryKey: '66175343', recordedContentType: 3,
    recordingId: '1df21175-b43f-4f25-99a5-3385e3c77097',
    liveRelationReadback: 'blocked_pending_live_relation_readback_non_execution_metadata'
  },
  activeDirectory: {
    contentName: '通用操作系统', inputValue: 'AD', recordingId: 'be62fb35-b396-400e-b63c-d0d258618c9b',
    risks: 6, higherRelations: 4, lowerRelations: 4, catalogModesShareExactIdentities: true
  },
  codeMigrationTool: {
    contentName: '代码迁移工具', recordingId: '8f74355b-c1f4-4b1c-a235-e34a06cd9704',
    risks: 3, higherRelations: 3, lowerRelations: 3, catalogModesShareExactIdentities: true
  },
  scoring: { items: parsed.scoreItems.length, appGenericBaseline: { items: 15, higherVerifiedWrites: 14, notApplicableItem: 'APP.RF.DISPLAY_ORDER_13' } },
  kindRegistry, catalogIdentityRegistry,
  fieldIds: [...fieldIds].sort(),
  fields: parsed.fields.map(({ sourceRow, values }) => ({
    sourceRow,
    fieldId: values.field_id, phase: values.Phase, objectType: values['场景/对象类型'], section: values['对象子类型/区段'],
    higherApplicable: values['Higher适用'], lowerApplicable: values['Lower适用'], label: values['Omnia UI标准字段名'],
    purpose: values['字段用途'], responsibility: values['填写责任/方式'], requiredRule: values['必填规则'],
    allowedValues: governedAllowedValueDeclaration(values.field_id, values['允许值']), evidenceType: values.evidence_type, v4Path: values['v4 JSON key/path'],
    operation: values['v4 endpoint+method / connector'], requestResponse: values['请求/响应位置'],
    evidenceStatus: values['证据状态/置信度'], validationRule: values['校验规则'], sourceTraceId: values.source_trace_id,
    notes: values['备注']
  })),
  relations: parsed.relations.map(({ values }) => {
    const relationId=String(values.relation_id||'');const family=catalogIdentityFamilyFor(relationId);const identity=catalogIdentityByRelation.get(relationId)||null;
    return {
    relationId, riskFieldId: values.risk_field_id, riskName: values['Risk标准名'],
    controlFieldId: values.control_field_id, controlName: values['Control标准名'], direction: values['关系类型/方向'],
    catalogIdentityRequired:family?.requiresExplicitCatalogControlNumber===true,
    catalogControlNumber:identity?.catalogControlNumber||'',
    catalogIdentityStatus:identity?'signed_live_exact':family?.requiresExplicitCatalogControlNumber===true?String(family.status):'legacy_governed_number',
    catalogIdentityEvidence:identity?{evidenceRef:identity.evidenceRef,sourceTraceId:identity.sourceTraceId}:null,
    catalogPresentHigher: values.catalog_present_higher, catalogPresentLower: values.catalog_present_lower,
    linkRequiredHigher: values.link_required_higher, linkRequiredLower: values.link_required_lower,
    classificationHigher: values.classification_higher, classificationLower: values.classification_lower,
    applicability: values['执行适用层级'], objectType: values['适用场景/对象类型'], required: values['是否必需'],
    missingDataPolicy: values['无资料时策略'], evidenceType: values['v4 evidence_type'], operation: values['v4 JSON/API/DOM/connector路径'],
    evidenceLocation: values['证据文件+行号'], evidenceStatus: values['确认状态'], sourceTraceId: values.source_trace_id,
    notes: values['备注']
  };}),
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
Object.assign(isRelevantDeclaration, { defaultRuleId: 'phase1.app-is-relevant-true.v2', defaultValue: true });
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
  ruleId: 'v4.dcno-description-from-element-id.v1', targetFieldId: 'P1.DCNO.IT.DESCRIPTION',
  dependencyFieldId: 'P1.DCNO.IT.ELEMENT_ID', algorithm: 'canonical_element_id', sourceTraceId: 'P1.REVIEW.DCNO_DESCRIPTION.v1'
}, {
  ruleId: 'phase1.app-is-relevant-true.v2', targetFieldId: 'P1.APP.IT.IS_RELEVANT',
  algorithm: 'constant_boolean_true', constantValue: true, sourceTraceId: 'P1.REQUIREMENT.APP_IS_RELEVANT_TRUE.2026-08-06'
}, {
  ruleId: 'v4.app-is-data-available-false.v1', targetFieldId: 'P1.APP.IT.IS_DATA_AVAILABLE',
  algorithm: 'constant_boolean_false', constantValue: false, sourceTraceId: 'v4:phase1:application:isDataAvailable=false'
}, {
  ruleId: 'v4.phase1-gra-name-from-element-id.v1', targetFieldId: 'P1.RUNTIME.GRA.NAME',
  dependencyFieldId: 'P1.RUNTIME.IT.ELEMENT_ID', algorithm: 'prefix_literal', prefix: 'GRA-', sourceTraceId: 'v4:omnia-phase1.js:716'
}];
governance.semanticDigest = sha256(Buffer.from(canonical({ kindRegistry: governance.kindRegistry, fields: governance.fields, relations: governance.relations, scoringItems: governance.scoringItems, derivationRules: governance.derivationRules })));
governance.managedGovernanceRef = 'ofp-member:backend/governance.json';
const finalGovernanceBytes = Buffer.from(JSON.stringify(governance, null, 2));
const runtimeBaseBytes = buildRuntimeBaseWithPython(kindRegistry,
  { runId: 'runtime-template-base', sourceArtifactId: 'none', governanceDigest: expectedV8Sha256 });

const xmlText = (value) => String(value || '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
  .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&').replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)));
const sourceTemplateContract = (bytes) => {
  const entries = workerModule.zipEntries(bytes);
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const strings = [...sharedXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/gu)].map((match) =>
    xmlText([...match[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gu)].map((part) => part[1]).join(''))
  );
  const worksheets = [...entries.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name));
  if (worksheets.length !== 1) throw new Error('Phase1 user template V5 must contain exactly one worksheet.');
  const xml = worksheets[0][1].toString('utf8');
  const cells = new Map();
  for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/gu)) {
    const ref = match[1].match(/\br="([A-Z]+\d+)"/u)?.[1];
    if (!ref) continue;
    const type = match[1].match(/\bt="([^"]+)"/u)?.[1] || '';
    const body = match[2] || '';
    const raw = body.match(/<(?:[A-Za-z_][\w.-]*:)?v>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/u)?.[1];
    const inline = body.match(/<(?:[A-Za-z_][\w.-]*:)?is>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/u)?.[1];
    const value = type === 's' && raw !== undefined ? strings[Number(raw)] || ''
      : type === 'inlineStr' && inline ? xmlText([...inline.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gu)].map((part) => part[1]).join(''))
        : xmlText(raw || '');
    cells.set(ref, value);
  }
  const validations = [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?dataValidation\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?dataValidation>/gu)].map((match) => ({
    sqref: xmlText(match[1].match(/\bsqref="([^"]+)"/u)?.[1] || ''),
    formula: xmlText(match[2].match(/<(?:[A-Za-z_][\w.-]*:)?formula1>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?formula1>/u)?.[1] || '')
  }));
  return { cells, validations };
};

// The downloadable source template is consumed only from the Feature-managed
// location. The workbook owner stages the audited V5 bytes there; packaging
// neither copies nor silently falls back to an external binary.
const userTemplateBytes = await readFile(managedUserTemplatePath);
if (userTemplateBytes.length < 1 || userTemplateBytes.length > 64 * 1024 * 1024) throw new Error('Phase1 user template V5 size is invalid.');
const userTemplate = sourceTemplateContract(userTemplateBytes);
const exactHeaders = new Map([
  ['B22','系统ID'],['C22','APP类型'],['D22','System Risk Classification'],['E22','Factors Considered'],['F22','Omnia工作区'],
  ['B39','DCNO ID'],['C39','DCNO 类型'],['D39','Omnia工作区'],['E39','关联系统ID'],
  ['B45','IT TOOL ID'],['C45','Tool 类型'],['D45','System Risk Classification'],['E45','Omnia工作区'],['F45','关联APP系统ID']
]);
for (const [cell, expected] of exactHeaders) if (userTemplate.cells.get(cell) !== expected) {
  throw new Error(`Phase1 user template V5 header drifted at ${cell}; expected ${expected}.`);
}
if (!userTemplate.cells.has('F46') || !userTemplate.cells.has('F47')) {
  throw new Error('Phase1 user template V5 Tool APP-relation input cells F46:F47 are missing.');
}
const validationCovers = (sqref, cell) => sqref.split(/\s+/u).some((token) => {
  if (token === cell) return true;
  const range = token.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/u);
  const target = cell.match(/^([A-Z]+)(\d+)$/u);
  return Boolean(range && target && range[1] === target[1] && range[3] === target[1]
    && Number(range[2]) <= Number(target[2]) && Number(target[2]) <= Number(range[4]));
});
const expectedAppTypes = ['Generic','SAP ECC','SAP S/4 HANA','Oracle EBS'];
for (const inputCell of ['C23','C24']) {
  const covering = userTemplate.validations.filter((item) => validationCovers(item.sqref, inputCell));
  const declared = covering[0]?.formula.replace(/^"|"$/gu, '').split(',') || [];
  if (covering.length !== 1 || canonical(declared) !== canonical(expectedAppTypes)) {
    throw new Error(`Phase1 user template V5 APP type validation must be unique and exact at ${inputCell}.`);
  }
}
if (!userTemplate.validations.some((item) => item.formula.replace(/^"|"$/gu, '').split(',').includes('网络') && validationCovers(item.sqref, 'C40'))) {
  throw new Error('Phase1 user template V5 DCNO type validation does not require 网络.');
}
for (const inputCell of ['C35','C36']) if (!userTemplate.validations.some((item) => validationCovers(item.sqref, inputCell) && item.formula.replace(/^"|"$/gu, '').split(',').includes('AD'))) {
  throw new Error(`Phase1 user template V5 OS type validation does not expose AD at ${inputCell}.`);
}
for (const inputCell of ['C46','C47']) if (!userTemplate.validations.some((item) => validationCovers(item.sqref, inputCell) && item.formula.includes('代码迁移工具'))) {
  throw new Error(`Phase1 user template V5 Tool type validation does not expose 代码迁移工具 at ${inputCell}.`);
}
const version = '0.2.138'; const sequence = 140;
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
  { operationId: 'omnia.create-associate.risk-factor-category.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-factor-category-preflight-request/v1', responseSchema: 'omnia.create-associate.risk-factor-category-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.risk-factor-category.patch.v1', routes: [
    route('risk-factor-category-assessment-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-factor-category-directory', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factors/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false&includeDeletedSuffix=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-factor-category-read', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factor-categories/{categoryId}', [{ name: 'categoryId', type: 'guid' }])
  ] },
  { operationId: 'omnia.create-associate.risk-factor-category.patch.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.risk-factor-category-patch-request/v1', responseSchema: 'omnia.create-associate.risk-factor-category-patch-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [
    route('risk-factor-category-mutation-assessment-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-factor-category-mutation-directory', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factors/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false&includeDeletedSuffix=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-factor-category-mutation-read', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factor-categories/{categoryId}', [{ name: 'categoryId', type: 'guid' }]),
    route('risk-factor-category-patch', 'PATCH', '/rapr/v0/engagements/{engagementId}/risk-factor-categories/{categoryId}', [{ name: 'categoryId', type: 'guid' }], 'signed_json')
  ] },
  { operationId: 'omnia.create-associate.risk-factor-category.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-factor-category-reconcile-request/v1', responseSchema: 'omnia.create-associate.risk-factor-category-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('risk-factor-category-assessment-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-factor-category-directory', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factors/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false&includeDeletedSuffix=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-factor-category-read', 'GET', '/rapr/v0/engagements/{engagementId}/risk-factor-categories/{categoryId}', [{ name: 'categoryId', type: 'guid' }])
  ] },
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
  { operationId: 'omnia.create-associate.risk-classification.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-classification-preflight-request/v1', responseSchema: 'omnia.create-associate.risk-classification-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.risk-classification.patch.v1', routes: [
    route('risk-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-assessment-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])
  ] },
  { operationId: 'omnia.create-associate.risk-classification.patch.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.risk-classification-patch-request/v1', responseSchema: 'omnia.create-associate.risk-classification-patch-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [
    route('risk-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-assessment-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-classification-patch', 'PATCH', '/rapr/v0/engagements/{engagementId}/risks/{riskId}', [{ name: 'riskId', type: 'guid' }], 'signed_json')
  ] },
  { operationId: 'omnia.create-associate.risk-classification.reconcile.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-classification-reconcile-request/v1', responseSchema: 'omnia.create-associate.risk-classification-reconcile-response/v1', enabledByDefault: true, grantsMutationPermit: false, routes: [
    route('risk-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-assessment-read', 'GET', '/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}', [{ name: 'riskAssessmentId', type: 'guid' }])
  ] },
  { operationId: 'omnia.create-associate.risk-control.preflight.v1', effect: 'read_only', requestSchema: 'omnia.create-associate.risk-control-preflight-request/v1', responseSchema: 'omnia.create-associate.risk-control-preflight-response/v1', enabledByDefault: true, grantsMutationPermit: true, permitsOperationId: 'omnia.create-associate.risk-control.associate.v1', routes: [route('risk-control-validation', 'POST', '/rapr/v0/engagements/{engagementId}/controls/validateHiddenDataForRiskAssociation?riskId={riskId}&operation=AddAssociation&riskClassification={riskClassification}', [{ name: 'riskId', type: 'guid' }, { name: 'riskClassification', type: 'string' }], 'signed_json')] },
  { operationId: 'omnia.create-associate.risk-control.associate.v1', effect: 'omnia_mutation', requestSchema: 'omnia.create-associate.risk-control-associate-request/v1', responseSchema: 'omnia.create-associate.risk-control-associate-response/v1', enabledByDefault: false, grantsMutationPermit: false, routes: [
    route('risk-catalog', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false', [{ name: 'riskAssessmentId', type: 'guid' }]),
    route('risk-control-detail', 'GET', '/rapr/v0/engagements/{engagementId}/plannedresponse/GetPlanResponseDetailByRiskRiskScopeId?riskriskScopeId={riskRiskScopeId}&reviewMode=false&controlExpanded=false&procedureExpanded=false', [{ name: 'riskRiskScopeId', type: 'guid' }]),
    route('risk-control-validation', 'POST', '/rapr/v0/engagements/{engagementId}/controls/validateHiddenDataForRiskAssociation?riskId={riskId}&operation=AddAssociation&riskClassification={riskClassification}', [{ name: 'riskId', type: 'guid' }, { name: 'riskClassification', type: 'string' }], 'signed_json'),
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
const pythonMemberPaths = [
  'python/canonical.py', 'python/create-associate-engine.py', 'python/errors.py', 'python/ooxml.py',
  'python/plan_ir.py', 'python/protocol.py', 'python/security.py', 'python/workbook_compile.py'
];
const pythonFiles = await Promise.all(pythonMemberPaths.map(async (memberPath) => ({
  path: memberPath,
  bytes: await readFile(path.join(source, ...memberPath.split('/')))
})));
const capabilityFixtureBytes=await readFile(path.join(testSource,'capability-fixtures.json'));
const capabilityFixtures=JSON.parse(capabilityFixtureBytes.toString('utf8'));
const pythonContractBytes=await readFile(path.join(testSource,'capability_contract.py'));
const workerContractBytes=await readFile(path.join(testSource,'worker_contract.cjs'));
const sourceFixtureVectors=[
  ...capabilityFixtures.pythonCases.map((item,index)=>({testId:item.testId,inputRef:`tests/capability-fixtures.json#pythonCases/${index}`,runnerRef:'tests/capability_contract.py'})),
  ...capabilityFixtures.workerCases.map((item,index)=>({testId:item.testId,inputRef:`tests/capability-fixtures.json#workerCases/${index}`,runnerRef:'tests/worker_contract.cjs'}))
];
const sourceFixtureTestIds=sourceFixtureVectors.map((item)=>item.testId);
if(new Set(sourceFixtureTestIds).size!==sourceFixtureTestIds.length)throw new Error('Capability fixture test IDs must be unique.');
const packageTestIds=['package-identity-and-governance','package-app-relevance-contract','package-nested-operation-contract','package-app-category-directory-contract','package-python-member-contract'];
const runtimeContract={schemaVersion:'omnia.feature-runtime-contract/v1',featureId:'omnia.create-associate',featureVersion:version,
  inputs:['staged_xlsx_artifact','upload_confirmation','background_validation','issue_revisions','ai_provider_review','return_confirmation','legacy_return_recovery_confirmation','connector_binding','workspace_safety'],outputs:['template_instance_xlsx','surface_patch','confirmation_card','legacy_return_recovery_outcome','managed_object_revisions','managed_relation_revisions'],
  events:['artifact.staging_replaced','workbook.upload_confirmed','run.transition','run.offline_crash_recovered','run.restart_requested','return.confirmation_invalidated','return.confirmed_in_comments','return.readback_verified','return.uncertain','return.force_cancelled','return.partial_closed_for_reimport'],
  errors:['WORKBOOK.*','GOVERNANCE.*','AI.REVIEW.*','RETURN.*','CONNECTOR.RESPONSE_LOST'],
  aiReviewCapabilities:[{capabilityId:'factors_considered_quality/v1',requestSchemaVersion:'omnia.feature-ai-review-request/v1',maxRequestBytes:1024*1024}],
  storePorts:[
    'approveReturnIntent','authorizeLegacyReturnRecovery','closeLegacyPartialReturn','commitPythonOutputHandle',
    'commitReviewValidation','createPythonJsonInputHandle','createPythonOutputHandle','finishReturn',
    'freezeReturnEvidenceSpec','inspectLegacyReturnRecovery','loadLatestRun','loadPlan','loadReturnProgress',
    'loadReturnReconcileSpec','openPythonArtifactHandle','prepareReturnCommand','prepareReturnIntent',
    'projectVerifiedReturn','proveOwnedCreatedObject','readArtifactBytes','readPythonJsonHandle',
    'recordBootstrapCapabilityEvidence','recordFieldRevisions','recordIssues','recordLegacyReturnRecoveryOutcome',
    'recordReturnEvidence','recordTemplateMetadata','releasePythonArtifactHandles','restartRun','returnRunToReview',
    'savePlan','saveReturnReconcileSpec','transitionRun','validateReturnAuthority'
  ],
  pythonSidecar:{schemaVersion:'omnia.python-sidecar-runtime/v1',implementation:'cpython',version:'3.13.14',architecture:'win32-x64',protocol:'omnia.python-sidecar-rpc/v1',bridgePath:'middle/create-associate-python-bridge.cjs',entryPath:'python/create-associate-engine.py',members:pythonMemberPaths,maxFrameBytes:1024*1024,heartbeatIntervalMs:5000,heartbeatTimeoutMs:15000}};
const implementationMap={schemaVersion:'omnia.feature-implementation-map/v1',featureId:'omnia.create-associate',featureVersion:version,planes:{
  surface:['frontend/surface.json'],worker:['middle/worker.cjs','middle/create-associate-python-bridge.cjs',...pythonMemberPaths],store:['backend/migrations/001.json','contracts/feature-runtime.json'],connector:['connector-capability/operation.ofop']},
  operations:operations.map(({operationId,effect})=>({operationId,effect}))};
const testVectors={schemaVersion:'omnia.feature-test-vectors/v1',featureId:'omnia.create-associate',vectors:[
  ...packageTestIds.map((testId)=>({testId,inputRef:`tests/self-test.cjs#${testId}`,expected:'pass'}))
]};
const testsManifest={schemaVersion:'omnia.feature-tests-manifest/v1',featureId:'omnia.create-associate',featureVersion:version,testIds:packageTestIds,vectorsPath:'tests/vectors.json',selfTestPath:'tests/self-test.cjs',status:'declared',command:'node tests/self-test.cjs'};
const packagedSelfTest="'use strict';\nconst fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');\nconst root=path.resolve(__dirname,'..'),worker=require(path.join(root,'middle','worker.cjs'));\nfunction check(value,message){if(!value)throw new Error(message);}\nfunction run(executable,args){const result=cp.spawnSync(executable,args,{cwd:root,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});if(result.status!==0)throw new Error('subprocess failed: '+executable+' '+args.join(' ')+'\\n'+(result.stderr||result.stdout));return result.stdout;}\nasync function main(){\n  const v8=fs.readFileSync(path.join(root,'backend','governance-source-v8.xlsx'));\n  const governance=JSON.parse(fs.readFileSync(path.join(root,'backend','governance.json'),'utf8'));\n  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));\n  const runtime=JSON.parse(fs.readFileSync(path.join(root,'contracts','feature-runtime.json'),'utf8'));\n  const operation=JSON.parse(fs.readFileSync(path.join(root,'connector-capability','operation.ofop'),'utf8'));\n  const parsed=worker.parseV8(v8);\n  const digest=crypto.createHash('sha256').update(v8).digest('hex').toUpperCase();\n  check(digest===worker.V8_SHA256&&parsed.fields.length===governance.fieldCount&&parsed.relations.length===governance.relationCount&&parsed.traces.length===governance.traceCount&&parsed.evidence.length===governance.evidenceCount&&parsed.scoreItems.length===governance.scoring.items,'package-identity-and-governance failed');\n  check(manifest.featureId==='omnia.create-associate'&&manifest.version==='0.2.78'&&manifest.sequence===80&&operation.packageId==='omnia.create-associate.operation'&&operation.version===manifest.version,'package identity/version failed');\n  const sourceTemplate=manifest.assets.find((item)=>item.kind==='source_template');\n  check(sourceTemplate&&fs.statSync(path.join(root,...sourceTemplate.path.split('/'))).isFile(),'source template asset missing');\n  const relevanceRule=governance.derivationRules.find((rule)=>rule.ruleId==='phase1.app-is-relevant-true.v2');\n  const relevanceField=governance.fields.find((field)=>field.fieldId==='P1.APP.IT.IS_RELEVANT');\n  const relevanceDerivation=governance.kindRegistry.APP.derivations.find((item)=>item.fieldId==='P1.APP.IT.IS_RELEVANT');\n  check(relevanceRule&&relevanceRule.algorithm==='constant_boolean_true'&&relevanceRule.constantValue===true&&relevanceField.defaultValue===true&&relevanceField.defaultRuleId===relevanceRule.ruleId&&relevanceDerivation.valueSource==='constant_true'&&relevanceDerivation.ruleId===relevanceRule.ruleId,'package-app-relevance-contract failed');\n  check(governance.kindRegistry.DCNO.returnSupport==='unsupported_pending_official_network_evidence'&&['object','gra','settings','relation','directRait','appScoring','riskControl','evaluation','aiReview'].every((capability)=>governance.kindRegistry.DCNO.capabilities[capability]===false),'DCNO fail-close drifted');\n  const operationMember=operation.files.find((item)=>item.path==='operation/handler.cjs');\n  check(operationMember&&operationMember.contentBase64,'nested Operation handler missing');\n  const handlerBytes=Buffer.from(operationMember.contentBase64,'base64');\n  check(handlerBytes.length===operationMember.size&&crypto.createHash('sha256').update(handlerBytes).digest('hex')===operationMember.sha256,'nested Operation handler integrity failed');\n  const compiled={exports:{}};\n  new Function('module','exports',handlerBytes.toString('utf8'))(compiled,compiled.exports);\n  check(typeof compiled.exports.createOperationHandler==='function','nested Operation handler export failed');\n  const handler=compiled.exports.createOperationHandler();\n  const engagementId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',objectId='33333333-3333-4333-8333-333333333333',workItemId='44444444-4444-4444-8444-444444444444';\n  const request={target:{targetIdentityKey:'package-app-settings',workspaceId},command:{commandId:'55555555-5555-4555-8555-555555555555',idempotencyKey:'a'.repeat(64),kind:'patch_object_settings',payload:{engagementId,workspaceId,objectId,typeId:'APP-TYPE-GENERIC',isRelevant:true,isDataAvailable:false,mode:'create_bootstrap'}}};\n  let wroteTrue=false;\n  const sdk={binding:{engagementId},invokeStep:async(stepId,params,body)=>{\n    if(stepId==='object-settings-mutation-read')return{id:objectId,workItemId,itElementType:'Application',typeId:null,isRelevant:null,isDataAvailable:null,concurrencyTabs:[]};\n    if(stepId==='object-settings-mutation-workspace')return[{facetId:workspaceId}];\n    if(stepId==='object-settings-type-patch'){wroteTrue=body.some((item)=>item.path==='/isRelevant'&&item.value===true);return{id:objectId,itElementType:'Application',typeId:'APP-TYPE-GENERIC',isRelevant:true,concurrencyTabs:[{entityTabTypeId:501,updatedOn:'2026-08-06T12:00:00.000Z'}]};}\n    if(stepId==='object-settings-data-patch')return{ok:true};\n    throw new Error('unexpected Operation self-test step: '+stepId);\n  }};\n  await handler.run('omnia.create-associate.object-settings.patch.v1',request,sdk);\n  check(wroteTrue,'package-nested-operation-contract failed');\n  const python=process.env.OMNIA_PYTHON_EXECUTABLE||process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE||'python';\n  const pythonMembers=runtime.pythonSidecar.members.map((member)=>path.join(root,...member.split('/')));\n  for(const member of pythonMembers)check(fs.statSync(member).isFile(),'signed Python member missing: '+member);\n  const pythonCode=\"import pathlib,sys\\nassert sys.version_info[:3]==(3,13,14),sys.version\\nfor name in sys.argv[1:]: compile(pathlib.Path(name).read_text(encoding='utf-8'),name,'exec')\\nprint(sys.version.split()[0])\";\n  const pythonVersion=run(python,['-I','-S','-c',pythonCode,...pythonMembers]).trim();\n  check(pythonVersion==='3.13.14','package-python-member-contract failed');\n  process.stdout.write('omnia.create-associate package self-test passed (4 declared checks; CPython '+pythonVersion+')\\n');\n}\nmain().catch((error)=>{process.stderr.write(String(error&&error.stack||error)+'\\n');process.exitCode=1;});\n";
const finalizedPackagedSelfTest = packagedSelfTest
  .replace("manifest.version==='0.2.78'&&manifest.sequence===80", `manifest.version==='${version}'&&manifest.sequence===${sequence}`)
  .replace("check(governance.kindRegistry.DCNO.returnSupport==='unsupported_pending_official_network_evidence'&&['object','gra','settings','relation','directRait','appScoring','riskControl','evaluation','aiReview'].every((capability)=>governance.kindRegistry.DCNO.capabilities[capability]===false),'DCNO fail-close drifted')", "check(governance.kindRegistry.DCNO.returnSupport==='supported'&&governance.kindRegistry.DCNO.riskControlSupportedRaitValues.join(',')==='Higher,Lower'&&['object','gra','relation','inheritedRait','riskControl','evaluation'].every((capability)=>governance.kindRegistry.DCNO.capabilities[capability]===true)&&['settings','directRait','appScoring','aiReview'].every((capability)=>governance.kindRegistry.DCNO.capabilities[capability]===false),'DCNO signed capability drifted')")
  .replace("  check(wroteTrue,'package-nested-operation-contract failed');\n", `  check(wroteTrue,'package-nested-operation-contract failed');
  const riskAssessmentId='66666666-6666-4666-8666-666666666666',categoryId='77777777-7777-4777-8777-777777777777',categoryName='IT风险评估（如果测试运行有效性）';
  const categorySdk={binding:{engagementId},invokeStep:async(stepId)=>{
    if(stepId==='risk-factor-category-assessment-read')return{id:riskAssessmentId,workspaceId,type:'Application',isDeleted:false};
    if(stepId==='risk-factor-category-directory')return{riskFactors:[
      {id:'90000000-0000-4000-8000-000000000001',riskAssessmentId,workspaceId,riskFactorGrouping:{'$id':'3',id:categoryId,name:categoryName,riskAssessmentId,workspaceId,applicable:true,isDeleted:false,updatedOn:'2026-08-06T12:00:00.000Z',description:'first snapshot'}},
      {id:'90000000-0000-4000-8000-000000000002',riskFactorEvaluationId:riskAssessmentId,workspaceFacetId:workspaceId,riskFactorGrouping:{'$id':'19',id:categoryId,name:' '+categoryName+' ',riskFactorEvaluationId:riskAssessmentId,workspaceFacetId:workspaceId,applicable:true,deleted:false,updatedOn:'2026-08-06T12:00:09.000Z',description:'second snapshot'}}
    ]};
    if(stepId==='risk-factor-category-read')return{id:categoryId,name:categoryName,riskAssessmentId,workspaceId,applicable:true,isDeleted:false,updatedOn:'2026-08-06T12:00:10.000Z'};
    throw new Error('unexpected APP category self-test step: '+stepId);
  }};
  const categoryResult=await handler.run('omnia.create-associate.risk-factor-category.preflight.v1',{target:{targetIdentityKey:'package-app-category',workspaceId},query:{riskAssessmentId,categoryId:'',categoryName,objectType:'Application'}},categorySdk);
  check(categoryResult.categoryId===categoryId&&categoryResult.applicable===true,'package-app-category-directory-contract failed');
`)
  .replace('(4 declared checks;', '(5 declared checks;');
if (finalizedPackagedSelfTest === packagedSelfTest) throw new Error('Packaged self-test patching did not apply.');
const featureManifest = {
  schemaVersion: 'omnia.feature-manifest/v1', featureId: 'omnia.create-associate', version, sequence, displayName: '新建与关联', minimumShellVersion: '0.4.15',
  recoveryCompatibility:{schemaVersion:'omnia.feature-recovery-compatibility/v1',mode:'partial_close_no_reuse',sourceFeatureVersions:['0.2.60'],actionId:'recover-interrupted-run'},
  requiredIsolation: 'process', storeNamespace: 'create_associate', migrationPath: 'backend/migrations/001.json', surfacePath: 'frontend/surface.json', workerPath: 'middle/worker.cjs', operationPackagePath: 'connector-capability/operation.ofop',
  contractsPath:'contracts/feature-runtime.json',implementationMapPath:'contracts/implementation-map.json',testsManifestPath:'tests/manifest.json',
  assets: [
    { path: 'backend/governance.json', sha256: sha256(finalGovernanceBytes), kind: 'governance' },
    { path: 'backend/governance-source-v8.xlsx', sha256: sha256(v8Bytes), kind: 'governance' },
    { path: 'backend/runtime-template-base.xlsx', sha256: sha256(runtimeBaseBytes), kind: 'runtime_template_base' }
    ,{ path: 'backend/Phase1-用户填写模板V5.xlsx', sha256: sha256(userTemplateBytes), kind: 'source_template' }
  ],
  navigation: {
    groups: [{ id: 'it-elements', parentId: null, level: 1, label: 'IT元素', order: 10 }],
    leaves: [{ id: 'create-associate', parentId: 'it-elements', level: 2, label: '新建与关联', order: 10,
      featureId: 'omnia.create-associate', featureVersion: version, route: 'feature:omnia.create-associate/workbench' }]
  }
};
const surface = {
  schemaVersion: 'omnia.declarative-feature-surface/v1', featureId: 'omnia.create-associate', featureVersion: version, surfaceId: 'create-associate.workbench', stateVersion: 1,
  title: '新建与关联', description: '导入真实 Phase 1 用户资料，完成本地校验后按确认回传当前 Pack。', density: 'compact', status: 'idle', statusMessage: '上传与本地校验无需 Remote 或安全锁；只有回传写入需要连接与安全锁。', scopes: [], items: [], selectedItemIds: [], search: '', artifacts: [], editors: [], issues: [],
  lifecycle:{schemaVersion:'omnia.declarative-feature-surface-lifecycle/v1',onReopenActionId:'fresh-start-on-reopen'},
  workflow:{revision:1,currentStepId:'upload',steps:[{stepId:'upload',label:'上传资料',state:'current',detail:'上传系统信息'},{stepId:'validate',label:'校验',state:'pending',detail:'等待上传'},{stepId:'return',label:'回传',state:'pending',detail:'等待校验通过'}]},
  actions: [
    { actionId: 'download-source-template', label: '下载模板', effect: 'read_only', enabled: false, reason: '正在检查可恢复的中断 Run。', presentation: 'upload', selectionMode: 'none', dependencies: [], output: { kind: 'save_managed_asset', memberPath: 'backend/Phase1-用户填写模板V5.xlsx', suggestedName: 'Phase1-用户填写模板V5.xlsx' } },
    { actionId: 'stage-source-workbook', label: '选择系统信息', effect: 'local_state_write', enabled: false, reason: '正在检查可恢复的中断 Run。', presentation: 'file_input', selectionMode: 'none', dependencies: [], input: { kind: 'open_file', accept: ['.xlsx'], label: '选择 Phase 1 系统信息' } },
    { actionId: 'confirm-upload', label: '确认上传', effect: 'local_state_write', enabled: false, reason: '请先选择或拖入一个 .xlsx 文件。', presentation: 'upload', pendingPresentation: { schemaVersion: 'omnia.declarative-action-pending-presentation/v1', title: '正在进入校验', message: '确认上传请求已发送；正在等待后台持久化 processing 状态。', workflowStepId: 'validate' }, selectionMode: 'none', dependencies: [] },
    { actionId: 'validate-staged-upload', label: '后台校验', effect: 'local_state_write', enabled: false, reason: '等待确认上传。', presentation: 'background', selectionMode: 'none', dependencies: [] },
    { actionId: 'apply-revisions', label: '保存修改并重新检查', effect: 'local_state_write', enabled: false, reason: '等待 Review。', selectionMode: 'none', dependencies: [] },
    { actionId: 'remove-batch-row', label: '仅从本批移除当前行', effect: 'local_state_write', enabled: false, reason: '等待 Review。', selectionMode: 'none', dependencies: [] },
    { actionId: 'revalidate-all', label: '重新检查全部', effect: 'local_state_write', enabled: false, reason: '等待 Review。', selectionMode: 'none', dependencies: [] },
    { actionId: 'back-to-upload', label: '返回上一步', effect: 'local_state_write', enabled: false, reason: '当前已是第一步，没有可返回的上一步。', selectionMode: 'none', dependencies: [] },
    { actionId: 'recover-interrupted-run', label: '恢复中断 Run', effect: 'local_state_write', visible: false, enabled: false, reason: '恢复上传已暂停；请使用正常上传流程。', presentation: 'upload', selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'], input: { kind: 'toggle', fieldKey: 'authorize-legacy-recovery', label: '我确认仅执行只读核验并关闭旧中断 Run，随后重新上传已更换元素名称的文件', defaultValue: false } },
    { actionId: 'fresh-start-on-reopen', label: '重新打开时结束旧流程', effect: 'local_state_write', visible: false, enabled: false, reason: '当前没有可结束的旧流程。', presentation: 'background', selectionMode: 'none', dependencies: [] },
    { actionId: 'restart-run', label: '结束旧流程并全新开始', effect: 'local_state_write', enabled: false, reason: '当前没有可结束的旧流程。', presentation: 'restart', selectionMode: 'none', dependencies: [] },
    { actionId: 'prepare-return', label: '提交审核', effect: 'local_state_write', enabled: false, reason: '完成处理与问题修订后可用。', pendingPresentation: { schemaVersion: 'omnia.declarative-action-pending-presentation/v1', title: '正在提交审核', message: '正在通过 Remote Connector 复核实时对象、安全锁与回传范围；后台冻结计划后才会开放确认回传。', workflowStepId: 'return' }, selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'], input: { kind: 'toggle', fieldKey: 'continue_on_isolated_failure', label: '单项异常时继续其余回传', defaultValue: true } },
    { actionId: 'confirm-return', label: '确认回传', effect: 'omnia_mutation', enabled: false, reason: '请先提交审核并冻结回传计划。', presentation: 'return', pendingPresentation: { schemaVersion: 'omnia.declarative-action-pending-presentation/v1', title: '正在确认回传', message: '正在重新校验安全锁、Connector 会话与冻结计划；后台确认通过后才会开始写入。', workflowStepId: 'return' }, selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] },
    { actionId: 'continue-return', label: '继续回传', effect: 'omnia_mutation', enabled: false, reason: '当前没有可继续的冻结计划。', presentation: 'return', pendingPresentation: { schemaVersion: 'omnia.declarative-action-pending-presentation/v1', title: '正在继续回传', message: '正在从持久化回传计划中继续处理尚未完成的项目。', workflowStepId: 'return' }, selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] },
    { actionId: 'reconcile-return', label: '只读核验', effect: 'read_only', enabled: false, reason: '当前没有待核验的写入结果。', presentation: 'return', pendingPresentation: { schemaVersion: 'omnia.declarative-action-pending-presentation/v1', title: '正在只读核验', message: '正在只读核验不确定结果；不会重放写入。', workflowStepId: 'return' }, selectionMode: 'none', dependencies: ['remote_connector', 'safety_lock'] }
  ]
};
const migration = { schemaVersion: 'omnia.feature-private-migration/v1', namespace: 'create_associate', version: 1, tables: [{ name: 'create_associate_runtime_plans', columns: [{ name: 'plan_id', type: 'TEXT', notNull: true, primaryKey: true }, { name: 'payload_json', type: 'TEXT', notNull: true, primaryKey: false }, { name: 'updated_at', type: 'TEXT', notNull: true, primaryKey: false }] }] };
let worker = await readFile(path.join(source, 'middle', 'worker.cjs'), 'utf8');
if ((worker.match(/saveReturnReconcileSpec/gu) || []).length < 3
  || (worker.match(/noMutation:\s*true/gu) || []).length < 2
  || !worker.includes("commandKind: 'verify_existing'")) {
  throw new Error('Create reuse/read-only closure durable command-spec contract is missing.');
}
worker = worker.replaceAll('__FEATURE_VERSION__', version).replace('__GOVERNANCE_JSON__', JSON.stringify(governance).replaceAll('\\', '\\\\').replaceAll("'", "\\'"));
const featurePackage = envelope({
  product: 'omnia-feature', packageId: featureManifest.featureId, version, sequence, keyId: 'omnia-v5-official-feature-2026-01', privateKey: featurePrivateKey,
  files: [
    file('SIGNATURE.json', JSON.stringify({ schemaVersion: 'omnia.package-signature-metadata/v1', scope: 'feature', keyId: 'omnia-v5-official-feature-2026-01' })),
    file('backend/migrations/001.json', JSON.stringify(migration, null, 2)),
    file('backend/governance.json', finalGovernanceBytes), file('backend/governance-source-v8.xlsx', v8Bytes),
    file('backend/runtime-template-base.xlsx', runtimeBaseBytes),
    file('backend/Phase1-用户填写模板V5.xlsx', userTemplateBytes),
    file('connector-capability/operation.ofop', JSON.stringify(operationPackage)),
    file('contracts/feature-runtime.json',JSON.stringify(runtimeContract,null,2)),file('contracts/implementation-map.json',JSON.stringify(implementationMap,null,2)),
    ...documentationFiles.map((document) => file(document.path, document.bytes)), file('docs/manifest.json', JSON.stringify(docsManifest, null, 2)),
    file('frontend/surface.json', JSON.stringify(surface, null, 2)), file('manifest.json', JSON.stringify(featureManifest, null, 2)), file('middle/worker.cjs', worker),
    file('middle/create-associate-python-bridge.cjs', await readFile(path.join(source, 'middle', 'create-associate-python-bridge.cjs'))),
    ...pythonFiles.map((member) => file(member.path, member.bytes)),
    file('tests/manifest.json',JSON.stringify(testsManifest,null,2)),file('tests/vectors.json',JSON.stringify(testVectors,null,2)),file('tests/self-test.cjs',finalizedPackagedSelfTest),
    file('sbom.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: featureManifest.featureId, version } }, components: [{type:'application',name:'CPython embeddable runtime',version:'3.13.14',scope:'required'}] }))
  ]
});
const packageSelfCheckOnly = process.argv.includes('--self-check');
const featurePaths = new Set(featurePackage.files.map((member) => member.path));
for (const requiredPath of ['python/plan_ir.py','python/create-associate-engine.py','middle/create-associate-python-bridge.cjs','middle/worker.cjs','backend/Phase1-用户填写模板V5.xlsx','tests/manifest.json','tests/vectors.json','tests/self-test.cjs']) {
  if (!featurePaths.has(requiredPath)) throw new Error(`Feature package member is missing: ${requiredPath}`);
}
try{new Function(finalizedPackagedSelfTest);}catch(error){throw new Error(`Packaged self-test syntax is invalid: ${error.message}`);}
if ([...featurePaths].some((memberPath) => /phase_1_14_|复核\.py/iu.test(memberPath))) throw new Error('Reference review script must not be a package member.');
if (Object.hasOwn(runtimeContract.pythonSidecar, 'capabilities')) throw new Error('Shell 0.4.14 rejects unknown pythonSidecar capabilities metadata.');
if (Object.keys(kindRegistry).sort().join(',') !== 'APP,DB,DCNO,OS,TOOL'
  || kindRegistry.TOOL.relationPolicy?.relationType !== 'ItToolApplication'
  || kindRegistry.TOOL.relationPolicy?.min !== 1 || kindRegistry.TOOL.relationPolicy?.max !== 200
  || kindRegistry.DB.relationPolicy?.relationType !== 'InfrastructureApplication'
  || kindRegistry.OS.relationPolicy?.relationType !== 'InfrastructureApplication'
  || kindRegistry.DCNO.returnSupport !== 'supported'
  || kindRegistry.DCNO.riskControlSupportedRaitValues?.join(',') !== 'Higher,Lower'
  || kindRegistry.DCNO.capabilities?.inheritedRait !== true
  || ['object','gra','relation','riskControl','evaluation'].some((capability) => kindRegistry.DCNO.capabilities?.[capability] !== true)
  || ['settings','directRait','appScoring','aiReview'].some((capability) => kindRegistry.DCNO.capabilities?.[capability] !== false)) {
  throw new Error('Signed kind registry support matrix failed package self-check.');
}
if (governance.sourceTemplateContract?.version !== 'V5'
  || governance.sourceTemplateContract?.memberPath !== 'backend/Phase1-用户填写模板V5.xlsx'
  || canonical(kindRegistry.APP.pendingRecordingContentValues) !== canonical(pendingRecordingContentValues.APP)
  || canonical(kindRegistry.OS.pendingRecordingContentValues) !== canonical(pendingRecordingContentValues.OS)
  || canonical(kindRegistry.TOOL.pendingRecordingContentValues) !== canonical(pendingRecordingContentValues.TOOL)) {
  throw new Error('V5 source-template pending-recording contract failed package self-check.');
}
if (packageSelfCheckOnly) {
  const runFixture=(executable,args,input)=>{
    const result=spawnSync(executable,args,{cwd:root,input,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
    if(result.status!==0)throw new Error(`Offline fixture runner failed: ${executable} ${args.join(' ')}\n${result.stderr||result.stdout}`);
    const output=JSON.parse(String(result.stdout||'').trim());
    if(output.schemaVersion!=='omnia.create-associate.fixture-results/v1'||!Array.isArray(output.results)||output.results.some((item)=>item.status!=='passed'))throw new Error(`Offline fixture result is invalid: ${executable}`);
    return output.results.map((item)=>item.testId);
  };
  const workerIds=runFixture(process.execPath,[path.join(testSource,'worker_contract.cjs'),path.join(source,'middle','worker.cjs'),path.join(testSource,'capability-fixtures.json')],Buffer.from(JSON.stringify({governance}),'utf8'));
  const pythonIds=runFixture(managedPython,[path.join(testSource,'capability_contract.py')],Buffer.from(JSON.stringify({governance,fixtures:capabilityFixtures,templateBase64:userTemplateBytes.toString('base64')}),'utf8'));
  const observedIds=[...pythonIds,...workerIds].sort(),expectedIds=[...sourceFixtureTestIds].sort();
  if(JSON.stringify(observedIds)!==JSON.stringify(expectedIds))throw new Error('Offline fixture result inventory differs from the signed vectors.');
  console.log(`omnia.create-associate ${version}/${sequence} package self-check passed (${observedIds.length} independent fixtures; no candidate written)`);
  process.exit(0);
}
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
