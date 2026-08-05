'use strict';

function fail(message) { throw new Error(message); }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid.`);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} fields drifted.`);
  return value;
}
function text(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function canonical(value) {
  return value === null || ['boolean','string','number'].includes(typeof value) ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function editorDescription(value,label){
  let editor=value; if(typeof editor==='string'){try{editor=JSON.parse(editor);}catch{fail(`${label} editor JSON is invalid.`);}}
  exact(editor,['editorData','suggestionsData','trackChangesEnableFlagInEditor','plainText'],label);
  if(!Array.isArray(editor.suggestionsData)||editor.trackChangesEnableFlagInEditor!==false||typeof editor.editorData!=='string'||typeof editor.plainText!=='string') fail(`${label} editor contract is invalid.`);
  return editor;
}
function rows(value) { return Array.isArray(value) ? value : []; }
function guid(value, label) {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(normalized)
    || normalized === '00000000-0000-0000-0000-000000000000') fail(`${label} must be a GUID.`);
  return normalized;
}
function catalogId(value,label){const normalized=text(value);if(!/^[A-Za-z0-9._:-]{1,128}$/u.test(normalized)) fail(`${label} must be a canonical live catalog identity.`);return normalized;}
function target(request) {
  const value = exact(request.target, ['targetIdentityKey', 'workspaceId'], 'Mutation target');
  return { targetIdentityKey: text(value.targetIdentityKey), workspaceId: guid(value.workspaceId, 'target.workspaceId') };
}
function command(request, kind) {
  const value = exact(request.command, ['commandId', 'idempotencyKey', 'kind', 'payload'], 'Command');
  guid(value.commandId, 'command.commandId');
  if (value.kind !== kind || !/^[0-9a-f]{64}$/u.test(text(value.idempotencyKey))) fail('Command identity is invalid.');
  return value;
}
function assertScope(request, sdk, payload) {
  const frozenTarget = target(request);
  if (guid(payload.engagementId, 'payload.engagementId') !== guid(sdk.binding.engagementId, 'binding.engagementId')) fail('Payload engagement differs from the active binding.');
  if (guid(payload.workspaceId || payload.facetId, 'payload.workspace') !== frozenTarget.workspaceId) fail('Payload Workspace differs from the frozen target.');
  return frozenTarget;
}
function pageBody(page, pageSize, sortField, extra = {}) {
  return { page, pageSize, filters: [], sortFields: [{ field: sortField, direction: 'asc' }], ...extra };
}
function resultRows(payload) { return rows(payload && payload.results); }
async function boundedSearch(sdk, stepId, bodyForPage, predicate) {
  let observed = 0; let expectedTotal = null; const exactMatches=[];
  for (let page = 1; page <= 20; page += 1) {
    const body = bodyForPage(page);
    const payload = await sdk.invokeStep(stepId, {}, body);
    const current = resultRows(payload);
    exactMatches.push(...current.filter(predicate));
    if (exactMatches.length > 1) fail('Authoritative search returned ambiguous exact identities across completed pages.');
    observed += current.length;
    const total = Number(payload && payload.totalResults);
    if(Number.isFinite(total)&&total>=0){
      if(expectedTotal===null) expectedTotal=total; else if(expectedTotal!==total) fail('Authoritative search total drifted across pages.');
      if(observed>total) fail('Authoritative search returned more rows than its reported total.');
      if((!current.length||current.length<body.pageSize)&&observed<total) fail('Authoritative search terminated before its reported total was observed.');
    }
    const complete=expectedTotal!==null?observed===expectedTotal:(!current.length||current.length<body.pageSize);
    if (complete) {
      return { found: exactMatches.length===1, item: exactMatches[0]||null, pagesRead: page, observed, total:expectedTotal };
    }
  }
  fail('Authoritative search exceeded the signed 20-page bound.');
}
function rowId(item) { return guid(item && (item.id || item.itElementId || item.applicationId || item.infrastructureId || item.toolId), 'result.id'); }
function rowWorkspace(item) { return guid(item && (item.workspaceId || item.workspaceFacetId || item.facetId), 'result.workspaceId'); }
function objectWorkItemId(item) {
  const ids = [...new Set([
    item && item.workItemId, item && item.applicationWorkItemId, item && item.infrastructureWorkItemId, item && item.itToolWorkItemId
  ].map(optionalGuid).filter(Boolean))];
  if (ids.length !== 1) fail('IT Element detail must contain one non-zero Work Item GUID.');
  return ids[0];
}
function mappingWorkspaceIds(mapping) {
  return [...new Set(rows(mapping).map((item) => optionalGuid(item && (item.facetId || item.workspaceFacetId || item.workspaceId || item.id))).filter(Boolean))].sort();
}
async function assertObjectWorkspaceAuthority(sdk, stepId, item, frozenWorkspaceId) {
  const workItemId = objectWorkItemId(item);
  const workspaceIds = mappingWorkspaceIds(await sdk.invokeStep(stepId, { workItemId }));
  if (workspaceIds.length !== 1 || workspaceIds[0] !== frozenWorkspaceId) fail('IT Element Work Item has no unique exact frozen Workspace mapping.');
  return { workItemId, workspaceId: frozenWorkspaceId };
}
function settingsConcurrencyToken(item, required, label) {
  const candidates=rows(item&&item.concurrencyTabs).filter((tab)=>Number(tab&&tab.entityTabTypeId)===501&&text(tab&&tab.updatedOn));
  if(!candidates.length){if(required)fail(`${label} has no Application settings concurrency token.`);return '';}
  const latest=[...candidates].map((tab)=>text(tab.updatedOn)).sort((left,right)=>right.localeCompare(left))[0];
  if(candidates.filter((tab)=>text(tab.updatedOn)===latest).length!==1) fail(`${label} has no unique latest Application settings concurrency token.`);
  return latest;
}
async function readApplicationSettings(sdk,readStep,workspaceStep,objectId,frozenWorkspaceId,label){
  const result=await sdk.invokeStep(readStep,{objectId});
  if(rowId(result)!==objectId||deletedEntity(result)||text(result.itElementType||result.elementType||result.type)!=='Application') fail(`${label} identity/type mismatch.`);
  const authority=await assertObjectWorkspaceAuthority(sdk,workspaceStep,result,frozenWorkspaceId);
  return{...result,...authority};
}
function assertObject(item, query) {
  const type = text(item.itElementType || item.elementType || item.type);
  if (rowWorkspace(item) !== guid(query.workspaceId, 'query.workspaceId') || !type || type !== query.objectType) return false;
  if (query.subtypeId && text(item.typeId || item.itElementTypeId) !== text(query.subtypeId)) return false;
  const external = text(item.number || item.referenceNumber || item.name);
  return external.normalize('NFC') === text(query.externalId).normalize('NFC');
}
function objectIdentityValues(item) {
  return [item && (item.number || item.referenceNumber || item.itElementNumber),
    item && (item.name || item.displayName || item.itElementName), item && item.systemId]
    .map((value) => normalizedLabel(value)).filter(Boolean);
}
async function searchObjectIdentities(sdk, stepId, query, sortField, extra) {
  const wanted = normalizedLabel(query.externalId); const wantedWorkspace = guid(query.workspaceId, 'query.workspaceId');
  let observed = 0; let expectedTotal = null; const matches = [];
  for (let page = 1; page <= 20; page += 1) {
    const body = pageBody(page, 500, sortField, extra); const payload = await sdk.invokeStep(stepId, {}, body);
    const current = resultRows(payload);
    for (const item of current) {
      if (!objectIdentityValues(item).includes(wanted)) continue;
      const itemType = normalizedObjectType(item && (item.itElementType || item.elementType || item.entityType || item.type));
      const workspaceId = optionalGuid(item && (item.workspaceId || item.workspaceFacetId || item.facetId));
      const id = optionalGuid(item && (item.id || item.itElementId || item.applicationId || item.infrastructureId || item.toolId));
      const observedSubtype = text(item && (item.typeId || item.itElementTypeId));
      if (itemType !== query.objectType || !workspaceId || workspaceId !== wantedWorkspace || !id
        || (query.subtypeId && observedSubtype && observedSubtype !== text(query.subtypeId))) {
        matches.push({ state: 'ambiguous', id, item });
      } else matches.push({ state: deletedEntity(item) ? 'recycle_bin' : 'active', id, item });
    }
    observed += current.length;
    const total = Number(payload && payload.totalResults);
    if (Number.isFinite(total) && total >= 0) {
      if (expectedTotal === null) expectedTotal = total;
      else if (expectedTotal !== total) fail('Authoritative IT Element search total drifted across pages.');
      if (observed > total) fail('Authoritative IT Element search returned more rows than its reported total.');
      if ((!current.length || current.length < body.pageSize) && observed < total) fail('Authoritative IT Element search terminated before its reported total was observed.');
    }
    const complete = expectedTotal !== null ? observed === expectedTotal : (!current.length || current.length < body.pageSize);
    if (complete) return { matches, pagesRead: page, observed, total: expectedTotal };
  }
  fail('Authoritative IT Element search exceeded the signed 20-page bound.');
}
function mergeObjectIdentityMatches(matches, query) {
  const expectedWorkspaceId = guid(query.workspaceId, 'query.workspaceId');
  const expectedSubtype = text(query.subtypeId); const byId = new Map(); let incompleteCount = 0;
  for (const match of matches) {
    if (!match.id || match.state === 'ambiguous') { incompleteCount += 1; continue; }
    const item = match.item || {};
    const objectType = normalizedObjectType(item.itElementType || item.elementType || item.entityType || item.type);
    const workspaceId = optionalGuid(item.workspaceId || item.workspaceFacetId || item.facetId);
    const subtype = text(item.typeId || item.itElementTypeId);
    if (!objectType || !workspaceId || (expectedSubtype && !subtype)) { incompleteCount += 1; continue; }
    const current = byId.get(match.id) || { id: match.id, states: new Set(), objectTypes: new Set(), workspaceIds: new Set(), subtypes: new Set(), item };
    current.states.add(match.state); current.objectTypes.add(objectType); current.workspaceIds.add(workspaceId);
    if (subtype) current.subtypes.add(subtype);
    byId.set(match.id, current);
  }
  const active = []; const recycled = []; const conflictIds = [];
  for (const current of byId.values()) {
    const conflict = current.states.size !== 1 || current.objectTypes.size !== 1 || !current.objectTypes.has(query.objectType)
      || current.workspaceIds.size !== 1 || !current.workspaceIds.has(expectedWorkspaceId)
      || (expectedSubtype && (current.subtypes.size !== 1 || !current.subtypes.has(expectedSubtype)));
    if (conflict) { conflictIds.push(current.id); continue; }
    const merged = { id: current.id, state: [...current.states][0], item: current.item };
    (merged.state === 'active' ? active : recycled).push(merged);
  }
  active.sort((left, right) => left.id.localeCompare(right.id)); recycled.sort((left, right) => left.id.localeCompare(right.id)); conflictIds.sort();
  return { active, recycled, conflictIds, incompleteCount };
}
async function objectPreflight(request, sdk) {
  const queryKeys = Object.keys(request.query || {}).sort();
  if (queryKeys.join('|') !== ['externalId', 'objectType', 'workspaceId'].sort().join('|')
    && queryKeys.join('|') !== ['externalId', 'graName', 'objectType', 'subtypeId', 'workspaceId'].sort().join('|')) fail('Object preflight query fields drifted.');
  const query = request.query; const workspaceId = guid(query.workspaceId, 'query.workspaceId');
  const mapping = {
    Application: ['application-search', 'number'],
    Infrastructure: ['infrastructure-search', 'number'],
    ITTool: ['tool-search', 'name']
  }[query.objectType];
  if (!mapping) fail('Unsupported IT Element type.');
  if (query.objectType !== 'Application') {
    const expectedSubtype = query.objectType === 'ITTool' ? 'Tool' : text(query.subtypeId);
    if (!['Database','OperatingSystem','Tool'].includes(expectedSubtype) || text(query.subtypeId) !== expectedSubtype) fail('Object preflight subtype identity is invalid.');
  }
  const search = await searchObjectIdentities(sdk, mapping[0], query, mapping[1], query.objectType === 'ITTool' ? { itElementType: 'ITTool' } : {});
  const merged = mergeObjectIdentityMatches(search.matches, query);
  const { active, recycled, conflictIds, incompleteCount } = merged;
  let graMatches = [];
  if (text(query.graName)) {
    const [workItems, commonAccounts] = await Promise.all([
      sdk.invokeStep('workitem-directory', {}, { workItemIds: [], engagementIds: [guid(sdk.binding.engagementId, 'binding.engagementId')], workItemTypes: ['RiskFactorEvaluation'] }),
      sdk.invokeStep('gra-directory', {}, { riskAssessmentType: [] })
    ]);
    const directory = applicationGraDirectory(workItems, commonAccounts);
    graMatches = directory.rows.filter((item) => normalizedLabel(item.graName) === normalizedLabel(query.graName)
      && (item.ambiguous || !item.objectType || item.objectType === query.objectType)
      && (item.ambiguous || !item.workspaceId || item.workspaceId === workspaceId));
  }
  const recycledGra = graMatches.filter((item) => item.recycled);
  const activeGra = graMatches.filter((item) => !item.recycled);
  let matchState = 'none';
  if (incompleteCount || conflictIds.length || active.length > 1 || recycled.length > 1 || active.length + recycled.length > 1 || activeGra.length > 1) matchState = 'ambiguous';
  else if (active.length === 1 && recycledGra.length) matchState = 'ambiguous';
  else if (active.length === 1) matchState = 'active';
  else if (recycled.length === 1 || recycledGra.length === 1) matchState = 'recycle_bin';
  else if (activeGra.length) matchState = 'ambiguous';
  let item = null;
  if (matchState === 'active') {
    const objectId = active[0].id; const detail = await sdk.invokeStep('object-detail', { objectId });
    const detailWorkspaceId = optionalGuid(detail && (detail.workspaceId || detail.workspaceFacetId || detail.facetId));
    const detailExact = !deletedEntity(detail) && rowId(detail) === objectId
      && normalizedObjectType(detail.itElementType || detail.elementType || detail.entityType || detail.type) === query.objectType
      && objectIdentityValues(detail).includes(normalizedLabel(query.externalId))
      && (!query.subtypeId || text(detail.typeId || detail.itElementTypeId) === text(query.subtypeId))
      && (!detailWorkspaceId || detailWorkspaceId === workspaceId);
    if (!detailExact) matchState = 'ambiguous';
    else {
      const authority = await assertObjectWorkspaceAuthority(sdk, 'object-identity-workspace', detail, workspaceId);
      item = { ...detail, workItemId: authority.workItemId, workspaceId: authority.workspaceId };
    }
  }
  return { source: 'live-generic-it-element-identity-contract/v1', found: matchState === 'active', item,
    matchState, matchCount: active.length + recycled.length + conflictIds.length + incompleteCount,
    activeCount: active.length, recycleBinCount: recycled.length + recycledGra.length,
    graState: identityState(graMatches), graMatchCount: graMatches.length,
    evidence: { pagesRead: search.pagesRead, observed: search.observed, total: search.total,
      uniqueActiveIds: active.slice(0, 10).map((value) => value.id), recycleIds: recycled.slice(0, 10).map((value) => value.id),
      conflictIds: conflictIds.slice(0, 10), incompleteCount } };
}

function optionalGuid(value) {
  const normalized = text(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(normalized)
    && normalized !== '00000000-0000-0000-0000-000000000000' ? normalized : '';
}
function deletedEntity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const trueLike = (item) => item === true || item === 1 || /^(true|1|yes)$/iu.test(text(item));
  if ([value.isDeleted, value.deleted, value.isInRecycleBin, value.inRecycleBin, value.isTrashed,
    value.trashed, value.isRemoved, value.removed].some(trueLike)) return true;
  if ([value.deletedAt, value.deletedOn, value.deletedDate, value.deletedDateTime, value.deletionDate,
    value.removedAt, value.trashedAt, value.recycledAt, value.recycleBinAt].some((item) => Boolean(text(item)))) return true;
  return [value.status, value.riskAssessmentStatus, value.lifecycleStatus, value.workItemStatus, value.state]
    .map((item) => normalizedLabel(item).replace(/[\s_-]+/gu, ''))
    .some((item) => ['deleted', 'softdeleted', 'recycled', 'recyclebin', 'trashed', 'intrash', 'removed'].includes(item));
}
function explicitArrayRows(value, label) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (!value || typeof value !== 'object') fail(`${label} must be an array or an allowed array envelope.`);
  const keys = ['$values','results','items','value'].filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (keys.length !== 1 || !Array.isArray(value[keys[0]])) fail(`${label} must contain exactly one allowed array envelope.`);
  return value[keys[0]];
}
function assessmentEntityCandidates(value, label, expectedObjectType, expectedInkContentId, expectedObjectId) {
  const canonicalType=normalizedObjectType(expectedObjectType); const expectedContent=text(expectedInkContentId);
  const expectedEntityId=guid(expectedObjectId,`${label} expected entityId`);
  if(!canonicalType||canonicalType!==text(expectedObjectType))fail(`${label} expected object type is not canonical.`);
  const direct = [value && value.entityId, value && value.itElementId, value && value.applicationId]
    .map(optionalGuid).filter(Boolean);
  const scoped = explicitArrayRows(value && value.riskScopes, `${label} riskScopes`)
    .filter((scope) => scope && typeof scope === 'object' && !Array.isArray(scope) && !deletedEntity(scope)
      && scope.isActive !== false && scope.active !== false)
    .filter((scope)=>{
      const scopeType=normalizedObjectType(scope.riskScopeType||scope.entityType||scope.type);
      if(scopeType!==canonicalType)return false;
      const scopeContent=text(scope.inkContentId||scope.contentId);
      return !scopeContent||(expectedContent&&scopeContent===expectedContent);
    })
    .map((scope) => optionalGuid(scope.entityId)).filter(Boolean);
  const exact = [...new Set([...direct, ...scoped])];
  if (exact.length > 1) fail(`${label} contains conflicting active IT Element entity GUIDs.`);
  if(exact.length===1&&exact[0]!==expectedEntityId)fail(`${label} entity GUID differs from the exact planned IT Element.`);
  return exact;
}
function payloadRows(value) { return Array.isArray(value) ? value : resultRows(value); }
function normalizedObjectType(value) {
  const normalized = normalizedLabel(value).replace(/[\s_-]+/gu, '');
  if (['application', '应用程序', '应用系统'].includes(normalized)) return 'Application';
  if (['infrastructure', '基础设施', 'database', 'operatingsystem', '数据库', '操作系统'].includes(normalized)) return 'Infrastructure';
  if (['ittool', 'tool', '工具', 'it工具'].includes(normalized)) return 'ITTool';
  return '';
}
function normalizeRait(value) {
  const normalized = normalizedLabel(value);
  if (normalized === 'higher' || normalized === '较高') return 'Higher';
  if (normalized === 'lower' || normalized === '较低') return 'Lower';
  return '';
}
function assessmentId(item, source) {
  return optionalGuid(source === 'work-item'
    ? item && (item.externalId || item.riskAssessmentId)
    : item && (item.id || item.riskAssessmentId));
}
function identityCandidates(item, objectType) {
  const values = [item && item.itElementName, item && item.itElementNumber, item && item.systemId,
    item && item.applicationName].map(text).filter(Boolean);
  if (objectType === 'Application') {
    const graName = text(item && (item.graName || item.name || item.displayName));
    if (/^(?:GRA|APP)[-_]+/iu.test(graName)) values.push(graName.replace(/^(?:GRA|APP)[-_]+/iu, '').trim());
  }
  return [...new Set(values.map((item) => normalizedLabel(item)).filter(Boolean))];
}
function applicationGraDirectory(workItemsPayload, commonAccountsPayload) {
  const workItems = payloadRows(workItemsPayload); const commonAccounts = payloadRows(commonAccountsPayload);
  const byId = new Map();
  const merge = (item, source) => {
    const id = assessmentId(item, source); if (!id) return;
    const current = byId.get(id) || { assessmentId: id, workItemId: '', objectId: '', identifiers: [], graName: '',
      workspaceId: '', objectType: '', rait: '', recycled: false, ambiguous: false, activeSeen: false, recycleSeen: false };
    const mergeExact=(key,value,normalize=(candidate)=>candidate)=>{
      if(!value)return;
      if(current[key]&&normalize(current[key])!==normalize(value))current.ambiguous=true;
      else current[key] ||= value;
    };
    current.workItemId ||= optionalGuid(source === 'work-item' ? item.id : item.workItemId);
    mergeExact('objectId',optionalGuid(item.entityId || item.itElementId || item.applicationId));
    mergeExact('graName',text(item.graName || item.name || item.displayName));
    mergeExact('workspaceId',optionalGuid(item.workspaceId || item.facetId));
    mergeExact('objectType',normalizedObjectType(item.riskAssessmentType || item.itElementType || item.entityType || item.type));
    current.rait ||= normalizeRait(item.itElementRaitConclusionLevelId || item.itElementRaitConclusionLevel
      || item.itElementRaitConclusionLevelName || item.lastSubmittedITElementRaitConclusionLevelId || item.raitConclusionLevel);
    current.identifiers = [...new Set([...current.identifiers, ...identityCandidates(item, current.objectType)])];
    const recycled = deletedEntity(item);
    current.recycleSeen ||= recycled; current.activeSeen ||= !recycled;
    current.recycled = current.recycleSeen && !current.activeSeen;
    if (current.recycleSeen && current.activeSeen) current.ambiguous = true;
    byId.set(id, current);
  };
  for (const item of workItems) merge(item, 'work-item');
  for (const item of commonAccounts) merge(item, 'common-account');
  return { rows: [...byId.values()], workItemCount: workItems.length, commonAccountCount: commonAccounts.length };
}
function applicationIdentityValue(item) {
  return [item && (item.number || item.referenceNumber || item.itElementNumber),
    item && (item.name || item.displayName || item.itElementName)].map((value) => normalizedLabel(value)).filter(Boolean);
}
async function searchApplicationIdentities(sdk, externalId) {
  const wanted = normalizedLabel(externalId); let observed = 0; let expectedTotal = null;
  const active = []; const recycled = []; const seenExact = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const body = pageBody(page, 500, 'number'); const payload = await sdk.invokeStep('application-search', {}, body);
    const current = resultRows(payload);
    for (const item of current) {
      if (!applicationIdentityValue(item).includes(wanted)) continue;
      const id = optionalGuid(item && (item.id || item.itElementId || item.applicationId));
      if (!id) fail('Authoritative Application search returned an exact identity without a canonical GUID.');
      const state = deletedEntity(item) ? 'recycle_bin' : 'active'; const key = `${state}|${id}`;
      if (seenExact.has(key)) fail('Authoritative Application search returned ambiguous exact identities across completed pages.');
      seenExact.add(key); (state === 'active' ? active : recycled).push(item);
    }
    if (active.length > 1) fail('Authoritative Application search returned ambiguous exact identities across completed pages.');
    observed += current.length;
    const total = Number(payload && payload.totalResults);
    if (Number.isFinite(total) && total >= 0) {
      if (expectedTotal === null) expectedTotal = total;
      else if (expectedTotal !== total) fail('Authoritative Application search total drifted across pages.');
      if (observed > total) fail('Authoritative Application search returned more rows than its reported total.');
      if ((!current.length || current.length < body.pageSize) && observed < total) {
        fail('Authoritative Application search terminated before its reported total was observed.');
      }
    }
    const complete = expectedTotal !== null ? observed === expectedTotal : (!current.length || current.length < body.pageSize);
    if (complete) return { active, recycled, pagesRead: page, observed, total: expectedTotal };
  }
  fail('Authoritative Application search exceeded the signed 20-page bound.');
}
function detailWorkspaceIds(value, indexed) {
  return [...new Set([
    optionalGuid(value && (value.workspaceId || value.workspaceFacetId || value.facetId)),
    ...rows(value && value.workspaceFacets).map((item) => optionalGuid(item && (item.id || item.workspaceId || item.facetId))),
    optionalGuid(indexed && (indexed.workspaceId || indexed.workspaceFacetId || indexed.facetId))
  ].filter(Boolean))];
}
function explicitlyHasNoGra(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owns = (key) => Object.prototype.hasOwnProperty.call(value, key);
  return owns('graName') && value.graName === null && owns('graContent') && value.graContent === null
    && owns('graStatus') && value.graStatus === 0 && owns('riskAssessments') && Array.isArray(value.riskAssessments)
    && value.riskAssessments.length === 0 && !optionalGuid(value.riskAssessmentId || value.graId)
    && !optionalGuid(value.riskAssessment && value.riskAssessment.id) && !optionalGuid(value.gra && value.gra.id);
}
function prunedApplication(item, detail, authority) {
  return {
    id: optionalGuid(detail && (detail.id || detail.itElementId || detail.applicationId))
      || optionalGuid(item && (item.id || item.itElementId || item.applicationId)),
    number: text(detail && (detail.number || detail.referenceNumber || detail.itElementNumber)
      || item && (item.number || item.referenceNumber || item.itElementNumber)),
    name: text(detail && (detail.name || detail.displayName || detail.itElementName)
      || item && (item.name || item.displayName || item.itElementName)),
    itElementType: normalizedObjectType(detail && (detail.itElementType || detail.entityType || detail.elementType || detail.type)
      || item && (item.itElementType || item.entityType || item.elementType || item.type)),
    workItemId: authority.workItemId,
    workspaceId: authority.workspaceId,
    riskAssessmentId: optionalGuid(detail && (detail.riskAssessmentId || detail.graId)
      || item && (item.riskAssessmentId || item.graId)),
    description: detail && Object.prototype.hasOwnProperty.call(detail, 'description') ? detail.description : null
  };
}
function identityState(matches) {
  if (!matches.length) return 'none';
  if (matches.some((item) => item.ambiguous)) return 'ambiguous';
  const states = [...new Set(matches.map((item) => item.recycled ? 'recycle_bin' : 'active'))];
  return matches.length === 1 && states.length === 1 ? states[0] : 'ambiguous';
}
async function resolveApplicationIdentity(request, sdk) {
  const frozen = target(request);
  const query = exact(request.query, ['objectType', 'externalId', 'workspaceId', 'graName', 'rait'], 'Application identity query');
  if (query.objectType !== 'Application') fail('Application identity resolution only supports Application.');
  const workspaceId = guid(query.workspaceId, 'query.workspaceId');
  if (workspaceId !== frozen.workspaceId) fail('Application identity query differs from the frozen target Workspace.');
  const externalId = text(query.externalId); const graName = text(query.graName); const expectedRait = normalizeRait(query.rait);
  if (!externalId || !graName || !expectedRait) fail('Application identity query is incomplete.');
  const [workItems, commonAccounts, search] = await Promise.all([
    sdk.invokeStep('workitem-directory', {}, { workItemIds: [], engagementIds: [guid(sdk.binding.engagementId, 'binding.engagementId')], workItemTypes: ['RiskFactorEvaluation'] }),
    sdk.invokeStep('gra-directory', {}, { riskAssessmentType: [] }),
    searchApplicationIdentities(sdk, externalId)
  ]);
  const directory = applicationGraDirectory(workItems, commonAccounts);
  const recycledIdentity = directory.rows.filter((item) => item.recycled && item.identifiers.includes(normalizedLabel(externalId)));
  const graNameMatches = directory.rows.filter((item) => normalizedLabel(item.graName) === normalizedLabel(graName));
  const recycledGraName = graNameMatches.filter((item) => item.recycled);
  const matchState = search.active.length ? 'active'
    : search.recycled.length + recycledIdentity.length > 1 ? 'ambiguous'
      : search.recycled.length + recycledIdentity.length === 1 ? 'recycle_bin' : 'none';
  const base = {
    source: 'live-app-identity-execution-contract/v1', engagementId: guid(sdk.binding.engagementId, 'binding.engagementId'),
    found: search.active.length === 1, item: null, matchState,
    matchCount: search.active.length || search.recycled.length + recycledIdentity.length,
    graState: identityState(graNameMatches), graMatchCount: graNameMatches.length,
    disposition: 'skip', reasonCode: 'active_pair_incompatible', resolved: null,
    evidence: { applicationPagesRead: search.pagesRead, applicationObserved: search.observed,
      applicationTotal: search.total, workItemCount: directory.workItemCount, commonAccountCount: directory.commonAccountCount }
  };
  if (!search.active.length) {
    if (matchState === 'none' && base.graState === 'none') return { ...base, disposition: 'create', reasonCode: 'not_found' };
    return { ...base, reasonCode: matchState === 'recycle_bin' ? 'identifier_recycle_bin'
      : matchState === 'ambiguous' || base.graState === 'ambiguous' ? 'identifier_ambiguous'
        : recycledGraName.length ? 'gra_in_recycle_bin' : 'active_pair_incompatible' };
  }
  const indexed = search.active[0]; const objectId = optionalGuid(indexed.id || indexed.itElementId || indexed.applicationId);
  const detail = await sdk.invokeStep('object-detail', { objectId });
  const authority = await assertObjectWorkspaceAuthority(sdk, 'object-identity-workspace', detail, workspaceId);
  const item = prunedApplication(indexed, detail, authority);
  const objectExact = item.id === objectId && normalizedLabel(item.name) === normalizedLabel(externalId)
    && normalizedLabel(item.number) === normalizedLabel(externalId) && item.itElementType === 'Application'
    && !deletedEntity(detail);
  const withItem = { ...base, item };
  if (!objectExact) return { ...withItem, reasonCode: 'active_pair_incompatible' };
  if (recycledGraName.length) return { ...withItem, reasonCode: 'gra_in_recycle_bin' };
  if (base.graState === 'ambiguous') return { ...withItem, reasonCode: 'identifier_ambiguous' };
  const indexedAssessmentId = optionalGuid(indexed.riskAssessmentId || indexed.graId);
  const activeGras = directory.rows.filter((value) => !value.recycled && value.assessmentId
    && (!indexedAssessmentId || value.assessmentId === indexedAssessmentId)
    && (!value.objectId || value.objectId === objectId)
    && (value.identifiers.includes(normalizedLabel(externalId)) || normalizedLabel(value.graName) === normalizedLabel(graName)));
  if (!activeGras.length && !indexedAssessmentId && explicitlyHasNoGra(detail) && base.graState === 'none') {
    return { ...withItem, disposition: 'resume', reasonCode: 'exact_element_without_gra',
      resolved: { objectId, riskAssessmentId: '', workItemId: authority.workItemId, workspaceId, graName, rait: expectedRait } };
  }
  if (activeGras.length !== 1) return { ...withItem, reasonCode: activeGras.length > 1 ? 'identifier_ambiguous' : 'active_pair_incompatible' };
  const gra = activeGras[0]; const graDetail = await sdk.invokeStep('gra-detail', { riskAssessmentId: gra.assessmentId });
  const actualRait = normalizeRait(graDetail.itElementRaitConclusionLevelId || graDetail.itElementRaitConclusionLevel
    || graDetail.itElementRaitConclusionLevelName || graDetail.lastSubmittedITElementRaitConclusionLevelId
    || graDetail.raitConclusionLevel);
  const graWorkspaceIds = detailWorkspaceIds(graDetail, gra); const detailEntityCandidates=assessmentEntityCandidates(graDetail,'Existing Application GRA','Application',graDetail.inkContentId||graDetail.contentId,objectId);
  const exactDirectoryFallback=!gra.ambiguous&&!gra.recycled&&gra.assessmentId===optionalGuid(graDetail.id||graDetail.riskAssessmentId)
    &&gra.objectId===objectId&&text(gra.graName)===graName&&gra.workspaceId===workspaceId&&gra.objectType==='Application';
  const graObjectId=detailEntityCandidates.length===1?detailEntityCandidates[0]:exactDirectoryFallback?gra.objectId:'';
  const graExact = optionalGuid(graDetail.id || graDetail.riskAssessmentId) === gra.assessmentId
    && graWorkspaceIds.length === 1 && graWorkspaceIds[0] === workspaceId && graObjectId === objectId
    && normalizedObjectType(graDetail.riskAssessmentType || graDetail.itElementType || graDetail.entityType || graDetail.type || gra.objectType) === 'Application'
    && normalizedLabel(graDetail.name || gra.graName) === normalizedLabel(graName)
    && !deletedEntity(graDetail);
  if (!graExact || (actualRait && actualRait !== expectedRait)) return { ...withItem, reasonCode: 'active_pair_incompatible' };
  return { ...withItem, disposition: 'reuse', reasonCode: actualRait ? 'exact_existing_pair' : 'exact_existing_incomplete_gra', resolved: {
    objectId, riskAssessmentId: gra.assessmentId, workItemId: authority.workItemId, workspaceId, graName, rait: expectedRait
  } };
}
async function applicationCreatePreflight(request, sdk) {
  if (request?.query?.objectType === 'Application') {
    const resolution = await resolveApplicationIdentity(request, sdk);
    if (resolution.disposition !== 'create') fail(`Application create preflight blocked: ${resolution.reasonCode}.`);
    return resolution;
  }
  const resolution = await objectPreflight(request, sdk);
  if (resolution.matchState !== 'none' || resolution.graState !== 'none') {
    fail(`IT Element create preflight blocked: object=${resolution.matchState}; GRA=${resolution.graState}.`);
  }
  return { ...resolution, disposition: 'create', reasonCode: 'not_found' };
}
async function relationshipObjectAuthority(sdk, detailStep, workspaceStep, objectId, expectedType, workspaceId, label) {
  const detail = await sdk.invokeStep(detailStep, { objectId });
  if (rowId(detail) !== objectId || deletedEntity(detail)
    || normalizedObjectType(detail.itElementType || detail.elementType || detail.entityType || detail.type) !== expectedType) {
    fail(`${label} identity/type mismatch.`);
  }
  const authority = await assertObjectWorkspaceAuthority(sdk, workspaceStep, detail, workspaceId);
  return { objectId, objectType: expectedType, workItemId: authority.workItemId, workspaceId: authority.workspaceId };
}
async function relationshipRead(request, sdk) {
  const query = exact(request.query, ['associationType', 'itElementId', 'associatingEntityId', 'workspaceId'], 'Relationship query');
  const itElementId = guid(query.itElementId, 'query.itElementId');
  const associatingId = guid(query.associatingEntityId, 'query.associatingEntityId');
  const workspaceId = guid(query.workspaceId, 'query.workspaceId');
  const targetType = query.associationType === 'InfrastructureApplication' || query.associationType === 'ItToolApplication' ? 'Application'
    : query.associationType === 'ItToolInfrastructure' ? 'Infrastructure' : '';
  const sourceType = query.associationType === 'InfrastructureApplication' ? 'Infrastructure'
    : targetType ? 'ITTool' : '';
  if (!sourceType || !targetType) fail('Unsupported signed relationship type.');
  const [sourceAuthority, targetAuthority] = await Promise.all([
    relationshipObjectAuthority(sdk, 'relation-source-detail', 'relation-source-workspace', itElementId, sourceType, workspaceId, 'Relationship source'),
    relationshipObjectAuthority(sdk, 'relation-target-detail', 'relation-target-workspace', associatingId, targetType, workspaceId, 'Relationship target')
  ]);
  if (query.associationType === 'InfrastructureApplication') {
    const fromInfrastructure = await boundedSearch(sdk, 'applications-search', (page) => pageBody(page, 500, 'number', { associatedWithInfrastructureId: itElementId }), (item) => rowId(item) === associatingId);
    const fromApplication = await boundedSearch(sdk, 'infrastructures-search', (page) => pageBody(page, 500, 'number', { associatedWithApplicationId: associatingId }), (item) => rowId(item) === itElementId);
    return { associated: fromInfrastructure.found && fromApplication.found, inconsistent: fromInfrastructure.found !== fromApplication.found, sourceAuthority, targetAuthority, fromInfrastructure, fromApplication };
  }
  const found = await boundedSearch(sdk, 'tool-relation-search', (page) => pageBody(page, 10, 'name', { associatedWithITToolId: itElementId, itElementType: targetType }), (item) => rowId(item) === associatingId);
  return { associated: found.found, inconsistent: false, sourceAuthority, targetAuthority, found };
}
function flattenObjects(value, output = []) {
  if (Array.isArray(value)) for (const item of value) flattenObjects(item, output);
  else if (value && typeof value === 'object') { output.push(value); for (const item of Object.values(value)) flattenObjects(item, output); }
  return output;
}
function normalizedLabel(value) { return text(value).normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN'); }
function uniqueExact(items, predicate, label) {
  const matches = flattenObjects(items).filter((item) => item && item.isDeleted !== true && predicate(item));
  if (matches.length !== 1) fail(`${label} is absent or ambiguous in the authoritative directory.`);
  return matches[0];
}
const CUSTOM_WORKSPACE_FACET_TYPE_ID = 'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0';
const CUSTOM_WORKSPACE_GROUP_FACET_TYPE_ID = '5420131f-8ea2-4c3f-938f-a25745240cd0';
function authorityFacetDirectory(payload, engagementId) {
  if (!Array.isArray(payload) || payload.length !== 1) fail('Facet authority must contain exactly the current Engagement directory.');
  const directory = payload[0];
  if (!directory || typeof directory !== 'object' || Array.isArray(directory)) fail('Facet authority directory is invalid.');
  if (guid(directory.engagementId, 'authority directory engagementId') !== engagementId) fail('Facet authority directory belongs to another Engagement.');
  if (!Array.isArray(directory.facets) || directory.facets.length > 2000) fail('Facet authority inventory is invalid or exceeds the signed bound.');
  const observedIds = new Set();
  const groups = new Map();
  const workspaceRows = [];
  for (const value of directory.facets) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Facet authority item is invalid.');
    if (guid(value.engagementId, 'Facet engagementId') !== engagementId) fail('Facet authority contains an item outside the current Engagement.');
    const facetTypeId = text(value.facetTypeId).toLowerCase();
    if (facetTypeId !== CUSTOM_WORKSPACE_GROUP_FACET_TYPE_ID && facetTypeId !== CUSTOM_WORKSPACE_FACET_TYPE_ID) continue;
    guid(facetTypeId, 'Workspace authority Facet facetTypeId');
    const facetId = guid(value.id, 'Facet id');
    if (observedIds.has(facetId)) fail(`Facet authority returned duplicate id ${facetId}.`);
    observedIds.add(facetId);
    if (value.isDeleted === true || value.deleted === true) continue;
    const name = text(value.name || value.value);
    if (!name) fail(`Workspace authority Facet ${facetId} has no name.`);
    if (facetTypeId === CUSTOM_WORKSPACE_GROUP_FACET_TYPE_ID) {
      groups.set(facetId, { id: facetId, name });
      continue;
    }
    workspaceRows.push({ id: facetId, name, parentSectionId: guid(value.parentId, `CustomWorkspace ${facetId} parentId`) });
  }
  if (workspaceRows.length < 1) fail('Facet authority did not return a verifiable CustomWorkspace.');
  const workspaces = workspaceRows.map((workspace) => {
    if (!groups.has(workspace.parentSectionId)) fail(`CustomWorkspace ${workspace.id} does not reference a live CustomWorkspaceGroup parentId.`);
    return workspace;
  });
  return { groups, workspaces };
}
const GRA_KIND_CONTRACT = Object.freeze({
  APP: Object.freeze({ objectType: 'Application', objectSubtype: 'Application', typeId: 3,
    categoryParent: 'Application type', categoryName: 'Application' }),
  DB: Object.freeze({ objectType: 'Infrastructure', objectSubtype: 'Database', typeId: 4,
    categoryParent: 'Infrastructure type', categoryName: 'Infrastructure_Database' }),
  OS: Object.freeze({ objectType: 'Infrastructure', objectSubtype: 'OperatingSystem', typeId: 4,
    categoryParent: 'Infrastructure type', categoryName: 'Infrastructure_Operating system' }),
  TOOL: Object.freeze({ objectType: 'ITTool', objectSubtype: 'Tool', typeId: 5,
    categoryParent: 'Tool type', categoryName: 'Tool' })
});
function catalogName(value) {
  return normalizedLabel(value).replace(/^(?:standardizedaccount|commonaccount)_/u, '');
}
function requestedContentAliases(elementKind, contentName) {
  const input = catalogName(contentName);
  const aliases = {
    APP: { generic: ['Generic', 'Generic Application'], 'sap ecc': ['SAP ECC'] },
    DB: { generic: ['Generic', 'Generic Database'], oracle: ['Oracle', 'Oracle Database'], sql: ['SQL', 'SQL Database'] },
    OS: { generic: ['Generic', 'Generic Operating System'], unix: ['UNIX', 'Unix'], win: ['WIN', 'Windows'] },
    TOOL: {
      generic: ['Generic', 'Generic Tool'],
      '工单工具': ['工单工具', 'Ticketing Tool'],
      '身份和访问管理工具': ['身份和访问管理工具', 'Identity & Access Management Tool']
    }
  }[elementKind] || {};
  return new Set((aliases[input] || [contentName]).map(catalogName));
}
function standardizedAccountItems(payload, engagementId) {
  if (!Array.isArray(payload) || payload.length !== 1) fail('GRA content authority must contain exactly one Standardized Accounts List publication.');
  const publication = payload[0];
  if (!publication || typeof publication !== 'object' || Array.isArray(publication)
    || guid(publication.engagementId, 'GRA content publication engagementId') !== engagementId
    || normalizedLabel(publication.typeName) !== normalizedLabel('Standardized Accounts List')
    || !Array.isArray(publication.items) || publication.items.length < 1 || publication.items.length > 2000) {
    fail('GRA content authority publication is invalid.');
  }
  return publication.items;
}
function contentCandidateNames(item) {
  const names = [item && item.name, item && item.description];
  for (const child of rows(item && item.subItems)) {
    if (normalizedLabel(child && child.parentListName) === normalizedLabel('Common Account Area')) names.push(child.name, child.description);
  }
  return new Set(names.map(catalogName).filter(Boolean));
}
function resolveGraContent(items, spec, engagementId) {
  const kindContract = GRA_KIND_CONTRACT[spec.elementKind];
  if (!kindContract || spec.objectType !== kindContract.objectType || spec.objectSubtype !== kindContract.objectSubtype) {
    fail(`GRA content ${spec.elementKind} object type/subtype contract drifted.`);
  }
  const aliases = requestedContentAliases(spec.elementKind, spec.contentName);
  const matches = items.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
    && item.isDeleted !== true
    && normalizedLabel(item.parentListName) === normalizedLabel('Standardized Accounts List')
    && [...contentCandidateNames(item)].some((name) => aliases.has(name)));
  if (matches.length !== 1) fail(`GRA content ${spec.elementKind}/${spec.contentName} is absent or ambiguous in the authoritative Standardized Accounts List.`);
  const item = matches[0];
  if (guid(item.engagementId, 'resolved GRA content engagementId') !== engagementId) fail('Resolved GRA content belongs to another Engagement.');
  const categories = rows(item.subItems).filter((candidate) => candidate && typeof candidate === 'object'
    && !Array.isArray(candidate) && candidate.isDeleted !== true
    && normalizedLabel(candidate.parentListName) === normalizedLabel(kindContract.categoryParent)
    && normalizedLabel(candidate.name) === normalizedLabel(kindContract.categoryName));
  if (categories.length !== 1) fail(`GRA content ${spec.elementKind}/${spec.contentName} has no unique live IT Element category.`);
  if (guid(categories[0].engagementId, 'resolved IT Element category engagementId') !== engagementId) fail('Resolved IT Element category belongs to another Engagement.');
  return {
    contentName: text(spec.contentName), objectType: spec.objectType, objectSubtype: spec.objectSubtype,
    elementKind: spec.elementKind, inkContentId: catalogId(item.key, 'resolved GRA content id'),
    typeId: kindContract.typeId, itElementTypeId: catalogId(categories[0].key, 'resolved IT Element type id')
  };
}
async function resolveAuthority(request, sdk) {
  const query = exact(request.query, ['workspaceNames', 'graContents'], 'Authority resolution query');
  if (!Array.isArray(query.workspaceNames) || query.workspaceNames.length < 1 || query.workspaceNames.length > 50
    || !Array.isArray(query.graContents) || query.graContents.length < 1 || query.graContents.length > 50) {
    fail('Authority resolution inventory is invalid.');
  }
  const engagementId = guid(sdk.binding.engagementId, 'binding.engagementId');
  const allowed = [...new Set(rows(request.allowedWorkspaceIds).map((value) => guid(value, 'allowedWorkspaceIds[]')))].sort();
  if (allowed.length < 1 || allowed.length !== rows(request.allowedWorkspaceIds).length) fail('Authority resolution safety scope is invalid.');
  const [hierarchy, facetPayload, graDirectory] = await Promise.all([
    sdk.invokeStep('authority-hierarchy'), sdk.invokeStep('authority-directory', { engagementId }),
    sdk.invokeStep('authority-gra-directory', { catalogType: 'Standardized Accounts List', releaseDate: 'null' })
  ]);
  if (hierarchy === null || hierarchy === undefined) fail('Pack hierarchy authority is unavailable.');
  const directory = authorityFacetDirectory(facetPayload, engagementId);
  const workspaceById = new Map(directory.workspaces.map((workspace) => [workspace.id, workspace]));
  if (allowed.some((workspaceId) => !workspaceById.has(workspaceId))) fail('Workspace safety scope is stale or outside the current CustomWorkspace authority directory.');
  const normalizedRequestedNames = query.workspaceNames.map((rawName) => normalizedLabel(rawName));
  if (normalizedRequestedNames.some((name) => !name) || new Set(normalizedRequestedNames).size !== normalizedRequestedNames.length) {
    fail('Workspace display-name requests are empty or ambiguous after normalization.');
  }
  const resolvedWorkspaces = query.workspaceNames.map((rawName) => {
    const name = text(rawName); if (!name) fail('Workspace display name is empty.');
    const matches = directory.workspaces.filter((candidate) => normalizedLabel(candidate.name) === normalizedLabel(name));
    if (matches.length !== 1) fail(`Workspace ${name} is absent or ambiguous in the CustomWorkspace Facet directory.`);
    const workspaceId = matches[0].id;
    if (!allowed.includes(workspaceId)) fail(`Resolved Workspace ${name} is outside the exact safety lock.`);
    return { name, workspaceId, parentSectionId: matches[0].parentSectionId };
  });
  const contentItems = standardizedAccountItems(graDirectory, engagementId);
  const resolvedGraContents = query.graContents.map((raw) => resolveGraContent(contentItems,
    exact(raw, ['contentName', 'elementKind', 'objectSubtype', 'objectType'], 'GRA content request'), engagementId));
  return { engagementId, workspaces: resolvedWorkspaces, graContents: resolvedGraContents };
}

