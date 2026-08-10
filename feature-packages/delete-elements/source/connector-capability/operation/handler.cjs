'use strict';

const CUSTOM_WORKSPACE = 'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0';
const CUSTOM_WORKSPACE_GROUP = '5420131f-8ea2-4c3f-938f-a25745240cd0';
const RELATION_CONTRACTS = Object.freeze({
  InfrastructureApplication: Object.freeze({ sourceTypes: ['DB', 'OS', 'DCNO'], targetType: 'APP', sourceTab: 602 }),
  ItToolApplication: Object.freeze({ sourceTypes: ['TOOL'], targetType: 'APP', sourceTab: 802 })
});

function rows(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['items', 'data', 'results']) if (Array.isArray(value && value[key])) return value[key];
  return [];
}
function text(value) { return String(value == null ? '' : value).trim(); }
function id(value) { return text(value).toLowerCase(); }
function fail(message) { throw new Error(message); }
function omniaGuid(value) {
  const result = id(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(result)
    && result !== '00000000-0000-0000-0000-000000000000' ? result : '';
}
function deleted(value) {
  return Boolean(value && (value.isDeleted === true || value.deleted === true || value.isInRecycleBin === true
    || ['deleted', 'softdeleted', 'recycled', 'recyclebin', 'trashed', 'removed'].includes(text(value.status || value.state).toLowerCase())));
}
function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') fail('Snapshot contains a non-JSON value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function utf8Bytes(value) {
  const bytes = [];
  for (const symbol of String(value)) {
    const code = symbol.codePointAt(0);
    if (code <= 0x7f) bytes.push(code);
    else if (code <= 0x7ff) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
    else if (code <= 0xffff) bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 0x3f), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}
function rotateRight(value, shift) { return (value >>> shift) | (value << (32 - shift)); }
function sha256(value) {
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (const word of [high, low]) bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const schedule = new Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + (index * 4);
      schedule[index] = ((bytes[cursor] << 24) | (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = schedule[index - 15]; const right = schedule[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ ((~e) & g);
      const temp1 = (h + sum1 + choice + constants[index] + schedule[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}
function digest(value) { return sha256(canonical(value)); }
function workspaceIds(mapping) {
  return [...new Set(rows(mapping).map((item) => id(item && (item.facetId || item.workspaceFacetId || item.workspaceId || item.id))).filter(Boolean))].sort();
}
function detailWorkspaceIds(value, indexed) {
  return [...new Set([
    id(value && (value.workspaceId || value.workspaceFacetId || value.facetId)),
    ...rows(value && value.workspaceFacets).map((item) => id(item && (item.id || item.workspaceId || item.facetId))),
    id(indexed && (indexed.workspaceId || indexed.workspaceFacetId || indexed.facetId))
  ].filter(Boolean))].sort();
}
function exactObservedWorkspace(value) {
  const raw = [
    value && (value.workspaceId || value.workspaceFacetId || value.facetId),
    ...rows(value && value.workspaceFacets).map((item) => item && (item.id || item.workspaceId || item.facetId))
  ].map(text).filter(Boolean);
  if (!raw.length) return '';
  const normalized = raw.map(omniaGuid);
  if (normalized.some((candidate) => !candidate)) return '';
  const unique = [...new Set(normalized)];
  return unique.length === 1 ? unique[0] : '';
}
function outsideRequestedWorkspace(detail, requestedWorkspaceIds) {
  if (!(requestedWorkspaceIds instanceof Set) || !requestedWorkspaceIds.size) return false;
  const observed = exactObservedWorkspace(detail);
  return Boolean(observed) && !requestedWorkspaceIds.has(observed);
}
function authorityDirectory(payload, engagementId) {
  const directory = rows(payload).find((item) => id(item && item.engagementId) === id(engagementId));
  const facets = rows(directory && directory.facets);
  if (facets.some((item) => id(item && item.engagementId) !== id(engagementId))) fail('Omnia authority directory crossed the current Engagement.');
  const sections = facets.filter((item) => id(item && item.facetTypeId) === CUSTOM_WORKSPACE_GROUP && !deleted(item))
    .map((item) => ({ id: id(item.id), name: text(item.name || item.value) })).filter((item) => item.id && item.name);
  const sectionIds = new Set(sections.map((item) => item.id));
  const workspaces = facets.filter((item) => id(item && item.facetTypeId) === CUSTOM_WORKSPACE && !deleted(item))
    .map((item) => ({ id: id(item.id), name: text(item.name || item.value), parentSectionId: sectionIds.has(id(item.parentId)) ? id(item.parentId) : '' }))
    .filter((item) => item.id && item.name);
  if (new Set(sections.map((item) => item.id)).size !== sections.length
    || new Set(workspaces.map((item) => item.id)).size !== workspaces.length) {
    fail('Omnia authority directory returned a duplicate Section or Workspace identity.');
  }
  if (!workspaces.length) fail('Omnia authority directory did not return a verifiable CustomWorkspace.');
  return { sections, workspaces };
}
function blockingRows(value, ownerId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ type: 'unknown-contract', id: '', workItemId: '' }];
  const required = ['blockingEntities', 'convertingEntities', 'blockingControlEntities', 'accountContents'];
  if (!required.every((key) => Array.isArray(value[key])) || value.showDeleteAccountProcedureMappingPrompt !== false) {
    return [{ type: 'unknown-contract', id: '', workItemId: '' }];
  }
  const owners = rows(value.blockingEntities);
  if (owners.length > 1 || (owners.length === 1 && id(owners[0] && (owners[0].entityId || owners[0].id)) !== id(ownerId))) {
    return [{ type: 'unknown-contract', id: '', workItemId: '' }];
  }
  const related = owners.length ? rows(owners[0] && owners[0].relatedEntities) : [];
  const normalized = [...related, ...rows(value.convertingEntities), ...rows(value.blockingControlEntities), ...rows(value.accountContents)]
    .map((item) => ({
      type: text(item && (item.relatedEntityType || item.entityType || item.type || 'relationship')),
      id: id(item && (item.relatedEntityId || item.entityId || item.id)),
      workItemId: id(item && item.workItemId),
      location: text(item && item.navigationData && item.navigationData.location)
    }));
  const identities = normalized.map((item) => `${item.type.toLowerCase()}|${item.id}|${item.workItemId}`);
  return normalized.some((item) => !item.id || !item.workItemId) || new Set(identities).size !== identities.length
    ? [{ type: 'unknown-contract', id: '', workItemId: '' }] : normalized;
}
async function mapLimit(values, concurrency, mapper) {
  if (!Array.isArray(values) || values.length > 2000) fail('Authoritative catalog exceeds the signed 2000 item bound.');
  const result = new Array(values.length); let cursor = 0;
  async function consume() { while (cursor < values.length) { const index = cursor++; result[index] = await mapper(values[index], index); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => consume()));
  return result;
}
async function searchAll(sdk, stepId, sortField, extra = {}) {
  const found = []; let expected = null; let observed = 0;
  for (let page = 1; page <= 20; page += 1) {
    const body = { page, pageSize: 500, filters: [], sortFields: [{ field: sortField, direction: 'asc' }], ...extra };
    const payload = await sdk.invokeStep(stepId, {}, body); const current = rows(payload && payload.results);
    observed += current.length; found.push(...current.filter((item) => !deleted(item)));
    const total = Number(payload && payload.totalResults);
    if (!Number.isInteger(total) || total < 0 || total > 2000) fail('Authoritative IT Element search returned an invalid or unsafe total.');
    if (expected === null) expected = total; else if (expected !== total) fail('Authoritative IT Element search total drifted.');
    if (observed > total) fail('Authoritative IT Element search exceeded its total.');
    if (observed === total) return found;
    if (!current.length) fail('Authoritative IT Element search ended before its total.');
  }
  fail('Authoritative IT Element search exceeded the signed page bound.');
}
const OBJECT_RAW_TYPE_FIELDS = Object.freeze(['itElementType', 'elementType', 'entityType', 'type']);
const OBJECT_SUBTYPE_FIELDS = Object.freeze([
  'typeId', 'itElementTypeId', 'subtype', 'infrastructureType', 'databaseType', 'category'
]);
const OBJECT_TYPE_FIELDS = Object.freeze([...OBJECT_RAW_TYPE_FIELDS, ...OBJECT_SUBTYPE_FIELDS]);
function normalizedTypeValue(value) {
  return text(value).toLowerCase().replace(/[\s_-]+/gu, ' ').trim();
}
function compactTypeValue(value) { return normalizedTypeValue(value).replace(/\s+/gu, ''); }
function typeEvidence(detail, indexed) {
  const evidence = [];
  for (const source of [detail, indexed]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const field of OBJECT_TYPE_FIELDS) {
      const value = normalizedTypeValue(source[field]);
      if (value) evidence.push({ field, value, compact: compactTypeValue(value) });
    }
  }
  return evidence;
}
function semanticObjectKind(value) {
  if (value === 'application') return 'APP';
  if (value === 'ittool' || value === 'tool') return 'TOOL';
  if (value === 'database' || value === 'db' || value === 'db2' || value === 'oracle' || value === 'hana' || value === 'sql') return 'DB';
  if (value === 'operatingsystem') return 'OS';
  if (value === 'network') return 'DCNO';
  return '';
}
function objectTypeClassification(detail, indexed) {
  const evidence = typeEvidence(detail, indexed);
  const kinds = new Set(evidence.map((item) => semanticObjectKind(item.compact)).filter(Boolean));
  const hasInfrastructure = evidence.some((item) => item.compact === 'infrastructure');
  const kind = kinds.size === 1 ? [...kinds][0] : '';
  const conflict = kinds.size > 1 || (hasInfrastructure && (kind === 'APP' || kind === 'TOOL'));
  const hasExactRawKind = !['APP', 'TOOL'].includes(kind) || evidence.some((item) =>
    OBJECT_RAW_TYPE_FIELDS.includes(item.field) && semanticObjectKind(item.compact) === kind);
  return { kind: conflict || !hasExactRawKind ? '' : kind, conflict, hasInfrastructure, evidence };
}
function objectKind(detail, indexed) { return objectTypeClassification(detail, indexed).kind; }
function explicitlyUnsupportedInfrastructure(detail, indexed) {
  const classification = objectTypeClassification(detail, indexed);
  if (classification.conflict || classification.kind || !classification.hasInfrastructure) return false;
  return classification.evidence.some((item) => OBJECT_SUBTYPE_FIELDS.includes(item.field));
}
function relationshipConcurrency(detail, tab) {
  const candidates = rows(detail && detail.concurrencyTabs)
    .filter((item) => Number(item && item.entityTabTypeId) === tab && text(item.updatedOn))
    .map((item) => ({ entityTabTypeId: tab, updatedOn: text(item.updatedOn), stamp: Date.parse(item.updatedOn) }))
    .filter((item) => Number.isFinite(item.stamp)).sort((left, right) => right.stamp - left.stamp);
  return candidates[0] ? { entityTabTypeId: tab, updatedOn: candidates[0].updatedOn } : null;
}
async function readInformation(sdk, information, requestedWorkspaceIds = null) {
  const informationId = id(information && (information.informationId || information.objectId || information.id));
  if (!informationId) fail('Information target has no canonical ID.');
  const detail = await sdk.invokeStep('information-detail', { informationId });
  const workItemId = id(detail && detail.workItemId || information && information.workItemId);
  if (id(detail && (detail.id || detail.informationId)) !== informationId || !workItemId || deleted(detail)) fail('Information detail identity is missing, changed, or deleted.');
  if (outsideRequestedWorkspace(detail, requestedWorkspaceIds)) return null;
  const [workItem, mapping, blocking] = await Promise.all([
    sdk.invokeStep('work-item', { workItemId }), sdk.invokeStep('facet-mapping', { workItemId }), sdk.invokeStep('blocking-relationships', { informationId })
  ]);
  return { objectId: informationId, informationId, workItemId, objectType: 'Information',
    number: text(detail.number || detail.referenceNumber || workItem && workItem.referenceNumber),
    name: text(detail.name || information.name || workItem && workItem.name),
    updatedAt: text(detail.updatedAt || detail.updatedOn || detail.lastModifiedOn || information.updatedAt),
    workspaceIds: workspaceIds(mapping), blockers: blockingRows(blocking, informationId), relations: [], deleted: false };
}
function mergeRiskAssessmentIndex(workItems, commonAccounts) {
  const workItemRows = rows(workItems); const commonAccountRows = rows(commonAccounts);
  const deletedIds = new Set([
    ...workItemRows.filter(deleted).map((item) => id(item && (item.externalId || item.riskAssessmentId))),
    ...commonAccountRows.filter(deleted).map((item) => id(item && (item.id || item.riskAssessmentId)))
  ].filter(Boolean));
  const byId = new Map();
  for (const item of workItemRows) {
    const riskAssessmentId = id(item && (item.externalId || item.riskAssessmentId));
    if (!riskAssessmentId || deletedIds.has(riskAssessmentId) || deleted(item)) continue;
    byId.set(riskAssessmentId, {
      riskAssessmentId, workItemId: id(item.id || item.workItemId), referenceNumber: text(item.referenceNumber),
      names: [...new Set([item.name, item.displayName].map(text).filter(Boolean))],
      riskAssessmentType: text(item.riskAssessmentType || item.type), workspaceId: id(item.workspaceId), status: text(item.status),
      updatedAt: text(item.updatedOn || item.updatedAt)
    });
  }
  for (const item of commonAccountRows) {
    const riskAssessmentId = id(item && (item.id || item.riskAssessmentId));
    if (!riskAssessmentId || deletedIds.has(riskAssessmentId) || deleted(item)) continue;
    const current = byId.get(riskAssessmentId) || { riskAssessmentId, workItemId: '', referenceNumber: '', names: [],
      riskAssessmentType: '', workspaceId: '', status: '', updatedAt: '' };
    current.workItemId ||= id(item.workItemId); current.referenceNumber ||= text(item.referenceNumber || item.riskAssessmentReferenceNumber);
    current.names = [...new Set([...current.names, item.name, item.displayName].map(text).filter(Boolean))];
    current.riskAssessmentType ||= text(item.riskAssessmentType || item.type); current.workspaceId ||= id(item.workspaceId);
    current.status ||= text(item.status); current.updatedAt ||= text(item.updatedOn || item.updatedAt);
    byId.set(riskAssessmentId, current);
  }
  return [...byId.values()].sort((left, right) => left.riskAssessmentId.localeCompare(right.riskAssessmentId));
}
async function readGra(sdk, indexed, requestedWorkspaceIds = null) {
  const riskAssessmentId = omniaGuid(indexed && indexed.riskAssessmentId);
  if (!riskAssessmentId) fail('GRA index row has no canonical Risk Assessment ID.');
  const detailResult = await optionalStep(sdk, 'gra-catalog-detail', { riskAssessmentId });
  if (!detailResult.present || deleted(detailResult.value)) return null;
  const detail = detailResult.value; const actual = omniaGuid(detail && (detail.id || detail.riskAssessmentId));
  if (actual !== riskAssessmentId) fail('GRA catalog detail returned another Risk Assessment identity.');
  if (outsideRequestedWorkspace(detail, requestedWorkspaceIds)) return null;
  const workItemId = omniaGuid(detail && (detail.workItemId || detail.riskAssessmentWorkItemId) || indexed.workItemId);
  const mapped = detailWorkspaceIds(detail, indexed).map(omniaGuid);
  if (!workItemId || mapped.length !== 1 || !mapped[0]) fail('GRA catalog detail has no exact Work Item and Workspace identity.');
  return { objectId: riskAssessmentId, riskAssessmentId, workItemId, objectType: 'GRA',
    number: text(detail.referenceNumber || indexed.referenceNumber),
    name: text(detail.name || detail.displayName || indexed.names && indexed.names[0]),
    updatedAt: text(detail.updatedOn || detail.updatedAt || indexed.updatedAt), workspaceIds: mapped,
    blockers: [], relations: [], deleted: false };
}
async function readItElement(sdk, indexed, stepPrefix = 'it-element', requestedWorkspaceIds = null) {
  const objectId = id(indexed && (indexed.objectId || indexed.id || indexed.itElementId || indexed.applicationId || indexed.infrastructureId || indexed.toolId));
  if (!objectId) fail('IT Element index row has no canonical ID.');
  const detail = await sdk.invokeStep(`${stepPrefix}-detail`, { objectId });
  const actual = id(detail && (detail.id || detail.itElementId));
  const workItemId = id(detail && (detail.workItemId || detail.applicationWorkItemId || detail.infrastructureWorkItemId || detail.itToolWorkItemId) || indexed && indexed.workItemId);
  if (actual !== objectId || !workItemId || deleted(detail)) fail('IT Element detail identity is missing, changed, or deleted.');
  if (outsideRequestedWorkspace(detail, requestedWorkspaceIds)) return null;
  const [mapping, blocking] = await Promise.all([
    sdk.invokeStep(`${stepPrefix}-facet-mapping`, { workItemId }), sdk.invokeStep(`${stepPrefix}-blocking-relationships`, { objectId })
  ]);
  const kind = objectKind(detail, indexed);
  if (!kind && explicitlyUnsupportedInfrastructure(detail, indexed)) return null;
  if (!kind) fail('IT Element type/subtype is missing, ambiguous, or outside the signed APP/DB/OS/DCNO/TOOL read contract.');
  return { objectId, workItemId, objectType: kind, number: text(detail.number || detail.referenceNumber || indexed.number),
    name: text(detail.name || detail.displayName || indexed.name), updatedAt: text(detail.updatedAt || detail.updatedOn || indexed.updatedAt || indexed.updatedOn),
    workspaceIds: workspaceIds(mapping), blockers: blockingRows(blocking, objectId), relations: [],
    riskAssessmentId: id(detail.riskAssessmentId || detail.graId || indexed.riskAssessmentId || indexed.graId), detail, deleted: false };
}
async function readPreflightToolIdentity(sdk, indexed) {
  const objectId = id(indexed && (indexed.objectId || indexed.id || indexed.itElementId || indexed.toolId));
  if (!objectId) fail('Tool directory row has no canonical ID.');
  const detail = await sdk.invokeStep('preflight-tool-detail', { objectId });
  const workItemId = id(detail && (detail.workItemId || detail.itToolWorkItemId) || indexed && indexed.workItemId);
  if (id(detail && (detail.id || detail.itElementId)) !== objectId || objectKind(detail, indexed) !== 'TOOL' || !workItemId || deleted(detail)) {
    fail('Tool relation discovery identity is missing, changed, or deleted.');
  }
  const mapping = await sdk.invokeStep('preflight-tool-facet-mapping', { workItemId }); const workspaces = workspaceIds(mapping);
  if (workspaces.length !== 1) fail('Tool relation discovery has no exact Workspace.');
  return { objectId, workItemId, objectType: 'TOOL', workspaceIds: workspaces, relations: [], blockers: [],
    updatedAt: text(detail.updatedOn || detail.updatedAt), detail, deleted: false };
}
function relationKey(type, sourceId, targetId) { return `${type}|${sourceId}|${targetId}`; }
function relationGroupKey(type, sourceId, targetIds) { return `${type}|${sourceId}|group:${digest([...targetIds].sort())}`; }
async function toolApplicationRows(sdk, toolId, stepId = 'tool-relation-search') {
  return searchAll(sdk, stepId, 'name', { associatedWithITToolId: toolId, itElementType: 'Application' });
}
async function discoverToolRelations(sdk, targets, stepIds = {}) {
  const tools = targets.filter((item) => item.objectType === 'TOOL');
  const byId = new Map(targets.map((item) => [item.objectId, item]));
  const edges = [];
  for (const tool of tools) {
    const applications = await toolApplicationRows(sdk, tool.objectId, stepIds.search || 'tool-relation-search');
    for (const indexed of applications) {
      const applicationId = id(indexed && (indexed.id || indexed.applicationId || indexed.itElementId));
      if (!applicationId) fail('Tool/Application search returned a row without an Application identity.');
      const application = byId.get(applicationId);
      edges.push({ relationType: 'ItToolApplication', sourceObjectId: tool.objectId, targetObjectId: applicationId,
        sourceObjectType: 'TOOL', targetObjectType: 'APP', sourceWorkItemId: tool.workItemId,
        targetWorkItemId: application && application.workItemId || id(indexed.workItemId),
        sourceWorkspaceId: tool.workspaceIds.length === 1 ? tool.workspaceIds[0] : '',
        targetWorkspaceId: application && application.workspaceIds.length === 1 ? application.workspaceIds[0] : id(indexed.workspaceId || indexed.workspaceFacetId || indexed.facetId) });
    }
  }
  const unique = new Map();
  for (const edge of edges) unique.set(relationKey(edge.relationType, edge.sourceObjectId, edge.targetObjectId), edge);
  return [...unique.values()].sort((left, right) => relationKey(left.relationType, left.sourceObjectId, left.targetObjectId)
    .localeCompare(relationKey(right.relationType, right.sourceObjectId, right.targetObjectId)));
}
async function readRelationObject(sdk, objectId, expectedType, workItemId, workspaceId) {
  const detail = await sdk.invokeStep('relation-object-detail', { objectId });
  const actualWorkItemId = id(detail && (detail.workItemId || detail.applicationWorkItemId || detail.infrastructureWorkItemId || detail.itToolWorkItemId));
  const mapping = await sdk.invokeStep('relation-facet-mapping', { workItemId }); const mapped = workspaceIds(mapping);
  if (id(detail && (detail.id || detail.itElementId)) !== objectId || actualWorkItemId !== workItemId || objectKind(detail) !== expectedType
    || deleted(detail) || mapped.length !== 1 || mapped[0] !== workspaceId) fail('Relation endpoint identity/type/Work Item/Workspace drifted.');
  return { objectId, objectType: expectedType, workItemId, workspaceId, updatedAt: text(detail.updatedOn || detail.updatedAt), detail };
}
async function relationState(sdk, relationType, sourceId, targetId) {
  if (relationType === 'InfrastructureApplication') {
    const [apps, infrastructures] = await Promise.all([
      searchAll(sdk, 'relation-applications-search', 'number', { associatedWithInfrastructureId: sourceId }),
      searchAll(sdk, 'relation-infrastructures-search', 'number', { associatedWithApplicationId: targetId })
    ]);
    const fromSource = apps.some((item) => id(item && (item.id || item.applicationId || item.itElementId)) === targetId);
    const fromTarget = infrastructures.some((item) => id(item && (item.id || item.infrastructureId || item.itElementId)) === sourceId);
    return { associated: fromSource && fromTarget, inconsistent: fromSource !== fromTarget, fromSource, fromTarget };
  }
  if (relationType === 'ItToolApplication') {
    const apps = await toolApplicationRows(sdk, sourceId, 'relation-tool-search');
    const found = apps.some((item) => id(item && (item.id || item.applicationId || item.itElementId)) === targetId);
    return { associated: found, inconsistent: false, fromSource: found, fromTarget: found };
  }
  fail('Unsupported relation type.');
}
async function relationPreflight(request, sdk) {
  const relationType = text(request.relationType); const contract = RELATION_CONTRACTS[relationType];
  if (!contract) fail('Unsupported relation type.');
  const sourceId = id(request.sourceObjectId); const sourceWorkItemId = id(request.sourceWorkItemId); const sourceWorkspaceId = id(request.sourceWorkspaceId);
  const requestedTargets = rows(request.targets).map((target) => ({ objectId: id(target && target.objectId), objectType: text(target && target.objectType),
    workItemId: id(target && target.workItemId), workspaceId: id(target && target.workspaceId) }));
  const targetIds = rows(request.targetObjectIds).map(id);
  if (!sourceId || !requestedTargets.length || requestedTargets.length > 200 || requestedTargets.some((target) => !target.objectId || target.objectType !== 'APP' || !target.workItemId || !target.workspaceId)
    || targetIds.length !== requestedTargets.length || new Set(targetIds).size !== targetIds.length
    || canonical(targetIds) !== canonical([...targetIds].sort()) || canonical(targetIds) !== canonical(requestedTargets.map((target) => target.objectId))) {
    fail('Relation group target inventory is empty, duplicate, unsorted, or incomplete.');
  }
  const [source, targets] = await Promise.all([
    readRelationObject(sdk, sourceId, text(request.sourceObjectType), sourceWorkItemId, sourceWorkspaceId),
    mapLimit(requestedTargets, 8, (target) => readRelationObject(sdk, target.objectId, 'APP', target.workItemId, target.workspaceId))
  ]);
  if (!contract.sourceTypes.includes(source.objectType) || targets.some((target) => source.workspaceId !== target.workspaceId)) fail('Relation endpoints do not match the frozen same-Workspace type contract.');
  const states = await mapLimit(targets, 8, (target) => relationState(sdk, relationType, sourceId, target.objectId));
  if (states.some((state) => !state.associated || state.inconsistent)) fail('Frozen relation group is partial, absent, or inconsistent.');
  const concurrency = relationshipConcurrency(source.detail, contract.sourceTab);
  if (!concurrency) fail(`${relationType} source tab ${contract.sourceTab} concurrency token is unavailable.`);
  return { relationGroupKey: relationGroupKey(relationType, sourceId, targetIds), relationType, targetObjectIds: targetIds,
    source: { objectId: source.objectId, objectType: source.objectType, workItemId: source.workItemId, workspaceId: source.workspaceId, updatedAt: source.updatedAt },
    targets: targets.map((target) => ({ objectId: target.objectId, objectType: target.objectType, workItemId: target.workItemId,
      workspaceId: target.workspaceId, updatedAt: target.updatedAt, associated: true, inconsistent: false, deleted: false })),
    concurrency, associated: true, inconsistent: false, deleted: false };
}
function validationClear(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && ['blockingEntities', 'convertingEntities', 'blockingControlEntities', 'accountContents'].every((key) => Array.isArray(value[key]) && value[key].length === 0)
    && value.showDeleteAccountProcedureMappingPrompt === false;
}
function catalogRows(payload, property, label) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload[property])) return payload[property];
  fail(`${label} did not return its recorded v4 top-level collection.`);
}
function optionalId(value) { return omniaGuid(value); }
function riskRiskScopeLookupId(item) {
  const direct = optionalId(item && item.riskRiskScopeId); if (direct) return direct;
  for (const value of rows(item && item.riskRiskScopeIds)) { const candidate = optionalId(value); if (candidate) return candidate; }
  for (const scope of rows(item && item.riskRiskScopes)) { const candidate = optionalId(scope && scope.id); if (candidate) return candidate; }
  fail('riskRiskScopeId is absent from the recorded create-associate catalog shapes.');
}
function riskControlSnapshot(detail, risk) {
  const result = [];
  const add = (scope, boundControlId = '') => {
    if (!scope || scope.isDeleted === true || scope.enabled === false || scope.isEnabled === false) return;
    const controlId = optionalId(scope.controlId || scope.planResponseControlId || scope.control && scope.control.id || boundControlId);
    const riskId = optionalId(scope.riskId || scope.risk && scope.risk.id || risk.riskId);
    const riskRiskScopeId = optionalId(scope.riskRiskScopeId || scope.riskRiskScope && scope.riskRiskScope.id || risk.riskRiskScopeId);
    const riskScopeId = optionalId(scope.riskScopeId || scope.riskScope && scope.riskScope.id || risk.riskScopeId);
    if (!controlId || riskId !== risk.riskId || riskRiskScopeId !== risk.riskRiskScopeId || riskScopeId !== risk.riskScopeId) {
      fail('Risk-Control detail contains an active association without the complete deletion identity.');
    }
    result.push({ riskId, riskRiskScopeId, riskScopeId, controlId });
  };
  for (const control of [...rows(detail && detail.planResponseSelectedControl), ...rows(detail && detail.planResponseControl)]) {
    const controlId = optionalId(control && (control.controlId || control.id)); if (!controlId || deleted(control)) continue;
    for (const scope of [...rows(control.currentRiskScopes), ...rows(control.controlRiskScopes), ...rows(control.riskScopes)]) {
      add(scope, controlId);
    }
  }
  for (const scope of [...rows(detail && detail.controlRiskScopes), ...rows(detail && detail.riskControlScopes)]) add(scope);
  const unique = new Map();
  for (const item of result) unique.set([item.riskId, item.riskRiskScopeId, item.riskScopeId, item.controlId].join('|'), item);
  return [...unique.values()].sort((left, right) => canonical(left).localeCompare(canonical(right)));
}
async function graCascadeSnapshot(sdk, riskAssessmentId, workspaceId, assessment) {
  const [riskPayload, controlPayload] = await Promise.all([
    sdk.invokeStep('risk-catalog', { riskAssessmentId }), sdk.invokeStep('control-catalog', { riskAssessmentId })
  ]);
  const assessmentUpdatedOn = text(assessment.updatedOn || assessment.updatedAt);
  if (!assessmentUpdatedOn) fail('GRA has no live concurrency timestamp.');
  const riskRows = catalogRows(riskPayload, 'plannedResponses', 'Risk catalog').filter((item) => !deleted(item));
  const risks = []; const riskControls = [];
  for (const item of riskRows) {
    const riskId = optionalId(item && (item.riskId || item.id)); if (!riskId) fail('Risk catalog row has no canonical riskId.');
    const riskRiskScopeId = riskRiskScopeLookupId(item);
    const detail = await sdk.invokeStep('risk-detail', { riskRiskScopeId });
    const detailRows = catalogRows(detail, 'planResponseRisk', 'Risk detail');
    const matches = detailRows.filter((candidate) => optionalId(candidate && (candidate.riskId || candidate.id)) === riskId && !deleted(candidate));
    if (matches.length !== 1) fail('Risk detail did not return one exact active planned-response Risk.');
    const scopes = rows(matches[0].riskRiskScopes).filter((scope) => optionalId(scope && scope.id) === riskRiskScopeId && !deleted(scope));
    if (scopes.length !== 1) fail('Risk detail did not return one exact active RiskRiskScope.');
    const riskScopeId = optionalId(scopes[0].riskScopeId); if (!riskScopeId) fail('Risk detail riskScopeId is absent.');
    const risk = { riskId, riskRiskScopeId, riskScopeId, updatedOn: text(item.updatedOn || item.updatedAt || matches[0].updatedOn || matches[0].updatedAt || assessmentUpdatedOn) };
    if (!risk.updatedOn) fail('Risk concurrency timestamp is absent.');
    risks.push(risk); riskControls.push(...riskControlSnapshot(detail, risk));
  }
  const controls = catalogRows(controlPayload, 'controls', 'Control catalog').filter((item) => !deleted(item)).map((item) => {
    const controlId = optionalId(item && (item.controlId || item.id)); const workItemId = optionalId(item && item.workItemId);
    if (!controlId || !workItemId) fail('Control catalog row has no complete Control/Work Item identity.');
    return { controlId, workItemId, updatedOn: text(item.updatedOn || item.updatedAt || assessmentUpdatedOn) };
  });
  const unique = (items, key, label) => {
    const result = new Map(); for (const item of items) { const identity = key(item); if (result.has(identity)) fail(`${label} snapshot contains a duplicate identity.`); result.set(identity, item); }
    return [...result.values()].sort((left, right) => key(left).localeCompare(key(right)));
  };
  const snapshot = { schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1',
    assessment: { riskAssessmentId, workItemId: optionalId(assessment.workItemId || assessment.riskAssessmentWorkItemId), workspaceId, updatedOn: assessmentUpdatedOn },
    risks: unique(risks, (item) => `${item.riskId}\u0000${item.riskRiskScopeId}`, 'Risk'),
    controls: unique(controls, (item) => `${item.controlId}\u0000${item.workItemId}`, 'Control'),
    riskControls: unique(riskControls, (item) => `${item.riskId}\u0000${item.riskRiskScopeId}\u0000${item.riskScopeId}\u0000${item.controlId}`, 'Risk-Control') };
  if (!snapshot.assessment.workItemId) fail('GRA Work Item identity is absent.');
  return { ...snapshot, snapshotDigest: digest(snapshot) };
}
function notFound(error) {
  return [error && error.status, error && error.statusCode, error && error.response && error.response.status].some((value) => Number(value) === 404)
    || ['NOT_FOUND', 'REMOTE.NOT_FOUND', 'CONNECTOR.NOT_FOUND'].includes(text(error && error.code).toUpperCase());
}
async function optionalStep(sdk, stepId, parameters) {
  try { return { present: true, value: await sdk.invokeStep(stepId, parameters) }; }
  catch (error) { if (notFound(error)) return { present: false, value: null }; throw error; }
}
async function graReconcile(request, sdk) {
  const riskAssessmentId = id(request.riskAssessmentId); const workspaceId = id(request.workspaceId);
  const frozen = request.frozenCascadeSnapshot;
  if (!frozen || frozen.schemaVersion !== 'omnia.delete.gra-cascade-snapshot/v1' || frozen.snapshotDigest !== digest({
    schemaVersion: frozen.schemaVersion, assessment: frozen.assessment, risks: frozen.risks, controls: frozen.controls, riskControls: frozen.riskControls
  }) || id(frozen.assessment && frozen.assessment.riskAssessmentId) !== riskAssessmentId || id(frozen.assessment && frozen.assessment.workspaceId) !== workspaceId) {
    fail('Frozen GRA cascade snapshot is missing, corrupt, or belongs to another root.');
  }
  const [assessmentResult, riskPayload, controlPayload] = await Promise.all([
    optionalStep(sdk, 'gra-detail', { riskAssessmentId }), sdk.invokeStep('risk-catalog', { riskAssessmentId }), sdk.invokeStep('control-catalog', { riskAssessmentId })
  ]);
  let assessmentState = 'absent';
  if (assessmentResult.present) {
    const actualId = id(assessmentResult.value && (assessmentResult.value.id || assessmentResult.value.riskAssessmentId));
    if (actualId !== riskAssessmentId) fail('GRA reconcile returned another assessment identity.');
    const workspaces = detailWorkspaceIds(assessmentResult.value);
    if (workspaces.length && (workspaces.length !== 1 || workspaces[0] !== workspaceId)) fail('GRA reconcile Workspace drifted.');
    assessmentState = deleted(assessmentResult.value) ? 'deleted' : 'present';
  }
  const activeRisks = new Set(catalogRows(riskPayload, 'plannedResponses', 'Risk catalog').filter((item) => !deleted(item)).map((item) => optionalId(item && (item.riskId || item.id))).filter(Boolean));
  const activeControls = new Set(catalogRows(controlPayload, 'controls', 'Control catalog').filter((item) => !deleted(item)).map((item) => optionalId(item && (item.controlId || item.id))).filter(Boolean));
  const risks = frozen.risks.map((item) => ({ ...item, ...(activeRisks.has(item.riskId) ? { deleted: false } : { absent: true }) }));
  const controls = frozen.controls.map((item) => ({ ...item, ...(activeControls.has(item.controlId) ? { deleted: false } : { absent: true }) }));
  const detailCache = new Map();
  const riskControls = [];
  for (const item of frozen.riskControls) {
    let active = false;
    if (!detailCache.has(item.riskRiskScopeId)) detailCache.set(item.riskRiskScopeId, await optionalStep(sdk, 'risk-detail', { riskRiskScopeId: item.riskRiskScopeId }));
    const result = detailCache.get(item.riskRiskScopeId);
    if (result.present) active = riskControlSnapshot(result.value, item).some((candidate) => canonical(candidate) === canonical({
      riskId: item.riskId, riskRiskScopeId: item.riskRiskScopeId, riskScopeId: item.riskScopeId, controlId: item.controlId
    }));
    riskControls.push({ ...item, ...(active ? { deleted: false } : { absent: true }) });
  }
  const observed = { schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1',
    assessment: frozen.assessment, risks, controls, riskControls, snapshotDigest: frozen.snapshotDigest };
  const verifiedCascade = assessmentState !== 'present'
    && risks.every((item) => item.absent === true) && controls.every((item) => item.absent === true)
    && riskControls.every((item) => item.absent === true);
  return { objectId: riskAssessmentId, riskAssessmentId, objectType: 'GRA', workspaceIds: [workspaceId], deleted: assessmentState !== 'present',
    verifiedCascade, cascadeSnapshot: observed };
}

