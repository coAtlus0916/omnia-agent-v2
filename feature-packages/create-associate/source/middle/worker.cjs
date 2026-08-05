'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const FEATURE_ID = 'omnia.create-associate';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const RETURN_CAPABILITY = Object.freeze({
  scenarioId: 'create-associate-return-v1',
  capabilityId: 'phase1-full-return-v1'
});
const V8_SHA256 = '1ED937A50253CEDF431CE02A0CC7A3B3E576597BBD6CAA6C967738D7B2DA4538';
const GOVERNANCE = '__GOVERNANCE_JSON__';
const EXPECTED_SHEETS = Object.freeze([
  '使用说明', '字段母版', 'Risk-Control关系', 'V4接口证据', '规则与枚举',
  '覆盖与质检', '原始字段追溯', 'SAP ECC录制证据', '评分项与规则'
]);

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function deriveGraName(elementId){return `GRA-${String(elementId||'').normalize('NFC').trim()}`;}
function descriptionRawField(kind){return kind==='APP'?'Derived Application Description':`Derived ${kind} Description`;}
function descriptionRuleId(kind){return kind==='APP'?'v8.app-description-from-element-id.v1':`v4.${kind.toLocaleLowerCase('en-US')}-description-from-element-id.v1`;}
function issueId(origin,code,fieldKey){return `${origin}-${digest(Buffer.from(`${code}|${fieldKey}`)).slice(0,48)}`;}
function issue(origin,code,fieldKey,issueType,state,message,checkId){return{issueId:issueId(origin,code,fieldKey),origin,code,fieldKey,issueType,state,message,checkId};}
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
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
  return [...xml.toString('utf8').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gu)].map((match) =>
    xmlText([...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((part) => part[1]).join(''))
  );
}