function catalogEntryId(item, names, label) {
  for (const name of names) if (item && item[name]) return guid(item[name], label);
  fail(`${label} is absent.`);
}
function catalogRows(payload, property, label) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload[property])) return payload[property];
  fail(`${label} did not return its recorded v4 top-level collection.`);
}
function catalogNumber(item, names) {
  for (const name of names) { const value = text(item && item[name]); if (value) return value; }
  return '';
}
function catalogDisplayName(number, value) {
  const name = text(value);
  if (!number || normalizedLabel(name).startsWith(normalizedLabel(number))) return name;
  return `${number}｜${name}`;
}
function riskRiskScopeLookupId(item) {
  const direct = optionalGuid(item && item.riskRiskScopeId);
  if (direct) return direct;
  for (const value of rows(item && item.riskRiskScopeIds)) { const candidate = optionalGuid(value); if (candidate) return candidate; }
  for (const scope of rows(item && item.riskRiskScopes)) { const candidate = optionalGuid(scope && scope.id); if (candidate) return candidate; }
  fail('riskRiskScopeId is absent from the recorded v4 catalog shapes.');
}
function catalogAssertion(item) {
  const candidates = [item && item.assertion, item && item.assertionType, item && item.selectedAssertion,
    ...rows(item && item.assertions).map((value) => value && typeof value === 'object' ? value.assertion : value),
    ...rows(item && item.riskRiskScopes).flatMap((scope) => [scope && scope.selectedAssertion, scope && scope.assertionType,
      ...rows(scope && scope.assertions).map((value) => value && typeof value === 'object' ? value.assertion : value)])]
    .map(text).filter(Boolean);
  return candidates[0] || '';
}
async function riskControlCatalog(request, sdk) {
  target(request);
  const riskAssessmentId = guid(request.riskAssessmentId, 'riskAssessmentId');
  const [riskPayload, controlPayload] = await Promise.all([
    sdk.invokeStep('risk-catalog', { riskAssessmentId }), sdk.invokeStep('control-catalog', { riskAssessmentId })
  ]);
  const riskRows = catalogRows(riskPayload, 'plannedResponses', 'Risk catalog');
  const controlRows = catalogRows(controlPayload, 'controls', 'Control catalog');
  const risks = riskRows.filter((item) => item && (item.riskId || item.id)).map((item) => {
    const riskNumber = catalogNumber(item, ['riskNumber', 'inkRiskNumber']);
    return ({
    riskId: catalogEntryId(item, ['riskId', 'id'], 'riskId'),
    riskRiskScopeId: riskRiskScopeLookupId(item), riskNumber,
    name: catalogDisplayName(riskNumber, item.name || item.riskName || item.title || item.description),
    classification: text(item.classificationType || item.riskClassification || item.classification || item.classificationName),
    assertion: catalogAssertion(item),
    updatedOn: text(item.updatedOn || item.updatedAt)
  }); }).filter((item) => (item.riskNumber || item.name) && item.classification && item.assertion && item.updatedOn);
  const controls = controlRows.filter((item) => item && (item.controlId || item.id)).map((item) => {
    const controlNumber = catalogNumber(item, ['controlNumber']);
    return { controlId: catalogEntryId(item, ['controlId', 'id'], 'controlId'), controlNumber,
      name: catalogDisplayName(controlNumber, item.name || item.controlName || item.title || item.description) };
  }).filter((item) => item.controlNumber || item.name);
  return { riskAssessmentId, risks, controls, diagnostics: {
    riskRows: riskRows.length, acceptedRisks: risks.length, controlRows: controlRows.length, acceptedControls: controls.length,
    riskNumbers: risks.map((item) => item.riskNumber).filter(Boolean).sort(),
    controlNumbers: controls.map((item) => item.controlNumber).filter(Boolean).sort(),
    classifications: [...new Set(risks.map((item) => item.classification).filter(Boolean))].sort()
  } };
}
async function graPreflight(request, sdk) {
  const query = exact(request.query, ['entityId', 'itElementType', 'name', 'workspaceId'], 'GRA preflight query');
  const entityId = guid(query.entityId, 'query.entityId'); const workspaceId = guid(query.workspaceId, 'query.workspaceId');
  const payload = await sdk.invokeStep('gra-directory', {}, { riskAssessmentType: [] });
  const matches = flattenObjects(payload).filter((item) => {
    const id = text(item.entityId || item.itElementId).toLowerCase();
    const workspace = text(item.workspaceId || item.facetId).toLowerCase();
    return id === entityId && workspace === workspaceId && text(item.name) === text(query.name)
      && text(item.type || item.itElementType) === query.itElementType
      && item.isDeleted !== true;
  });
  if (matches.length > 1) fail('GRA preflight returned ambiguous exact identities.');
  return { found: matches.length === 1, item: matches[0] || null };
}
function riskFactors(payload) { return rows(payload && payload.riskFactors); }
function riskFactorByIdentity(payload, itemId) {
  const match = /^SAP_ECC\.RF\.DISPLAY_ORDER_(\d{2})$/u.exec(text(itemId));
  if (!match) fail('Risk Factor governance item identity is invalid.');
  const displayOrder = Number(match[1]);
  const matches = riskFactors(payload).filter((item) => Number(item.displayOrder ?? item.order ?? item.sequence) === displayOrder);
  if (matches.length !== 1) fail('Risk Factor identity is absent or ambiguous.');
  return matches[0];
}
function spectrumLevel(factor, selectionMode) {
  const spectrum = rows(factor.riskLevelSpectrum);
  const requestedValue = selectionMode === 'Higher'
    ? Math.max(...spectrum.map((item) => Number(item.value)).filter(Number.isFinite))
    : selectionMode === 'Lower' ? 1 : NaN;
  const matches = spectrum.filter((item) => Number(item.value) === requestedValue);
  if (matches.length !== 1) fail('Requested Risk Factor level is absent or ambiguous in the live spectrum.');
  return matches[0];
}
function assessmentWorkspace(result) { return rowWorkspace(result); }
function exactPatch(commandValue, expectedKind) {
  const value = command(commandValue, expectedKind);
  return value.payload;
}
function associationScopes(value, output = []) {
  if (Array.isArray(value)) for (const item of value) associationScopes(item, output);
  else if (value && typeof value === 'object') {
    if (value.riskId || value.riskScopeId || value.controlId || value.assertions) output.push(value);
    for (const item of Object.values(value)) associationScopes(item, output);
  }
  return output;
}
function hasRiskControl(detail, expected) {
  const assertion = text(expected.assertion);
  const matches = associationScopes(detail).filter((scope) => {
    const controlId = text(scope.controlId || scope.planResponseControlId || scope.control?.id).toLowerCase();
    const riskId = text(scope.riskId || scope.risk?.id).toLowerCase();
    const riskScopeId = text(scope.riskScopeId || scope.riskRiskScopeId || scope.id).toLowerCase();
    const assertions = rows(scope.assertions).map((item) => text(item.assertion || item.code || item)).filter(Boolean);
    return controlId === expected.controlId && riskId === expected.riskId && riskScopeId === expected.riskScopeId
      && assertions.length === 1 && assertions[0] === assertion;
  });
  return matches.length === 1;
}