function createOperationHandler() {
  return Object.freeze({ async run(operationId, request, sdk) {
    if (operationId === 'omnia.delete.scope.read.v1') {
      await sdk.invokeStep('pack-hierarchy');
      const directory = authorityDirectory(await sdk.invokeStep('authority-directory', { engagementId: sdk.binding.engagementId }), sdk.binding.engagementId);
      return { connectorId: sdk.binding.connectorId, sessionGeneration: sdk.binding.sessionGeneration, engagementId: sdk.binding.engagementId,
        authorityInstanceId: sdk.binding.authorityInstanceId, tenantOrOrgId: sdk.binding.tenantOrOrgId, packId: sdk.binding.packId,
        workspaceIds: directory.workspaces.map((item) => item.id), sections: directory.sections, workspaces: directory.workspaces };
    }
    if (operationId === 'omnia.delete.catalog.heavy-read.v1') {
      if (id(request.engagementId) !== id(sdk.binding.engagementId)) fail('Authoritative catalog request crossed the current Engagement.');
      const requestedWorkspaceIds = rows(request.workspaceIds).map(omniaGuid);
      if (!requestedWorkspaceIds.length || requestedWorkspaceIds.some((value) => !value)
        || new Set(requestedWorkspaceIds).size !== requestedWorkspaceIds.length) {
        fail('Authoritative catalog request has an empty, duplicate, or invalid Workspace scope.');
      }
      const allowed = new Set(requestedWorkspaceIds);
      const [informationPayload, graWorkItems, graCommonAccounts, applications, infrastructures, tools] = await Promise.all([
        sdk.invokeStep('information-collection'),
        sdk.invokeStep('gra-workitem-index', {}, { workItemIds: [], engagementIds: [sdk.binding.engagementId], workItemTypes: ['RiskFactorEvaluation'] }),
        sdk.invokeStep('gra-common-account-index', {}, { riskAssessmentType: [] }),
        searchAll(sdk, 'application-search', 'number'), searchAll(sdk, 'infrastructure-search', 'number'),
        searchAll(sdk, 'tool-search', 'name', { itElementType: 'ITTool' })
      ]);
      const information = rows(informationPayload); const gras = mergeRiskAssessmentIndex(graWorkItems, graCommonAccounts);
      const targets = await mapLimit([...information.map((item) => ({ kind: 'information', item })),
        ...gras.map((item) => ({ kind: 'gra', item })),
        ...applications.map((item) => ({ kind: 'it', item })), ...infrastructures.map((item) => ({ kind: 'it', item })),
        ...tools.map((item) => ({ kind: 'it', item }))], 4,
      (entry) => entry.kind === 'information' ? readInformation(sdk, entry.item, allowed)
        : entry.kind === 'gra' ? readGra(sdk, entry.item, allowed) : readItElement(sdk, entry.item, 'it-element', allowed));
      const activeTargets = targets.filter(Boolean);
      const toolEdges = await discoverToolRelations(sdk, activeTargets);
      const byId = new Map(activeTargets.map((item) => [item.objectId, item]));
      for (const edge of toolEdges) {
        const source = byId.get(edge.sourceObjectId); const target = byId.get(edge.targetObjectId);
        if (source) source.relations.push(edge); if (target) target.relations.push(edge);
      }
      const unique = new Map();
      for (const target of activeTargets) if (!target.deleted && target.workspaceIds.length === 1 && target.workspaceIds.every((workspace) => allowed.has(workspace))) {
        const { detail: _detail, ...projected } = target;
        const clean = { ...projected, relations: [...target.relations].sort((left, right) => canonical(left).localeCompare(canonical(right))) };
        const identity = `${target.objectType}|${target.objectId}`;
        if (unique.has(identity)) fail('Authoritative catalog returned a duplicate target identity.');
        unique.set(identity, clean);
      }
      return { engagementId: sdk.binding.engagementId, items: [...unique.values()] };
    }
    if (operationId === 'omnia.delete.information.preflight.v1') {
      const target = await readInformation(sdk, request.target || {});
      return { informationId: target.informationId, objectId: target.objectId, objectType: 'Information', workItemId: target.workItemId,
        workspaceIds: target.workspaceIds, updatedAt: target.updatedAt, blockers: target.blockers, relations: [] };
    }
    if (operationId === 'omnia.delete.information.direct.v1') {
      const informationId = id(request.command && request.command.payload && request.command.payload.informationId);
      if (!informationId || informationId !== id(request.informationId)) fail('Signed Information delete target drifted from the Core command.');
      await sdk.invokeStep('soft-delete', { informationId }); return { informationId, objectId: informationId, objectType: 'Information', accepted: true };
    }
    if (operationId === 'omnia.delete.information.reconcile.v1') {
      const informationId = id(request.informationId); const workItemId = id(request.workItemId); const workspaceId = id(request.workspaceId);
      const detailResult = await optionalStep(sdk, 'information-detail', { informationId });
      if (!detailResult.present) return { informationId, objectId: informationId, objectType: 'Information', workspaceIds: [workspaceId], deleted: true, absent: true };
      const mapping = await sdk.invokeStep('facet-mapping', { workItemId }); const mapped = workspaceIds(mapping);
      if (id(detailResult.value && (detailResult.value.id || detailResult.value.informationId)) !== informationId || mapped.length !== 1 || mapped[0] !== workspaceId) fail('Information reconcile identity/Workspace drifted.');
      return { informationId, objectId: informationId, objectType: 'Information', workspaceIds: [workspaceId], deleted: deleted(detailResult.value) };
    }
    if (operationId === 'omnia.delete.it-element.preflight.v1') {
      const allTools = await searchAll(sdk, 'preflight-tool-search', 'name', { itElementType: 'ITTool' });
      const target = await readItElement(sdk, request.target || request, 'it-element');
      const toolTargets = target.objectType === 'TOOL' ? [target]
        : await mapLimit(allTools, 4, (item) => readPreflightToolIdentity(sdk, item));
      const candidates = target.objectType === 'TOOL' ? [target] : [...toolTargets, target];
      const discovered = (await discoverToolRelations(sdk, candidates, { search: 'preflight-tool-relation-search' }))
        .filter((edge) => edge.sourceObjectId === target.objectId || edge.targetObjectId === target.objectId);
      const relations = [];
      for (const edge of discovered) {
        if (edge.targetWorkItemId && edge.targetWorkspaceId) { relations.push(edge); continue; }
        const detail = await sdk.invokeStep('preflight-partner-detail', { objectId: edge.targetObjectId });
        const targetWorkItemId = id(detail && (detail.workItemId || detail.applicationWorkItemId));
        if (id(detail && (detail.id || detail.itElementId)) !== edge.targetObjectId || objectKind(detail) !== 'APP' || deleted(detail) || !targetWorkItemId) {
          fail('Tool/Application preflight could not freeze the Application endpoint identity.');
        }
        const mapping = await sdk.invokeStep('preflight-partner-facet-mapping', { workItemId: targetWorkItemId }); const workspaces = workspaceIds(mapping);
        if (workspaces.length !== 1) fail('Tool/Application preflight Application endpoint has no exact Workspace.');
        relations.push({ ...edge, targetWorkItemId, targetWorkspaceId: workspaces[0] });
      }
      return { objectId: target.objectId, objectType: target.objectType, workItemId: target.workItemId, workspaceIds: target.workspaceIds,
        updatedAt: target.updatedAt, blockers: target.blockers, riskAssessmentId: target.riskAssessmentId, relations };
    }
    if (operationId === 'omnia.delete.it-element.direct.v1') {
      const payload = request.command && request.command.payload; const objectId = id(payload && payload.objectId); const objectType = text(payload && payload.objectType);
      if (!objectId || objectId !== id(request.objectId) || objectType !== text(request.objectType) || !['APP', 'DB', 'OS', 'DCNO', 'TOOL'].includes(objectType)) fail('Signed IT Element delete identity drifted from the Core command.');
      await sdk.invokeStep('it-element-soft-delete', { objectId }); return { objectId, objectType, accepted: true };
    }
    if (operationId === 'omnia.delete.it-element.reconcile.v1') {
      const objectId = id(request.objectId); const workItemId = id(request.workItemId); const workspaceId = id(request.workspaceId); const objectType = text(request.objectType);
      const detailResult = await optionalStep(sdk, 'it-element-detail', { objectId });
      if (!detailResult.present) return { objectId, objectType, workspaceIds: [workspaceId], deleted: true, absent: true };
      const mapping = await sdk.invokeStep('it-element-facet-mapping', { workItemId }); const mapped = workspaceIds(mapping);
      if (id(detailResult.value && (detailResult.value.id || detailResult.value.itElementId)) !== objectId || objectKind(detailResult.value) !== objectType || mapped.length !== 1 || mapped[0] !== workspaceId) fail('IT Element reconcile identity/type/Workspace drifted.');
      return { objectId, objectType, workspaceIds: [workspaceId], deleted: deleted(detailResult.value) };
    }
    if (operationId === 'omnia.delete.gra.preflight.v1') {
      const riskAssessmentId = id(request.riskAssessmentId); const workspaceId = id(request.workspaceId);
      const detail = await sdk.invokeStep('gra-detail', { riskAssessmentId }); const workItemId = id(detail && (detail.workItemId || detail.riskAssessmentWorkItemId));
      const workspaces = detailWorkspaceIds(detail);
      if (id(detail && (detail.id || detail.riskAssessmentId)) !== riskAssessmentId || workspaces.length !== 1 || workspaces[0] !== workspaceId || deleted(detail) || !workItemId) fail('GRA preflight identity/Workspace drifted.');
      const [relationship, validation] = await Promise.all([
        sdk.invokeStep('gra-relationship', { workItemId }), sdk.invokeStep('gra-delete-validation', { riskAssessmentId })
      ]);
      if (id(relationship && (relationship.id || relationship.riskAssessmentId) || relationship) !== riskAssessmentId || !validationClear(validation)) fail('GRA delete validation reported blockers or relationship drift.');
      const cascadeSnapshot = await graCascadeSnapshot(sdk, riskAssessmentId, workspaceId, detail);
      return { objectId: riskAssessmentId, riskAssessmentId, objectType: 'GRA', workItemId, workspaceIds: [workspaceId],
        updatedAt: text(detail.updatedOn || detail.updatedAt), blockers: [], relations: [], cascadeSnapshot };
    }
    if (operationId === 'omnia.delete.gra.direct.v1') {
      const riskAssessmentId = id(request.command && request.command.payload && request.command.payload.riskAssessmentId);
      if (!riskAssessmentId || riskAssessmentId !== id(request.riskAssessmentId)) fail('Signed GRA delete target drifted from the Core command.');
      await sdk.invokeStep('gra-soft-delete', { riskAssessmentId }); return { objectId: riskAssessmentId, riskAssessmentId, objectType: 'GRA', accepted: true };
    }
    if (operationId === 'omnia.delete.gra.reconcile.v1') return graReconcile(request, sdk);
    if (operationId === 'omnia.delete.infrastructure-application.preflight.v1' || operationId === 'omnia.delete.it-tool-application.preflight.v1') return relationPreflight(request, sdk);
    if (operationId === 'omnia.delete.infrastructure-application.disassociate.v1' || operationId === 'omnia.delete.it-tool-application.disassociate.v1') {
      const payload = request.command && request.command.payload; const relationType = text(payload && payload.relationType); const contract = RELATION_CONTRACTS[relationType];
      const payloadTargetIds = rows(payload && payload.targetObjectIds).map(id); const requestTargetIds = rows(request.targetObjectIds).map(id);
      if (!contract || relationType !== text(request.relationType) || id(payload.sourceObjectId) !== id(request.sourceObjectId)
        || !payloadTargetIds.length || new Set(payloadTargetIds).size !== payloadTargetIds.length || canonical(payloadTargetIds) !== canonical(requestTargetIds)
        || Number(payload.concurrency && payload.concurrency.entityTabTypeId) !== contract.sourceTab || !text(payload.concurrency && payload.concurrency.updatedOn)) fail('Frozen relation deletion payload drifted from the Core command.');
      await sdk.invokeStep('relation-disassociate', {}, { ItElementId: id(payload.sourceObjectId), AssociatingEntityIds: payloadTargetIds,
        associationType: relationType, ConcurrencyTabId: contract.sourceTab, ConcurrencyTabUpdatedOn: text(payload.concurrency.updatedOn) });
      return { relationGroupKey: relationGroupKey(relationType, id(payload.sourceObjectId), payloadTargetIds), relationType, targetObjectIds: payloadTargetIds, accepted: true };
    }
    if (operationId === 'omnia.delete.infrastructure-application.reconcile.v1' || operationId === 'omnia.delete.it-tool-application.reconcile.v1') {
      const relationType = text(request.relationType); const contract = RELATION_CONTRACTS[relationType]; if (!contract) fail('Unsupported relation type.');
      const sourceId = id(request.sourceObjectId); const requestedTargets = rows(request.targets).map((target) => ({ objectId: id(target && target.objectId),
        objectType: text(target && target.objectType), workItemId: id(target && target.workItemId), workspaceId: id(target && target.workspaceId) }));
      const targetIds = rows(request.targetObjectIds).map(id);
      if (!requestedTargets.length || canonical(targetIds) !== canonical(requestedTargets.map((target) => target.objectId))
        || canonical(targetIds) !== canonical([...new Set(targetIds)].sort())) fail('Relationship reconcile target group drifted.');
      const [source, targets] = await Promise.all([
        readRelationObject(sdk, sourceId, text(request.sourceObjectType), id(request.sourceWorkItemId), id(request.sourceWorkspaceId)),
        mapLimit(requestedTargets, 8, (target) => readRelationObject(sdk, target.objectId, 'APP', target.workItemId, target.workspaceId))
      ]);
      if (!contract.sourceTypes.includes(source.objectType) || targets.some((target) => target.objectType !== contract.targetType || target.workspaceId !== source.workspaceId)) fail('Relationship reconcile endpoint type or Workspace drifted.');
      const states = await mapLimit(targets, 8, (target) => relationState(sdk, relationType, sourceId, target.objectId));
      const projectedTargets = targets.map((target, index) => ({ objectId: target.objectId, objectType: target.objectType,
        associated: states[index].associated, inconsistent: states[index].inconsistent,
        deleted: !states[index].associated && !states[index].inconsistent }));
      const inconsistent = projectedTargets.some((target) => target.inconsistent); const associated = projectedTargets.every((target) => target.associated);
      const deleted = projectedTargets.every((target) => target.deleted);
      return { relationGroupKey: relationGroupKey(relationType, sourceId, targetIds), relationType, targetObjectIds: targetIds,
        source: { objectId: sourceId, objectType: source.objectType }, targets: projectedTargets, associated, inconsistent, deleted };
    }
    fail(`Unsupported signed Operation: ${operationId}`);
  } });
}

module.exports = Object.freeze({ createOperationHandler });
