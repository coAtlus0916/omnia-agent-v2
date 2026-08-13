'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { setTimeout: delay } = require('node:timers/promises');

const FEATURE_ID = 'omnia.create-associate';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const MAX_USER_ELEMENTS = 200;
let ACTIVE_KIND_REGISTRY = null;
function installKindRegistry(governance){
  const registry=governance?.kindRegistry;
  if(!registry||typeof registry!=='object'||Array.isArray(registry)||!Object.keys(registry).length)fail('GOVERNANCE.KIND_REGISTRY_MISSING','Signed kind capability registry is missing.');
  for(const [kind,spec] of Object.entries(registry)){
    if(!spec||!spec.objectType||!spec.objectSubtype||!spec.id||!Array.isArray(spec.reviewFields)||!spec.reviewFields.length||!spec.capabilities||!Array.isArray(spec.stageNodes)||!Array.isArray(spec.derivations))fail('GOVERNANCE.KIND_REGISTRY_INVALID',`Signed kind capability is invalid: ${kind}.`);
    if(spec.relation&&(!spec.relationPolicy||spec.relationPolicy.targetKind!=='APP'||!Number.isInteger(spec.relationPolicy.min)||!Number.isInteger(spec.relationPolicy.max)||spec.relationPolicy.min<0||spec.relationPolicy.max<spec.relationPolicy.min))fail('GOVERNANCE.RELATION_POLICY_INVALID',`Signed relation policy is invalid: ${kind}.`);
    if(spec.riskControlSupportedRaitValues!==undefined&&(!Array.isArray(spec.riskControlSupportedRaitValues)||!spec.riskControlSupportedRaitValues.length||spec.riskControlSupportedRaitValues.some((value)=>!['Higher','Lower'].includes(value))||new Set(spec.riskControlSupportedRaitValues).size!==spec.riskControlSupportedRaitValues.length))fail('GOVERNANCE.RISK_CONTROL_RAIT_SCOPE_INVALID',`Signed Risk-Control RAIT scope is invalid: ${kind}.`);
  }
  ACTIVE_KIND_REGISTRY=registry;return registry;
}
function kindCapability(kind,registry=ACTIVE_KIND_REGISTRY){const spec=registry?.[kind];if(!spec)fail('GOVERNANCE.KIND_UNDECLARED',`Element kind is not declared: ${kind}.`);return spec;}
function infrastructureKinds(registry=ACTIVE_KIND_REGISTRY){return new Set(Object.entries(registry||{}).filter(([,spec])=>spec.inheritRait===true).map(([kind])=>kind));}
const CAPABILITY_STAGE_REQUIREMENTS=Object.freeze({
  object:['object'],gra:['gra'],settings:['settings'],relation:['relation'],directRait:['gra_state'],inheritedRait:['inherited_rait'],
  appScoring:['app_category','app_scoring','documentation'],riskControl:['risk_classification','risk_control'],evaluation:['evaluation']
});
function frozenStageNodes(planRow){
  const stages=Array.isArray(planRow?.stageNodes)?planRow.stageNodes.map((value)=>String(value)):[];
  if(!stages.length||new Set(stages).size!==stages.length)fail('RETURN.CAPABILITY_STAGE_PLAN_INVALID',`Frozen capability stage plan is invalid: ${planRow?.rowKey||'(missing row)'}.`);
  const declared=new Set(stages),capabilities=planRow?.capabilities||{};
  for(const [capability,requiredStages] of Object.entries(CAPABILITY_STAGE_REQUIREMENTS)){
    if(capabilities[capability]===true&&requiredStages.some((stage)=>!declared.has(stage)))fail('RETURN.CAPABILITY_STAGE_PLAN_INVALID',`Frozen capability ${capability} is missing its declared stage nodes for ${planRow?.rowKey||'(missing row)'}.`);
    if(capabilities[capability]!==true&&requiredStages.some((stage)=>declared.has(stage)))fail('RETURN.CAPABILITY_STAGE_PLAN_INVALID',`Frozen stage plan enables undeclared capability ${capability} for ${planRow?.rowKey||'(missing row)'}.`);
  }
  return Object.freeze([...stages]);
}
function freezePlanCapabilities(planRow){
  const capabilities=planRow?.capabilities;
  if(!capabilities||typeof capabilities!=='object'||Array.isArray(capabilities)||!Object.keys(capabilities).length
    ||Object.values(capabilities).some((value)=>typeof value!=='boolean')){
    fail('RETURN.CAPABILITY_PROJECTION_INVALID',`Frozen capability projection is invalid: ${planRow?.rowKey||'(missing row)'}.`);
  }
  return Object.freeze(Object.fromEntries(Object.entries(capabilities).map(([key,value])=>[String(key),value])));
}
function frozenReturnIntents(planRow){
  const intents=planRow?.returnIntents;
  if(!intents||intents.schemaVersion!=='omnia.create-associate.deterministic-return-intents/v1'||typeof intents.semanticDigest!=='string'){
    fail('RETURN.DETERMINISTIC_INTENTS_INVALID',`Frozen Python Return intents are invalid: ${planRow?.rowKey||'(missing row)'}.`);
  }
  const body=Object.fromEntries(Object.entries(intents).filter(([key])=>key!=='semanticDigest'));
  if(digest(Buffer.from(canonical(body)))!==intents.semanticDigest
    ||!Array.isArray(intents.relationTargets)||!Array.isArray(intents.riskControlCatalogRelations)
    ||!Array.isArray(intents.riskControlRelations)||!Array.isArray(intents.riskClassifications)||!Array.isArray(intents.scoringItems)){
    fail('RETURN.DETERMINISTIC_INTENTS_DRIFT',`Frozen Python Return intents drifted: ${planRow?.rowKey||'(missing row)'}.`);
  }
  return intents;
}
function assertReturnPlanCapabilities(planRows,returnRows){
  const planned=Array.isArray(planRows)?planRows:[],projected=Array.isArray(returnRows)?returnRows:[];
  if(planned.length!==projected.length)fail('RETURN.CAPABILITY_PROJECTION_DRIFT','Return-plan row inventory differs from the frozen Python capability plan.');
  const byRowKey=new Map(projected.map((row)=>[String(row?.rowKey||''),row]));
  if(byRowKey.size!==projected.length)fail('RETURN.CAPABILITY_PROJECTION_DRIFT','Return-plan capability projection contains duplicate or missing row keys.');
  for(const planRow of planned){
    const prepared=byRowKey.get(String(planRow?.rowKey||'')),expected=freezePlanCapabilities(planRow),expectedIntents=frozenReturnIntents(planRow);
    if(!prepared||!prepared.capabilities||typeof prepared.capabilities!=='object'||Array.isArray(prepared.capabilities)
      ||canonical(prepared.capabilities)!==canonical(expected))fail('RETURN.CAPABILITY_PROJECTION_DRIFT',`Return-plan capabilities differ from the frozen Python plan for ${planRow?.rowKey||'(missing row)'}.`);
    const preparedIntents=frozenReturnIntents(prepared);
    if(preparedIntents.semanticDigest!==expectedIntents.semanticDigest)fail('RETURN.DETERMINISTIC_INTENTS_DRIFT',`Return-plan deterministic intents differ from the frozen Python plan for ${planRow?.rowKey||'(missing row)'}.`);
    frozenStageNodes(prepared);
  }
  return true;
}
function hasFrozenStage(row,stage){return Array.isArray(row?.stageNodes)&&row.stageNodes.includes(stage);}
function buildFrozenDependencyGraph(rows){
  const values=Array.isArray(rows)?rows:[];
  const nodes=values.map((row,index)=>{
    const dependencies=Array.isArray(row?.dependencyRowKeys)?row.dependencyRowKeys.map((value)=>String(value)):null;
    if(!row?.rowKey||dependencies===null||new Set(dependencies).size!==dependencies.length||dependencies.includes(String(row.rowKey)))fail('RETURN.DEPENDENCY_GRAPH_INVALID',`Frozen dependency list is invalid for ${row?.rowKey||'(missing row)'}.`);
    frozenStageNodes(row);
    return{id:String(row.rowKey),index,row,dependencies};
  });
  const byId=new Map(nodes.map((node)=>[node.id,node]));
  if(byId.size!==nodes.length)fail('RETURN.DEPENDENCY_GRAPH_INVALID','Return dependency graph contains duplicate row keys.');
  for(const node of nodes)for(const dependency of node.dependencies)if(!byId.has(dependency))fail('RETURN.DEPENDENCY_GRAPH_INVALID',`Return dependency ${dependency} is missing.`);
  const visiting=new Set(),visited=new Set();
  const visit=(node)=>{if(visiting.has(node.id))fail('RETURN.DEPENDENCY_GRAPH_INVALID',`Return dependency graph contains a cycle at ${node.id}.`);if(visited.has(node.id))return;visiting.add(node.id);for(const dependency of node.dependencies)visit(byId.get(dependency));visiting.delete(node.id);visited.add(node.id);};
  for(const node of nodes)visit(node);
  return nodes;
}
function dependencyBlockedByFailure(node,failedRowKeys){return node.dependencies.some((dependency)=>failedRowKeys.has(dependency));}
function returnExecutionPolicy(payload={}){return{schemaVersion:'omnia.create-associate.return-execution-policy/v1',continueOnIsolatedFailure:payload?.continue_on_isolated_failure!==false};}
const RETURN_DEFAULT_CONCURRENCY = 8;
const RETURN_MAX_CONCURRENCY = 8;
// Pack mutations that touch different Risk/Factor identities do not share a
// concurrency token. Use the same bounded capacity as the signed return plan
// and Connector Next Agent; same-Risk relations remain serialized in lanes.
const RETURN_WITHIN_GRA_CONCURRENCY = 8;
const RETURN_READBACK_MAX_ATTEMPTS = 8;
const RETURN_CAPABILITY = Object.freeze({
  scenarioId: 'create-associate-return-v1',
  capabilityId: 'phase1-full-return-v1'
});
async function boundedDelay(milliseconds) {
  const value = Math.max(0, Math.min(5_000, Math.trunc(Number(milliseconds) || 0)));
  if (value > 0) await delay(value);
}
async function runBoundedIndependent(items, limit, worker) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return [];
  const results = new Array(values.length);
  const failures = [];
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      try { results[index] = await worker(values[index], index); }
      catch (error) { failures.push({ index, error }); }
    }
  };
  const workerCount = Math.min(values.length, Math.max(1, Math.trunc(Number(limit) || 1)));
  await Promise.all(Array.from({ length: workerCount }, () => run()));
  if (failures.length) throw failures.sort((left, right) => left.index - right.index)[0].error;
  return results;
}
function createFifoOperationLimiter(limit) {
  const capacity = Math.max(1, Math.trunc(Number(limit) || 1));
  const waiting = [];
  let active = 0;
  const dispatch = () => {
    while (active < capacity && waiting.length) {
      active += 1;
      waiting.shift()();
    }
  };
  return async (operation) => {
    if (typeof operation !== 'function') fail('RETURN.OPERATION_LIMITER_INVALID', 'Remote Operation limiter requires one callable operation.');
    await new Promise((resolve) => { waiting.push(resolve); dispatch(); });
    try { return await operation(); }
    finally { active -= 1; dispatch(); }
  };
}
function completeObjectCreateAbsence(observed,objectType){
  const proof=observed?.evidence&&typeof observed.evidence==='object'?observed.evidence:{};
  const application=objectType==='Application'
    &&Number(observed?.matchCount)===0&&Number(observed?.graMatchCount)===0
    &&Number(proof.applicationPagesRead)>0&&Number(proof.applicationObserved)>=0;
  const generic=objectType!=='Application'
    &&Number(observed?.matchCount)===0&&Number(observed?.activeCount)===0&&Number(observed?.recycleBinCount)===0
    &&Number(observed?.graMatchCount)===0&&Number(proof.pagesRead)>0&&Number(proof.observed)>=0;
  return observed?.found===false&&observed?.item===null&&observed?.disposition==='create'
    &&observed?.reasonCode==='not_found'&&observed?.matchState==='none'&&observed?.graState==='none'
    &&(application||generic);
}
function completeGraCreateAbsence(observed){
  return observed?.found===false&&observed?.item===null
    &&Number(observed?.evidence?.directoryMatches)===0;
}
const V8_SHA256 = '6511D225827D805B2C7D8DBFE85D09C076E17C21F4A6B9EF13DDF3BCC4A9135D';
const GOVERNANCE = '__GOVERNANCE_JSON__';
const EXPECTED_SHEETS = Object.freeze([
  '使用说明', '字段母版', 'Risk-Control关系', 'V4接口证据', '规则与枚举',
  '覆盖与质检', '原始字段追溯', 'SAP ECC录制证据', '评分项与规则'
]);

function fail(code, message) {
  const error = new Error(message);
  error.name = 'CreateAssociateWorkerError';
  error.code = code;
  throw error;
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
const AI_REVIEW_DISPLAY_LANGUAGE = 'zh-CN';
const AI_REVIEW_LANGUAGE_VERSION = 'zh-CN-simplified/v1';
function isChineseAiReviewDisplayText(value,{allowEmpty=false}={}){
  const text=String(value??'').normalize('NFC').trim();
  return (!text&&allowEmpty)||Boolean(text&&/[\p{Script=Han}]/u.test(text));
}
function assertChineseAiReviewDisplayText(value,label,{allowEmpty=false}={}){
  if(!isChineseAiReviewDisplayText(value,{allowEmpty})){
    fail('AI.REVIEW_OUTPUT_LANGUAGE_INVALID',`${label} must be user-facing Simplified Chinese (${AI_REVIEW_DISPLAY_LANGUAGE}); obvious English-only output is rejected.`);
  }
}
function aiReviewItemUsesChineseDisplayText(item){
  return isChineseAiReviewDisplayText(item?.summary)
    &&Array.isArray(item?.concerns)
    &&item.concerns.every((concern)=>isChineseAiReviewDisplayText(concern?.message)
      &&isChineseAiReviewDisplayText(concern?.suggestion,{allowEmpty:true}));
}
function assertAiReviewOutputUsesChineseDisplayText(output){
  for(const [index,item] of (Array.isArray(output?.items)?output.items:[]).entries()){
    assertChineseAiReviewDisplayText(item?.summary,`Factors review item ${index+1} summary`);
    for(const [concernIndex,concern] of (Array.isArray(item?.concerns)?item.concerns:[]).entries()){
      assertChineseAiReviewDisplayText(concern?.message,`Factors review item ${index+1} concern ${concernIndex+1} message`);
      assertChineseAiReviewDisplayText(concern?.suggestion,`Factors review item ${index+1} concern ${concernIndex+1} suggestion`,{allowEmpty:true});
    }
  }
  return true;
}
function deriveGraName(elementId){return `GRA-${String(elementId||'').normalize('NFC').trim()}`;}
function elementDescriptionDerivation(kind){
  const derivation=kindCapability(kind).derivations.find((item)=>item.valueSource==='element_id'&&String(item.fieldId||'').endsWith('.IT.DESCRIPTION'));
  if(!derivation?.rawFieldKey||!derivation?.ruleId)fail('GOVERNANCE.DESCRIPTION_DERIVATION_MISSING',`Signed element description derivation is missing: ${kind}.`);
  return derivation;
}
function descriptionRawField(kind){return elementDescriptionDerivation(kind).rawFieldKey;}
function descriptionRuleId(kind){return elementDescriptionDerivation(kind).ruleId;}
function issueId(origin,code,fieldKey){return `${origin}-${digest(Buffer.from(`${code}|${fieldKey}`)).slice(0,48)}`;}
function issue(origin,code,fieldKey,issueType,state,message,checkId){return{issueId:issueId(origin,code,fieldKey),origin,code,fieldKey,issueType,state,message,checkId};}
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function observedDocumentation(value){
  const wrapped=value&&value.documentation;
  const candidate=wrapped&&typeof wrapped==='object'&&!Array.isArray(wrapped)&&Object.prototype.hasOwnProperty.call(wrapped,'documentation')
    ?wrapped.documentation:wrapped;
  if(candidate===null||candidate===undefined||candidate==='')return null;
  if(typeof candidate==='object'&&!Array.isArray(candidate))return candidate;
  if(typeof candidate!=='string')fail('RETURN.DOCUMENTATION_INVALID','The authoritative Documentation payload is not an RTE JSON string.');
  let parsed; try{parsed=JSON.parse(candidate);}catch{fail('RETURN.DOCUMENTATION_INVALID','The authoritative Documentation RTE JSON is invalid.');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('RETURN.DOCUMENTATION_INVALID','The authoritative Documentation RTE object is invalid.');
  return parsed;
}
function xmlText(value) {
  return String(value || '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&').replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)));
}

function zipEntries(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 64 * 1024 * 1024) fail('WORKBOOK.INVALID_ZIP', 'XLSX container size is invalid.');
  let eocd = -1;
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 65_557); cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50) { eocd = cursor; break; }
  }
  if (eocd < 0) fail('WORKBOOK.INVALID_ZIP', 'XLSX ZIP end record is missing.');
  const count = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  if (count < 1 || count > 2_048 || cursor < 0 || cursor >= eocd) fail('WORKBOOK.INVALID_ZIP', 'XLSX central directory bounds are invalid.');
  const entries = new Map();
  let totalInflated = 0;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) fail('WORKBOOK.INVALID_ZIP', 'XLSX central directory is malformed.');
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > eocd || compressedSize > 32 * 1024 * 1024
      || uncompressedSize > 32 * 1024 * 1024 || (compressedSize > 0 && uncompressedSize / compressedSize > 100)) {
      fail('WORKBOOK.ZIP_BOMB', 'XLSX entry exceeds compression or bounds limits.');
    }
    totalInflated += uncompressedSize;
    if (totalInflated > 128 * 1024 * 1024) fail('WORKBOOK.ZIP_BOMB', 'XLSX total inflated size exceeds 128 MiB.');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) fail('WORKBOOK.INVALID_ZIP', 'XLSX local entry is malformed.');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start < 0 || start + compressedSize > bytes.length) fail('WORKBOOK.INVALID_ZIP', 'XLSX local entry bounds are invalid.');
    const compressed = bytes.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (!data) fail('WORKBOOK.UNSUPPORTED_COMPRESSION', `Unsupported XLSX compression method ${method}.`);
    if (data.length !== uncompressedSize || entries.has(name)) fail('WORKBOOK.INVALID_ZIP', 'XLSX entry size or name is inconsistent.');
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function sharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<(?:[A-Za-z_][\w.-]*:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/gu)].map((match) =>
    xmlText([...match[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gu)].map((part) => part[1]).join(''))
  );
}

function workbook(entries) {
  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const rels = new Map([...relsXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/?\s*>/gu)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([A-Za-z:]+)="([^"]*)"/gu)].map((item) => [item[1], xmlText(item[2])]));
    return [attrs.Id, attrs.Target];
  }));
  return [...workbookXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?\s*>/gu)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([A-Za-z:]+)="([^"]*)"/gu)].map((item) => [item[1], xmlText(item[2])]));
    const target = rels.get(attrs['r:id']);
    return { name: attrs.name, path: target ? `xl/${String(target).replace(/^\//u, '').replace(/^xl\//u, '')}` : '' };
  });
}

function columnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/u)?.[0] || '';
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function sheetRows(xmlBytes,strings,allowManagedFormulaCache=false){
  const rows = [];
  const xml = xmlBytes.toString('utf8');
  for (const rowMatch of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/gu)) {
    const rowNumber = Number(rowMatch[1].match(/\br="(\d+)"/u)?.[1] || rows.length + 1);
    const cells = [];
    for(const cellMatch of rowMatch[2].matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/gu)){
      const attrs = cellMatch[1];
      const ref = attrs.match(/\br="([A-Z]+\d+)"/u)?.[1] || '';
      const type = attrs.match(/\bt="([^"]+)"/u)?.[1] || '';
      const body = cellMatch[2]||'';
      const hasFormula=/<(?:[A-Za-z_][\w.-]*:)?f\b/iu.test(body);
      if(hasFormula&&!allowManagedFormulaCache) fail('WORKBOOK.FORMULA_UNSUPPORTED',`Formula cell ${ref||'(unknown)'} is unsupported in user input; cached values are never treated as source data.`);
      if(hasFormula&&type==='s') fail('WORKBOOK.FORMULA_CACHE_INVALID',`Formula cell ${ref||'(unknown)'} cannot use a shared-string index as its cached value.`);
      const raw = body.match(/<(?:[A-Za-z_][\w.-]*:)?v>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/u)?.[1];
      const inline = body.match(/<(?:[A-Za-z_][\w.-]*:)?is>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/u)?.[1];
      let value = raw === undefined ? '' : xmlText(raw);
      if(type==='s'&&raw!==undefined&&!hasFormula)value=strings[Number(raw)]||'';
      if (type === 'inlineStr' && inline) value = xmlText([...inline.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gu)].map((part) => part[1]).join(''));
      cells[columnIndex(ref)] = value;
    }
    rows[rowNumber] = cells;
  }
  return rows;
}

function parseV8(input) {
  if(!Buffer.isBuffer(input)) fail('GOVERNANCE.BYTES_REQUIRED','V8 parser only accepts bytes supplied through a managed port.');
  const bytes = input;
  const sha256 = digest(bytes).toUpperCase();
  if (sha256 !== V8_SHA256) fail('WORKBOOK.DIGEST_MISMATCH', `V8 digest mismatch: ${sha256}.`);
  const entries = zipEntries(bytes);
  const strings = sharedStrings(entries);
  const sheets = workbook(entries);
  if (sheets.length !== EXPECTED_SHEETS.length || sheets.some((sheet, index) => sheet.name !== EXPECTED_SHEETS[index])) {
    fail('WORKBOOK.SHEET_CONTRACT_MISMATCH', 'V8 must contain the exact ordered 9-sheet contract.');
  }
  const byName=new Map(sheets.map((sheet)=>[sheet.name,sheetRows(entries.get(sheet.path),strings,true)]));
  const table = (name) => {
    const rows = byName.get(name);
    const headers = rows?.[4] || [];
    return (rows || []).slice(5).filter((row) => row && row.some((value) => value !== '')).map((row, index) => ({
      sourceRow: index + 5,
      values: Object.fromEntries(headers.map((header, column) => [String(header), row[column] ?? '']))
    }));
  };
  const fields = table('字段母版');
  const relations = table('Risk-Control关系');
  const evidence = table('V4接口证据');
  const traces = table('原始字段追溯').filter((row) => row.values['行角色'] === '字段');
  const sap = table('SAP ECC录制证据');
  const scores = table('评分项与规则');
  if (byName.get('字段母版')?.[4]?.[0] !== 'field_id' || byName.get('Risk-Control关系')?.[4]?.[0] !== 'relation_id') {
    fail('WORKBOOK.HEADER_ROW_MISMATCH', 'V8 governance headers must be on row 4.');
  }
  const ids = new Set(fields.map((row) => row.values.field_id));
  const relationIds=new Set(relations.map((row)=>String(row.values.relation_id||'')));
  if (fields.length < 187 || ids.size !== fields.length || relations.length < 68 || relationIds.size !== relations.length || evidence.length < 21 || traces.length < 180) {
    fail('WORKBOOK.COUNT_MISMATCH', 'V8 governance must preserve the 187/68/21/180 baseline and keep all field/relation identities unique.');
  }
  const sapRelations = relations.filter((row) => String(row.values.relation_id).includes('.SAP_ECC.'));
  const higher = sapRelations.filter((row) => row.values.link_required_higher === 'Y');
  const lower = sapRelations.filter((row) => row.values.link_required_lower === 'Y');
  const sap03 = sapRelations.find((row) => String(row.values.relation_id).endsWith('.SAP_03'));
  if (higher.length !== 18 || lower.length !== 17 || !sap03 || sap03.values.link_required_higher !== 'Y'
    || sap03.values.link_required_lower !== 'N') {
    fail('WORKBOOK.SAP_CONTRACT_MISMATCH', 'SAP relation contract must be Higher=18, Lower=17, SAP.03 Higher-only.');
  }
  const scoreSheet = byName.get('评分项与规则');
  const scoreHeaderIndex=(scoreSheet||[]).findIndex((row)=>row?.some((value)=>String(value||'').trim()==='item_id'));
  if(scoreHeaderIndex<0) fail('WORKBOOK.SCORING_HEADER_MISSING','Scoring governance has no item_id header.');
  const scoreHeaders = scoreSheet[scoreHeaderIndex] || [];
  const scoreItems = (scoreSheet || []).slice(scoreHeaderIndex+1).filter((row)=>row&&row.some((value)=>value!=='')).map((row, index) => ({
    sourceRow: index + scoreHeaderIndex + 1,
    values: Object.fromEntries(scoreHeaders.map((header, column) => [String(header), row?.[column] ?? '']))
  }));
  const scoreIds=new Set(scoreItems.map((row)=>String(row.values.item_id||'')));
  const appScoreItems=scoreItems.filter((row)=>String(row.values.item_id||'').startsWith('APP.RF.'));
  const writable = appScoreItems.filter((row) => String(row.values['Higher适用']).startsWith('Y') && String(row.values['request位置']).includes('request-'));
  const notApplicable = appScoreItems.filter((row) => String(row.values['Higher适用']).startsWith('N') && String(row.values.item_id).endsWith('_13'));
  if (scoreItems.length < 15 || scoreIds.size !== scoreItems.length || appScoreItems.length !== 15 || writable.length !== 14 || notApplicable.length !== 1) {
    fail('WORKBOOK.SCORING_CONTRACT_MISMATCH', `Scoring governance must keep the single APP-generic 15/14/1 capability; observed total=${scoreItems.length}, APP=${appScoreItems.length}/${writable.length}/${notApplicable.length}; headers=${scoreHeaders.join('|')}.`);
  }
  return { sha256, fields, relations, evidence, traces, sap, scores, scoreItems };
}

