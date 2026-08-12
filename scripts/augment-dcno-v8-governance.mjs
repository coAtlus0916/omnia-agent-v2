#!/usr/bin/env node
'use strict';

/**
 * Add the recorded DCNO/Network governance slice to the signed V8 source
 * workbook.  This is deliberately a small OOXML patcher: all ZIP members are
 * read through the managed worker's zipEntries/zip functions and only the two
 * governance worksheets (and their two table range declarations) are changed.
 *
 * The command is parameterised with --input and --output (or the
 * DCNO_V8_INPUT/DCNO_V8_OUTPUT environment variables).  With no arguments it
 * patches the managed source workbook in place.  A second invocation notices
 * the complete target inventory and exits without writing anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const worker = require('../feature-packages/create-associate/source/middle/worker.cjs');

const BASE_SHA256 = '4093CEF41FD91D5A91C644149072E83931FADB61CF382A600EF0A688E4917C95';
const DEFAULT_WORKBOOK = path.resolve(import.meta.dirname, '../feature-packages/create-associate/source/managed/phase1-system-information-v8.xlsx');

const ARTIFACT_ID = '110eba6d-dd39-4b20-bfd5-83caefd20260';
const ARTIFACT_SHA256 = 'd44d21b3c41f900eedf93819bfe88a5b82c4d1bd9f3ff74f92a66f9e3cdee490';
const RECORDING_ID = '8aa3673e-53b7-4902-bca6-7b86d5cc62be';
const RECORDING_SHORT_ID = '8aa3673e';
const RECORDING_EVENTS = 992;
const EVIDENCE_REF = `artifact:${ARTIFACT_ID}#sha256=${ARTIFACT_SHA256}`;
const EVIDENCE_LOCATION = `${EVIDENCE_REF}; recordingId=${RECORDING_ID}; events=${RECORDING_EVENTS}`;
const LOWER_BOUNDARY_NOTE = '未录制 Lower，N 是执行阻断边界，不证明目录不存在。';

const FIELD_IDS = Object.freeze([
  'P1.DCNO.IT.ELEMENT_ID',
  'P1.DCNO.GRA.GRA_CONTENT',
  'P1.DCNO.IT.WORKSPACE',
  'P1.DCNO.IT.APPLICATION_RELATION',
  'P1.DCNO.GRA.RAIT_CONCLUSION',
  'P1.DCNO.IT.DESCRIPTION'
]);

const RISK_FIELDS = Object.freeze({
  RAITCOR001: 'P1.RISK.DCNO.NETWORK.RAITCOR001',
  RAITCOR008: 'P1.RISK.DCNO.NETWORK.RAITCOR008',
  RAITCOR006: 'P1.RISK.DCNO.NETWORK.RAITCOR006'
});

const CONTROL_FIELDS = Object.freeze({
  APP_03: 'P1.CONTROL.DCNO.NETWORK.APP_03',
  APP_06: 'P1.CONTROL.DCNO.NETWORK.APP_06',
  DCNO_05: 'P1.CONTROL.DCNO.NETWORK.DCNO_05',
  DCNO_10: 'P1.CONTROL.DCNO.NETWORK.DCNO_10',
  DCNO_21: 'P1.CONTROL.DCNO.NETWORK.DCNO_21',
  DCNO_22: 'P1.CONTROL.DCNO.NETWORK.DCNO_22',
  DCNO_23: 'P1.CONTROL.DCNO.NETWORK.DCNO_23',
  DCNO_24: 'P1.CONTROL.DCNO.NETWORK.DCNO_24'
});

const RELATION_IDS = Object.freeze([
  'REL.DCNO.NETWORK.RAITCOR008.DCNO_05',
  'REL.DCNO.NETWORK.RAITCOR006.DCNO_10',
  'REL.DCNO.NETWORK.RAITCOR008.DCNO_21',
  'REL.DCNO.NETWORK.RAITCOR008.DCNO_22',
  'REL.DCNO.NETWORK.RAITCOR008.DCNO_23',
  'REL.DCNO.NETWORK.RAITCOR008.DCNO_24',
  'REL.DCNO.NETWORK.RAITCOR001.APP_03',
  'REL.DCNO.NETWORK.RAITCOR001.APP_06'
]);

const FIELD_HEADERS = Object.freeze([
  'field_id', 'Phase', '场景/对象类型', '对象子类型/区段', 'Higher适用', 'Lower适用',
  'Omnia UI标准字段名', '字段用途', '填写责任/方式', '必填规则', '无资料时默认/回退', '允许值',
  'evidence_type', 'v4 JSON key/path', 'v4 endpoint+method / connector', '请求/响应位置', 'v4 DOM/selector',
  'v4证据路径+行号', '证据状态/置信度', '校验规则', 'source_trace_id', '备注'
]);
const RELATION_HEADERS = Object.freeze([
  'relation_id', 'risk_field_id', 'Risk标准名', 'control_field_id', 'Control标准名', '关系类型/方向',
  'catalog_present_higher', 'catalog_present_lower', 'link_required_higher', 'link_required_lower',
  'classification_higher', 'classification_lower', '执行适用层级', '适用场景/对象类型', '是否必需',
  '无资料时策略', 'v4 evidence_type', 'v4 JSON/API/DOM/connector路径', '证据文件+行号', '确认状态',
  'source_trace_id', '备注'
]);

const RISK_LABELS = Object.freeze({
  RAITCOR001: 'RAITCOR001｜通用网络设备 - 用户拥有的访问权限超出了执行分配的职责所必需的权限，这可能导致职责分离不当。',
  RAITCOR008: 'RAITCOR008｜通用网络设备 - 网络未能充分阻止未经授权的用户访问信息系统。',
  RAITCOR006: 'RAITCOR006｜通用网络设备 - 对系统软件 (如操作系统，网络，变更管理软件或访问控制软件) 进行了不适当的变更。'
});
const CONTROL_LABELS = Object.freeze({
  APP_03: 'APP.03｜用户访问权限复核',
  APP_06: 'APP.06｜特权 / 管理员访问',
  DCNO_05: 'DCNO.05｜身份验证 / 密码控制',
  DCNO_10: 'DCNO.10｜变更审批和测试',
  DCNO_21: 'DCNO.21｜网络分段',
  DCNO_22: 'DCNO.22｜漏洞扫描',
  DCNO_23: 'DCNO.23｜入侵检测',
  DCNO_24: 'DCNO.24｜VPN 访问配置'
});

function fail(message) { throw new Error(`[augment-dcno-v8] ${message}`); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(); }

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      console.log('Usage: node scripts/augment-dcno-v8-governance.mjs [--input workbook.xlsx] [--output workbook.xlsx]');
      process.exit(0);
    }
    if (!token.startsWith('--')) fail(`unknown argument ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`argument --${name} requires a value`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function xmlUnescape(value) {
  return String(value ?? '')
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)));
}

function xmlEscape(value) {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function columnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/u)?.[0] || '';
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function columnName(index) {
  let value = Number(index) + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function sharedStrings(entries) {
  const source = entries.get('xl/sharedStrings.xml');
  if (!source) return [];
  const xml = source.toString('utf8');
  return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/gu)].map((match) =>
    xmlUnescape([...match[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gu)].map((part) => part[1]).join(''))
  );
}

function parseWorksheet(xmlBytes, strings) {
  const xml = Buffer.from(xmlBytes).toString('utf8');
  const rows = new Map();
  const rowPattern = /<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/gu;
  for (const rowMatch of xml.matchAll(rowPattern)) {
    const rowNumber = Number(rowMatch[1].match(/\br="(\d+)"/u)?.[1] || 0);
    if (!rowNumber) continue;
    const cells = [];
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/gu;
    for (const cellMatch of rowMatch[2].matchAll(cellPattern)) {
      const attrs = cellMatch[1];
      const reference = attrs.match(/\br="([A-Z]+\d+)"/u)?.[1] || '';
      if (!reference) continue;
      const type = attrs.match(/\bt="([^"]+)"/u)?.[1] || '';
      const body = cellMatch[2] || '';
      const raw = body.match(/<(?:[A-Za-z_][\w.-]*:)?v>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/u)?.[1];
      const inline = body.match(/<(?:[A-Za-z_][\w.-]*:)?is>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/u)?.[1];
      let value = raw === undefined ? '' : xmlUnescape(raw);
      if (type === 's' && raw !== undefined) value = strings[Number(raw)] || '';
      if (type === 'inlineStr' && inline !== undefined) {
        value = xmlUnescape([...inline.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gu)].map((part) => part[1]).join(''));
      }
      cells[columnIndex(reference)] = value;
    }
    rows.set(rowNumber, cells);
  }
  return { xml, rows };
}

function populatedTable(parsed, headers = FIELD_HEADERS) {
  return [...parsed.rows.entries()]
    .filter(([rowNumber, values]) => rowNumber > 4 && values.some((value) => value !== undefined && value !== ''))
    .map(([sourceRow, values]) => ({ sourceRow, values: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ''])) }));
}

function inspectWorkbook(bytes) {
  const entries = worker.zipEntries(Buffer.from(bytes));
  const strings = sharedStrings(entries);
  const fieldSheet = parseWorksheet(entries.get('xl/worksheets/sheet2.xml'), strings);
  const relationSheet = parseWorksheet(entries.get('xl/worksheets/sheet3.xml'), strings);
  const fields = populatedTable(fieldSheet, FIELD_HEADERS);
  const relations = populatedTable(relationSheet, RELATION_HEADERS);
  return { entries, fieldSheet, relationSheet, fields, relations };
}

function fieldById(fields, id) { return fields.find((row) => String(row.values.field_id) === id); }
function relationById(relations, id) { return relations.find((row) => String(row.values.relation_id) === id); }

function assertHeaders(info) {
  const fieldHeader = info.fieldSheet.rows.get(4) || [];
  const relationHeader = info.relationSheet.rows.get(4) || [];
  if (FIELD_HEADERS.some((header, index) => fieldHeader[index] !== header)) fail('字段母版 row 4 header drifted.');
  if (RELATION_HEADERS.some((header, index) => relationHeader[index] !== header)) fail('Risk-Control关系 row 4 header drifted.');
}

function assertBaseline(info, inputSha) {
  if (inputSha !== BASE_SHA256) fail(`input SHA mismatch: expected ${BASE_SHA256}, got ${inputSha}.`);
  assertHeaders(info);
  if (info.fields.length !== 222 || info.relations.length !== 92) fail(`baseline count drifted: fields=${info.fields.length}, relations=${info.relations.length}.`);
  for (const id of FIELD_IDS) if (!fieldById(info.fields, id)) fail(`required existing field is missing: ${id}.`);
  if (info.relations.some((row) => String(row.values.relation_id || '').startsWith('REL.DCNO.NETWORK.'))) {
    fail('baseline already contains a REL.DCNO.NETWORK.* relation.');
  }
}

function inlineCell(reference, value) {
  return `<x:c r="${reference}" t="inlineStr"><x:is><x:t xml:space="preserve">${xmlEscape(value)}</x:t></x:is></x:c>`;
}

function rowXml(rowNumber, values) {
  return `<x:row r="${rowNumber}">${values.map((value, column) => inlineCell(`${columnName(column)}${rowNumber}`, value)).join('')}</x:row>`;
}

function appendRows(xml, startRow, rows) {
  const generated = rows.map((values, index) => rowXml(startRow + index, values)).join('');
  const close = /<\/(?:[A-Za-z_][\w.-]*:)?sheetData>/u;
  if (!close.test(xml)) fail('target worksheet has no sheetData close tag.');
  return xml.replace(close, `${generated}$&`);
}

function replaceCell(xml, rowNumber, column, value) {
  const rowPattern = /<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/gu;
  let replacedRow = false;
  const updated = xml.replace(rowPattern, (rowText, attrs, body) => {
    if (Number(attrs.match(/\br="(\d+)"/u)?.[1] || 0) !== rowNumber) return rowText;
    const reference = `${columnName(column)}${rowNumber}`;
    const cellPattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?c>)`, 'gu');
    let found = false;
    const nextBody = body.replace(cellPattern, (cellText, cellAttrs) => {
      if (cellAttrs.match(/\br="([A-Z]+\d+)"/u)?.[1] !== reference) return cellText;
      found = true;
      const withoutType = cellAttrs.replace(/\s+t="[^"]*"/u, '');
      return `<x:c${withoutType} t="inlineStr"><x:is><x:t xml:space="preserve">${xmlEscape(value)}</x:t></x:is></x:c>`;
    });
    if (!found) fail(`existing cell ${reference} is missing.`);
    replacedRow = true;
    return `<x:row${attrs}>${nextBody}</x:row>`;
  });
  if (!replacedRow) fail(`existing row ${rowNumber} is missing.`);
  return updated;
}

function updateSheetRanges(xml, lastRow) {
  const replaceRef = (text, attribute) => text.replace(new RegExp(`(<(?:[A-Za-z_][\\w.-]*:)?${attribute}\\b[^>]*\\bref=")([^"]+)(")`, 'gu'), (_match, prefix, ref, suffix) => {
    const start = String(ref).split(':')[0] || 'A1';
    const endColumn = String(ref).split(':')[1]?.match(/^[A-Z]+/u)?.[0] || 'V';
    return `${prefix}${start}:${endColumn}${lastRow}${suffix}`;
  });
  return replaceRef(replaceRef(xml, 'dimension'), 'autoFilter');
}

function updateTableRange(xml, lastRow) {
  return xml.replace(/(\bref=")([A-Z]+)(\d+):([A-Z]+)\d+(")/gu, (_match, prefix, startColumn, startRow, endColumn, suffix) => `${prefix}${startColumn}${startRow}:${endColumn}${lastRow}${suffix}`);
}

function riskFieldRow(code, enabledCount) {
  return [
    RISK_FIELDS[code], 'Phase 1', 'Risk', 'Network Infrastructure / DCNO', 'Y', 'N', RISK_LABELS[code],
    'Omnia 已识别风险及分类规则（通用网络设备目录）', 'Agent执行', '规则驱动', '目录缺失则停止并报错', 'Higher|Lower|ClassificationNA',
    'api', 'risks[].id/inkRiskNumber/riskNumber/description/riskRiskScopes[].id；planned detail.planResponseRisk[0].riskNumber/classificationType/riskRiskScopes',
    'GET /rapr/v0/engagements/{engagementId}/risks/byriskassessmentid；GET /plannedresponse/GetPlanResponseDetailByRiskRiskScopeId',
    '录制响应：risk id、riskNumber、description、riskRiskScopeId；Higher 精确读回', '', EVIDENCE_LOCATION,
    `真实录制证据；${enabledCount} enabled；${RECORDING_EVENTS} events；风险编号与描述精确匹配。`,
    'Higher=Higher；Lower 未录制，不作存在性结论；riskNumber 必须唯一精确匹配', `DCNO.RECORDING.${RECORDING_SHORT_ID}.RISK.${code}`,
    `目录身份来自真实录制：${EVIDENCE_REF}；recordingId=${RECORDING_ID}；${enabledCount} enabled。`
  ];
}

function controlFieldRow(code, observedState = 'observed') {
  const controlNumber = code.replace('_', '.');
  const sourceTrace = `DCNO.RECORDING.${RECORDING_SHORT_ID}.CONTROL.${code}`;
  return [
    CONTROL_FIELDS[code], 'Phase 1', 'Control', 'Network Infrastructure / DCNO', 'Y', 'N', CONTROL_LABELS[code],
    'Omnia Control 目录项（通用网络设备）', 'Omnia自动', '按关系规则', '目录缺失则停止并报错', '', 'api',
    'controls[].id/controlNumber/name/description/controlRiskScopes[]；planned detail.planResponseSelectedControl/planResponseControl[].controlNumber/enabled/currentRiskScopes[].riskId/riskScopeId/assertionType/assertions',
    'GET /rapr/v0/engagements/{engagementId}/controls/byRiskAssessmentId/{id}；GET /plannedresponse/GetPlanResponseDetailByRiskRiskScopeId',
    '录制响应：control id、controlNumber、controlRiskScopes[]；Higher 精确读回', '', EVIDENCE_LOCATION,
    `真实录制证据；${observedState}；controlNumber 必须唯一精确匹配；${RECORDING_EVENTS} events。`,
    'controlNumber 必须唯一精确匹配；不得仅按模糊描述关联', sourceTrace,
    `目录身份来自真实录制：${EVIDENCE_REF}；recordingId=${RECORDING_ID}；${observedState}。`
  ];
}

function relationRow({ relationId, riskCode, controlCode, higherRequired, required, status, sourceTraceId, observedState = '' }) {
  const lowerNote = LOWER_BOUNDARY_NOTE;
  const relationNote = [
    `Higher 目录与关系证据来自真实录制：${EVIDENCE_REF}；recordingId=${RECORDING_ID}；${RECORDING_EVENTS} events。`,
    observedState ? `observed=${observedState}; enabled=false。` : '',
    lowerNote
  ].filter(Boolean).join(' ');
  return [
    relationId, RISK_FIELDS[riskCode], RISK_LABELS[riskCode], CONTROL_FIELDS[controlCode], CONTROL_LABELS[controlCode], 'Risk -> Control',
    'Y', 'N', higherRequired ? 'Y' : 'N', 'N', 'Higher', '待确认', 'Higher', 'Network Infrastructure / DCNO', required ? 'Y' : 'N',
    '阻断：不创建、不降级、不猜测', 'api',
    'GET risks/byriskassessmentid；GET controls/byRiskAssessmentId/{id}；GET plannedresponse/GetPlanResponseDetailByRiskRiskScopeId',
    EVIDENCE_LOCATION, status, sourceTraceId, relationNote
  ];
}

const NEW_FIELD_ROWS = Object.freeze([
  riskFieldRow('RAITCOR001', 0),
  riskFieldRow('RAITCOR008', 5),
  riskFieldRow('RAITCOR006', 1),
  controlFieldRow('APP_03', 'observed/disabled'),
  controlFieldRow('APP_06', 'observed/disabled'),
  controlFieldRow('DCNO_05'),
  controlFieldRow('DCNO_10'),
  controlFieldRow('DCNO_21'),
  controlFieldRow('DCNO_22'),
  controlFieldRow('DCNO_23'),
  controlFieldRow('DCNO_24')
]);

const NEW_RELATION_ROWS = Object.freeze([
  relationRow({ relationId: RELATION_IDS[0], riskCode: 'RAITCOR008', controlCode: 'DCNO_05', higherRequired: true, required: true, status: '已确认-强', sourceTraceId: 'DCNO.RECORDING.8aa3673e.CONTROL.28ffdb1e' }),
  relationRow({ relationId: RELATION_IDS[1], riskCode: 'RAITCOR006', controlCode: 'DCNO_10', higherRequired: true, required: true, status: '已确认-强', sourceTraceId: 'DCNO.RECORDING.8aa3673e.CONTROL.3c01f852' }),
  relationRow({ relationId: RELATION_IDS[2], riskCode: 'RAITCOR008', controlCode: 'DCNO_21', higherRequired: true, required: true, status: '已确认-强', sourceTraceId: 'DCNO.RECORDING.8aa3673e.CONTROL.4fd6f7eb' }),
  relationRow({ relationId: RELATION_IDS[3], riskCode: 'RAITCOR008', controlCode: 'DCNO_22', higherRequired: true, required: true, status: '已确认-强', sourceTraceId: 'DCNO.RECORDING.8aa3673e.CONTROL.693bbcbe' }),
  relationRow({ relationId: RELATION_IDS[4], riskCode: 'RAITCOR008', controlCode: 'DCNO_23', higherRequired: true, required: true, status: '已确认-强', sourceTraceId: 'DCNO.RECORDING.8aa3673e.CONTROL.59c30262' }),
  relationRow({ relationId: RELATION_IDS[5], riskCode: 'RAITCOR008', controlCode: 'DCNO_24', higherRequired: true, required: true, status: '已确认-强', sourceTraceId: 'DCNO.RECORDING.8aa3673e.CONTROL.9f3dd69f' }),
  relationRow({ relationId: RELATION_IDS[6], riskCode: 'RAITCOR001', controlCode: 'APP_03', higherRequired: false, required: false, status: '部分确认', sourceTraceId: 'DCNO.RECORDING.8aa3673e.CONTROL.APP_03', observedState: 'true' }),
  relationRow({ relationId: RELATION_IDS[7], riskCode: 'RAITCOR001', controlCode: 'APP_06', higherRequired: false, required: false, status: '部分确认', sourceTraceId: 'DCNO.RECORDING.8aa3673e.CONTROL.APP_06', observedState: 'true' })
]);

function targetState(info) {
  try {
    assertHeaders(info);
    if (info.fields.length !== 233 || info.relations.length !== 100) return false;
    if (NEW_FIELD_ROWS.some((row) => !fieldById(info.fields, row[0]))) return false;
    if (RELATION_IDS.some((id) => !relationById(info.relations, id))) return false;
    const allDcnoRelations = info.relations.filter((row) => String(row.values.relation_id || '').startsWith('REL.DCNO.NETWORK.'));
    if (allDcnoRelations.length !== 8 || new Set(allDcnoRelations.map((row) => row.values.relation_id)).size !== 8) return false;
    const expectedById = new Map(NEW_RELATION_ROWS.map((row) => [row[0], row]));
    for (const relation of allDcnoRelations) {
      const expected = expectedById.get(relation.values.relation_id);
      if (!expected) return false;
      for (const index of [0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 18]) {
        if (String(relation.values[RELATION_HEADERS[index]]) !== String(expected[index])) return false;
      }
      if (!String(relation.values['备注']).includes(LOWER_BOUNDARY_NOTE)) return false;
    }
    for (const row of FIELD_IDS.map((id) => fieldById(info.fields, id))) {
      if (!row || !String(row.values['证据状态/置信度']).includes(String(RECORDING_EVENTS)) || String(row.values['备注']).includes('Return unsupported')) return false;
      if (!String(row.values['备注']).includes(EVIDENCE_REF) || !String(row.values['备注']).includes(RECORDING_ID)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function assertNewCellsInline(entries, sheetName, rowNumbers) {
  const xml = entries.get(sheetName)?.toString('utf8') || '';
  for (const rowNumber of rowNumbers) {
    const row = xml.match(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?row\\b[^>]*\\br="${rowNumber}"[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?row>`, 'u'))?.[1] || '';
    if (!row || (row.match(/<(?:[A-Za-z_][\w.-]*:)?c\b/gu) || []).length !== 22
      || (row.match(/<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*\bt="inlineStr"/gu) || []).length !== 22) {
      fail(`${sheetName} row ${rowNumber} does not contain 22 inlineStr cells.`);
    }
  }
}

function buildWorkbook(inputBytes) {
  const original = inspectWorkbook(inputBytes);
  assertBaseline(original, digest(inputBytes));
  const entries = new Map(original.entries);
  let fieldsXml = original.fieldSheet.xml;
  const dcnoStatus = `真实录制证据；${RECORDING_EVENTS} events；artifact=${ARTIFACT_ID}；recordingId=${RECORDING_ID}；Higher 网络目录精确身份与状态读回。`;
  const dcnoNote = `已由本次真实录制证据替换旧 fail-close 状态：${EVIDENCE_REF}；recordingId=${RECORDING_ID}；${RECORDING_EVENTS} events。`;
  for (const [index, id] of FIELD_IDS.entries()) {
    const row = fieldById(original.fields, id);
    if (!row) fail(`required existing field is missing: ${id}.`);
    const sourceRow = row.sourceRow;
    fieldsXml = replaceCell(fieldsXml, sourceRow, 12, 'api');
    fieldsXml = replaceCell(fieldsXml, sourceRow, 17, EVIDENCE_LOCATION);
    fieldsXml = replaceCell(fieldsXml, sourceRow, 18, dcnoStatus);
    fieldsXml = replaceCell(fieldsXml, sourceRow, 21, dcnoNote);
    // Keep stable source_trace_id values; they are field identity, not a
    // recording counter.  The recording artifact is carried by evidence and
    // notes above.
    void index;
  }
  fieldsXml = appendRows(updateSheetRanges(fieldsXml, 237), 227, NEW_FIELD_ROWS);
  let relationsXml = appendRows(updateSheetRanges(original.relationSheet.xml, 104), 97, NEW_RELATION_ROWS);
  entries.set('xl/worksheets/sheet2.xml', Buffer.from(fieldsXml, 'utf8'));
  entries.set('xl/worksheets/sheet3.xml', Buffer.from(relationsXml, 'utf8'));
  for (const [name, lastRow] of [['xl/tables/table1.xml', 237], ['xl/tables/table2.xml', 104]]) {
    const table = entries.get(name);
    if (!table) fail(`required table member is missing: ${name}.`);
    entries.set(name, Buffer.from(updateTableRange(table.toString('utf8'), lastRow), 'utf8'));
  }
  const outputBytes = worker.zip(Object.fromEntries(entries));
  const compiled = inspectWorkbook(outputBytes);
  if (!targetState(compiled)) fail(`generated workbook target state failed (fields=${compiled.fields.length}, relations=${compiled.relations.length}).`);
  assertNewCellsInline(compiled.entries, 'xl/worksheets/sheet2.xml', Array.from({ length: NEW_FIELD_ROWS.length }, (_value, index) => 227 + index));
  assertNewCellsInline(compiled.entries, 'xl/worksheets/sheet3.xml', Array.from({ length: NEW_RELATION_ROWS.length }, (_value, index) => 97 + index));
  const mutableMembers = new Set(['xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/tables/table1.xml', 'xl/tables/table2.xml']);
  for (const [name, bytes] of original.entries) {
    if (!mutableMembers.has(name) && !Buffer.from(bytes).equals(Buffer.from(compiled.entries.get(name) || Buffer.alloc(0)))) fail(`undeclared ZIP member changed: ${name}.`);
  }
  return { outputBytes, fields: compiled.fields, relations: compiled.relations, entries: compiled.entries };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input || process.env.DCNO_V8_INPUT || DEFAULT_WORKBOOK);
  const outputPath = path.resolve(args.output || process.env.DCNO_V8_OUTPUT || inputPath);
  if (!fs.existsSync(inputPath)) fail(`input workbook does not exist: ${inputPath}`);
  const inputBytes = fs.readFileSync(inputPath);
  const inputSha = digest(inputBytes);
  let current;
  try { current = inspectWorkbook(inputBytes); } catch (error) { fail(`cannot inspect input workbook: ${error.message}`); }
  if (targetState(current)) {
    console.log(JSON.stringify({ status: 'idempotent-no-write', input: inputPath, output: outputPath, sha256: inputSha, fields: current.fields.length, relations: current.relations.length, risks: 3, controls: 8, dcnoRelations: 8 }));
    return;
  }
  if (outputPath !== inputPath && fs.existsSync(outputPath)) {
    try {
      const existingBytes = fs.readFileSync(outputPath);
      const existing = inspectWorkbook(existingBytes);
      if (targetState(existing)) {
        console.log(JSON.stringify({ status: 'idempotent-no-write', input: inputPath, output: outputPath, sha256: digest(existingBytes), fields: existing.fields.length, relations: existing.relations.length, risks: 3, controls: 8, dcnoRelations: 8 }));
        return;
      }
    } catch {
      // A non-target output is handled by the normal baseline guard below.
    }
  }
  if (inputSha !== BASE_SHA256) fail(`input SHA mismatch: expected ${BASE_SHA256}, got ${inputSha}; neither baseline nor complete target state.`);
  const result = buildWorkbook(inputBytes);
  fs.writeFileSync(outputPath, result.outputBytes);
  const outputSha = digest(result.outputBytes);
  console.log(JSON.stringify({ status: 'written', input: inputPath, output: outputPath, inputSha256: inputSha, outputSha256: outputSha, fields: result.fields.length, relations: result.relations.length, risks: 3, controls: 8, dcnoRelations: 8, recordingId: RECORDING_ID, events: RECORDING_EVENTS, preservedZipMembers: [...current.entries.keys()].filter((name) => !['xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/tables/table1.xml', 'xl/tables/table2.xml'].includes(name)).length }));
}

try { main(); } catch (error) { console.error(error?.stack || String(error)); process.exitCode = 1; }
