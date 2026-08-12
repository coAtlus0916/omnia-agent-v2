#!/usr/bin/env node
'use strict';

/**
 * Bind the SAP S/4 HANA V8 governance rows to the complete, immutable
 * recording captured on 2026-08-07. Only the Risk-Control worksheet changes.
 * The policy-facing SAP.xx field identities remain stable; runtime catalog
 * identities live in risk-control-catalog-identities.json as exact SAPS4.xx
 * values.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const worker = require('../feature-packages/create-associate/source/middle/worker.cjs');

const BASE_SHA256 = '410374FF21D03E30A2533C9CFC686EB436BF3446EAE1CEB0AAFD92DB95D893A8';
const DEFAULT_WORKBOOK = path.resolve(import.meta.dirname,
  '../feature-packages/create-associate/source/managed/phase1-system-information-v8.xlsx');
const RECORDING_ID = '34ea8734-0d21-4ef2-88a5-6455ae94b8bd';
const OBSERVATION_ID = 'observation_3a5ae32dd9f425d95639407f559ac88a';
const STREAM_ID = 'stream_ae92c5640b6138ece0cb3a9419cde70f';
const STREAM_SHA256 = '65fff6c856998e303189a2a35bd59b51754402673887bd8c574015be17edb9d8';
const STREAM_BYTES = 9433532;
const EVENT_COUNT = 1587;
const EVIDENCE_REF = `recording:${RECORDING_ID}/${OBSERVATION_ID}/${STREAM_ID}#sha256=${STREAM_SHA256}`;

const DIRECT_CONTROLS = Object.freeze([
  ['RAITCOR001', 'SAP_01', 'SAPS4.01', 'ff217109-ddb2-49f2-47cc-08def477482a', '402D78FD-35C0-489D-ACF8-0274C7C13AE5', 'request_322', 934, 943, 'request_323', 939, 949],
  ['RAITCOR001', 'SAP_04', 'SAPS4.04', '3f35a8b8-4eaf-45f9-78a0-08def477489e', '88EC69A8-E46C-4C78-BA38-86F0CB88A057', 'request_331', 968, 980, 'request_332', 976, 985],
  ['RAITCOR001', 'SAP_07', 'SAPS4.07', '1f58adb3-d294-4ba6-11e5-08def47748e4', 'D944866F-A37D-4AD8-80AD-7FAE9A6B5872', 'request_339', 1007, 1013, 'request_340', 1009, 1017],
  ['RAITCOR001', 'SAP_11', 'SAPS4.11', '2f1420ef-33cf-4643-4c3c-08def4774901', '4341BEEB-AB4D-4FBF-9750-2F0238A31B2A', 'request_347', 1025, 1030, 'request_348', 1026, 1035],
  ['RAITCOR001', 'SAP_17', 'SAPS4.17', '92aac287-26ce-4123-9cf3-08def4774926', 'DAD933A3-B9CA-4B5E-B106-0D8FC323DE2A', 'request_355', 1050, 1051, 'request_356', 1052, 1059],
  ['RAITCOR001', 'SAP_06', 'SAPS4.06', '3b3afdec-0388-4f2a-9faa-08def47748c0', '6E4A0501-A1C4-4DC0-9CD4-D0ED2A83DCEF', 'request_363', 1068, 1077, 'request_364', 1073, 1082],
  ['RAITCOR001', 'SAP_02', 'SAPS4.02', '05b01b45-22c7-4758-0e75-08def477485f', 'FCB89DB0-D141-4BD1-BAA0-C6C13307CB23', 'request_371', 1090, 1101, 'request_372', 1097, 1105],
  ['RAITCOR001', 'SAP_18', 'SAPS4.18', 'd7ede4b7-703f-46b7-a109-08def4774956', '41165CBB-C266-4992-9FF2-4DB7561651B7', 'request_379', 1119, 1129, 'request_380', 1124, 1133],
  ['RAITCOR001', 'SAP_20', 'SAPS4.20', '52f72907-ce41-4105-448e-08def4774990', 'F8AAD26D-BEE2-4DFC-94DD-F1B3C97570DD', 'request_387', 1143, 1154, 'request_388', 1149, 1158],
  ['RAITCOR001', 'SAP_03', 'SAPS4.03', '13db40ce-af4e-46af-642a-08def4774885', '95DB7248-282C-4CE3-B258-696EC0D6DE64', 'request_395', 1166, 1176, 'request_396', 1172, 1181],
  ['RAITCOR001', 'SAP_19', 'SAPS4.19', '8d8a4b52-fad8-4833-65b1-08def4774973', 'F8C73A1B-0163-43FD-8273-A41BEB722995', 'request_403', 1193, 1200, 'request_404', 1196, 1204],
  ['RAITCOR001', 'SAP_28', 'SAPS4.28', 'e0b4b03b-e54a-43d2-983a-08def47749b1', 'BD992BD0-45D7-495E-BB82-0B4751A06387', 'request_411', 1218, 1223, 'request_412', 1219, 1227],
  ['RAITCOR003', 'SAP_05', 'SAPS4.05', '73c7e139-1ff4-463d-9af7-08def47749fe', 'FFF1F5A9-FE1A-43E3-970D-106AF1938134', 'request_423', 1262, 1270, 'request_424', 1265, 1275],
  ['RAITCOR003', 'SAP_09', 'SAPS4.09', '76101ffd-88bf-4daa-e9bf-08def4774a17', '1258AF31-AA56-46C4-A820-D7B03D46F184', 'request_431', 1284, 1286, 'request_432', 1285, 1296],
  ['RAITCOR004', 'SAP_10', 'SAPS4.10', 'e8cd9788-ed85-433d-62e3-08def4774a6e', '33293DE5-A994-4F1E-A429-C5E0ED479B75', 'request_443', 1325, 1330, 'request_444', 1326, 1334],
  ['RAITCOR004', 'SAP_26', 'SAPS4.26', 'f38cd23a-de29-4744-5105-08def4774b0b', '03832215-67F5-436C-85D8-C6BDD97A6F7A', 'request_451', 1347, 1352, 'request_452', 1348, 1356],
  ['RAITCOR004', 'SAP_25', 'SAPS4.25', 'ccccc280-d848-47ed-e47c-08def4774aea', 'ACC61AE8-00D4-48DA-8654-4D01FECDBB89', 'request_459', 1364, 1373, 'request_460', 1369, 1377],
  ['RAITCOR004', 'SAP_23', 'SAPS4.23', '5d544b85-c8ed-4980-4d2b-08def4774aa9', 'BE3EBFB4-19EE-437A-BFD7-98B9CDAA7B2E', 'request_467', 1386, 1391, 'request_468', 1387, 1395],
  ['RAITCOR004', 'SAP_13', 'SAPS4.13', '3e2634e6-b1b0-4cdf-f673-08def4774a89', '9DFAEA18-15D6-44E4-A298-B7EAA18B3D4C', 'request_475', 1408, 1417, 'request_476', 1413, 1421],
  ['RAITCOR004', 'SAP_24', 'SAPS4.24', '7899ecd5-5049-4116-571b-08def4774acd', '0FF398AA-D1FB-4E1A-9F39-A811D165ECC2', 'request_483', 1430, 1435, 'request_484', 1431, 1439],
  ['RAITCOR007', 'SAP_14', 'SAPS4.14', 'adb7352b-82c3-4e05-e41e-08def4774b87', '67156A5C-AA3E-4379-86A2-0A78B9DEE80A', 'request_495', 1466, 1472, 'request_496', 1468, 1477],
  ['RAITCOR011', 'SAP_15', 'SAPS4.15', '97f3f0a3-5c5c-4084-b6ac-08def4774ba7', 'F80D8BA2-2C45-41D2-A5CE-57FF8DF5CF5D', 'request_511', 1513, 1520, 'request_512', 1516, 1525],
  ['RAITCOR011', 'SAP_16', 'SAPS4.16', '50b97075-f5ba-4e46-14f4-08def4774bce', '6B668D60-20CB-4810-BD57-23C4765C1140', 'request_519', 1535, 1541, 'request_520', 1538, 1548],
  ['RAITCOR011', 'SAP_27', 'SAPS4.27', '700cfb08-40d1-454e-1277-08def4774bf3', 'DDB84A18-1C31-4169-8768-833F98C565F2', 'request_528', 1557, 1560, 'request_529', 1558, 1566]
]);

const GROUP_CONTROLS = Object.freeze([
  ['RAITCOR001', 'SAPCUA_06', 'SAPCUA.06', '30ff63da-1a5e-4f2c-7a44-08def47749d5', '92A4D762-667D-455A-9909-EA70BBCD47F0', 'request_264', 761, 778, 'request_325', 941, 944],
  ['RAITCOR003', 'SAPCHARM_01', 'SAPCHARM.01', '5b154535-3769-4347-110f-08def4774a35', 'B7E3B8A4-FDC4-4892-8C02-3DD3DCB64295', 'request_271', 779, 791, 'request_426', 1268, 1271],
  ['RAITCOR003', 'SAPCHARM_02', 'SAPCHARM.02', '5b1b44c8-43a0-4e62-a038-08def4774a52', '9757E112-2CCA-43EB-815F-9737A1621DFE', 'request_273', 782, 796, 'request_426', 1268, 1271],
  ['RAITCOR004', 'IMP_01', 'IMP.01', '13ba0e3e-0b57-4cb8-cc80-08def4774b25', '148B9D80-7061-429B-A53D-3FB194103B8E', 'request_285', 812, 826, 'request_446', 1328, 1331],
  ['RAITCOR004', 'IMP_02', 'IMP.02', '680d00b8-7cfd-4464-b8bd-08def4774b4a', '4804830B-FC10-4D1B-8648-3302D52E7ED8', 'request_286', 815, 833, 'request_446', 1328, 1331],
  ['RAITCOR004', 'IMP_03', 'IMP.03', 'd8b6fbc1-7ca0-42e0-0185-08def4774b6a', 'CFBB6CD5-8B72-4FBD-A6C1-1FF4322057BF', 'request_287', 817, 837, 'request_446', 1328, 1331]
]);
const ALL_CONTROLS = Object.freeze([
  ...DIRECT_CONTROLS.map((row) => [...row, 'direct-enabled-readback']),
  ...GROUP_CONTROLS.map((row) => [...row, 'group-final-risk-readback'])
]);
const exactControlKey = (row) => row[11] === 'direct-enabled-readback' ? row[1].replace(/^SAP_/u, 'SAPS4_') : row[1];
const EXPECTED = new Map(ALL_CONTROLS.map((row) => [`REL.APP.SAP_S4_HANA.${row[0]}.${exactControlKey(row)}`, row]));
const SOURCE_EXPECTED = new Map(ALL_CONTROLS.map((row) => [`REL.APP.SAP_S4_HANA.${row[0]}.${row[1]}`, row]));
const RELATION_HEADERS = Object.freeze([
  'relation_id', 'risk_field_id', 'Risk标准名', 'control_field_id', 'Control标准名', '关系类型/方向',
  'catalog_present_higher', 'catalog_present_lower', 'link_required_higher', 'link_required_lower',
  'classification_higher', 'classification_lower', '执行适用层级', '适用场景/对象类型', '是否必需',
  '无资料时策略', 'v4 evidence_type', 'v4 JSON/API/DOM/connector路径', '证据文件+行号', '确认状态',
  'source_trace_id', '备注'
]);
const FIELD_HEADERS = Object.freeze([
  'field_id', 'Phase', '场景/对象类型', '对象子类型/区段', 'Higher适用', 'Lower适用',
  'Omnia UI标准字段名', '字段用途', '填写责任/方式', '必填规则', '无资料时默认/回退', '允许值',
  'evidence_type', 'v4 JSON key/path', 'v4 endpoint+method / connector', '请求/响应位置', 'v4 DOM/selector',
  'v4证据路径+行号', '证据状态/置信度', '校验规则', 'source_trace_id', '备注'
]);
const CROSS_CONTROL_LABELS = Object.freeze({
  SAPCUA_06: 'SAPCUA.06｜SAP CUA - 特权 / 管理员访问权限',
  SAPCHARM_01: 'SAPCHARM.01｜工作流程路径',
  SAPCHARM_02: 'SAPCHARM.02｜Charm 工作流程 职责分离 (SOD)',
  IMP_01: 'IMP.01｜测试系统实施或变更',
  IMP_02: 'IMP.02｜上线批准',
  IMP_03: 'IMP.03｜系统生成报告的测试和批准'
});
const CONTROL_NAMES = Object.freeze({
  SAPS4_01: '用户授权', SAPS4_02: '终止', SAPS4_03: '用户访问权限复核', SAPS4_04: '职责分离',
  SAPS4_05: '身份验证', SAPS4_06: '安全管理访问', SAPS4_07: '表维护访问权限', SAPS4_09: '超级用户默认密码',
  SAPS4_10: '变更管理', SAPS4_11: '更改密码参数的访问权限', SAPS4_13: '实施变更发布生产环境的访问权限',
  SAPS4_14: '数据转换', SAPS4_15: '批处理任务管理访问权限', SAPS4_16: '任务监控', SAPS4_17: '程序执行访问',
  SAPS4_18: 'SAP_ALL / SAP_NEW 安全', SAPS4_19: 'SAP 支持 ID', SAPS4_20: '超级用户安全和监控',
  SAPS4_23: '生产客户端和系统设置', SAPS4_24: '客户端维护和系统更改选项访问权限',
  SAPS4_25: '开发访问权限', SAPS4_26: 'DEBUG访问权限', SAPS4_27: 'IDOC 管理访问权限 /IDOC 监控',
  SAPS4_28: '特权级别通用账号', SAPCUA_06: 'SAP CUA - 特权 / 管理员访问权限',
  SAPCHARM_01: '工作流程路径', SAPCHARM_02: 'Charm 工作流程 职责分离 (SOD)',
  IMP_01: '测试系统实施或变更', IMP_02: '上线批准', IMP_03: '系统生成报告的测试和批准'
});
const RISK_NAMES = Object.freeze({
  RAITCOR001: 'RAITCOR001｜SAP S/4 HANA - 用户拥有的访问权限超出了执行分配的职责所必需的权限，这可能导致职责分离不当。',
  RAITCOR003: 'RAITCOR003｜SAP S/4 HANA - 系统配置或更新不足，无法限制正确授权和适当的用户访问系统。',
  RAITCOR004: 'RAITCOR004｜SAP S/4 HANA - 对包含相关自动控制 (即可配置设置，自动算法，自动计算和自动数据提取) 和 / 或报告逻辑的应用系统或程序进行了不适当的变更。',
  RAITCOR007: 'RAITCOR007｜SAP S/4 HANA - 在从旧系统或以前版本的系统转换数据时，由于转换传输的数据不完整、冗余、过时或不准确导致传输数据错误。',
  RAITCOR011: 'RAITCOR011｜SAP S/4 HANA - 生产系统，程序和 / 或系统任务会导致数据处理不准确，不完整或对数据未经授权的处理。'
});
const RISK_EVIDENCE = Object.freeze({
  RAITCOR001: ['request_230', 684, 686, 'request_414', 1221, 1224, 13],
  RAITCOR003: ['request_231', 685, 689, 'request_434', 1288, 1292, 4],
  RAITCOR004: ['request_233', 688, 693, 'request_486', 1433, 1436, 9],
  RAITCOR007: ['request_234', 690, 692, 'request_498', 1470, 1473, 1],
  RAITCOR011: ['request_235', 691, 697, 'request_531', 1561, 1563, 3]
});

function fail(message) { throw new Error(`[augment-s4-hana-v8] ${message}`); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
function xmlUnescape(value) {
  return String(value ?? '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)));
}
function xmlEscape(value) {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}
function columnIndex(reference) {
  let value = 0;
  for (const letter of String(reference).match(/^[A-Z]+/u)?.[0] || '') value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}
function columnName(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}
function sharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/gu)].map((match) =>
    xmlUnescape([...match[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gu)].map((part) => part[1]).join('')));
}
function parseRows(xml, strings) {
  const rows = new Map();
  for (const rowMatch of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/gu)) {
    const rowNumber = Number(rowMatch[1].match(/\br="(\d+)"/u)?.[1] || 0);
    if (!rowNumber) continue;
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/gu)) {
      const reference = cellMatch[1].match(/\br="([A-Z]+\d+)"/u)?.[1] || '';
      if (!reference) continue;
      const type = cellMatch[1].match(/\bt="([^"]+)"/u)?.[1] || '';
      const body = cellMatch[2] || '';
      const raw = body.match(/<(?:[A-Za-z_][\w.-]*:)?v>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/u)?.[1];
      const inline = body.match(/<(?:[A-Za-z_][\w.-]*:)?is>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/u)?.[1];
      let value = raw === undefined ? '' : xmlUnescape(raw);
      if (type === 's' && raw !== undefined) value = strings[Number(raw)] || '';
      if (type === 'inlineStr' && inline !== undefined) value = xmlUnescape([...inline.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gu)].map((part) => part[1]).join(''));
      cells[columnIndex(reference)] = value;
    }
    rows.set(rowNumber, cells);
  }
  return rows;
}
function tableRows(rows, headers) {
  return [...rows.entries()].filter(([rowNumber, values]) => rowNumber > 4 && values.some((value) => value !== undefined && value !== ''))
    .map(([sourceRow, values]) => ({ sourceRow, values: Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])) }));
}
function inspect(bytes) {
  const entries = worker.zipEntries(Buffer.from(bytes));
  const strings = sharedStrings(entries);
  const fieldXml = entries.get('xl/worksheets/sheet2.xml')?.toString('utf8') || '';
  const relationXml = entries.get('xl/worksheets/sheet3.xml')?.toString('utf8') || '';
  const fieldRows = parseRows(fieldXml, strings);
  const relationRows = parseRows(relationXml, strings);
  if (FIELD_HEADERS.some((header, index) => fieldRows.get(4)?.[index] !== header)) fail('Field worksheet header drifted.');
  if (RELATION_HEADERS.some((header, index) => relationRows.get(4)?.[index] !== header)) fail('Risk-Control worksheet header drifted.');
  return { entries, fieldXml, relationXml, fields: tableRows(fieldRows, FIELD_HEADERS), relations: tableRows(relationRows, RELATION_HEADERS) };
}
function replaceCell(xml, rowNumber, column, value) {
  let rowFound = false;
  const next = xml.replace(/<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/gu,
    (rowText, attrs, body) => {
      if (Number(attrs.match(/\br="(\d+)"/u)?.[1] || 0) !== rowNumber) return rowText;
      rowFound = true;
      const reference = `${columnName(column)}${rowNumber}`;
      let cellFound = false;
      const nextBody = body.replace(/<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/gu,
        (cellText, cellAttrs) => {
          if (cellAttrs.match(/\br="([A-Z]+\d+)"/u)?.[1] !== reference) return cellText;
          cellFound = true;
          const attrsWithoutType = cellAttrs.replace(/\s+t="[^"]*"/u, '');
          return `<x:c${attrsWithoutType} t="inlineStr"><x:is><x:t xml:space="preserve">${xmlEscape(value)}</x:t></x:is></x:c>`;
        });
      if (!cellFound) fail(`cell ${reference} is missing.`);
      return `<x:row${attrs}>${nextBody}</x:row>`;
    });
  if (!rowFound) fail(`row ${rowNumber} is missing.`);
  return next;
}
function inlineCell(reference, value) {
  return `<x:c r="${reference}" t="inlineStr"><x:is><x:t xml:space="preserve">${xmlEscape(value)}</x:t></x:is></x:c>`;
}
function rowXml(rowNumber, values) {
  return `<x:row r="${rowNumber}">${values.map((value, column) => inlineCell(`${columnName(column)}${rowNumber}`, value)).join('')}</x:row>`;
}
function appendRows(xml, startRow, rows) {
  const generated = rows.map((values, index) => rowXml(startRow + index, values)).join('');
  if (!/<\/(?:[A-Za-z_][\w.-]*:)?sheetData>/u.test(xml)) fail('worksheet sheetData close tag is missing.');
  return xml.replace(/<\/(?:[A-Za-z_][\w.-]*:)?sheetData>/u, `${generated}$&`);
}
function updateSheetRanges(xml, lastRow) {
  const replaceRef = (text, tag) => text.replace(new RegExp(`(<(?:[A-Za-z_][\\w.-]*:)?${tag}\\b[^>]*\\bref=")([^"]+)(")`, 'gu'),
    (_match, prefix, ref, suffix) => {
      const start = String(ref).split(':')[0] || 'A1';
      const endColumn = String(ref).split(':')[1]?.match(/^[A-Z]+/u)?.[0] || 'V';
      return `${prefix}${start}:${endColumn}${lastRow}${suffix}`;
    });
  return replaceRef(replaceRef(xml, 'dimension'), 'autoFilter');
}
function updateTableRange(xml, lastRow) {
  return xml.replace(/(\bref=")([A-Z]+)(\d+):([A-Z]+)\d+(")/gu,
    (_match, prefix, startColumn, startRow, endColumn, suffix) => `${prefix}${startColumn}${startRow}:${endColumn}${lastRow}${suffix}`);
}
function evidence(row) {
  const [risk, controlKey, number, controlId, inkContentId, associateRequest, associateSeq, associateResponseSeq,
    readRequest, readSeq, readResponseSeq, evidenceKind] = row;
  const prefix = `${EVIDENCE_REF}; bytes=${STREAM_BYTES}; events=${EVENT_COUNT}; ${risk}/${number}; `
    + `controlId=${controlId}; inkContentId=${inkContentId}; `;
  if (evidenceKind === 'direct-enabled-readback') {
    return prefix + `associate=${associateRequest}/seq${associateSeq}->200/seq${associateResponseSeq}; `
      + `controlReadback=${readRequest}/seq${readSeq}->200/seq${readResponseSeq}; state=Applicable; enabled=true`;
  }
  return prefix + `candidate=${associateRequest}/seq${associateSeq}->200/seq${associateResponseSeq}; `
    + `finalRiskReadback=${readRequest}/seq${readSeq}->200/seq${readResponseSeq}; risk.controlIds contains controlId`;
}
function targetState(info) {
  const rows = info.relations.filter((row) => String(row.values.relation_id).startsWith('REL.APP.SAP_S4_HANA.'));
  if (info.fields.length !== 239 || info.relations.length !== 106 || rows.length !== 30
    || rows.some((row) => !EXPECTED.has(row.values.relation_id))) return false;
  return rows.every((row) => row.values.link_required_higher === 'Y'
    && row.values.catalog_present_lower === 'N' && row.values.link_required_lower === 'N'
    && row.values['确认状态'].includes('30/30')
    && row.values['证据文件+行号'].includes(EVIDENCE_REF)
    && row.values['备注'].includes('Lower 未录制'));
}
function relationId(row) { return `REL.APP.SAP_S4_HANA.${row[0]}.${exactControlKey(row)}`; }
function controlFieldId(row) { return `P1.CONTROL.APP.SAP_S4_HANA.${exactControlKey(row)}`; }
function controlLabel(row) { return `${row[2]}｜${CONTROL_NAMES[exactControlKey(row)]}`; }
function sourceTrace(row) { return `S4HANA.RECORDING.34ea8734.CONTROL.${row[3].slice(0, 8)}`; }
function controlFieldRow(row) {
  return [
    controlFieldId(row), 'Phase 1', 'Control', 'Application / SAP S/4 HANA', 'Y', 'N', controlLabel(row),
    'Omnia 真实 SAP S/4 HANA Higher Control 目录项', 'Omnia自动', '按真实最终 Risk 关系',
    '精确目录身份或最终关系读回缺失则停止并报错', '', 'frozen-stream+exact-live-catalog+final-risk-readback',
    'controls[].id/controlNumber/name/inkContentId/controlRiskScopes[]；risks[].controlIds/controls[]',
    'GET controls/{controlId}；GET risks/{riskId}；POST validateHiddenDataForRiskAssociation；POST controls/controlrisks/associate',
    row[11] === 'direct-enabled-readback' ? 'Control state=Applicable/enabled=true；最终 Risk controlIds 包含 controlId' : '候选 Control 精确身份；最终 Risk controlIds 包含 controlId',
    '', evidence(row), '真实 SAP S/4 HANA Higher 30/30 最终关系证据；Lower 未录制',
    'catalogControlNumber、Risk number、controlId 必须唯一精确匹配；禁止按序号、翻译或描述猜测',
    sourceTrace(row), 'Higher 来自完整冻结流；Lower 未录制，N 是执行阻断边界，不证明 Lower 目录不存在。'
  ];
}
function relationRow(row) {
  return [
    relationId(row), `P1.RISK.APP.SAP_S4_HANA.${row[0]}`, RISK_NAMES[row[0]], controlFieldId(row), controlLabel(row),
    'Risk -> Control', 'Y', 'N', 'Y', 'N', 'Higher', '待确认', 'Higher', 'Application / SAP S/4 HANA',
    '条件必需（Higher）', '阻断：不创建、不降级、不猜测', 'frozen-stream+exact-live-catalog+final-risk-readback',
    'GET risks/{riskId}；GET controls/{controlId}；POST validateHiddenDataForRiskAssociation；POST controls/controlrisks/associate',
    evidence(row), '真实 SAP S/4 HANA Higher 30/30 最终关系证据；Lower 未声称 live canary', sourceTrace(row),
    `Higher 精确关系 ${row[0]} -> ${row[2]}，controlId=${row[3]}；Lower 未录制，N 是执行阻断边界。`
  ];
}
function updateRiskField(xml, field) {
  const code = String(field.values.field_id).split('.').at(-1);
  const observed = RISK_EVIDENCE[code];
  if (!observed) return xml;
  const [directoryRequest, directorySeq, directoryResponseSeq, finalRequest, finalSeq, finalResponseSeq, controlCount] = observed;
  const location = `${EVIDENCE_REF}; bytes=${STREAM_BYTES}; events=${EVENT_COUNT}; `
    + `directory=${directoryRequest}/seq${directorySeq}->200/seq${directoryResponseSeq}; `
    + `final=${finalRequest}/seq${finalSeq}->200/seq${finalResponseSeq}; controlIds=${controlCount}`;
  let next = replaceCell(xml, field.sourceRow, 4, 'Y');
  next = replaceCell(next, field.sourceRow, 5, 'N');
  next = replaceCell(next, field.sourceRow, 6, RISK_NAMES[code]);
  next = replaceCell(next, field.sourceRow, 12, 'frozen-stream+exact-live-risk+final-risk-readback');
  next = replaceCell(next, field.sourceRow, 13, 'risks[].id/inkContentId/inkRiskNumber/riskNumber/description/classificationType/riskRiskScopes/controlIds/controls');
  next = replaceCell(next, field.sourceRow, 14, 'GET risks/{riskId}；GET risks/byriskassessmentid；GET plannedresponse/GetPlanResponseDetailByRiskRiskScopeId');
  next = replaceCell(next, field.sourceRow, 15, 'Higher riskNumber/classification/riskScopeId 与最终 controlIds 权威读回');
  next = replaceCell(next, field.sourceRow, 17, location);
  next = replaceCell(next, field.sourceRow, 18, `真实 SAP S/4 HANA Higher Risk 与最终 ${controlCount} 条 Control 关系；Lower 未录制`);
  next = replaceCell(next, field.sourceRow, 19, 'Higher=Higher 且 riskNumber/ID/scope 唯一精确；Lower 无证据时阻断');
  next = replaceCell(next, field.sourceRow, 21, `${EVIDENCE_REF}；Lower 未录制，不推断 Lower Risk 或目录。`);
  return next;
}
function build(inputBytes) {
  const original = inspect(inputBytes);
  if (original.fields.length !== 233 || original.relations.length !== 100) {
    fail(`governance count drifted: fields=${original.fields.length}, relations=${original.relations.length}.`);
  }
  const s4 = original.relations.filter((row) => String(row.values.relation_id).startsWith('REL.APP.SAP_S4_HANA.'));
  if (s4.length !== 24 || s4.some((row) => !SOURCE_EXPECTED.has(row.values.relation_id))) fail('S/4 source relation inventory drifted.');
  let fieldXml = original.fieldXml;
  const riskFields = original.fields.filter((row) => String(row.values.field_id).startsWith('P1.RISK.APP.SAP_S4_HANA.'));
  if (riskFields.length !== 5) fail(`S/4 source Risk field inventory drifted: ${riskFields.length}.`);
  for (const field of riskFields) fieldXml = updateRiskField(fieldXml, field);
  for (const observed of ALL_CONTROLS.filter((row) => row[11] === 'direct-enabled-readback')) {
    const sourceId = `P1.CONTROL.APP.SAP_S4_HANA.${observed[1]}`;
    const field = original.fields.find((item) => item.values.field_id === sourceId);
    if (!field) fail(`S/4 source Control field is missing: ${sourceId}.`);
    const values = controlFieldRow(observed);
    for (let column = 0; column < values.length; column += 1) fieldXml = replaceCell(fieldXml, field.sourceRow, column, values[column]);
  }
  fieldXml = appendRows(updateSheetRanges(fieldXml, 243), 238, GROUP_CONTROLS.map((row) => controlFieldRow([...row, 'group-final-risk-readback'])));

  let relationXml = original.relationXml;
  for (const relation of s4) {
    const observed = SOURCE_EXPECTED.get(relation.values.relation_id);
    const values = relationRow(observed);
    for (let column = 0; column < values.length; column += 1) relationXml = replaceCell(relationXml, relation.sourceRow, column, values[column]);
  }
  relationXml = appendRows(updateSheetRanges(relationXml, 110), 105, GROUP_CONTROLS.map((row) => relationRow([...row, 'group-final-risk-readback'])));
  const entries = new Map(original.entries);
  entries.set('xl/worksheets/sheet2.xml', Buffer.from(fieldXml, 'utf8'));
  entries.set('xl/worksheets/sheet3.xml', Buffer.from(relationXml, 'utf8'));
  for (const [member, lastRow] of [['xl/tables/table1.xml', 243], ['xl/tables/table2.xml', 110]]) {
    const table = entries.get(member);
    if (!table) fail(`required table member is missing: ${member}.`);
    entries.set(member, Buffer.from(updateTableRange(table.toString('utf8'), lastRow), 'utf8'));
  }
  const outputBytes = worker.zip(Object.fromEntries(entries));
  const compiled = inspect(outputBytes);
  if (!targetState(compiled)) fail('generated workbook target state failed.');
  const mutable = new Set(['xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/tables/table1.xml', 'xl/tables/table2.xml']);
  for (const [name, bytes] of original.entries) {
    if (!mutable.has(name) && !Buffer.from(bytes).equals(Buffer.from(compiled.entries.get(name) || Buffer.alloc(0)))) {
      fail(`undeclared ZIP member changed: ${name}.`);
    }
  }
  return outputBytes;
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--input', '--output'].includes(key) || !value) fail(`invalid arguments near ${key || '(end)'}.`);
    result[key.slice(2)] = value;
  }
  return result;
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input || process.env.S4_HANA_V8_INPUT || DEFAULT_WORKBOOK);
  const outputPath = path.resolve(args.output || process.env.S4_HANA_V8_OUTPUT || inputPath);
  const inputBytes = fs.readFileSync(inputPath);
  const current = inspect(inputBytes);
  if (targetState(current)) {
    console.log(JSON.stringify({status: 'idempotent-no-write', sha256: digest(inputBytes), fields: current.fields.length,
      relations: current.relations.length, s4HigherRequired: 30, s4LowerRequired: 0, recordingId: RECORDING_ID, events: EVENT_COUNT}));
    return;
  }
  const inputSha = digest(inputBytes);
  if (inputSha !== BASE_SHA256) fail(`input SHA mismatch: expected ${BASE_SHA256}, got ${inputSha}.`);
  const outputBytes = build(inputBytes);
  fs.writeFileSync(outputPath, outputBytes);
  console.log(JSON.stringify({status: 'written', inputSha256: inputSha, outputSha256: digest(outputBytes),
    fields: 239, relations: 106, s4HigherRequired: 30, s4LowerRequired: 0, recordingId: RECORDING_ID, observationId: OBSERVATION_ID,
    streamId: STREAM_ID, streamSha256: STREAM_SHA256, bytes: STREAM_BYTES, events: EVENT_COUNT}));
}

try { main(); } catch (error) { console.error(error?.stack || String(error)); process.exitCode = 1; }