function createOperationHandler() {
  return Object.freeze({
    run: async (operationId, request, sdk) => {
      if (operationId === 'omnia.create-associate.authority.resolve.v1') return resolveAuthority(request, sdk);
      if (operationId === 'omnia.create-associate.risk-control.catalog.v1') return riskControlCatalog(request, sdk);
      if (operationId === 'omnia.create-associate.object.preflight.v1') return objectPreflight(request, sdk);
      if (operationId === 'omnia.create-associate.object.identity.resolve.v1') return resolveApplicationIdentity(request, sdk);
      if (operationId === 'omnia.create-associate.object.create-preflight.v2') return applicationCreatePreflight(request, sdk);
      if (operationId === 'omnia.create-associate.object.create.v1') {
        const value = command(request, 'create_object'); const payload = value.payload;
        const common = ['name', 'workspaceId', 'engagementId', 'number', 'itElementType'];
        if (payload.itElementType === 'ITTool') {
          exact(payload, [...common, 'typeId'], 'Create IT Tool payload');
          if (payload.typeId !== 'Tool') fail('Create IT Tool typeId must match the recorded Tool contract.');
        }
        else if (payload.itElementType === 'Application') {
          exact(payload, [...common, 'description'], 'Create Application payload');
          if (typeof payload.description !== 'string') fail('Create Application description must be the recorded editor JSON string.');
          let editor; try { editor = JSON.parse(payload.description); } catch { fail('Create Application description editor JSON is invalid.'); }
          exact(editor, ['editorData', 'suggestionsData', 'trackChangesEnableFlagInEditor', 'plainText'], 'Create Application description editor');
          if (!Array.isArray(editor.suggestionsData) || editor.trackChangesEnableFlagInEditor !== false
            || typeof editor.editorData !== 'string' || typeof editor.plainText !== 'string') fail('Create Application description editor contract is invalid.');
        }
        else if (payload.itElementType === 'Infrastructure') {
          exact(payload, [...common, 'description', 'typeId'], 'Create Infrastructure payload');
          if (!['Database','OperatingSystem'].includes(payload.typeId)) fail('Create Infrastructure typeId must match the recorded DB/OS contract.');
        }
        else fail('Unsupported create object type.');
        assertScope(request, sdk, payload);
        return sdk.invokeStep('object-create', {}, payload);
      }
      if (operationId === 'omnia.create-associate.object.reconcile.v1') {
        const frozen = target(request); const objectId = guid(request.objectId, 'objectId');
        const query=request.query;
        exact(query,query?.objectType==='Application'?['externalId','objectType','description']:['externalId','objectType','subtypeId'],'Object read-back query');
        const result = await sdk.invokeStep('object-readback', { objectId });
        if (rowId(result) !== objectId || deletedEntity(result)||text(result.number||result.referenceNumber||result.name).normalize('NFC')!==text(query.externalId).normalize('NFC')
          || !text(result.itElementType||result.elementType||result.type)||text(result.itElementType||result.elementType||result.type)!==text(query.objectType)
          || (query.objectType!=='Application'&&text(result.typeId||result.itElementTypeId)!==text(query.subtypeId))) fail('Object read-back identity, type, subtype, external identity, or Workspace mismatch.');
        if(query.objectType==='Application'&&canonical(editorDescription(result.description,'Application read-back description'))!==canonical(editorDescription(query.description,'Frozen Application description'))) fail('Application description read-back differs from the frozen derived editor value.');
        const authority=await assertObjectWorkspaceAuthority(sdk,'object-readback-workspace',result,frozen.workspaceId);
        return {...result,...authority};
      }
      if (operationId === 'omnia.create-associate.object-settings.preflight.v1') {
        const frozen=target(request); const objectId=guid(request.objectId,'objectId');
        return readApplicationSettings(sdk,'object-settings-read','object-settings-workspace',objectId,frozen.workspaceId,'IT Element settings preflight');
      }
      if (operationId === 'omnia.create-associate.object-settings.patch.v1') {
        const value=exactPatch(request,'patch_object_settings');
        const payload=exact(value,['engagementId','workspaceId','objectId','typeId','isRelevant','isDataAvailable','mode'],'IT Element settings payload');
        assertScope(request,sdk,payload); const objectId=guid(payload.objectId,'payload.objectId');
        if(!text(payload.typeId)||payload.isRelevant!==false||typeof payload.isDataAvailable!=='boolean'||!['create_bootstrap','existing_with_token','recover_owned_create_bootstrap'].includes(payload.mode)) fail('IT Element settings do not match the frozen Application contract.');
        const before=await readApplicationSettings(sdk,'object-settings-mutation-read','object-settings-mutation-workspace',objectId,target(request).workspaceId,'IT Element settings mutation pre-read');
        const previousToken=settingsConcurrencyToken(before,payload.mode==='existing_with_token','IT Element settings mutation pre-read');
        if(['create_bootstrap','recover_owned_create_bootstrap'].includes(payload.mode)&&previousToken) fail('Application settings bootstrap is only allowed before a concurrency token exists.');
        if(payload.mode==='recover_owned_create_bootstrap'){
          const empty=(item)=>item===null||item===undefined||item==='';
          if(!empty(before.typeId)||!empty(before.isRelevant)||!empty(before.isDataAvailable)||!Array.isArray(before.concurrencyTabs)||before.concurrencyTabs.length!==0)fail('Owned-create Application settings recovery requires all settings and concurrency tabs to remain empty.');
        }
        const typePatch=[
          {op:'replace',path:'/typeId',value:payload.typeId},{op:'replace',path:'/isRelevant',value:false},
          {op:'replace',path:'/concurrencyTabId',value:501},
          ...(['create_bootstrap','recover_owned_create_bootstrap'].includes(payload.mode)?[{op:'replace',path:'/concurrencyTabUpdatedOn'}]:[{op:'replace',path:'/concurrencyTabUpdatedOn',value:previousToken}])
        ];
        await sdk.invokeStep('object-settings-type-patch',{objectId},typePatch);
        const afterType=await readApplicationSettings(sdk,'object-settings-mutation-read','object-settings-mutation-workspace',objectId,target(request).workspaceId,'IT Element settings type/relevance read-back');
        if(text(afterType.typeId)!==text(payload.typeId)||afterType.isRelevant!==false) fail('Application settings type/relevance read-back differs from the frozen plan.');
        const freshToken=settingsConcurrencyToken(afterType,true,'IT Element settings type/relevance read-back');
        if(previousToken&&freshToken===previousToken) fail('Application settings type/relevance PATCH did not produce a fresh concurrency token.');
        return sdk.invokeStep('object-settings-data-patch',{objectId},[
          {op:'replace',path:'/isDataAvailable',value:payload.isDataAvailable},{op:'replace',path:'/concurrencyTabId',value:501},
          {op:'replace',path:'/concurrencyTabUpdatedOn',value:freshToken}
        ]);
      }
      if (operationId === 'omnia.create-associate.object-settings.reconcile.v1') {
        const frozen=target(request); const query=exact(request.query,['objectId','typeId','isRelevant','isDataAvailable','number','mode'],'IT Element settings readback query');
        if(!['create_bootstrap','existing_with_token','recover_owned_create_bootstrap'].includes(query.mode))fail('IT Element settings readback mode is invalid.');
        const objectId=guid(query.objectId,'query.objectId'); const authoritativeResult=await readApplicationSettings(sdk,'object-settings-read','object-settings-workspace',objectId,frozen.workspaceId,'IT Element settings readback');
        const result=authoritativeResult;
        return {verified:text(result.number||result.referenceNumber)===text(query.number)&&text(result.typeId)===text(query.typeId)&&result.isRelevant===query.isRelevant&&result.isDataAvailable===query.isDataAvailable,result:authoritativeResult};
      }
      if (operationId === 'omnia.create-associate.relation.preflight.v1' || operationId === 'omnia.create-associate.relation.reconcile.v1') {
        return relationshipRead(request, sdk);
      }
      if (operationId === 'omnia.create-associate.relation.associate.v1') {
        const value = command(request, 'associate_relation');
        const payload = exact(value.payload, ['ItElementId', 'AssociatingEntityIds', 'associationType', 'ConcurrencyTabId', 'workspaceId', 'engagementId'], 'Associate relation payload');
        const frozen = assertScope(request, sdk, payload);
        const expectedTab = { InfrastructureApplication: 602, ItToolApplication: 802, ItToolInfrastructure: 803 }[payload.associationType];
        if (!expectedTab || Number(payload.ConcurrencyTabId) !== expectedTab || !Array.isArray(payload.AssociatingEntityIds)
          || payload.AssociatingEntityIds.length !== 1) fail('Relationship payload does not match the recorded Omnia contract.');
        guid(payload.ItElementId, 'payload.ItElementId'); guid(payload.AssociatingEntityIds[0], 'payload.AssociatingEntityIds[0]');
        const transportBody = {
          ItElementId: payload.ItElementId, AssociatingEntityIds: payload.AssociatingEntityIds,
          associationType: payload.associationType, ConcurrencyTabId: payload.ConcurrencyTabId
        };
        if (!frozen.targetIdentityKey) fail('Relationship target identity is empty.');
        return sdk.invokeStep('relation-associate', {}, transportBody);
      }
      if (operationId === 'omnia.create-associate.gra.preflight.v1') return graPreflight(request, sdk);
      if (operationId === 'omnia.create-associate.gra.create.v1') {
        const value = command(request, 'create_gra');
        const payload = exact(value.payload, ['inkContentId', 'typeId', 'facetId', 'entityId', 'name', 'engagementId'], 'Create GRA payload');
        assertScope(request, sdk, { engagementId: payload.engagementId, workspaceId: payload.facetId });
        guid(payload.entityId, 'payload.entityId'); catalogId(payload.inkContentId, 'payload.inkContentId'); catalogId(payload.typeId, 'payload.typeId');
        return sdk.invokeStep('gra-create', {}, {
          inkContentId: payload.inkContentId, typeId: payload.typeId, facetId: payload.facetId,
          entityId: payload.entityId, name: payload.name
        });
      }
      if (operationId === 'omnia.create-associate.gra.reconcile.v1') {
        const frozen = target(request); const riskAssessmentId = guid(request.riskAssessmentId, 'riskAssessmentId');
        const query=exact(request.query,['entityId','name','itElementType','inkContentId','typeId'],'GRA read-back query');
        const expectedEntityId=guid(query.entityId,'query.entityId');
        const kindContracts=Object.values(GRA_KIND_CONTRACT).filter((item)=>item.objectType===text(query.itElementType));
        const expectedTypeIds=[...new Set(kindContracts.map((item)=>String(item.typeId)))];
        if(!kindContracts.length||expectedTypeIds.length!==1||catalogId(query.typeId,'query.typeId')!==expectedTypeIds[0]) fail('GRA read-back query type does not match the governed APP/DB/OS/TOOL contract.');
        const result = await sdk.invokeStep('gra-readback', { riskAssessmentId });
        const detailEntityCandidates=assessmentEntityCandidates(result,'GRA read-back',query.itElementType,query.inkContentId,expectedEntityId);
        let observedEntityId=detailEntityCandidates[0]||'';
        if(!observedEntityId){
          const [workItems,commonAccounts]=await Promise.all([
            sdk.invokeStep('workitem-directory',{}, {workItemIds:[],engagementIds:[guid(sdk.binding.engagementId,'binding.engagementId')],workItemTypes:['RiskFactorEvaluation']}),
            sdk.invokeStep('gra-directory',{}, {riskAssessmentType:[]})
          ]);
          const directory=applicationGraDirectory(workItems,commonAccounts);
          const matches=directory.rows.filter((item)=>!item.ambiguous&&!item.recycled&&item.assessmentId===riskAssessmentId
            &&item.objectId===expectedEntityId&&text(item.graName)===text(query.name)&&item.workspaceId===frozen.workspaceId
            &&item.objectType===text(query.itElementType));
          if(matches.length!==1)fail('GRA read-back live directory has no unique exact assessment/entity/name/Workspace/type binding.');
          observedEntityId=matches[0].objectId;
        }
        if (guid(result.id || result.riskAssessmentId, 'GRA result id') !== riskAssessmentId
          || rowWorkspace(result) !== frozen.workspaceId||observedEntityId!==expectedEntityId
          || text(result.name)!==text(query.name)||text(result.type||result.itElementType||result.entityType)!==text(query.itElementType)
          || catalogId(result.inkContentId||result.contentId,'GRA inkContentId')!==catalogId(query.inkContentId,'query.inkContentId')) fail('GRA read-back content/entity/type/name/Workspace binding mismatch.');
        return result;
      }
      if (operationId === 'omnia.create-associate.gra-state.preflight.v1') {
        const frozen = target(request); const riskAssessmentId = guid(request.riskAssessmentId, 'riskAssessmentId');
        const result = await sdk.invokeStep('gra-state-read', { riskAssessmentId });
        if (guid(result.id || result.riskAssessmentId, 'GRA result id') !== riskAssessmentId || assessmentWorkspace(result) !== frozen.workspaceId) fail('GRA state preflight identity mismatch.');
        return result;
      }
      if (operationId === 'omnia.create-associate.gra-state.patch.v1') {
        const value = exactPatch(request, 'patch_gra_state');
        const payload = exact(value, ['engagementId', 'workspaceId', 'riskAssessmentId', 'patchKind', 'value'], 'GRA state payload');
        assertScope(request, sdk, payload); const riskAssessmentId = guid(payload.riskAssessmentId, 'payload.riskAssessmentId');
        const path = payload.patchKind === 'status' ? '/status' : payload.patchKind === 'rait' ? '/itElementRaitConclusionLevelId' : '';
        if (!path || !text(payload.value)) fail('Unsupported GRA state patch.');
        return sdk.invokeStep('gra-state-patch', { riskAssessmentId }, [{ op: 'replace', path, value: payload.value }]);
      }
      if (operationId === 'omnia.create-associate.gra-state.reconcile.v1') {
        const frozen = target(request); const query = exact(request.query, ['riskAssessmentId', 'patchKind', 'value'], 'GRA state readback query');
        const riskAssessmentId = guid(query.riskAssessmentId, 'query.riskAssessmentId');
        const result = await sdk.invokeStep('gra-state-read', { riskAssessmentId });
        if (assessmentWorkspace(result) !== frozen.workspaceId) fail('GRA state readback Workspace mismatch.');
        const observed = query.patchKind === 'status' ? result.status
          : result.itElementRaitConclusionLevelId || result.itElementRaitConclusionLevelName;
        return { verified: text(observed) === text(query.value), observed, riskAssessmentId };
      }
      if (operationId === 'omnia.create-associate.risk-factor.preflight.v1') {
        target(request); const query = exact(request.query, ['riskAssessmentId', 'itemId', 'selectionMode'], 'Risk Factor query');
        const riskAssessmentId = guid(query.riskAssessmentId, 'query.riskAssessmentId');
        const payload = await sdk.invokeStep('risk-factor-directory', { riskAssessmentId });
        const factor = riskFactorByIdentity(payload, query.itemId); const factorId = guid(factor.id, 'resolved factor.id');
        const selected = spectrumLevel(factor, query.selectionMode);
        return { itemId: query.itemId, factorId, applicable: factor.applicable !== false, current: factor.riskLevel, selected, spectrum: factor.riskLevelSpectrum };
      }
      if (operationId === 'omnia.create-associate.risk-factor.patch.v1') {
        const value = exactPatch(request, 'patch_risk_factor');
        const payload = exact(value, ['engagementId','workspaceId','riskAssessmentId','itemId','selectionMode','factorId','selectedValue','spectrumDigest'], 'Risk Factor payload');
        assertScope(request, sdk, payload); const riskAssessmentId = guid(payload.riskAssessmentId, 'payload.riskAssessmentId');
        const directory = await sdk.invokeStep('risk-factor-directory', { riskAssessmentId });
        const factor = riskFactorByIdentity(directory, payload.itemId);
        if (factor.applicable === false) fail('Risk Factor is not applicable and must not be written.');
        const factorId = guid(factor.id, 'resolved factor.id');
        const selected = spectrumLevel(factor, payload.selectionMode);
        if(factorId!==guid(payload.factorId,'payload.factorId')||Number(selected.value)!==Number(payload.selectedValue)||!/^[0-9a-f]{64}$/u.test(text(payload.spectrumDigest))) fail('Risk Factor live identity or selected spectrum value drifted after confirmation.');
        return sdk.invokeStep('risk-factor-patch', { factorId }, [{ op: 'replace', path: '/riskLevel', value: selected }]);
      }
      if (operationId === 'omnia.create-associate.risk-factor.reconcile.v1') {
        target(request); const query = exact(request.query, ['riskAssessmentId', 'itemId', 'selectionMode'], 'Risk Factor readback query');
        const riskAssessmentId = guid(query.riskAssessmentId, 'query.riskAssessmentId');
        const factor = riskFactorByIdentity(await sdk.invokeStep('risk-factor-directory', { riskAssessmentId }), query.itemId);
        const expected = spectrumLevel(factor, query.selectionMode);
        return { verified: factor.applicable !== false && Number(factor.riskLevel?.value ?? factor.riskLevel) === Number(expected.value), expected, factor };
      }
      if (operationId === 'omnia.create-associate.documentation.preflight.v1') {
        const frozen = target(request); const riskAssessmentId = guid(request.riskAssessmentId, 'riskAssessmentId');
        const result = await sdk.invokeStep('documentation-read', { riskAssessmentId });
        if (assessmentWorkspace(result) !== frozen.workspaceId) fail('Documentation preflight Workspace mismatch.');
        return { documentation: result.documentation || null, riskAssessmentId };
      }
      if (operationId === 'omnia.create-associate.documentation.patch.v1') {
        const value = exactPatch(request, 'patch_documentation');
        const payload = exact(value, ['engagementId', 'workspaceId', 'riskAssessmentId', 'editorData', 'plainText'], 'Documentation payload');
        assertScope(request, sdk, payload); const riskAssessmentId = guid(payload.riskAssessmentId, 'payload.riskAssessmentId');
        if (!text(payload.editorData) || !text(payload.plainText)) fail('Documentation text is empty.');
        return sdk.invokeStep('documentation-patch', { riskAssessmentId }, [{
          op: 'replace', path: '/documentation', value: {
            documentation: { editorData: payload.editorData, plainText: payload.plainText }, workItems: []
          }
        }]);
      }
      if (operationId === 'omnia.create-associate.documentation.reconcile.v1') {
        const frozen = target(request); const query = exact(request.query, ['riskAssessmentId', 'editorData', 'plainText'], 'Documentation readback query');
        const result = await sdk.invokeStep('documentation-read', { riskAssessmentId: guid(query.riskAssessmentId, 'query.riskAssessmentId') });
        if (assessmentWorkspace(result) !== frozen.workspaceId) fail('Documentation readback Workspace mismatch.');
        const observed = result.documentation?.documentation || result.documentation;
        return { verified: text(observed?.editorData) === text(query.editorData) && text(observed?.plainText) === text(query.plainText) && rows(result.documentation?.workItems).length === 0, observed };
      }
      if (operationId === 'omnia.create-associate.evaluation.preflight.v1') {
        const frozen = target(request); const riskAssessmentId = guid(request.riskAssessmentId, 'riskAssessmentId');
        const result = await sdk.invokeStep('evaluation-read', { riskAssessmentId });
        if (assessmentWorkspace(result) !== frozen.workspaceId) fail('Evaluation preflight Workspace mismatch.');
        return result;
      }
      if (operationId === 'omnia.create-associate.evaluation.submit.v1') {
        const value = exactPatch(request, 'submit_evaluation');
        const payload = exact(value, ['engagementId', 'workspaceId', 'riskAssessmentId'], 'Evaluation submit payload');
        assertScope(request, sdk, payload); const riskAssessmentId = guid(payload.riskAssessmentId, 'payload.riskAssessmentId');
        return sdk.invokeStep('evaluation-submit', { riskAssessmentId }, {
          riskLevelOverride: true, isPurgeControlHiddenData: false, updateQM: false, accountContents: []
        });
      }
      if (operationId === 'omnia.create-associate.evaluation.reconcile.v1') {
        const frozen = target(request); const riskAssessmentId = guid(request.riskAssessmentId, 'riskAssessmentId');
        const result = await sdk.invokeStep('evaluation-read', { riskAssessmentId });
        if (assessmentWorkspace(result) !== frozen.workspaceId) fail('Evaluation readback Workspace mismatch.');
        return { verified: result.status === 'EvaluationComplete', status: result.status, result };
      }
      if (operationId === 'omnia.create-associate.risk-control.preflight.v1') {
        target(request); const query = exact(request.query, ['riskId', 'riskClassification', 'controlId'], 'Risk-Control validation query');
        const riskId = guid(query.riskId, 'query.riskId'); const controlId = guid(query.controlId, 'query.controlId');
        const validation = await sdk.invokeStep('risk-control-validation', {
          riskId, riskClassification: text(query.riskClassification)
        }, { riskId, operation: 'AddAssociation', controlIds: [controlId] });
        if (!Array.isArray(validation) || validation.some((item) => !item || typeof item !== 'object' || typeof item.showPopup !== 'boolean')) {
          fail('Risk-Control hidden-data validation response is not an interpretable array.');
        }
        return { validation, requiresPurge: rows(validation).some((item) => item && item.showPopup === true) };
      }
      if (operationId === 'omnia.create-associate.risk-control.associate.v1') {
        const value = exactPatch(request, 'associate_risk_control');
        const payload = exact(value, ['engagementId','workspaceId','riskAssessmentId','riskName','controlName','riskClassification','riskId','updatedOn','isPurgeControlHiddenData','controlRiskScopes'], 'Risk-Control association payload');
        assertScope(request, sdk, payload); const riskId = guid(payload.riskId, 'payload.riskId');
        if (!Array.isArray(payload.controlRiskScopes) || payload.controlRiskScopes.length !== 1) fail('Risk-Control command must contain exactly one scope.');
        const scope = exact(payload.controlRiskScopes[0], ['controlId', 'riskScopeId', 'assertionType', 'riskId', 'assertions'], 'Risk-Control scope');
        if (guid(scope.riskId, 'scope.riskId') !== riskId || !Array.isArray(scope.assertions) || scope.assertions.length !== 1
          || text(scope.assertionType) !== text(scope.assertions[0]?.assertion)) fail('Risk-Control scope identity or assertion is invalid.');
        const controlId=guid(scope.controlId,'scope.controlId'); const riskScopeId=guid(scope.riskScopeId,'scope.riskScopeId');
        const catalog=await riskControlCatalog({target:request.target,riskAssessmentId:payload.riskAssessmentId},sdk);
        const riskNumber=text(payload.riskName).split(/[｜|]/u,1)[0]; const controlNumber=text(payload.controlName).split(/[｜|]/u,1)[0];
        const riskMatches=catalog.risks.filter((item)=>(item.riskNumber?normalizedLabel(item.riskNumber)===normalizedLabel(riskNumber):normalizedLabel(item.name)===normalizedLabel(payload.riskName))
          &&normalizedLabel(item.classification)===normalizedLabel(payload.riskClassification));
        const controlMatches=catalog.controls.filter((item)=>item.controlNumber?normalizedLabel(item.controlNumber)===normalizedLabel(controlNumber):normalizedLabel(item.name)===normalizedLabel(payload.controlName));
        if(riskMatches.length!==1||controlMatches.length!==1||riskMatches[0].riskId!==riskId||riskMatches[0].riskRiskScopeId!==riskScopeId
          ||riskMatches[0].assertion!==text(scope.assertionType)||controlMatches[0].controlId!==controlId||riskMatches[0].updatedOn!==text(payload.updatedOn)) fail('Risk-Control mutation identity differs from the signed live catalog and logical frozen intent.');
        return sdk.invokeStep('risk-control-associate', {}, {
          controlRiskScopes: payload.controlRiskScopes, riskId: payload.riskId,
          updatedOn: payload.updatedOn, isPurgeControlHiddenData: payload.isPurgeControlHiddenData
        });
      }
      if (operationId === 'omnia.create-associate.risk-control.reconcile.v1') {
        target(request); const query = exact(request.query, ['riskRiskScopeId', 'riskId', 'controlId', 'assertion'], 'Risk-Control readback query');
        const expected = { riskId: guid(query.riskId, 'query.riskId'), controlId: guid(query.controlId, 'query.controlId'), riskScopeId: guid(query.riskRiskScopeId, 'query.riskRiskScopeId'), assertion: text(query.assertion) };
        const detail = await sdk.invokeStep('risk-control-detail', { riskRiskScopeId: expected.riskScopeId });
        return { verified: hasRiskControl(detail, expected), detail };
      }
      fail(`Unsupported signed Operation: ${operationId}`);
    }
  });
}

module.exports = { createOperationHandler };