function workbook(entries) {
  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const rels = new Map([...relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gu)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([A-Za-z:]+)="([^"]*)"/gu)].map((item) => [item[1], xmlText(item[2])]));
    return [attrs.Id, attrs.Target];
  }));
  return [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gu)].map((match) => {
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
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gu)) {
    const rowNumber = Number(rowMatch[1].match(/\br="(\d+)"/u)?.[1] || rows.length + 1);
    const cells = [];
    for(const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)){
      const attrs = cellMatch[1];
      const ref = attrs.match(/\br="([A-Z]+\d+)"/u)?.[1] || '';
      const type = attrs.match(/\bt="([^"]+)"/u)?.[1] || '';
      const body = cellMatch[2]||'';
      const hasFormula=/<f\b/iu.test(body);
      if(hasFormula&&!allowManagedFormulaCache) fail('WORKBOOK.FORMULA_UNSUPPORTED',`Formula cell ${ref||'(unknown)'} is unsupported in user input; cached values are never treated as source data.`);
      if(hasFormula&&type==='s') fail('WORKBOOK.FORMULA_CACHE_INVALID',`Formula cell ${ref||'(unknown)'} cannot use a shared-string index as its cached value.`);
      const raw = body.match(/<v>([\s\S]*?)<\/v>/u)?.[1];
      const inline = body.match(/<is>([\s\S]*?)<\/is>/u)?.[1];
      let value = raw === undefined ? '' : xmlText(raw);
      if(type==='s'&&raw!==undefined&&!hasFormula)value=strings[Number(raw)]||'';
      if (type === 'inlineStr' && inline) value = xmlText([...inline.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((part) => part[1]).join(''));
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
  if (fields.length !== 187 || ids.size !== 187 || relations.length !== 68 || evidence.length !== 21 || traces.length !== 180) {
    fail('WORKBOOK.COUNT_MISMATCH', 'V8 counts must be fields=187, relations=68, evidence=21, field traces=180.');
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
  const scoreHeaders = scoreSheet?.[10] || [];
  const scoreItems = (scoreSheet || []).slice(11, 26).map((row, index) => ({
    sourceRow: index + 11,
    values: Object.fromEntries(scoreHeaders.map((header, column) => [String(header), row?.[column] ?? '']))
  }));
  const writable = scoreItems.filter((row) => String(row.values['Higher适用']).startsWith('Y') && String(row.values['request位置']).includes('request-'));
  const notApplicable = scoreItems.filter((row) => String(row.values['Higher适用']).startsWith('N') && String(row.values.item_id).endsWith('_13'));
  if (scoreItems.length !== 15 || writable.length !== 14 || notApplicable.length !== 1) {
    fail('WORKBOOK.SCORING_CONTRACT_MISMATCH', `Scoring contract must be 15/14/1; observed ${scoreItems.length}/${writable.length}/${notApplicable.length}; headers=${scoreHeaders.join('|')}.`);
  }
  return { sha256, fields, relations, evidence, traces, sap, scores, scoreItems };
}

function parseUserWorkbook(bytes, sourceArtifactId, governance = {}) {
  const entries = zipEntries(bytes);
  const strings = sharedStrings(entries);
  const sheets = workbook(entries);
  const definitions = [
    { kind: 'APP', id: '系统ID', required: ['系统ID', 'APP类型', 'System Risk Classification', 'Factors Considered', 'Omnia工作区'], relation: '' },
    { kind: 'DB', id: '数据库ID', required: ['数据库ID', 'DB 类型', 'Omnia工作区', '关联系统ID'], relation: '关联系统ID' },
    { kind: 'OS', id: '服务器ID', required: ['服务器ID', 'OS 类型', 'Omnia工作区', '关联系统ID'], relation: '关联系统ID' },
    { kind: 'TOOL', id: 'IT TOOL ID', required: ['IT TOOL ID', 'Tool 类型', 'System Risk Classification', 'Omnia工作区'], relation: '' }
  ];
  const rows = [];
  const candidates = [];
  const issues = [];
  for (const sheet of sheets) {
    const values = sheetRows(entries.get(sheet.path), strings);
    const headers = [];
    for (let rowNumber = 1; rowNumber < values.length; rowNumber += 1) {
      const row = values[rowNumber] || [];
      const definition = definitions.find((item) => row.includes(item.id));
      if (definition) headers.push({ rowNumber, definition, row });
    }
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      const end = headers[index + 1]?.rowNumber || values.length;
      const normalized = Array.from({ length: Math.max(header.row.length, 1) }, (_unused, column) =>
        String(header.row[column] || '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
      );
      const present = normalized.filter(Boolean);
      if (new Set(present).size !== present.length) fail('WORKBOOK.AMBIGUOUS_HEADER', `Duplicate normalized columns in ${sheet.name} row ${header.rowNumber}.`);
      const columns = new Map(normalized.map((name, column) => [name, column]));
      for (let sourceRow = header.rowNumber + 1; sourceRow < end; sourceRow += 1) {
        const source = values[sourceRow] || [];
        const elementId = String(source[columns.get(header.definition.id)] || '').trim();
        if (!elementId) continue;
        const populatedColumns = [...columns.values()].filter((column) => String(source[column] || '').trim()).length;
        if (populatedColumns < 2) continue;
        const rowKey = digest(`${header.definition.kind}|${sheet.name.normalize('NFC')}|${sourceRow}`);
        const fields = Object.fromEntries([...columns].filter(([name]) => name).map(([name, column]) => [name, String(source[column] || '').trim()]));
        const relations = header.definition.relation
          ? String(fields[header.definition.relation] || '').split(/[、,，;；]/u).map((value) => value.trim()).filter(Boolean)
          : [];
        const logical = { rowKey, kind: header.definition.kind, elementId, sourceSheet: sheet.name, sourceRow, fields, relations };
        rows.push(logical);
        for (const [rawFieldKey, value] of Object.entries(fields)) {
          const canonicalFieldId = String(governance.fieldAliases?.[header.definition.kind]?.[rawFieldKey] || '');
          const fieldKey = canonicalFieldId ? `${rowKey}.${canonicalFieldId}` : `${rowKey}.unmapped.${digest(rawFieldKey)}`;
          candidates.push({
            fieldKey, rawFieldKey, canonicalFieldId, revision: 1, valueKind: 'source', value,
            status: value ? 'accepted' : 'needs_input',
            provenance: {
              sourceArtifactId, sourceSheet: sheet.name, sourceRow, rowKey,
              fieldKey,
              sourceTraceId: `input:${digest(`${sourceArtifactId}|${sheet.name}|${sourceRow}|${rawFieldKey}`)}`,
              derivationRule: 'verbatim_user_workbook_cell'
            }
          });
          if (!canonicalFieldId) issues.push(issue('parser','PARSER.UNMAPPED_FIELD',fieldKey,'ambiguous','blocking',
            `原始列 ${rawFieldKey} 无法唯一映射到 V8 canonical field_id。`,'template_structure'));
          if(rawFieldKey==='System Risk Classification'&&value&&!['Higher','Lower'].includes(value)) issues.push(issue('local','LOCAL.INVALID_ENUM',fieldKey,'invalid_enum','needs_input',`${header.definition.kind} ${elementId} 的 RAIT 仅允许 Higher 或 Lower。`,'valid_values'));
        }
        const idCandidate=candidates.find((item)=>item.provenance.rowKey===rowKey&&item.rawFieldKey===header.definition.id);
        const graRule=governance.derivationRules?.find((item)=>item.ruleId==='v4.phase1-gra-name-from-element-id.v1');
        if(!idCandidate||!graRule||graRule.algorithm!=='prefix_literal'||graRule.prefix!=='GRA-'||graRule.targetFieldId!=='P1.RUNTIME.GRA.NAME') fail('GOVERNANCE.GRA_NAME_RULE_MISSING','Signed GRA name derivation rule is unavailable.');
        const graFieldKey=`${rowKey}.P1.RUNTIME.GRA.NAME`;
        candidates.push({fieldKey:graFieldKey,rawFieldKey:'Derived GRA Name',canonicalFieldId:'P1.RUNTIME.GRA.NAME',revision:1,valueKind:'derived',value:deriveGraName(elementId),status:'accepted',provenance:{
          sourceArtifactId:`${governance.sourceRef}:sha256:${String(governance.sourceSha256).toLocaleLowerCase('en-US')}`,sourceSheet:'V4接口证据',sourceRow:1,rowKey,fieldKey:graFieldKey,
          sourceTraceId:String(graRule.sourceTraceId),derivationRule:String(graRule.ruleId),dependencyFieldKey:idCandidate.fieldKey
        }});
        logical.fields['Derived GRA Name']=deriveGraName(elementId);
        {
          const kind=header.definition.kind;const targetFieldId=`P1.${kind}.IT.DESCRIPTION`;const dependencyFieldId=`P1.${kind}.IT.ELEMENT_ID`;
          const declaration=governance.fields?.find((item)=>item.fieldId===targetFieldId);
          const rule=governance.derivationRules?.find((item)=>item.ruleId===descriptionRuleId(kind));
          if(!declaration||!rule||rule.targetFieldId!==targetFieldId||rule.algorithm!=='canonical_element_id'||rule.dependencyFieldId!==dependencyFieldId) fail('GOVERNANCE.DESCRIPTION_RULE_MISSING',`Signed ${kind} description derivation rule is unavailable.`);
          candidates.push({fieldKey:`${rowKey}.${targetFieldId}`,rawFieldKey:descriptionRawField(kind),canonicalFieldId:targetFieldId,revision:1,valueKind:'derived',value:elementId,status:'accepted',provenance:{
            sourceArtifactId:`${governance.sourceRef}:sha256:${String(governance.sourceSha256).toLocaleLowerCase('en-US')}`,sourceSheet:'字段母版',sourceRow:Number(declaration.sourceRow),rowKey,fieldKey:`${rowKey}.${targetFieldId}`,
             sourceTraceId:String(rule.sourceTraceId),derivationRule:String(rule.ruleId),dependencyFieldKey:idCandidate.fieldKey
          }});
          logical.fields[descriptionRawField(kind)]=elementId;
        }
        if(header.definition.kind==='APP'){
          const relevantDeclaration=governance.fields?.find((item)=>item.fieldId==='P1.APP.IT.IS_RELEVANT');
          const relevantRule=governance.derivationRules?.find((item)=>item.ruleId==='v8.app-is-relevant-false.v1');
          if(!relevantDeclaration||Number(relevantDeclaration.sourceRow)!==9||relevantDeclaration.defaultRuleId!=='v8.app-is-relevant-false.v1'||relevantDeclaration.defaultValue!==false
            ||!relevantRule||relevantRule.targetFieldId!=='P1.APP.IT.IS_RELEVANT'||relevantRule.algorithm!=='constant_boolean_false'||relevantRule.constantValue!==false||relevantRule.sourceTraceId!=='SRC.IT元素.011') fail('GOVERNANCE.IS_RELEVANT_RULE_MISSING','Signed APP isRelevant constant-false rule is unavailable.');
          const relevantFieldKey=`${rowKey}.P1.APP.IT.IS_RELEVANT`;
          candidates.push({fieldKey:relevantFieldKey,rawFieldKey:'Derived Application Is Relevant',canonicalFieldId:'P1.APP.IT.IS_RELEVANT',revision:1,valueKind:'rule_default',value:false,status:'accepted',provenance:{
            sourceArtifactId:`${governance.sourceRef}:sha256:${String(governance.sourceSha256).toLocaleLowerCase('en-US')}`,sourceSheet:'字段母版',sourceRow:Number(relevantDeclaration.sourceRow),rowKey,fieldKey:relevantFieldKey,
            sourceTraceId:String(relevantRule.sourceTraceId),derivationRule:String(relevantRule.ruleId)
          }});
          logical.fields['Derived Application Is Relevant']=false;
          const dataDeclaration=governance.fields?.find((item)=>item.fieldId==='P1.APP.IT.IS_DATA_AVAILABLE');
          const dataRule=governance.derivationRules?.find((item)=>item.ruleId==='v4.app-is-data-available-false.v1');
          if(!dataDeclaration||dataDeclaration.defaultRuleId!=='v4.app-is-data-available-false.v1'||dataDeclaration.defaultValue!==false
            ||!dataRule||dataRule.targetFieldId!=='P1.APP.IT.IS_DATA_AVAILABLE'||dataRule.algorithm!=='constant_boolean_false'||dataRule.constantValue!==false) fail('GOVERNANCE.IS_DATA_AVAILABLE_RULE_MISSING','Signed v4-compatible APP isDataAvailable constant-false rule is unavailable.');
          const dataFieldKey=`${rowKey}.P1.APP.IT.IS_DATA_AVAILABLE`;
          candidates.push({fieldKey:dataFieldKey,rawFieldKey:'Derived Application Is Data Available',canonicalFieldId:'P1.APP.IT.IS_DATA_AVAILABLE',revision:1,valueKind:'rule_default',value:false,status:'accepted',provenance:{
            sourceArtifactId:`${governance.sourceRef}:sha256:${String(governance.sourceSha256).toLocaleLowerCase('en-US')}`,sourceSheet:'V4接口证据',sourceRow:Number(dataDeclaration.sourceRow),rowKey,fieldKey:dataFieldKey,
            sourceTraceId:String(dataRule.sourceTraceId),derivationRule:String(dataRule.ruleId)
          }});
          logical.fields['Derived Application Is Data Available']=false;
        }
        for (const required of header.definition.required) {
          if (!String(fields[required] || '').trim()) {
            const candidate = candidates.find((item) => item.provenance.rowKey === rowKey && item.rawFieldKey === required);
            const fieldKey=candidate?.fieldKey || `${rowKey}.missing.${digest(required)}`;
            issues.push(issue('local','LOCAL.REQUIRED_FIELD',fieldKey,'missing',candidate ? 'needs_input' : 'blocking',
              `${header.definition.kind} ${elementId} 缺少必填字段 ${required}。`,'required_fields'));
          }
        }
      }
    }
  }
  const identity = new Map();
  for (const row of rows) {
    const workspaceIdentity = String(Object.entries(row.fields).find(([name]) => name.includes('Omnia'))?.[1] || '').normalize('NFKC');
    const key = `${row.kind}|${row.elementId}|${workspaceIdentity}`.toLocaleLowerCase('en-US');
    const previous = identity.get(key);
    if (previous) issues.push(issue('local','LOCAL.DUPLICATE_IDENTITY',`${row.rowKey}.identity`,'conflict','blocking',
      canonical(previous.fields) === canonical(row.fields)
        ? `${row.kind} ${row.elementId} 在同一规范身份下重复；为防止重复创建，必须由用户在源资料中只保留一行。`
        : `${row.kind} ${row.elementId} 存在冲突的重复行。`,'unique_names')); else identity.set(key, row);
  }
  const apps = new Set(rows.filter((row) => row.kind === 'APP').map((row) => row.elementId.toLocaleLowerCase('en-US')));
  for (const row of rows.filter((item) => ['DB', 'OS'].includes(item.kind))) {
    for (const target of row.relations) if (!apps.has(target.toLocaleLowerCase('en-US'))) issues.push(issue('local','UNSUPPORTED.EXTERNAL_APP_REFERENCE',`${row.rowKey}.relationship-target-live`,'contract_mismatch','blocking',
      `${row.kind} ${row.elementId} 引用的 APP ${target} 不在当前批次；0.2.1 未实现冻结外部目标与权威 RAIT 读回，禁止准备回传。`,'relationship_targets'));
  }
  for(const row of rows.filter((item)=>['DB','OS'].includes(item.kind))){
    const appRows=row.relations.map((target)=>rows.filter((item)=>item.kind==='APP'&&item.elementId.toLocaleLowerCase('en-US')===target.toLocaleLowerCase('en-US'))).flat();
    const modes=[...new Set(appRows.map((app)=>String(app.fields['System Risk Classification']||'')))];
    if(appRows.length===1&&modes.length===1&&['Higher','Lower'].includes(modes[0])){
      const canonicalFieldId=`P1.${row.kind}.GRA.RAIT_CONCLUSION`;
      if(!governance.fieldIds?.includes(canonicalFieldId)) fail('GOVERNANCE.INHERITANCE_FIELD_MISSING',`${canonicalFieldId} is absent from signed governance.`);
      const fieldKey=`${row.rowKey}.${canonicalFieldId}`;
      candidates.push({fieldKey,rawFieldKey:'Inherited System Risk Classification',canonicalFieldId,revision:1,valueKind:'inherited',value:modes[0],status:'accepted',provenance:{
        sourceArtifactId,sourceSheet:row.sourceSheet,sourceRow:row.sourceRow,rowKey:row.rowKey,fieldKey,
        sourceTraceId:`inheritance:${digest(`${appRows[0].rowKey}|${row.rowKey}|${row.relations[0]}`)}`,
        derivationRule:`planned_db_os_rait_from_app_edge:${appRows[0].rowKey};remote_verification_required_before_return`
      }});
      row.fields['Inherited System Risk Classification']=modes[0];
    }
  }
  if (rows.length === 0) issues.push(issue('parser','PARSER.NO_SUPPORTED_ROWS','workbook.sections','missing','blocking',
    '未在用户资料中找到 APP/DB/OS/Tool 四区段数据行。','template_structure'));
  const issueNamespace=digest(Buffer.from(String(sourceArtifactId)));
  for(const candidate of issues)candidate.issueId=issueId(candidate.origin||'parser',`${issueNamespace}|${candidate.code||candidate.issueType}`,candidate.fieldKey);
  return { rows, candidates, issues, issueNamespace, sheetNames: sheets.map((sheet) => sheet.name) };
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}
function columnName(index) { let name = ''; for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name; return name; }
function displayUnits(value) {
  const text = value && typeof value === 'object' && value.formula ? '0' : String(value ?? '');
  return text.split(/\r?\n/u).map((line) => [...line].reduce((total, character) => total + (/[^\u0000-\u00ff]/u.test(character) ? 2 : 1), 0));
}
function deterministicRowHeight(values, widths, options, header) {
  if (header) return Number(options.headerRowHeight || 26);
  const lineCount = values.reduce((maximum, value, index) => {
    const capacity = Math.max(6, Math.floor(Number(widths[index] || 24) - 2));
    const lines = displayUnits(value).reduce((total, units) => total + Math.max(1, Math.ceil(units / capacity)), 0);
    return Math.max(maximum, lines);
  }, 1);
  const estimated = 5 + lineCount * Number(options.lineHeight || 14.25);
  return Math.min(Number(options.maxRowHeight || 96), Math.max(Number(options.minRowHeight || 22), estimated));
}
function worksheetXml(headers, rows, options = {}) {
  const widths = options.columnWidths || headers.map((_value, index) => index === 0 ? 34 : 24);
  if (widths.length !== headers.length || widths.some((width) => !Number.isFinite(Number(width)) || Number(width) < 6)) {
    fail('OUTPUT.LAYOUT_INVALID', 'Runtime workbook column layout is incomplete.');
  }
  const cell = (value, row, column, style = 0) => {
    const ref = `${columnName(column)}${row}`;
    if (value && typeof value === 'object' && value.formula) return `<c r="${ref}" s="${style}"><f>${escapeXml(value.formula)}</f><v>0</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  };
  const data = [headers, ...rows].map((values, index) => {
    const height = deterministicRowHeight(values, widths, options, index === 0);
    return `<row r="${index + 1}" ht="${height.toFixed(2)}" customHeight="1">${values.map((value, column) => cell(value, index + 1, column + 1, index === 0 ? 1 : 2)).join('')}</row>`;
  }).join('');
  const lastColumn = columnName(headers.length);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1" autoPageBreaks="1"/></sheetPr><dimension ref="A1:${lastColumn}${rows.length + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${headers.map((_value, index) => `<col min="${index + 1}" max="${index + 1}" width="${Number(widths[index]).toFixed(2)}" customWidth="1"/>`).join('')}</cols><sheetData>${data}</sheetData><autoFilter ref="A1:${lastColumn}${rows.length + 1}"/>${options.validation ? `<dataValidations count="1"><dataValidation type="list" allowBlank="0" sqref="${options.validation}"><formula1>&quot;accepted,needs_input,blocked&quot;</formula1></dataValidation></dataValidations>` : ''}<sheetProtection sheet="1" objects="1" scenarios="1"/><printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" pageOrder="overThenDown" fitToWidth="${Number(options.fitToWidth || 1)}" fitToHeight="${Number(options.fitToHeight || 0)}"/></worksheet>`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1); return crc >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(files) {
  const local = []; const central = []; let offset = 0;
  for (const [pathname, content] of Object.entries(files)) {
    const name = Buffer.from(pathname, 'utf8'); const bytes = Buffer.from(content); const crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + bytes.length;
  }
  const directoryBytes = Buffer.concat(central); const end = Buffer.alloc(22); const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

function buildRuntimeWorkbook(parsed, metadata, baseBytes) {
  const resultRows = parsed.rows.map((row) => [row.rowKey,row.kind,row.elementId,row.fields['Omnia工作区']||'',row.fields['System Risk Classification']||row.fields['Inherited System Risk Classification']||'',row.relations.join('、'),parsed.issues.some((issue)=>issue.fieldKey.startsWith(row.rowKey)&&['needs_input','blocking'].includes(issue.state))?'needs_input':'accepted']);
  const planRows = parsed.rows.flatMap((row) => {
    const blocked = parsed.issues.some((issue) => issue.fieldKey.startsWith(row.rowKey) && ['needs_input', 'blocking'].includes(issue.state));
    const disposition = blocked ? 'blocked_missing_input' : 'supported_after_preflight';
    const plans = [
      [row.rowKey, 'it_element', row.kind, row.elementId, blocked ? 'blocked_missing_input' : 'supported_after_preflight', 'object-type-aware exact identity/workspace/subtype preflight; create or exact reuse followed by mandatory readback'],
      [row.rowKey, 'gra', row.kind, deriveGraName(row.elementId), disposition, 'content/workspace/identity preflight'],
      [row.rowKey, 'field_diff', row.kind, row.elementId, blocked ? 'blocked_missing_input' : 'conditional', 'signed field Operation + readback']
    ];
    for (const relation of row.relations) plans.push([row.rowKey, 'element_relation', row.kind, relation, disposition, 'only an APP in this workbook or a separately implemented exact live reference may be used; external APP reference is disabled'],);
    plans.push([row.rowKey, 'risk_control_multiset', row.kind, row.elementId, blocked ? 'blocked_missing_input' : 'conditional', 'governance IR + live catalog exact multiset']);
    return plans;
  });
  const traceRows = parsed.candidates.map((field) => [field.provenance.sourceArtifactId, field.provenance.sourceSheet, field.provenance.sourceRow, field.provenance.rowKey, field.fieldKey, field.canonicalFieldId, field.revision, field.valueKind, field.value, field.status, field.provenance.sourceTraceId, field.provenance.derivationRule]);
  const issueRows = parsed.issues.map((issue) => [issue.issueId, issue.issueType, issue.state, issue.fieldKey, issue.message]);
  issueRows.unshift(['SUMMARY', '行数', 'calculated', 'parsedRows', { formula: `COUNTA('处理结果'!A2:A${resultRows.length + 1})` }]);
  issueRows.push(
    ['SUPPORT.app_create', 'support', 'supported_after_preflight', 'APP create', 'Signed exact create-only permit, mutation and mandatory authority readback.'],
    ['SUPPORT.existing_reuse', 'support', 'supported_after_preflight', 'existing exact reuse', 'APP/DB/OS/Tool may reuse an exact unique live object after Workspace/type identity readback.'],
    ['SUPPORT.db_os_tool_create', 'support', 'supported_after_preflight', 'DB/OS/Tool create', 'The object-type-aware create-only preflight repeats the live exact search; creation uses the recorded DB=Database, OS=OperatingSystem, Tool=Tool subtype contract and mandatory read-back.'],
    ['SUPPORT.external_app_reference', 'support', 'blocked_not_implemented', 'external APP reference', 'External APP exact preflight plus verified RAIT readback is not implemented; reference is disabled.'],
    ['SUPPORT.gra', 'support', 'supported_after_preflight', 'gra', 'Signed exact create/reconcile Operation; requires live content identity.'],
    ['SUPPORT.field_diff', 'support', 'conditional', 'field_diff', 'Only fields with signed Operations and readback may execute.'],
    ['SUPPORT.element_relation.db_os_to_app','support','supported_after_preflight','element_relation','DB/OS 关联系统ID -> in-workbook APP；执行 InfrastructureApplication 精确双向读回合同。'],
    ['SUPPORT.element_relation.tool','support','not_applicable_no_input_contract','element_relation','The current user template has no Tool relation field; Tool object/GRA/RAIT Return is supported without fabricating a relationship.'],
    ['SUPPORT.risk_control', 'support', 'conditional', 'risk_control', 'Governance multiset plus live catalog/hidden-data validation required.'],
    ['SUPPORT.not_applicable', 'support', 'not_applicable', 'explicit_n_a', 'Governance-declared N/A operations are omitted, never synthesized.'],
    ['SUPPORT.production_return', 'support', 'pending_canary', 'return', 'Comments confirmation and exact authority canary remain mandatory.']
  );
  const sheets = [
    ['处理结果', ['rowKey', '类型', '元素ID', '工作区', 'RAIT', '关联APP', '状态'], resultRows, { validation: `G2:G${Math.max(2, resultRows.length + 1)}`, columnWidths: [36, 12, 24, 20, 14, 24, 20], maxRowHeight: 72 }],
    ['执行计划', ['rowKey', 'operationKind', '对象类型', '目标身份', 'disposition', '门禁'], planRows, { columnWidths: [36, 22, 14, 26, 26, 48], maxRowHeight: 90 }],
    ['来源追踪', ['sourceArtifactId', 'sourceSheet', 'sourceRow', 'rowKey', 'fieldKey', 'canonicalFieldId', 'revision', 'valueKind', 'value', 'status', 'sourceTraceId', 'derivationRule'], traceRows, { columnWidths: [22, 14, 8, 26, 28, 22, 8, 12, 18, 12, 26, 30], fitToWidth: 2, fitToHeight: 1, maxRowHeight: 110 }],
    ['问题与支持矩阵', ['issueId', 'issueType', 'state', 'fieldKey', 'message'], issueRows, { columnWidths: [34, 20, 26, 28, 64], maxRowHeight: 110 }]
  ];
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet[0])}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const relations = sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const overrides = sheets.map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const generated = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView/></bookViews><sheets>${workbookSheets}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf xfId="0"/><xf xfId="0" fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>',
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Omnia Create Associate Run ${escapeXml(metadata.runId)}</dc:title><dc:subject>candidate; source=${escapeXml(metadata.sourceArtifactId)}; governance=${escapeXml(metadata.governanceDigest)}</dc:subject></cp:coreProperties>`
  };
  sheets.forEach((sheet, index) => { generated[`xl/worksheets/sheet${index + 1}.xml`] = worksheetXml(sheet[1], sheet[2], sheet[3]); });
  let files = generated;
  let baseDigest = '';
  if (baseBytes) {
    const original = zipEntries(Buffer.from(baseBytes));
    const originalSheetNames = workbook(original).map((sheet) => sheet.name);
    if (originalSheetNames.join('|') !== sheets.map((sheet) => sheet[0]).join('|')) {
      fail('OUTPUT.BASE_STRUCTURE_INVALID', 'Signed runtime-template base workbook sheet contract drifted.');
    }
    const mutableParts = new Set(['docProps/core.xml', ...sheets.map((_sheet, index) => `xl/worksheets/sheet${index + 1}.xml`)]);
    files = Object.fromEntries(original);
    for (const pathname of mutableParts) {
      if (!original.has(pathname) || !generated[pathname]) fail('OUTPUT.BASE_PART_MISSING', `Signed runtime-template base part is missing: ${pathname}`);
      files[pathname] = generated[pathname];
    }
    for (const [pathname, bytes] of original) {
      if (!mutableParts.has(pathname) && digest(Buffer.from(files[pathname])) !== digest(bytes)) {
        fail('OUTPUT.UNDECLARED_PART_CHANGED', `Runtime-template patch changed an undeclared OOXML part: ${pathname}`);
      }
    }
    baseDigest = digest(Buffer.from(baseBytes));
  }
  const bytes = zip(files);
  const compiled = zipEntries(bytes);
  const runtimeSheets = workbook(compiled).map((sheet) => sheet.name);
  if (runtimeSheets.join('|') !== sheets.map((sheet) => sheet[0]).join('|')) fail('OUTPUT.STRUCTURE_INVALID', 'Runtime workbook sheet contract drifted.');
  const sheetXml = sheets.map((_sheet, index) => compiled.get(`xl/worksheets/sheet${index + 1}.xml`)?.toString('utf8') || '');
  if (sheetXml.some((source, index) => (source.match(/<row\b/gu) || []).length !== (source.match(/<row\b[^>]*\bht="[0-9.]+"[^>]*\bcustomHeight="1"/gu) || []).length)) {
    fail('OUTPUT.LAYOUT_INVALID', 'Every populated runtime workbook row must have a deterministic custom height.');
  }
  if (!/fitToWidth="2"[^>]*fitToHeight="1"/u.test(sheetXml[2]) || !/pageOrder="overThenDown"/u.test(sheetXml[2]) || (sheetXml[2].match(/<col\b/gu) || []).length !== 12) {
    fail('OUTPUT.LAYOUT_INVALID', 'Source trace must retain all twelve fields in a readable two-page-wide print layout.');
  }
  const xml = [...compiled].map(([name, value]) => name.endsWith('.xml') ? value.toString('utf8') : '').join('');
  if (!xml.includes('<f>') || !xml.includes('<dataValidations') || !xml.includes('<sheetProtection')) fail('OUTPUT.VALIDATION_INVALID', 'Runtime workbook formula/enum/protection contract is incomplete.');
  return {
    bytes,
    baseDigest: baseDigest || digest(bytes),
    patchDigest: digest(Buffer.from(canonical({
      mutableParts: ['docProps/core.xml', ...sheets.map((_sheet, index) => `xl/worksheets/sheet${index + 1}.xml`)],
      rows: parsed.rows,
      candidates: parsed.candidates,
      issues: parsed.issues,
      metadata:{sourceArtifactId:metadata.sourceArtifactId,governanceDigest:metadata.governanceDigest,baseDigest:baseDigest||digest(bytes)}
    }))),
    semanticDigest: digest(Buffer.from(canonical({ rows: parsed.rows, candidates:parsed.candidates,issues: parsed.issues,sourceArtifactId:metadata.sourceArtifactId,governanceDigest:metadata.governanceDigest,baseDigest:baseDigest||digest(bytes) })))
  };
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
  factorPreflight: 'omnia.create-associate.risk-factor.preflight.v1', factorWrite: 'omnia.create-associate.risk-factor.patch.v1', factorRead: 'omnia.create-associate.risk-factor.reconcile.v1',
  documentationPreflight: 'omnia.create-associate.documentation.preflight.v1', documentationWrite: 'omnia.create-associate.documentation.patch.v1', documentationRead: 'omnia.create-associate.documentation.reconcile.v1',
  evaluationPreflight: 'omnia.create-associate.evaluation.preflight.v1', evaluationWrite: 'omnia.create-associate.evaluation.submit.v1', evaluationRead: 'omnia.create-associate.evaluation.reconcile.v1',
  riskCatalog: 'omnia.create-associate.risk-control.catalog.v1', riskPreflight: 'omnia.create-associate.risk-control.preflight.v1', riskWrite: 'omnia.create-associate.risk-control.associate.v1', riskRead: 'omnia.create-associate.risk-control.reconcile.v1'
});
function rowField(row, governance, fieldId) {
  const alias = Object.entries(governance.fieldAliases?.[row.kind] || {}).find(([, canonicalId]) => canonicalId === fieldId)?.[0];
  return alias ? String(row.fields[alias] || '').trim() : '';
}
function objectType(kind) { return kind === 'APP' ? 'Application' : kind === 'TOOL' ? 'ITTool' : 'Infrastructure'; }
function objectSubtypeId(kind) { return kind === 'DB' ? 'Database' : kind === 'OS' ? 'OperatingSystem' : kind === 'TOOL' ? 'Tool' : ''; }
function authorityObjectSubtype(kind) { return kind === 'APP' ? 'Application' : objectSubtypeId(kind); }
function identityKey(prefix, value) { return `${prefix}:${digest(Buffer.from(canonical(value))).slice(0, 48)}`; }
function normalizeRait(value) {
  const normalized=String(value||'').normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return normalized==='higher'?'Higher':normalized==='lower'?'Lower':String(value||'').normalize('NFKC').trim();
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
function relationApplicable(relation, row, content, mode) {
  const scope = String(relation.objectType || '').toLocaleLowerCase('en-US');
  const kindMatch = row.kind === 'APP' ? scope.includes('application')
    : row.kind === 'DB' ? scope.includes('database')
      : row.kind === 'OS' ? scope.includes('operating system') || scope.includes('os')
        : scope.includes('tool');
  const subtypeMatch = row.kind !== 'APP' || !scope.includes('sap ecc') || String(content).toLocaleLowerCase('en-US').includes('sap ecc');
  return kindMatch && subtypeMatch && String(relation[`catalogPresent${mode}`] || '').startsWith('Y');
}
function linkRequired(relation, mode) { return String(relation[`linkRequired${mode}`] || '').startsWith('Y'); }
function uncertainError(error) { return error && error.code === 'CONNECTOR.RESPONSE_LOST'; }
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
function workflowSurface(latest){
  const run=latest?.run; const state=String(run?.state||''); const revision=Math.max(1,Number(run?.state_revision||1));
  const confirmationPending=state==='waiting_confirmation';
  const confirmed=['returning','verifying','uncertain','reconciling','succeeded'].includes(state)
    ||state==='failed'&&Array.isArray(latest?.returnProgress)&&latest.returnProgress.length>0;
  const returning=confirmed;
  const validationStarted=Boolean(run)&&!['draft','acquiring'].includes(state);
  const validationDone=['ready_for_review','waiting_confirmation','returning','verifying','uncertain','reconciling','succeeded'].includes(state);
  const failed=state==='failed'; const currentStepId=returning?'return':confirmationPending?'comments':validationStarted?'validate':'upload';
  return {revision,currentStepId,steps:[
    {stepId:'upload',label:'上传资料',state:run?'completed':'current',detail:'上传系统信息'},
    {stepId:'validate',label:'校验',state:failed&&!returning?'failed':validationDone?'completed':validationStarted?'current':'pending',detail:validationDone?'解析、规则与输出校验已持久化':validationStarted?'正在按 Run 事件推进':'等待上传'},
    {stepId:'comments',label:'Comments 复核',state:confirmed?'completed':confirmationPending?'current':'pending',detail:confirmed?'已确认':confirmationPending?'计划已冻结，等待 Comments 确认':'未提交'},
    {stepId:'return',label:'回传',state:state==='succeeded'?'completed':state==='uncertain'?'warning':failed&&returning?'failed':returning?'current':'pending',detail:state==='succeeded'?'全部命令读回完成':state==='uncertain'?'响应未知，仅允许只读核验':returning?`已确认；持久 Run 状态：${state}`:'等待 Comments 确认'}
  ]};
}
function progressSurface(latest,parsed){
  const run=latest?.run;if(!run)return{scopes:[],items:[],workflow:workflowSurface(latest)}; const scopeId=`run:${run.run_id}`;
  const rows=parsed?.rows||[];
  return {workflow:workflowSurface(latest),scopes:[{id:scopeId,parentId:scopeId,label:`Run ${run.run_id}`,parentLabel:'新建与关联',selected:true}],items:rows.map((row)=>({id:`element:${row.rowKey}`,scopeId,type:row.kind,title:row.elementId,subtitle:`目标工作区 ${String(row.fields['Omnia工作区']||'未填写')}；GRA ${String(row.fields['Derived GRA Name']||deriveGraName(row.elementId))}`,selectable:false,disabledReason:'目标身份来自当前受管资料，只读展示。',concurrencyToken:String(run.state_revision)}))};
}
function validationPresentation(parsed,live={}){
  const normalizedLive={...live};
  if(live.workspace_live?.state==='failed'){
    for(const checkId of ['omnia_id_conflicts','relationship_targets']){
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
    ['infrastructure_links','基础设施已关联系统',checkFailed('infrastructure_links')?'failed':'passed',checkFailed('infrastructure_links')?'DB/OS 必须恰好关联一个批内、同工作区 APP。':'DB/OS 已填写一个精确批内关联系统。'],
    ['infrastructure_rait','多系统关联的 RAIT 一致',checkFailed('infrastructure_rait')?'failed':'passed',checkFailed('infrastructure_rait')?'继承 RAIT 不唯一。':'DB/OS RAIT 为只读一致继承值。'],
    ['relationship_targets','关联目标存在且类型正确',liveState('relationship_targets'),checkFailed('relationship_targets')?'存在 0.2.1 不支持的批外 APP 或不精确目标。':liveCheck('relationship_targets').reason],
    ['workspace_presence','Omnia 工作区已填写',workspaceMissing?'failed':'passed',workspaceMissing?'存在缺失工作区。':'所有非排除行已填写工作区。'],
    ['factors_considered_ai_review','Factors Considered 智能复核',activeRows(parsed).some((row)=>row.kind==='APP')?'warning':'skipped',activeRows(parsed).some((row)=>row.kind==='APP')?'AI 复核未执行：当前 Provider 不可用或输入不满足评估条件；此项不参与阻断。':'本批无 APP，该项不适用。'],
    ['workspace_live','Omnia 工作区名称实时有效',liveCheck('workspace_live').state,liveCheck('workspace_live').reason]
  ];
  const pending=checks.filter((item)=>item[2]==='pending').length,failed=checks.filter((item)=>item[2]==='failed').length,completed=checks.length-pending;
  return {progress:{label:'校验进度',completed,total:checks.length,percent:Math.floor(completed*100/checks.length),state:failed?'failed':checks.some((item)=>item[2]==='warning')||warnings.length?'warning':pending?'pending':'passed',message:`${completed}/${checks.length} 项已执行；error ${errors.length}，warning ${warnings.length+(activeRows(parsed).some((row)=>row.kind==='APP')?1:0)}。`,items:checks.map(([itemId,label,state,detail])=>({itemId,label,state,detail}))},issues:issues.map((issue)=>{const row=parsed.rows.find((candidate)=>String(issue.fieldKey).startsWith(`${candidate.rowKey}.`));return{issueId:issue.issueId,scope:row?(issue.fieldKey.includes('.identity')?'element':'field'):'global',severity:['needs_input','blocking'].includes(issue.state)?'error':'warning',elementId:row?.elementId||'',fieldKey:issue.fieldKey,message:issue.message};})};
}
function reviewBlocked(parsed,live={}){return validationPresentation(parsed,live).progress.items.some((item)=>item.state==='failed'||item.state==='pending');}
const REVIEW_MATRIX=Object.freeze({
  APP:[['系统ID','元素ID','text',true,200],['APP类型','APP子类型','enum',true,120],['System Risk Classification','RAIT','enum',true,20],['Factors Considered','Factors Considered','textarea',true,8000],['Omnia工作区','Omnia工作区','text',true,200]],
  DB:[['数据库ID','元素ID','text',true,200],['DB 类型','DB子类型','enum',true,120],['Omnia工作区','Omnia工作区','text',true,200],['关联系统ID','关联系统ID','text',true,500],['Inherited System Risk Classification','RAIT（只读继承）','readonly',false,20]],
  OS:[['服务器ID','元素ID','text',true,200],['OS 类型','OS子类型','enum',true,120],['Omnia工作区','Omnia工作区','text',true,200],['关联系统ID','关联系统ID','text',true,500],['Inherited System Risk Classification','RAIT（只读继承）','readonly',false,20]],
  TOOL:[['IT TOOL ID','元素ID','text',true,200],['Tool 类型','Tool子类型','enum',true,120],['System Risk Classification','RAIT','enum',true,20],['Omnia工作区','Omnia工作区','text',true,200]]
});
const REVIEW_ENUMS=Object.freeze({'System Risk Classification':['Higher','Lower'],'APP类型':['Generic','SAP ECC'],'DB 类型':['Generic','Oracle','SQL'],'OS 类型':['Generic','UNIX','WIN'],'Tool 类型':['工单工具','身份和访问管理工具']});
function activeRows(parsed){const excluded=new Set(parsed.excludedRowKeys||[]);return (parsed.rows||[]).filter((row)=>!excluded.has(row.rowKey));}
function reviewCandidate(parsed,row,raw){return (parsed.candidates||[]).find((candidate)=>candidate.provenance?.rowKey===row.rowKey&&candidate.rawFieldKey===raw);}
function activeReviewIssues(parsed){const excluded=new Set(parsed.excludedRowKeys||[]),rows=parsed.rows||[];return (parsed.issues||[]).filter((issue)=>issue.state!=='resolved'&&!rows.some((row)=>excluded.has(row.rowKey)&&String(issue.fieldKey).startsWith(`${row.rowKey}.`)));}
function reviewPresentation(parsed){
  const rows=parsed.rows||[],active=activeRows(parsed),issues=activeReviewIssues(parsed);const firstIssue=issues.find((issue)=>['needs_input','blocking'].includes(issue.state));const selected=active.find((row)=>firstIssue&&String(firstIssue.fieldKey).startsWith(`${row.rowKey}.`))||active[0]||rows[0];const fields=[];
  for(const row of active){for(const [raw,label,inputKind,required,maxLength] of REVIEW_MATRIX[row.kind]){const candidate=reviewCandidate(parsed,row,raw);const messages=issues.filter((issue)=>issue.fieldKey===candidate?.fieldKey||String(issue.fieldKey).startsWith(`${row.rowKey}.`)&&issue.message.includes(raw)).map((issue)=>issue.message);fields.push({rowKey:row.rowKey,kind:row.kind,fieldKey:candidate?.fieldKey||`${row.rowKey}.readonly.${digest(raw)}`,rawFieldKey:raw,label,expectedRevision:Number(candidate?.revision||0),inputKind,currentValue:String(row.fields[raw]??''),allowedValues:REVIEW_ENUMS[raw]||[],required:Boolean(required),maxLength:Number(maxLength),editable:inputKind!=='readonly'&&Boolean(candidate),message:messages.join(' '),sourceSheet:candidate?.provenance?.sourceSheet||row.sourceSheet,sourceRow:Number(candidate?.provenance?.sourceRow||row.sourceRow),derivation:candidate?.provenance?.derivationRule||'verbatim_user_workbook_cell'});}const gra=reviewCandidate(parsed,row,'Derived GRA Name');fields.push({rowKey:row.rowKey,kind:row.kind,fieldKey:gra?.fieldKey||`${row.rowKey}.derived.gra-name`,rawFieldKey:'Derived GRA Name',label:'GRA 名称（派生）',expectedRevision:Number(gra?.revision||0),inputKind:'readonly',currentValue:String(gra?.value??deriveGraName(row.elementId)),allowedValues:[],required:true,maxLength:200,editable:false,message:'',sourceSheet:gra?.provenance?.sourceSheet||row.sourceSheet,sourceRow:Number(gra?.provenance?.sourceRow||row.sourceRow),derivation:gra?.provenance?.derivationRule||'v4.phase1-gra-name-from-element-id.v1'});const rawDescription=descriptionRawField(row.kind),description=reviewCandidate(parsed,row,rawDescription);fields.push({rowKey:row.rowKey,kind:row.kind,fieldKey:description?.fieldKey||`${row.rowKey}.derived.description`,rawFieldKey:rawDescription,label:'Description（派生）',expectedRevision:Number(description?.revision||1),inputKind:'readonly',currentValue:String(description?.value??row.elementId),allowedValues:[],required:true,maxLength:200,editable:false,message:'',sourceSheet:description?.provenance?.sourceSheet||'字段母版',sourceRow:Number(description?.provenance?.sourceRow||0),derivation:description?.provenance?.derivationRule||descriptionRuleId(row.kind)});}
  const kinds=[['APP','Application'],['DB','Database'],['OS','Operating System'],['TOOL','IT Tool']];return{selectedKind:selected?.kind||'APP',selectedRowKey:selected?.rowKey||'',elementTypes:kinds.map(([kind,label])=>{const typed=active.filter((row)=>row.kind===kind),typedIssues=issues.filter((issue)=>typed.some((row)=>String(issue.fieldKey).startsWith(`${row.rowKey}.`)));return{kind,label,count:typed.length,issueCount:typedIssues.filter((issue)=>['needs_input','blocking'].includes(issue.state)).length,warningCount:typedIssues.filter((issue)=>issue.state==='waived').length,disabled:typed.length===0,reason:typed.length?'':`本批没有 ${label} 行。`};}),elements:rows.map((row)=>{const rowIssues=issues.filter((issue)=>String(issue.fieldKey).startsWith(`${row.rowKey}.`));return{rowKey:row.rowKey,kind:row.kind,elementId:row.elementId,label:`${row.elementId} · ${row.sourceSheet}:${row.sourceRow}`,sourceSheet:row.sourceSheet,sourceRow:row.sourceRow,issueCount:rowIssues.filter((issue)=>['needs_input','blocking'].includes(issue.state)).length,warningCount:rowIssues.filter((issue)=>issue.state==='waived').length,derivedDisplay:`${deriveGraName(row.elementId)} / ${String(row.fields[descriptionRawField(row.kind)]||row.elementId)}`,blocking:rowIssues.some((issue)=>['needs_input','blocking'].includes(issue.state)),excluded:(parsed.excludedRowKeys||[]).includes(row.rowKey)};}),fields,issueOrder:issues.map((issue)=>{const row=rows.find((candidate)=>String(issue.fieldKey).startsWith(`${candidate.rowKey}.`));return{issueId:issue.issueId,rowKey:row?.rowKey||'',fieldKey:issue.fieldKey,severity:['needs_input','blocking'].includes(issue.state)?'error':'warning',message:issue.message};})};
}
function recomputeLocalIssues(parsed){
  const rows=activeRows(parsed);const issues=(parsed.issues||[]).filter((candidate)=>candidate.origin==='parser');
  const add=(row,code,fieldKey,issueType,state,message,checkId)=>{const created=issue('local',code,fieldKey||`${row?.rowKey||'global'}.${issueType}`,issueType,state,message,checkId);created.issueId=issueId('local',`${parsed.issueNamespace||'legacy'}|${code}`,created.fieldKey);issues.push(created);};
  for(const row of rows){for(const [raw,label,inputKind,required,maxLength] of REVIEW_MATRIX[row.kind]){const value=String(row.fields[raw]??'').normalize('NFC').trim(),candidate=reviewCandidate(parsed,row,raw);if(required&&!value)add(row,'LOCAL.REQUIRED_FIELD',candidate?.fieldKey||`${row.rowKey}.missing.${digest(raw)}`,'missing','needs_input',`${row.kind} ${row.elementId} 缺少必填字段 ${label}。`,'required_fields');if(value.length>Number(maxLength))add(row,'LOCAL.FIELD_TOO_LONG',candidate?.fieldKey,'invalid_enum','needs_input',`${row.kind} ${row.elementId} 的 ${label} 超过 ${maxLength} 字符上限。`,'valid_values');const allowed=REVIEW_ENUMS[raw];if(value&&allowed&&!allowed.includes(value))add(row,'LOCAL.INVALID_ENUM',candidate?.fieldKey,'invalid_enum','needs_input',`${row.kind} ${row.elementId} 的 ${label} 仅允许 ${allowed.join(' / ')}。`,'valid_values');if(raw===REVIEW_MATRIX[row.kind][0][0]){row.elementId=value;const illegal=/[\u0000-\u001f\u007f<>:"/\\|?*、，,;；]/u.test(value)||/^\.+$/u.test(value);if(illegal||deriveGraName(value).length>200)add(row,'LOCAL.ILLEGAL_ELEMENT_NAME',candidate?.fieldKey,'invalid_enum','needs_input',`${row.kind} 元素 ID 含非法字符，或派生 GRA 名超过 200 字符。`,'valid_values');}}}
  const identities=new Map(),graNames=new Map();for(const row of rows){const identity=String(row.elementId).toLocaleLowerCase('en-US'),gra=deriveGraName(row.elementId).toLocaleLowerCase('en-US');if(identities.has(identity)||graNames.has(gra))add(row,'LOCAL.DUPLICATE_IDENTITY',`${row.rowKey}.identity`,'conflict','blocking',`${row.kind} ${row.elementId} 的元素 ID 或派生 GRA 名在全批次重复。`,'unique_names');else{identities.set(identity,row);graNames.set(gra,row);}}
  const apps=rows.filter((row)=>row.kind==='APP');for(const row of rows.filter((item)=>['DB','OS'].includes(item.kind))){row.relations=String(row.fields['关联系统ID']||'').split(/[、,，;；]/u).map((value)=>value.trim()).filter(Boolean);if(row.relations.length!==1)add(row,'LOCAL.EXACTLY_ONE_APP_REQUIRED',`${row.rowKey}.relations`,'ambiguous','blocking',`${row.kind} ${row.elementId} 必须恰好关联一个批内 APP；0.2.1 不支持零个或多个继承边。`,'infrastructure_links');const matches=row.relations.length===1?apps.filter((app)=>app.elementId.toLocaleLowerCase('en-US')===row.relations[0].toLocaleLowerCase('en-US')):[];if(row.relations.length===1&&matches.length===0)add(row,'UNSUPPORTED.EXTERNAL_APP_REFERENCE',`${row.rowKey}.relationship-target-live`,'contract_mismatch','blocking',`${row.kind} ${row.elementId} 引用批外 APP ${row.relations[0]}；0.2.1 未冻结外部目标与 RAIT，禁止回传。`,'relationship_targets');if(matches.length>1)add(row,'LOCAL.AMBIGUOUS_APP_REFERENCE',`${row.rowKey}.relations`,'ambiguous','blocking',`${row.kind} ${row.elementId} 的批内 APP 关联存在歧义。`,'infrastructure_links');if(matches.length===1){const source=matches[0],rowWorkspace=String(row.fields['Omnia工作区']||'').normalize('NFKC').trim(),sourceWorkspace=String(source.fields['Omnia工作区']||'').normalize('NFKC').trim();if(rowWorkspace!==sourceWorkspace)add(row,'LOCAL.CROSS_WORKSPACE_INHERITANCE',`${row.rowKey}.relations`,'contract_mismatch','blocking',`${row.kind} ${row.elementId} 与 APP ${source.elementId} 不在同一 Omnia 工作区。`,'infrastructure_links');const mode=String(source.fields['System Risk Classification']||'');if(!['Higher','Lower'].includes(mode))add(row,'LOCAL.RAIT_INHERITANCE_INVALID',`${row.rowKey}.inheritance`,'conflict','blocking',`${row.kind} ${row.elementId} 的唯一 APP RAIT 不可用。`,'infrastructure_rait');else row.fields['Inherited System Risk Classification']=mode;}}
  parsed.issues=issues;return issues;
}
function reviewSurface(latest,plan,compiled,message){const parsed=plan.parsed,progress=progressSurface(latest,parsed),validation=validationPresentation(parsed,plan.liveValidation||{}),blocker=reviewBlocked(parsed,plan.liveValidation||{}),activeCount=activeRows(parsed).length;return{stateVersion:Number(latest.run.state_revision),status:blocker?'blocked':'ready',statusMessage:message,scopes:progress.scopes,items:progress.items,workflow:progress.workflow,progress:validation.progress,issues:validation.issues,review:reviewPresentation(parsed),editors:[],artifacts:[],actions:[
  {actionId:'download-source-template',enabled:false,reason:'校验步骤不显示上传动作。'},{actionId:'stage-source-workbook',enabled:false,reason:'请先返回上传。'},{actionId:'confirm-upload',enabled:false,reason:'当前资料已经确认。'},{actionId:'validate-staged-upload',enabled:false,reason:'当前校验已经完成。'},
  {actionId:'back-to-upload',enabled:true,reason:'离开 Review 后才允许重新选择资料。'},{actionId:'restart-run',enabled:true,reason:'取消当前可编辑 Run；旧 Artifact、修订和事件保留审计。'},{actionId:'apply-revisions',enabled:true,reason:'保存所有 dirty 字段并完整重跑校验。'},{actionId:'remove-batch-row',enabled:activeCount>1,reason:activeCount>1?'仅移出本批，不调用 Connector，不删除 Omnia。':'批次仅剩一行，禁止移除。'},{actionId:'revalidate-all',enabled:true,reason:'在原 Run 上重跑全部本地与可用实时校验。'},{actionId:'prepare-return',enabled:!blocker,reason:blocker?'存在 error、未执行实时项或全局 blocker。':''}]};}
function uploadSurface(latest,message,fresh=false){
  const run=latest?.run;const staged=run?.state==='acquiring';const editable=staged||['needs_input','ready_for_review'].includes(String(run?.state||''));
  const workflow={revision:Math.max(1,Number(latest?.run?.state_revision||1)),currentStepId:'upload',steps:[
    {stepId:'upload',label:'上传资料',state:'current',detail:'上传系统信息'},
    {stepId:'validate',label:'校验',state:'pending',detail:'等待上传'},
    {stepId:'comments',label:'Comments 复核',state:'pending',detail:'未提交'},
    {stepId:'return',label:'回传',state:'pending',detail:'等待 Comments 确认'}
  ]};
  const source=staged?(latest.artifacts||[]).filter((item)=>String(item.kind)==='source').slice(-1):[];
  return{stateVersion:Number(run?.state_revision||1),status:'ready',statusMessage:message,scopes:[],items:[],workflow,clearFields:['progress','review'],issues:[],editors:[],artifacts:source.map((item)=>({artifactId:String(item.artifact_id),kind:'source',name:String(item.original_name),sha256:String(item.sha256),sizeBytes:Number(item.size_bytes),available:false,reason:'待确认上传'})),actions:[
    {actionId:'download-source-template',enabled:true,reason:''},{actionId:'stage-source-workbook',enabled:true,reason:''},{actionId:'confirm-upload',enabled:staged,reason:staged?'':'请先选择或拖入一个 .xlsx 文件。'},{actionId:'validate-staged-upload',enabled:false,reason:'等待确认上传。'},
    {actionId:'restart-run',enabled:editable,reason:editable?'取消当前可编辑 Run；下一次上传建立新 Run。':'当前没有可重置的可编辑 Run。'},{actionId:'apply-revisions',enabled:false,reason:'等待校验。'},{actionId:'remove-batch-row',enabled:false,reason:'等待校验。'},{actionId:'revalidate-all',enabled:false,reason:'等待校验。'},{actionId:'back-to-upload',enabled:false,reason:'当前已在上传步骤。'},{actionId:'prepare-return',enabled:false,reason:'等待校验通过。'}]};
}
function processingSurface(latest,message){
  const labels=[['template_structure','模板结构可识别'],['required_fields','必填项目已填写'],['valid_values','名称与填写内容合法'],['unique_names','批次内元素 ID 与 GRA 名称唯一'],['omnia_id_conflicts','已核验当前 Pack 与回收站中的同名元素影响'],['infrastructure_links','基础设施已关联系统'],['infrastructure_rait','多系统关联的 RAIT 一致'],['relationship_targets','关联目标存在且类型正确'],['workspace_presence','Omnia 工作区已填写'],['factors_considered_ai_review','Factors Considered 智能复核'],['workspace_live','Omnia 工作区名称实时有效']];
  return{stateVersion:Number(latest.run.state_revision),status:'loading',statusMessage:message,scopes:[],items:[],workflow:workflowSurface(latest),progress:{label:'校验进度',completed:0,total:labels.length,percent:0,state:'running',message:'正在校验 0/11',items:labels.map(([itemId,label])=>({itemId,label,state:'pending',detail:'等待后台校验。'}))},issues:[],editors:[],artifacts:[],clearFields:['review'],actions:[
    {actionId:'download-source-template',enabled:false,reason:'正在校验。'},{actionId:'stage-source-workbook',enabled:false,reason:'正在校验。'},{actionId:'confirm-upload',enabled:false,reason:'已确认上传。'},{actionId:'validate-staged-upload',enabled:true,reason:''},{actionId:'restart-run',enabled:false,reason:'后台校验已开始，不允许重放或取消中间状态。'},{actionId:'apply-revisions',enabled:false,reason:'正在校验。'},{actionId:'remove-batch-row',enabled:false,reason:'正在校验。'},{actionId:'revalidate-all',enabled:false,reason:'正在校验。'},{actionId:'back-to-upload',enabled:false,reason:'正在校验。'},{actionId:'prepare-return',enabled:false,reason:'正在校验。'}]};
}
function returnSurface(latest,message){
  const run=latest?.run;const progress=progressSurface(latest);const state=String(run?.state||'');
  const terminal=['succeeded','failed','cancelled'].includes(state);const status=state==='succeeded'?'ready':state==='failed'?'error':state==='uncertain'?'stale':'loading';
  const intents=latest?.returnProgress||[]; const completed=intents.filter((item)=>item.state==='verified'||['readback_verified','closed_not_applied'].includes(item.command_state)).length; const percent=state==='succeeded'?100:intents.length?Math.floor(completed*100/intents.length):0;
  const intentState=(item)=>item.state==='verified'||['readback_verified','closed_not_applied'].includes(item.command_state)?'passed':item.state==='uncertain'||item.command_state==='uncertain'?'uncertain':item.state==='failed'||item.command_state==='failed'?'failed':['submitted','committed'].includes(item.command_state)?'running':'pending';
  const category=(item)=>{const key=String(item.target_key||''),kind=String(item.target_kind||'');if(kind==='object'&&key.startsWith('object|'))return'元素';if(kind==='object'&&key.startsWith('gra|'))return'GRA';if(kind==='relation')return'关系';if(kind==='risk_control')return'Risk-Control';return'设置';};
  const categoryOrder=['元素','GRA','关系','Risk-Control','设置'];
  const grouped=categoryOrder.map((label)=>({label,rows:intents.filter((item)=>category(item)===label)})).filter((group)=>group.rows.length).map((group,index)=>{
    const states=group.rows.map(intentState),done=states.filter((value)=>value==='passed').length,failedCount=states.filter((value)=>value==='failed').length,uncertainCount=states.filter((value)=>value==='uncertain').length,runningCount=states.filter((value)=>value==='running').length;
    const groupState=failedCount?'failed':uncertainCount?'uncertain':runningCount?'running':done===group.rows.length?'passed':'pending';
    return{itemId:`return-group-${index}`,label:group.label,state:groupState,detail:`已完成 ${done}/${group.rows.length}${failedCount?`；失败 ${failedCount}`:''}${uncertainCount?`；待只读核验 ${uncertainCount}`:''}${runningCount?`；执行中 ${runningCount}`:''}`};
  });
  return {stateVersion:Number(run?.state_revision||1),status,statusMessage:message||`回传阶段 ${state} / revision ${Number(run?.state_revision||0)}`,workflow:progress.workflow,clearFields:['review'],
    progress:{label:'回传进度',completed:state==='succeeded'?intents.length:completed,total:intents.length,percent,state:state==='uncertain'?'uncertain':state==='failed'?'failed':state==='succeeded'?'passed':'running',message:state==='succeeded'?'已完成；停留在回传页面。':state==='uncertain'?'响应未知，禁止重放；请执行只读核验。':message||`当前阶段 ${state}`,items:grouped},
    scopes:progress.scopes,items:progress.items,editors:[],issues:[],artifacts:(latest?.artifacts||[]).filter((item)=>String(item.kind)!=='source').map((item)=>({artifactId:String(item.artifact_id),kind:String(item.kind),name:String(item.original_name),sha256:String(item.sha256),sizeBytes:Number(item.size_bytes),available:true,reason:''})),actions:[
      {actionId:'stage-source-workbook',enabled:terminal,reason:terminal?'':'回传计划已冻结；请先完成、核验或终止当前 Run。'},
      {actionId:'restart-run',enabled:false,reason:'回传计划已冻结；重新开始不能掩盖确认、写入或 uncertain 状态。'},
      {actionId:'apply-revisions',enabled:false,reason:'回传阶段不接受字段修订。'},
      {actionId:'prepare-return',enabled:false,reason:'回传计划已冻结或已完成。'}]};
}

function createFeatureWorker(dependencies) {
  if (!dependencies?.store?.call) fail('WORKER.STORE_REQUIRED', 'A typed persistent Store port is required.');
  const store = dependencies.store;
  const connector = dependencies.connector;
  if (!connector?.invoke) fail('WORKER.CONNECTOR_REQUIRED', 'A signed Operation Connector port is required.');
  const governance = dependencies.governance || (GOVERNANCE.startsWith('__') ? null : JSON.parse(GOVERNANCE));
  if (!governance || governance.sourceSha256 !== V8_SHA256 || governance.fieldCount !== 187 || governance.relationCount !== 68) {
    fail('GOVERNANCE.NOT_FROZEN', 'The signed V8-derived governance contract is unavailable or drifted.');
  }
  const governanceSemanticDigest = digest(Buffer.from(canonical({
    fields: governance.fields, relations: governance.relations, scoringItems: governance.scoringItems, derivationRules: governance.derivationRules
  })));
  const ensureStagedPlan=async(latest)=>{
    const run=latest?.run;if(!run||run.state!=='acquiring'||!run.source_artifact_id)fail('RUN.NOT_STAGED','The latest Run has no recoverable staged source.');
    const existing=await store.call('loadPlan',String(run.run_id));if(existing?.descriptor)return existing;
    const artifact=await store.call('readArtifactBytes',{artifactId:String(run.source_artifact_id)});
    if(String(artifact.runId)!==String(run.run_id)||String(artifact.traceId)!==String(run.trace_id)||artifact.kind!=='source')fail('ARTIFACT.RUN_BINDING_MISMATCH','Recovered staged artifact binding drifted.');
    const descriptor={schemaVersion:'omnia.feature-artifact/v1',artifactId:String(artifact.artifactId),runId:String(artifact.runId),traceId:String(artifact.traceId),featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,surfaceId:'create-associate.workbench',kind:'source',originalName:String(artifact.originalName),mediaType:String(artifact.mediaType),sizeBytes:Number(artifact.sizeBytes),sha256:String(artifact.sha256),importedAt:String(artifact.importedAt)};
    const recovered={schemaVersion:'omnia.create-associate.staged-upload/v1',planId:String(run.run_id),runId:String(run.run_id),traceId:String(run.trace_id),descriptor,stageState:'acquiring',updatedAt:new Date().toISOString()};
    await store.call('savePlan',recovered);return recovered;
  };
  if (!Array.isArray(governance.fields) || governance.fields.length !== 187
    || !Array.isArray(governance.relations) || governance.relations.length !== 68
    || !Array.isArray(governance.scoringItems) || governance.scoringItems.length !== 15
    || governance.semanticDigest !== governanceSemanticDigest) {
    fail('GOVERNANCE.IR_DRIFT', 'The signed governance IR semantic digest or inventory drifted.');
  }
  const graNameRule=governance.derivationRules.find((item)=>item.ruleId==='v4.phase1-gra-name-from-element-id.v1');
  if(!graNameRule||graNameRule.algorithm!=='prefix_literal'||graNameRule.prefix!=='GRA-')fail('GOVERNANCE.GRA_NAME_RULE_MISSING','Signed v4 canonical GRA naming rule is unavailable.');

  async function compileInstance(parsed, descriptor, runId, traceId) {
    const runtimeBase = await store.call('readManagedAssetBytes', { memberPath: 'backend/runtime-template-base.xlsx' });
    if (runtimeBase.assetKind !== 'runtime_template_base' || !/^[0-9a-f]{64}$/u.test(String(runtimeBase.memberDigest || ''))) {
      fail('OUTPUT.BASE_NOT_MANAGED', 'The signed runtime-template base workbook is unavailable.');
    }
    const compiled = buildRuntimeWorkbook(
      parsed,
      { runId, traceId, sourceArtifactId: descriptor.artifactId, governanceDigest: governance.sourceSha256 },
      Buffer.from(runtimeBase.contentBase64, 'base64')
    );
    const output = await store.call('commitArtifact', {
      runId, kind: 'template_instance', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      originalName: `create-associate-${runId}.xlsx`, extension: '.xlsx', sourceArtifactId: descriptor.artifactId,
      sha256: digest(compiled.bytes), contentBase64: compiled.bytes.toString('base64')
    });
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

  async function invoke(operationId, connectorBinding, request) {
    return connector.invoke({ schemaVersion: 'omnia.operation-invocation/v1', featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION, operationId, request: { connectorBinding, ...request } });
  }
  function authorityRequest(checkpoint, context) {
    const workspaceNames = [...new Set(activeRows(checkpoint.parsed).map((row) => rowField(row, governance, `P1.${row.kind}.IT.WORKSPACE`)))];
    const graContents = [...new Map(activeRows(checkpoint.parsed).map((row) => {
      const value = rowField(row, governance, `P1.${row.kind}.GRA.GRA_CONTENT`);
      return [`${row.kind}|${value}`, { elementKind: row.kind, objectType: objectType(row.kind),
        objectSubtype: authorityObjectSubtype(row.kind), contentName: value }];
    })).values()];
    if (workspaceNames.some((value) => !value) || graContents.some((value) => !value.contentName)) fail('RETURN.AUTHORITY_INPUT_MISSING', 'Workspace or GRA content input is missing.');
    return { connectorBinding: context.connectorBinding, allowedWorkspaceIds: context.safetyLock.workspaceIds, query: { workspaceNames, graContents } };
  }
  async function runReviewLiveValidation(checkpoint,context){
    checkpoint.parsed.issues=(checkpoint.parsed.issues||[]).filter((candidate)=>candidate.origin!=='live_validation'&&!String(candidate.issueId||'').startsWith('live-'));
    const liveIssue=(code,fieldKey,issueType,state,message,checkId)=>{const created=issue('live_validation',code,fieldKey,issueType,state,message,checkId);created.issueId=issueId('live_validation',`${checkpoint.parsed.issueNamespace||checkpoint.planId||'legacy'}|${code}`,fieldKey);return created;};
    const failedLiveChecks=(reason)=>({omnia_id_conflicts:{state:'failed',reason},relationship_targets:{state:'failed',reason},workspace_live:{state:'failed',reason}});
    const binding=context?.connectorBinding,safety=context?.safetyLock;if(!binding?.connectorId||Number(binding.sessionGeneration)<1||!binding.engagementId){const reason='当前没有可用的 Remote Connector binding，无法执行 APP 身份/回收站、非 APP 活动对象、关系目标类型与工作区实时检查；连接后可在原 Run 重试。';checkpoint.parsed.issues.push(liveIssue('LIVE.WORKSPACE_UNAVAILABLE','global.workspace_live','contract_mismatch','blocking',reason,'workspace_live'));return failedLiveChecks(reason);}if(!Array.isArray(safety?.workspaceIds)||!safety.workspaceIds.length){const reason='当前 Pack Workspace 安全范围为空，无法执行 APP 身份/回收站、非 APP 活动对象、关系目标类型与工作区实时检查；请启用安全范围后在原 Run 重新校验。';checkpoint.parsed.issues.push(liveIssue('LIVE.SAFETY_SCOPE_UNAVAILABLE','global.workspace_live','contract_mismatch','blocking',reason,'workspace_live'));return failedLiveChecks(reason);}
    try{const query=authorityRequest(checkpoint,context).query;const authority=await invoke(RETURN_OPERATIONS.authority,binding,{allowedWorkspaceIds:safety.workspaceIds,query});const byName=new Map((authority.workspaces||[]).map((item)=>[String(item.name).normalize('NFKC'),item.workspaceId]));const missing=query.workspaceNames.filter((name)=>!byName.has(String(name).normalize('NFKC')));if(missing.length){const reason=`Omnia 工作区实时不存在或不在安全范围：${missing.join(', ')}；因此 APP 身份/回收站、非 APP 活动对象与关系目标类型检查未执行。`;checkpoint.parsed.issues.push(liveIssue('LIVE.WORKSPACE_NOT_FOUND','global.workspace_live','contract_mismatch','blocking',reason,'workspace_live'));return failedLiveChecks(reason);}
      checkpoint.liveIdentityResolutions={};
      let existing=0,creatable=0,identityBlocks=0;
      for(const row of activeRows(checkpoint.parsed)){
        const workspaceId=byName.get(rowField(row,governance,`P1.${row.kind}.IT.WORKSPACE`).normalize('NFKC'));
        if(row.kind==='APP'){
          const request=applicationIdentityRequest(row.elementId,workspaceId,rowField(row,governance,'P1.APP.GRA.RAIT_CONCLUSION'));
          try{
            const observed=await invoke(RETURN_OPERATIONS.objectIdentityResolve,binding,request);
            const identity=inspectApplicationIdentity(observed,request);
            checkpoint.liveIdentityResolutions[row.rowKey]={operationId:RETURN_OPERATIONS.objectIdentityResolve,target:request.target,query:request.query,disposition:identity.disposition,reasonCode:identity.reasonCode,resolved:{objectId:identity.objectId,riskAssessmentId:identity.riskAssessmentId},evidence:observed?.evidence||null};
            if(!identity.accepted){identityBlocks+=1;checkpoint.parsed.issues.push(liveIssue('LIVE.APP_IDENTITY_BLOCKED',`${row.rowKey}.identity`,'conflict','blocking',`APP ${row.elementId} 身份解析被拒绝：${identity.reasonCode}。`,'omnia_id_conflicts'));}
            else if(identity.disposition!=='create') existing+=1;
          }catch(error){identityBlocks+=1;checkpoint.parsed.issues.push(liveIssue('LIVE.APP_IDENTITY_FAILED',`${row.rowKey}.identity`,'contract_mismatch','blocking',`APP ${row.elementId} 身份解析失败：${String(error.message||error)}`,'omnia_id_conflicts'));}
          continue;
        }
        const request={target:{targetIdentityKey:identityKey('review-object',[row.kind,row.elementId,workspaceId]),workspaceId},query:{objectType:objectType(row.kind),subtypeId:objectSubtypeId(row.kind),externalId:row.elementId,workspaceId,graName:deriveGraName(row.elementId)}};
        const observed=await invoke(RETURN_OPERATIONS.objectPreflight,binding,request);const identity=inspectGenericIdentity(observed,request);
        checkpoint.liveIdentityResolutions[row.rowKey]={operationId:RETURN_OPERATIONS.objectPreflight,target:request.target,query:request.query,matchState:identity.state,resolved:{objectId:identity.objectId},evidence:identity.evidence};
        if(!identity.accepted){identityBlocks+=1;checkpoint.parsed.issues.push(liveIssue('LIVE.NON_APP_IDENTITY_BLOCKED',`${row.rowKey}.identity`,'conflict','blocking',`${row.kind} ${row.elementId} 身份解析被拒绝：${identity.reasonCode}。`,'omnia_id_conflicts'));}
        else if(identity.state==='active')existing+=1;
        else if(identity.state==='none')creatable+=1;
      }
      const targetFailed=checkpoint.parsed.issues.some((candidate)=>candidate.state==='blocking'&&candidate.checkId==='relationship_targets');
      const conflictsFailed=identityBlocks>0;
      const conflictReason=`APP/DB/OS/Tool 活动、回收站与歧义身份解析已执行；发现 ${existing} 个可恢复/复用对象、${creatable} 个可进入创建预检的新对象${identityBlocks?`，${identityBlocks} 个身份被拒绝或解析失败`:''}。`;
      return{omnia_id_conflicts:{state:conflictsFailed?'failed':'passed',reason:conflictReason},relationship_targets:{state:targetFailed?'failed':'passed',reason:targetFailed?'存在 0.2.1 不支持的批外 APP 或不精确目标。':'所有 DB/OS 目标均为批内唯一、同工作区 APP。'},workspace_live:{state:'passed',reason:`${query.workspaceNames.length} 个工作区已按当前 Pack 权威目录精确匹配。`}};
    }catch(error){const reason=`实时校验失败（APP 身份/回收站、非 APP 活动对象、关系目标类型或工作区检查未闭合；可在原 Run 重试）：${String(error.message||error)}`;checkpoint.parsed.issues.push(liveIssue('LIVE.VALIDATION_FAILED','global.workspace_live','contract_mismatch','blocking',reason,'workspace_live'));return failedLiveChecks(reason);}
  }
  async function buildReturnPreparation(checkpoint, context) {
    if(reviewBlocked(checkpoint.parsed,checkpoint.liveValidation||{})) fail('RETURN.REVIEW_BLOCKED','Canonical Review contains a failed or pending check; prepare-return is forbidden.');
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
    const plannedApps = activeRows(checkpoint.parsed).filter((item) => item.kind === 'APP').map((item) => ({
      elementId: item.elementId, workspaceName: rowField(item, governance, 'P1.APP.IT.WORKSPACE'),
      mode: rowField(item, governance, 'P1.APP.GRA.RAIT_CONCLUSION')
    }));
    const rowsPrepared = []; const targets = []; const preflights = [];
    for (const row of activeRows(checkpoint.parsed)) {
      const type = objectType(row.kind); const workspaceName = rowField(row, governance, `P1.${row.kind}.IT.WORKSPACE`);
      const workspaceId = workspaces.get(workspaceName.normalize('NFKC'));
      const contentName = rowField(row, governance, `P1.${row.kind}.GRA.GRA_CONTENT`);
      const content = graContents.get(`${row.kind}|${contentName.normalize('NFKC')}`);
      if (!workspaceId || !content) fail('RETURN.AUTHORITY_UNRESOLVED', `Authority identity is unavailable for ${row.kind}/${row.elementId}.`);
      const objectTarget = { targetIdentityKey: identityKey('object', [row.kind, row.elementId, workspaceId]), workspaceId };
      const declaredMode = row.kind === 'APP' || row.kind === 'TOOL'
        ? normalizeRait(rowField(row, governance, `P1.${row.kind}.GRA.RAIT_CONCLUSION`)) : '';
      const subtypeId=objectSubtypeId(row.kind);
      const appIdentityRequest=row.kind==='APP'?applicationIdentityRequest(row.elementId,workspaceId,declaredMode,objectTarget.targetIdentityKey):null;
      const objectQuery = appIdentityRequest?.query||{ objectType: type, subtypeId, externalId: row.elementId, workspaceId,graName:deriveGraName(row.elementId) };
      const objectObserved = await invoke(row.kind==='APP'?RETURN_OPERATIONS.objectIdentityResolve:RETURN_OPERATIONS.objectPreflight,
        context.connectorBinding,appIdentityRequest||{ target: objectTarget, query: objectQuery });
      const appIdentity=row.kind==='APP'?inspectApplicationIdentity(objectObserved,appIdentityRequest):null;
      const genericIdentity=row.kind==='APP'?null:inspectGenericIdentity(objectObserved,{target:objectTarget,query:objectQuery});
      if(appIdentity&&!appIdentity.accepted) fail('RETURN.APP_IDENTITY_BLOCKED',`APP ${row.elementId} identity resolution blocked Return preparation: ${appIdentity.reasonCode}.`);
      if(genericIdentity&&!genericIdentity.accepted) fail('RETURN.GENERIC_IDENTITY_BLOCKED',`${row.kind} ${row.elementId} identity resolution blocked Return preparation: ${genericIdentity.reasonCode}.`);
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
        target: { targetIdentityKey: identityKey('gra', [row.rowKey, workspaceId]), workspaceId },
        query: { entityId: objectId, itElementType: type, name: deriveGraName(row.elementId), workspaceId }
      });
      if(graObserved.found) await invoke(RETURN_OPERATIONS.graRead,context.connectorBinding,{target:{targetIdentityKey:identityKey('gra',[row.rowKey,workspaceId]),workspaceId},riskAssessmentId:responseId(graObserved.item,'GRA preflight'),query:{entityId:objectId,name:deriveGraName(row.elementId),itElementType:type,inkContentId:content.inkContentId,typeId:content.typeId}});
      let mode = declaredMode; let inheritanceSources = [];
      if (['DB','OS'].includes(row.kind)) {
        if(row.relations.length!==1) fail('RETURN.APP_REFERENCE_CARDINALITY',`${row.kind} ${row.elementId} requires exactly one in-workbook APP inheritance edge.`);
        inheritanceSources = row.relations.map((externalId) => {
          const matches = plannedApps.filter((item) => item.elementId.toLocaleLowerCase('en-US') === externalId.toLocaleLowerCase('en-US'));
          if (matches.length !== 1) fail('RETURN.APP_REFERENCE_AMBIGUOUS', `${row.kind} ${row.elementId} does not reference exactly one in-workbook APP identity for ${externalId}.`);
          if(matches[0].workspaceName.normalize('NFKC')!==workspaceName.normalize('NFKC')) fail('RETURN.APP_REFERENCE_WORKSPACE_DRIFT',`${row.kind} ${row.elementId} and APP ${externalId} must use the same frozen Workspace.`);
          return { externalId, workspaceName: matches[0].workspaceName, plannedMode: matches[0].mode };
        });
        const modes = [...new Set(inheritanceSources.map((item) => item.plannedMode))];
        if (modes.length !== 1 || !['Higher','Lower'].includes(modes[0])) fail('RETURN.RAIT_INHERITANCE_AMBIGUOUS', `${row.kind} ${row.elementId} has no unique planned APP RAIT inheritance value.`);
        mode = modes[0];
      }
      if (mode && !['Higher', 'Lower'].includes(mode)) fail('RETURN.RAIT_INVALID', `${row.kind} ${row.elementId} has an unsupported RAIT value.`);
      const prepared = { rowKey: row.rowKey, kind: row.kind, elementId: row.elementId, objectType: type,
        workspaceName, workspaceId, content, subtypeId, mode, declaredMode, inheritanceSources, objectTarget, objectQuery, objectObserved, objectId,graName:deriveGraName(row.elementId),
        identityDisposition:appIdentity?.disposition||'',identityResolution:appIdentity?{operationId:RETURN_OPERATIONS.objectIdentityResolve,disposition:appIdentity.disposition,reasonCode:appIdentity.reasonCode,resolved:{objectId:appIdentity.objectId,riskAssessmentId:appIdentity.riskAssessmentId},evidence:objectObserved?.evidence||null}:null,
        graObserved, graId: graObserved.found ? responseId(graObserved.item, 'GRA preflight') : '', relations: row.relations };
      prepared.description=String(row.fields[descriptionRawField(row.kind)]||'');
      if(prepared.description!==row.elementId) fail('RETURN.DESCRIPTION_DERIVATION_DRIFT',`${row.kind} ${row.elementId} description differs from the signed derived field revision.`);
      if(row.kind==='APP'){
        prepared.isRelevant=row.fields['Derived Application Is Relevant'];
        if(prepared.isRelevant!==false) fail('RETURN.IS_RELEVANT_RULE_DRIFT',`APP ${row.elementId} isRelevant differs from the signed constant-false rule revision.`);
        prepared.isDataAvailable=row.fields['Derived Application Is Data Available'];
        if(prepared.isDataAvailable!==false) fail('RETURN.DATA_AVAILABILITY_RULE_DRIFT',`APP ${row.elementId} isDataAvailable differs from the signed v4-compatible constant-false rule revision.`);
        if(!objectId)prepared.dataAvailability=freezeAppDataAvailability('create',undefined,prepared.isDataAvailable);
        if(!String(content.itElementTypeId||'')) fail('RETURN.APP_TYPE_AUTHORITY_MISSING',`APP ${row.elementId} has no live authority-resolved IT Element type identity.`);
      }
      rowsPrepared.push(prepared);
      targets.push({ kind: 'object', key: `object|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: type, externalId: row.elementId,
        disposition:row.kind==='APP'?prepared.identityDisposition:(objectId?'reuse':'create'),resolvedObjectId:objectId,mutationOperationId:RETURN_OPERATIONS.objectCreate,
        identityResolution:prepared.identityResolution,description:row.kind==='APP'?prepared.description:undefined,operationTargetIdentityKey:objectTarget.targetIdentityKey,
        evidenceOperationIds:row.kind==='APP'?[RETURN_OPERATIONS.objectRead,RETURN_OPERATIONS.objectIdentityResolve,RETURN_OPERATIONS.objectCreatePreflight]:[RETURN_OPERATIONS.objectRead,RETURN_OPERATIONS.objectPreflight,RETURN_OPERATIONS.objectCreatePreflight] });
      targets.push({ kind: 'object', key: `gra|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', externalId: row.elementId,
        disposition:graObserved.found?'reuse':'create',resolvedObjectId:graObserved.found?responseId(graObserved.item,'GRA preflight'):'',entityObjectTargetKey:`object|${row.rowKey}`,
        contentIdentity:{inkContentId:content.inkContentId,typeId:content.typeId},mutationOperationId:RETURN_OPERATIONS.graCreate,
        operationTargetIdentityKey:identityKey('gra',[row.rowKey,workspaceId]),evidenceOperationIds:[RETURN_OPERATIONS.graRead,RETURN_OPERATIONS.graPreflight] });
      if(row.kind==='APP') targets.push({kind:'field',key:`object-settings|${row.rowKey}`,rowKey:row.rowKey,workspace:workspaceId,objectType:type,objectTargetKey:`object|${row.rowKey}`,typeId:content.itElementTypeId,isRelevant:prepared.isRelevant,isDataAvailable:prepared.dataAvailability?.value,dataAvailabilityDisposition:prepared.dataAvailability?.disposition,
        mutationOperationId:RETURN_OPERATIONS.objectSettingsWrite,operationTargetIdentityKey:identityKey('object-settings',[row.rowKey]),evidenceOperationIds:[RETURN_OPERATIONS.objectSettingsRead]});
      targets.push({ kind: 'field', key: `gra-status|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, fieldId: 'status', value: 'EvaluationStarted',
        mutationOperationId:RETURN_OPERATIONS.graStateWrite,operationTargetIdentityKey:identityKey('gra-state',[row.rowKey,'status']),evidenceOperationIds:[RETURN_OPERATIONS.graStateRead] });
      if (['APP','DB','OS','TOOL'].includes(row.kind)) targets.push({ kind: 'field', key: `gra-rait|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, fieldId: 'itElementRaitConclusionLevelId', value: mode,
        mutationOperationId:RETURN_OPERATIONS.graStateWrite,operationTargetIdentityKey:identityKey('gra-state',[row.rowKey,'rait']),evidenceOperationIds:[RETURN_OPERATIONS.graStateRead] });
      for (const relation of row.relations) targets.push({ kind: 'relation', key: `element-relation|${row.rowKey}|${relation}`, rowKey: row.rowKey, workspace: workspaceId, relationType: 'InfrastructureApplication',
        sourceObjectTargetKey:`object|${row.rowKey}`,targetExternalId:relation,mutationOperationId:RETURN_OPERATIONS.relationWrite,
        operationTargetIdentityMode:'resolved_relation',operationTargetIdentityKey:'post-create-resolution',evidenceOperationIds:[RETURN_OPERATIONS.relationRead] });
      const selectedGovernance = governance.relations.filter((relation) => relationApplicable(relation, row, contentName, mode || 'Higher'));
      for (const relation of selectedGovernance.filter((item) => linkRequired(item, mode || 'Higher'))) targets.push({
        kind: 'risk_control', key: `risk-control|${row.rowKey}|${relation.relationId}`, rowKey: row.rowKey, workspace: workspaceId,
        objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, relationId: relation.relationId, riskName: relation.riskName, controlName: relation.controlName,
        classification: relation[`classification${mode || 'Higher'}`],mutationOperationId:RETURN_OPERATIONS.riskWrite,operationTargetIdentityKey:identityKey('risk-control',[row.rowKey,relation.relationId]),evidenceOperationIds:[RETURN_OPERATIONS.riskRead]
      });
      if (row.kind === 'APP' && contentName.toLocaleLowerCase('en-US').includes('sap ecc')) {
        for (const item of governance.scoringItems) {
          const applicable = mode === 'Higher' ? String(item.higherApplicable).startsWith('Y') : true;
          if (applicable) targets.push({ kind: 'field', key: `risk-factor|${row.rowKey}|${item.itemId}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, fieldId: item.itemId, value: mode,
            mutationOperationId:RETURN_OPERATIONS.factorWrite,operationTargetIdentityKey:identityKey('risk-factor',[row.rowKey,item.itemId]),evidenceOperationIds:[RETURN_OPERATIONS.factorRead,RETURN_OPERATIONS.factorPreflight] });
        }
        const factors = rowField(row, governance, 'P1.APP.GRA.FACTORS_CONSIDERED');
        if (factors) targets.push({ kind: 'documentation', key: `documentation|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, plainText: factors,
          mutationOperationId:RETURN_OPERATIONS.documentationWrite,operationTargetIdentityKey:identityKey('documentation',[row.rowKey]),evidenceOperationIds:[RETURN_OPERATIONS.documentationRead] });
      }
      targets.push({ kind: 'evaluation', key: `evaluation|${row.rowKey}`, rowKey: row.rowKey, workspace: workspaceId, objectType: 'GRA', graTargetKey: `gra|${row.rowKey}`, value: 'EvaluationComplete',
        mutationOperationId:RETURN_OPERATIONS.evaluationWrite,operationTargetIdentityKey:identityKey('evaluation',[row.rowKey]),evidenceOperationIds:[RETURN_OPERATIONS.evaluationRead] });
    }
    for(const relation of targets.filter((item)=>item.kind==='relation')){
      const matches=rowsPrepared.filter((item)=>item.kind==='APP'&&item.elementId.toLocaleLowerCase('en-US')===String(relation.targetExternalId).toLocaleLowerCase('en-US'));
      if(matches.length!==1) fail('RETURN.RELATION_TARGET_UNVERIFIED',`Relation ${relation.key} does not resolve to one exact in-workbook APP target.`);
      relation.targetObjectTargetKey=`object|${matches[0].rowKey}`;
      relation.targetWorkspace=matches[0].workspaceId;
    }
    for(const row of rowsPrepared.filter((item)=>['DB','OS'].includes(item.kind))){
      if(row.inheritanceSources.length!==1) fail('RETURN.RAIT_INHERITANCE_AMBIGUOUS',`${row.kind} ${row.elementId} requires exactly one APP inheritance edge.`);
      const source=rowsPrepared.find((item)=>item.kind==='APP'&&item.elementId.toLocaleLowerCase('en-US')===row.inheritanceSources[0].externalId.toLocaleLowerCase('en-US')&&item.workspaceName.normalize('NFKC')===row.inheritanceSources[0].workspaceName.normalize('NFKC'));
      if(!source) fail('RETURN.RAIT_INHERITANCE_AMBIGUOUS',`${row.kind} ${row.elementId} APP inheritance source is not an exact planned identity.`);
      targets.push({kind:'field',key:`inheritance-source|${row.rowKey}|${source.rowKey}`,rowKey:row.rowKey,workspace:source.workspaceId,objectType:'GRA',graTargetKey:`gra|${source.rowKey}`,sourceRowKey:source.rowKey,fieldId:'itElementRaitConclusionLevelId',value:row.mode,mutationOperationId:RETURN_OPERATIONS.graStateWrite,operationTargetIdentityKey:identityKey('gra-state',[row.rowKey,source.rowKey,'inheritance']),evidenceOperationIds:[RETURN_OPERATIONS.graStateRead]});
    }
    const normalized=(value)=>String(value||'').normalize('NFKC').replace(/\s+/gu,' ').trim();
    for(const row of rowsPrepared){
      const rowTargets=targets.filter((item)=>item.rowKey===row.rowKey);
      const rowPreview={rowKey:row.rowKey,elementId:row.elementId,workspaceId:row.workspaceId,changes:[]};
      rowPreview.changes.push({targetKey:`object|${row.rowKey}`,disposition:row.kind==='APP'?row.identityDisposition:(row.objectId?'reuse':'create'),current:row.objectId||'absent',desired:`${row.objectType}/${row.elementId}`,operationId:RETURN_OPERATIONS.objectCreate,evidenceOperationIds:row.kind==='APP'?[RETURN_OPERATIONS.objectIdentityResolve,RETURN_OPERATIONS.objectRead]:[RETURN_OPERATIONS.objectRead]});
      rowPreview.changes.push({targetKey:`gra|${row.rowKey}`,disposition:row.graId?'reuse':'create',current:row.graId||'absent',desired:`${row.content.contentName}/${row.graName}`,operationId:RETURN_OPERATIONS.graCreate,evidenceOperationId:RETURN_OPERATIONS.graRead});
      if(row.kind==='APP'){
        const settingsIntent=rowTargets.find((item)=>item.key===`object-settings|${row.rowKey}`);
        if(row.objectId){
          const target={targetIdentityKey:settingsIntent.operationTargetIdentityKey,workspaceId:row.workspaceId};
          const current=await invoke(RETURN_OPERATIONS.objectSettingsPreflight,context.connectorBinding,{target,objectId:row.objectId});
           const frozenData=freezeAppDataAvailability(row.identityDisposition,current.isDataAvailable,row.isDataAvailable);const desiredData=frozenData.value;
           row.dataAvailability=frozenData;settingsIntent.isDataAvailable=desiredData;settingsIntent.dataAvailabilityDisposition=frozenData.disposition;
          rowPreview.changes.push({targetKey:settingsIntent.key,disposition:String(current.typeId)===String(settingsIntent.typeId)&&current.isRelevant===settingsIntent.isRelevant&&current.isDataAvailable===desiredData?'reuse':'patch',current:{typeId:current.typeId,isRelevant:current.isRelevant,isDataAvailable:current.isDataAvailable},desired:{typeId:settingsIntent.typeId,isRelevant:settingsIntent.isRelevant,isDataAvailable:desiredData},operationId:RETURN_OPERATIONS.objectSettingsWrite,evidenceOperationId:RETURN_OPERATIONS.objectSettingsRead});
         }else{const frozenData=freezeAppDataAvailability('create',undefined,row.isDataAvailable);row.dataAvailability=frozenData;settingsIntent.isDataAvailable=frozenData.value;settingsIntent.dataAvailabilityDisposition=frozenData.disposition;rowPreview.changes.push({targetKey:settingsIntent.key,disposition:'post-create-resolution',current:'not-readable-before-object-create',desired:{typeId:settingsIntent.typeId,isRelevant:settingsIntent.isRelevant,isDataAvailable:frozenData.value,dataAvailabilityDisposition:frozenData.disposition},operationId:RETURN_OPERATIONS.objectSettingsWrite,evidenceOperationId:RETURN_OPERATIONS.objectSettingsRead});}
      }
      if(row.graId){
        const stateTarget=(kind)=>({targetIdentityKey:identityKey('gra-state',[row.rowKey,kind]),workspaceId:row.workspaceId});
        const state=await invoke(RETURN_OPERATIONS.graStatePreflight,context.connectorBinding,{target:stateTarget('status'),riskAssessmentId:row.graId});
        for(const intent of rowTargets.filter((item)=>String(item.key).startsWith('gra-status|')||String(item.key).startsWith('gra-rait|'))){
          const patchKind=intent.fieldId==='status'?'status':'rait'; const current=patchKind==='status'?state.status:state.itElementRaitConclusionLevelId||state.itElementRaitConclusionLevelName;
          rowPreview.changes.push({targetKey:intent.key,disposition:String(current)===String(intent.value)?'reuse':'patch',current,desired:intent.value,operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]});
        }
        const riskIntents=rowTargets.filter((item)=>item.kind==='risk_control');
        if(riskIntents.length){
          const catalog=await invoke(RETURN_OPERATIONS.riskCatalog,context.connectorBinding,{target:{targetIdentityKey:identityKey('risk-catalog',[row.rowKey]),workspaceId:row.workspaceId},riskAssessmentId:row.graId});
          for(const intent of riskIntents){
            const risks=catalog.risks.filter((item)=>normalized(item.name)===normalized(intent.riskName)&&normalized(item.classification)===normalized(intent.classification));
            const controls=catalog.controls.filter((item)=>normalized(item.name)===normalized(intent.controlName));
            if(risks.length!==1||controls.length!==1) fail('RETURN.RISK_CONTROL_CATALOG_DRIFT',`Risk/Control identity is absent or ambiguous during review: ${intent.relationId}.`);
            const risk=risks[0],control=controls[0]; intent.resolvedCatalog={riskId:risk.riskId,riskRiskScopeId:risk.riskRiskScopeId,controlId:control.controlId,assertion:risk.assertion,updatedOn:risk.updatedOn};
            const observed=await invoke(RETURN_OPERATIONS.riskRead,context.connectorBinding,{target:{targetIdentityKey:intent.operationTargetIdentityKey,workspaceId:row.workspaceId},query:{riskRiskScopeId:risk.riskRiskScopeId,riskId:risk.riskId,controlId:control.controlId,assertion:risk.assertion}});
            rowPreview.changes.push({targetKey:intent.key,disposition:observed.verified===true?'reuse':'associate',current:observed.verified===true?'exact association':'absent',desired:{risk:intent.riskName,classification:intent.classification,control:intent.controlName,assertion:risk.assertion},resolvedIds:intent.resolvedCatalog,operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]});
          }
        }
        for(const intent of rowTargets.filter((item)=>String(item.key).startsWith('risk-factor|'))){
          const target={targetIdentityKey:intent.operationTargetIdentityKey,workspaceId:row.workspaceId};
          const observed=await invoke(RETURN_OPERATIONS.factorPreflight,context.connectorBinding,{target,query:{riskAssessmentId:row.graId,itemId:intent.fieldId,selectionMode:intent.value}});
          intent.resolvedFactor={factorId:observed.factorId,selectedValue:observed.selected?.value,selectedName:observed.selected?.name,spectrumDigest:digest(Buffer.from(canonical(observed.spectrum||[])))};
          const selected=Number(observed.selected?.value),current=Number(observed.current?.value??observed.current);
          rowPreview.changes.push({targetKey:intent.key,disposition:observed.applicable===false?'not-applicable':selected===current?'reuse':'patch',current:observed.current,desired:observed.selected,operationId:intent.mutationOperationId,evidenceOperationId:observed.applicable===false?RETURN_OPERATIONS.factorPreflight:RETURN_OPERATIONS.factorRead});
        }
        const docIntent=rowTargets.find((item)=>item.kind==='documentation');
        if(docIntent){const current=await invoke(RETURN_OPERATIONS.documentationPreflight,context.connectorBinding,{target:{targetIdentityKey:docIntent.operationTargetIdentityKey,workspaceId:row.workspaceId},riskAssessmentId:row.graId}); const doc=current.documentation?.documentation||current.documentation;
          rowPreview.changes.push({targetKey:docIntent.key,disposition:String(doc?.plainText||'')===String(docIntent.plainText)?'reuse':'patch',current:doc?.plainText||'',desired:docIntent.plainText,operationId:docIntent.mutationOperationId,evidenceOperationId:docIntent.evidenceOperationIds[0]});}
        const evalIntent=rowTargets.find((item)=>item.kind==='evaluation');
        const evaluation=await invoke(RETURN_OPERATIONS.evaluationPreflight,context.connectorBinding,{target:{targetIdentityKey:evalIntent.operationTargetIdentityKey,workspaceId:row.workspaceId},riskAssessmentId:row.graId});
        rowPreview.changes.push({targetKey:evalIntent.key,disposition:evaluation.status===evalIntent.value?'reuse':'submit',current:evaluation.status,desired:evalIntent.value,operationId:evalIntent.mutationOperationId,evidenceOperationId:evalIntent.evidenceOperationIds[0]});
      }else for(const intent of rowTargets.filter((item)=>!item.key.startsWith('object|')&&!item.key.startsWith('gra|')&&item.kind!=='relation'&&!item.key.startsWith('object-settings|'))) rowPreview.changes.push({targetKey:intent.key,disposition:'post-create-resolution',current:'not-readable-before-gra-create',desired:intent.value||intent.plainText||intent.relationId||intent.fieldId||intent.kind,operationId:intent.mutationOperationId,evidenceOperationIds:intent.evidenceOperationIds});
      preflights.push(rowPreview);
    }
    for(const intent of targets.filter((item)=>item.kind==='relation')){
      const source=rowsPrepared.find((item)=>`object|${item.rowKey}`===intent.sourceObjectTargetKey); const targetRow=rowsPrepared.find((item)=>`object|${item.rowKey}`===intent.targetObjectTargetKey);
      const preview=preflights.find((item)=>item.rowKey===intent.rowKey);
      if(source?.objectId&&targetRow?.objectId){const target={targetIdentityKey:`relation|${intent.workspace}|${source.objectId}|${targetRow.objectId}|${intent.relationType}`,workspaceId:intent.workspace}; intent.resolvedOperationTargetIdentityKey=target.targetIdentityKey;
        const observed=await invoke(RETURN_OPERATIONS.relationPreflight,context.connectorBinding,{target,query:{associationType:intent.relationType,itElementId:source.objectId,associatingEntityId:targetRow.objectId,workspaceId:intent.workspace}});
        preview.changes.push({targetKey:intent.key,disposition:observed.associated===true&&observed.inconsistent===false?'reuse':'associate',current:observed,desired:{sourceObjectId:source.objectId,targetObjectId:targetRow.objectId,relationType:intent.relationType},operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]});
      }else preview.changes.push({targetKey:intent.key,disposition:'post-create-resolution',current:'source-or-target-object-not-yet-created',desired:{sourceObjectTargetKey:intent.sourceObjectTargetKey,targetObjectTargetKey:intent.targetObjectTargetKey,relationType:intent.relationType},operationId:intent.mutationOperationId,evidenceOperationId:intent.evidenceOperationIds[0]});
    }
    return { authority, rows: rowsPrepared, targets, preflights };
  }

  return Object.freeze({
    health: async () => {
      let latest=await store.call('loadLatestRun',{}); let run=latest?.run;
      let recoveredMessageCard=null,recoveredSurfacePatch=null;
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
          recoveredSurfacePatch=processingSurface(latest,'已恢复已确认的系统信息文件；后台校验将从尚未提交的 processing 阶段安全启动。');
        }else{
          const revision=await store.call('transitionRun',{runId:String(run.run_id),expectedRevision:Number(run.state_revision),toState:'failed',eventType:'run.processing_recovery_rejected',error:'Persisted processing Run and staged plan identity drifted; background validation was not replayed.',details:{interruptedStage:'processing',stageState:String(checkpoint?.stageState||''),replay:false}});
          latest=await store.call('loadLatestRun',{});run=latest.run;const progress=progressSurface(latest);
          recoveredSurfacePatch={stateVersion:Number(revision),status:'stale',statusMessage:`processing Run 与持久化上传计划不一致；Run 已失败关闭（revision ${revision}），未启动后台校验。请重新上传原文件建立新 Run。`,scopes:progress.scopes,items:progress.items,artifacts:(latest.artifacts||[]).filter((item)=>String(item.kind)!=='source').map((item)=>({artifactId:String(item.artifact_id),kind:String(item.kind),name:String(item.original_name),sha256:String(item.sha256),sizeBytes:Number(item.size_bytes),available:true,reason:''})),editors:[],actions:[{actionId:'stage-source-workbook',enabled:true,reason:''},{actionId:'validate-staged-upload',enabled:false,reason:'不一致的 Run 已失败关闭，禁止后台重放。'},{actionId:'restart-run',enabled:false,reason:'不一致的 Run 已失败关闭。'},{actionId:'apply-revisions',enabled:false,reason:'不一致的 Run 不允许原地修订。'},{actionId:'prepare-return',enabled:false,reason:'必须重新导入并生成新 Run。'}]};
        }
      }else if(run&&['converting','validating_output'].includes(run.state)){
        const interruptedStage=String(run.state); const revision=await store.call('transitionRun',{runId:String(run.run_id),expectedRevision:Number(run.state_revision),toState:'failed',eventType:'run.offline_crash_recovered',error:`Offline ${interruptedStage} stage was interrupted; no processing was replayed.`,details:{interruptedStage,replay:false}});
        latest=await store.call('loadLatestRun',{}); run=latest.run; const progress=progressSurface(latest);
        recoveredSurfacePatch={stateVersion:Number(revision),status:'stale',statusMessage:`检测到离线处理在 ${interruptedStage} 阶段中断；Run 已持久化转为 failed（revision ${revision}），未自动重放。请通过“选择用户资料”重新导入原文件以建立新 Run。`,
          scopes:progress.scopes,items:progress.items,
          artifacts:(latest.artifacts||[]).filter((item)=>String(item.kind)!=='source').map((item)=>({artifactId:String(item.artifact_id),kind:String(item.kind),name:String(item.original_name),sha256:String(item.sha256),sizeBytes:Number(item.size_bytes),available:true,reason:''})),editors:[],actions:[
            {actionId:'stage-source-workbook',enabled:true,reason:''},{actionId:'restart-run',enabled:false,reason:'中断 Run 已失败关闭。'},{actionId:'apply-revisions',enabled:false,reason:'中断 Run 不允许原地修订。'},{actionId:'prepare-return',enabled:false,reason:'离线处理未完成；必须重新导入并生成新 Run。'}]};
      }
      if(run?.state==='uncertain'){
        const checkpoint=await store.call('loadPlan',String(run.run_id));
        recoveredSurfacePatch=returnSurface(latest,'Recovered an uncertain Return; mutation replay is forbidden and only read-only reconcile is available.');
        if(checkpoint?.confirmation) recoveredMessageCard={messageId:checkpoint.confirmation.messageId,featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,surfaceId:'create-associate.workbench',runId:String(run.run_id),confirmationId:checkpoint.confirmation.confirmationId,stateVersion:Number(run.state_revision),state:'uncertain',title:'回传结果待核验',summary:'检测到重启前已提交但未完成读回的命令；禁止重放，只允许签名只读 reconcile。',details:[{label:'计划摘要',value:checkpoint.confirmation.planDigest}],actions:[{actionId:'reconcile-return',label:'只读核验',effect:'read_only',enabled:true,reason:'',selectionMode:'none',dependencies:['remote_connector','safety_lock']}]};
      }else if(run?.state==='returning'){
        const checkpoint=await store.call('loadPlan',String(run.run_id));
        recoveredSurfacePatch=returnSurface(latest,'Recovered a confirmed pre-submit Return; no mutation was replayed and explicit continuation is required.');
        if(checkpoint?.confirmation) recoveredMessageCard={messageId:checkpoint.confirmation.messageId,featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,surfaceId:'create-associate.workbench',runId:String(run.run_id),confirmationId:checkpoint.confirmation.confirmationId,stateVersion:Number(run.state_revision),state:'executing',title:'已确认回传待显式继续',summary:'进程在 mutation 提交前退出；没有自动执行或重放任何写入。请核对冻结计划后显式继续。',details:[{label:'计划摘要',value:checkpoint.confirmation.planDigest},{label:'恢复状态',value:'returning / no submitted or committed command'}],actions:[{actionId:'continue-return',label:'继续冻结命令',effect:'omnia_mutation',enabled:true,reason:'',selectionMode:'none',dependencies:['remote_connector','safety_lock']}]};
      }
      if(run&&['needs_input','ready_for_review'].includes(run.state)){
        const checkpoint=await store.call('loadPlan',String(run.run_id));
        if(checkpoint?.parsed) recoveredSurfacePatch=checkpoint.reviewNavigation==='upload'
          ?uploadSurface(latest,'已恢复持久化 Upload 层；原 Run、Artifact、修订与排除状态未改变。')
          :reviewSurface(latest,checkpoint,null,'已恢复持久化 Review 层。');
      }
      return {ready:true,featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,transport:'remote-only',recoveredMessageCard,recoveredSurfacePatch};
    },
    handleAction: async (input) => {
      if(input?.actionId==='restart-run'){
        const latest=await store.call('loadLatestRun',{}),run=latest?.run;
        if(!run||!['acquiring','needs_input','ready_for_review'].includes(run.state))fail('RUN.RESTART_BLOCKED','Only the current staged or editable Run can restart.');
        await store.call('transitionRun',{runId:String(run.run_id),expectedRevision:Number(run.state_revision),toState:'cancelled',eventType:'run.restart_requested',details:{preserveArtifacts:true,preserveRevisions:true,nextUploadCreatesNewRun:true}});
        const cancelled=await store.call('loadLatestRun',{});
        return{surfacePatch:uploadSurface(cancelled,'当前 Run 已取消并保留审计；下一次上传将建立新的 Run。',true)};
      }
      if (input?.actionId === 'reconcile-return') {
        const runId=String(input.payload?.runId||''); const latest=await store.call('loadLatestRun',{}); const run=latest?.run;
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
              const graTarget={targetIdentityKey:identityKey('gra',[rowPlan.rowKey,rowPlan.workspaceId]),workspaceId:rowPlan.workspaceId};
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
          observed=await invoke(spec.readOperation,binding,{...spec.readRequest,receiptContext:{runId,commandId:spec.commandId}}); applied=observed?.verified===true;
        }
        await store.call('recordReturnEvidence',{runId,commandId:spec.commandId,evidenceType:'reconcile',commandState:applied?'readback_verified':manualUnresolved?'uncertain':'closed_not_applied',payload:observed,receiptId:observed?.__operationReceiptId||'',verified:applied,error:applied?'':manualUnresolved?'APP identity remains create/skip; the uncertain mutation is not replayed and requires manual reconcile.':'Authoritative reconcile proved the uncertain mutation was not applied.'});
        if(applied){
          if(targetSpec.kind==='relation') await store.call('projectVerifiedReturn',{runId,commandId:spec.commandId,binding,workspaceId:targetSpec.workspace,projectionKind:'relation',relationType:targetSpec.relationType,relationKey:targetSpec.key,sourceObjectId:spec.preflightRequest.query.itElementId,targetObjectId:spec.preflightRequest.query.associatingEntityId,payload:observed});
          else {
            if(!objectId){ const current=await buildReturnPreparation(checkpoint,input.context); const currentRow=current.rows.find((item)=>item.rowKey===rowPlan.rowKey); objectId=targetSpec.objectType==='GRA'&&targetSpec.kind==='object'?currentRow.graId:targetSpec.objectType==='GRA'?currentRow.graId:currentRow.objectId; }
            await store.call('projectVerifiedReturn',{runId,commandId:spec.commandId,binding,workspaceId:targetSpec.workspace,projectionKind:'object',objectType:targetSpec.objectType,objectId,provenance:{rowKey:rowPlan.rowKey,targetKey:targetSpec.key,reconciled:true},payload:observed});
          }
        }
        await store.call('transitionRun',{runId,expectedRevision:revision,toState:applied?'returning':manualUnresolved?'uncertain':'failed',eventType:applied?'return.reconcile_resolved':manualUnresolved?'return.reconcile_manual_required':'return.reconcile_not_applied',details:{applied,manualUnresolved}});
        await store.call('savePlan',{...checkpoint,execution:{state:applied?'reconciled':manualUnresolved?'uncertain':'reconciled',lastCommandId:spec.commandId,applied,reconcileSpec:manualUnresolved?spec:undefined},updatedAt:new Date().toISOString()});
        const latestAfterReconcile=await store.call('loadLatestRun',{});
        return {surfacePatch:returnSurface(latestAfterReconcile,applied?'只读 reconcile 证明已应用；未重放，待显式继续。':manualUnresolved?'APP 身份仍无法证明写入结果；Run 保持 uncertain，禁止重放并等待人工核验。':'只读 reconcile 证明未应用；Run 已失败关闭。'),messageCard:{messageId:checkpoint.confirmation.messageId,featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,surfaceId:'create-associate.workbench',runId,confirmationId:checkpoint.confirmation.confirmationId,stateVersion:Number(input.expectedStateVersion)+1,state:applied?'executing':manualUnresolved?'uncertain':'failed',title:'只读核验完成',summary:applied?'权威读回确认写入已应用；未重放。可继续剩余冻结命令。':manualUnresolved?'身份解析仍为 create/skip，无法安全判断写入结果；未重放，保持 uncertain 并等待人工核验。':'权威读回确认该写入未应用；未重放。本 intent 已失败关闭，如需重试必须建立新计划并重新确认。',details:[{label:'计划摘要',value:checkpoint.confirmation.planDigest},{label:'核验命令',value:spec.commandId}],actions:applied?[{actionId:'continue-return',label:'继续剩余回传',effect:'omnia_mutation',enabled:true,reason:'',selectionMode:'none',dependencies:['remote_connector','safety_lock']}]:manualUnresolved?[{actionId:'reconcile-return',label:'重新只读核验',effect:'read_only',enabled:true,reason:'',selectionMode:'none',dependencies:['remote_connector','safety_lock']}]:[]}};
      }
      if (input?.actionId === 'confirm-return' || input?.actionId === 'continue-return') {
        const runId = String(input.payload?.runId || '');
        const checkpoint = await store.call('loadPlan', runId);
        if (!checkpoint?.returnPlan || !checkpoint?.confirmation) fail('RETURN.PLAN_MISSING', 'The frozen Return plan is unavailable.');
        const current = await buildReturnPreparation(checkpoint, input.context);
        const currentPreflightDigest = digest(Buffer.from(canonical({ authority: current.authority, preflights: current.preflights })));
        if (input.actionId === 'confirm-return' && currentPreflightDigest !== checkpoint.preflightDigest) fail('RETURN.PREFLIGHT_CHANGED', 'Authority, object identity, or GRA preflight changed before confirmation.');
        const approved = input.actionId === 'confirm-return' ? await store.call('approveReturnIntent', {
          confirmationId: input.payload?.confirmationId, confirmationToken: checkpoint.confirmation.confirmationToken,
          expectedStateVersion: input.expectedStateVersion, connectorBinding: input.context.connectorBinding,
          safetyLock: input.context.safetyLock, preflightDigest: currentPreflightDigest
        }) : (await store.call('validateReturnAuthority', { runId, connectorBinding: input.context.connectorBinding, safetyLock: input.context.safetyLock }), { planDigest: checkpoint.confirmation.planDigest });
        const plan = checkpoint.returnPlan; const planDigest = approved.planDigest; const binding = input.context.connectorBinding;
        const targetByKey = new Map(plan.targets.map((item) => [item.key, item]));
        const progress = new Map((await store.call('loadReturnProgress', { runId })).map((item) => [item.target_key, item.state]));
        const done = (key) => progress.get(key) === 'verified';
        const objectIds = new Map(); const graIds = new Map();
        const runtimeKey=(kind,elementId,workspaceId)=>`${kind}|${elementId}|${workspaceId}`.toLocaleLowerCase('en-US');
        async function commandFor(targetKey,operationId,request,evidenceTargetIdentityKey='') {
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
        async function verifiedMutation(spec) {
          const command = await commandFor(spec.targetKey,spec.mutationOperation,spec.mutationPayload,spec.target.targetIdentityKey);
          let before;
          try {
            before = await invoke(spec.preflightOperation, binding, { ...spec.preflightRequest, planDigest });
            if (spec.acceptPreflight && !spec.acceptPreflight(before)) fail('RETURN.PREFLIGHT_BLOCKED', `Preflight blocked ${spec.targetKey}.`);
            await evidence(command.commandId, 'preflight', 'prepared', before, true);
          } catch (error) {
            await evidence(command.commandId, 'preflight', 'failed', { code: error.code || 'RETURN.PREFLIGHT_FAILED', message: error.message }, false, error.message);
            await store.call('finishReturn', { runId, outcome: 'failed', error: error.message }); throw error;
          }
          if(spec.raceReadOperation){
            await freezeRead(command.commandId,spec.raceReadOperation,spec.raceReadRequest);
            const raced=await invoke(spec.raceReadOperation,binding,{...spec.raceReadRequest,receiptContext:{runId,commandId:command.commandId}});
            if(spec.raceAlreadyApplied(raced)){
              const readEvidence=await evidence(command.commandId,'reconcile','readback_verified',raced,true);
              return {command,response:null,observed:raced,readEvidence,closedByRace:true};
            }
          }
          const durableReconcileSpec = { commandId: command.commandId, targetKey: spec.targetKey, target: spec.target,
            preflightOperation: spec.preflightOperation, preflightRequest: spec.preflightRequest,
            reconcileOperation: spec.reconcileOperation||spec.preflightOperation,
            reconcileRequest: spec.reconcileRequest||spec.preflightRequest,
            readOperation: spec.readOperation, readRequest: typeof spec.readRequest === 'function' ? null : spec.readRequest,
            mutationOperation: spec.mutationOperation, commandKind: spec.commandKind, mutationPayload:spec.mutationPayload };
          await store.call('saveReturnReconcileSpec', { runId, commandId: command.commandId, spec: durableReconcileSpec });
          await evidence(command.commandId, 'request', 'submitted', { operationId: spec.mutationOperation, request: spec.mutationPayload });
          let response;
          try {
            response = await invoke(spec.mutationOperation, binding, { target: spec.target, planDigest,
              command: { commandId: command.commandId, idempotencyKey: command.idempotencyKey, kind: spec.commandKind, payload: spec.mutationPayload } });
          } catch (error) {
            if (uncertainError(error)) {
              await evidence(command.commandId, 'request', 'uncertain', { operationId: spec.mutationOperation }, false, error.message);
              await store.call('savePlan', { ...checkpoint, execution: { state: 'uncertain', reconcileSpec: durableReconcileSpec }, updatedAt: new Date().toISOString() });
              await store.call('finishReturn', { runId, outcome: 'uncertain', error: error.message });
              const uncertain = new Error(error.message); uncertain.code = 'RETURN.UNCERTAIN'; throw uncertain;
            }
            await evidence(command.commandId, 'request', 'failed', { operationId: spec.mutationOperation }, false, error.message);
            await store.call('finishReturn', { runId, outcome: 'failed', error: error.message }); throw error;
          }
          await evidence(command.commandId, 'commit', 'committed', response, true);
          const query = typeof spec.readRequest === 'function' ? spec.readRequest(response) : spec.readRequest;
          try {
            await freezeRead(command.commandId,spec.readOperation,query);
            const observed = await invoke(spec.readOperation, binding, { ...query, receiptContext: { runId, commandId: command.commandId } });
            if (!spec.verify(observed, response)) fail('RETURN.READBACK_MISMATCH', `Verified read-back failed for ${spec.targetKey}.`);
            const readEvidence = await evidence(command.commandId, 'readback', 'readback_verified', observed, true);
            return { command, response, observed, readEvidence };
          } catch (error) {
            await evidence(command.commandId, 'reconcile', 'uncertain', { code: error.code || 'RETURN.READBACK_FAILED', message: error.message }, false, error.message);
            await store.call('savePlan', { ...checkpoint, execution: { state: 'uncertain', reconcileSpec: durableReconcileSpec }, updatedAt: new Date().toISOString() });
            await store.call('finishReturn', { runId, outcome: 'uncertain', error: error.message });
            const uncertain = new Error(error.message); uncertain.code = 'RETURN.UNCERTAIN'; throw uncertain;
          }
        }
        async function verifiedExisting(spec) {
          const command = await commandFor(spec.targetKey,spec.mutationOperation,spec.readRequest,spec.readRequest.target.targetIdentityKey);
          try {
            const before = await invoke(spec.preflightOperation, binding, { ...spec.preflightRequest, planDigest });
            if(spec.acceptPreflight&&!spec.acceptPreflight(before)) fail('RETURN.PREFLIGHT_BLOCKED',`Existing identity preflight blocked ${spec.targetKey}.`);
            await evidence(command.commandId, 'preflight', 'prepared', before, true);
            await freezeRead(command.commandId,spec.readOperation,spec.readRequest);
            const observed = await invoke(spec.readOperation, binding, { ...spec.readRequest, receiptContext: { runId, commandId: command.commandId } });
            if (!spec.verify(observed)) fail('RETURN.READBACK_MISMATCH', `Existing read-back failed for ${spec.targetKey}.`);
            await evidence(command.commandId, 'readback', 'readback_verified', observed, true);
            return { command, observed };
          } catch (error) {
            await evidence(command.commandId, 'preflight', 'failed', { code: error.code || 'RETURN.EXISTING_READ_FAILED', message: error.message }, false, error.message);
            await store.call('finishReturn', { runId, outcome: 'failed', error: error.message }); throw error;
          }
        }
        async function closeVerified(targetKey, mutationOperation, readOperation, readRequest, verify) {
          const command = await commandFor(targetKey,mutationOperation,readRequest,readRequest.target.targetIdentityKey);
          await freezeRead(command.commandId,readOperation,readRequest);
          const observed = await invoke(readOperation, binding, { ...readRequest, receiptContext: { runId, commandId: command.commandId } });
          if (!verify(observed)) fail('RETURN.READBACK_MISMATCH', `Existing authoritative read-back failed for ${targetKey}.`);
          await evidence(command.commandId, 'reconcile', 'readback_verified', observed, true);
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
          const ordered = [...current.rows].sort((a, b) => (a.kind === 'APP' ? 0 : 1) - (b.kind === 'APP' ? 0 : 1));
          for (const row of ordered) {
            let objectId = row.objectId;
            let objectResult;
            if (done(`object|${row.rowKey}`)) {
              if (!objectId) fail('RETURN.RESUME_OBJECT_MISSING', `Verified object ${row.elementId} is absent during continuation.`);
            } else if (objectId) objectResult = await verifiedExisting({ targetKey: `object|${row.rowKey}`, mutationOperation: RETURN_OPERATIONS.objectCreate,
              preflightOperation: row.kind==='APP'?RETURN_OPERATIONS.objectIdentityResolve:RETURN_OPERATIONS.objectPreflight, preflightRequest: { target: row.objectTarget, query: row.objectQuery },
              acceptPreflight:row.kind==='APP'?(observed)=>{const identity=inspectApplicationIdentity(observed,{target:row.objectTarget,query:row.objectQuery});return identity.accepted&&identity.disposition===row.identityDisposition&&identity.objectId===objectId;}
                :(observed)=>{const identity=inspectGenericIdentity(observed,{target:row.objectTarget,query:row.objectQuery});return identity.accepted&&identity.state==='active'&&identity.objectId===objectId;},
              readOperation: RETURN_OPERATIONS.objectRead, readRequest: { target: row.objectTarget, objectId, query:{externalId:row.elementId,objectType:row.objectType,...(row.objectType==='Application'?{description:descriptionEditorJson(row.description)}:{subtypeId:row.subtypeId})} }, verify: (value) => responseId(value, 'IT Element read-back') === objectId });
            else {
              const description=descriptionEditorJson(row.description);
              const payload = { name: row.elementId, workspaceId: row.workspaceId, engagementId: binding.engagementId,
                number: row.elementId, itElementType: row.objectType,
                ...(row.objectType==='Application'||row.objectType==='Infrastructure'?{description}:{}),
                ...(row.objectType==='Infrastructure'||row.objectType==='ITTool'?{typeId:row.subtypeId}:{}) };
              objectResult = await verifiedMutation({ targetKey: `object|${row.rowKey}`, target: row.objectTarget,
                preflightOperation: RETURN_OPERATIONS.objectCreatePreflight, preflightRequest: { target: row.objectTarget, query: row.objectQuery },
                acceptPreflight:(observed)=>observed.disposition==='create',
                reconcileOperation:RETURN_OPERATIONS.objectIdentityResolve,reconcileRequest:{target:row.objectTarget,query:row.objectQuery},
                mutationOperation: RETURN_OPERATIONS.objectCreate, mutationPayload: payload, commandKind: 'create_object',
                readOperation: RETURN_OPERATIONS.objectRead, readRequest: (response) => ({ target: row.objectTarget, objectId: responseId(response, 'created IT Element'),query:{externalId:row.elementId,objectType:row.objectType,...(row.objectType==='Application'?{description}:{subtypeId:row.subtypeId})} }),
                verify: (value, response) => responseId(value, 'IT Element read-back') === responseId(response, 'created IT Element') });
              objectId = responseId(objectResult.response, 'created IT Element');
            }
            objectIds.set(runtimeKey(row.kind,row.elementId,row.workspaceId), objectId);
            if (objectResult) await projectObject(objectResult, row, `object|${row.rowKey}`, row.objectType, objectId);
            if(row.kind==='APP'&&!done(`object-settings|${row.rowKey}`)){
              const settingsKey=`object-settings|${row.rowKey}`; const settingsTarget={targetIdentityKey:identityKey('object-settings',[row.rowKey]),workspaceId:row.workspaceId};
              const settingsIntent=targetByKey.get(settingsKey);if(!settingsIntent)fail('RETURN.INTENT_MISSING',`Frozen APP settings target is missing: ${settingsKey}`);
              const before=await invoke(RETURN_OPERATIONS.objectSettingsPreflight,binding,{target:settingsTarget,objectId});
              const tab=(before.concurrencyTabs||[]).find((item)=>Number(item.entityTabTypeId)===501);
              const desiredData=resolveFrozenAppDataAvailability(row.identityDisposition,before,{disposition:settingsIntent.dataAvailabilityDisposition,value:settingsIntent.isDataAvailable});
              if(typeof desiredData!=='boolean'||!tab?.updatedOn) fail('RETURN.OBJECT_SETTINGS_AUTHORITY_MISSING',`APP ${row.elementId} settings lack exact data-availability or concurrency authority.`);
              const query={objectId,typeId:row.content.itElementTypeId,isRelevant:row.isRelevant,isDataAvailable:desiredData,number:row.elementId};
              const settingsResult=String(before.typeId)===String(query.typeId)&&before.isRelevant===row.isRelevant&&before.isDataAvailable===desiredData&&String(before.number||before.referenceNumber)===row.elementId
                ? await closeVerified(settingsKey,RETURN_OPERATIONS.objectSettingsWrite,RETURN_OPERATIONS.objectSettingsRead,{target:settingsTarget,query},(observed)=>observed.verified===true)
                : await verifiedMutation({targetKey:settingsKey,target:settingsTarget,preflightOperation:RETURN_OPERATIONS.objectSettingsPreflight,preflightRequest:{target:settingsTarget,objectId},mutationOperation:RETURN_OPERATIONS.objectSettingsWrite,commandKind:'patch_object_settings',mutationPayload:{engagementId:binding.engagementId,workspaceId:row.workspaceId,objectId,typeId:row.content.itElementTypeId,isRelevant:row.isRelevant,isDataAvailable:desiredData,concurrencyTabId:501,concurrencyTabUpdatedOn:tab.updatedOn},readOperation:RETURN_OPERATIONS.objectSettingsRead,readRequest:{target:settingsTarget,query},verify:(observed)=>observed.verified===true});
              await projectObject(settingsResult,row,settingsKey,row.objectType,objectId);
            }
            // v4 ordering is intentional: an Infrastructure must be linked to its
            // exact in-batch Application and verified from both directions before
            // its GRA is created. The later relation pass sees the committed target
            // and remains a no-op for resume compatibility.
            if(['DB','OS'].includes(row.kind)){
              for(const appExternalId of row.relations){
                const appRows=ordered.filter((item)=>item.kind==='APP'&&item.elementId.toLocaleLowerCase('en-US')===appExternalId.toLocaleLowerCase('en-US'));
                if(appRows.length!==1) fail('RETURN.RELATION_TARGET_UNVERIFIED',`Application ${appExternalId} does not resolve to one exact Workspace-bound object.`);
                const appId=objectIds.get(runtimeKey('APP',appRows[0].elementId,appRows[0].workspaceId));
                if(!appId) fail('RETURN.RELATION_TARGET_UNVERIFIED',`Application ${appExternalId} is not a verified exact object.`);
                const targetKey=`element-relation|${row.rowKey}|${appExternalId}`;
                if(done(targetKey)) continue;
                const target={targetIdentityKey:`relation|${row.workspaceId}|${objectId}|${appId}|InfrastructureApplication`,workspaceId:row.workspaceId};
                const query={associationType:'InfrastructureApplication',itElementId:objectId,associatingEntityId:appId,workspaceId:row.workspaceId};
                const before=await invoke(RETURN_OPERATIONS.relationPreflight,binding,{target,query});
                const relationResult=before.associated===true&&before.inconsistent===false
                  ?await closeVerified(targetKey,RETURN_OPERATIONS.relationWrite,RETURN_OPERATIONS.relationRead,{target,query},(observed)=>observed.associated===true&&observed.inconsistent===false)
                  :await verifiedMutation({targetKey,target,preflightOperation:RETURN_OPERATIONS.relationPreflight,preflightRequest:{target,query},mutationOperation:RETURN_OPERATIONS.relationWrite,commandKind:'associate_relation',acceptPreflight:(observed)=>observed.associated===false&&observed.inconsistent===false,mutationPayload:{ItElementId:objectId,AssociatingEntityIds:[appId],associationType:'InfrastructureApplication',ConcurrencyTabId:602,workspaceId:row.workspaceId,engagementId:binding.engagementId},readOperation:RETURN_OPERATIONS.relationRead,readRequest:{target,query},verify:(observed)=>observed.associated===true&&observed.inconsistent===false});
                await store.call('projectVerifiedReturn',{runId,commandId:relationResult.command.commandId,binding,workspaceId:row.workspaceId,projectionKind:'relation',relationType:'InfrastructureApplication',relationKey:targetKey,sourceObjectId:objectId,targetObjectId:appId,payload:relationResult.observed});
              }
            }
            const graTarget = { targetIdentityKey: identityKey('gra', [row.rowKey, row.workspaceId]), workspaceId: row.workspaceId };
            let graId = row.graId; let graResult;
            const graPreflightRequest = { target: graTarget, query: { entityId: objectId, itElementType: row.objectType, name: row.graName, workspaceId: row.workspaceId } };
            if (done(`gra|${row.rowKey}`)) {
              if (!graId) fail('RETURN.RESUME_GRA_MISSING', `Verified GRA ${row.elementId} is absent during continuation.`);
            } else if (graId) graResult = await verifiedExisting({ targetKey: `gra|${row.rowKey}`, mutationOperation: RETURN_OPERATIONS.graCreate,
              preflightOperation: RETURN_OPERATIONS.graPreflight, preflightRequest: graPreflightRequest, readOperation: RETURN_OPERATIONS.graRead,
              readRequest: { target: graTarget, riskAssessmentId: graId,query:{entityId:objectId,name:row.graName,itElementType:row.objectType,inkContentId:row.content.inkContentId,typeId:row.content.typeId} }, verify: (value) => responseId(value, 'GRA read-back') === graId });
            else graResult = await verifiedMutation({ targetKey: `gra|${row.rowKey}`, target: graTarget,
              preflightOperation: RETURN_OPERATIONS.graPreflight, preflightRequest: graPreflightRequest,
              acceptPreflight:(observed)=>observed.found===false,
              mutationOperation: RETURN_OPERATIONS.graCreate, commandKind: 'create_gra', mutationPayload: {
                inkContentId: row.content.inkContentId, typeId: row.content.typeId, facetId: row.workspaceId,
                entityId: objectId, name: row.graName, engagementId: binding.engagementId
              }, readOperation: RETURN_OPERATIONS.graRead,
              readRequest: (response) => ({ target: graTarget, riskAssessmentId: responseId(response, 'created GRA'),query:{entityId:objectId,name:row.graName,itElementType:row.objectType,inkContentId:row.content.inkContentId,typeId:row.content.typeId} }),
              verify: (value, response) => responseId(value, 'GRA read-back') === responseId(response, 'created GRA') });
            graId = graId || responseId(graResult.response, 'created GRA'); graIds.set(runtimeKey(row.kind,row.elementId,row.workspaceId), graId);
            if (graResult) await projectObject(graResult, row, `gra|${row.rowKey}`, 'GRA', graId);
          }
          for (const row of ordered) {
            const objectId = objectIds.get(runtimeKey(row.kind,row.elementId,row.workspaceId)); const graId = graIds.get(runtimeKey(row.kind,row.elementId,row.workspaceId));
            let mode = row.mode;
            const statePatches = ['APP','TOOL'].includes(row.kind) ? [['status','EvaluationStarted'], ['rait',mode]] : [['status','EvaluationStarted']];
            for (const [patchKind, value] of statePatches) {
              const targetKey = `gra-${patchKind === 'status' ? 'status' : 'rait'}|${row.rowKey}`;
              if (done(targetKey)) continue;
              const target = { targetIdentityKey: identityKey('gra-state', [row.rowKey, patchKind]), workspaceId: row.workspaceId };
              const before = await invoke(RETURN_OPERATIONS.graStatePreflight, binding, { target, riskAssessmentId: graId });
              const currentValue = patchKind === 'status' ? before.status : before.itElementRaitConclusionLevelId || before.itElementRaitConclusionLevelName;
              const stateResult = String(currentValue) === String(value)
                ? await closeVerified(targetKey,RETURN_OPERATIONS.graStateWrite,RETURN_OPERATIONS.graStateRead,{target,query:{riskAssessmentId:graId,patchKind,value}},(observed)=>observed.verified===true)
                : await verifiedMutation({ targetKey, target, preflightOperation: RETURN_OPERATIONS.graStatePreflight,
                  preflightRequest: { target, riskAssessmentId: graId }, mutationOperation: RETURN_OPERATIONS.graStateWrite,
                  commandKind: 'patch_gra_state', mutationPayload: { engagementId: binding.engagementId, workspaceId: row.workspaceId, riskAssessmentId: graId, patchKind, value },
                  readOperation: RETURN_OPERATIONS.graStateRead, readRequest: { target, query: { riskAssessmentId: graId, patchKind, value } }, verify: (observed) => observed.verified === true });
              await projectGraRevision(stateResult, row, targetKey, graId);
            }
            for (const appExternalId of row.relations) {
              const appRows=ordered.filter((item)=>item.kind==='APP'&&item.elementId.toLocaleLowerCase('en-US')===appExternalId.toLocaleLowerCase('en-US'));
              if(appRows.length!==1) fail('RETURN.RELATION_TARGET_UNVERIFIED', `Application ${appExternalId} does not resolve to one exact Workspace-bound object.`);
              const appId = objectIds.get(runtimeKey('APP',appRows[0].elementId,appRows[0].workspaceId));
              if (!appId) fail('RETURN.RELATION_TARGET_UNVERIFIED', `Application ${appExternalId} is not a verified exact object.`);
              const targetKey = `element-relation|${row.rowKey}|${appExternalId}`;
              if (done(targetKey)) continue;
              const target = { targetIdentityKey:`relation|${row.workspaceId}|${objectId}|${appId}|InfrastructureApplication`, workspaceId: row.workspaceId };
              const query = { associationType: 'InfrastructureApplication', itElementId: objectId, associatingEntityId: appId, workspaceId: row.workspaceId };
              const relationBefore = await invoke(RETURN_OPERATIONS.relationPreflight, binding, { target, query });
              const result = relationBefore.associated === true && relationBefore.inconsistent === false
                ? await closeVerified(targetKey,RETURN_OPERATIONS.relationWrite,RETURN_OPERATIONS.relationRead,{target,query},(observed)=>observed.associated===true&&observed.inconsistent===false)
                : await verifiedMutation({ targetKey, target, preflightOperation: RETURN_OPERATIONS.relationPreflight,
                preflightRequest: { target, query }, mutationOperation: RETURN_OPERATIONS.relationWrite, commandKind: 'associate_relation',
                acceptPreflight:(observed)=>observed.associated===false&&observed.inconsistent===false,
                mutationPayload: { ItElementId: objectId, AssociatingEntityIds: [appId], associationType: 'InfrastructureApplication', ConcurrencyTabId: 602, workspaceId: row.workspaceId, engagementId: binding.engagementId },
                readOperation: RETURN_OPERATIONS.relationRead, readRequest: { target, query }, verify: (observed) => observed.associated === true && observed.inconsistent === false });
              await store.call('projectVerifiedReturn', { runId, commandId: result.command.commandId, binding, workspaceId: row.workspaceId,
                projectionKind: 'relation', relationType: 'InfrastructureApplication', relationKey: targetKey,
                sourceObjectId: objectId, targetObjectId: appId, payload: result.observed });
            }
            if(['DB','OS'].includes(row.kind)){
              const source=row.inheritanceSources[0]; const appRow=ordered.find((item)=>item.kind==='APP'&&item.elementId.toLocaleLowerCase('en-US')===source.externalId.toLocaleLowerCase('en-US')&&item.workspaceName.normalize('NFKC')===source.workspaceName.normalize('NFKC'));
              if(!appRow) fail('RETURN.RAIT_INHERITANCE_DRIFT',`${row.kind} ${row.elementId} inheritance source disappeared.`);
              const appGraId=graIds.get(runtimeKey('APP',appRow.elementId,appRow.workspaceId)); const sourceKey=`inheritance-source|${row.rowKey}|${appRow.rowKey}`;
              const sourceTarget={targetIdentityKey:identityKey('gra-state',[row.rowKey,appRow.rowKey,'inheritance']),workspaceId:appRow.workspaceId};
              const sourceBefore=await invoke(RETURN_OPERATIONS.graStatePreflight,binding,{target:sourceTarget,riskAssessmentId:appGraId});
              const liveInheritedMode=normalizeRait(sourceBefore.itElementRaitConclusionLevelId||sourceBefore.itElementRaitConclusionLevelName);
              if(!['Higher','Lower'].includes(liveInheritedMode)||liveInheritedMode!==normalizeRait(appRow.mode)) fail('RETURN.RAIT_INHERITANCE_DRIFT',`${row.kind} ${row.elementId} live APP GRA RAIT differs from the frozen APP plan.`);
              const sourceResult=await closeVerified(sourceKey,RETURN_OPERATIONS.graStateWrite,RETURN_OPERATIONS.graStateRead,{target:sourceTarget,query:{riskAssessmentId:appGraId,patchKind:'rait',value:liveInheritedMode}},(observed)=>observed.verified===true);
              await projectGraRevision(sourceResult,appRow,sourceKey,appGraId); mode=liveInheritedMode;
              const targetKey=`gra-rait|${row.rowKey}`;
              if(!done(targetKey)){
                const target={targetIdentityKey:identityKey('gra-state',[row.rowKey,'rait']),workspaceId:row.workspaceId}; const before=await invoke(RETURN_OPERATIONS.graStatePreflight,binding,{target,riskAssessmentId:graId}); const currentValue=before.itElementRaitConclusionLevelId||before.itElementRaitConclusionLevelName;
                const stateResult=String(currentValue)===String(mode)?await closeVerified(targetKey,RETURN_OPERATIONS.graStateWrite,RETURN_OPERATIONS.graStateRead,{target,query:{riskAssessmentId:graId,patchKind:'rait',value:mode}},(observed)=>observed.verified===true):await verifiedMutation({targetKey,target,preflightOperation:RETURN_OPERATIONS.graStatePreflight,preflightRequest:{target,riskAssessmentId:graId},mutationOperation:RETURN_OPERATIONS.graStateWrite,commandKind:'patch_gra_state',mutationPayload:{engagementId:binding.engagementId,workspaceId:row.workspaceId,riskAssessmentId:graId,patchKind:'rait',value:mode},readOperation:RETURN_OPERATIONS.graStateRead,readRequest:{target,query:{riskAssessmentId:graId,patchKind:'rait',value:mode}},verify:(observed)=>observed.verified===true});
                await projectGraRevision(stateResult,row,targetKey,graId);
              }
            }
            const contentName = row.content.contentName; const selected = governance.relations.filter((relation) => relationApplicable(relation, row, contentName, mode));
            const catalog = selected.length ? await invoke(RETURN_OPERATIONS.riskCatalog, binding, { target: { targetIdentityKey: identityKey('risk-catalog', [row.rowKey]), workspaceId: row.workspaceId }, riskAssessmentId: graId }) : { risks: [], controls: [] };
            const normalized = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
            for (const relation of selected.filter((item) => linkRequired(item, mode))) {
              const risks = catalog.risks.filter((item) => normalized(item.name) === normalized(relation.riskName) && normalized(item.classification) === normalized(relation[`classification${mode}`]));
              const controls = catalog.controls.filter((item) => normalized(item.name) === normalized(relation.controlName));
              if (risks.length !== 1 || controls.length !== 1) fail('RETURN.RISK_CONTROL_CATALOG_DRIFT', `Risk/Control catalog identity is absent or ambiguous: ${relation.relationId}.`);
              const risk = risks[0]; const control = controls[0]; const targetKey = `risk-control|${row.rowKey}|${relation.relationId}`;
              if (done(targetKey)) continue;
              const target = { targetIdentityKey: identityKey('risk-control', [row.rowKey, relation.relationId]), workspaceId: row.workspaceId };
              const riskQuery = { riskRiskScopeId: risk.riskRiskScopeId, riskId: risk.riskId, controlId: control.controlId, assertion: risk.assertion };
              const existingRisk = await invoke(RETURN_OPERATIONS.riskRead, binding, { target, query: riskQuery });
              if(existingRisk.verified===true&&!targetByKey.get(targetKey).resolvedCatalog) fail('RETURN.POST_CREATE_RISK_ALREADY_ASSOCIATED',`Post-create Risk-Control ${relation.relationId} became associated before its frozen mutation; a new review is required.`);
              const result = existingRisk.verified === true ? await closeVerified(targetKey,RETURN_OPERATIONS.riskWrite,RETURN_OPERATIONS.riskRead,{target,query:riskQuery},(observed)=>observed.verified===true) : await verifiedMutation({ targetKey, target, preflightOperation: RETURN_OPERATIONS.riskPreflight,
                preflightRequest: { target, query: { riskId: risk.riskId, riskClassification: risk.classification, controlId: control.controlId } },
                mutationOperation: RETURN_OPERATIONS.riskWrite, commandKind: 'associate_risk_control', mutationPayload: {
                  engagementId:binding.engagementId,workspaceId:row.workspaceId,riskAssessmentId:graId,riskName:relation.riskName,
                  controlName:relation.controlName,riskClassification:relation[`classification${mode}`],riskId:risk.riskId,updatedOn:risk.updatedOn,
                  isPurgeControlHiddenData: false, controlRiskScopes: [{ controlId: control.controlId, riskScopeId: risk.riskRiskScopeId,
                    assertionType: risk.assertion, riskId: risk.riskId, assertions: [{ assertion: risk.assertion }] }]
                }, acceptPreflight: (preflight) => preflight.requiresPurge === false,
                raceReadOperation:RETURN_OPERATIONS.riskRead,raceReadRequest:{target,query:riskQuery},raceAlreadyApplied:(observed)=>observed.verified===true,
                readOperation: RETURN_OPERATIONS.riskRead, readRequest: { target, query: riskQuery }, verify: (observed) => observed.verified === true });
              await store.call('projectVerifiedReturn',{runId,commandId:result.command.commandId,binding,workspaceId:row.workspaceId,projectionKind:'relation',relationType:'risk_control',relationKey:targetKey,sourceObjectId:risk.riskId,targetObjectId:control.controlId,payload:{...result.observed,riskRiskScopeId:risk.riskRiskScopeId,assertion:risk.assertion,graId}});
            }
            if (row.kind === 'APP' && String(contentName).toLocaleLowerCase('en-US').includes('sap ecc')) {
              for (const item of governance.scoringItems) {
                const targetKey = `risk-factor|${row.rowKey}|${item.itemId}`;
                if (!targetByKey.has(targetKey)) continue;
                if (done(targetKey)) continue;
                const target = { targetIdentityKey: identityKey('risk-factor', [row.rowKey, item.itemId]), workspaceId: row.workspaceId };
                const factorPreflight = await invoke(RETURN_OPERATIONS.factorPreflight, binding, { target, query: { riskAssessmentId: graId, itemId: item.itemId, selectionMode: mode } });
                if (factorPreflight.applicable === false) {
                  const preflightRequest={target,query:{riskAssessmentId:graId,itemId:item.itemId,selectionMode:mode}};
                  const command = await commandFor(targetKey,RETURN_OPERATIONS.factorWrite,preflightRequest,target.targetIdentityKey);
                  await freezeRead(command.commandId,RETURN_OPERATIONS.factorPreflight,preflightRequest);
                  const observed=await invoke(RETURN_OPERATIONS.factorPreflight,binding,{...preflightRequest,receiptContext:{runId,commandId:command.commandId}});
                  if(observed.applicable!==false) fail('RETURN.FACTOR_APPLICABILITY_DRIFT',`Risk Factor ${item.itemId} applicability changed during authoritative closure.`);
                  await evidence(command.commandId,'reconcile','closed_not_applied',observed,true); continue;
                }
                const selectedValue = Number(factorPreflight.selected?.value); const currentValue = Number(factorPreflight.current?.value ?? factorPreflight.current);
                const factorReadRequest={target,query:{riskAssessmentId:graId,itemId:item.itemId,selectionMode:mode}};
                const frozenFactor=targetByKey.get(targetKey).resolvedFactor;
                const liveFactor={factorId:factorPreflight.factorId,selectedValue:factorPreflight.selected?.value,spectrumDigest:digest(Buffer.from(canonical(factorPreflight.spectrum||[])))};
                if(frozenFactor&&(String(frozenFactor.factorId)!==String(liveFactor.factorId)||Number(frozenFactor.selectedValue)!==Number(liveFactor.selectedValue)||String(frozenFactor.spectrumDigest)!==String(liveFactor.spectrumDigest))) fail('RETURN.FACTOR_SPECTRUM_DRIFT',`Risk Factor ${item.itemId} live spectrum changed after confirmation.`);
                const exactFactor=frozenFactor||liveFactor;
                const factorResult = selectedValue === currentValue ? await closeVerified(targetKey,RETURN_OPERATIONS.factorWrite,RETURN_OPERATIONS.factorRead,factorReadRequest,(observed)=>observed.verified===true) : await verifiedMutation({ targetKey, target, preflightOperation: RETURN_OPERATIONS.factorPreflight,
                  preflightRequest: { target, query: { riskAssessmentId: graId, itemId: item.itemId, selectionMode: mode } },
                  mutationOperation:RETURN_OPERATIONS.factorWrite,commandKind:'patch_risk_factor',mutationPayload:{engagementId:binding.engagementId,workspaceId:row.workspaceId,riskAssessmentId:graId,itemId:item.itemId,selectionMode:mode,
                    factorId:exactFactor.factorId,selectedValue:exactFactor.selectedValue,spectrumDigest:exactFactor.spectrumDigest},
                  readOperation: RETURN_OPERATIONS.factorRead, readRequest: { target, query: { riskAssessmentId: graId, itemId: item.itemId, selectionMode: mode } }, verify: (observed) => observed.verified === true });
                await projectGraRevision(factorResult, row, targetKey, graId);
              }
              const docKey = `documentation|${row.rowKey}`; const docIntent = targetByKey.get(docKey);
              if (docIntent && !done(docKey)) {
                const target = { targetIdentityKey: identityKey('documentation', [row.rowKey]), workspaceId: row.workspaceId };
                const plainText = docIntent.plainText; const editorData = `<p>${plainText.replace(/[&<>]/gu, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[char]))}</p>`;
                const currentDoc = await invoke(RETURN_OPERATIONS.documentationPreflight, binding, { target, riskAssessmentId: graId });
                const observedDoc = currentDoc.documentation?.documentation || currentDoc.documentation;
                const docResult = String(observedDoc?.editorData || '') === editorData && String(observedDoc?.plainText || '') === plainText
                  ? await closeVerified(docKey,RETURN_OPERATIONS.documentationWrite,RETURN_OPERATIONS.documentationRead,{target,query:{riskAssessmentId:graId,editorData,plainText}},(observed)=>observed.verified===true)
                  : await verifiedMutation({ targetKey: docKey, target, preflightOperation: RETURN_OPERATIONS.documentationPreflight,
                  preflightRequest: { target, riskAssessmentId: graId }, mutationOperation: RETURN_OPERATIONS.documentationWrite, commandKind: 'patch_documentation',
                  mutationPayload: { engagementId: binding.engagementId, workspaceId: row.workspaceId, riskAssessmentId: graId, editorData, plainText },
                  readOperation: RETURN_OPERATIONS.documentationRead, readRequest: { target, query: { riskAssessmentId: graId, editorData, plainText } }, verify: (observed) => observed.verified === true });
                await projectGraRevision(docResult, row, docKey, graId);
              }
            }
            const evaluationKey = `evaluation|${row.rowKey}`; const evaluationTarget = { targetIdentityKey: identityKey('evaluation', [row.rowKey]), workspaceId: row.workspaceId };
            if (done(evaluationKey)) continue;
            const currentEvaluation = await invoke(RETURN_OPERATIONS.evaluationPreflight, binding, { target: evaluationTarget, riskAssessmentId: graId });
            const evaluationResult = currentEvaluation.status === 'EvaluationComplete'
              ? await closeVerified(evaluationKey,RETURN_OPERATIONS.evaluationWrite,RETURN_OPERATIONS.evaluationRead,{target:evaluationTarget,riskAssessmentId:graId},(observed)=>observed.verified===true)
              : await verifiedMutation({ targetKey: evaluationKey, target: evaluationTarget, preflightOperation: RETURN_OPERATIONS.evaluationPreflight,
              preflightRequest: { target: evaluationTarget, riskAssessmentId: graId }, mutationOperation: RETURN_OPERATIONS.evaluationWrite, commandKind: 'submit_evaluation',
              mutationPayload: { engagementId: binding.engagementId, workspaceId: row.workspaceId, riskAssessmentId: graId },
              readOperation: RETURN_OPERATIONS.evaluationRead, readRequest: { target: evaluationTarget, riskAssessmentId: graId }, verify: (observed) => observed.verified === true });
            await projectGraRevision(evaluationResult, row, evaluationKey, graId);
          }
          await store.call('recordBootstrapCapabilityEvidence',{
            schemaVersion:'omnia.feature-capability-evidence-bootstrap/v1',runId,...RETURN_CAPABILITY,
            connectorBinding:binding,safetyLock:input.context.safetyLock
          });
          await store.call('finishReturn', { runId, outcome: 'succeeded' });
          await store.call('savePlan', { ...checkpoint, execution: { state: 'completed' }, updatedAt: new Date().toISOString() });
          const completedLatest=await store.call('loadLatestRun',{});
          return { surfacePatch:returnSurface(completedLatest,'Return completed with authoritative read-back and durable projection for every intent.'),messageCard: { messageId: checkpoint.confirmation.messageId, featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
            surfaceId:'create-associate.workbench',runId,confirmationId:checkpoint.confirmation.confirmationId,stateVersion:Number(input.expectedStateVersion)+1,
            state: 'completed', title: '回传完成', summary: '所有冻结 intent 均已通过第二次预检、写入、权威读回和 Managed Content 投影。', details: [{label:'计划摘要',value:planDigest}], actions: [] } };
        } catch (error) {
          if (error?.code === 'RETURN.UNCERTAIN') { const uncertainLatest=await store.call('loadLatestRun',{}); return { surfacePatch:returnSurface(uncertainLatest,'Mutation response was lost; the durable Run is uncertain and only read-only reconcile is allowed.'),messageCard: { messageId: checkpoint.confirmation.messageId, featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
            surfaceId:'create-associate.workbench',runId,confirmationId:checkpoint.confirmation.confirmationId,stateVersion:Number(input.expectedStateVersion)+1,state:'uncertain',
            title: '回传结果待核验', summary: '写入响应丢失；禁止重放，只允许执行签名只读 reconcile。', details: [{label:'计划摘要',value:planDigest}],
            actions: [{ actionId:'reconcile-return',label:'只读核验',effect:'read_only',enabled:true,reason:'',selectionMode:'none',dependencies:['remote_connector','safety_lock'] }] } }; }
          const failedLatest=await store.call('loadLatestRun',{});
          if(failedLatest?.run?.state==='returning'||failedLatest?.run?.state==='verifying') await store.call('finishReturn',{runId,outcome:'failed',error:String(error.message||error)});
          await store.call('savePlan',{...checkpoint,execution:{state:'failed',error:{code:String(error.code||'RETURN.FAILED'),message:String(error.message||error)}},updatedAt:new Date().toISOString()});
          const terminalLatest=await store.call('loadLatestRun',{});
          return {surfacePatch:returnSurface(terminalLatest,`Return failed: ${String(error.message||error)}`),messageCard:{messageId:checkpoint.confirmation.messageId,featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,surfaceId:'create-associate.workbench',runId,confirmationId:checkpoint.confirmation.confirmationId,stateVersion:Number(input.expectedStateVersion)+1,state:'failed',title:'回传失败',summary:'确定性预检、业务校验或读回失败；冻结计划不可重放，必须重新准备并审核新计划。',details:[{label:'计划摘要',value:planDigest},{label:'失败',value:`${String(error.code||'RETURN.FAILED')}: ${String(error.message||error)}`}],actions:[]}};
        }
      }
      if (input?.actionId === 'prepare-return') {
        const latest = await store.call('loadLatestRun', {}); const run = latest?.run;
        if (!run || run.state !== 'ready_for_review') fail('RUN.NOT_REVIEWABLE', 'The latest Run is not ready for return review.');
        const checkpoint = await store.call('loadPlan', String(run.run_id));
        if (!checkpoint?.parsed) fail('RUN.CHECKPOINT_MISSING', 'The durable conversion checkpoint is unavailable.');
        {
          const prepared = await buildReturnPreparation(checkpoint, input.context);
          const plan = { schemaVersion: 'omnia.create-associate.return-plan/v1', runId: run.run_id,
            authority: prepared.authority, rows: prepared.rows, targets: prepared.targets, initialPreflights: prepared.preflights };
          const preflightDigest = digest(Buffer.from(canonical({ authority: prepared.authority, preflights: prepared.preflights })));
          const authorityDigest = digest(Buffer.from(canonical({
            connectorId: input.context.connectorBinding.connectorId, sessionGeneration: Number(input.context.connectorBinding.sessionGeneration),
            engagementId: input.context.connectorBinding.engagementId, authorityInstanceId: input.context.connectorBinding.authorityInstanceId,
            tenantOrOrgId: input.context.connectorBinding.tenantOrOrgId, packId: input.context.connectorBinding.packId,
            workspaceIds: input.context.safetyLock.workspaceIds
          })));
          const elementTargets=prepared.targets.filter((item)=>item.kind==='object'&&item.objectType!=='GRA');
          const existingObjects=elementTargets.filter((item)=>['reuse','resume'].includes(item.disposition)).length;
          const newObjects=elementTargets.filter((item)=>item.disposition==='create').length;
          const visibleDetails = [
            {label:'Pack / Workspace',value:`${input.context.connectorBinding.packId} · ${prepared.authority.workspaces.map((item)=>item.name).join('、')}`},
            {label:'元素',value:`${prepared.rows.length} 个：${prepared.rows.map((row)=>`${row.kind} ${row.elementId}`).join('；')}`},
            {label:'对象处理',value:`${existingObjects} 个复用/恢复，${newObjects} 个新建`},
            {label:'关系',value:`${prepared.targets.filter((item)=>item.kind==='relation').length} 项`},
            {label:'Risk-Control',value:`${prepared.targets.filter((item)=>item.kind==='risk_control').length} 项`},
            {label:'计划摘要',value:'(freezing)'}
          ];
          const frozen = await store.call('prepareReturnIntent', {
            runId: run.run_id, plan, connectorBinding: input.context.connectorBinding, safetyLock: input.context.safetyLock,
            credentialDigest: authorityDigest, preflightDigest
          });
          const capabilityState=await store.call('getCapabilityEvidenceState',{...RETURN_CAPABILITY,connectorBinding:input.context.connectorBinding,workspaceIds:input.context.safetyLock.workspaceIds});
          await store.call('savePlan', { ...checkpoint, returnPlan: plan, confirmation: frozen, preflightDigest, updatedAt: new Date().toISOString() });
          const frozenLatest=await store.call('loadLatestRun',{});
          return { surfacePatch:returnSurface(frozenLatest,capabilityState.verified?'回传计划已冻结；当前 scope 已有有效读回验证证据，等待 Comments 明确确认。':'回传计划已冻结，等待 Comments 中的一次明确确认。首次真实回传验证将在确认后写入当前 Pack。'),messageCard: {
            messageId: frozen.messageId, featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
            surfaceId: 'create-associate.workbench', runId: run.run_id, confirmationId: frozen.confirmationId,
            stateVersion: frozen.stateVersion, state: 'pending_confirmation', title: '新建与关联回传审核',
            summary: `已冻结 ${prepared.rows.length} 个元素的回传计划：${existingObjects} 个复用/恢复，${newObjects} 个新建；确认后执行二次预检、写入与权威读回。`,
            details: visibleDetails.map((detail) => detail.label === '计划摘要' ? { ...detail, value: frozen.planDigest } : detail),
            actions: [{ actionId: 'confirm-return', label: '确认回传', effect: 'omnia_mutation', enabled: true,
              reason:'', selectionMode: 'none',
              dependencies: ['remote_connector', 'safety_lock'] }]
          } };
        }
      }
      if (['apply-revisions','remove-batch-row','revalidate-all','back-to-upload'].includes(input?.actionId)) {
        const latest=await store.call('loadLatestRun',{}),run=latest?.run;if(!run||!['needs_input','ready_for_review'].includes(run.state))fail('RUN.NOT_EDITABLE','The latest Run is not in canonical Review.');
        const plan=await store.call('loadPlan',String(run.run_id));if(!plan?.parsed||!plan?.descriptor)fail('RUN.CHECKPOINT_MISSING','The durable Review checkpoint is unavailable.');
        if(input.actionId==='back-to-upload'){plan.reviewNavigation='upload';plan.updatedAt=new Date().toISOString();await store.call('savePlan',plan);return{surfacePatch:uploadSurface(latest,'已返回独立 Upload 层；当前源 Artifact、字段 revisions 与排除状态均保留。')};}
        const revisions=['apply-revisions','revalidate-all'].includes(input.actionId)?(input.payload?.revisions||[]):[];if(!Array.isArray(revisions))fail('REVISION.BATCH_INVALID','Review revisions must be an array.');const derivedRevisions=[];
        for(const change of revisions){const row=plan.parsed.rows.find((item)=>item.rowKey===change.rowKey),candidate=plan.parsed.candidates.find((item)=>item.fieldKey===change.fieldKey&&item.provenance?.rowKey===change.rowKey);if(!row||!candidate||Number(candidate.revision)!==Number(change.expectedRevision)||['derived','rule_default','inherited'].includes(candidate.valueKind))fail('REVISION.CAS_MISMATCH','Review field changed; reload before saving.');const spec=REVIEW_MATRIX[row.kind].find((item)=>item[0]===candidate.rawFieldKey);const value=String(change.value??'').normalize('NFC').trim();if(!spec||value.length>Number(spec[4]))fail('REVISION.VALUE_INVALID',`${candidate.rawFieldKey} exceeds its official limit.`);candidate.value=value;candidate.revision=Number(change.expectedRevision)+1;candidate.valueKind='user_revision';candidate.status='accepted';row.fields[candidate.rawFieldKey]=value;if(candidate.rawFieldKey===REVIEW_MATRIX[row.kind][0][0]){row.elementId=value;for(const [rawFieldKey,derivedValue] of [['Derived GRA Name',deriveGraName(value)],[descriptionRawField(row.kind),value]]){const derived=reviewCandidate(plan.parsed,row,rawFieldKey);if(!derived||derived.valueKind!=='derived')fail('REVISION.DERIVED_LINEAGE_MISSING',`${rawFieldKey} has no signed derived candidate lineage.`);const expectedRevision=Number(derived.revision);derived.value=derivedValue;derived.revision=expectedRevision+1;derived.status='accepted';derived.provenance.dependencyFieldKey=candidate.fieldKey;row.fields[rawFieldKey]=derivedValue;derivedRevisions.push({fieldKey:derived.fieldKey,expectedRevision,value:derivedValue,dependencyFieldKey:candidate.fieldKey,dependencyRevision:candidate.revision});}}if(candidate.rawFieldKey==='关联系统ID')row.relations=value.split(/[、,，;；]/u).map((item)=>item.trim()).filter(Boolean);}
        let excludedRowKey='';if(input.actionId==='remove-batch-row'){excludedRowKey=String(input.payload?.rowKey||'');if(Number(input.payload?.expectedRunRevision)!==Number(run.state_revision))fail('RUN.REVISION_MISMATCH','Run revision changed before row removal.');if(activeRows(plan.parsed).length<=1)fail('REVIEW.LAST_ROW','The final active batch row cannot be removed.');if(!activeRows(plan.parsed).some((row)=>row.rowKey===excludedRowKey))fail('REVIEW.ROW_MISSING','Selected batch row is unavailable.');plan.parsed.excludedRowKeys=[...new Set([...(plan.parsed.excludedRowKeys||[]),excludedRowKey])];}
        recomputeLocalIssues(plan.parsed);plan.liveValidation=await runReviewLiveValidation(plan,input.context);plan.reviewNavigation='review';const validation=validationPresentation(plan.parsed,plan.liveValidation);const blocker=validation.progress.items.some((item)=>item.state==='failed'||item.state==='pending');const compiled=await compileInstance({...plan.parsed,rows:activeRows(plan.parsed)},plan.descriptor,run.run_id,run.trace_id);
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
        await store.call('savePlan',{schemaVersion:'omnia.create-associate.staged-upload/v1',planId:String(run.run_id),runId:String(run.run_id),traceId:String(run.trace_id),descriptor,stageState:'acquiring',updatedAt:new Date().toISOString()});
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
      const artifact=await store.call('readArtifactBytes',{artifactId:descriptor.artifactId});
      if(artifact.runId!==descriptor.runId||artifact.traceId!==descriptor.traceId||artifact.artifactId!==descriptor.artifactId)fail('ARTIFACT.RUN_BINDING_MISMATCH','Core-managed artifact Run/trace binding drifted.');
      const runId=artifact.runId;const traceId=artifact.traceId;let revision=Number(run.state_revision);
      let parsed;
      try { parsed = parseUserWorkbook(Buffer.from(artifact.contentBase64, 'base64'), descriptor.artifactId, governance);recomputeLocalIssues(parsed); }
      catch (error) {
        await store.call('transitionRun', { runId, expectedRevision: revision, toState: 'failed', eventType: 'workbook.rejected', error: error.message });
        throw error;
      }
      revision = await store.call('transitionRun', { runId, expectedRevision: revision, toState: 'converting', eventType: 'workbook.contract_verified' });
      let compiled,output,unresolved;
      try{
        compiled = await compileInstance(parsed, descriptor, runId, traceId); output=compiled.output;
        const checkpoint={...stagedPlan,planId:runId,runId,traceId,descriptor,parsed,stageState:'validated',reviewNavigation:'review',createdAt:stagedPlan.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};checkpoint.liveValidation=await runReviewLiveValidation(checkpoint,input.context);
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

module.exports = { createFeatureWorker, parseV8, parseUserWorkbook, buildRuntimeWorkbook, zipEntries, zip, V8_SHA256,deriveGraName,recomputeLocalIssues,validationPresentation,reviewPresentation,reviewBlocked,freezeAppDataAvailability,resolveFrozenAppDataAvailability,workflowSurface,normalizeRait,applicationIdentityRequest,inspectApplicationIdentity,RETURN_OPERATIONS };