const RETURN_OPERATIONS = Object.freeze({
  authority: 'omnia.create-associate.authority.resolve.v1',
  objectIdentityResolve: 'omnia.create-associate.object.identity.resolve.v1',
  objectCreatePreflight: 'omnia.create-associate.object.create-preflight.v2',
  objectPreflight: 'omnia.create-associate.object.preflight.v1',
  objectCreate: 'omnia.create-associate.object.create.v1', objectRead: 'omnia.create-associate.object.reconcile.v1',
  objectSettingsPreflight:'omnia.create-associate.object-settings.preflight.v1',objectSettingsWrite:'omnia.create-associate.object-settings.patch.v1',objectSettingsRead:'omnia.create-associate.object-settings.reconcile.v1',
  relationPreflight: 'omnia.create-associate.relation.preflight.v1', relationWrite: 'omnia.create-associate.relation.associate.v1', relationRead: 'omnia.create-associate.relation.reconcile.v1',
  graPreflight: 'omnia.create-associate.gra.preflight.v1', graCreate: 'omnia.create-associate.gra.create.v1', graRead: 'omnia.create-associate.gra.reconcile.v1',
  graStatePreflight: 'omnia.create-associate.gra-state.preflight.v1', graStateWrite: 'omnia.create-associate.gra-state.patch.v1', graStateRead: 'omnia.create-associate.gra-state.reconcile.v1',
  riskFactorCategoryPreflight: 'omnia.create-associate.risk-factor-category.preflight.v1', riskFactorCategoryWrite: 'omnia.create-associate.risk-factor-category.patch.v1', riskFactorCategoryRead: 'omnia.create-associate.risk-factor-category.reconcile.v1',
  factorPreflight: 'omnia.create-associate.risk-factor.preflight.v1', factorWrite: 'omnia.create-associate.risk-factor.patch.v1', factorRead: 'omnia.create-associate.risk-factor.reconcile.v1',
  documentationPreflight: 'omnia.create-associate.documentation.preflight.v1', documentationWrite: 'omnia.create-associate.documentation.patch.v1', documentationRead: 'omnia.create-associate.documentation.reconcile.v1',
  evaluationPreflight: 'omnia.create-associate.evaluation.preflight.v1', evaluationWrite: 'omnia.create-associate.evaluation.submit.v1', evaluationRead: 'omnia.create-associate.evaluation.reconcile.v1',
  riskClassificationPreflight: 'omnia.create-associate.risk-classification.preflight.v1', riskClassificationWrite: 'omnia.create-associate.risk-classification.patch.v1', riskClassificationRead: 'omnia.create-associate.risk-classification.reconcile.v1',
  riskCatalog: 'omnia.create-associate.risk-control.catalog.v1', riskPreflight: 'omnia.create-associate.risk-control.preflight.v1', riskWrite: 'omnia.create-associate.risk-control.associate.v1', riskRead: 'omnia.create-associate.risk-control.reconcile.v1'
});
function rowField(row, governance, fieldId) {
  const alias = Object.entries(kindCapability(row.kind,governance.kindRegistry).aliases||{}).find(([, canonicalId]) => canonicalId === fieldId)?.[0];
  return alias ? String(row.fields[alias] || '').trim() : '';
}
function authorityContentNameFor(row,governance,registry=governance.kindRegistry){
  const inputValue=rowField(row,governance,`P1.${row.kind}.GRA.GRA_CONTENT`);
  const declared=(kindCapability(row.kind,registry).pendingRecordingContentValues||[]).find((item)=>String(item?.inputValue||'')===inputValue);
  return String(declared?.expectedOmniaContentName||'').trim()||inputValue;
}
function rowWorkspaceName(row) { return String(row?.fields?.['Omnia工作区'] || '').normalize('NFKC').trim(); }
function objectType(kind) { return kindCapability(kind).objectType; }
function objectSubtypeId(kind) { return kindCapability(kind).objectSubtype; }
function authorityObjectSubtype(kind) { return kind === 'APP' ? 'Application' : objectSubtypeId(kind); }
function identityKey(prefix, value) { return `${prefix}:${digest(Buffer.from(canonical(value))).slice(0, 48)}`; }
function objectBusinessIdentity(kind, elementId, workspaceId) {
  return [workspaceId, kind, elementId];
}
function graBusinessIdentity(kind, elementId, workspaceId, graName = deriveGraName(elementId)) {
  return [...objectBusinessIdentity(kind, elementId, workspaceId), graName];
}
function graOperationIdentity(prefix, row, qualifier = '') {
  const identity = graBusinessIdentity(row.kind, row.elementId, row.workspaceId, row.graName);
  return identityKey(prefix, qualifier === '' ? identity : [...identity, qualifier]);
}
function inheritanceOperationIdentity(source, target) {
  return identityKey('gra-state', [
    ...graBusinessIdentity(source.kind, source.elementId, source.workspaceId, source.graName),
    'itElementRaitConclusionLevelId',
    'inherited-by',
    ...graBusinessIdentity(target.kind, target.elementId, target.workspaceId, target.graName)
  ]);
}
function normalizeRait(value) {
  const normalized=String(value||'').normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return normalized==='higher'?'Higher':normalized==='lower'?'Lower':String(value||'').normalize('NFKC').trim();
}
function applyLiveVerifiedInfrastructureInheritance(candidate,sourceApps,inheritedMode){
  if(candidate.value!==inheritedMode||candidate.status!=='accepted')candidate.revision=Number(candidate.revision||0)+1;
  candidate.value=inheritedMode;candidate.status='accepted';candidate.valueKind='inherited';
  candidate.provenance={
    ...(candidate.provenance||{}),
    sourceApps,
    derivationRule:'live_verified_app_edges:any_higher_else_all_lower:v1;remote_verification_required_before_return'
  };
  return candidate;
}
function applicationIdentityRequest(elementId,workspaceId,rait,targetIdentityKey='') {
  const externalId=String(elementId||'').normalize('NFC').trim();
  const normalizedRait=normalizeRait(rait);
  return {
    target:{targetIdentityKey:targetIdentityKey||identityKey('object',['APP',externalId,workspaceId]),workspaceId},
    query:{objectType:'Application',externalId,workspaceId,graName:deriveGraName(externalId),rait:normalizedRait}
  };
}
function normalizedGuid(value) {
  const candidate=String(value||'').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(candidate)
    && candidate!=='00000000-0000-0000-0000-000000000000' ? candidate : '';
}
function exactResolvedGuid(value,key,label) {
  const candidate=normalizedGuid(value?.[key]);
  if(!candidate) fail('RETURN.IDENTITY_INVALID',`${label} did not return one canonical GUID.`);
  return candidate;
}
function inspectApplicationIdentity(resolution,request) {
  const disposition=String(resolution?.disposition||'skip');
  const reasonCode=String(resolution?.reasonCode||'identity_resolution_missing');
  if(!['create','resume','reuse'].includes(disposition)) return {accepted:false,disposition,reasonCode,objectId:'',riskAssessmentId:''};
  if(disposition==='create'){
    if(resolution?.found!==false||resolution?.matchState!=='none'||resolution?.graState!=='none'||resolution?.resolved) fail('RETURN.APP_IDENTITY_DRIFT','Signed APP create disposition contains contradictory identity state.');
    return {accepted:true,disposition,reasonCode,objectId:'',riskAssessmentId:''};
  }
  if(resolution?.found!==true||resolution?.matchState!=='active') fail('RETURN.APP_IDENTITY_DRIFT','Signed APP resume/reuse disposition is not backed by one active object identity.');
  const resolved=resolution?.resolved;
  if(String(resolved?.workspaceId||'').toLowerCase()!==String(request.query.workspaceId||'').toLowerCase()
    ||String(resolved?.graName||'').normalize('NFC').trim()!==request.query.graName
    ||normalizeRait(resolved?.rait)!==request.query.rait) fail('RETURN.APP_IDENTITY_DRIFT','Signed APP identity resolution differs from the exact frozen query.');
  const objectId=exactResolvedGuid(resolved,'objectId','APP identity resolution');
  const riskAssessmentId=disposition==='reuse'?exactResolvedGuid(resolved,'riskAssessmentId','APP GRA identity resolution'):'';
  return {accepted:true,disposition,reasonCode,objectId,riskAssessmentId};
}
function inspectGenericIdentity(resolution,request) {
  const state=String(resolution?.matchState||'');
  if(!['none','active','recycle_bin','ambiguous'].includes(state)) fail('RETURN.GENERIC_IDENTITY_DRIFT','Signed non-APP identity resolution has no explicit state.');
  const found=resolution?.found===true; const activeCount=Number(resolution?.activeCount||0); const recycleBinCount=Number(resolution?.recycleBinCount||0);
  if((state==='active')!==found) fail('RETURN.GENERIC_IDENTITY_DRIFT','Signed non-APP found flag contradicts matchState.');
  if(state==='active'&&(activeCount!==1||recycleBinCount!==0||!resolution?.item)) fail('RETURN.GENERIC_IDENTITY_DRIFT','Signed non-APP active identity is not uniquely proven.');
  if(state==='none'&&(activeCount!==0||recycleBinCount!==0||resolution?.item)) fail('RETURN.GENERIC_IDENTITY_DRIFT','Signed non-APP none identity contains contradictory evidence.');
  if(['recycle_bin','ambiguous'].includes(state)&&found) fail('RETURN.GENERIC_IDENTITY_DRIFT','Recycle-bin or ambiguous identity must never be treated as active.');
  const objectId=state==='active'?responseId(resolution.item,'non-APP identity resolution'):'';
  return {accepted:['none','active'].includes(state),state,objectId,reasonCode:state==='active'?'exact_active_identity':state==='none'?'not_found':`identifier_${state}`,
    evidence:resolution?.evidence||null};
}
function responseId(value, label) {
  const candidate = normalizedGuid(value?.id || value?.itElementId || value?.riskAssessmentId || value?.entityId);
  if (!candidate) fail('RETURN.IDENTITY_INVALID', `${label} did not return one canonical GUID.`);
  return candidate;
}
function catalogIdentityText(value) { return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US'); }
function governedCatalogNumber(value) {
  const label = String(value || '').normalize('NFKC').trim();
  return label.split(/[｜|]/u, 1)[0].trim();
}
function governedCatalogDescription(value) {
  const label = String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const match = /^(?:[\p{L}\p{N}][\p{L}\p{N} ./_-]*\.\d+)\s*(?:[|｜]|[-–—:：])\s*(.+)$/u.exec(label);
  return catalogIdentityText(match ? match[1] : label);
}
function governedCatalogNumberParts(value) {
  const label=String(value||'').normalize('NFKC').trim();
  const match=/^([\p{L}\p{N}]+)\.(\d{1,4})$/u.exec(label.replace(/[^\p{L}\p{N}.]+/gu,''));
  if(!match)return null;
  const ordinal=Number(match[2]);
  return Number.isSafeInteger(ordinal)&&ordinal>0
    ?{prefix:catalogIdentityText(match[1]),ordinal}:null;
}
function catalogIdentityEvidenceGaps(relations) {
  return (Array.isArray(relations) ? relations : []).filter((relation) => {
    if (relation?.catalogIdentityRequired !== true) return false;
    const parts = governedCatalogNumberParts(relation.catalogControlNumber);
    const evidence = relation.catalogIdentityEvidence;
    return !parts || relation.catalogIdentityStatus !== 'signed_live_exact'
      || !evidence || typeof evidence !== 'object'
      || !String(evidence.evidenceRef || '').trim()
      || !String(evidence.sourceTraceId || '').trim();
  });
}
function riskControlCatalogFingerprint(catalog) {
  const risks = (Array.isArray(catalog?.risks) ? catalog.risks : []).map((item) => ({
    riskId: String(item?.riskId || ''), riskRiskScopeId: String(item?.riskRiskScopeId || ''),
    riskScopeId: String(item?.riskScopeId || ''), riskNumber: catalogIdentityText(item?.riskNumber),
    name: catalogIdentityText(item?.name), classification: catalogIdentityText(item?.classification),
    assertion: catalogIdentityText(item?.assertion), assertionType: catalogIdentityText(item?.assertionType)
  })).sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const controls = (Array.isArray(catalog?.controls) ? catalog.controls : []).map((item) => ({
    controlId: String(item?.controlId || ''), controlNumber: catalogIdentityText(item?.controlNumber),
    name: catalogIdentityText(item?.name)
  })).sort((left, right) => canonical(left).localeCompare(canonical(right)));
  return digest(Buffer.from(canonical({ risks, controls })));
}
function catalogRiskIdentityMatches(catalog, relation) {
  const number = catalogIdentityText(governedCatalogNumber(relation.riskName));
  const expectedName = catalogIdentityText(relation.riskName);
  return (Array.isArray(catalog?.risks) ? catalog.risks : []).filter((item) => {
    const liveNumber = catalogIdentityText(item.riskNumber);
    return liveNumber ? liveNumber === number : catalogIdentityText(item.name) === expectedName;
  });
}
function catalogRiskMatches(catalog, relation, classification) {
  const expectedClassification = catalogIdentityText(classification);
  return catalogRiskIdentityMatches(catalog,relation).filter((item)=>catalogIdentityText(item.classification)===expectedClassification);
}
function catalogControlMatches(catalog, relation) {
  const signedCatalogNumber = catalogIdentityText(relation?.catalogControlNumber);
  const number = signedCatalogNumber || catalogIdentityText(governedCatalogNumber(relation.controlName));
  if(!number)return [];
  return (Array.isArray(catalog?.controls) ? catalog.controls : [])
    .filter((item) => catalogIdentityText(item.controlNumber)===number);
}
function unresolvedCatalogRelations(catalog, relations, mode) {
  return relations.filter((relation) => catalogRiskMatches(catalog, relation, relation[`classification${mode}`]).length !== 1
    || catalogControlMatches(catalog, relation).length !== 1);
}
function uncertainError(error) {
  return error && ['CONNECTOR.RESPONSE_LOST', 'REMOTE.MUTATION_UNCERTAIN'].includes(String(error.code || ''));
}
function descriptionEditorJson(value) {
  const plainText=String(value||'').trim(); const editorData=plainText?`<p>${plainText.replace(/[&<>"]/gu,(char)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[char]))}</p>`:'';
  return JSON.stringify({editorData,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText});
}
function descriptionPlainText(value){
  let editor=value; if(typeof editor==='string'){try{editor=JSON.parse(editor);}catch{return null;}}
  return editor&&typeof editor==='object'&&!Array.isArray(editor)&&typeof editor.plainText==='string'?editor.plainText.trim():null;
}
function freezeAppDataAvailability(identityDisposition,authoritativeValue,signedDefault){
  if(identityDisposition==='resume'&&(authoritativeValue===null||authoritativeValue===undefined)){
    if(signedDefault!==false)fail('RETURN.DATA_AVAILABILITY_RULE_DRIFT','Resumed unset APP must freeze the signed false isDataAvailable default.');
    return{disposition:'resume_unset_default_false',value:false};
  }
  if(['resume','reuse'].includes(identityDisposition)){if(typeof authoritativeValue!=='boolean')fail('RETURN.DATA_AVAILABILITY_UNRESOLVED','Pre-existing APP has no authoritative isDataAvailable boolean.');return{disposition:'preserve_authoritative_existing',value:authoritativeValue};}
  if(identityDisposition!=='create')fail('RETURN.DATA_AVAILABILITY_DISPOSITION_DRIFT','APP identity disposition is unavailable for data-availability freeze.');
  if(signedDefault!==false)fail('RETURN.DATA_AVAILABILITY_RULE_DRIFT','New APP must freeze the signed false isDataAvailable default.');
  return{disposition:'signed_new_default_false',value:false};
}
function resolveFrozenAppDataAvailability(identityDisposition,before,frozen){
  if(!frozen||typeof frozen.value!=='boolean')fail('RETURN.DATA_AVAILABILITY_DISPOSITION_DRIFT','Frozen APP data-availability disposition is invalid.');
  if(identityDisposition==='resume'&&frozen.disposition==='resume_unset_default_false'){
    if(frozen.value!==false||before?.isDataAvailable!==null&&before?.isDataAvailable!==undefined)fail('RETURN.DATA_AVAILABILITY_AUTHORITY_DRIFT','Resumed APP isDataAvailable is no longer unset; a new plan is required.');
    return false;
  }
  const expectedDisposition=identityDisposition==='create'?'signed_new_default_false':['resume','reuse'].includes(identityDisposition)?'preserve_authoritative_existing':'';
  if(!expectedDisposition||frozen.disposition!==expectedDisposition)fail('RETURN.DATA_AVAILABILITY_DISPOSITION_DRIFT','Frozen APP data-availability disposition differs between Review and execution.');
  if(expectedDisposition==='preserve_authoritative_existing'&&before?.isDataAvailable!==frozen.value)fail('RETURN.DATA_AVAILABILITY_AUTHORITY_DRIFT','Pre-existing APP authoritative isDataAvailable changed after Review; a new plan is required.');
  if(expectedDisposition==='signed_new_default_false'&&frozen.value!==false)fail('RETURN.DATA_AVAILABILITY_RULE_DRIFT','New APP execution may only use the signed false default.');
  return frozen.value;
}
function latestApplicationSettingsToken(detail,required,label){
  const candidates=(detail?.concurrencyTabs||[]).filter((tab)=>Number(tab?.entityTabTypeId)===501&&String(tab?.updatedOn||'').trim());
  if(!candidates.length){if(required)fail('RETURN.OBJECT_SETTINGS_AUTHORITY_MISSING',`${label} has no Application settings concurrency token.`);return'';}
  const latest=candidates.map((tab)=>String(tab.updatedOn).trim()).sort((left,right)=>right.localeCompare(left))[0];
  if(candidates.filter((tab)=>String(tab.updatedOn).trim()===latest).length!==1)fail('RETURN.OBJECT_SETTINGS_AUTHORITY_AMBIGUOUS',`${label} has no unique latest Application settings concurrency token.`);
  return latest;
}
function unsetApplicationSettings(detail){
  const empty=(value)=>value===null||value===undefined||value==='';
  return empty(detail?.typeId)&&empty(detail?.isRelevant)&&empty(detail?.isDataAvailable)
    &&Array.isArray(detail?.concurrencyTabs)&&detail.concurrencyTabs.length===0;
}
function exactApplicationSettingsIdentity(detail,objectId,externalId){
  const normalized=(value)=>String(value||'').normalize('NFKC').replace(/\s+/gu,' ').trim().toLocaleLowerCase('en-US');
  return normalized(detail?.id||detail?.itElementId||detail?.applicationId).toLowerCase()===String(objectId).toLowerCase()
    &&normalized(detail?.number||detail?.referenceNumber)===normalized(externalId)
    &&normalized(detail?.name||detail?.displayName)===normalized(externalId);
}
function workflowSurface(latest){
  const run=latest?.run; const state=String(run?.state||''); const revision=Math.max(1,Number(run?.state_revision||1));
  const confirmationPending=state==='waiting_confirmation';
  const confirmed=['returning','verifying','uncertain','reconciling','succeeded'].includes(state)
    ||state==='failed'&&Array.isArray(latest?.returnProgress)&&latest.returnProgress.length>0;
  const returning=confirmationPending||confirmed;
  const validationStarted=Boolean(run)&&!['draft','acquiring'].includes(state);
  const validationDone=['ready_for_review','waiting_confirmation','returning','verifying','uncertain','reconciling','succeeded'].includes(state);
  const failed=state==='failed'; const currentStepId=returning?'return':validationStarted?'validate':'upload';
  return {revision,currentStepId,steps:[
    {stepId:'upload',label:'上传资料',state:run?'completed':'current',detail:'上传系统信息'},
    {stepId:'validate',label:'校验',state:failed&&!returning?'failed':validationDone?'completed':validationStarted?'current':'pending',detail:validationDone?'解析、规则与输出校验已持久化':validationStarted?'正在按 Run 事件推进':'等待上传'},
    {stepId:'return',label:'回传',state:state==='succeeded'?'completed':state==='uncertain'?'warning':failed&&returning?'failed':returning?'current':'pending',detail:state==='succeeded'?'回传完成':state==='uncertain'?'等待只读核验':failed&&returning?'回传未完成':confirmationPending?'等待确认回传':returning?'正在回传':'等待校验通过'}
  ]};
}
function progressSurface(latest,parsed){
  const run=latest?.run;if(!run)return{scopes:[],items:[],workflow:workflowSurface(latest)}; const scopeId=`run:${run.run_id}`;
  const rows=parsed?.rows||[];
  return {workflow:workflowSurface(latest),scopes:[{id:scopeId,parentId:scopeId,label:`Run ${run.run_id}`,parentLabel:'新建与关联',selected:true}],items:rows.map((row)=>({id:`element:${row.rowKey}`,scopeId,type:row.kind,title:row.elementId,subtitle:`目标工作区 ${String(row.fields['Omnia工作区']||'未填写')}；GRA ${String(row.fields['Derived GRA Name']||deriveGraName(row.elementId))}`,selectable:false,disabledReason:'目标身份来自当前受管资料，只读展示。',concurrencyToken:String(run.state_revision)}))};
}
function legacyRecoveryInspectionEligible(inspection){
  return inspection?.schemaVersion==='omnia.feature-return-recovery-inspection-result/v1'&&inspection.eligible===true
    &&inspection.featureId===FEATURE_ID&&inspection.sourceFeatureVersion==='0.2.60'
    &&inspection.successorFeatureVersion===FEATURE_VERSION&&inspection.recoveryMode==='partial_close_no_reuse'
    &&inspection.state==='returning'&&Number(inspection.counts?.uncertain||0)===0&&Number(inspection.counts?.inFlight||0)===0
    &&Array.isArray(inspection.reconcileRequired)&&inspection.reconcileRequired.length<=1;
}
function legacyRecoveryAction(latest){
  void latest;
  return{actionId:'recover-interrupted-run',enabled:false,reason:'恢复上传已暂停；请使用正常上传流程。'};
}
function workflowNavigationActions(latest,currentStepId){
  const run=latest?.run;const state=String(run?.state||'');const revision=Number(run?.state_revision||0);
  const events=Array.isArray(latest?.events)?latest.events:[];const lastEvent=events[events.length-1];
  const alreadyRestarted=Boolean(run)&&String(lastEvent?.event_type||'')==='run.restart_requested'&&Number(lastEvent?.revision||0)===revision;
  const intents=Array.isArray(latest?.returnProgress)?latest.returnProgress:[];
  const commandStarted=intents.filter((item)=>String(item.command_state||'pending')!=='pending'||['commanded','verified','uncertain','failed'].includes(String(item.state||''))).length;
  const uncertain=intents.filter((item)=>String(item.command_state||'')==='uncertain'||String(item.state||'')==='uncertain').length;
  const stableRestart=['draft','acquiring','processing','needs_input','converting','validating_output','ready_for_review','waiting_confirmation','returning','verifying','succeeded','failed','cancelled','not_evaluable'].includes(state);
  const forceCancellable=state==='returning'&&uncertain===0;
  const restartEnabled=Boolean(run)&&stableRestart&&uncertain===0&&!alreadyRestarted;
  const restartReason=!run?'当前没有需要重置的 Run。'
    :alreadyRestarted?'当前 Run 已保留审计并返回新的上传入口。'
      :forceCancellable?'先强制取消剩余回传调度，保留已写入并验证的 Omnia 数据与全部审计，再建立新的上传入口。'
        :restartEnabled?(state==='succeeded'||state==='failed'?'保留终态 Run、命令、回执和读回审计；下一次上传建立新 Run。':state==='verifying'?'结束剩余本地核验调度，保留所有命令、回执、读回和已验证远端写入；不回滚、不重放。':'CAS 结束当前流程并保留 Artifact、修订、确认和事件审计；下一次上传建立新 Run。')
        :state==='uncertain'?`存在 ${uncertain||commandStarted} 个结果不确定的命令；只能先执行只读核验，禁止重新开始。`
          :['returning','verifying','reconciling'].includes(state)?`已有 ${commandStarted} 个命令进入写入或核验阶段；禁止取消或掩盖当前 Return。`
            :'后台校验仍在运行；完成或失败关闭前禁止重新开始。';
  let previousEnabled=false;let previousReason='';
  if(currentStepId==='upload')previousReason='当前已是第一步，没有可返回的上一步。';
  else if(['needs_input','ready_for_review'].includes(state)){previousEnabled=true;previousReason='返回上传并保留当前 Run、Artifact、字段修订和排除状态。';}
  else if(state==='waiting_confirmation'&&commandStarted===0){previousEnabled=true;previousReason='撤销未消费的冻结确认并返回校验；旧确认令牌立即失效。';}
  else if(state==='waiting_confirmation')previousReason='冻结确认已经产生命令或回执，禁止返回上一步。';
  else if(state==='uncertain')previousReason=`存在 ${uncertain||commandStarted} 个结果不确定的命令；只能先执行只读核验。`;
  else if(forceCancellable){previousEnabled=true;previousReason=`强制停止剩余本地回传调度；已写入并验证的 ${intents.filter((item)=>String(item.state||'')==='verified'||['readback_verified','closed_not_applied'].includes(String(item.command_state||''))).length} 项不会回滚或重放。`;}
  else if(['returning','verifying','reconciling'].includes(state))previousReason=`已有 ${commandStarted} 个命令进入写入或核验阶段；禁止返回上一步。`;
  else if(['succeeded','failed','cancelled','not_evaluable'].includes(state))previousReason='当前 Run 已进入终态；可重新开始新上传，但不能改写既有流程历史。';
  else previousReason='后台校验仍在运行；完成前禁止返回上一步。';
  return[
    legacyRecoveryAction(latest),
    {actionId:'fresh-start-on-reopen',enabled:restartEnabled,reason:restartReason},
    {actionId:'restart-run',label:'结束旧流程并全新开始',enabled:restartEnabled,reason:restartReason},
    {actionId:'back-to-upload',label:forceCancellable?'强制取消回传':'返回上一步',enabled:previousEnabled,reason:previousReason}
  ];
}
function terminalRunReturnsToFreshUpload(latest){
  const state=String(latest?.run?.state||'');
  const returnProgress=Array.isArray(latest?.returnProgress)?latest.returnProgress:[];
  return ['succeeded','failed','cancelled','not_evaluable'].includes(state)&&returnProgress.length===0;
}
const VALIDATION_CHECK_LABELS=[['template_structure','模板结构可识别'],['required_fields','必填项目已填写'],['valid_values','名称与填写内容合法'],['unique_names','批次内元素 ID 与 GRA 名称唯一'],['omnia_id_conflicts','已核验当前 Pack 与回收站中的同名元素影响'],['infrastructure_links','基础设施已关联系统'],['infrastructure_rait','多系统 RAIT 按 Higher 优先归并'],['relationship_targets','关联目标可解析且类型正确'],['workspace_presence','Omnia 工作区已填写'],['factors_considered_ai_review','Factors Considered 智能复核'],['workspace_live','Omnia 工作区名称实时有效']];
function validationPresentation(parsed,live={}){
  const normalizedLive={...live};
  if(live.workspace_live?.state==='failed'){
    for(const checkId of ['omnia_id_conflicts','relationship_targets','infrastructure_rait']){
      if(!normalizedLive[checkId]||normalizedLive[checkId].state==='pending') normalizedLive[checkId]={state:'failed',reason:live.workspace_live.reason};
    }
  }
  const activePrefixes=new Set(activeRows(parsed).map((row)=>`${row.rowKey}.`));
  const activeKeys=new Set((parsed.candidates||[]).filter((candidate)=>activeRows(parsed).some((row)=>candidate.provenance?.rowKey===row.rowKey||candidate.rowKey===row.rowKey)).map((candidate)=>candidate.fieldKey));
  const issues=(parsed.issues||[]).filter((candidate)=>candidate.state!=='resolved'&&(activeKeys.has(candidate.fieldKey)||!String(candidate.fieldKey).includes('.')||String(candidate.fieldKey).startsWith('global.')||String(candidate.fieldKey).startsWith('workbook.')||[...activePrefixes].some((prefix)=>String(candidate.fieldKey).startsWith(prefix))));
  const errors=issues.filter((candidate)=>['needs_input','blocking'].includes(candidate.state)); const warnings=issues.filter((candidate)=>candidate.state==='waived');
  const inferredCheck=(candidate)=>candidate.checkId
    ||(candidate.issueType==='missing'?'required_fields':candidate.issueType==='invalid_enum'?'valid_values':String(candidate.fieldKey).endsWith('.identity')?'unique_names':String(candidate.fieldKey).endsWith('.relations')?'infrastructure_links':String(candidate.fieldKey).endsWith('.inheritance')?'infrastructure_rait':String(candidate.fieldKey).includes('relationship-target')?'relationship_targets':String(candidate.fieldKey).includes('workspace_live')?'workspace_live':'template_structure');
  const checkFailed=(id)=>errors.some((candidate)=>inferredCheck(candidate)===id);const workspaceKeys=new Set((parsed.candidates||[]).filter((candidate)=>candidate.rawFieldKey==='Omnia工作区').map((candidate)=>candidate.fieldKey));const workspaceMissing=errors.some((candidate)=>workspaceKeys.has(candidate.fieldKey)||String(candidate.fieldKey).endsWith(`.missing.${digest('Omnia工作区')}`)); const liveCheck=(id)=>normalizedLive[id]||{state:'pending',reason:'未执行实时校验，不视为通过。'};
  const liveState=(id)=>checkFailed(id)?'failed':liveCheck(id).state;
  const checks=[
    ['template_structure','模板结构可识别',checkFailed('template_structure')?'failed':'passed',checkFailed('template_structure')?'存在未映射列、结构问题或未归类阻断项。':'XLSX 容器、工作表与区段已从真实字节解析。'],
    ['required_fields','必填项目已填写',checkFailed('required_fields')?'failed':'passed',checkFailed('required_fields')?'存在缺失必填值。':'非排除行必填值完整。'],
    ['valid_values','名称与填写内容合法',checkFailed('valid_values')?'failed':'passed',checkFailed('valid_values')?'存在不受支持能力、超长值、枚举或非法名称。':'子类型、RAIT、长度与名称符合已发布规则。'],
    ['unique_names','批次内元素 ID 与 GRA 名称唯一',checkFailed('unique_names')?'failed':'passed',checkFailed('unique_names')?'存在重复元素 ID 或派生 GRA 名。':'元素 ID 与派生 GRA 名在批内唯一。'],
    ['omnia_id_conflicts','已核验当前 Pack 与回收站中的同名元素影响',liveState('omnia_id_conflicts'),checkFailed('omnia_id_conflicts')?'活动对象、创建能力或回收站证明未闭合。':liveCheck('omnia_id_conflicts').reason],
    ['infrastructure_links','基础设施已关联系统',checkFailed('infrastructure_links')?'failed':'passed',checkFailed('infrastructure_links')?'基础设施必须至少填写一个 APP 关系目标，且不能重复或指向明确的非 APP 行。':'基础设施已填写一个或多个 APP 关系目标；批外及跨工作区目标将在实时校验中精确解析并提醒。'],
    ['infrastructure_rait','多系统 RAIT 按 Higher 优先归并',liveState('infrastructure_rait'),checkFailed('infrastructure_rait')?'关联 APP 的 RAIT 缺失、无效或未通过当前 Pack 的精确身份校验。':liveCheck('infrastructure_rait').reason],
    ['relationship_targets','关联目标可解析且类型正确',liveState('relationship_targets'),checkFailed('relationship_targets')?'DB/OS/Tool/DCNO 存在缺失、歧义、非 APP 或未通过当前 Pack 精确身份校验的关系目标。批外与跨工作区本身仅作提醒。':liveCheck('relationship_targets').reason],
    ['workspace_presence','Omnia 工作区已填写',workspaceMissing?'failed':'passed',workspaceMissing?'存在缺失工作区。':'所有非排除行已填写工作区。'],
    ['factors_considered_ai_review','Factors Considered 智能复核',liveCheck('factors_considered_ai_review').state,liveCheck('factors_considered_ai_review').reason],
    ['workspace_live','Omnia 工作区名称实时有效',liveCheck('workspace_live').state,liveCheck('workspace_live').reason]
  ];
  const pending=checks.filter((item)=>item[2]==='pending').length,failed=checks.filter((item)=>item[2]==='failed').length,completed=checks.length-pending;
  return {progress:{label:'校验进度',completed,total:checks.length,percent:Math.floor(completed*100/checks.length),state:failed?'failed':checks.some((item)=>item[2]==='warning')||warnings.length?'warning':pending?'pending':'passed',message:`${completed}/${checks.length} 项已执行；error ${errors.length}，warning ${warnings.length}。`,items:checks.map(([itemId,label,state,detail])=>({itemId,label,state,detail}))},issues:errors.map((issue)=>{const row=parsed.rows.find((candidate)=>String(issue.fieldKey).startsWith(`${candidate.rowKey}.`));return{issueId:issue.issueId,scope:row?(issue.fieldKey.includes('.identity')?'element':'field'):'global',severity:'error',elementId:row?.elementId||'',fieldKey:issue.fieldKey,message:issue.message};})};
}
function reviewBlocked(parsed,live={}){return validationPresentation(parsed,live).progress.items.some((item)=>item.state==='failed'||item.state==='pending');}
const REVIEW_FIELDS_BY_KIND=new Proxy({}, {get(_target,kind){return kindCapability(String(kind)).reviewFields.map((field)=>[field.rawFieldKey,field.label,field.inputKind,field.required,field.maxLength]);}});
function reviewAllowedValues(parsed,raw){for(const spec of Object.values(parsed?.kindRegistry||ACTIVE_KIND_REGISTRY||{})){const field=spec.reviewFields.find((item)=>item.rawFieldKey===raw);if(field)return field.allowedValues||[];}return[];}
function activeRows(parsed){const excluded=new Set(parsed.excludedRowKeys||[]);return (parsed.rows||[]).filter((row)=>!excluded.has(row.rowKey));}
function aiReviewEligibleRows(parsed){return activeRows(parsed).filter((row)=>kindCapability(String(row.kind),parsed?.kindRegistry).capabilities?.aiReview===true);}
function reviewCandidate(parsed,row,raw){return (parsed.candidates||[]).find((candidate)=>candidate.provenance?.rowKey===row.rowKey&&candidate.rawFieldKey===raw);}
function activeReviewIssues(parsed){
  const excluded=new Set(parsed.excludedRowKeys||[]),rows=parsed.rows||[],used=new Set();
  return (parsed.issues||[])
    .filter((issue)=>issue.state!=='resolved'&&!rows.some((row)=>excluded.has(row.rowKey)&&String(issue.fieldKey).startsWith(`${row.rowKey}.`)))
    .map((issue,index)=>{
      const original=String(issue.issueId||'').trim();let issueId=original;
      if(!issueId||used.has(issueId)) issueId=`${original||'legacy-review-issue'}.compat.${digest(`${original}|${issue.code||''}|${issue.fieldKey||''}|${issue.message||''}|${index}`).slice(0,16)}`;
      while(used.has(issueId)) issueId=`${issueId}.${index}`;
      used.add(issueId);return issueId===original?issue:{...issue,issueId};
    });
}
function reviewPresentation(parsed){
  const rows=parsed.rows||[],active=activeRows(parsed),issues=activeReviewIssues(parsed);const firstIssue=issues.find((issue)=>['needs_input','blocking'].includes(issue.state));const selected=active.find((row)=>firstIssue&&String(firstIssue.fieldKey).startsWith(`${row.rowKey}.`))||active[0]||rows[0];const fields=[];
  for(const row of active){for(const [raw,label,inputKind,required,maxLength] of REVIEW_FIELDS_BY_KIND[row.kind]){const candidate=reviewCandidate(parsed,row,raw);const messages=issues.filter((issue)=>['needs_input','blocking'].includes(issue.state)&&(issue.fieldKey===candidate?.fieldKey||String(issue.fieldKey).startsWith(`${row.rowKey}.`)&&issue.message.includes(raw))).map((issue)=>issue.message);fields.push({rowKey:row.rowKey,kind:row.kind,fieldKey:candidate?.fieldKey||`${row.rowKey}.readonly.${digest(raw)}`,rawFieldKey:raw,label,expectedRevision:Number(candidate?.revision||0),inputKind,currentValue:String(row.fields[raw]??''),allowedValues:reviewAllowedValues(parsed,raw),required:Boolean(required),maxLength:Number(maxLength),editable:inputKind!=='readonly'&&Boolean(candidate),message:messages.join(' '),sourceSheet:candidate?.provenance?.sourceSheet||row.sourceSheet,sourceRow:Number(candidate?.provenance?.sourceRow||row.sourceRow),derivation:candidate?.provenance?.derivationRule||'verbatim_user_workbook_cell'});}const gra=reviewCandidate(parsed,row,'Derived GRA Name');fields.push({rowKey:row.rowKey,kind:row.kind,fieldKey:gra?.fieldKey||`${row.rowKey}.derived.gra-name`,rawFieldKey:'Derived GRA Name',label:'GRA 名称（派生）',expectedRevision:Number(gra?.revision||0),inputKind:'readonly',currentValue:String(gra?.value??deriveGraName(row.elementId)),allowedValues:[],required:true,maxLength:200,editable:false,message:'',sourceSheet:gra?.provenance?.sourceSheet||row.sourceSheet,sourceRow:Number(gra?.provenance?.sourceRow||row.sourceRow),derivation:gra?.provenance?.derivationRule||'v4.phase1-gra-name-from-element-id.v1'});const rawDescription=descriptionRawField(row.kind),description=reviewCandidate(parsed,row,rawDescription);fields.push({rowKey:row.rowKey,kind:row.kind,fieldKey:description?.fieldKey||`${row.rowKey}.derived.description`,rawFieldKey:rawDescription,label:'Description（派生）',expectedRevision:Number(description?.revision||1),inputKind:'readonly',currentValue:String(description?.value??row.elementId),allowedValues:[],required:true,maxLength:200,editable:false,message:'',sourceSheet:description?.provenance?.sourceSheet||'字段母版',sourceRow:Number(description?.provenance?.sourceRow||0),derivation:description?.provenance?.derivationRule||descriptionRuleId(row.kind)});}
  const kinds=[['APP','Application'],['DB','Database'],['OS','Operating System'],['TOOL','IT Tool'],['DCNO','DCNO']];return{selectedKind:selected?.kind||'APP',selectedRowKey:selected?.rowKey||'',elementTypes:kinds.map(([kind,label])=>{const typed=active.filter((row)=>row.kind===kind),typedIssues=issues.filter((issue)=>typed.some((row)=>String(issue.fieldKey).startsWith(`${row.rowKey}.`)));return{kind,label,count:typed.length,issueCount:typedIssues.filter((issue)=>['needs_input','blocking'].includes(issue.state)).length,warningCount:typedIssues.filter((issue)=>issue.state==='waived').length,disabled:typed.length===0,reason:typed.length?'':`本批没有 ${label} 行。`};}),elements:rows.map((row)=>{const rowIssues=issues.filter((issue)=>String(issue.fieldKey).startsWith(`${row.rowKey}.`));return{rowKey:row.rowKey,kind:row.kind,elementId:row.elementId,label:`${row.elementId} · ${row.sourceSheet}:${row.sourceRow}`,sourceSheet:row.sourceSheet,sourceRow:row.sourceRow,issueCount:rowIssues.filter((issue)=>['needs_input','blocking'].includes(issue.state)).length,warningCount:rowIssues.filter((issue)=>issue.state==='waived').length,derivedDisplay:`${deriveGraName(row.elementId)} / ${String(row.fields[descriptionRawField(row.kind)]||row.elementId)}`,inheritanceDecision:row.inheritanceDecision||null,blocking:rowIssues.some((issue)=>['needs_input','blocking'].includes(issue.state)),excluded:(parsed.excludedRowKeys||[]).includes(row.rowKey)};}),fields,issueOrder:issues.filter((issue)=>['needs_input','blocking'].includes(issue.state)).map((issue)=>{const row=rows.find((candidate)=>String(issue.fieldKey).startsWith(`${candidate.rowKey}.`));return{issueId:issue.issueId,rowKey:row?.rowKey||'',fieldKey:issue.fieldKey,severity:'error',message:issue.message};})};
}
function reviewSurface(latest,plan,compiled,message){const parsed=plan.parsed,progress=progressSurface(latest,parsed),validation=validationPresentation(parsed,plan.liveValidation||{}),returnBlocked=reviewBlocked(parsed,plan.liveValidation||{}),activeCount=activeRows(parsed).length;return{stateVersion:Number(latest.run.state_revision),status:returnBlocked?'blocked':'ready',statusMessage:message,scopes:progress.scopes,items:progress.items,workflow:progress.workflow,progress:validation.progress,issues:validation.issues,review:reviewPresentation(parsed),editors:[],artifacts:[],actions:[
  {actionId:'download-source-template',enabled:false,reason:'校验步骤不显示上传动作。'},{actionId:'stage-source-workbook',enabled:false,reason:'请先返回上传。'},{actionId:'confirm-upload',enabled:false,reason:'当前资料已经确认。'},{actionId:'validate-staged-upload',enabled:false,reason:'当前校验已经完成。'},
  ...workflowNavigationActions(latest,'validate'),{actionId:'apply-revisions',enabled:true,reason:'保存所有 dirty 字段并完整重跑校验。'},{actionId:'remove-batch-row',enabled:activeCount>1,reason:activeCount>1?'仅移出本批，不调用 Connector，不删除 Omnia。':'批次仅剩一行，禁止移除。'},{actionId:'revalidate-all',enabled:true,reason:'在原 Run 上重跑全部本地与可用实时校验。'},{actionId:'prepare-return',enabled:!returnBlocked,reason:returnBlocked?'存在 error、未执行实时项或全局 blocker。':''},
  {actionId:'confirm-return',enabled:false,reason:'请先提交审核并冻结回传计划。'},{actionId:'continue-return',enabled:false,reason:'当前没有可继续的冻结计划。'},{actionId:'reconcile-return',enabled:false,reason:'当前没有待核验的写入结果。'}]};}
function uploadSurface(latest,message,fresh=false){
  const run=latest?.run;const staged=run?.state==='acquiring';const recoveryOnly=legacyRecoveryAction(latest).enabled===true;
  const workflow={revision:Math.max(1,Number(latest?.run?.state_revision||1)),currentStepId:'upload',steps:[
    {stepId:'upload',label:'上传资料',state:'current',detail:'上传系统信息'},
    {stepId:'validate',label:'校验',state:'pending',detail:'等待上传'},
    {stepId:'return',label:'回传',state:'pending',detail:'等待校验通过'}
  ]};
  const source=staged?(latest.artifacts||[]).filter((item)=>String(item.kind)==='source').slice(-1):[];
  return{stateVersion:Number(run?.state_revision||1),status:'ready',statusMessage:message,scopes:[],items:[],workflow,clearFields:['progress','review'],issues:[],editors:[],artifacts:source.map((item)=>({artifactId:String(item.artifact_id),kind:'source',name:String(item.original_name),sha256:String(item.sha256),sizeBytes:Number(item.size_bytes),available:false,reason:'待确认上传'})),actions:[
    {actionId:'download-source-template',enabled:!recoveryOnly,reason:recoveryOnly?'请先只读核验并关闭旧中断 Run。':''},{actionId:'stage-source-workbook',enabled:!recoveryOnly,reason:recoveryOnly?'请先只读核验并关闭旧中断 Run。':''},{actionId:'confirm-upload',enabled:!recoveryOnly&&staged,reason:recoveryOnly?'请先只读核验并关闭旧中断 Run。':staged?'':'请先选择或拖入一个 .xlsx 文件。'},{actionId:'validate-staged-upload',enabled:false,reason:recoveryOnly?'请先只读核验并关闭旧中断 Run。':'等待确认上传。'},
    ...workflowNavigationActions(latest,'upload'),{actionId:'apply-revisions',enabled:false,reason:'等待校验。'},{actionId:'remove-batch-row',enabled:false,reason:'等待校验。'},{actionId:'revalidate-all',enabled:false,reason:'等待校验。'},{actionId:'prepare-return',enabled:false,reason:'等待校验通过。'},
    {actionId:'confirm-return',enabled:false,reason:'请先提交审核并冻结回传计划。'},{actionId:'continue-return',enabled:false,reason:'当前没有可继续的冻结计划。'},{actionId:'reconcile-return',enabled:false,reason:'当前没有待核验的写入结果。'}]};
}
function processingSurface(latest,message,validationProgress=null){
  const completedResults=new Map((Array.isArray(validationProgress?.results)?validationProgress.results:[]).map((item)=>[String(item.itemId),item]));
  const completed=completedResults.size,total=VALIDATION_CHECK_LABELS.length;
  return{stateVersion:Number(latest.run.state_revision),status:'loading',statusMessage:message,scopes:[],items:[],workflow:workflowSurface(latest),progress:{label:'校验进度',completed,total,percent:Math.floor(completed*100/total),state:'running',message:`正在校验 ${completed}/${total}`,items:VALIDATION_CHECK_LABELS.map(([itemId,label])=>{const result=completedResults.get(itemId);return{itemId,label,state:result?.state||'pending',detail:result?.detail||'等待后台校验。'};})},issues:[],editors:[],artifacts:[],clearFields:['review'],actions:[
    {actionId:'download-source-template',enabled:false,reason:'正在校验。'},{actionId:'stage-source-workbook',enabled:false,reason:'正在校验。'},{actionId:'confirm-upload',enabled:false,reason:'已确认上传。'},{actionId:'validate-staged-upload',enabled:true,reason:''},...workflowNavigationActions(latest,'validate'),{actionId:'apply-revisions',enabled:false,reason:'正在校验。'},{actionId:'remove-batch-row',enabled:false,reason:'正在校验。'},{actionId:'revalidate-all',enabled:false,reason:'正在校验。'},{actionId:'prepare-return',enabled:false,reason:'正在校验。'},
    {actionId:'confirm-return',enabled:false,reason:'请先提交审核并冻结回传计划。'},{actionId:'continue-return',enabled:false,reason:'当前没有可继续的冻结计划。'},{actionId:'reconcile-return',enabled:false,reason:'当前没有待核验的写入结果。'}]};
}
function returnSurface(latest,message,execution={}){
  const run=latest?.run;const progress=progressSurface(latest);const state=String(run?.state||'');
  const status=state==='succeeded'?'ready':state==='failed'?'error':state==='uncertain'?'stale':'loading';
  const intents=latest?.returnProgress||[]; const completed=intents.filter((item)=>item.command_state==='readback_verified').length; const effectiveCompleted=state==='succeeded'?intents.length:completed;const percent=intents.length?Math.floor(effectiveCompleted*100/intents.length):0;
  const intentState=(item)=>item.command_state==='readback_verified'?'passed':item.state==='uncertain'||item.command_state==='uncertain'?'uncertain':item.state==='failed'||item.command_state==='failed'?'failed':['submitted','committed'].includes(item.command_state)?'running':'pending';
  const category=(item)=>{const key=String(item.target_key||''),kind=String(item.target_kind||'');if(kind==='object'&&key.startsWith('object|'))return'元素';if(kind==='object'&&key.startsWith('gra|'))return'GRA';if(kind==='relation')return'关系';if(kind==='risk_control')return'Risk-Control';return'设置';};
  const categoryOrder=['元素','GRA','关系','Risk-Control','设置'];
  const grouped=categoryOrder.map((label)=>({label,rows:intents.filter((item)=>category(item)===label)})).filter((group)=>group.rows.length).map((group,index)=>{
    const states=group.rows.map(intentState),done=states.filter((value)=>value==='passed').length,failedCount=states.filter((value)=>value==='failed').length,uncertainCount=states.filter((value)=>value==='uncertain').length,runningCount=states.filter((value)=>value==='running').length;
    const groupState=failedCount?'failed':uncertainCount?'uncertain':runningCount?'running':done===group.rows.length?'passed':'pending';
    return{itemId:`return-group-${index}`,label:group.label,state:groupState,detail:'',completed:done,total:group.rows.length,percent:group.rows.length?Math.floor(done*100/group.rows.length):0};
  });
  const forceCancelled=execution?.state==='force_cancelled';
  const issues=state==='failed'?[{issueId:`return-failed-${String(run?.run_id||'run')}`,scope:'global',severity:forceCancelled?'warning':'error',elementId:'',fieldKey:'return',message:forceCancelled?'回传已按用户要求强制取消。已在 Omnia 写入并验证的内容保持不变；剩余计划不会继续调度，也不会执行回滚或重放。':'回传未完成，本次计划已安全停止。请重新建立回传计划；系统会复用已经写入并验证的内容。'}]
    :state==='uncertain'?[{issueId:`return-uncertain-${String(run?.run_id||'run')}`,scope:'global',severity:'warning',elementId:'',fieldKey:'return',message:'写入结果尚未完成核验，请保持当前页面并执行只读核验。'}]:[];
  for(const failed of Array.isArray(execution.itemFailures)?execution.itemFailures:[])issues.push({issueId:`return-item-${failed.rowKey}`,scope:'element',severity:failed.state==='uncertain'?'warning':'error',elementId:String(failed.elementId||''),fieldKey:`${failed.rowKey}.return`,message:String(failed.message||'Return item was isolated.').slice(0,500)});
  return {stateVersion:Number(run?.state_revision||1),status,statusMessage:message||(forceCancelled?'回传已强制取消；已验证的远端结果与完整审计均已保留，现在可以重新开始。':''),workflow:progress.workflow,clearFields:['review'],
    progress:{label:'回传进度',completed:effectiveCompleted,total:intents.length,percent,state:state==='uncertain'?'uncertain':state==='failed'?'failed':state==='succeeded'?'passed':'running',message:'',items:grouped},
    scopes:[],items:[],editors:[],issues,artifacts:[],actions:[
      {actionId:'download-source-template',enabled:false,reason:'回传阶段不再显示上传操作。'},
      {actionId:'stage-source-workbook',enabled:false,reason:'回传阶段不再显示上传操作。'},
      {actionId:'confirm-upload',enabled:false,reason:'上传已经完成。'},
      {actionId:'validate-staged-upload',enabled:false,reason:'校验已经完成。'},
      ...workflowNavigationActions(latest,'return'),
      {actionId:'apply-revisions',enabled:false,reason:'回传阶段不接受字段修订。'},
      {actionId:'remove-batch-row',enabled:false,reason:'回传阶段不接受批次修改。'},
      {actionId:'revalidate-all',enabled:false,reason:'校验已经完成。'},
      {actionId:'prepare-return',enabled:false,reason:'回传计划已冻结或已完成。'},
      {actionId:'confirm-return',enabled:state==='waiting_confirmation',reason:state==='waiting_confirmation'?'':'当前不在待确认阶段。'},
      {actionId:'continue-return',enabled:state==='returning',reason:state==='returning'?'':'当前没有可继续的冻结计划。'},
      {actionId:'reconcile-return',enabled:state==='uncertain',reason:state==='uncertain'?'':'当前没有待核验的写入结果。'}]};
}

async function forceCancelReturnRun(store,latest){
  const run=latest?.run;const runId=String(run?.run_id||'');
  if(!runId||String(run.state)!=='returning')fail('RETURN.FORCE_CANCEL_STATE','只有正在回传且没有不确定写入的当前 Run 可以强制取消。');
  const progress=Array.isArray(latest.returnProgress)?latest.returnProgress:await store.call('loadReturnProgress',{runId});
  const uncertain=progress.filter((item)=>String(item.state||'')==='uncertain'||String(item.command_state||'')==='uncertain');
  if(uncertain.length)fail('RETURN.FORCE_CANCEL_UNCERTAIN','存在写入结果不确定的命令；必须先完成只读核验，禁止强制取消。');
  const verified=progress.filter((item)=>String(item.state||'')==='verified'||['readback_verified','closed_not_applied'].includes(String(item.command_state||''))).length;
  const total=progress.length;const cancelledAt=new Date().toISOString();
  const stateRevision=await store.call('transitionRun',{runId,expectedRevision:Number(run.state_revision),toState:'failed',eventType:'return.force_cancelled',error:`用户强制取消剩余回传调度；已验证 ${verified}/${total} 项保持不变，未执行回滚或重放。`,details:{verifiedTargets:verified,totalTargets:total,remainingTargets:Math.max(0,total-verified),remoteRollback:false,mutationReplay:false}});
  const checkpoint=await store.call('loadPlan',runId);
  const execution={...(checkpoint?.execution||{}),state:'force_cancelled',partial:verified<total,forceCancelledAt:cancelledAt,verifiedTargets:verified,totalTargets:total,remainingTargets:Math.max(0,total-verified),remoteRollback:false,mutationReplay:false};
  if(checkpoint)await store.call('savePlan',{...checkpoint,execution,updatedAt:cancelledAt});
  return{runId,stateRevision:Number(stateRevision),verified,total,execution};
}

async function closeRunForFreshStart(store,latest,forceCancelledRuns=new Set(),trigger='explicit_feature_fresh_start'){
  let run=latest?.run;const initialState=String(run?.state||'');const runId=String(run?.run_id||'');
  if(!runId)fail('RUN.RESTART_BLOCKED','No current Run is available to restart.');
  const progress=Array.isArray(latest?.returnProgress)?latest.returnProgress:await store.call('loadReturnProgress',{runId});
  const uncertain=(Array.isArray(progress)?progress:[]).filter((item)=>String(item?.state||'')==='uncertain'||String(item?.command_state||'')==='uncertain');
  if(['uncertain','reconciling'].includes(initialState)||uncertain.length){
    fail('RUN.RESTART_RECONCILE_REQUIRED','旧流程存在未闭合的写入结果；必须先执行只读核验，禁止丢弃、回滚或重放。');
  }
  if(initialState==='returning'){
    forceCancelledRuns.add(runId);
    try{await forceCancelReturnRun(store,{...latest,returnProgress:Array.isArray(progress)?progress:[]});}
    catch(error){forceCancelledRuns.delete(runId);throw error;}
  }else if(['draft','processing'].includes(initialState)){
    const nextState='cancelled';
    await store.call('transitionRun',{runId,expectedRevision:Number(run.state_revision),toState:nextState,eventType:'run.fresh_start_force_closed',details:{trigger,preserveArtifacts:true,preserveRevisions:true,remoteRollback:false,mutationReplay:false}});
  }else if(['converting','validating_output','verifying'].includes(initialState)){
    forceCancelledRuns.add(runId);
    const verified=(Array.isArray(progress)?progress:[]).filter((item)=>String(item?.state||'')==='verified'||['readback_verified','closed_not_applied'].includes(String(item?.command_state||''))).length;
    await store.call('transitionRun',{runId,expectedRevision:Number(run.state_revision),toState:'failed',eventType:'run.fresh_start_force_closed',error:`Feature fresh start closed ${initialState}; verified remote results and immutable audit were preserved.`,details:{trigger,interruptedStage:initialState,verifiedTargets:verified,totalTargets:Array.isArray(progress)?progress.length:0,preserveArtifacts:true,preserveRevisions:true,preserveCommands:true,preserveReceipts:true,remoteRollback:false,mutationReplay:false}});
  }
  latest=await store.call('loadLatestRun',{});run=latest?.run;
  if(!run||String(run.run_id)!==runId)fail('RUN.RESTART_IDENTITY_DRIFT','Current Run identity changed while closing the old workflow.');
  const restarted=await store.call('restartRun',{runId,expectedRevision:Number(run.state_revision)});
  const current=await store.call('loadLatestRun',{});
  return{current,restarted,initialState,runId};
}

function createFeatureWorker(dependencies) {
  if (!dependencies?.store?.call) fail('WORKER.STORE_REQUIRED', 'A typed persistent Store port is required.');
  const store = dependencies.store;
  const forceCancelledRuns=new Set();
  const connector = dependencies.connector;
  // The Feature has row-level and within-GRA parallelism, while Connector Next
  // exposes eight execution lanes. Limit only each individual signed Operation
  // call (never a whole row or dependency stage), so nested work cannot retain
  // a permit while waiting for another permit and the durable remote queue is
  // not overfilled by dozens of command promises.
  const withRemoteOperationPermit = createFifoOperationLimiter(RETURN_MAX_CONCURRENCY);
  const ai = dependencies.ai;
  const {createPythonSidecarBridge}=require('./create-associate-python-bridge.cjs');
  const python=createPythonSidecarBridge({ports:dependencies,maxFrameBytes:1024*1024,requestTimeoutMs:120000,heartbeatIntervalMs:5000,heartbeatTimeoutMs:15000});
  if (!connector?.invoke) fail('WORKER.CONNECTOR_REQUIRED', 'A signed Operation Connector port is required.');
  const governance = dependencies.governance || (GOVERNANCE.startsWith('__') ? null : JSON.parse(GOVERNANCE));
  if (!governance || governance.sourceSha256 !== V8_SHA256 || Number(governance.fieldCount)<187 || Number(governance.relationCount)<68) {
    fail('GOVERNANCE.NOT_FROZEN', 'The signed V8-derived governance contract is unavailable or drifted.');
  }
  installKindRegistry(governance);
  const governanceSemanticDigest = digest(Buffer.from(canonical({
    kindRegistry: governance.kindRegistry, fields: governance.fields, relations: governance.relations, scoringItems: governance.scoringItems, derivationRules: governance.derivationRules
  })));
  const compatibleFrozenGovernanceDigests=new Set([governance.semanticDigest]);
  for(const entry of governance.catalogIdentityRegistry?.compatibleFrozenGovernanceDigests||[]){
    if(entry?.scope!=='execution_catalog_alias_only'||!/^[0-9a-f]{64}$/u.test(String(entry.semanticDigest||''))
      ||!String(entry.relationIdPrefix||'').trim()||!String(entry.evidenceRef||'').trim()
      ||!governance.relations.some((relation)=>String(relation.relationId||'').startsWith(String(entry.relationIdPrefix)))){
      fail('GOVERNANCE.CATALOG_ALIAS_COMPATIBILITY_INVALID','Signed execution catalog-alias compatibility evidence is invalid.');
    }
    compatibleFrozenGovernanceDigests.add(String(entry.semanticDigest));
  }
  const governanceRelationById=new Map(governance.relations.map((relation)=>[String(relation.relationId||''),relation]));
  const catalogIdentityFields=new Set(['catalogIdentityRequired','catalogControlNumber','catalogIdentityStatus','catalogIdentityEvidence']);
  const withoutCatalogIdentity=(relation)=>Object.fromEntries(Object.entries(relation||{}).filter(([key])=>!catalogIdentityFields.has(key)));
  const executionCatalogRelations=(frozenRelations)=>(frozenRelations||[]).map((frozen)=>{
    const current=governanceRelationById.get(String(frozen?.relationId||''));
    if(!current||canonical(withoutCatalogIdentity(current))!==canonical(withoutCatalogIdentity(frozen))){
      fail('RETURN.CATALOG_ALIAS_BUSINESS_DRIFT',`Execution catalog alias relation differs from the frozen business relation: ${String(frozen?.relationId||'')}.`);
    }
    if(current.catalogIdentityStatus!=='signed_live_exact')return frozen;
    if(current.catalogIdentityRequired!==true||!String(current.catalogControlNumber||'').trim()
      ||!String(current.catalogIdentityEvidence?.evidenceRef||'').trim()||!String(current.catalogIdentityEvidence?.sourceTraceId||'').trim()){
      fail('RETURN.CATALOG_ALIAS_EVIDENCE_INVALID',`Execution catalog alias has no exact signed evidence: ${String(frozen?.relationId||'')}.`);
    }
    return{...frozen,catalogIdentityRequired:true,catalogControlNumber:current.catalogControlNumber,
      catalogIdentityStatus:current.catalogIdentityStatus,catalogIdentityEvidence:current.catalogIdentityEvidence};
  });
  const ensureStagedPlan=async(latest)=>{
    const run=latest?.run;if(!run||run.state!=='acquiring'||!run.source_artifact_id)fail('RUN.NOT_STAGED','The latest Run has no recoverable staged source.');
    const existing=await store.call('loadPlan',String(run.run_id));if(existing?.descriptor)return existing;
    const artifact=await store.call('readArtifactBytes',{artifactId:String(run.source_artifact_id)});
    if(String(artifact.runId)!==String(run.run_id)||String(artifact.traceId)!==String(run.trace_id)||artifact.kind!=='source')fail('ARTIFACT.RUN_BINDING_MISMATCH','Recovered staged artifact binding drifted.');
    const descriptor={schemaVersion:'omnia.feature-artifact/v1',artifactId:String(artifact.artifactId),runId:String(artifact.runId),traceId:String(artifact.traceId),featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,surfaceId:'create-associate.workbench',kind:'source',originalName:String(artifact.originalName),mediaType:String(artifact.mediaType),sizeBytes:Number(artifact.sizeBytes),sha256:String(artifact.sha256),importedAt:String(artifact.importedAt)};
    const recovered={schemaVersion:'omnia.create-associate.staged-upload/v1',planId:String(run.run_id),runId:String(run.run_id),traceId:String(run.trace_id),descriptor,
      stageState:'acquiring',updatedAt:new Date().toISOString()};
    await store.call('savePlan',recovered);return recovered;
  };
  const toolSpec=kindCapability('TOOL');const toolRelationFieldId=toolSpec.aliases?.[toolSpec.relation];
  const toolApplicationExtension=governance.fields?.find((field)=>field.fieldId===toolRelationFieldId);
  if (!Array.isArray(governance.fields) || governance.fields.length !== Number(governance.fieldCount)
    || !Array.isArray(governance.relations) || governance.relations.length !== Number(governance.relationCount)
    || !Array.isArray(governance.scoringItems) || governance.scoringItems.length < 15
    || !toolApplicationExtension || Number(toolApplicationExtension.sourceRow)!==48
    || toolApplicationExtension.sourceTraceId!=='SRC.IT元素.060'
    || governance.semanticDigest !== governanceSemanticDigest) {
    fail('GOVERNANCE.IR_DRIFT', 'The signed governance IR semantic digest or inventory drifted.');
  }
  const graNameRule=governance.derivationRules.find((item)=>item.ruleId==='v4.phase1-gra-name-from-element-id.v1');
  if(!graNameRule||graNameRule.algorithm!=='prefix_literal'||graNameRule.prefix!=='GRA-')fail('GOVERNANCE.GRA_NAME_RULE_MISSING','Signed v4 canonical GRA naming rule is unavailable.');

  async function invokePythonJson(method,payload,runId,maxBytes=32*1024*1024){
    const resultHandle=await store.call('createPythonOutputHandle',{runId,kind:'transient_json',mediaType:'application/json',originalName:`${method}-${runId}.json`,maxBytes});
    const value=await python.invoke(method,{...payload,resultHandle},{runId});
    if(value?.artifact&&value.contentSchemaVersion){
      const decoded=await store.call('readPythonJsonHandle',{handle:value.artifact});
      if(!decoded||decoded.schemaVersion!==value.contentSchemaVersion||String(decoded.semanticDigest||'')!==String(value.semanticDigest||''))fail('PYTHON.RESULT_HANDLE_DRIFT','Managed Python JSON result identity drifted.');
      return decoded;
    }
    return value;
  }

  async function compileInstance(parsed, descriptor, runId, traceId) {
    const runtimeBase = await store.call('openPythonArtifactHandle', { runId, memberPath: 'backend/runtime-template-base.xlsx' });
    if (runtimeBase.assetKind !== 'runtime_template_base' || !/^[0-9a-f]{64}$/u.test(String(runtimeBase.memberDigest || ''))) {
      fail('OUTPUT.BASE_NOT_MANAGED', 'The signed runtime-template base workbook is unavailable.');
    }
    const outputWorkbookHandle=await store.call('createPythonOutputHandle',{
      runId,kind:'template_instance',mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      originalName:`create-associate-${runId}.xlsx`,maxBytes:64*1024*1024
    });
    const parsedHandle=await store.call('createPythonJsonInputHandle',{runId,value:parsed,maxBytes:32*1024*1024});
    const result=await python.invoke('compile_workbook',{
      schemaVersion:'omnia.create-associate.python-operation/v1',baseWorkbookHandle:runtimeBase,parsedHandle,
      metadata:{runId,traceId,sourceArtifactId:descriptor.artifactId,governanceDigest:governance.sourceSha256},outputWorkbookHandle
    },{runId});
    const compiled=result?.workbook;
    if(!compiled||compiled.schemaVersion!=='omnia.create-associate.compiled-workbook/v1'||result?.artifact?.handleId!==outputWorkbookHandle.handleId
      ||compiled.sha256!==result.artifact.sha256||compiled.sizeBytes!==result.artifact.sizeBytes
      ||compiled.baseDigest!==runtimeBase.memberDigest||!Array.isArray(compiled.declaredParts))fail('OUTPUT.PYTHON_COMPILE_INVALID','Managed Python workbook compiler returned an invalid deterministic descriptor.');
    const output=await store.call('commitPythonOutputHandle',{handleId:result.artifact.handleId,sha256:compiled.sha256});
    const templateVersion = FEATURE_VERSION;
    const templateVersionId = `omnia.create-associate.runtime-template@${templateVersion}`;
    const templateInstanceId = crypto.randomUUID();
    const templateSemanticDigest = digest(Buffer.from(canonical({
      templateId: 'omnia.create-associate.runtime-template', version: templateVersion,
      schemaVersion: 'omnia.create-associate.runtime-template/v1', baseDigest: compiled.baseDigest,
      governanceDigest: governance.sourceSha256
    })));
    await store.call('recordTemplateMetadata', {
      status: 'candidate', runId, templateVersionId, templateInstanceId,
      templateId: 'omnia.create-associate.runtime-template', version: templateVersion,
      governanceArtifactId: governance.managedGovernanceRef, baseAssetPath: runtimeBase.memberPath,
      basePackageDigest: runtimeBase.packageDigest, sourceArtifactId: descriptor.artifactId,
      outputArtifactId: output.artifactId, outputFileDigest: output.sha256,
      baseFileDigest: compiled.baseDigest, semanticDigest: templateSemanticDigest,
      instanceSemanticDigest: compiled.semanticDigest, patchDigest: compiled.patchDigest,
      schemaVersion: 'omnia.create-associate.runtime-template/v1',
      owner: 'omnia-v5-feature-team', license: 'internal-authorized-use'
    });
    return { output, templateInstanceId };
  }

  async function validateParsedIr(parsed,runId){
    const parsedHandle=await store.call('createPythonJsonInputHandle',{runId,value:parsed,maxBytes:32*1024*1024});
    return invokePythonJson('validate_ir',{schemaVersion:'omnia.create-associate.python-operation/v1',parsedHandle},runId);
  }

  async function compilePlanIr(parsed,runId,liveValidation){
    const parsedHandle=await store.call('createPythonJsonInputHandle',{runId,value:parsed,maxBytes:32*1024*1024});
    const governanceHandle=await store.call('createPythonJsonInputHandle',{runId,value:governance,maxBytes:16*1024*1024});
    const liveValidationHandle=await store.call('createPythonJsonInputHandle',{runId,value:liveValidation||{},maxBytes:16*1024*1024});
    const planIr=await invokePythonJson('build_plan_ir',{schemaVersion:'omnia.create-associate.python-operation/v1',parsedHandle,governanceHandle,liveValidationHandle},runId);
    if(!planIr||planIr.schemaVersion!=='omnia.create-associate.capability-plan-ir/v1'||planIr.parsedDigest!==parsed.semanticDigest
      ||planIr.governanceDigest!==governance.semanticDigest||!Array.isArray(planIr.rows)||!planIr.semanticDigest){
      fail('PLAN.PYTHON_RESULT_INVALID','Managed Python plan compiler returned an invalid capability plan IR.');
    }
    return planIr;
  }

  async function invoke(operationId, connectorBinding, request) {
    return withRemoteOperationPermit(() => connector.invoke({ schemaVersion: 'omnia.operation-invocation/v1', featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION, operationId, request: { connectorBinding, ...request } }));
  }
  async function resolveExternalApplicationTarget(connectorBinding, workspaceIds, externalId) {
    const candidates = new Map(); const diagnostics = [];
    for (const workspaceId of [...new Set((workspaceIds || []).map((value) => String(value).toLowerCase()).filter(Boolean))]) {
      for (const rait of ['Higher', 'Lower']) {
        const request = applicationIdentityRequest(externalId, workspaceId, rait,
          identityKey('external-app-reference', [externalId, workspaceId, rait]));
        try {
          const observed = await invoke(RETURN_OPERATIONS.objectIdentityResolve, connectorBinding, request);
          const identity = inspectApplicationIdentity(observed, request);
          diagnostics.push({ workspaceId, rait, disposition: identity.disposition, reasonCode: identity.reasonCode });
          if (identity.accepted && identity.disposition === 'reuse' && identity.objectId && identity.riskAssessmentId) {
            candidates.set(`${identity.objectId}|${identity.riskAssessmentId}|${workspaceId}|${rait}`, {
              sourceType: 'external', externalId, rowKey: '', workspaceId, objectId: identity.objectId,
              riskAssessmentId: identity.riskAssessmentId, rait, evidence: observed?.evidence || null
            });
          }
        } catch (error) {
          diagnostics.push({ workspaceId, rait, disposition: 'error', reasonCode: String(error?.code || error?.message || error) });
        }
      }
    }
    const resolved = [...candidates.values()];
    return resolved.length === 1
      ? { accepted: true, target: resolved[0], diagnostics }
      : { accepted: false, reasonCode: resolved.length ? 'external_app_ambiguous' : 'external_app_not_found', diagnostics };
  }
  async function waitForCompleteRiskControlCatalog(connectorBinding, request, relations, mode) {
    const maxSettlingMs = 120_000; const maxReads = 40; const startedAt = Date.now();
    const jitterSeed = parseInt(digest(Buffer.from(canonical({ request, mode, relationIds: relations.map((item) => item.relationId) }))).slice(0, 8), 16);
    let catalog = { risks: [], controls: [], diagnostics: {} }; let missing = relations; let attempts = 0; let waitedMs = 0;
    let lastFingerprint='';let stableReads=0;
    while (attempts < maxReads) {
      if(attempts>0&&Date.now()-startedAt>=maxSettlingMs) break;
      attempts += 1;
      catalog = await invoke(RETURN_OPERATIONS.riskCatalog, connectorBinding, request);
      missing = unresolvedCatalogRelations(catalog, relations, mode);
      if (!missing.length) return catalog;
      const elapsedMs = Date.now() - startedAt;
      const fingerprint=riskControlCatalogFingerprint(catalog);
      stableReads=fingerprint===lastFingerprint?stableReads+1:1;
      lastFingerprint=fingerprint;
      const diagnostics=catalog?.diagnostics||{};
      const acceptedRisks=Number(diagnostics.acceptedRisks??catalog?.risks?.length??0);
      const acceptedControls=Number(diagnostics.acceptedControls??catalog?.controls?.length??0);
      if(acceptedRisks>0&&acceptedControls>0&&stableReads>=3&&elapsedMs>=5_000){
        fail('RETURN.RISK_CONTROL_GOVERNANCE_INCOMPATIBLE',`Generated Risk/Control catalog remained unchanged for ${stableReads} reads (${elapsedMs}ms elapsed) but does not match signed governance; risks=${acceptedRisks}, controls=${acceptedControls}, missing=${missing.map((item)=>item.relationId).join(', ')}, fingerprint=${fingerprint}.`);
      }
      const remainingMs = maxSettlingMs - elapsedMs;
      if (remainingMs <= 0 || attempts >= maxReads) break;
      const exponentialMs = Math.min(5_000, Math.round(750 * (1.55 ** (attempts - 1))));
      const jitterRatio = 0.85 + (((jitterSeed + attempts * 2654435761) >>> 0) % 301) / 1000;
      const delayMs = Math.min(remainingMs, Math.max(250, Math.round(exponentialMs * jitterRatio)));
      await boundedDelay(delayMs);
      waitedMs += delayMs;
    }
    const diagnostics = catalog?.diagnostics || {};
    const identitySamples=Array.isArray(diagnostics.controlIdentitySamples)
      ?diagnostics.controlIdentitySamples.slice(0,8).map((item)=>({
        controlNumber:String(item?.controlNumber||'').slice(0,160),name:String(item?.name||'').slice(0,160)
      })):[];
    fail('RETURN.RISK_CONTROL_CATALOG_SETTLING_TIMEOUT', `Generated Risk/Control catalog remained incomplete after ${attempts} bounded reads (${waitedMs}ms passive wait, ${Date.now()-startedAt}ms elapsed); risks=${Number(diagnostics.acceptedRisks??catalog?.risks?.length??0)}, controls=${Number(diagnostics.acceptedControls??catalog?.controls?.length??0)}, missing=${missing.map((item) => item.relationId).join(', ')}, controlIdentitySamples=${JSON.stringify(identitySamples)}.`);
  }
  async function waitForGeneratedRiskIdentities(connectorBinding,row,riskAssessmentId,intents){
    const maxSettlingMs=120_000;const maxReads=40;const startedAt=Date.now();let attempts=0;let waitedMs=0;let missing=intents;
    const jitterSeed=parseInt(digest(Buffer.from(canonical({riskAssessmentId,rowKey:row.rowKey,risks:intents.map((item)=>item.riskNumber)}))).slice(0,8),16);
    while(attempts<maxReads){
      if(attempts>0&&Date.now()-startedAt>=maxSettlingMs)break;
      attempts+=1;
      const results=await Promise.all(intents.map(async(intent)=>{
        const target={targetIdentityKey:intent.operationTargetIdentityKey,workspaceId:row.workspaceId};
        const observed=await invoke(RETURN_OPERATIONS.riskClassificationPreflight,connectorBinding,{target,query:{riskAssessmentId,riskName:intent.riskName,riskId:intent.resolvedRisk?.riskId||'',classification:intent.value}});
        return {intent,observed};
      }));
      missing=results.filter((item)=>item.observed?.found!==true).map((item)=>item.intent);
      if(!missing.length)return new Map(results.map((item)=>[item.intent.key,item.observed.risk]));
      const remainingMs=maxSettlingMs-(Date.now()-startedAt);if(remainingMs<=0||attempts>=maxReads)break;
      const exponentialMs=Math.min(5_000,Math.round(750*(1.55**(attempts-1))));
      const jitterRatio=0.85+(((jitterSeed+attempts*2654435761)>>>0)%301)/1000;
      const delayMs=Math.min(remainingMs,Math.max(250,Math.round(exponentialMs*jitterRatio)));
      await boundedDelay(delayMs);waitedMs+=delayMs;
    }
    fail('RETURN.RISK_IDENTITY_SETTLING_TIMEOUT',`Generated Risk identities remained incomplete after ${attempts} bounded reads (${waitedMs}ms passive wait, ${Date.now()-startedAt}ms elapsed); missing=${missing.map((item)=>item.riskNumber).join(', ')}.`);
  }
  async function waitForEvaluationComplete(connectorBinding, request) {
    let observed = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      observed = await invoke(RETURN_OPERATIONS.evaluationRead, connectorBinding, request);
      if (observed?.verified === true && observed.status === 'EvaluationComplete') return observed;
      const status = String(observed?.status || 'unknown');
      if (/failed|cancelled|canceled|deleted/iu.test(status)) fail('RETURN.EVALUATION_TERMINAL_FAILURE', `GRA evaluation entered terminal status ${status}.`);
      // The authoritative remote read already provides the pacing boundary.
      // Re-read immediately so a completed evaluation is observed without an
      // additional fixed client-side wait.
    }
    fail('RETURN.EVALUATION_SETTLING_TIMEOUT', `GRA evaluation did not reach EvaluationComplete after 120 bounded reads; last status=${String(observed?.status || 'unknown')}.`);
  }
  function authorityRequest(checkpoint, context) {
    const workspaceNames = [...new Set(activeRows(checkpoint.parsed).map((row) => rowWorkspaceName(row)))];
    const graContents = [...new Map(activeRows(checkpoint.parsed).map((row) => {
      const value=authorityContentNameFor(row,governance,checkpoint.parsed?.kindRegistry);
      return [`${row.kind}|${value}`, { elementKind: row.kind, objectType: objectType(row.kind),
        objectSubtype: authorityObjectSubtype(row.kind), contentName: value }];
    })).values()];
    if (workspaceNames.some((value) => !value) || graContents.some((value) => !value.contentName)) fail('RETURN.AUTHORITY_INPUT_MISSING', 'Workspace or GRA content input is missing.');
    return { connectorBinding: context.connectorBinding, allowedWorkspaceIds: context.safetyLock.workspaceIds, query: { workspaceNames, graContents } };
  }
  async function runFactorsConsideredAiReview(checkpoint) {
    const parsed=checkpoint.parsed;
    parsed.issues=(parsed.issues||[]).filter((candidate)=>candidate.origin!=='ai_review'&&!String(candidate.issueId||'').startsWith('ai-review-'));
    const apps=aiReviewEligibleRows(parsed);
    if(!apps.length){
      checkpoint.aiReview={state:'skipped',reasonCode:'AI.REVIEW_NOT_APPLICABLE',capturedAt:new Date().toISOString()};
      return{state:'skipped',reason:'本批无 APP，Factors Considered 智能复核不适用。'};
    }
    const aiIssue=(code,fieldKey,message)=>{const created=issue('ai_review',code,fieldKey,'ambiguous','waived',message,'factors_considered_ai_review');created.issueId=issueId('ai_review',`${parsed.issueNamespace||checkpoint.planId||'legacy'}|${code}`,fieldKey);return created;};
    const factorCandidate=(row)=>reviewCandidate(parsed,row,'Factors Considered');
    const missing=apps.filter((row)=>!String(row.fields['Factors Considered']||'').trim());
    if(missing.length){
      const reason=`${missing.length} 个 APP 缺少 Factors Considered；确定性必填校验已阻断，AI 不会替用户补写。`;
      for(const row of missing)parsed.issues.push(aiIssue('AI.REVIEW_INPUT_INCOMPLETE',factorCandidate(row)?.fieldKey||`${row.rowKey}.factors-considered-ai`,reason));
      checkpoint.aiReview={state:'not_evaluable',reasonCode:'AI.REVIEW_INPUT_INCOMPLETE',capturedAt:new Date().toISOString()};
      return{state:'warning',reason};
    }
    if(!ai?.review){
      const reason='AI 复核未执行：Shell 未提供受控 ai.review 端口；此项不视为通过。';
      parsed.issues.push(aiIssue('AI.REVIEW_PORT_UNAVAILABLE','global.ai_review',reason));
      checkpoint.aiReview={state:'not_evaluable',reasonCode:'AI.REVIEW_PORT_UNAVAILABLE',capturedAt:new Date().toISOString()};
      return{state:'warning',reason};
    }
    const items=apps.map((row)=>({rowKey:String(row.rowKey),rait:String(row.fields['System Risk Classification']||''),factorsConsidered:String(row.fields['Factors Considered']||'')}));
    const instructions=[
      'Review each APP Factors Considered value only as a non-authoritative quality suggestion.',
      'Use only the literal Factors Considered text and declared Higher/Lower RAIT. Do not infer from an application name, application type, external domain knowledge, industry experience, or stereotypes.',
      'Check two dimensions: whether the Factors text is internally coherent without contradictions, and whether its own words support the declared Higher/Lower conclusion.',
      'Higher/Lower characteristics are text-matching guidance only. Treat orders or financial information as key data only when the Factors text explicitly says so; employee personal information or company payroll alone must not be assumed to be key data.',
      'Do not invent business facts, change or rewrite the field, authorize a mutation, or decide whether Return may proceed. Every concern remains a non-authoritative warning.',
      'Write every user-visible summary, concern.message, and every non-empty concern.suggestion in Simplified Chinese (zh-CN). Internal schemaVersion, rowKey, assessment, and concern.code values must remain in the declared English contract. 用户可见的 summary、message 和非空 suggestion 必须使用简体中文，不得返回纯英文展示文本。',
      'Return exactly {"schemaVersion":"omnia.create-associate.factors-review/v1","items":[...]} with one item for every input rowKey and no extras.',
      'Each item must contain exactly rowKey, assessment, summary, concerns. assessment is clear, needs_attention, or not_evaluable. concerns is an array of at most 5 objects containing exactly code, message, suggestion.'
    ].join(' ');
    const exactKeys=(value,expected,label)=>{
      if(!value||typeof value!=='object'||Array.isArray(value))fail('AI.REVIEW_OUTPUT_INVALID',`${label} must be an object.`);
      const actual=Object.keys(value).sort(),wanted=[...expected].sort();
      if(actual.length!==wanted.length||actual.some((key,index)=>key!==wanted[index]))fail('AI.REVIEW_OUTPUT_INVALID',`${label} fields are invalid.`);
    };
    const inputDigest=digest(Buffer.from(canonical({capabilityId:'factors_considered_quality/v1',languageVersion:AI_REVIEW_LANGUAGE_VERSION,instructions,items})));
    const cached=checkpoint.aiReview;
    if(cached?.languageVersion===AI_REVIEW_LANGUAGE_VERSION&&cached?.inputDigest===inputDigest&&cached.reviewId&&['passed','warning'].includes(cached.state)&&Array.isArray(cached.items)
      &&cached.items.length===items.length&&new Set(cached.items.map((item)=>String(item.rowKey||''))).size===items.length
      &&cached.items.every((item)=>items.some((inputItem)=>inputItem.rowKey===String(item.rowKey||''))&&aiReviewItemUsesChineseDisplayText(item))){
      for(const reviewed of cached.items){
        const rowKey=String(reviewed.rowKey),row=apps.find((candidate)=>candidate.rowKey===rowKey),fieldKey=factorCandidate(row)?.fieldKey||`${rowKey}.factors-considered-ai`;
        for(const concern of Array.isArray(reviewed.concerns)?reviewed.concerns:[]){
          const code=String(concern?.code||'cached_review'),message=String(concern?.message||'AI review concern'),suggestion=String(concern?.suggestion||'');
          parsed.issues.push(aiIssue(`AI.SUGGESTION.${code.toLocaleUpperCase('en-US')}`,fieldKey,`${message}${suggestion?` 建议：${suggestion}`:''}`));
        }
        if(reviewed.assessment==='not_evaluable'&&(!Array.isArray(reviewed.concerns)||!reviewed.concerns.length))parsed.issues.push(aiIssue('AI.REVIEW_ITEM_NOT_EVALUABLE',fieldKey,String(reviewed.summary||'AI could not evaluate this item.')));
      }
      return{state:cached.state,reason:String(cached.reason||`复用真实 AI 复核 ${cached.reviewId}（输入未变化）。`),reviewId:cached.reviewId,usage:cached.usage,capturedAt:cached.capturedAt,reused:true};
    }
    try{
      const result=await ai.review({schemaVersion:'omnia.feature-ai-review-request/v1',capabilityId:'factors_considered_quality/v1',runId:String(checkpoint.runId||checkpoint.planId),instructions,input:{items}});
      exactKeys(result,['schemaVersion','reviewId','capabilityId','provider','model','capturedAt','usage','output'],'AI review result');
      if(result.schemaVersion!=='omnia.feature-ai-review-result/v1'||result.capabilityId!=='factors_considered_quality/v1'
        ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(String(result.reviewId||''))
        ||!String(result.provider||'')||String(result.provider).length>80||!String(result.model||'')||String(result.model).length>160
        ||!Number.isFinite(Date.parse(String(result.capturedAt||''))))fail('AI.REVIEW_RESULT_INVALID','AI review identity or provider metadata is invalid.');
      exactKeys(result.usage,['inputTokens','outputTokens','totalTokens','cachedTokens','reasoningTokens'],'AI review usage');
      for(const value of Object.values(result.usage))if(value!==null&&(!Number.isSafeInteger(value)||value<0))fail('AI.REVIEW_USAGE_INVALID','AI review usage values must be non-negative integers or null.');
      exactKeys(result.output,['schemaVersion','items'],'Factors review output');
      if(result.output.schemaVersion!=='omnia.create-associate.factors-review/v1'||!Array.isArray(result.output.items)||result.output.items.length!==items.length)fail('AI.REVIEW_COVERAGE_INVALID','AI review output row count differs from the exact APP input.');
      assertAiReviewOutputUsesChineseDisplayText(result.output);
      const inputKeys=new Set(items.map((item)=>item.rowKey)),seen=new Set();let attention=0,notEvaluable=0;
      for(const reviewed of result.output.items){
        exactKeys(reviewed,['rowKey','assessment','summary','concerns'],'Factors review item');
        const rowKey=String(reviewed.rowKey||''),assessment=String(reviewed.assessment||''),summary=String(reviewed.summary||'');
        if(!inputKeys.has(rowKey)||seen.has(rowKey)||!['clear','needs_attention','not_evaluable'].includes(assessment)||!summary||summary.length>1000
          ||!Array.isArray(reviewed.concerns)||reviewed.concerns.length>5)fail('AI.REVIEW_COVERAGE_INVALID','AI review output has invalid or duplicate row coverage.');
        seen.add(rowKey);
        if(assessment==='needs_attention'&&!reviewed.concerns.length)fail('AI.REVIEW_OUTPUT_INVALID','AI needs_attention result must include at least one concern.');
        const row=apps.find((candidate)=>candidate.rowKey===rowKey),fieldKey=factorCandidate(row)?.fieldKey||`${rowKey}.factors-considered-ai`;
        for(const concern of reviewed.concerns){
          exactKeys(concern,['code','message','suggestion'],'Factors review concern');
          const code=String(concern.code||''),message=String(concern.message||''),suggestion=String(concern.suggestion||'');
          if(!/^[a-z0-9][a-z0-9._-]{1,63}$/iu.test(code)||!message||message.length>1000||suggestion.length>1000)fail('AI.REVIEW_OUTPUT_INVALID','AI review concern fields are invalid.');
          parsed.issues.push(aiIssue(`AI.SUGGESTION.${code.toLocaleUpperCase('en-US')}`,fieldKey,`${message}${suggestion?` 建议：${suggestion}`:''}`));
        }
        if(assessment==='needs_attention')attention+=1;
        if(assessment==='not_evaluable')notEvaluable+=1;
        if(assessment==='not_evaluable'&&!reviewed.concerns.length)parsed.issues.push(aiIssue('AI.REVIEW_ITEM_NOT_EVALUABLE',fieldKey,summary));
      }
      if(seen.size!==inputKeys.size)fail('AI.REVIEW_COVERAGE_INVALID','AI review output omitted an APP row.');
      const usageText=`usage input=${result.usage.inputTokens??'unknown'}, output=${result.usage.outputTokens??'unknown'}, total=${result.usage.totalTokens??'unknown'}`;
      const reason=attention||notEvaluable
        ?`真实 AI 复核 ${result.reviewId} 已完成（${result.model}，${result.capturedAt}，${usageText}）；${attention} 个 APP 有质量建议，${notEvaluable} 个 APP 无法评估。建议不授权写入且不自动改字段。`
        :`真实 AI 复核 ${result.reviewId} 已完成（${result.model}，${result.capturedAt}，${usageText}）；全部 ${items.length} 个 APP 无质量关注。该结论不授权写入。`;
      checkpoint.aiReview={state:attention||notEvaluable?'warning':'passed',languageVersion:AI_REVIEW_LANGUAGE_VERSION,inputDigest,reviewId:result.reviewId,capabilityId:result.capabilityId,provider:result.provider,model:result.model,capturedAt:result.capturedAt,usage:result.usage,items:result.output.items,reason};
      return{state:attention||notEvaluable?'warning':'passed',reason,reviewId:result.reviewId,usage:result.usage,capturedAt:result.capturedAt};
    }catch(error){
      const code=String(error?.code||'AI.REVIEW_FAILED'),message=String(error?.message||error).slice(0,500),reason=`AI 复核未完成（${code}）；未生成合格的简体中文复核结果。此项不视为通过、不自动修改字段，可在当前 Run 重新校验。`;
      parsed.issues.push(aiIssue(code,'global.ai_review',reason));
      checkpoint.aiReview={state:'not_evaluable',languageVersion:AI_REVIEW_LANGUAGE_VERSION,inputDigest,reasonCode:code,message,capturedAt:new Date().toISOString()};
      return{state:'warning',reason};
    }
  }
  async function runReviewLiveValidation(checkpoint,context,onCheck=async()=>{}){
    checkpoint.parsed.issues=(checkpoint.parsed.issues||[]).filter((candidate)=>candidate.origin!=='live_validation'&&!String(candidate.issueId||'').startsWith('live-'));
    const aiReview=await runFactorsConsideredAiReview(checkpoint);
    await onCheck('factors_considered_ai_review',aiReview);
    let relationTargets=[];
    const withAiReview=(checks)=>({...checks,factors_considered_ai_review:aiReview,relationTargets});
    const reportLiveChecks=async(checks)=>{for(const checkId of ['workspace_live','omnia_id_conflicts','relationship_targets','infrastructure_rait'])await onCheck(checkId,checks[checkId]);};
    const liveIssue=(code,fieldKey,issueType,state,message,checkId)=>{const created=issue('live_validation',code,fieldKey,issueType,state,message,checkId);created.issueId=issueId('live_validation',`${checkpoint.parsed.issueNamespace||checkpoint.planId||'legacy'}|${code}`,fieldKey);return created;};
    const failedLiveChecks=(reason)=>({omnia_id_conflicts:{state:'failed',reason},relationship_targets:{state:'failed',reason},infrastructure_rait:{state:'failed',reason},workspace_live:{state:'failed',reason}});
    const binding=context?.connectorBinding,safety=context?.safetyLock;if(!binding?.connectorId||Number(binding.sessionGeneration)<1||!binding.engagementId){const reason='当前没有可用的 Remote Connector binding，无法执行 APP 身份/回收站、非 APP 活动对象、关系目标类型与工作区实时检查；连接后可在原 Run 重试。';checkpoint.parsed.issues.push(liveIssue('LIVE.WORKSPACE_UNAVAILABLE','global.workspace_live','contract_mismatch','blocking',reason,'workspace_live'));const checks=failedLiveChecks(reason);await reportLiveChecks(checks);return withAiReview(checks);}if(!Array.isArray(safety?.workspaceIds)||!safety.workspaceIds.length){const reason='当前 Pack Workspace 安全范围为空，无法执行 APP 身份/回收站、非 APP 活动对象、关系目标类型与工作区实时检查；请启用安全范围后在原 Run 重新校验。';checkpoint.parsed.issues.push(liveIssue('LIVE.SAFETY_SCOPE_UNAVAILABLE','global.workspace_live','contract_mismatch','blocking',reason,'workspace_live'));const checks=failedLiveChecks(reason);await reportLiveChecks(checks);return withAiReview(checks);}
    try{const query=authorityRequest(checkpoint,context).query;const authority=await invoke(RETURN_OPERATIONS.authority,binding,{allowedWorkspaceIds:safety.workspaceIds,query});const byName=new Map((authority.workspaces||[]).map((item)=>[String(item.name).normalize('NFKC'),item.workspaceId]));const missing=query.workspaceNames.filter((name)=>!byName.has(String(name).normalize('NFKC')));if(missing.length){const reason=`Omnia 工作区实时不存在或不在安全范围：${missing.join(', ')}；因此 APP 身份/回收站、非 APP 活动对象与关系目标类型检查未执行。`;checkpoint.parsed.issues.push(liveIssue('LIVE.WORKSPACE_NOT_FOUND','global.workspace_live','contract_mismatch','blocking',reason,'workspace_live'));const checks=failedLiveChecks(reason);await reportLiveChecks(checks);return withAiReview(checks);}
      const workspaceCheck={state:'passed',reason:`${query.workspaceNames.length} 个本次上传元素所属工作区已按当前 Pack 权威目录精确匹配。`};
      await onCheck('workspace_live',workspaceCheck);
      checkpoint.liveIdentityResolutions={};
      let ownedRecoveries=0,creatable=0,nameConflicts=0,identityBlocks=0;
      for(const row of activeRows(checkpoint.parsed)){
        const workspaceId=byName.get(rowWorkspaceName(row));
        if(row.kind==='APP'){
          const request=applicationIdentityRequest(row.elementId,workspaceId,rowField(row,governance,'P1.APP.GRA.RAIT_CONCLUSION'));
          try{
            const observed=await invoke(RETURN_OPERATIONS.objectIdentityResolve,binding,request);
            const identity=inspectApplicationIdentity(observed,request);
            checkpoint.liveIdentityResolutions[row.rowKey]={operationId:RETURN_OPERATIONS.objectIdentityResolve,target:request.target,query:request.query,disposition:identity.disposition,reasonCode:identity.reasonCode,resolved:{objectId:identity.objectId,riskAssessmentId:identity.riskAssessmentId},evidence:observed?.evidence||null};
            if(!identity.accepted){identityBlocks+=1;checkpoint.parsed.issues.push(liveIssue('LIVE.APP_IDENTITY_BLOCKED',`${row.rowKey}.identity`,'conflict','blocking',`APP ${row.elementId} 身份解析被拒绝：${identity.reasonCode}。`,'omnia_id_conflicts'));}
            else if(identity.disposition==='create')creatable+=1;
            else{
              const proof=await store.call('proveOwnedCreatedObject',{objectId:identity.objectId,workspaceId,externalId:row.elementId,expectedObjectType:'Application',connectorBinding:binding});
              checkpoint.liveIdentityResolutions[row.rowKey].ownership=proof?.proven===true
                ?{proven:true,runId:proof.runId,commandId:proof.commandId,objectId:proof.objectId}
                :{proven:false};
              if(proof?.proven===true)ownedRecoveries+=1;
              else{nameConflicts+=1;identityBlocks+=1;checkpoint.parsed.issues.push(liveIssue('LIVE.APP_IDENTITY_CONFLICT',`${row.rowKey}.identity`,'conflict','blocking',`APP ${row.elementId} 与当前 Pack 中的活动同名对象冲突；该对象没有与当前 Connector、Authority、Pack、Engagement 和 Workspace 严格匹配的 Agent-managed 创建证据。`,'omnia_id_conflicts'));}
            }
          }catch(error){identityBlocks+=1;checkpoint.parsed.issues.push(liveIssue('LIVE.APP_IDENTITY_FAILED',`${row.rowKey}.identity`,'contract_mismatch','blocking',`APP ${row.elementId} 身份解析失败：${String(error.message||error)}`,'omnia_id_conflicts'));}
          continue;
        }
        const request={target:{targetIdentityKey:identityKey('review-object',[row.kind,row.elementId,workspaceId]),workspaceId},query:{objectType:objectType(row.kind),subtypeId:objectSubtypeId(row.kind),externalId:row.elementId,workspaceId,graName:deriveGraName(row.elementId)}};
        const observed=await invoke(RETURN_OPERATIONS.objectPreflight,binding,request);const identity=inspectGenericIdentity(observed,request);
        const genericDisposition=identity.state==='active'?'resume':identity.state==='none'?'create':'blocked';
        checkpoint.liveIdentityResolutions[row.rowKey]={operationId:RETURN_OPERATIONS.objectPreflight,target:request.target,query:request.query,matchState:identity.state,disposition:genericDisposition,reasonCode:identity.reasonCode,resolved:{objectId:identity.objectId},evidence:identity.evidence};
        if(!identity.accepted){identityBlocks+=1;checkpoint.parsed.issues.push(liveIssue('LIVE.NON_APP_IDENTITY_BLOCKED',`${row.rowKey}.identity`,'conflict','blocking',`${row.kind} ${row.elementId} 身份解析被拒绝：${identity.reasonCode}。`,'omnia_id_conflicts'));}
        else if(identity.state==='active'){
          const proof=await store.call('proveOwnedCreatedObject',{objectId:identity.objectId,workspaceId,externalId:row.elementId,expectedObjectType:objectType(row.kind),connectorBinding:binding});
          checkpoint.liveIdentityResolutions[row.rowKey].ownership=proof?.proven===true
            ?{proven:true,runId:proof.runId,commandId:proof.commandId,objectId:proof.objectId,objectType:proof.objectType}
            :{proven:false};
          if(proof?.proven===true)ownedRecoveries+=1;
          else{nameConflicts+=1;identityBlocks+=1;checkpoint.parsed.issues.push(liveIssue('LIVE.NON_APP_IDENTITY_CONFLICT',`${row.rowKey}.identity`,'conflict','blocking',`${row.kind} ${row.elementId} 与当前 Pack 中的活动同名对象冲突；该对象没有与当前 Connector、Authority、Pack、Engagement、Workspace、对象类型和外部标识严格匹配的 Agent-managed 创建证据。`,'omnia_id_conflicts'));}
        }
        else if(identity.state==='none')creatable+=1;
      }
      const active=activeRows(checkpoint.parsed),appRowsByIdentity=new Map();
      for(const app of active.filter((candidate)=>candidate.kind==='APP')){const key=String(app.elementId).normalize('NFKC').toLocaleLowerCase('en-US'),matches=appRowsByIdentity.get(key);if(matches)matches.push(app);else appRowsByIdentity.set(key,[app]);}
      const externalCache=new Map();let liveTargetFailures=0,crossWorkspaceWarnings=0,externalWarnings=0,mixedRaitWarnings=0;
      for(const row of active.filter((candidate)=>kindCapability(candidate.kind).capabilities?.relation===true)){
        const sourceWorkspaceId=byName.get(rowWorkspaceName(row));const rowTargets=[];
        for(const appExternalId of row.relations){
          const normalizedExternalId=String(appExternalId).normalize('NFKC').toLocaleLowerCase('en-US');
          const matches=appRowsByIdentity.get(normalizedExternalId)||[];
          let resolved=null;
          if(matches.length===1){
            const app=matches[0],resolution=checkpoint.liveIdentityResolutions[app.rowKey];
            const disposition=String(resolution?.disposition||'');
            const targetReady=disposition==='create'||(['resume','reuse'].includes(disposition)&&resolution?.ownership?.proven===true);
            if(targetReady){
              resolved={sourceRowKey:row.rowKey,sourceType:'in_batch',externalId:String(app.elementId),targetRowKey:String(app.rowKey),workspaceId:byName.get(rowWorkspaceName(app)),objectId:String(resolution?.resolved?.objectId||''),riskAssessmentId:String(resolution?.resolved?.riskAssessmentId||''),rait:normalizeRait(rowField(app,governance,'P1.APP.GRA.RAIT_CONCLUSION')),disposition};
            }
          }else if(matches.length===0){
            let external=externalCache.get(normalizedExternalId);
            if(!external){external=await resolveExternalApplicationTarget(binding,safety.workspaceIds,appExternalId);externalCache.set(normalizedExternalId,external);}
            if(external.accepted)resolved={sourceRowKey:row.rowKey,...external.target};
          }
          if(!resolved||!['Higher','Lower'].includes(resolved.rait)||!resolved.workspaceId){
            liveTargetFailures+=1;
            checkpoint.parsed.issues.push(liveIssue('LIVE.RELATIONSHIP_APP_IDENTITY_FAILED',`${row.rowKey}.relationship-target-live.${normalizedExternalId}`,'contract_mismatch','blocking',`${row.kind} ${row.elementId} 的关联 APP ${appExternalId} 在当前 Pack 中不存在、身份不唯一、不是活动 Application，或 RAIT 无法精确解析。`,'relationship_targets'));
            if(infrastructureKinds().has(row.kind))checkpoint.parsed.issues.push(liveIssue('LIVE.INFRASTRUCTURE_RAIT_SOURCE_FAILED',`${row.rowKey}.inheritance-live.${normalizedExternalId}`,'contract_mismatch','blocking',`${row.kind} ${row.elementId} 的 RAIT 来源 APP ${appExternalId} 未通过当前 Pack 的精确身份与 RAIT 校验。`,'infrastructure_rait'));
            continue;
          }
          relationTargets.push(resolved);rowTargets.push(resolved);
          if(resolved.sourceType==='external'){
            externalWarnings+=1;
            checkpoint.parsed.issues.push(liveIssue('LIVE.EXTERNAL_APP_REFERENCE',`${row.rowKey}.relationship-target-live.${normalizedExternalId}`,'contract_mismatch','waived',`${row.kind} ${row.elementId} 关联了本次上传批次之外、但已在当前 Pack 精确验证的 APP ${appExternalId}。`,'relationship_targets'));
          }
          if(String(resolved.workspaceId)!==String(sourceWorkspaceId)){
            crossWorkspaceWarnings+=1;
            checkpoint.parsed.issues.push(liveIssue('LIVE.CROSS_WORKSPACE_APP_REFERENCE',`${row.rowKey}.relationship-target-live.${normalizedExternalId}`,'contract_mismatch','waived',`${row.kind} ${row.elementId} 与关联 APP ${appExternalId} 不在同一工作区；关系仍可执行，请确认这是预期安排。`,'relationship_targets'));
          }
        }
        if(infrastructureKinds().has(row.kind)&&rowTargets.length===row.relations.length){
          const modes=[...new Set(rowTargets.map((target)=>target.rait))];
          const inheritedMode=modes.includes('Higher')?'Higher':modes.length===1&&modes[0]==='Lower'?'Lower':'';
          if(inheritedMode){
            const sourceApps=rowTargets.map((target)=>({sourceType:target.sourceType,rowKey:target.targetRowKey||'',elementId:target.externalId,workspaceId:target.workspaceId,objectId:target.objectId||'',riskAssessmentId:target.riskAssessmentId||'',rait:target.rait}));
            row.inheritance={schemaVersion:'omnia.create-associate.infrastructure-app-inheritance/v1',rait:inheritedMode,sourceApps,relationType:kindCapability(row.kind).relationPolicy.relationType};
            row.inheritanceDecision={schemaVersion:'omnia.create-associate.infrastructure-rait-decision/v1',policy:'any_higher_else_all_lower',sourceModes:sourceApps.map((source)=>({rowKey:source.rowKey,elementId:source.elementId,rait:source.rait})),mixedSources:modes.length>1,result:inheritedMode,message:modes.length>1?'关联 APP 的 RAIT 不一致，已按 Higher 优先自动设为 Higher。':`已从精确关联 APP 继承 ${inheritedMode}。`};
            row.fields['Inherited System Risk Classification']=inheritedMode;delete row.pendingExternalInheritance;
            const inheritedCandidate=(checkpoint.parsed.candidates||[]).find((candidate)=>candidate.provenance?.rowKey===row.rowKey&&candidate.canonicalFieldId===`P1.${row.kind}.GRA.RAIT_CONCLUSION`);
            if(inheritedCandidate)applyLiveVerifiedInfrastructureInheritance(inheritedCandidate,sourceApps,inheritedMode);
          }
          if(modes.length>1){
            mixedRaitWarnings+=1;
            checkpoint.parsed.issues.push(liveIssue('LIVE.RAIT_MIXED_HIGHER_WARNING',`${row.rowKey}.inheritance-live`,'contract_mismatch','waived',`${row.kind} ${row.elementId} 关联的 APP 同时包含 Higher 与 Lower；已按 Higher 优先自动设为 Higher。`,'infrastructure_rait'));
          }
        }
      }
      const targetFailed=checkpoint.parsed.issues.some((candidate)=>candidate.state==='blocking'&&candidate.checkId==='relationship_targets');
      const raitFailed=checkpoint.parsed.issues.some((candidate)=>candidate.state==='blocking'&&candidate.checkId==='infrastructure_rait');
      const conflictsFailed=identityBlocks>0;
      const conflictReason=`所有声明的 APP/Infrastructure/Tool 活动、回收站与歧义身份解析已执行；发现 ${ownedRecoveries} 个具有严格 Agent-managed 归属证明的恢复对象、${creatable} 个可进入创建预检的新对象${nameConflicts?`，${nameConflicts} 个未授权活动同名冲突`:''}${identityBlocks-nameConflicts>0?`，${identityBlocks-nameConflicts} 个身份被拒绝或解析失败`:''}。`;
      const relationshipWarning=crossWorkspaceWarnings+externalWarnings>0;
      const relationshipReason=targetFailed?`存在 ${liveTargetFailures} 个未通过当前 Pack 精确身份校验的 APP 关系目标。`:`全部关系目标均已解析为当前 Pack 中唯一且活动的 APP；其中 ${externalWarnings} 个来自本次上传批次之外，${crossWorkspaceWarnings} 个跨工作区，仅作提醒。`;
      const inheritanceReason=raitFailed?'存在缺失/无效继承 RAIT，或 APP 来源未通过当前 Pack 的精确身份与 RAIT 校验。':mixedRaitWarnings?`${mixedRaitWarnings} 个元素关联的 APP 同时包含 Higher 与 Lower，已按 Higher 优先自动设为 Higher。`:'所有继承 RAIT 均来自当前 Pack 中精确验证的 APP。';
      const checks={omnia_id_conflicts:{state:conflictsFailed?'failed':'passed',reason:conflictReason},relationship_targets:{state:targetFailed?'failed':relationshipWarning?'warning':'passed',reason:relationshipReason},infrastructure_rait:{state:raitFailed?'failed':mixedRaitWarnings?'warning':'passed',reason:inheritanceReason},workspace_live:workspaceCheck};
      for(const checkId of ['omnia_id_conflicts','relationship_targets','infrastructure_rait'])await onCheck(checkId,checks[checkId]);
      return withAiReview(checks);
    }catch(error){const reason=`实时校验失败（APP 身份/回收站、非 APP 活动对象、关系目标类型或工作区检查未闭合；可在原 Run 重试）：${String(error.message||error)}`;checkpoint.parsed.issues.push(liveIssue('LIVE.VALIDATION_FAILED','global.workspace_live','contract_mismatch','blocking',reason,'workspace_live'));const checks=failedLiveChecks(reason);await reportLiveChecks(checks);return withAiReview(checks);}
  }
  async function buildReturnPreparation(checkpoint, context) {
    if(reviewBlocked(checkpoint.parsed,checkpoint.liveValidation||{})) fail('RETURN.REVIEW_BLOCKED','Canonical Review contains a failed or pending check; prepare-return is forbidden.');
    const planIr=checkpoint.planIr;
    const planIrDigest=planIr&&digest(Buffer.from(canonical(Object.fromEntries(Object.entries(planIr).filter(([key])=>key!=='semanticDigest')))));
    if(!planIr||planIr.schemaVersion!=='omnia.create-associate.capability-plan-ir/v1'||planIr.parsedDigest!==checkpoint.parsed.semanticDigest
      ||!compatibleFrozenGovernanceDigests.has(planIr.governanceDigest)||planIr.semanticDigest!==planIrDigest||!Array.isArray(planIr.rows)){
      fail('RETURN.CAPABILITY_PLAN_IR_DRIFT','Frozen Python capability plan IR is missing or differs from the reviewed workbook.');
    }
    const active=activeRows(checkpoint.parsed),planRowsByKey=new Map(planIr.rows.map((item)=>[item.rowKey,item]));
    if(active.length!==planRowsByKey.size||active.some((row)=>!planRowsByKey.has(row.rowKey)))fail('RETURN.CAPABILITY_PLAN_ROW_DRIFT','Frozen Python capability plan row inventory differs from Review.');
    const observedAuthority = await invoke(RETURN_OPERATIONS.authority, context.connectorBinding, {
      allowedWorkspaceIds: context.safetyLock.workspaceIds, query: authorityRequest(checkpoint, context).query
    });
    if (String(observedAuthority.engagementId || '') !== String(context.connectorBinding.engagementId || '')) {
      fail('RETURN.AUTHORITY_ENGAGEMENT_DRIFT', 'Signed authority resolution returned another engagement identity.');
    }
    const authority = { ...observedAuthority,
      authorityInstanceId: String(context.connectorBinding.authorityInstanceId || ''),
      tenantOrOrgId: String(context.connectorBinding.tenantOrOrgId || ''),
      packId: String(context.connectorBinding.packId || ''),
      engagementId: String(context.connectorBinding.engagementId || '')
    };
    if (!authority.authorityInstanceId || !authority.packId || !authority.engagementId) {
      fail('RETURN.AUTHORITY_SCOPE_MISSING', 'Exact authority instance, Pack, and engagement identities are required.');
    }
    const workspaces = new Map(authority.workspaces.map((item) => [String(item.name).normalize('NFKC'), item.workspaceId]));
    const graContents = new Map(authority.graContents.map((item) => [`${item.elementKind}|${String(item.contentName).normalize('NFKC')}`, item]));
    const plannedApps = planIr.rows.filter((item)=>item.kind==='APP').map((item) => ({
      rowKey:item.rowKey,elementId:item.object.externalId,workspaceName:item.object.workspaceName,mode:item.rait?.value
    }));
    const rowsPrepared = []; const targets = []; const preflights = [];
    for (const row of active) {
      const planRow=planRowsByKey.get(row.rowKey);
      if(planRow.kind!==row.kind||planRow.object?.externalId!==row.elementId||planRow.status!=='ready_for_remote_preflight')fail('RETURN.CAPABILITY_PLAN_ROW_INVALID',`Frozen capability plan row is not executable: ${row.kind}/${row.elementId}.`);
      const returnIntents=frozenReturnIntents(planRow);
      if(returnIntents.blockedUnresolvedRait===true)fail('RETURN.DETERMINISTIC_INTENTS_BLOCKED',`Frozen Python Return intents have unresolved RAIT: ${row.kind}/${row.elementId}.`);
      if(canonical(returnIntents.relationTargets)!==canonical(row.relations||[]))fail('RETURN.DETERMINISTIC_INTENTS_DRIFT',`Frozen Python relation targets differ from Review: ${row.kind}/${row.elementId}.`);
      const stageNodes=frozenStageNodes(planRow);
      if(!Array.isArray(planRow.dependencyRowKeys)||new Set(planRow.dependencyRowKeys).size!==planRow.dependencyRowKeys.length)fail('RETURN.CAPABILITY_PLAN_DEPENDENCY_INVALID',`Frozen capability dependencies are invalid: ${row.kind}/${row.elementId}.`);
      const dependencySourceRows=planRow.dependencyRowKeys.map((rowKey)=>active.find((candidate)=>candidate.rowKey===rowKey));
      if(dependencySourceRows.some((candidate)=>!candidate))fail('RETURN.CAPABILITY_PLAN_DEPENDENCY_INVALID',`Frozen capability dependency is missing: ${row.kind}/${row.elementId}.`);
      const type = objectType(row.kind); const workspaceName = String(planRow.object.workspaceName||'');
      const workspaceId = workspaces.get(workspaceName.normalize('NFKC'));
      const contentName = String(planRow.object.contentName||'');
      const authorityContentName=authorityContentNameFor(row,governance,checkpoint.parsed?.kindRegistry);
      if(workspaceName!==rowField(row,governance,`P1.${row.kind}.IT.WORKSPACE`)||contentName!==rowField(row,governance,`P1.${row.kind}.GRA.GRA_CONTENT`))fail('RETURN.DETERMINISTIC_INTENTS_DRIFT',`Frozen Python object scope differs from Review: ${row.kind}/${row.elementId}.`);
      const content = graContents.get(`${row.kind}|${authorityContentName.normalize('NFKC')}`);
      if (!workspaceId || !content) fail('RETURN.AUTHORITY_UNRESOLVED', `Authority identity is unavailable for ${row.kind}/${row.elementId}.`);
      const objectTarget = { targetIdentityKey: identityKey('object', [row.kind, row.elementId, workspaceId]), workspaceId };
      const declaredMode = planRow.rait?.strategy === 'direct' ? normalizeRait(planRow.rait?.value) : '';
      const subtypeId=objectSubtypeId(row.kind);
      const appIdentityRequest=row.kind==='APP'?applicationIdentityRequest(row.elementId,workspaceId,declaredMode,objectTarget.targetIdentityKey):null;
      const objectQuery = appIdentityRequest?.query||{ objectType: type, subtypeId, externalId: row.elementId, workspaceId,graName:deriveGraName(row.elementId) };
      const objectObserved = await invoke(row.kind==='APP'?RETURN_OPERATIONS.objectIdentityResolve:RETURN_OPERATIONS.objectPreflight,
        context.connectorBinding,appIdentityRequest||{ target: objectTarget, query: objectQuery });
      const appIdentity=row.kind==='APP'?inspectApplicationIdentity(objectObserved,appIdentityRequest):null;
      const genericIdentity=row.kind==='APP'?null:inspectGenericIdentity(objectObserved,{target:objectTarget,query:objectQuery});
      if(appIdentity&&!appIdentity.accepted) fail('RETURN.APP_IDENTITY_BLOCKED',`APP ${row.elementId} identity resolution blocked Return preparation: ${appIdentity.reasonCode}.`);
      if(genericIdentity&&!genericIdentity.accepted) fail('RETURN.GENERIC_IDENTITY_BLOCKED',`${row.kind} ${row.elementId} identity resolution blocked Return preparation: ${genericIdentity.reasonCode}.`);
      let ownedCreateProof=null;
      if(appIdentity&&appIdentity.disposition!=='create'){
        const proof=await store.call('proveOwnedCreatedObject',{objectId:appIdentity.objectId,workspaceId,externalId:row.elementId,expectedObjectType:'Application',connectorBinding:context.connectorBinding});
        if(proof?.proven!==true)fail('RETURN.APP_IDENTITY_CONFLICT',`APP ${row.elementId} matches an active same-name object without exact Agent-managed ownership proof; Return preparation is forbidden.`);
        ownedCreateProof={proven:true,runId:proof.runId,commandId:proof.commandId,objectId:proof.objectId,objectType:proof.objectType};
      }
      if(genericIdentity?.state==='active'){
        const proof=await store.call('proveOwnedCreatedObject',{objectId:genericIdentity.objectId,workspaceId,externalId:row.elementId,expectedObjectType:type,connectorBinding:context.connectorBinding});
        if(proof?.proven!==true)fail('RETURN.GENERIC_IDENTITY_CONFLICT',`${row.kind} ${row.elementId} matches an active same-name object without exact Agent-managed ownership proof; Return preparation is forbidden.`);
        ownedCreateProof={proven:true,runId:proof.runId,commandId:proof.commandId,objectId:proof.objectId,objectType:proof.objectType};
      }
      if(objectObserved.found&&row.kind!=='APP'&&String(objectObserved.item?.typeId||objectObserved.item?.itElementTypeId||'')!==subtypeId){
        fail('RETURN.SUBTYPE_AUTHORITY_DRIFT',`${row.kind} ${row.elementId} live subtype does not match the exact signed content subtype identity.`);
      }
      const objectId = appIdentity?appIdentity.objectId:(genericIdentity?.objectId||'');
      if(objectId&&row.kind==='APP'){
        const desiredDescription=String(row.fields['Derived Application Description']||'');
        const currentDescription=descriptionPlainText(objectObserved.item?.description);
        if(currentDescription!==desiredDescription) fail('RETURN.EXISTING_DESCRIPTION_UNSUPPORTED',`APP ${row.elementId} existing description current=${JSON.stringify(currentDescription)} desired=${JSON.stringify(desiredDescription)}; no signed description patch Operation is released.`);
      }
      let graObserved = { found: false, item: null };
      if(appIdentity?.disposition==='reuse') graObserved={found:true,item:{id:appIdentity.riskAssessmentId}};
      else if (objectId&&row.kind!=='APP') graObserved = await invoke(RETURN_OPERATIONS.graPreflight, context.connectorBinding, {
        target: { targetIdentityKey: identityKey('gra', graBusinessIdentity(row.kind, row.elementId, workspaceId)), workspaceId },
        query: { entityId: objectId, itElementType: type, name: deriveGraName(row.elementId), workspaceId }
      });
      if(graObserved.found) await invoke(RETURN_OPERATIONS.graRead,context.connectorBinding,{target:{targetIdentityKey:identityKey('gra',graBusinessIdentity(row.kind,row.elementId,workspaceId)),workspaceId},riskAssessmentId:responseId(graObserved.item,'GRA preflight'),query:{entityId:objectId,name:deriveGraName(row.elementId),itElementType:type,inkContentId:content.inkContentId,typeId:content.typeId}});
      const resolvedRelationTargets=Array.isArray(planRow.relationPolicy?.resolvedTargets)?planRow.relationPolicy.resolvedTargets:[];
      if(hasFrozenStage({stageNodes},'relation')&&resolvedRelationTargets.length!==row.relations.length)fail('RETURN.RELATION_TARGET_UNVERIFIED',`${row.kind} ${row.elementId} does not have one frozen live target for every relation.`);
      let mode = declaredMode; let inheritanceSources = [];
      if (planRow.rait?.strategy === 'any_higher_else_all_lower') {
        const sources=Array.isArray(planRow.rait.sources)?planRow.rait.sources:[];
        if(!['Higher','Lower'].includes(planRow.rait.value)||sources.length!==row.relations.length||sources.length!==resolvedRelationTargets.length)fail('RETURN.INHERITANCE_IR_MISSING',`${row.kind} ${row.elementId} has no exact governed APP inheritance result; revalidate the source workbook before Return.`);
        inheritanceSources=sources.map((source)=>{
          const sourceType=String(source.sourceType||''),externalId=String(source.elementId||''),plannedMode=normalizeRait(source.plannedMode);
          if(!['Higher','Lower'].includes(plannedMode)||!['in_batch','external'].includes(sourceType))fail('RETURN.INHERITANCE_SOURCE_DRIFT',`${row.kind} ${row.elementId} has an invalid governed APP inheritance source.`);
          if(sourceType==='in_batch'){
            const matches=plannedApps.filter((item)=>item.rowKey===source.rowKey&&item.elementId.normalize('NFKC')===externalId.normalize('NFKC'));
            if(matches.length!==1||matches[0].mode!==plannedMode)fail('RETURN.INHERITANCE_SOURCE_DRIFT',`${row.kind} ${row.elementId} has a missing or drifted in-batch APP inheritance source.`);
            const targetWorkspaceId=workspaces.get(matches[0].workspaceName.normalize('NFKC'));
            if(!targetWorkspaceId||targetWorkspaceId!==source.workspaceId)fail('RETURN.INHERITANCE_SOURCE_DRIFT',`${row.kind} ${row.elementId} in-batch APP inheritance workspace drifted.`);
            return{sourceType,externalId,rowKey:matches[0].rowKey,workspaceName:matches[0].workspaceName,workspaceId:targetWorkspaceId,plannedMode,sourceKey:`inheritance-source|${row.rowKey}|${matches[0].rowKey}`};
          }
          if(!normalizedGuid(source.workspaceId)||!normalizedGuid(source.objectId)||!normalizedGuid(source.riskAssessmentId))fail('RETURN.INHERITANCE_SOURCE_DRIFT',`${row.kind} ${row.elementId} external APP inheritance identity is incomplete.`);
          return{sourceType,externalId,rowKey:'',workspaceName:'',workspaceId:String(source.workspaceId),objectId:String(source.objectId),riskAssessmentId:String(source.riskAssessmentId),plannedMode,sourceKey:`inheritance-source|${row.rowKey}|external:${source.workspaceId}:${externalId}`};
        });
        const relationIds=new Set(row.relations.map((relation)=>String(relation).normalize('NFKC').toLocaleLowerCase('en-US'))),sourceIds=new Set(inheritanceSources.map((source)=>String(source.externalId).normalize('NFKC').toLocaleLowerCase('en-US')));
        if(relationIds.size!==row.relations.length||relationIds.size!==sourceIds.size||[...relationIds].some((id)=>!sourceIds.has(id)))fail('RETURN.INHERITANCE_RELATION_DRIFT',`${row.kind} ${row.elementId} relation targets differ from its governed inheritance IR.`);
        const expectedMode=inheritanceSources.some((source)=>source.plannedMode==='Higher')?'Higher':inheritanceSources.every((source)=>source.plannedMode==='Lower')?'Lower':'';
        if(expectedMode!==planRow.rait.value)fail('RETURN.INHERITANCE_RAIT_DRIFT',`${row.kind} ${row.elementId} governed inherited RAIT no longer matches its frozen APP sources.`);
        mode=planRow.rait.value;
      }
      if (mode && !['Higher', 'Lower'].includes(mode)) fail('RETURN.RAIT_INVALID', `${row.kind} ${row.elementId} has an unsupported RAIT value.`);
      const identityDisposition=appIdentity?.disposition||(genericIdentity?.state==='active'?'resume':'create');
      const identityResolution=appIdentity
        ?{operationId:RETURN_OPERATIONS.objectIdentityResolve,disposition:identityDisposition,reasonCode:appIdentity.reasonCode,resolved:{objectId:appIdentity.objectId,riskAssessmentId:appIdentity.riskAssessmentId},ownership:ownedCreateProof,evidence:objectObserved?.evidence||null}
        :{operationId:RETURN_OPERATIONS.objectPreflight,disposition:identityDisposition,reasonCode:genericIdentity?.reasonCode||'identity_resolution_missing',matchState:genericIdentity?.state||'',resolved:{objectId:genericIdentity?.objectId||''},ownership:ownedCreateProof,evidence:genericIdentity?.evidence||null};
      const prepared = { rowKey: row.rowKey, kind: row.kind, elementId: row.elementId, objectType: type,
        workspaceName, workspaceId, content, subtypeId, mode, declaredMode, inheritanceSources, objectTarget, objectQuery, objectObserved, objectId,graName:deriveGraName(row.elementId),
        identityDisposition,identityResolution,
        graObserved, graId: graObserved.found ? responseId(graObserved.item, 'GRA preflight') : '', relations:[...returnIntents.relationTargets], relationPolicy:planRow.relationPolicy,
        resolvedRelationTargets,dependencyRowKeys:[...planRow.dependencyRowKeys],stageNodes:[...stageNodes],capabilities:freezePlanCapabilities(planRow),returnIntents };
      prepared.description=String(returnIntents.description||'');
      if(prepared.description!==row.elementId) fail('RETURN.DESCRIPTION_DERIVATION_DRIFT',`${row.kind} ${row.elementId} description differs from the signed derived field revision.`);
      if(hasFrozenStage(prepared,'settings')){
        prepared.isRelevant=returnIntents.settings?.isRelevant;
        if(prepared.isRelevant!==true) fail('RETURN.IS_RELEVANT_RULE_DRIFT',`APP ${row.elementId} isRelevant differs from the signed constant-true rule revision.`);
        prepared.isDataAvailable=returnIntents.settings?.isDataAvailable;
        if(prepared.isDataAvailable!==false) fail('RETURN.DATA_AVAILABILITY_RULE_DRIFT',`APP ${row.elementId} isDataAvailable differs from the signed v4-compatible constant-false rule revision.`);
        if(!objectId)prepared.dataAvailability=freezeAppDataAvailability('create',undefined,prepared.isDataAvailable);
        if(!String(content.itElementTypeId||'')) fail('RETURN.APP_TYPE_AUTHORITY_MISSING',`APP ${row.elementId} has no live authority-resolved IT Element type identity.`);
      }
      rowsPrepared.push(prepared);
      targets.push({ kind: 'object', key: `object|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: type, externalId: row.elementId,
        disposition:prepared.identityDisposition,resolvedObjectId:objectId,mutationOperationId:RETURN_OPERATIONS.objectCreate,
        identityResolution:prepared.identityResolution,description:row.kind==='APP'?prepared.description:undefined,operationTargetIdentityKey:objectTarget.targetIdentityKey,
        evidenceOperationIds:row.kind==='APP'?[RETURN_OPERATIONS.objectRead,RETURN_OPERATIONS.objectIdentityResolve,RETURN_OPERATIONS.objectCreatePreflight]:[RETURN_OPERATIONS.objectRead,RETURN_OPERATIONS.objectPreflight,RETURN_OPERATIONS.objectCreatePreflight] });
      targets.push({ kind: 'object', key: `gra|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', externalId: prepared.graName,
        disposition:graObserved.found?'reuse':'create',resolvedObjectId:graObserved.found?responseId(graObserved.item,'GRA preflight'):'',entityObjectTargetKey:`object|${row.rowKey}`,
        contentName,contentIdentity:{inkContentId:content.inkContentId,typeId:content.typeId},mutationOperationId:RETURN_OPERATIONS.graCreate,
        operationTargetIdentityKey:graOperationIdentity('gra',prepared),evidenceOperationIds:[RETURN_OPERATIONS.graRead,RETURN_OPERATIONS.graPreflight] });
      if(hasFrozenStage(prepared,'settings')) targets.push({kind:'field',key:`object-settings|${row.rowKey}`,rowKey:row.rowKey,workspace:workspaceId,objectType:type,externalId:row.elementId,objectTargetKey:`object|${row.rowKey}`,mode:objectId?'existing_with_token':'create_bootstrap',typeId:content.itElementTypeId,isRelevant:prepared.isRelevant,isDataAvailable:prepared.dataAvailability?.value,dataAvailabilityDisposition:prepared.dataAvailability?.disposition,
        mutationOperationId:RETURN_OPERATIONS.objectSettingsWrite,operationTargetIdentityKey:identityKey('object-settings',[...objectBusinessIdentity(row.kind,row.elementId,workspaceId),'application-settings']),evidenceOperationIds:[RETURN_OPERATIONS.objectSettingsRead]});
      targets.push({ kind: 'field', key: `gra-status|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, fieldId: 'status', value: 'EvaluationStarted',
        mutationOperationId:RETURN_OPERATIONS.graStateWrite,operationTargetIdentityKey:graOperationIdentity('gra-state',prepared,'status'),evidenceOperationIds:[RETURN_OPERATIONS.graStateRead] });
      if (hasFrozenStage(prepared,'gra_state')||hasFrozenStage(prepared,'inherited_rait')) targets.push({ kind: 'field', key: `gra-rait|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, fieldId: 'itElementRaitConclusionLevelId', value: mode,
        mutationOperationId:RETURN_OPERATIONS.graStateWrite,operationTargetIdentityKey:graOperationIdentity('gra-state',prepared,'itElementRaitConclusionLevelId'),evidenceOperationIds:[RETURN_OPERATIONS.graStateRead] });
      if(hasFrozenStage(prepared,'app_category')) targets.push({kind:'field',key:`risk-factor-category|${row.rowKey}`,rowKey:row.rowKey,workspace:workspaceId,objectType:'GRA',graTargetKey:`gra|${row.rowKey}`,fieldId:'applicable',value:true,
        categoryName:'IT风险评估（如果测试运行有效性）',mutationOperationId:RETURN_OPERATIONS.riskFactorCategoryWrite,
        operationTargetIdentityKey:graOperationIdentity('risk-factor-category',prepared,'IT风险评估（如果测试运行有效性）'),
        evidenceOperationIds:[RETURN_OPERATIONS.riskFactorCategoryRead,RETURN_OPERATIONS.riskFactorCategoryPreflight]});
      for (const relation of hasFrozenStage(prepared,'relation')?returnIntents.relationTargets:[]) {
        const targetMatches=resolvedRelationTargets.filter((candidate)=>String(candidate.externalId||'').normalize('NFKC').toLocaleLowerCase('en-US')===String(relation).normalize('NFKC').toLocaleLowerCase('en-US'));
        if(targetMatches.length!==1)fail('RETURN.CAPABILITY_PLAN_DEPENDENCY_INVALID',`Frozen relation target is absent or ambiguous: ${row.kind}/${row.elementId}/${relation}.`);
        const resolvedTarget=targetMatches[0];
        const dependencyMatches=resolvedTarget.sourceType==='in_batch'?dependencySourceRows.filter((candidate)=>candidate.rowKey===resolvedTarget.targetRowKey&&candidate.elementId.normalize('NFKC').toLocaleLowerCase('en-US')===String(relation).normalize('NFKC').toLocaleLowerCase('en-US')):[];
        if(resolvedTarget.sourceType==='in_batch'&&dependencyMatches.length!==1)fail('RETURN.CAPABILITY_PLAN_DEPENDENCY_INVALID',`Frozen in-batch relation dependency is absent or ambiguous: ${row.kind}/${row.elementId}/${relation}.`);
        if(resolvedTarget.sourceType==='external'&&(!normalizedGuid(resolvedTarget.objectId)||!normalizedGuid(resolvedTarget.riskAssessmentId)))fail('RETURN.RELATION_TARGET_UNVERIFIED',`Frozen external APP relation identity is incomplete: ${row.kind}/${row.elementId}/${relation}.`);
        targets.push({ kind: 'relation', key: `element-relation|${row.rowKey}|${relation}`, rowKey: row.rowKey, workspace: workspaceId, relationType: planRow.relationPolicy.relationType,
          sourceObjectTargetKey:`object|${row.rowKey}`,targetObjectTargetKey:dependencyMatches[0]?`object|${dependencyMatches[0].rowKey}`:'',targetExternalId:relation,targetSourceType:resolvedTarget.sourceType,targetWorkspace:String(resolvedTarget.workspaceId),
          targetDependencyRowKey:dependencyMatches[0]?.rowKey||'',resolvedTargetObjectId:String(resolvedTarget.objectId||''),resolvedTargetRiskAssessmentId:String(resolvedTarget.riskAssessmentId||''),mutationOperationId:RETURN_OPERATIONS.relationWrite,
          operationTargetIdentityMode:'resolved_relation',operationTargetIdentityKey:'post-create-resolution',evidenceOperationIds:[RETURN_OPERATIONS.relationRead] });
      }
      const selectedGovernance = hasFrozenStage(prepared,'risk_control')?returnIntents.riskControlCatalogRelations:[];
      const requiredGovernance=hasFrozenStage(prepared,'risk_control')?returnIntents.riskControlRelations:[];
      const classificationTargets=new Map();
      for(const risk of returnIntents.riskClassifications){
        const classification=risk.classification;const riskNumber=risk.riskNumber;
        const uniqueKey=catalogIdentityText(riskNumber);const existing=classificationTargets.get(uniqueKey);
        if(existing&&catalogIdentityText(existing.classification)!==catalogIdentityText(classification))fail('RETURN.RISK_CLASSIFICATION_GOVERNANCE_CONFLICT',`Generated Risk ${riskNumber} has conflicting governed classifications.`);
        if(!existing)classificationTargets.set(uniqueKey,{riskName:risk.riskName,riskNumber,classification});
      }
      for(const risk of classificationTargets.values()) targets.push({kind:'field',key:`risk-classification|${row.rowKey}|${risk.riskNumber}`,rowKey:row.rowKey,workspace:workspaceId,objectType:'GRA',graTargetKey:`gra|${row.rowKey}`,fieldId:'classificationType',value:risk.classification,riskName:risk.riskName,riskNumber:risk.riskNumber,
        mutationOperationId:RETURN_OPERATIONS.riskClassificationWrite,operationTargetIdentityKey:graOperationIdentity('risk-classification',prepared,`${risk.riskNumber}|${risk.classification}`),evidenceOperationIds:[RETURN_OPERATIONS.riskClassificationRead,RETURN_OPERATIONS.riskClassificationPreflight]});
      for (const relation of requiredGovernance) targets.push({
        kind: 'risk_control', key: `risk-control|${row.rowKey}|${relation.relationId}`, rowKey: row.rowKey, workspace: workspaceId,
        objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, relationId: relation.relationId, riskName: relation.riskName, controlName: relation.controlName,
        classification: relation[`classification${mode || 'Higher'}`],mutationOperationId:RETURN_OPERATIONS.riskWrite,operationTargetIdentityKey:graOperationIdentity('risk-control',prepared,relation.relationId),evidenceOperationIds:[RETURN_OPERATIONS.riskRead]
      });
      if (hasFrozenStage(prepared,'app_scoring')) {
        for (const item of returnIntents.scoringItems) targets.push({ kind: 'field', key: `risk-factor|${row.rowKey}|${item.itemId}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, fieldId: item.itemId, itemLabel:item.label, value: mode,contentName,
          mutationOperationId:RETURN_OPERATIONS.factorWrite,operationTargetIdentityKey:graOperationIdentity('risk-factor',prepared,item.itemId),evidenceOperationIds:[RETURN_OPERATIONS.factorRead,RETURN_OPERATIONS.factorPreflight] });
        const factors = String(returnIntents.documentation||'');
        if (factors) targets.push({ kind: 'documentation', key: `documentation|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, plainText: factors,
          mutationOperationId:RETURN_OPERATIONS.documentationWrite,operationTargetIdentityKey:graOperationIdentity('documentation',prepared,'factors-considered'),evidenceOperationIds:[RETURN_OPERATIONS.documentationRead] });
      }
      if(hasFrozenStage(prepared,'evaluation')) targets.push({ kind: 'evaluation', key: `evaluation|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, value: 'EvaluationComplete',
        mutationOperationId:RETURN_OPERATIONS.evaluationWrite,operationTargetIdentityKey:graOperationIdentity('evaluation',prepared,'EvaluationComplete'),evidenceOperationIds:[RETURN_OPERATIONS.evaluationRead] });
    }
    for(const relation of targets.filter((item)=>item.kind==='relation')){
      if(relation.targetSourceType==='external'){
        if(!normalizedGuid(relation.resolvedTargetObjectId)||!normalizedGuid(relation.resolvedTargetRiskAssessmentId)||!normalizedGuid(relation.targetWorkspace))fail('RETURN.RELATION_TARGET_UNVERIFIED',`Relation ${relation.key} has no exact external APP target.`);
        continue;
      }
      const matches=rowsPrepared.filter((item)=>item.rowKey===relation.targetDependencyRowKey&&String(item.workspaceId)===String(relation.targetWorkspace)&&item.elementId.normalize('NFKC').toLocaleLowerCase('en-US')===String(relation.targetExternalId).normalize('NFKC').toLocaleLowerCase('en-US'));
      if(matches.length!==1) fail('RETURN.RELATION_TARGET_UNVERIFIED',`Relation ${relation.key} does not resolve to one exact in-workbook APP target.`);
      relation.targetObjectTargetKey=`object|${matches[0].rowKey}`;
      relation.targetWorkspace=matches[0].workspaceId;
    }
    for(const row of rowsPrepared.filter((item)=>hasFrozenStage(item,'inherited_rait'))){
      if(!row.inheritanceSources.length) fail('RETURN.RAIT_INHERITANCE_AMBIGUOUS',`${row.kind} ${row.elementId} has no governed APP inheritance sources.`);
      for(const sourceReference of row.inheritanceSources){
        const source=sourceReference.sourceType==='in_batch'?rowsPrepared.find((item)=>row.dependencyRowKeys.includes(item.rowKey)&&item.rowKey===sourceReference.rowKey&&item.elementId.normalize('NFKC')===sourceReference.externalId.normalize('NFKC')&&item.workspaceName.normalize('NFKC')===sourceReference.workspaceName.normalize('NFKC')):null;
        if(sourceReference.sourceType==='in_batch'&&!source) fail('RETURN.RAIT_INHERITANCE_AMBIGUOUS',`${row.kind} ${row.elementId} APP inheritance source is not an exact planned identity.`);
        const sourceIdentity=source||{kind:'APP',elementId:sourceReference.externalId,workspaceId:sourceReference.workspaceId,graName:deriveGraName(sourceReference.externalId)};
        targets.push({kind:'field',key:sourceReference.sourceKey,rowKey:row.rowKey,workspace:sourceReference.workspaceId,objectType:'GRA',graTargetKey:source?`gra|${source.rowKey}`:'',sourceType:sourceReference.sourceType,sourceRowKey:sourceReference.rowKey,sourceExternalId:sourceReference.externalId,resolvedRiskAssessmentId:sourceReference.riskAssessmentId||'',fieldId:'itElementRaitConclusionLevelId',value:sourceReference.plannedMode,mutationOperationId:RETURN_OPERATIONS.graStateWrite,operationTargetIdentityKey:inheritanceOperationIdentity(sourceIdentity,row),evidenceOperationIds:[RETURN_OPERATIONS.graStateRead]});
      }
    }
    const normalized=(value)=>String(value||'').normalize('NFKC').replace(/\s+/gu,' ').trim();
    preflights.push(...await runBoundedIndependent(rowsPrepared,RETURN_DEFAULT_CONCURRENCY,async(row)=>{
      const rowTargets=targets.filter((item)=>item.rowKey===row.rowKey);
      const rowPreview={rowKey:row.rowKey,elementId:row.elementId,workspaceId:row.workspaceId,changes:[]};
      rowPreview.changes.push({targetKey:`object|${row.rowKey}`,disposition:row.identityDisposition,current:row.objectId||'absent',desired:`${row.objectType}/${row.elementId}`,operationId:RETURN_OPERATIONS.objectCreate,evidenceOperationIds:row.kind==='APP'?[RETURN_OPERATIONS.objectIdentityResolve,RETURN_OPERATIONS.objectRead]:[RETURN_OPERATIONS.objectRead]});
      rowPreview.changes.push({targetKey:`gra|${row.rowKey}`,disposition:row.graId?'reuse':'create',current:row.graId||'absent',desired:`${row.content.contentName}/${row.graName}`,operationId:RETURN_OPERATIONS.graCreate,evidenceOperationId:RETURN_OPERATIONS.graRead});
      if(hasFrozenStage(row,'settings')){
        const settingsIntent=rowTargets.find((item)=>item.key===`object-settings|${row.rowKey}`);
        if(row.objectId){
          const target={targetIdentityKey:settingsIntent.operationTargetIdentityKey,workspaceId:row.workspaceId};
          const current=await invoke(RETURN_OPERATIONS.objectSettingsPreflight,context.connectorBinding,{target,objectId:row.objectId});
           const currentToken=latestApplicationSettingsToken(current,false,`APP ${row.elementId} settings preflight`);
           if(!currentToken){
             if(row.identityDisposition!=='resume'||!unsetApplicationSettings(current)||!exactApplicationSettingsIdentity(current,row.objectId,row.elementId))fail('RETURN.OBJECT_SETTINGS_AUTHORITY_MISSING',`APP ${row.elementId} has no reusable 501 token and is not an exact empty owned-create recovery candidate.`);
             const proof=await store.call('proveOwnedCreatedObject',{objectId:row.objectId,workspaceId:row.workspaceId,externalId:row.elementId,expectedObjectType:'Application',connectorBinding:context.connectorBinding});
             if(proof?.proven!==true)fail('RETURN.OBJECT_SETTINGS_OWNERSHIP_MISSING',`APP ${row.elementId} has no exact prior product-owned object.create commit proof.`);
             settingsIntent.mode='recover_owned_create_bootstrap';settingsIntent.ownedCreateProof={runId:proof.runId,commandId:proof.commandId,objectId:proof.objectId};
           }
           const frozenData=freezeAppDataAvailability(row.identityDisposition,current.isDataAvailable,row.isDataAvailable);const desiredData=frozenData.value;
           row.dataAvailability=frozenData;settingsIntent.isDataAvailable=desiredData;settingsIntent.dataAvailabilityDisposition=frozenData.disposition;
          rowPreview.changes.push({targetKey:settingsIntent.key,disposition:String(current.typeId)===String(settingsIntent.typeId)&&current.isRelevant===settingsIntent.isRelevant&&current.isDataAvailable===desiredData?'reuse':'patch',current:{typeId:current.typeId,isRelevant:current.isRelevant,isDataAvailable:current.isDataAvailable},desired:{typeId:settingsIntent.typeId,isRelevant:settingsIntent.isRelevant,isDataAvailable:desiredData},operationId:RETURN_OPERATIONS.objectSettingsWrite,evidenceOperationId:RETURN_OPERATIONS.objectSettingsRead});
         }else{const frozenData=freezeAppDataAvailability('create',undefined,row.isDataAvailable);row.dataAvailability=frozenData;settingsIntent.isDataAvailable=frozenData.value;settingsIntent.dataAvailabilityDisposition=frozenData.disposition;rowPreview.changes.push({targetKey:settingsIntent.key,disposition:'post-create-resolution',current:'not-readable-before-object-create',desired:{typeId:settingsIntent.typeId,isRelevant:settingsIntent.isRelevant,isDataAvailable:frozenData.value,dataAvailabilityDisposition:frozenData.disposition},operationId:RETURN_OPERATIONS.objectSettingsWrite,evidenceOperationId:RETURN_OPERATIONS.objectSettingsRead});}
      }
      if(row.graId){
        const statusIntent=rowTargets.find((item)=>String(item.key).startsWith('gra-status|'));
        const state=await invoke(RETURN_OPERATIONS.graStatePreflight,context.connectorBinding,{target:{targetIdentityKey:statusIntent.operationTargetIdentityKey,workspaceId:row.workspaceId},riskAssessmentId:row.graId});
        for(const intent of rowTargets.filter((item)=>String(item.key).startsWith('gra-status|')||String(item.key).startsWith('gra-rait|'))){
          const patchKind=intent.fieldId==='status'?'status':'rait'; const current=patchKind==='status'?(state.status??null):(state.itElementRaitConclusionLevelId||state.itElementRaitConclusionLevelName||null);
          rowPreview.changes.push({targetKey:intent.key,disposition:String(current)===String(intent.value)?'reuse':'patch',current,desired:intent.value,operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]});
        }
        const desiredStatus=rowTargets.find((item)=>String(item.key).startsWith('gra-status|'))?.value;
        const desiredRait=rowTargets.find((item)=>String(item.key).startsWith('gra-rait|'))?.value;
        if(!desiredStatus||!desiredRait) fail('RETURN.GRA_STATE_INTENT_MISSING',`GRA ${row.graId} has no complete frozen status/RAIT target.`);
        const graStateReady=String(state.status)===String(desiredStatus)&&normalizeRait(state.itElementRaitConclusionLevelId||state.itElementRaitConclusionLevelName)===normalizeRait(desiredRait);
        const evaluationComplete=String(state.status)==='EvaluationComplete';
        const deferred=rowTargets.filter((item)=>item.kind==='risk_control'||String(item.key).startsWith('risk-classification|')||String(item.key).startsWith('risk-factor-category|')||String(item.key).startsWith('risk-factor|')||item.kind==='documentation'||item.kind==='evaluation');
        if(!graStateReady){
          for(const intent of deferred){
            const desired=intent.kind==='risk_control'?{relationId:intent.relationId,riskName:intent.riskName,controlName:intent.controlName,classification:intent.classification}
              :String(intent.key).startsWith('risk-classification|')?{riskName:intent.riskName,classification:intent.value}
                :String(intent.key).startsWith('risk-factor-category|')?{categoryName:intent.categoryName,applicable:intent.value}
                :String(intent.key).startsWith('risk-factor|')?{itemId:intent.fieldId,itemLabel:intent.itemLabel,selectionMode:intent.value,contentName:intent.contentName}
                :intent.kind==='documentation'?{plainText:intent.plainText}:{value:intent.value};
            if(Object.values(desired).some((value)=>value===undefined||value===null||value==='')||!Array.isArray(intent.evidenceOperationIds)) fail('RETURN.DEFERRED_INTENT_INVALID',`Deferred GRA target ${intent.key} is incomplete.`);
            intent.resolutionMode='post_state_catalog';rowPreview.changes.push({targetKey:intent.key,disposition:'post-state-resolution',current:'GRA state/RAIT not ready',desired,operationId:intent.mutationOperationId,evidenceOperationIds:intent.evidenceOperationIds});
          }
        }else{
          const riskIntents=rowTargets.filter((item)=>item.kind==='risk_control');
          const classificationIntents=rowTargets.filter((item)=>String(item.key).startsWith('risk-classification|'));
          if((riskIntents.length||classificationIntents.length)&&!evaluationComplete){
            for(const intent of [...classificationIntents,...riskIntents]){
              const desired=intent.kind==='risk_control'
                ?{relationId:intent.relationId,riskName:intent.riskName,controlName:intent.controlName,classification:intent.classification}
                :{riskName:intent.riskName,classification:intent.value};
              if(Object.values(desired).some((value)=>value===undefined||value===null||value==='')) fail('RETURN.DEFERRED_INTENT_INVALID',`Deferred Risk-Control target ${intent.key} is incomplete.`);
              intent.resolutionMode='post_evaluation_catalog';
              rowPreview.changes.push({targetKey:intent.key,disposition:'post-evaluation-resolution',current:'Evaluation is not complete',desired,operationId:intent.mutationOperationId,evidenceOperationIds:intent.evidenceOperationIds});
            }
          }else if(riskIntents.length||classificationIntents.length){
            const catalog=await invoke(RETURN_OPERATIONS.riskCatalog,context.connectorBinding,{target:{targetIdentityKey:graOperationIdentity('risk-catalog',row,'generated-catalog'),workspaceId:row.workspaceId},riskAssessmentId:row.graId});
            for(const intent of classificationIntents){
              const risks=catalogRiskIdentityMatches(catalog,intent);
              if(risks.length!==1) fail('RETURN.RISK_CLASSIFICATION_IDENTITY_DRIFT',`Generated Risk identity is absent or ambiguous during review: ${intent.riskNumber}.`);
              const risk=risks[0];intent.resolvedRisk={riskId:risk.riskId,riskRiskScopeId:risk.riskRiskScopeId,riskScopeId:risk.riskScopeId,assertionType:risk.assertionType,assertion:risk.assertion};
              rowPreview.changes.push({targetKey:intent.key,disposition:catalogIdentityText(risk.classification)===catalogIdentityText(intent.value)?'reuse':'patch',current:risk.classification||'',desired:intent.value,resolvedIds:intent.resolvedRisk,operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]});
            }
            for(const intent of riskIntents){
              const risks=catalogRiskIdentityMatches(catalog,intent);
              const controls=catalogControlMatches(catalog,intent);
              if(risks.length!==1||controls.length!==1) fail('RETURN.RISK_CONTROL_CATALOG_DRIFT',`Risk/Control identity is absent or ambiguous during review: ${intent.relationId}.`);
              const risk=risks[0],control=controls[0]; intent.resolvedCatalog={riskId:risk.riskId,riskRiskScopeId:risk.riskRiskScopeId,riskScopeId:risk.riskScopeId,controlId:control.controlId,assertionType:risk.assertionType,assertion:risk.assertion,updatedOn:risk.updatedOn};
              const observed=await invoke(RETURN_OPERATIONS.riskRead,context.connectorBinding,{target:{targetIdentityKey:intent.operationTargetIdentityKey,workspaceId:row.workspaceId},query:{riskRiskScopeId:risk.riskRiskScopeId,riskScopeId:risk.riskScopeId,riskId:risk.riskId,controlId:control.controlId,assertionType:risk.assertionType,assertion:risk.assertion}});
              rowPreview.changes.push({targetKey:intent.key,disposition:observed.verified===true?'reuse':'associate',current:observed.verified===true?'exact association':'absent',desired:{risk:intent.riskName,classification:intent.classification,control:intent.controlName,assertionType:risk.assertionType,assertion:risk.assertion},resolvedIds:intent.resolvedCatalog,operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]});
            }
          }
          const categoryIntent=rowTargets.find((item)=>String(item.key).startsWith('risk-factor-category|'));
          let categoryReady=false;
          if(categoryIntent){
            const target={targetIdentityKey:categoryIntent.operationTargetIdentityKey,workspaceId:row.workspaceId};
            const observed=await invoke(RETURN_OPERATIONS.riskFactorCategoryPreflight,context.connectorBinding,{target,query:{riskAssessmentId:row.graId,categoryId:'',categoryName:categoryIntent.categoryName,objectType:'Application'}});
            categoryIntent.resolvedCategory={categoryId:observed.categoryId,categoryName:observed.categoryName};
            categoryReady=observed.applicable===true;
            rowPreview.changes.push({targetKey:categoryIntent.key,disposition:observed.applicable===true?'reuse':'patch',current:observed.applicable,desired:true,resolvedIds:categoryIntent.resolvedCategory,operationId:categoryIntent.mutationOperationId,evidenceOperationId:categoryIntent.evidenceOperationIds[0]});
          }
          for(const intent of rowTargets.filter((item)=>String(item.key).startsWith('risk-factor|'))){
            if(!categoryReady){intent.resolutionMode='post_category_verification';rowPreview.changes.push({targetKey:intent.key,disposition:'post-category-resolution',current:'IT Risk Factor category is not yet verified applicable',desired:{itemId:intent.fieldId,itemLabel:intent.itemLabel,selectionMode:intent.value,contentName:intent.contentName},operationId:intent.mutationOperationId,evidenceOperationIds:intent.evidenceOperationIds});continue;}
            const target={targetIdentityKey:intent.operationTargetIdentityKey,workspaceId:row.workspaceId};
            const observed=await invoke(RETURN_OPERATIONS.factorPreflight,context.connectorBinding,{target,query:{riskAssessmentId:row.graId,itemId:intent.fieldId,itemLabel:intent.itemLabel,selectionMode:intent.value,contentName:intent.contentName}});
            intent.resolvedFactor={factorId:observed.factorId,selectedValue:observed.selected?.value,selectedName:observed.selected?.name,spectrumDigest:digest(Buffer.from(canonical(observed.spectrum||[])))};
            const selected=Number(observed.selected?.value),current=Number(observed.current?.value??observed.current);
            rowPreview.changes.push({targetKey:intent.key,disposition:observed.applicable===false?'not-applicable':selected===current?'reuse':'patch',current:observed.current,desired:observed.selected,operationId:intent.mutationOperationId,evidenceOperationId:observed.applicable===false?RETURN_OPERATIONS.factorPreflight:RETURN_OPERATIONS.factorRead});
          }
          const docIntent=rowTargets.find((item)=>item.kind==='documentation');
          if(docIntent){const current=await invoke(RETURN_OPERATIONS.documentationPreflight,context.connectorBinding,{target:{targetIdentityKey:docIntent.operationTargetIdentityKey,workspaceId:row.workspaceId},riskAssessmentId:row.graId}); const doc=observedDocumentation(current);
            rowPreview.changes.push({targetKey:docIntent.key,disposition:String(doc?.plainText||'')===String(docIntent.plainText)?'reuse':'patch',current:doc?.plainText||'',desired:docIntent.plainText,operationId:docIntent.mutationOperationId,evidenceOperationId:docIntent.evidenceOperationIds[0]});}
          const evalIntent=rowTargets.find((item)=>item.kind==='evaluation');
          const evaluation=await invoke(RETURN_OPERATIONS.evaluationPreflight,context.connectorBinding,{target:{targetIdentityKey:evalIntent.operationTargetIdentityKey,workspaceId:row.workspaceId},riskAssessmentId:row.graId});
          rowPreview.changes.push({targetKey:evalIntent.key,disposition:evaluation.status===evalIntent.value?'reuse':'submit',current:evaluation.status,desired:evalIntent.value,operationId:evalIntent.mutationOperationId,evidenceOperationId:evalIntent.evidenceOperationIds[0]});
        }
      }else for(const intent of rowTargets.filter((item)=>!item.key.startsWith('object|')&&!item.key.startsWith('gra|')&&item.kind!=='relation'&&!item.key.startsWith('object-settings|'))) rowPreview.changes.push({targetKey:intent.key,disposition:'post-create-resolution',current:'not-readable-before-gra-create',desired:intent.value||intent.plainText||intent.relationId||intent.fieldId||intent.kind,operationId:intent.mutationOperationId,evidenceOperationIds:intent.evidenceOperationIds});
      return rowPreview;
    }));
    const relationPreviews=await runBoundedIndependent(targets.filter((item)=>item.kind==='relation'),RETURN_DEFAULT_CONCURRENCY,async(intent)=>{
      const source=rowsPrepared.find((item)=>`object|${item.rowKey}`===intent.sourceObjectTargetKey); const targetRow=rowsPrepared.find((item)=>`object|${item.rowKey}`===intent.targetObjectTargetKey);
      const targetObjectId=targetRow?.objectId||intent.resolvedTargetObjectId;
      if(source?.objectId&&targetObjectId){const target={targetIdentityKey:`relation|${intent.workspace}|${intent.targetWorkspace}|${source.objectId}|${targetObjectId}|${intent.relationType}`,workspaceId:intent.workspace}; intent.resolvedOperationTargetIdentityKey=target.targetIdentityKey;
        const observed=await invoke(RETURN_OPERATIONS.relationPreflight,context.connectorBinding,{target,query:{associationType:intent.relationType,itElementId:source.objectId,associatingEntityId:targetObjectId,sourceWorkspaceId:intent.workspace,targetWorkspaceId:intent.targetWorkspace}});
        return{rowKey:intent.rowKey,change:{targetKey:intent.key,disposition:observed.associated===true&&observed.inconsistent===false?'reuse':'associate',current:observed,desired:{sourceObjectId:source.objectId,targetObjectId,sourceWorkspaceId:intent.workspace,targetWorkspaceId:intent.targetWorkspace,relationType:intent.relationType},operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]}};
      }
      return{rowKey:intent.rowKey,change:{targetKey:intent.key,disposition:'post-create-resolution',current:'source-or-target-object-not-yet-created',desired:{sourceObjectTargetKey:intent.sourceObjectTargetKey,targetObjectTargetKey:intent.targetObjectTargetKey,relationType:intent.relationType},operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]}};
    });
    for(const item of relationPreviews){
      const preview=preflights.find((candidate)=>candidate.rowKey===item.rowKey);
      if(!preview)fail('RETURN.RELATION_PREVIEW_ROW_MISSING',`Frozen relation preview row is missing: ${item.rowKey}.`);
      preview.changes.push(item.change);
    }
    assertReturnPlanCapabilities(planIr.rows,rowsPrepared);
    return { authority, rows: rowsPrepared, targets, preflights };
  }

  return Object.freeze({
    shutdown: async () => { await python.close(); return true; },
    health: async () => {
      await python.start();
      let latest=(await store.call('loadLatestRun',{}))||{}; let run=latest?.run;
      try{
        latest.legacyRecoveryInspection=await store.call('inspectLegacyReturnRecovery',{
          schemaVersion:'omnia.feature-return-recovery-inspection/v1',runId:'',sourceFeatureVersion:''
        });
        if(!legacyRecoveryInspectionEligible(latest.legacyRecoveryInspection)){
          latest.legacyRecoveryInspection=null;
          latest.legacyRecoveryInspectionError='Core 未返回唯一、可恢复的中断 Run。';
        }
      }catch(error){
        latest.legacyRecoveryInspection=null;
        latest.legacyRecoveryInspectionError=`恢复检查不可用：${String(error?.message||error)}`;
      }
      if(run&&['waiting_confirmation','returning','verifying','uncertain','reconciling','succeeded','failed'].includes(String(run.state))) latest.returnProgress=await store.call('loadReturnProgress',{runId:String(run.run_id)});
      let recoveredSurfacePatch=null;
      if(run?.state==='acquiring'){
        await ensureStagedPlan(latest);
        recoveredSurfacePatch=uploadSurface(latest,'已恢复待确认的系统信息文件；确认上传后才会开始校验。');
      }else if(run?.state==='processing'){
        const checkpoint=await store.call('loadPlan',String(run.run_id));const descriptor=checkpoint?.descriptor;
        const resumable=checkpoint?.stageState==='processing'
          && String(checkpoint.runId||'')===String(run.run_id)
          && String(checkpoint.traceId||'')===String(run.trace_id)
          && descriptor?.kind==='source'
          && String(descriptor.runId||'')===String(run.run_id)
          && String(descriptor.traceId||'')===String(run.trace_id)
          && String(descriptor.artifactId||'')===String(run.source_artifact_id||'');
        if(resumable){
          recoveredSurfacePatch=processingSurface(latest,'已恢复已确认的系统信息文件；后台校验将从尚未提交的 processing 阶段安全启动。',checkpoint.validationProgress||null);
        }else{
          const revision=await store.call('transitionRun',{runId:String(run.run_id),expectedRevision:Number(run.state_revision),toState:'failed',eventType:'run.processing_recovery_rejected',error:'Persisted processing Run and staged plan identity drifted; background validation was not replayed.',details:{interruptedStage:'processing',stageState:String(checkpoint?.stageState||''),replay:false}});
          latest=await store.call('loadLatestRun',{});run=latest.run;const progress=progressSurface(latest);
          recoveredSurfacePatch={stateVersion:Number(revision),status:'stale',statusMessage:`processing Run 与持久化上传计划不一致；Run 已失败关闭（revision ${revision}），未启动后台校验。请重新上传原文件建立新 Run。`,scopes:progress.scopes,items:progress.items,artifacts:(latest.artifacts||[]).filter((item)=>String(item.kind)!=='source').map((item)=>({artifactId:String(item.artifact_id),kind:String(item.kind),name:String(item.original_name),sha256:String(item.sha256),sizeBytes:Number(item.size_bytes),available:true,reason:''})),editors:[],actions:[{actionId:'stage-source-workbook',enabled:true,reason:''},{actionId:'validate-staged-upload',enabled:false,reason:'不一致的 Run 已失败关闭，禁止后台重放。'},...workflowNavigationActions(latest,'upload'),{actionId:'apply-revisions',enabled:false,reason:'不一致的 Run 不允许原地修订。'},{actionId:'prepare-return',enabled:false,reason:'必须重新导入并生成新 Run。'}]};
        }
      }else if(run&&['converting','validating_output'].includes(run.state)){
        const interruptedStage=String(run.state); const revision=await store.call('transitionRun',{runId:String(run.run_id),expectedRevision:Number(run.state_revision),toState:'failed',eventType:'run.offline_crash_recovered',error:`Offline ${interruptedStage} stage was interrupted; no processing was replayed.`,details:{interruptedStage,replay:false}});
        latest=await store.call('loadLatestRun',{}); run=latest.run; const progress=progressSurface(latest);
        recoveredSurfacePatch={stateVersion:Number(revision),status:'stale',statusMessage:`检测到离线处理在 ${interruptedStage} 阶段中断；Run 已持久化转为 failed（revision ${revision}），未自动重放。请通过“选择用户资料”重新导入原文件以建立新 Run。`,
          scopes:progress.scopes,items:progress.items,
          artifacts:(latest.artifacts||[]).filter((item)=>String(item.kind)!=='source').map((item)=>({artifactId:String(item.artifact_id),kind:String(item.kind),name:String(item.original_name),sha256:String(item.sha256),sizeBytes:Number(item.size_bytes),available:true,reason:''})),editors:[],actions:[
            {actionId:'stage-source-workbook',enabled:true,reason:''},...workflowNavigationActions(latest,'upload'),{actionId:'apply-revisions',enabled:false,reason:'中断 Run 不允许原地修订。'},{actionId:'prepare-return',enabled:false,reason:'离线处理未完成；必须重新导入并生成新 Run。'}]};
      }
      const healthEvents=Array.isArray(latest?.events)?latest.events:[];
      const healthLastEvent=healthEvents[healthEvents.length-1];
      const restartAlreadyAudited=Boolean(run)
        && String(healthLastEvent?.event_type||'')==='run.restart_requested'
        && Number(healthLastEvent?.revision||0)===Number(run.state_revision);
      if(restartAlreadyAudited){
        recoveredSurfacePatch=uploadSurface(latest,'旧流程审计已保留；请上传新文件建立全新 Run。',true);
      }else if(run&&['waiting_confirmation','returning','verifying','uncertain','reconciling'].includes(String(run.state))){
        const checkpoint=await store.call('loadPlan',String(run.run_id));
        recoveredSurfacePatch=returnSurface(latest,'',checkpoint?.execution||{});
      }else if(run&&['succeeded','failed'].includes(String(run.state))&&Array.isArray(latest.returnProgress)&&latest.returnProgress.length){
        const checkpoint=await store.call('loadPlan',String(run.run_id));
        recoveredSurfacePatch=returnSurface(latest,'',checkpoint?.execution||{});
      }else if(terminalRunReturnsToFreshUpload(latest)){
        recoveredSurfacePatch=uploadSurface(latest,'旧流程已进入终态并保留完整审计；可直接上传新文件建立全新 Run。',true);
      }
      if(run&&['needs_input','ready_for_review'].includes(run.state)){
        const checkpoint=await store.call('loadPlan',String(run.run_id));
        if(checkpoint?.parsed) recoveredSurfacePatch=checkpoint.reviewNavigation==='upload'
          ?uploadSurface(latest,'已恢复持久化 Upload 层；原 Run、Artifact、修订与排除状态未改变。')
          :reviewSurface(latest,checkpoint,null,'已恢复持久化 Review 层。');
      }
      if(!run)recoveredSurfacePatch=uploadSurface(latest,'',true);
      return {ready:true,featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,transport:'remote-only',recoveredMessageCard:null,recoveredSurfacePatch};
    },
    handleAction: async (input) => {
      if(input?.actionId==='recover-interrupted-run'){
        const inspection=await store.call('inspectLegacyReturnRecovery',{
          schemaVersion:'omnia.feature-return-recovery-inspection/v1',runId:'',sourceFeatureVersion:''
        });
        const currentRunAtRecovery=await store.call('loadLatestRun',{});
        if(currentRunAtRecovery?.run)fail('RETURN.RECOVERY_CURRENT_RUN_EXISTS','当前版本已有 Run；旧中断 Run 保持不变。');
        if(input.payload?.['authorize-legacy-recovery']!==true)fail('RETURN.RECOVERY_CONFIRMATION_REQUIRED','请先明确确认：仅执行只读核验并关闭旧中断 Run，随后需重新上传已更换元素名称的文件。');
        if(!input.context?.connectorBinding||!input.context?.safetyLock){
          fail('RETURN.RECOVERY_AUTHORITY_REQUIRED','恢复中断 Run 需要当前 Connector binding 与 safety lock；旧 Run 保持不变。');
        }
        if(inspection?.schemaVersion!=='omnia.feature-return-recovery-inspection-result/v1'||inspection.eligible!==true
          ||inspection.featureId!==FEATURE_ID||inspection.sourceFeatureVersion!=='0.2.60'
          ||inspection.successorFeatureVersion!==FEATURE_VERSION||inspection.recoveryMode!=='partial_close_no_reuse'
          ||!inspection.runId||!Number.isSafeInteger(Number(inspection.stateRevision))||inspection.state!=='returning'
          ||Number(inspection.counts?.uncertain||0)!==0||Number(inspection.counts?.inFlight||0)!==0||!Array.isArray(inspection.reconcileRequired)
          ||inspection.reconcileRequired.length>1||!inspection.sourceArtifact?.artifactId||!inspection.sourceArtifact?.sha256){
          fail('RETURN.RECOVERY_INSPECTION_REJECTED','Core 未返回唯一、可安全关闭的 0.2.60 中断 Run；旧 Run 保持不变。');
        }
        const authorization=await store.call('authorizeLegacyReturnRecovery',{
          schemaVersion:'omnia.feature-return-recovery-authorization-request/v1',runId:String(inspection.runId),
          sourceFeatureVersion:String(inspection.sourceFeatureVersion),expectedStateRevision:Number(inspection.stateRevision),
          connectorBinding:input.context.connectorBinding,safetyLock:input.context.safetyLock
        });
        if(authorization?.schemaVersion!=='omnia.feature-return-recovery-authorization/v1'
          ||!authorization.authorizationId||String(authorization.runId)!==String(inspection.runId)
          ||authorization.sourceFeatureVersion!==inspection.sourceFeatureVersion||authorization.successorFeatureVersion!==FEATURE_VERSION
          ||Number(authorization.expectedStateRevision)!==Number(inspection.stateRevision)
          ||!Array.isArray(authorization.reconcileRequired)
          ||authorization.reconcileRequired.length!==inspection.reconcileRequired.length
          ||canonical(authorization.reconcileRequired)!==canonical(inspection.reconcileRequired)
          ||!Number.isFinite(Date.parse(String(authorization.expiresAt||'')))||Date.parse(String(authorization.expiresAt))<=Date.now()){
          fail('RETURN.RECOVERY_AUTHORIZATION_INVALID','Core legacy recovery authorization 不完整或已过期；旧 Run 保持不变。');
        }
        if(inspection.reconcileRequired.length===1){
          const inspected=inspection.reconcileRequired[0];
          const authorized=authorization.reconcileRequired[0];
          if(!inspected?.commandId||inspected.commandId!==authorized?.commandId
            ||inspected.targetKind!=='object'||authorized.targetKind!=='object'
            ||inspected.operationId!==RETURN_OPERATIONS.graCreate||authorized.operationId!==RETURN_OPERATIONS.graCreate
            ||!String(inspected.targetKey||'').startsWith('gra|')||inspected.targetKey!==authorized.targetKey
            ||inspected.targetIdentityKey!==authorized.targetIdentityKey){
            fail('RETURN.RECOVERY_COMMAND_UNSUPPORTED','Legacy recovery 只接受 Core 授权的唯一 GRA create command；旧 Run 保持不变。');
          }
          const spec=authorized.reconcileSpec;
          const reconcileOperation=spec?.reconcileOperation||spec?.preflightOperation;
          const reconcileRequest=spec?.reconcileRequest||spec?.preflightRequest;
          const evidenceIds=new Set(Array.isArray(authorized.evidenceOperationIds)?authorized.evidenceOperationIds:[]);
          const target=reconcileRequest?.target;const query=reconcileRequest?.query;const mutation=spec?.mutationPayload;
          if(spec?.commandId!==authorized.commandId||spec?.targetKey!==authorized.targetKey
            ||spec?.mutationOperation!==RETURN_OPERATIONS.graCreate||spec?.commandKind!=='create_gra'
            ||spec?.preflightOperation!==RETURN_OPERATIONS.graPreflight||spec?.reconcileOperation!==RETURN_OPERATIONS.graPreflight
            ||reconcileOperation!==RETURN_OPERATIONS.graPreflight||spec?.readOperation!==RETURN_OPERATIONS.graRead||spec?.readRequest!==null
            ||canonical(spec.preflightRequest)!==canonical(spec.reconcileRequest)||evidenceIds.size!==2
            ||!evidenceIds.has(RETURN_OPERATIONS.graPreflight)||!evidenceIds.has(RETURN_OPERATIONS.graRead)
            ||!target?.targetIdentityKey||target.targetIdentityKey!==authorized.targetIdentityKey
            ||reconcileRequest?.target?.targetIdentityKey!==spec?.target?.targetIdentityKey
            ||!target.workspaceId||query?.workspaceId!==target.workspaceId||mutation?.facetId!==target.workspaceId
            ||query?.entityId!==mutation?.entityId||query?.name!==mutation?.name||!query?.itElementType
            ||Object.keys(query||{}).sort().join(',')!=='entityId,itElementType,name,workspaceId'
            ||Object.keys(mutation||{}).sort().join(',')!=='engagementId,entityId,facetId,inkContentId,name,typeId'
            ||!mutation?.inkContentId||!mutation?.typeId||mutation?.engagementId!==input.context.connectorBinding.engagementId){
            fail('RETURN.RECOVERY_SPEC_INVALID','Legacy GRA recovery specification 与冻结 command/target/Workspace/Engagement 不一致；旧 Run 保持不变。');
          }
          const recoveryContext={schemaVersion:'omnia.feature-return-recovery-receipt-context/v1',authorizationId:String(authorization.authorizationId),
            runId:String(inspection.runId),commandId:String(authorized.commandId)};
          const preflight=await invoke(RETURN_OPERATIONS.graPreflight,input.context.connectorBinding,{...reconcileRequest,recoveryContext});
          if(!preflight||typeof preflight!=='object'||Array.isArray(preflight)||Object.getPrototypeOf(preflight)!==Object.prototype){
            fail('RETURN.RECOVERY_RESPONSE_INVALID','Legacy GRA preflight 未返回可签名的 plain record；旧 Run 保持不变。');
          }
          const {__recoveryReceiptId:preflightReceiptId,...originalPreflight}=preflight;
          if(!String(preflightReceiptId||''))fail('RETURN.RECOVERY_RECEIPT_MISSING','Legacy GRA preflight 未返回 Core 签发的只读 receipt；旧 Run 保持不变。');
          let outcome='';let recoveryReceiptId='';let evidencePayload;
          if(preflight?.found===false){
            outcome='not_applied';recoveryReceiptId=String(preflightReceiptId);evidencePayload=originalPreflight;
          }else if(preflight?.found===true){
            const riskAssessmentId=responseId(preflight.item,'legacy recovery GRA preflight');
            const readRequest={target,riskAssessmentId,query:{entityId:mutation.entityId,name:mutation.name,itElementType:query.itElementType,
              inkContentId:mutation.inkContentId,typeId:mutation.typeId},recoveryContext};
            const readback=await invoke(RETURN_OPERATIONS.graRead,input.context.connectorBinding,readRequest);
            if(responseId(readback,'legacy recovery GRA read-back')!==riskAssessmentId){
              fail('RETURN.RECOVERY_READBACK_UNCERTAIN','Legacy GRA read-back 未返回唯一相同 identity；旧 Run 保持不变。');
            }
            if(!readback||typeof readback!=='object'||Array.isArray(readback)||Object.getPrototypeOf(readback)!==Object.prototype){
              fail('RETURN.RECOVERY_RESPONSE_INVALID','Legacy GRA read-back 未返回可签名的 plain record；旧 Run 保持不变。');
            }
            const {__recoveryReceiptId,...originalReadback}=readback;
            outcome='applied';recoveryReceiptId=String(__recoveryReceiptId||'');evidencePayload=originalReadback;
          }else fail('RETURN.RECOVERY_PREFLIGHT_UNCERTAIN','Legacy GRA preflight 未精确证明 applied 或 not_applied；旧 Run 保持不变。');
          if(!recoveryReceiptId)fail('RETURN.RECOVERY_RECEIPT_MISSING','Legacy recovery Operation 未返回 Core 签发的只读 receipt；旧 Run 保持不变。');
          const recorded=await store.call('recordLegacyReturnRecoveryOutcome',{
            schemaVersion:'omnia.feature-return-recovery-outcome/v1',authorizationId:String(authorization.authorizationId),
            runId:String(inspection.runId),commandId:String(authorized.commandId),outcome,recoveryReceiptId,payload:evidencePayload
          });
          if(recorded?.schemaVersion!=='omnia.feature-return-recovery-outcome-result/v1'
            ||!recorded.outcomeId||recorded.outcome!==outcome||!Number.isFinite(Date.parse(String(recorded.recordedAt||'')))){
            fail('RETURN.RECOVERY_OUTCOME_NOT_RECORDED','Core 未持久化精确 legacy recovery outcome；旧 Run 保持不变。');
          }
        }
        const closed=await store.call('closeLegacyPartialReturn',{
          schemaVersion:'omnia.feature-return-partial-close/v1',authorizationId:String(authorization.authorizationId),
          runId:String(inspection.runId),sourceFeatureVersion:String(inspection.sourceFeatureVersion),expectedStateRevision:Number(inspection.stateRevision)
        });
        if(closed?.schemaVersion!=='omnia.feature-return-partial-close-result/v1'
          ||String(closed?.runId)!==String(inspection.runId)||closed?.state!=='failed'
          ||!Number.isSafeInteger(Number(closed.stateRevision))||closed.recoveryMode!=='partial_close_no_reuse'){
          fail('RETURN.RECOVERY_CLOSE_FAILED','Core 未完成旧 Run 的 CAS partial-close；旧 Run 不得视为已关闭。');
        }
        const current=await store.call('loadLatestRun',{});
        if(current?.run)fail('RETURN.RECOVERY_NEW_RUN_CONFLICT','旧 Run 已关闭，但当前版本已存在另一个 Run；系统未自动上传或确认。');
        return{surfacePatch:uploadSurface(current,'旧中断 Run 已经只读核验并安全关闭。请重新上传已更换元素名称的文件，完成全新校验、预检与确认；系统不会自动上传、确认或回传。',true)};
      }
      if(input?.actionId==='restart-run'||input?.actionId==='fresh-start-on-reopen'){
        const latest=await store.call('loadLatestRun',{});
        const trigger=input.actionId==='fresh-start-on-reopen'?'surface_reopen':'explicit_feature_fresh_start';
        const closed=await closeRunForFreshStart(store,latest,forceCancelledRuns,trigger);
        const preservedRemote=['returning','verifying','succeeded','failed'].includes(closed.initialState)||closed.restarted.terminalAuditPreserved===true;
        return{surfacePatch:uploadSurface(closed.current,preservedRemote?'旧流程已显式结束；已写入并验证的 Omnia 数据、命令、回执与读回证据均已保留，未执行回滚或重放。现在可以上传资料建立新 Run。':'旧流程已通过 Core CAS 结束；Artifact、修订、确认与事件审计均已保留。现在可以上传资料建立新 Run。',true)};
      }
      if(input?.actionId==='back-to-upload'){
        const latest=await store.call('loadLatestRun',{}),run=latest?.run;
        if(run?.state==='returning'){
          const runId=String(run.run_id);forceCancelledRuns.add(runId);
          let cancelled;try{cancelled=await forceCancelReturnRun(store,latest);}catch(error){forceCancelledRuns.delete(runId);throw error;}
          const current=await store.call('loadLatestRun',{});
          return{surfacePatch:returnSurface(current,`已强制取消剩余回传调度：${cancelled.verified}/${cancelled.total} 项已在 Omnia 验证并原样保留；未完成项不会继续执行。`,cancelled.execution)};
        }
        if(run?.state==='waiting_confirmation'){
          const checkpoint=await store.call('loadPlan',String(run.run_id));
          if(!checkpoint?.parsed||!checkpoint?.descriptor)fail('RUN.CHECKPOINT_MISSING','The durable Review checkpoint is unavailable.');
          await store.call('returnRunToReview',{runId:String(run.run_id),expectedRevision:Number(run.state_revision)});
          const {returnPlan:_returnPlan,confirmation:_confirmation,preflightDigest:_preflightDigest,execution:_execution,...reviewCheckpoint}=checkpoint;
          reviewCheckpoint.reviewNavigation='review';reviewCheckpoint.updatedAt=new Date().toISOString();await store.call('savePlan',reviewCheckpoint);
          const current=await store.call('loadLatestRun',{});
          return{surfacePatch:reviewSurface(current,reviewCheckpoint,null,'冻结回传确认已撤销；旧确认令牌失效，当前 Run、Artifact 与字段修订均已保留。')};
        }
      }
      if (input?.actionId === 'reconcile-return') {
        const latest=await store.call('loadLatestRun',{}); const run=latest?.run;const runId=String(input.payload?.runId||run?.run_id||'');
        if(!run||String(run.run_id)!==runId||run.state!=='uncertain') fail('RETURN.RECONCILE_STATE','Only the current uncertain Run can reconcile.');
        const checkpoint=await store.call('loadPlan',runId); const spec=checkpoint?.execution?.reconcileSpec||await store.call('loadReturnReconcileSpec',{runId});
        if(!spec?.commandId||!spec.targetKey) fail('RETURN.RECONCILE_SPEC_MISSING','Serializable reconcile specification is unavailable.');
        await store.call('validateReturnAuthority',{runId,connectorBinding:input.context.connectorBinding,safetyLock:input.context.safetyLock});
        const revision=await store.call('transitionRun',{runId,expectedRevision:Number(run.state_revision),toState:'reconciling',eventType:'return.reconcile_started'});
        const binding=input.context.connectorBinding; const targetSpec=checkpoint.returnPlan.targets.find((item)=>item.key===spec.targetKey);
        const rowPlan=checkpoint.returnPlan.rows.find((item)=>item.rowKey===targetSpec?.rowKey);
        if(!targetSpec||!rowPlan) fail('RETURN.RECONCILE_TARGET_MISSING','Reconcile target is not in the frozen plan.');
        let observed=null; let applied=false; let objectId=''; let manualUnresolved=false;
        const reconcileOperation=spec.reconcileOperation||spec.preflightOperation;
        const reconcileRequest=spec.reconcileRequest||spec.preflightRequest;
        if(reconcileOperation===RETURN_OPERATIONS.objectIdentityResolve){
          const resolution=await invoke(reconcileOperation,binding,reconcileRequest);
          const identity=inspectApplicationIdentity(resolution,reconcileRequest);
          if(identity.accepted&&['resume','reuse'].includes(identity.disposition)){
            objectId=identity.objectId;
            if(identity.disposition==='reuse'){
              const graTarget={targetIdentityKey:checkpoint.returnPlan.targets.find((item)=>item.key===`gra|${rowPlan.rowKey}`)?.operationTargetIdentityKey||graOperationIdentity('gra',rowPlan),workspaceId:rowPlan.workspaceId};
              const graRead=await invoke(RETURN_OPERATIONS.graRead,binding,{target:graTarget,riskAssessmentId:identity.riskAssessmentId,query:{entityId:objectId,name:rowPlan.graName||deriveGraName(rowPlan.elementId),itElementType:'Application',inkContentId:rowPlan.content.inkContentId,typeId:rowPlan.content.typeId}});
              if(responseId(graRead,'reconciled APP GRA read-back')!==identity.riskAssessmentId) fail('RETURN.READBACK_MISMATCH','Reconciled APP GRA differs from its exact identity resolution.');
            }
            const readRequest={target:spec.target,objectId,query:{externalId:rowPlan.elementId,objectType:'Application',description:descriptionEditorJson(rowPlan.description)}};
            await store.call('freezeReturnEvidenceSpec',{runId,commandId:spec.commandId,operationId:RETURN_OPERATIONS.objectRead,request:{connectorBinding:binding,...readRequest}});
            const objectRead=await invoke(RETURN_OPERATIONS.objectRead,binding,{...readRequest,receiptContext:{runId,commandId:spec.commandId}});
            if(responseId(objectRead,'reconciled APP read-back')!==objectId) fail('RETURN.READBACK_MISMATCH','Reconciled APP identity differs from its exact object read-back.');
            observed=objectRead;
            applied=true;
          }else{
            observed={identityResolution:resolution};
            manualUnresolved=true;
          }
        } else if(reconcileOperation===RETURN_OPERATIONS.objectPreflight||reconcileOperation===RETURN_OPERATIONS.graPreflight){
          const found=await invoke(reconcileOperation,binding,reconcileRequest); applied=found?.found===true;
          if(applied){ objectId=responseId(found.item,'reconciled create identity');
            const readOperation=reconcileOperation===RETURN_OPERATIONS.objectPreflight?RETURN_OPERATIONS.objectRead:RETURN_OPERATIONS.graRead;
            const readRequest=reconcileOperation===RETURN_OPERATIONS.objectPreflight
              ?{target:spec.target,objectId,query:{externalId:rowPlan.elementId,objectType:rowPlan.objectType,...(rowPlan.objectType==='Application'?{description:descriptionEditorJson(rowPlan.description)}:{subtypeId:rowPlan.subtypeId})}}
              :{target:spec.target,riskAssessmentId:objectId,query:{entityId:rowPlan.objectId||reconcileRequest.query.entityId,name:rowPlan.graName||deriveGraName(rowPlan.elementId),itElementType:rowPlan.objectType,inkContentId:rowPlan.content.inkContentId,typeId:rowPlan.content.typeId}};
            await store.call('freezeReturnEvidenceSpec',{runId,commandId:spec.commandId,operationId:readOperation,request:{connectorBinding:binding,...readRequest}});
            observed=await invoke(readOperation,binding,{...readRequest,receiptContext:{runId,commandId:spec.commandId}}); }
          else {await store.call('freezeReturnEvidenceSpec',{runId,commandId:spec.commandId,operationId:reconcileOperation,request:{connectorBinding:binding,...reconcileRequest}}); observed=await invoke(reconcileOperation,binding,{...reconcileRequest,receiptContext:{runId,commandId:spec.commandId}});}
        } else if(reconcileOperation===RETURN_OPERATIONS.relationPreflight){
          await store.call('freezeReturnEvidenceSpec',{runId,commandId:spec.commandId,operationId:RETURN_OPERATIONS.relationRead,request:{connectorBinding:binding,...reconcileRequest}});
          observed=await invoke(RETURN_OPERATIONS.relationRead,binding,{...reconcileRequest,receiptContext:{runId,commandId:spec.commandId}}); applied=observed?.associated===true&&observed?.inconsistent===false;
        } else {
          if(!spec.readRequest) fail('RETURN.RECONCILE_READ_MISSING','Reconcile has no serialized exact read request.');
          await store.call('freezeReturnEvidenceSpec',{runId,commandId:spec.commandId,operationId:spec.readOperation,request:{connectorBinding:binding,...spec.readRequest}});
          const readRequest={...spec.readRequest,receiptContext:{runId,commandId:spec.commandId}};
          if(spec.waitForEvaluationComplete) observed=await waitForEvaluationComplete(binding,readRequest);
          else {
            const attempts=Math.max(1,Math.min(RETURN_READBACK_MAX_ATTEMPTS,Number(spec.readbackPolicy?.maxAttempts||RETURN_READBACK_MAX_ATTEMPTS)));
            for(let attempt=0;attempt<attempts;attempt+=1){
              observed=await invoke(spec.readOperation,binding,readRequest);
              if(observed?.verified===true||attempt===attempts-1)break;
            }
          }
          applied=observed?.verified===true;
        }
        await store.call('recordReturnEvidence',{runId,commandId:spec.commandId,evidenceType:'reconcile',commandState:applied?'readback_verified':manualUnresolved?'uncertain':'closed_not_applied',payload:observed,receiptId:observed?.__operationReceiptId||'',verified:applied,error:applied?'':manualUnresolved?'APP identity remains create/skip; the uncertain mutation is not replayed and requires manual reconcile.':'Authoritative reconcile proved the uncertain mutation was not applied.'});
        if(applied){
          if(targetSpec.kind==='relation') await store.call('projectVerifiedReturn',{runId,commandId:spec.commandId,binding,workspaceId:targetSpec.workspace,projectionKind:'relation',relationType:targetSpec.relationType,relationKey:targetSpec.key,sourceObjectId:spec.preflightRequest.query.itElementId,targetObjectId:spec.preflightRequest.query.associatingEntityId,payload:observed});
          else if(targetSpec.kind==='risk_control') await store.call('projectVerifiedReturn',{runId,commandId:spec.commandId,binding,workspaceId:targetSpec.workspace,projectionKind:'relation',relationType:'risk_control',relationKey:targetSpec.key,sourceObjectId:spec.preflightRequest.query.riskId,targetObjectId:spec.preflightRequest.query.controlId,payload:observed});
          else {
            if(!objectId){ const current=await buildReturnPreparation(checkpoint,input.context); const currentRow=current.rows.find((item)=>item.rowKey===rowPlan.rowKey); objectId=targetSpec.objectType==='GRA'&&targetSpec.kind==='object'?currentRow.graId:targetSpec.objectType==='GRA'?currentRow.graId:currentRow.objectId; }
            await store.call('projectVerifiedReturn',{runId,commandId:spec.commandId,binding,workspaceId:targetSpec.workspace,projectionKind:'object',objectType:targetSpec.objectType,objectId,provenance:{rowKey:rowPlan.rowKey,targetKey:targetSpec.key,reconciled:true},payload:observed});
          }
        }
        const remainingFailures=(Array.isArray(checkpoint.execution?.itemFailures)?checkpoint.execution.itemFailures:[])
          .filter((item)=>String(item?.reconcileSpec?.commandId||'')!==String(spec.commandId));
        const nextUncertain=remainingFailures.find((item)=>item?.state==='uncertain'&&item?.reconcileSpec);
        const nextState=manualUnresolved||nextUncertain?'uncertain':'returning';
        await store.call('transitionRun',{runId,expectedRevision:revision,toState:nextState,eventType:applied?'return.reconcile_resolved':manualUnresolved?'return.reconcile_manual_required':'return.reconcile_not_applied',details:{applied,manualUnresolved,remainingUncertain:Boolean(nextUncertain)}});
        await store.call('savePlan',{...checkpoint,execution:{...checkpoint.execution,state:nextUncertain?'uncertain':manualUnresolved?'uncertain':'reconciled',itemFailures:remainingFailures,lastCommandId:spec.commandId,applied,reconcileSpec:manualUnresolved?spec:nextUncertain?.reconcileSpec},updatedAt:new Date().toISOString()});
        const latestAfterReconcile=await store.call('loadLatestRun',{});
        return {surfacePatch:returnSurface(latestAfterReconcile,'')};
      }
      if (input?.actionId === 'confirm-return' || input?.actionId === 'continue-return') {
        const actionLatest=await store.call('loadLatestRun',{});
        const runId = String(input.payload?.runId || actionLatest?.run?.run_id || '');
        const checkpoint = await store.call('loadPlan', runId);
        if (!checkpoint?.returnPlan || !checkpoint?.confirmation) fail('RETURN.PLAN_MISSING', 'The frozen Return plan is unavailable.');
        assertReturnPlanCapabilities(checkpoint.planIr?.rows,checkpoint.returnPlan.rows);
        if(input.actionId==='continue-return'){
          const completionProgress=await store.call('loadReturnProgress',{runId});
          const terminalNoopTargets=new Set(Array.isArray(checkpoint.execution?.terminalNoopTargets)
            ?checkpoint.execution.terminalNoopTargets.map(String):[]);
          const allVerified=completionProgress.length>0&&completionProgress.every((item)=>
            String(item.command_state||'')==='readback_verified'||terminalNoopTargets.has(String(item.target_key||'')));
          if(allVerified){
            await store.call('validateReturnAuthority',{runId,connectorBinding:input.context.connectorBinding,safetyLock:input.context.safetyLock});
            await store.call('recordBootstrapCapabilityEvidence',{
              schemaVersion:'omnia.feature-capability-evidence-bootstrap/v1',runId,...RETURN_CAPABILITY,
              connectorBinding:input.context.connectorBinding,safetyLock:input.context.safetyLock
            });
            await store.call('finishReturn',{runId,outcome:'succeeded'});
            checkpoint.execution={...(checkpoint.execution||{}),state:'completed',partial:false,itemFailures:[],completedAt:new Date().toISOString()};
            await store.call('savePlan',{...checkpoint,updatedAt:new Date().toISOString()});
            const finalizedLatest=await store.call('loadLatestRun',{});
            return{surfacePatch:returnSurface(finalizedLatest,'',checkpoint.execution)};
          }
        }
        // Confirmation still re-reads and freezes the complete batch snapshot.
        // A resumed Return already has that immutable confirmation plus Core's
        // exact binding/safety authority. Repeating every row/relation preflight
        // before each Continue duplicated hundreds of remote reads; every
        // remaining mutation below still performs its own action-time exact
        // preflight and authoritative read-back.
        let executionRows = checkpoint.returnPlan.rows;
        let currentPreflightDigest = checkpoint.preflightDigest;
        if (input.actionId === 'confirm-return') {
          const current = await buildReturnPreparation(checkpoint, input.context);
          assertReturnPlanCapabilities(checkpoint.planIr?.rows,current.rows);
          executionRows = current.rows;
          currentPreflightDigest = digest(Buffer.from(canonical({ authority: current.authority, preflights: current.preflights })));
          if (currentPreflightDigest !== checkpoint.preflightDigest) fail('RETURN.PREFLIGHT_CHANGED', 'Authority, object identity, or GRA preflight changed before confirmation.');
        }
        if(input.actionId==='confirm-return'&&Number(checkpoint.confirmation.stateVersion)!==1) fail('RETURN.CONFIRMATION_VERSION_INVALID','The frozen confirmation state version is invalid.');
        const approved = input.actionId === 'confirm-return' ? await store.call('approveReturnIntent', {
          confirmationId: input.payload?.confirmationId||checkpoint.confirmation.confirmationId, confirmationToken: checkpoint.confirmation.confirmationToken,
          expectedStateVersion: Number(checkpoint.confirmation.stateVersion), connectorBinding: input.context.connectorBinding,
          safetyLock: input.context.safetyLock, preflightDigest: currentPreflightDigest
        }) : (await store.call('validateReturnAuthority', { runId, connectorBinding: input.context.connectorBinding, safetyLock: input.context.safetyLock }), { planDigest: checkpoint.confirmation.planDigest });
        const executeReturn=async()=>{
        const plan = checkpoint.returnPlan; const planDigest = approved.planDigest; const binding = input.context.connectorBinding;
        const targetByKey = new Map(plan.targets.map((item) => [item.key, item]));
        const progressRows = new Map((await store.call('loadReturnProgress', { runId })).map((item) => [item.target_key, item]));
        const terminalNoopTargets=new Set(Array.isArray(checkpoint.execution?.terminalNoopTargets)
          ?checkpoint.execution.terminalNoopTargets.map(String):[]);
        // A verified intent only proves that the immutable desired state was
        // frozen and audited.  It does not prove that a closed-not-applied
        // command reached Omnia.  Keep the command state authoritative here
        // so an explicit Continue can safely retry only after reconcile has
        // proved the prior attempt was not applied.
        const progress = new Map([...progressRows].map(([key,item]) => [
          key,
          item.command_state==='readback_verified'||terminalNoopTargets.has(String(key))
            ? 'verified'
            : String(item.command_state||item.state||'')
        ]));
        // `persistVerifiedTarget` advances this live map after every exact
        // authoritative read-back.  Looking only at the invocation-start
        // `progressRows` snapshot made later stages falsely treat a command
        // completed milliseconds earlier as unfinished, forcing an otherwise
        // healthy Return to pause after each intra-row dependency boundary.
        const done = (key) => progress.get(key) === 'verified';
        const objectIds = new Map(); const graIds = new Map();
        const runtimeKey=(kind,elementId,workspaceId)=>`${kind}|${elementId}|${workspaceId}`.toLocaleLowerCase('en-US');
        const concurrency=Math.max(1,Math.min(RETURN_MAX_CONCURRENCY,RETURN_DEFAULT_CONCURRENCY));
        const reservations=new Map();
        const continueOnIsolatedFailure=plan.executionPolicy?.continueOnIsolatedFailure!==false;
        const isolatedRows=new Map();
        const terminal={outcome:'',error:null,reconcileSpec:null};
        let checkpointSaveTail=Promise.resolve();
        let progressUpdatesSinceSave=0;
        const terminalRank=(outcome)=>outcome==='uncertain'?2:outcome==='failed'?1:0;
        function signalTerminal(error,reconcileSpec=null){
          const normalized=error instanceof Error?error:new Error(String(error||'Return execution failed.'));
          if(reconcileSpec)normalized.returnReconcileSpec=reconcileSpec;
          if(continueOnIsolatedFailure)return normalized;
          const outcome=normalized.code==='RETURN.UNCERTAIN'?'uncertain':'failed';
          if(terminalRank(outcome)>terminalRank(terminal.outcome)){
            terminal.outcome=outcome;terminal.error=normalized;terminal.reconcileSpec=reconcileSpec||null;
          }else if(!terminal.error){terminal.outcome=outcome;terminal.error=normalized;terminal.reconcileSpec=reconcileSpec||null;}
          else if(outcome==='uncertain'&&!terminal.reconcileSpec&&reconcileSpec)terminal.reconcileSpec=reconcileSpec;
          return normalized;
        }
        async function isolateRow(row,error){
          const normalized=error instanceof Error?error:new Error(String(error||'Return item failed.'));
          const state=normalized.code==='RETURN.UNCERTAIN'?'uncertain':'failed';
          const previous=isolatedRows.get(row.rowKey);
          if(previous&&previous.state==='uncertain')return;
          const item={rowKey:row.rowKey,elementId:row.elementId,state,code:String(normalized.code||'RETURN.FAILED'),message:String(normalized.message||normalized),reconcileSpec:normalized.returnReconcileSpec||null};
          isolatedRows.set(row.rowKey,item);
          await saveExecution({state:'running',partial:true,itemFailures:[...isolatedRows.values()]});
        }
        function mergeExecution(execution){
          const state=forceCancelledRuns.has(runId)?'force_cancelled':terminal.outcome||execution.state||checkpoint.execution?.state||'running';
          checkpoint.execution={...(checkpoint.execution||{}),...execution,state,
            ...(terminal.reconcileSpec?{reconcileSpec:terminal.reconcileSpec}:{})};
        }
        async function persistExecutionCheckpoint(){
          checkpointSaveTail=checkpointSaveTail.catch(()=>undefined).then(async()=>{
            await store.call('savePlan',{...checkpoint,updatedAt:new Date().toISOString()});
          });
          progressUpdatesSinceSave=0;
          return checkpointSaveTail;
        }
        async function saveExecution(execution){
          mergeExecution(execution);
          return persistExecutionCheckpoint();
        }
        async function saveProgressExecution(execution){
          mergeExecution(execution);
          progressUpdatesSinceSave+=1;
          // Core's command/evidence/Managed Content ledgers remain durable for
          // every target.  This private 2MB presentation checkpoint is only a
          // resumable progress projection, so persist it once per full worker
          // lane instead of serializing it after every completed target.
          if(progressUpdatesSinceSave>=RETURN_MAX_CONCURRENCY)await persistExecutionCheckpoint();
        }
        async function withReservations(keys,operation){
          const acquired=[];
          for(const key of [...new Set((keys||[]).filter(Boolean))].sort()){
            const previous=reservations.get(key)||Promise.resolve();let release;
            const held=new Promise((resolve)=>{release=resolve;});const tail=previous.then(()=>held);
            reservations.set(key,tail);await previous;acquired.push({key,tail,release});
          }
          try{return await operation();}
          finally{for(const reservation of acquired.reverse()){reservation.release();if(reservations.get(reservation.key)===reservation.tail)reservations.delete(reservation.key);}}
        }
        const rowReservationKeys=(row)=>[
          `object|${row.workspaceId}|${row.objectType}|${row.elementId}`.toLocaleLowerCase('en-US'),
          `gra|${row.workspaceId}|${row.graName}`.toLocaleLowerCase('en-US')
        ];
        async function runCoreDependencyRows(rows,worker){
          const values=Array.isArray(rows)?rows:[];
          const nodes=buildFrozenDependencyGraph(values);
          const byId=new Map(nodes.map((node)=>[node.id,node]));
          const pending=new Set(nodes.map((node)=>node.id));const completed=new Set();const failed=new Set();const active=new Map();
          const start=(node)=>{
            pending.delete(node.id);
            const task=withReservations(rowReservationKeys(node.row),()=>worker(node.row,node.index))
              .then(()=>({id:node.id,error:null}),error=>({id:node.id,error}));
            active.set(node.id,task);
          };
          while(pending.size||active.size){
            if(!terminal.outcome||continueOnIsolatedFailure){
              for(const node of nodes){
                if(active.size>=concurrency)break;
                if(!pending.has(node.id))continue;
                if(isolatedRows.has(node.id)){pending.delete(node.id);failed.add(node.id);continue;}
                if(dependencyBlockedByFailure(node,failed)){pending.delete(node.id);failed.add(node.id);await isolateRow(node.row,Object.assign(new Error('A required frozen-plan dependency did not complete.'),{code:'RETURN.DEPENDENCY_BLOCKED'}));continue;}
                if(!node.dependencies.every((dependency)=>completed.has(dependency)))continue;
                start(node);
              }
            }
            if(!active.size){
              if(!pending.size)break;
              if(terminal.outcome)break;
              fail('RETURN.DEPENDENCY_GRAPH_STALLED',`Return dependency graph cannot make progress: ${[...pending].join(', ')}.`);
            }
            const settled=await Promise.race(active.values());active.delete(settled.id);
            if(settled.error){if(continueOnIsolatedFailure){failed.add(settled.id);await isolateRow(byId.get(settled.id).row,settled.error);}else signalTerminal(settled.error);}else completed.add(settled.id);
            if(terminal.outcome&&active.size){
              const inFlight=await Promise.all(active.values());active.clear();
              for(const result of inFlight){if(result.error)signalTerminal(result.error);else completed.add(result.id);}
            }
          }
          if(terminal.error)throw terminal.error;
        }
        // A row's post-settings work may begin as soon as that row reaches its
        // verified GRA state.  Core dependency completion remains separate from
        // post-settings completion so DB/OS still wait for their exact APP's
        // state transition, while unrelated rows can evaluate and associate in
        // the same bounded window.
        async function runDependencyPipelineRows(rows,coreWorker,postSettingsWorker){
          const values=Array.isArray(rows)?rows:[];
          const nodes=buildFrozenDependencyGraph(values);
          const byId=new Map(nodes.map((node)=>[node.id,node]));
          const pendingCore=new Set(nodes.map((node)=>node.id));const pendingPost=new Set();const completedCore=new Set();const failed=new Set();const active=new Map();
          const start=(node,stage)=>{
            const worker=stage==='core'?coreWorker:postSettingsWorker;
            if(stage==='core')pendingCore.delete(node.id);else pendingPost.delete(node.id);
            const task=withReservations(rowReservationKeys(node.row),()=>worker(node.row,node.index))
              .then(()=>({id:node.id,stage,error:null}),error=>({id:node.id,stage,error}));
            active.set(`${stage}|${node.id}`,task);
          };
          while(pendingCore.size||pendingPost.size||active.size){
            if(!terminal.outcome||continueOnIsolatedFailure){
              while(active.size<concurrency){
                // Post-settings work is queued first: this is the row-level
                // pipeline edge. Existing core work continues in other slots.
                const postNode=nodes.find((node)=>pendingPost.has(node.id)&&!isolatedRows.has(node.id));
                if(postNode){start(postNode,'post');continue;}
                for(const node of nodes.filter((candidate)=>pendingCore.has(candidate.id)&&(isolatedRows.has(candidate.id)||dependencyBlockedByFailure(candidate,failed)))){pendingCore.delete(node.id);failed.add(node.id);if(!isolatedRows.has(node.id))await isolateRow(node.row,Object.assign(new Error('A required frozen-plan dependency did not complete.'),{code:'RETURN.DEPENDENCY_BLOCKED'}));}
                for(const node of nodes.filter((candidate)=>pendingPost.has(candidate.id)&&isolatedRows.has(candidate.id)))pendingPost.delete(node.id);
                const coreNode=nodes.find((node)=>pendingCore.has(node.id)&&node.dependencies.every((dependency)=>completedCore.has(dependency)));
                if(!coreNode)break;
                start(coreNode,'core');
              }
            }
            if(!active.size){
              if(!pendingCore.size&&!pendingPost.size)break;
              if(terminal.outcome)break;
              fail('RETURN.DEPENDENCY_GRAPH_STALLED',`Return dependency pipeline cannot make progress: ${[...pendingCore].join(', ')}.`);
            }
            const settled=await Promise.race(active.values());active.delete(`${settled.stage}|${settled.id}`);
            if(settled.error){if(continueOnIsolatedFailure){failed.add(settled.id);await isolateRow(byId.get(settled.id).row,settled.error);}else signalTerminal(settled.error);}
            else if(settled.stage==='core'){completedCore.add(settled.id);pendingPost.add(settled.id);}
            if(terminal.outcome&&active.size){
              const inFlight=await Promise.all(active.values());active.clear();
              for(const result of inFlight)if(result.error)signalTerminal(result.error);else if(result.stage==='core')completedCore.add(result.id);
            }
          }
          if(terminal.error)throw terminal.error;
        }
        async function commandFor(targetKey,operationId,request,evidenceTargetIdentityKey='') {
          if(forceCancelledRuns.has(runId))fail('RETURN.FORCE_CANCELLED','回传已被用户强制取消；禁止继续准备或调度命令。');
          const targetSpec = targetByKey.get(targetKey); if (!targetSpec) fail('RETURN.INTENT_MISSING', `Frozen target is missing: ${targetKey}`);
          return store.call('prepareReturnCommand', { runId, planDigest, targetKind: targetSpec.kind, targetKey,
            operationId, request, evidenceOperationIds:targetSpec.evidenceOperationIds,
            evidenceTargetIdentityKey:evidenceTargetIdentityKey||targetSpec.operationTargetIdentityKey,binding,workspaceIds:input.context.safetyLock.workspaceIds });
        }
        async function freezeRead(commandId,operationId,readRequest){
          await store.call('freezeReturnEvidenceSpec',{runId,commandId,operationId,request:{connectorBinding:binding,...readRequest}});
        }
        async function evidence(commandId, evidenceType, commandState, payload, verified = false, error = '') {
          return store.call('recordReturnEvidence', { runId, commandId, evidenceType, commandState, payload,
            receiptId: payload?.__operationReceiptId || '', verified, error });
        }
        async function persistVerifiedTarget(targetKey,commandId){
          progress.set(targetKey,'verified');
          await saveProgressExecution({state:'running',background:false,lastVerifiedTargetKey:targetKey,lastCommandId:commandId,verifiedTargets:[...progress.values()].filter((state)=>state==='verified').length});
        }
        async function verifiedMutation(spec) {
          const command = await commandFor(spec.targetKey,spec.mutationOperation,spec.mutationPayload,spec.target.targetIdentityKey);
          let before;
          try {
            // Several execution branches must read the current value to decide
            // whether a write is needed. When that exact read already carried
            // this planDigest it also granted the in-process, target-bound
            // mutation permit. Reuse its result as the command's durable
            // preflight evidence instead of issuing the identical remote read
            // a second time. The signed mutation handler's action-time checks
            // and the post-effect authoritative read-back remain unchanged.
            const receiptBoundCreatePreflight=spec.claimCreateReservation===true;
            if(receiptBoundCreatePreflight)await freezeRead(command.commandId,spec.preflightOperation,{...spec.preflightRequest,planDigest});
            before = spec.preflightResult === undefined
              ? await invoke(spec.preflightOperation, binding, { ...spec.preflightRequest, planDigest,
                ...(receiptBoundCreatePreflight?{receiptContext:{runId,commandId:command.commandId}}:{}) })
              : spec.preflightResult;
            if (spec.acceptPreflight && !spec.acceptPreflight(before)) fail('RETURN.PREFLIGHT_BLOCKED', `Preflight blocked ${spec.targetKey}.`);
            await evidence(command.commandId, 'preflight', 'prepared', before, true);
            if(receiptBoundCreatePreflight)await store.call('bindMutationReservationEvidence',{runId,commandId:command.commandId,
              operationId:spec.preflightOperation,receiptId:String(before?.__operationReceiptId||''),
              evidenceRequest:{connectorBinding:binding,...spec.preflightRequest,planDigest}});
          } catch (error) {
            await evidence(command.commandId, 'preflight', 'failed', { code: error.code || 'RETURN.PREFLIGHT_FAILED', message: error.message }, false, error.message);
            signalTerminal(error);throw error;
          }
          if(spec.raceReadOperation){
            await freezeRead(command.commandId,spec.raceReadOperation,spec.raceReadRequest);
            const raced=await invoke(spec.raceReadOperation,binding,{...spec.raceReadRequest,receiptContext:{runId,commandId:command.commandId}});
            if(spec.raceAlreadyApplied(raced)){
              const readEvidence=await evidence(command.commandId,'reconcile','readback_verified',raced,true);
              await persistVerifiedTarget(spec.targetKey,command.commandId);
              return {command,response:null,observed:raced,readEvidence,closedByRace:true};
            }
          }
          const durableReconcileSpec = { commandId: command.commandId, targetKey: spec.targetKey, target: spec.target,
            preflightOperation: spec.preflightOperation, preflightRequest: spec.preflightRequest,
            reconcileOperation: spec.reconcileOperation||spec.preflightOperation,
            reconcileRequest: spec.reconcileRequest||spec.preflightRequest,
            readOperation: spec.readOperation, readRequest: typeof spec.readRequest === 'function' ? null : spec.readRequest,
            waitForEvaluationComplete:spec.waitForEvaluationComplete===true,
            readbackPolicy:spec.readbackPolicy||null,
            mutationOperation: spec.mutationOperation, commandKind: spec.commandKind, mutationPayload:spec.mutationPayload };
          await store.call('saveReturnReconcileSpec', { runId, commandId: command.commandId, spec: durableReconcileSpec });
          if(forceCancelledRuns.has(runId))fail('RETURN.FORCE_CANCELLED','回传已被用户强制取消；禁止提交尚未开始的远端写入。');
          await evidence(command.commandId, 'request', 'submitted', { operationId: spec.mutationOperation, request: spec.mutationPayload });
          let response;
          try {
            if(forceCancelledRuns.has(runId))fail('RETURN.FORCE_CANCELLED','回传已被用户强制取消；禁止提交尚未开始的远端写入。');
            response = await invoke(spec.mutationOperation, binding, { target: spec.target, planDigest,
              command: { commandId: command.commandId, idempotencyKey: command.idempotencyKey, kind: spec.commandKind, payload: spec.mutationPayload } });
          } catch (error) {
            if (uncertainError(error)) {
              await evidence(command.commandId, 'request', 'uncertain', { operationId: spec.mutationOperation }, false, error.message);
              const uncertain = new Error(error.message); uncertain.code = 'RETURN.UNCERTAIN';
              signalTerminal(uncertain,durableReconcileSpec);await saveExecution({state:'uncertain',reconcileSpec:durableReconcileSpec});throw uncertain;
            }
            await evidence(command.commandId, 'request', 'failed', { operationId: spec.mutationOperation }, false, error.message);
            signalTerminal(error);throw error;
          }
          if(response?.__connectorMutationNotStarted===true){
            const retryCount=Number(spec.notStartedRetryCount||0);
            if(retryCount>=1)fail('RETURN.PRE_EFFECT_RETRY_EXHAUSTED',`Connector rejected ${spec.targetKey} before effect after one safe retry.`);
            return verifiedMutation({...spec,notStartedRetryCount:retryCount+1});
          }
          await evidence(command.commandId, 'commit', 'committed', response, true);
          const query = typeof spec.readRequest === 'function' ? spec.readRequest(response) : spec.readRequest;
          try {
            await freezeRead(command.commandId,spec.readOperation,query);
            const readRequest = { ...query, receiptContext: { runId, commandId: command.commandId } };
            let observed;
            if (spec.waitForEvaluationComplete) observed = await waitForEvaluationComplete(binding, readRequest);
            else {
              const attempts=Math.max(1,Math.min(RETURN_READBACK_MAX_ATTEMPTS,Number(spec.readbackPolicy?.maxAttempts||RETURN_READBACK_MAX_ATTEMPTS)));
              for(let attempt=0;attempt<attempts;attempt+=1){
                observed=await invoke(spec.readOperation,binding,readRequest);
                if(spec.verify(observed,response)||attempt===attempts-1)break;
              }
            }
            if (!spec.verify(observed, response)) fail('RETURN.READBACK_MISMATCH', `Verified read-back failed for ${spec.targetKey}.`);
            const readEvidence = await evidence(command.commandId, 'readback', 'readback_verified', observed, true);
            await persistVerifiedTarget(spec.targetKey,command.commandId);
            return { command, response, observed, readEvidence };
          } catch (error) {
            await evidence(command.commandId, 'reconcile', 'uncertain', { code: error.code || 'RETURN.READBACK_FAILED', message: error.message }, false, error.message);
            const uncertain = new Error(error.message); uncertain.code = 'RETURN.UNCERTAIN';
            signalTerminal(uncertain,durableReconcileSpec);await saveExecution({state:'uncertain',reconcileSpec:durableReconcileSpec});throw uncertain;
          }
        }
        async function waitForReadOnly(operationId,request,label,maxAttempts=RETURN_READBACK_MAX_ATTEMPTS){
          let lastError;
          for(let attempt=0;attempt<Math.max(1,Math.min(RETURN_READBACK_MAX_ATTEMPTS,Number(maxAttempts)));attempt+=1){
            try{return await invoke(operationId,binding,request);}catch(error){lastError=error;}
          }
          if(lastError)throw lastError;
          fail('RETURN.READINESS_UNAVAILABLE',`${label} did not become readable.`);
        }
        async function verifiedExisting(spec) {
          const command = await commandFor(spec.targetKey,spec.mutationOperation,spec.readRequest,spec.readRequest.target.targetIdentityKey);
          await store.call('saveReturnReconcileSpec', { runId, commandId: command.commandId, spec: {
            commandId: command.commandId, targetKey: spec.targetKey, target: spec.readRequest.target,
            preflightOperation: spec.preflightOperation, preflightRequest: spec.preflightRequest,
            reconcileOperation: spec.readOperation, reconcileRequest: spec.readRequest,
            readOperation: spec.readOperation, readRequest: spec.readRequest,
            mutationOperation: spec.mutationOperation, commandKind: 'verify_existing',
            mutationPayload: spec.readRequest, noMutation: true
          } });
          try {
            const before = await invoke(spec.preflightOperation, binding, { ...spec.preflightRequest, planDigest });
            if(spec.acceptPreflight&&!spec.acceptPreflight(before)) fail('RETURN.PREFLIGHT_BLOCKED',`Existing identity preflight blocked ${spec.targetKey}.`);
            await evidence(command.commandId, 'preflight', 'prepared', before, true);
            await freezeRead(command.commandId,spec.readOperation,spec.readRequest);
            const observed = await invoke(spec.readOperation, binding, { ...spec.readRequest, receiptContext: { runId, commandId: command.commandId } });
            if (!spec.verify(observed)) fail('RETURN.READBACK_MISMATCH', `Existing read-back failed for ${spec.targetKey}.`);
            await evidence(command.commandId, 'readback', 'readback_verified', observed, true);
            await persistVerifiedTarget(spec.targetKey,command.commandId);
            return { command, observed };
          } catch (error) {
            await evidence(command.commandId, 'preflight', 'failed', { code: error.code || 'RETURN.EXISTING_READ_FAILED', message: error.message }, false, error.message);
            signalTerminal(error);throw error;
          }
        }
        async function closeVerified(targetKey, mutationOperation, readOperation, readRequest, verify) {
          const command = await commandFor(targetKey,mutationOperation,readRequest,readRequest.target.targetIdentityKey);
          await store.call('saveReturnReconcileSpec', { runId, commandId: command.commandId, spec: {
            commandId: command.commandId, targetKey, target: readRequest.target,
            reconcileOperation: readOperation, reconcileRequest: readRequest,
            readOperation, readRequest, mutationOperation, commandKind: 'verify_existing',
            mutationPayload: readRequest, noMutation: true
          } });
          await freezeRead(command.commandId,readOperation,readRequest);
          const observed = await invoke(readOperation, binding, { ...readRequest, receiptContext: { runId, commandId: command.commandId } });
          if (!verify(observed)) fail('RETURN.READBACK_MISMATCH', `Existing authoritative read-back failed for ${targetKey}.`);
          await evidence(command.commandId, 'reconcile', 'readback_verified', observed, true);
          await persistVerifiedTarget(targetKey,command.commandId);
          return { command, observed };
        }
        async function projectObject(result, row, targetKey, objectTypeValue, objectId) {
          await store.call('projectVerifiedReturn', { runId, commandId: result.command.commandId, binding,
            workspaceId: row.workspaceId, projectionKind: 'object', objectType: objectTypeValue, objectId,
            provenance: { rowKey: row.rowKey, targetKey }, payload: result.observed });
        }
        async function projectGraRevision(result, row, targetKey, graId) {
          await store.call('projectVerifiedReturn', { runId, commandId: result.command.commandId, binding,
            workspaceId: row.workspaceId, projectionKind: 'object', objectType: 'GRA', objectId: graId,
            provenance: { rowKey: row.rowKey, targetKey }, payload: result.observed });
        }
        try {
          const ordered = [...executionRows];
          const executionModes = new Map();
          await runCoreDependencyRows(ordered,async(row)=>{
            let objectId = row.objectId;
            let objectResult;
            if (done(`object|${row.rowKey}`)) {
              if (!objectId) fail('RETURN.RESUME_OBJECT_MISSING', `Verified object ${row.elementId} is absent during continuation.`);
            } else if (objectId) {
              const frozenOwnership=row.identityResolution?.ownership;
              const proof=await store.call('proveOwnedCreatedObject',{objectId,workspaceId:row.workspaceId,externalId:row.elementId,expectedObjectType:row.objectType,connectorBinding:binding});
              if(proof?.proven!==true||proof.runId!==frozenOwnership?.runId||proof.commandId!==frozenOwnership?.commandId||proof.objectId!==frozenOwnership?.objectId||proof.objectType!==frozenOwnership?.objectType)fail('RETURN.OBJECT_OWNERSHIP_DRIFT',`${row.kind} ${row.elementId} owned-create proof changed after plan freeze.`);
              objectResult = await verifiedExisting({ targetKey: `object|${row.rowKey}`, mutationOperation: RETURN_OPERATIONS.objectCreate,
                preflightOperation: row.kind==='APP'?RETURN_OPERATIONS.objectIdentityResolve:RETURN_OPERATIONS.objectPreflight, preflightRequest: { target: row.objectTarget, query: row.objectQuery },
                acceptPreflight:row.kind==='APP'?(observed)=>{const identity=inspectApplicationIdentity(observed,{target:row.objectTarget,query:row.objectQuery});return identity.accepted&&identity.disposition===row.identityDisposition&&identity.objectId===objectId;}
                  :(observed)=>{const identity=inspectGenericIdentity(observed,{target:row.objectTarget,query:row.objectQuery});return row.identityDisposition==='resume'&&identity.accepted&&identity.state==='active'&&identity.objectId===objectId;},
                readOperation: RETURN_OPERATIONS.objectRead, readRequest: { target: row.objectTarget, objectId, query:{externalId:row.elementId,objectType:row.objectType,...(row.objectType==='Application'?{description:descriptionEditorJson(row.description)}:{subtypeId:row.subtypeId})} }, verify: (value) => responseId(value, 'IT Element read-back') === objectId });
            }
            else {
              const description=descriptionEditorJson(row.description);
              const payload = { name: row.elementId, workspaceId: row.workspaceId, engagementId: binding.engagementId,
                number: row.elementId, itElementType: row.objectType,
                ...(row.objectType==='Application'||row.objectType==='Infrastructure'?{description}:{}),
                ...(row.objectType==='Infrastructure'||row.objectType==='ITTool'?{typeId:row.subtypeId}:{}) };
              objectResult = await verifiedMutation({ targetKey: `object|${row.rowKey}`, target: row.objectTarget,
                preflightOperation: RETURN_OPERATIONS.objectCreatePreflight, preflightRequest: { target: row.objectTarget, query: row.objectQuery },
                claimCreateReservation:true,
                acceptPreflight:(observed)=>completeObjectCreateAbsence(observed,row.objectType),
                reconcileOperation:RETURN_OPERATIONS.objectIdentityResolve,reconcileRequest:{target:row.objectTarget,query:row.objectQuery},
                mutationOperation: RETURN_OPERATIONS.objectCreate, mutationPayload: payload, commandKind: 'create_object',
                readOperation: RETURN_OPERATIONS.objectRead, readRequest: (response) => ({ target: row.objectTarget, objectId: responseId(response, 'created IT Element'),query:{externalId:row.elementId,objectType:row.objectType,...(row.objectType==='Application'?{description}:{subtypeId:row.subtypeId})} }),
                verify: (value, response) => responseId(value, 'IT Element read-back') === responseId(response, 'created IT Element') });
              objectId = responseId(objectResult.response, 'created IT Element');
            }
            objectIds.set(runtimeKey(row.kind,row.elementId,row.workspaceId), objectId);
            if (objectResult) await projectObject(objectResult, row, `object|${row.rowKey}`, row.objectType, objectId);
            if(hasFrozenStage(row,'settings')&&!done(`object-settings|${row.rowKey}`)){
              const settingsKey=`object-settings|${row.rowKey}`; const settingsTarget={targetIdentityKey:targetByKey.get(settingsKey).operationTargetIdentityKey,workspaceId:row.workspaceId};
              const settingsIntent=targetByKey.get(settingsKey);if(!settingsIntent)fail('RETURN.INTENT_MISSING',`Frozen APP settings target is missing: ${settingsKey}`);
              const before=await invoke(RETURN_OPERATIONS.objectSettingsPreflight,binding,{target:settingsTarget,objectId,planDigest});
              const settingsIdentityDisposition=row.identityDisposition==='resume'&&settingsIntent.mode==='create_bootstrap'?'create':row.identityDisposition;
              const allowedSettingsModes=settingsIdentityDisposition==='create'?['create_bootstrap']:settingsIdentityDisposition==='reuse'?['existing_with_token']:settingsIdentityDisposition==='resume'?['existing_with_token','recover_owned_create_bootstrap']:[];
              if(!allowedSettingsModes.includes(settingsIntent.mode))fail('RETURN.OBJECT_SETTINGS_MODE_DRIFT',`APP ${row.elementId} settings mode differs from the frozen identity disposition.`);
              const beforeToken=latestApplicationSettingsToken(before,settingsIntent.mode==='existing_with_token',`APP ${row.elementId} settings execution preflight`);
              if(['create_bootstrap','recover_owned_create_bootstrap'].includes(settingsIntent.mode)&&beforeToken)fail('RETURN.OBJECT_SETTINGS_MODE_DRIFT',`APP ${row.elementId} bootstrap mode cannot consume a pre-existing concurrency token.`);
              if(settingsIntent.mode==='recover_owned_create_bootstrap'){
                if(!unsetApplicationSettings(before)||!exactApplicationSettingsIdentity(before,objectId,row.elementId))fail('RETURN.OBJECT_SETTINGS_AUTHORITY_DRIFT',`APP ${row.elementId} is no longer an exact empty owned-create recovery candidate.`);
                const proof=await store.call('proveOwnedCreatedObject',{objectId,workspaceId:row.workspaceId,externalId:row.elementId,expectedObjectType:'Application',connectorBinding:binding});
                if(proof?.proven!==true||proof.runId!==settingsIntent.ownedCreateProof?.runId||proof.commandId!==settingsIntent.ownedCreateProof?.commandId)fail('RETURN.OBJECT_SETTINGS_OWNERSHIP_DRIFT',`APP ${row.elementId} owned-create proof changed after plan freeze.`);
              }
              const desiredData=resolveFrozenAppDataAvailability(settingsIdentityDisposition,before,{disposition:settingsIntent.dataAvailabilityDisposition,value:settingsIntent.isDataAvailable});
              if(typeof desiredData!=='boolean') fail('RETURN.OBJECT_SETTINGS_AUTHORITY_MISSING',`APP ${row.elementId} settings lack exact data-availability authority.`);
              const query={objectId,typeId:row.content.itElementTypeId,isRelevant:row.isRelevant,isDataAvailable:desiredData,number:row.elementId,mode:settingsIntent.mode};
              const settingsResult=settingsIntent.mode==='existing_with_token'&&String(before.typeId)===String(query.typeId)&&before.isRelevant===row.isRelevant&&before.isDataAvailable===desiredData&&String(before.number||before.referenceNumber)===row.elementId
                ? await closeVerified(settingsKey,RETURN_OPERATIONS.objectSettingsWrite,RETURN_OPERATIONS.objectSettingsRead,{target:settingsTarget,query},(observed)=>observed.verified===true)
                : await verifiedMutation({targetKey:settingsKey,target:settingsTarget,preflightOperation:RETURN_OPERATIONS.objectSettingsPreflight,preflightRequest:{target:settingsTarget,objectId},preflightResult:before,mutationOperation:RETURN_OPERATIONS.objectSettingsWrite,commandKind:'patch_object_settings',mutationPayload:{engagementId:binding.engagementId,workspaceId:row.workspaceId,objectId,typeId:row.content.itElementTypeId,isRelevant:row.isRelevant,isDataAvailable:desiredData,mode:settingsIntent.mode},readOperation:RETURN_OPERATIONS.objectSettingsRead,readRequest:{target:settingsTarget,query},verify:(observed)=>observed.verified===true});
              await projectObject(settingsResult,row,settingsKey,row.objectType,objectId);
            }
            // Ordering is intentional: a relation-capable object must be linked to
            // each exact in-batch or current-Pack Application and verified from both
            // directions before its GRA is created. The later relation pass sees the committed target
            // and remains a no-op for resume compatibility.
            if(hasFrozenStage(row,'relation')&&row.relations.length){
              const relationType=String(row.relationPolicy?.relationType||'');const relationConcurrencyTabId=Number(row.relationPolicy?.concurrencyTabId||0);
              for(const appExternalId of row.relations){
                const targetKey=`element-relation|${row.rowKey}|${appExternalId}`;
                const relationIntent=targetByKey.get(targetKey);const dependencyRowKey=relationIntent?.targetDependencyRowKey;
                if(!relationIntent||!['in_batch','external'].includes(relationIntent.targetSourceType))fail('RETURN.INTENT_MISSING',`Frozen relation target is missing: ${targetKey}`);
                const targetKind=String(row.relationPolicy?.targetKind||'');
                const appRows=relationIntent?.targetSourceType==='in_batch'?ordered.filter((item)=>item.kind===targetKind&&item.rowKey===dependencyRowKey&&item.workspaceId===relationIntent.targetWorkspace&&item.elementId.normalize('NFKC').toLocaleLowerCase('en-US')===String(appExternalId).normalize('NFKC').toLocaleLowerCase('en-US')):[];
                if(relationIntent?.targetSourceType==='in_batch'&&appRows.length!==1) fail('RETURN.RELATION_TARGET_UNVERIFIED',`Application ${appExternalId} does not resolve to one exact in-batch object.`);
                const appId=relationIntent?.targetSourceType==='external'?normalizedGuid(relationIntent.resolvedTargetObjectId):objectIds.get(runtimeKey(targetKind,appRows[0].elementId,appRows[0].workspaceId));
                if(!appId) fail('RETURN.RELATION_TARGET_UNVERIFIED',`Application ${appExternalId} is not a verified exact object.`);
                if(done(targetKey)) continue;
                const targetWorkspaceId=String(relationIntent.targetWorkspace||'');
                const target={targetIdentityKey:`relation|${row.workspaceId}|${targetWorkspaceId}|${objectId}|${appId}|${relationType}`,workspaceId:row.workspaceId};
                const query={associationType:relationType,itElementId:objectId,associatingEntityId:appId,sourceWorkspaceId:row.workspaceId,targetWorkspaceId};
                const before=await invoke(RETURN_OPERATIONS.relationPreflight,binding,{target,query,planDigest});
                const relationResult=before.associated===true&&before.inconsistent===false
                  ?await closeVerified(targetKey,RETURN_OPERATIONS.relationWrite,RETURN_OPERATIONS.relationRead,{target,query},(observed)=>observed.associated===true&&observed.inconsistent===false)
                  :await verifiedMutation({targetKey,target,preflightOperation:RETURN_OPERATIONS.relationPreflight,preflightRequest:{target,query},preflightResult:before,mutationOperation:RETURN_OPERATIONS.relationWrite,commandKind:'associate_relation',acceptPreflight:(observed)=>observed.associated===false&&observed.inconsistent===false,mutationPayload:{ItElementId:objectId,AssociatingEntityIds:[appId],associationType:relationType,ConcurrencyTabId:relationConcurrencyTabId,workspaceId:row.workspaceId,engagementId:binding.engagementId},readOperation:RETURN_OPERATIONS.relationRead,readRequest:{target,query},verify:(observed)=>observed.associated===true&&observed.inconsistent===false});
                await store.call('projectVerifiedReturn',{runId,commandId:relationResult.command.commandId,binding,workspaceId:row.workspaceId,projectionKind:'relation',relationType,relationKey:targetKey,sourceObjectId:objectId,targetObjectId:appId,payload:relationResult.observed});
              }
            }
            const graTarget = { targetIdentityKey: targetByKey.get(`gra|${row.rowKey}`).operationTargetIdentityKey, workspaceId: row.workspaceId };
            let graId = row.graId; let graResult;
            const graPreflightRequest = { target: graTarget, query: { entityId: objectId, itElementType: row.objectType, name: row.graName, workspaceId: row.workspaceId } };
            if (done(`gra|${row.rowKey}`)) {
              if (!graId) fail('RETURN.RESUME_GRA_MISSING', `Verified GRA ${row.elementId} is absent during continuation.`);
            } else if (graId) graResult = await verifiedExisting({ targetKey: `gra|${row.rowKey}`, mutationOperation: RETURN_OPERATIONS.graCreate,
              preflightOperation: RETURN_OPERATIONS.graPreflight, preflightRequest: graPreflightRequest, readOperation: RETURN_OPERATIONS.graRead,
              readRequest: { target: graTarget, riskAssessmentId: graId,query:{entityId:objectId,name:row.graName,itElementType:row.objectType,inkContentId:row.content.inkContentId,typeId:row.content.typeId} }, verify: (value) => responseId(value, 'GRA read-back') === graId });
            else graResult = await verifiedMutation({ targetKey: `gra|${row.rowKey}`, target: graTarget,
              preflightOperation: RETURN_OPERATIONS.graPreflight, preflightRequest: graPreflightRequest,
              claimCreateReservation:true,
              acceptPreflight:completeGraCreateAbsence,
              mutationOperation: RETURN_OPERATIONS.graCreate, commandKind: 'create_gra', mutationPayload: {
                inkContentId: row.content.inkContentId, typeId: row.content.typeId, facetId: row.workspaceId,
                entityId: objectId, name: row.graName, engagementId: binding.engagementId
              }, readOperation: RETURN_OPERATIONS.graRead,
              readRequest: (response) => ({ target: graTarget, riskAssessmentId: responseId(response, 'created GRA'),query:{entityId:objectId,name:row.graName,itElementType:row.objectType,inkContentId:row.content.inkContentId,typeId:row.content.typeId} }),
              verify: (value, response) => responseId(value, 'GRA read-back') === responseId(response, 'created GRA') });
            graId = graId || responseId(graResult.response, 'created GRA'); graIds.set(runtimeKey(row.kind,row.elementId,row.workspaceId), graId);
            if (graResult) await projectObject(graResult, row, `gra|${row.rowKey}`, 'GRA', graId);
          });
          await runDependencyPipelineRows(ordered,async(row)=>{
            const objectId = objectIds.get(runtimeKey(row.kind,row.elementId,row.workspaceId)); const graId = graIds.get(runtimeKey(row.kind,row.elementId,row.workspaceId));
            let mode = row.mode;
            const statePatches = hasFrozenStage(row,'gra_state') ? [['status','EvaluationStarted'], ['rait',mode]] : [['status','EvaluationStarted']];
            for (const [patchKind, value] of statePatches) {
              const targetKey = `gra-${patchKind === 'status' ? 'status' : 'rait'}|${row.rowKey}`;
              if (done(targetKey)) continue;
              const target = { targetIdentityKey: targetByKey.get(targetKey).operationTargetIdentityKey, workspaceId: row.workspaceId };
              const before = await invoke(RETURN_OPERATIONS.graStatePreflight, binding, { target, riskAssessmentId: graId, planDigest });
              const currentValue = patchKind === 'status' ? before.status : before.itElementRaitConclusionLevelId || before.itElementRaitConclusionLevelName;
              const stateResult = String(currentValue) === String(value)
                ? await closeVerified(targetKey,RETURN_OPERATIONS.graStateWrite,RETURN_OPERATIONS.graStateRead,{target,query:{riskAssessmentId:graId,patchKind,value}},(observed)=>observed.verified===true)
                : await verifiedMutation({ targetKey, target, preflightOperation: RETURN_OPERATIONS.graStatePreflight, preflightResult: before,
                  preflightRequest: { target, riskAssessmentId: graId }, mutationOperation: RETURN_OPERATIONS.graStateWrite,
                  commandKind: 'patch_gra_state', mutationPayload: { engagementId: binding.engagementId, workspaceId: row.workspaceId, riskAssessmentId: graId, patchKind, value },
                  readOperation: RETURN_OPERATIONS.graStateRead, readRequest: { target, query: { riskAssessmentId: graId, patchKind, value } }, verify: (observed) => observed.verified === true });
              await projectGraRevision(stateResult, row, targetKey, graId);
            }
            const relationType=String(row.relationPolicy?.relationType||'');const relationConcurrencyTabId=Number(row.relationPolicy?.concurrencyTabId||0);
            for (const appExternalId of row.relations) {
              const targetKey = `element-relation|${row.rowKey}|${appExternalId}`;
              const relationIntent=targetByKey.get(targetKey);const dependencyRowKey=relationIntent?.targetDependencyRowKey;
              if(!relationIntent||!['in_batch','external'].includes(relationIntent.targetSourceType))fail('RETURN.INTENT_MISSING',`Frozen relation target is missing: ${targetKey}`);
              const targetKind=String(row.relationPolicy?.targetKind||'');
              const appRows=relationIntent?.targetSourceType==='in_batch'?ordered.filter((item)=>item.kind===targetKind&&item.rowKey===dependencyRowKey&&item.workspaceId===relationIntent.targetWorkspace&&item.elementId.normalize('NFKC').toLocaleLowerCase('en-US')===String(appExternalId).normalize('NFKC').toLocaleLowerCase('en-US')):[];
              if(relationIntent?.targetSourceType==='in_batch'&&appRows.length!==1) fail('RETURN.RELATION_TARGET_UNVERIFIED', `Application ${appExternalId} does not resolve to one exact in-batch object.`);
              const appId=relationIntent?.targetSourceType==='external'?normalizedGuid(relationIntent.resolvedTargetObjectId):objectIds.get(runtimeKey(targetKind,appRows[0].elementId,appRows[0].workspaceId));
              if (!appId) fail('RETURN.RELATION_TARGET_UNVERIFIED', `Application ${appExternalId} is not a verified exact object.`);
              if (done(targetKey)) continue;
              const targetWorkspaceId=String(relationIntent.targetWorkspace||'');
              const target = { targetIdentityKey:`relation|${row.workspaceId}|${targetWorkspaceId}|${objectId}|${appId}|${relationType}`, workspaceId: row.workspaceId };
              const query = { associationType: relationType, itElementId: objectId, associatingEntityId: appId, sourceWorkspaceId: row.workspaceId, targetWorkspaceId };
              const relationBefore = await invoke(RETURN_OPERATIONS.relationPreflight, binding, { target, query, planDigest });
              const result = relationBefore.associated === true && relationBefore.inconsistent === false
                ? await closeVerified(targetKey,RETURN_OPERATIONS.relationWrite,RETURN_OPERATIONS.relationRead,{target,query},(observed)=>observed.associated===true&&observed.inconsistent===false)
                : await verifiedMutation({ targetKey, target, preflightOperation: RETURN_OPERATIONS.relationPreflight, preflightResult: relationBefore,
                preflightRequest: { target, query }, mutationOperation: RETURN_OPERATIONS.relationWrite, commandKind: 'associate_relation',
                acceptPreflight:(observed)=>observed.associated===false&&observed.inconsistent===false,
                mutationPayload: { ItElementId: objectId, AssociatingEntityIds: [appId], associationType: relationType, ConcurrencyTabId: relationConcurrencyTabId, workspaceId: row.workspaceId, engagementId: binding.engagementId },
                readOperation: RETURN_OPERATIONS.relationRead, readRequest: { target, query }, verify: (observed) => observed.associated === true && observed.inconsistent === false });
              await store.call('projectVerifiedReturn', { runId, commandId: result.command.commandId, binding, workspaceId: row.workspaceId,
                projectionKind: 'relation', relationType, relationKey: targetKey,
                sourceObjectId: objectId, targetObjectId: appId, payload: result.observed });
            }
            if(hasFrozenStage(row,'inherited_rait')){
              for(const source of row.inheritanceSources){ const appRow=source.sourceType==='in_batch'?ordered.find((item)=>item.kind==='APP'&&item.rowKey===source.rowKey&&item.elementId.normalize('NFKC')===source.externalId.normalize('NFKC')&&item.workspaceName.normalize('NFKC')===source.workspaceName.normalize('NFKC')):null;
              if(source.sourceType==='in_batch'&&!appRow) fail('RETURN.RAIT_INHERITANCE_DRIFT',`${row.kind} ${row.elementId} inheritance source disappeared.`);
              const appGraId=source.sourceType==='external'?normalizedGuid(source.riskAssessmentId):graIds.get(runtimeKey('APP',appRow.elementId,appRow.workspaceId)); const sourceKey=source.sourceKey;
              const sourceIntent=targetByKey.get(sourceKey);if(!sourceIntent||!appGraId)fail('RETURN.RAIT_INHERITANCE_DRIFT',`${row.kind} ${row.elementId} inheritance source identity is incomplete.`);
              const sourceTarget={targetIdentityKey:sourceIntent.operationTargetIdentityKey,workspaceId:source.workspaceId};
              const sourceBefore=await invoke(RETURN_OPERATIONS.graStatePreflight,binding,{target:sourceTarget,riskAssessmentId:appGraId});
              const liveInheritedMode=normalizeRait(sourceBefore.itElementRaitConclusionLevelId||sourceBefore.itElementRaitConclusionLevelName);
              if(!['Higher','Lower'].includes(liveInheritedMode)||liveInheritedMode!==normalizeRait(source.plannedMode)) fail('RETURN.RAIT_INHERITANCE_DRIFT',`${row.kind} ${row.elementId} live APP GRA RAIT differs from the frozen APP plan.`);
              if(!done(sourceKey)){
                const sourceResult=await closeVerified(sourceKey,RETURN_OPERATIONS.graStateWrite,RETURN_OPERATIONS.graStateRead,{target:sourceTarget,query:{riskAssessmentId:appGraId,patchKind:'rait',value:liveInheritedMode}},(observed)=>observed.verified===true);
                if(appRow)await projectGraRevision(sourceResult,appRow,sourceKey,appGraId);
              }
              mode=row.mode;
              const targetKey=`gra-rait|${row.rowKey}`;
              if(!done(targetKey)){
                const target={targetIdentityKey:targetByKey.get(targetKey).operationTargetIdentityKey,workspaceId:row.workspaceId}; const before=await invoke(RETURN_OPERATIONS.graStatePreflight,binding,{target,riskAssessmentId:graId,planDigest}); const currentValue=before.itElementRaitConclusionLevelId||before.itElementRaitConclusionLevelName;
                const stateResult=String(currentValue)===String(mode)?await closeVerified(targetKey,RETURN_OPERATIONS.graStateWrite,RETURN_OPERATIONS.graStateRead,{target,query:{riskAssessmentId:graId,patchKind:'rait',value:mode}},(observed)=>observed.verified===true):await verifiedMutation({targetKey,target,preflightOperation:RETURN_OPERATIONS.graStatePreflight,preflightRequest:{target,riskAssessmentId:graId},preflightResult:before,mutationOperation:RETURN_OPERATIONS.graStateWrite,commandKind:'patch_gra_state',mutationPayload:{engagementId:binding.engagementId,workspaceId:row.workspaceId,riskAssessmentId:graId,patchKind:'rait',value:mode},readOperation:RETURN_OPERATIONS.graStateRead,readRequest:{target,query:{riskAssessmentId:graId,patchKind:'rait',value:mode}},verify:(observed)=>observed.verified===true});
                await projectGraRevision(stateResult,row,targetKey,graId);
              }
              }
            }
            if(hasFrozenStage(row,'app_category')){
              const categoryKey=`risk-factor-category|${row.rowKey}`;
              if(!done(categoryKey)){
                const categoryIntent=targetByKey.get(categoryKey);
                const target={targetIdentityKey:categoryIntent.operationTargetIdentityKey,workspaceId:row.workspaceId};
                const preflightRequest={target,query:{riskAssessmentId:graId,categoryId:categoryIntent.resolvedCategory?.categoryId||'',categoryName:categoryIntent.categoryName,objectType:'Application'}};
                const before=await invoke(RETURN_OPERATIONS.riskFactorCategoryPreflight,binding,{...preflightRequest,planDigest});
                const categoryId=String(categoryIntent.resolvedCategory?.categoryId||before.categoryId||'');
                if(!categoryId||categoryId!==String(before.categoryId||''))fail('RETURN.RISK_FACTOR_CATEGORY_IDENTITY_DRIFT',`APP ${row.elementId} IT Risk Factor category identity changed after confirmation.`);
                const readRequest={target,query:{riskAssessmentId:graId,categoryId,categoryName:categoryIntent.categoryName,objectType:'Application'}};
                const categoryResult=before.applicable===true
                  ?await closeVerified(categoryKey,RETURN_OPERATIONS.riskFactorCategoryWrite,RETURN_OPERATIONS.riskFactorCategoryRead,readRequest,(observed)=>observed.verified===true)
                  :await verifiedMutation({targetKey:categoryKey,target,preflightOperation:RETURN_OPERATIONS.riskFactorCategoryPreflight,preflightRequest,preflightResult:before,
                    mutationOperation:RETURN_OPERATIONS.riskFactorCategoryWrite,commandKind:'enable_app_it_risk_assessment_category',
                    mutationPayload:{engagementId:binding.engagementId,workspaceId:row.workspaceId,riskAssessmentId:graId,categoryId,categoryName:categoryIntent.categoryName,objectType:'Application'},
                    readOperation:RETURN_OPERATIONS.riskFactorCategoryRead,readRequest,verify:(observed)=>observed.verified===true});
                await projectGraRevision(categoryResult,row,categoryKey,graId);
              }
            }
            executionModes.set(row.rowKey, mode);
          },async(row)=>{
            {
            // v4 keeps a single GRA's factors and documentation serial.  The
            // pipeline only removes the cross-row barrier before evaluation.
            const mode=executionModes.get(row.rowKey)||row.mode;
            const graId=graIds.get(runtimeKey(row.kind,row.elementId,row.workspaceId));
            if (hasFrozenStage(row,'app_scoring')) {
              const categoryKey=`risk-factor-category|${row.rowKey}`;
              if(!done(categoryKey))fail('RETURN.RISK_FACTOR_CATEGORY_NOT_VERIFIED',`APP ${row.elementId} scoring cannot start before its IT Risk Factor category is verified applicable.`);
              const factorIntents=plan.targets.filter((item)=>item.rowKey===row.rowKey&&String(item.key).startsWith('risk-factor|'));
              if(!factorIntents.length)fail('RETURN.SCORING_GOVERNANCE_MISSING',`APP ${row.elementId} has no frozen governed Risk Factor scoring intents.`);
              const readinessIntent=factorIntents.find((item)=>!done(item.key));
              let readinessPreflight=null;
              if(readinessIntent){
                const readinessTarget={targetIdentityKey:readinessIntent.operationTargetIdentityKey,workspaceId:row.workspaceId};
                const readinessQuery={riskAssessmentId:graId,itemId:readinessIntent.fieldId,itemLabel:readinessIntent.itemLabel,selectionMode:mode,contentName:readinessIntent.contentName};
                readinessPreflight=await waitForReadOnly(RETURN_OPERATIONS.factorPreflight,{target:readinessTarget,query:readinessQuery,planDigest},`APP ${row.elementId} scoring interface`);
              }
              await runBoundedIndependent(factorIntents, RETURN_WITHIN_GRA_CONCURRENCY, async (factorIntent) => {
                const targetKey = factorIntent.key;
                if (done(targetKey)) return;
                const target = { targetIdentityKey: factorIntent.operationTargetIdentityKey, workspaceId: row.workspaceId };
                const factorQuery={riskAssessmentId:graId,itemId:factorIntent.fieldId,itemLabel:factorIntent.itemLabel,selectionMode:mode,contentName:factorIntent.contentName};
                const factorPreflight = readinessIntent?.key===factorIntent.key&&readinessPreflight
                  ?readinessPreflight
                  :await invoke(RETURN_OPERATIONS.factorPreflight, binding, { target, query: factorQuery, planDigest });
                if (factorPreflight.applicable === false) {
                  const preflightRequest={target,query:factorQuery};
                  const command = await commandFor(targetKey,RETURN_OPERATIONS.factorWrite,preflightRequest,target.targetIdentityKey);
                  await freezeRead(command.commandId,RETURN_OPERATIONS.factorPreflight,preflightRequest);
                  const observed=await invoke(RETURN_OPERATIONS.factorPreflight,binding,{...preflightRequest,receiptContext:{runId,commandId:command.commandId}});
                  if(observed.applicable!==false) fail('RETURN.FACTOR_APPLICABILITY_DRIFT',`Risk Factor ${factorIntent.fieldId} applicability changed during authoritative closure.`);
                  await evidence(command.commandId,'reconcile','closed_not_applied',observed,true);
                  // A Pack-authoritative `applicable:false` is a terminal no-op,
                  // not a failed mutation. Persist that Feature-owned business
                  // conclusion so Continue can finish without reissuing the
                  // same closure. Connector remains a generic envelope host.
                  terminalNoopTargets.add(targetKey);
                  progress.set(targetKey,'verified');
                  await saveProgressExecution({terminalNoopTargets:[...terminalNoopTargets].sort()});
                  return;
                }
                const selectedValue = Number(factorPreflight.selected?.value); const currentValue = Number(factorPreflight.current?.value ?? factorPreflight.current);
                const factorReadRequest={target,query:factorQuery};
                const frozenFactor=targetByKey.get(targetKey).resolvedFactor;
                const liveFactor={factorId:factorPreflight.factorId,selectedValue:factorPreflight.selected?.value,spectrumDigest:digest(Buffer.from(canonical(factorPreflight.spectrum||[])))};
                if(frozenFactor&&(String(frozenFactor.factorId)!==String(liveFactor.factorId)||Number(frozenFactor.selectedValue)!==Number(liveFactor.selectedValue)||String(frozenFactor.spectrumDigest)!==String(liveFactor.spectrumDigest))) fail('RETURN.FACTOR_SPECTRUM_DRIFT',`Risk Factor ${factorIntent.fieldId} live spectrum changed after confirmation.`);
                const exactFactor=frozenFactor||liveFactor;
                const factorResult = selectedValue === currentValue ? await closeVerified(targetKey,RETURN_OPERATIONS.factorWrite,RETURN_OPERATIONS.factorRead,factorReadRequest,(observed)=>observed.verified===true) : await verifiedMutation({ targetKey, target, preflightOperation: RETURN_OPERATIONS.factorPreflight, preflightResult: factorPreflight,
                  preflightRequest: { target, query: factorQuery },
                  mutationOperation:RETURN_OPERATIONS.factorWrite,commandKind:'patch_risk_factor',mutationPayload:{engagementId:binding.engagementId,workspaceId:row.workspaceId,riskAssessmentId:graId,itemId:factorIntent.fieldId,itemLabel:factorIntent.itemLabel,selectionMode:mode,contentName:factorIntent.contentName,
                    factorId:exactFactor.factorId,selectedValue:exactFactor.selectedValue,spectrumDigest:exactFactor.spectrumDigest},
                  readOperation: RETURN_OPERATIONS.factorRead, readRequest: { target, query: factorQuery }, verify: (observed) => observed.verified === true });
                await projectGraRevision(factorResult, row, targetKey, graId);
              });
              const docKey = `documentation|${row.rowKey}`; const docIntent = targetByKey.get(docKey);
              if (docIntent && !done(docKey)) {
                const target = { targetIdentityKey: docIntent.operationTargetIdentityKey, workspaceId: row.workspaceId };
                const plainText = docIntent.plainText; const editorData = `<p>${plainText.replace(/[&<>]/gu, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[char]))}</p>`;
                const currentDoc = await invoke(RETURN_OPERATIONS.documentationPreflight, binding, { target, riskAssessmentId: graId, planDigest });
                const observedDoc = observedDocumentation(currentDoc);
                const docResult = String(observedDoc?.editorData || '') === editorData && String(observedDoc?.plainText || '') === plainText
                  ? await closeVerified(docKey,RETURN_OPERATIONS.documentationWrite,RETURN_OPERATIONS.documentationRead,{target,query:{riskAssessmentId:graId,editorData,plainText}},(observed)=>observed.verified===true)
                  : await verifiedMutation({ targetKey: docKey, target, preflightOperation: RETURN_OPERATIONS.documentationPreflight, preflightResult: currentDoc,
                  preflightRequest: { target, riskAssessmentId: graId }, mutationOperation: RETURN_OPERATIONS.documentationWrite, commandKind: 'patch_documentation',
                  mutationPayload: { engagementId: binding.engagementId, workspaceId: row.workspaceId, riskAssessmentId: graId, editorData, plainText },
                  readOperation: RETURN_OPERATIONS.documentationRead, readRequest: { target, query: { riskAssessmentId: graId, editorData, plainText } }, verify: (observed) => observed.verified === true });
                await projectGraRevision(docResult, row, docKey, graId);
              }
            }
            }
            {
          // Submission is not complete until the signed read operation observes
          // EvaluationComplete. Pending/content generation states are polled within
          // the bounded v4 window and do not become uncertain on the first read.
            const graId=graIds.get(runtimeKey(row.kind,row.elementId,row.workspaceId));
            const evaluationKey = `evaluation|${row.rowKey}`; const evaluationIntent=targetByKey.get(evaluationKey);
            if (hasFrozenStage(row,'evaluation')&&!evaluationIntent)fail('RETURN.INTENT_MISSING',`Frozen evaluation target is missing: ${evaluationKey}`);
            const evaluationTarget = evaluationIntent?{ targetIdentityKey: evaluationIntent.operationTargetIdentityKey, workspaceId: row.workspaceId }:null;
            if (evaluationIntent&&!done(evaluationKey)) {
              const currentEvaluation = await invoke(RETURN_OPERATIONS.evaluationPreflight, binding, { target: evaluationTarget, riskAssessmentId: graId, planDigest });
              const evaluationResult = currentEvaluation.status === 'EvaluationComplete'
                ? await closeVerified(evaluationKey,RETURN_OPERATIONS.evaluationWrite,RETURN_OPERATIONS.evaluationRead,{target:evaluationTarget,riskAssessmentId:graId},(observed)=>observed.verified===true)
                : await verifiedMutation({ targetKey: evaluationKey, target: evaluationTarget, preflightOperation: RETURN_OPERATIONS.evaluationPreflight, preflightResult: currentEvaluation,
                preflightRequest: { target: evaluationTarget, riskAssessmentId: graId }, mutationOperation: RETURN_OPERATIONS.evaluationWrite, commandKind: 'submit_evaluation',
                mutationPayload: { engagementId: binding.engagementId, workspaceId: row.workspaceId, riskAssessmentId: graId },
                readOperation: RETURN_OPERATIONS.evaluationRead, readRequest: { target: evaluationTarget, riskAssessmentId: graId },
                waitForEvaluationComplete:true, verify: (observed) => observed.verified === true });
              await projectGraRevision(evaluationResult, row, evaluationKey, graId);
            }
            }
            {
          // Generated Risk/Control identities are resolved only after this row's
          // signed EvaluationComplete read-back. Frozen identities remain exact.
            const mode=executionModes.get(row.rowKey)||row.mode;
            const graId=graIds.get(runtimeKey(row.kind,row.elementId,row.workspaceId));
            const returnIntents=frozenReturnIntents(row);
            if(mode!==row.mode)fail('RETURN.DETERMINISTIC_INTENTS_DRIFT',`Execution RAIT differs from the frozen Python Return intent: ${row.rowKey}.`);
            const requiredRelations=hasFrozenStage(row,'risk_control')?executionCatalogRelations(returnIntents.riskControlRelations):[];
            // A prior Feature generation can crash after the signed read-back
            // is committed but before Managed Content projection. Repair only
            // that missing local projection, using the frozen catalog identity
            // and the exact receipt payload selected by Core; never replay the
            // already-completed remote association.
            for(const relation of requiredRelations){
              const targetKey=`risk-control|${row.rowKey}|${relation.relationId}`;
              const progressRow=progressRows.get(targetKey);
              if(progressRow?.command_state!=='readback_verified'||Number(progressRow.relation_projection_count||0)!==0)continue;
              const targetSpec=targetByKey.get(targetKey);const frozenCatalog=targetSpec?.resolvedCatalog;
              const sourceObjectId=frozenCatalog?.riskId||progressRow.projection_source_object_id;
              const targetObjectId=frozenCatalog?.controlId||progressRow.projection_target_object_id;
              if(!progressRow.command_id||!sourceObjectId||!targetObjectId)fail('RETURN.VERIFIED_PROJECTION_IDENTITY_MISSING',`Verified Risk-Control projection identity is incomplete: ${relation.relationId}.`);
              await store.call('projectVerifiedReturn',{runId,commandId:progressRow.command_id,binding,workspaceId:row.workspaceId,projectionKind:'relation',relationType:'risk_control',relationKey:targetKey,sourceObjectId,targetObjectId});
              progressRow.relation_projection_count=1;
            }
            const pendingRelations=requiredRelations.filter((relation)=>!done(`risk-control|${row.rowKey}|${relation.relationId}`));
            const classificationIntents=plan.targets.filter((item)=>item.rowKey===row.rowKey&&String(item.key).startsWith('risk-classification|'));
            const pendingClassifications=classificationIntents.filter((item)=>!done(item.key));
            if(!pendingRelations.length&&!pendingClassifications.length) return;
            const catalogRequest={target:{targetIdentityKey:graOperationIdentity('risk-catalog',row,'generated-catalog'),workspaceId:row.workspaceId},riskAssessmentId:graId};
            const generatedRisks=await waitForGeneratedRiskIdentities(binding,row,graId,pendingClassifications);
            await runBoundedIndependent(pendingClassifications,RETURN_WITHIN_GRA_CONCURRENCY,async(intent)=>{
              const risk=generatedRisks.get(intent.key);if(!risk)fail('RETURN.RISK_CLASSIFICATION_IDENTITY_DRIFT',`Generated Risk identity is absent: ${intent.riskNumber}.`);
              const target={targetIdentityKey:intent.operationTargetIdentityKey,workspaceId:row.workspaceId};
              const query={riskAssessmentId:graId,riskName:intent.riskName,riskId:risk.riskId,classification:intent.value};
              const readRequest={target,query};
              const classificationResult=catalogIdentityText(risk.classification)===catalogIdentityText(intent.value)
                ?await closeVerified(intent.key,RETURN_OPERATIONS.riskClassificationWrite,RETURN_OPERATIONS.riskClassificationRead,readRequest,(observed)=>observed.verified===true)
                :await verifiedMutation({targetKey:intent.key,target,preflightOperation:RETURN_OPERATIONS.riskClassificationPreflight,
                  preflightRequest:readRequest,acceptPreflight:(preflight)=>preflight.found===true,mutationOperation:RETURN_OPERATIONS.riskClassificationWrite,commandKind:'patch_risk_classification',
                  mutationPayload:{engagementId:binding.engagementId,workspaceId:row.workspaceId,riskAssessmentId:graId,riskName:intent.riskName,riskId:risk.riskId,classification:intent.value},
                  raceReadOperation:RETURN_OPERATIONS.riskClassificationRead,raceReadRequest:readRequest,raceAlreadyApplied:(observed)=>observed.verified===true,
                  readOperation:RETURN_OPERATIONS.riskClassificationRead,readRequest,verify:(observed)=>observed.verified===true});
              await projectGraRevision(classificationResult,row,intent.key,graId);
            });
            // Resolve the immutable generated Risk/Control identity set once
            // per GRA. Each signed mutation Operation still performs its own
            // action-time exact identity/preflight check, and every mutation
            // keeps its authoritative read-back. Re-reading the full catalog
            // before every relation added no safety proof and dominated large
            // batches with identical network payloads.
            const catalog=pendingRelations.length?await waitForCompleteRiskControlCatalog(binding,catalogRequest,requiredRelations,mode):null;
            const relationWork=pendingRelations.map((relation)=>{
              const risks=catalogRiskMatches(catalog,relation,relation[`classification${mode}`]);
              const controls=catalogControlMatches(catalog,relation);
              if(risks.length!==1||controls.length!==1) fail('RETURN.RISK_CONTROL_CATALOG_DRIFT',`Risk/Control catalog identity is absent or ambiguous: ${relation.relationId}.`);
              const risk=risks[0];const control=controls[0];const targetKey=`risk-control|${row.rowKey}|${relation.relationId}`;
              const targetSpec=targetByKey.get(targetKey);const frozenCatalog=targetSpec.resolvedCatalog;
              if(frozenCatalog&&(frozenCatalog.riskId!==risk.riskId||frozenCatalog.riskRiskScopeId!==risk.riskRiskScopeId||(frozenCatalog.riskScopeId&&frozenCatalog.riskScopeId!==risk.riskScopeId)||frozenCatalog.controlId!==control.controlId
                ||(frozenCatalog.assertionType&&frozenCatalog.assertionType!==risk.assertionType)||frozenCatalog.assertion!==risk.assertion)) fail('RETURN.RISK_CONTROL_CATALOG_IDENTITY_DRIFT',`Risk/Control live identity changed after confirmation: ${relation.relationId}.`);
              return{relation,risk,control,targetKey,targetSpec,frozenCatalog};
            });
            const relationsByRisk=new Map();
            for(const item of relationWork){const lane=relationsByRisk.get(item.risk.riskId)||[];lane.push(item);relationsByRisk.set(item.risk.riskId,lane);}
            const riskLanes=[...relationsByRisk.values()];
            await runBoundedIndependent(riskLanes,RETURN_WITHIN_GRA_CONCURRENCY,async(lane)=>{
              for(const {relation,risk,control,targetKey,targetSpec,frozenCatalog} of lane){
              const target={targetIdentityKey:targetSpec.operationTargetIdentityKey,workspaceId:row.workspaceId};
              const riskQuery={riskRiskScopeId:risk.riskRiskScopeId,riskScopeId:risk.riskScopeId,riskId:risk.riskId,controlId:control.controlId,assertionType:risk.assertionType,assertion:risk.assertion};
              const result=await verifiedMutation({targetKey,target,preflightOperation:RETURN_OPERATIONS.riskPreflight,
                  preflightRequest:{target,query:{riskId:risk.riskId,riskClassification:risk.classification,controlId:control.controlId}},
                  mutationOperation:RETURN_OPERATIONS.riskWrite,commandKind:'associate_risk_control',mutationPayload:{
                    engagementId:binding.engagementId,workspaceId:row.workspaceId,riskAssessmentId:graId,riskRiskScopeId:risk.riskRiskScopeId,riskName:targetSpec.riskName,
                    controlName:targetSpec.controlName,riskClassification:targetSpec.classification,riskId:risk.riskId,updatedOn:risk.updatedOn,
                    isPurgeControlHiddenData:false,controlRiskScopes:[{controlId:control.controlId,riskScopeId:risk.riskScopeId,
                      assertionType:risk.assertionType,riskId:risk.riskId,assertions:[{assertion:risk.assertion}]}]},
                  acceptPreflight:(preflight)=>preflight.requiresPurge===false,
                  readOperation:RETURN_OPERATIONS.riskRead,readRequest:{target,query:riskQuery},readbackPolicy:{maxAttempts:RETURN_READBACK_MAX_ATTEMPTS,delayMs:0},verify:(observed)=>observed.verified===true});
              await store.call('projectVerifiedReturn',{runId,commandId:result.command.commandId,binding,workspaceId:row.workspaceId,projectionKind:'relation',relationType:'risk_control',relationKey:targetKey,sourceObjectId:risk.riskId,targetObjectId:control.controlId,payload:result.observed});
              }
            });
            }
          });
          // Reload the durable ledger before declaring the batch complete.  A
          // row-isolated invocation may leave a mixture of verified, uncertain
          // and still-frozen intents; the in-memory row result alone is not a
          // valid terminal signal for the whole Run.
          const finalProgress=await store.call('loadReturnProgress',{runId});
          const unresolved=finalProgress.filter((item)=>String(item.command_state||'')!=='readback_verified'
            &&!terminalNoopTargets.has(String(item.target_key||'')));
          const uncertain=unresolved.filter((item)=>String(item.state||'')==='uncertain'||String(item.command_state||'')==='uncertain');
          const resumable=unresolved.filter((item)=>!uncertain.includes(item));
          const itemFailures=[...isolatedRows.values()];
          if(uncertain.length){
            await store.call('finishReturn',{runId,outcome:'uncertain',error:`${uncertain.length} write result(s) require signed read-only reconciliation before Return can continue.`});
            await saveExecution({state:'uncertain',partial:true,itemFailures,uncertainTargets:uncertain.map((item)=>String(item.target_key||'')),completedAt:new Date().toISOString()});
          }else if(resumable.length){
            // Stay in `returning`: no uncertain mutation is replayed, and the
            // explicit Continue action resumes only the still-frozen ledger.
            await saveExecution({state:'paused',partial:true,itemFailures,resumableTargets:resumable.map((item)=>String(item.target_key||'')),pausedAt:new Date().toISOString()});
          }else{
            await store.call('recordBootstrapCapabilityEvidence',{
              schemaVersion:'omnia.feature-capability-evidence-bootstrap/v1',runId,...RETURN_CAPABILITY,
              connectorBinding:binding,safetyLock:input.context.safetyLock
            });
            await store.call('finishReturn',{runId,outcome:'succeeded'});
            await saveExecution({state:'completed',partial:false,itemFailures:[],completedAt:new Date().toISOString()});
          }
          const completedLatest=await store.call('loadLatestRun',{});
          return {surfacePatch:returnSurface(completedLatest,'',checkpoint.execution)};
        } catch (error) {
          signalTerminal(error);
          const outcome=terminal.outcome||'failed';const terminalError=terminal.error||error;
          const failedLatest=await store.call('loadLatestRun',{});
          if(failedLatest?.run?.state==='returning'||failedLatest?.run?.state==='verifying') await store.call('finishReturn',{runId,outcome,error:String(terminalError.message||terminalError)});
          await saveExecution({state:outcome,error:{code:String(terminalError.code||'RETURN.FAILED'),message:String(terminalError.message||terminalError)},...(terminal.reconcileSpec?{reconcileSpec:terminal.reconcileSpec}:{})});
          const terminalLatest=await store.call('loadLatestRun',{});
          return {surfacePatch:returnSurface(terminalLatest,'',checkpoint.execution)};
        }
        };
        checkpoint.execution={state:'running',background:false,startedAt:new Date().toISOString(),executionPolicy:checkpoint.returnPlan.executionPolicy||null,itemFailures:[]};
        await store.call('savePlan',{...checkpoint,updatedAt:new Date().toISOString()});
        return await executeReturn();
      }
      if (input?.actionId === 'prepare-return') {
        const latest = await store.call('loadLatestRun', {}); const run = latest?.run;
        if (!run || run.state !== 'ready_for_review') fail('RUN.NOT_REVIEWABLE', 'The latest Run is not ready for return review.');
        const checkpoint = await store.call('loadPlan', String(run.run_id));
        if (!checkpoint?.parsed) fail('RUN.CHECKPOINT_MISSING', 'The durable conversion checkpoint is unavailable.');
        {
          const prepared = await buildReturnPreparation(checkpoint, input.context);
          const executionPolicy=returnExecutionPolicy(input.payload);
          const plan = { schemaVersion: 'omnia.create-associate.return-plan/v1', runId: run.run_id,
            authority: prepared.authority, rows: prepared.rows, targets: prepared.targets, initialPreflights: prepared.preflights, executionPolicy };
          assertReturnPlanCapabilities(checkpoint.planIr?.rows,plan.rows);
          const preflightDigest = digest(Buffer.from(canonical({ authority: prepared.authority, preflights: prepared.preflights })));
          const authorityDigest = digest(Buffer.from(canonical({
            connectorId: input.context.connectorBinding.connectorId, sessionGeneration: Number(input.context.connectorBinding.sessionGeneration),
            engagementId: input.context.connectorBinding.engagementId, authorityInstanceId: input.context.connectorBinding.authorityInstanceId,
            tenantOrOrgId: input.context.connectorBinding.tenantOrOrgId, packId: input.context.connectorBinding.packId,
            workspaceIds: input.context.safetyLock.workspaceIds
          })));
          const frozen = await store.call('prepareReturnIntent', {
            runId: run.run_id, plan, connectorBinding: input.context.connectorBinding, safetyLock: input.context.safetyLock,
            credentialDigest: authorityDigest, preflightDigest
          });
          await store.call('savePlan', { ...checkpoint, returnPlan: plan, confirmation: frozen, preflightDigest, executionPolicy, updatedAt: new Date().toISOString() });
          const frozenLatest=await store.call('loadLatestRun',{});
          return {surfacePatch:returnSurface(frozenLatest,'')};
        }
      }
      if (['apply-revisions','remove-batch-row','revalidate-all','back-to-upload'].includes(input?.actionId)) {
        const latest=await store.call('loadLatestRun',{}),run=latest?.run;if(!run||!['needs_input','ready_for_review'].includes(run.state))fail('RUN.NOT_EDITABLE','The latest Run is not in canonical Review.');
        const plan=await store.call('loadPlan',String(run.run_id));if(!plan?.parsed||!plan?.descriptor)fail('RUN.CHECKPOINT_MISSING','The durable Review checkpoint is unavailable.');
        if(input.actionId==='back-to-upload'){plan.reviewNavigation='upload';plan.updatedAt=new Date().toISOString();await store.call('savePlan',plan);return{surfacePatch:uploadSurface(latest,'已返回独立 Upload 层；当前源 Artifact、字段 revisions 与排除状态均保留。')};}
        const revisions=['apply-revisions','revalidate-all'].includes(input.actionId)?(input.payload?.revisions||[]):[];if(!Array.isArray(revisions))fail('REVISION.BATCH_INVALID','Review revisions must be an array.');const derivedRevisions=[];
        for(const change of revisions){const row=plan.parsed.rows.find((item)=>item.rowKey===change.rowKey),candidate=plan.parsed.candidates.find((item)=>item.fieldKey===change.fieldKey&&item.provenance?.rowKey===change.rowKey);if(!row||!candidate||Number(candidate.revision)!==Number(change.expectedRevision)||['derived','rule_default','inherited'].includes(candidate.valueKind))fail('REVISION.CAS_MISMATCH','Review field changed; reload before saving.');const fields=REVIEW_FIELDS_BY_KIND[row.kind];const spec=fields.find((item)=>item[0]===candidate.rawFieldKey);const value=String(change.value??'').normalize('NFC').trim();if(!spec||value.length>Number(spec[4]))fail('REVISION.VALUE_INVALID',`${candidate.rawFieldKey} exceeds its official limit.`);candidate.value=value;candidate.revision=Number(change.expectedRevision)+1;candidate.valueKind='user_revision';candidate.status='accepted';row.fields[candidate.rawFieldKey]=value;if(candidate.rawFieldKey===fields[0][0]){row.elementId=value;for(const [rawFieldKey,derivedValue] of [['Derived GRA Name',deriveGraName(value)],[descriptionRawField(row.kind),value]]){const derived=reviewCandidate(plan.parsed,row,rawFieldKey);if(!derived||derived.valueKind!=='derived')fail('REVISION.DERIVED_LINEAGE_MISSING',`${rawFieldKey} has no signed derived candidate lineage.`);const expectedRevision=Number(derived.revision);derived.value=derivedValue;derived.revision=expectedRevision+1;derived.status='accepted';derived.provenance.dependencyFieldKey=candidate.fieldKey;row.fields[rawFieldKey]=derivedValue;derivedRevisions.push({fieldKey:derived.fieldKey,expectedRevision,value:derivedValue,dependencyFieldKey:candidate.fieldKey,dependencyRevision:candidate.revision});}}if(candidate.rawFieldKey===String(kindCapability(row.kind).relation||''))row.relations=value.split(/[、,，;；]/u).map((item)=>item.trim()).filter(Boolean);}
        let excludedRowKey='';if(input.actionId==='remove-batch-row'){excludedRowKey=String(input.payload?.rowKey||'');if(Number(input.payload?.expectedRunRevision)!==Number(run.state_revision))fail('RUN.REVISION_MISMATCH','Run revision changed before row removal.');if(activeRows(plan.parsed).length<=1)fail('REVIEW.LAST_ROW','The final active batch row cannot be removed.');if(!activeRows(plan.parsed).some((row)=>row.rowKey===excludedRowKey))fail('REVIEW.ROW_MISSING','Selected batch row is unavailable.');plan.parsed.excludedRowKeys=[...new Set([...(plan.parsed.excludedRowKeys||[]),excludedRowKey])];}
        plan.parsed=await validateParsedIr(plan.parsed,run.run_id);plan.liveValidation=await runReviewLiveValidation(plan,input.context);plan.planIr=await compilePlanIr(plan.parsed,run.run_id,plan.liveValidation);plan.reviewNavigation='review';const validation=validationPresentation(plan.parsed,plan.liveValidation);const blocker=validation.progress.items.some((item)=>item.state==='failed'||item.state==='pending');const compiled=await compileInstance({...plan.parsed,rows:activeRows(plan.parsed)},plan.descriptor,run.run_id,run.trace_id);
        const committed=await store.call('commitReviewValidation',{runId:run.run_id,expectedRunRevision:Number(run.state_revision),revisions,derivedRevisions,issues:plan.parsed.issues,nextState:blocker?'needs_input':'ready_for_review',eventType:input.actionId==='remove-batch-row'?'review.row_excluded':input.actionId==='revalidate-all'?'review.revalidated':'review.saved_and_revalidated',excludedRowKey,templateInstanceId:compiled.templateInstanceId});
        plan.updatedAt=new Date().toISOString();await store.call('savePlan',plan);const current=await store.call('loadLatestRun',{});return{surfacePatch:reviewSurface(current,plan,compiled,`已保存并重跑 11 项校验；Run revision ${committed.stateRevision}。`)};
      }
      if(input?.actionId==='stage-source-workbook'){
        const descriptor=input.payload?.artifact;
        if(!descriptor||descriptor.schemaVersion!=='omnia.feature-artifact/v1'||descriptor.featureId!==FEATURE_ID||descriptor.featureVersion!==FEATURE_VERSION||descriptor.kind!=='source')fail('ARTIFACT.IDENTITY_MISMATCH','The selected managed artifact identity is invalid.');
        const artifact=await store.call('readArtifactBytes',{artifactId:descriptor.artifactId});
        if(artifact.runId!==descriptor.runId||artifact.traceId!==descriptor.traceId||artifact.artifactId!==descriptor.artifactId)fail('ARTIFACT.RUN_BINDING_MISMATCH','Core-managed artifact Run/trace binding drifted.');
        const latest=await store.call('loadLatestRun',{}),run=latest?.run;
        if(!run||run.state!=='acquiring'||String(run.run_id)!==String(descriptor.runId)||String(run.source_artifact_id)!==String(descriptor.artifactId))fail('RUN.STAGED_SOURCE_MISMATCH','The staged source is not the current acquiring Run.');
        await store.call('savePlan',{schemaVersion:'omnia.create-associate.staged-upload/v1',planId:String(run.run_id),runId:String(run.run_id),traceId:String(run.trace_id),descriptor,
          stageState:'acquiring',updatedAt:new Date().toISOString()});
        return{surfacePatch:uploadSurface(latest,'系统信息文件已暂存；请确认上传后开始校验。')};
      }
      if(input?.actionId==='confirm-upload'){
        const latest=await store.call('loadLatestRun',{}),run=latest?.run;
        if(!run||run.state!=='acquiring')fail('RUN.NOT_STAGED','Only the current acquiring Run can be confirmed.');
        const checkpoint=await ensureStagedPlan(latest);
        if(!checkpoint?.descriptor||String(checkpoint.descriptor.runId)!==String(run.run_id)||String(checkpoint.descriptor.artifactId)!==String(run.source_artifact_id))fail('RUN.STAGED_SOURCE_MISMATCH','The durable staged descriptor does not match the acquiring Run.');
        const revision=await store.call('transitionRun',{runId:String(run.run_id),expectedRevision:Number(run.state_revision),toState:'processing',eventType:'workbook.upload_confirmed',details:{sourceArtifactId:String(run.source_artifact_id)}});
        await store.call('savePlan',{...checkpoint,stageState:'processing',confirmedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
        const processing=await store.call('loadLatestRun',{});
        if(Number(processing?.run?.state_revision)!==Number(revision)||processing?.run?.state!=='processing')fail('RUN.PROCESSING_PROJECTION_DRIFT','Confirmed Run did not project the processing state.');
        return{surfacePatch:processingSurface(processing,'正在校验系统信息。')};
      }
      if(input?.actionId!=='validate-staged-upload')fail('ACTION.NOT_AVAILABLE','This action is not available for the current Run state.');
      const latest=await store.call('loadLatestRun',{}),run=latest?.run;
      if(!run||run.state!=='processing')fail('RUN.NOT_PROCESSING','Background validation requires the current processing Run.');
      const stagedPlan=await store.call('loadPlan',String(run.run_id));const descriptor=stagedPlan?.descriptor;
      if(stagedPlan?.stageState!=='processing'||!descriptor||String(descriptor.runId)!==String(run.run_id)||String(descriptor.artifactId)!==String(run.source_artifact_id))fail('RUN.STAGED_SOURCE_MISMATCH','The processing Run has no matching durable staged descriptor.');
      const runId=String(run.run_id);const traceId=String(run.trace_id);let revision=Number(run.state_revision);
      let parsed;
      try {
        const workbookHandle=await store.call('openPythonArtifactHandle',{runId,artifactId:descriptor.artifactId});
        if(workbookHandle.runId!==descriptor.runId||workbookHandle.sha256!==descriptor.sha256||workbookHandle.sizeBytes!==descriptor.sizeBytes)fail('ARTIFACT.RUN_BINDING_MISMATCH','Core-managed Python input handle drifted from the staged Artifact descriptor.');
        const governanceHandle=await store.call('createPythonJsonInputHandle',{runId,value:governance,maxBytes:16*1024*1024});
        parsed=await invokePythonJson('parse_workbook',{schemaVersion:'omnia.create-associate.python-operation/v1',workbookHandle,sourceArtifactId:descriptor.artifactId,governanceHandle},runId);
        if(Array.isArray(parsed?.rows)&&parsed.rows.length>MAX_USER_ELEMENTS)fail('PARSER.ELEMENT_LIMIT_EXCEEDED','当前版本单次最多处理200个元素，请拆分工作簿后重新上传；文件未写入后台。');
        if(!parsed||parsed.schemaVersion!=='omnia.create-associate.parsed-workbook/v1'||parsed.sourceArtifactId!==descriptor.artifactId||!Array.isArray(parsed.rows))fail('PARSER.PYTHON_RESULT_INVALID','Managed Python parser returned an invalid workbook contract.');
      }
      catch (error) {
        await store.call('transitionRun', { runId, expectedRevision: revision, toState: 'failed', eventType: 'workbook.rejected', error: error.message });
        throw error;
      }
      revision = await store.call('transitionRun', { runId, expectedRevision: revision, toState: 'converting', eventType: 'workbook.contract_verified' });
      let compiled,output,unresolved;
      try{
        compiled = await compileInstance(parsed, descriptor, runId, traceId); output=compiled.output;
        const checkpoint={...stagedPlan,planId:runId,runId,traceId,descriptor,parsed,stageState:'processing',reviewNavigation:'review',createdAt:stagedPlan.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),validationProgress:{schemaVersion:'omnia.feature-validation-progress/v1',total:VALIDATION_CHECK_LABELS.length,results:[]}};
        const validationResultIds=new Set();
        const publishValidationCheck=async(itemId,result)=>{
          if(validationResultIds.has(itemId))return;
          const state=['passed','warning','failed','skipped'].includes(String(result?.state||''))?String(result.state):'failed';
          const detail=String(result?.reason||result?.detail||'校验未返回有效结果。').slice(0,2000);
          validationResultIds.add(itemId);
          checkpoint.validationProgress.results.push({itemId,state,detail});
          checkpoint.updatedAt=new Date().toISOString();
          await store.call('savePlan',checkpoint);
        };
        const localValidation=validationPresentation(parsed,{}),localById=new Map(localValidation.progress.items.map((item)=>[item.itemId,item]));
        for(const itemId of ['template_structure','required_fields','valid_values','unique_names','infrastructure_links','workspace_presence']){
          const item=localById.get(itemId);await publishValidationCheck(itemId,{state:item?.state||'failed',detail:item?.detail||'本地校验结果缺失。'});
        }
        checkpoint.liveValidation=await runReviewLiveValidation(checkpoint,input.context,publishValidationCheck);
        if(checkpoint.validationProgress.results.length!==VALIDATION_CHECK_LABELS.length)fail('VALIDATION.PROGRESS_INCOMPLETE','Validation finished without publishing every signed check result.');
        checkpoint.planIr=await compilePlanIr(parsed,runId,checkpoint.liveValidation);checkpoint.stageState='validated';
        await store.call('recordFieldRevisions', { runId, templateInstanceId: compiled.templateInstanceId, fields: parsed.candidates });
        await store.call('recordIssues', { runId, issues: parsed.issues });
        await store.call('savePlan', checkpoint);
        const initialValidation=validationPresentation(parsed,checkpoint.liveValidation);const initialBlocker=initialValidation.progress.items.some((item)=>item.state==='failed'||item.state==='pending');
        unresolved = parsed.issues.filter((issue) => issue.state === 'needs_input' || issue.state === 'blocking');
        revision = await store.call('transitionRun', { runId, expectedRevision: revision, toState: 'validating_output', eventType: 'output.created' });
        revision = await store.call('transitionRun', {runId,expectedRevision:revision,toState:unresolved.length||initialBlocker?'needs_input':'ready_for_review',eventType:unresolved.length||initialBlocker?'issues.persisted':'output.ready'});
      }catch(error){await store.call('transitionRun',{runId,expectedRevision:revision,toState:'failed',eventType:'output.failed',error:String(error.message||error)});throw error;}
      const current=await store.call('loadLatestRun',{});const plan=await store.call('loadPlan',runId);
      return{surfacePatch:reviewSurface(current,plan,compiled,`已从系统信息解析 ${parsed.rows.length} 行、${parsed.candidates.length} 个候选值；blocking/error ${unresolved.length}，warning ${parsed.issues.filter((issue)=>issue.state==='waived').length}。`)};
    }
  });
}

module.exports = { createFeatureWorker, parseV8, zipEntries, V8_SHA256,AI_REVIEW_DISPLAY_LANGUAGE,AI_REVIEW_LANGUAGE_VERSION,isChineseAiReviewDisplayText,assertChineseAiReviewDisplayText,aiReviewItemUsesChineseDisplayText,assertAiReviewOutputUsesChineseDisplayText,deriveGraName,validationPresentation,reviewPresentation,reviewBlocked,freezeAppDataAvailability,resolveFrozenAppDataAvailability,exactApplicationSettingsIdentity,workflowSurface,uploadSurface,terminalRunReturnsToFreshUpload,normalizeRait,applyLiveVerifiedInfrastructureInheritance,applicationIdentityRequest,inspectApplicationIdentity,RETURN_OPERATIONS,
  buildFrozenDependencyGraph,dependencyBlockedByFailure,returnExecutionPolicy,createFifoOperationLimiter,completeObjectCreateAbsence,completeGraCreateAbsence,aiReviewEligibleRows,frozenStageNodes,freezePlanCapabilities,frozenReturnIntents,assertReturnPlanCapabilities,authorityContentNameFor,governedCatalogDescription,catalogIdentityEvidenceGaps,riskControlCatalogFingerprint,catalogControlMatches,unresolvedCatalogRelations,workflowNavigationActions,returnSurface,forceCancelReturnRun,closeRunForFreshStart };
