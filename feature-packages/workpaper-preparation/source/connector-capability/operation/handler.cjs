'use strict';

const CUSTOM_WORKSPACE = 'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0';
const CONTROL_CORE_TAB_ID = 201;
const CONTROL_OE_TAB_ID = 209;
const MAX_WORKSPACES = 500;
const MAX_GRAS = 500;
const MAX_CONTROLS = 500;

function rows(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of [...keys, 'items', 'data', 'results']) {
    if (Array.isArray(value && value[key])) return value[key];
  }
  return [];
}
function text(value) {
  const normalized = value == null ? '' : String(value);
  return normalized.trim();
}
function lower(value) { return text(value).normalize('NFKC').toLowerCase(); }
function fail(message) {
  const error = new Error(message);
  error.name = 'WorkpaperOperationError';
  throw error;
}
function guid(value) {
  const result = lower(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(result)
    && result !== '00000000-0000-0000-0000-000000000000' ? result : '';
}
function deleted(value) {
  return Boolean(value && (value.isDeleted === true || value.deleted === true || value.isInRecycleBin === true
    || ['deleted', 'softdeleted', 'recycled', 'recyclebin', 'trashed', 'removed'].includes(lower(value.status || value.state))));
}
function exactObject(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const candidates = rows(value);
  if (candidates.length === 1 && candidates[0] && typeof candidates[0] === 'object') return candidates[0];
  fail(`${label} did not return one object.`);
}
function workspaceIds(mapping) {
  return [...new Set(rows(mapping).map((item) => guid(item && (item.facetId || item.workspaceFacetId || item.workspaceId || item.id))).filter(Boolean))].sort();
}
function detailWorkspaceIds(value, indexed) {
  return [...new Set([
    guid(value && (value.workspaceId || value.workspaceFacetId || value.facetId)),
    ...rows(value && value.workspaceFacets).map((item) => guid(item && (item.id || item.workspaceId || item.facetId))),
    guid(indexed && (indexed.workspaceId || indexed.workspaceFacetId || indexed.facetId))
  ].filter(Boolean))].sort();
}
function applicationType(value) {
  const candidates = [value && value.type, value && value.riskAssessmentType, value && value.itElementType, value && value.elementType]
    .map(lower).filter(Boolean);
  return candidates.includes('application');
}
function applicationElementType(value) {
  const candidates = [value && value.itElementType, value && value.elementType, value && value.entityType, value && value.type]
    .map(lower).filter(Boolean);
  return candidates.includes('application');
}
function catalogId(value) {
  const result = text(value);
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(result) ? result : '';
}
function normalizedLabel(value) { return text(value).normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN'); }
function catalogName(value) { return normalizedLabel(value).replace(/^(?:standardizedaccount|commonaccount)_/u, ''); }
function contentCandidateNames(item) {
  const names = [item && item.name, item && item.description];
  for (const child of rows(item && item.subItems)) {
    if (normalizedLabel(child && child.parentListName) === normalizedLabel('Common Account Area')) {
      names.push(child.name, child.description);
    }
  }
  return new Set(names.map(catalogName).filter(Boolean));
}
function genericApplicationContentId(payload, engagementId) {
  if (!Array.isArray(payload) || payload.length !== 1) fail('Generic APP content authority is absent or ambiguous.');
  const publication = payload[0];
  if (!publication || typeof publication !== 'object' || Array.isArray(publication)
    || guid(publication.engagementId) !== guid(engagementId)
    || normalizedLabel(publication.typeName) !== normalizedLabel('Standardized Accounts List')
    || !Array.isArray(publication.items) || publication.items.length < 1 || publication.items.length > 2000) {
    fail('Generic APP content authority publication is invalid.');
  }
  const aliases = new Set(['Generic', 'Generic Application'].map(catalogName));
  const matches = publication.items.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
    && item.isDeleted !== true
    && guid(item.engagementId) === guid(engagementId)
    && normalizedLabel(item.parentListName) === normalizedLabel('Standardized Accounts List')
    && [...contentCandidateNames(item)].some((name) => aliases.has(name))
    && rows(item.subItems).filter((child) => child && typeof child === 'object' && !Array.isArray(child)
      && child.isDeleted !== true
      && guid(child.engagementId) === guid(engagementId)
      && normalizedLabel(child.parentListName) === normalizedLabel('Application type')
      && normalizedLabel(child.name) === normalizedLabel('Application')).length === 1);
  if (matches.length !== 1) fail('Generic APP content is absent or ambiguous in the authoritative Standardized Accounts List.');
  const result = catalogId(matches[0].key);
  if (!result) fail('Generic APP content lacks a canonical live catalog identity.');
  return result;
}
function graContentId(value) {
  const nested = value && value.graContent && typeof value.graContent === 'object' && !Array.isArray(value.graContent)
    ? value.graContent : null;
  const candidates = [...new Set([
    value && value.inkContentId, value && value.contentId, value && value.graContentId,
    nested && (nested.inkContentId || nested.contentId || nested.id || nested.key)
  ].map(catalogId).filter(Boolean))];
  return candidates.length === 1 ? candidates[0] : '';
}
function assessmentAppId(value) {
  const scope = rows(value && value.riskScopes).find((item) => lower(item && item.riskScopeType) === 'application' && guid(item && item.entityId));
  return guid(value && (value.entityId || value.itElementId || value.applicationId) || scope && scope.entityId);
}
function currentTab(value, tabId) {
  const rawCandidates = rows(value && value.concurrencyTabs)
    .filter((item) => Number(item && item.entityTabTypeId) === tabId);
  const candidates = rawCandidates
    .map((item) => ({ entityTabTypeId: tabId, updatedOn: text(item && item.updatedOn) }))
    .filter((item) => item.updatedOn && Number.isFinite(Date.parse(item.updatedOn)));
  if (rawCandidates.length === 1 && candidates.length === 1) return candidates[0];
  // Omnia also projects the currently active tab token on the Control root.
  // This is a real concurrency pair (tab id + token), unlike the Control's
  // ordinary updatedOn timestamp.  Prefer the unique concurrencyTabs row,
  // but accept the exact root pair when no row for this tab is present.
  const rootToken = text(value && value.concurrencyTabUpdatedOn);
  if (rawCandidates.length === 0 && Number(value && value.concurrencyTabId) === tabId
    && rootToken && Number.isFinite(Date.parse(rootToken))) {
    return { entityTabTypeId: tabId, updatedOn: rootToken };
  }
  return null;
}
function controlState(detail) {
  const controlId = guid(detail && (detail.id || detail.controlId));
  const workItemId = guid(detail && (detail.workItemId || detail.controlWorkItemId));
  const coreConcurrency = currentTab(detail, CONTROL_CORE_TAB_ID);
  const oeConcurrency = currentTab(detail, CONTROL_OE_TAB_ID);
  const operatingEffectivenessId = guid(detail && detail.controlOperatingEffectiveness && detail.controlOperatingEffectiveness.id);
  const opened = detail && detail.planningOperatingEffectivenessTesting === true;
  const planningCommonControlTesting = detail && typeof detail.planningCommonControlTesting === 'boolean'
    ? detail.planningCommonControlTesting : null;
  const usePreviousAuditEvidence = detail && typeof detail.usePreviousAuditEvidence === 'boolean'
    ? detail.usePreviousAuditEvidence : null;
  const priorEvidenceDeclined = usePreviousAuditEvidence === false;
  const priorEvidenceNotApplicable = usePreviousAuditEvidence === null
    && Array.isArray(detail && detail.controlPriorYearEvidenceWorkPapers)
    && detail.controlPriorYearEvidenceWorkPapers.length === 0;
  // The recorded workflow explicitly selects "do not use prior evidence"
  // even when the live evidence inventory is empty. Empty inventory is useful
  // diagnostic state, but it is not a substitute for the requested setting.
  const priorEvidenceComplete = priorEvidenceDeclined;
  const diagnosticValue = (value) => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.length <= 160 ? value : `[string:${value.length}]`;
    if (Array.isArray(value)) return { kind: 'array', length: value.length,
      itemKeys: [...new Set(value.slice(0, 5).flatMap((item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : []))].sort().slice(0, 32) };
    if (value && typeof value === 'object') return { kind: 'object', keys: Object.keys(value).sort().slice(0, 48) };
    return `[${typeof value}]`;
  };
  const diagnosticEntries = [
    ...Object.entries(detail || {}),
    ...Object.entries(detail && detail.controlOperatingEffectiveness || {})
      .map(([key, value]) => [`controlOperatingEffectiveness.${key}`, value])
  ].filter(([key]) => /previous|prior|audit|evidence/iu.test(key))
    .sort(([left], [right]) => left.localeCompare(right)).slice(0, 48);
  const priorEvidenceDiagnostics = Object.fromEntries(diagnosticEntries.map(([key, value]) => [key, diagnosticValue(value)]));
  const activeRiskScopeAssociations = rows(detail && detail.controlRiskScopes).filter((item) => !deleted(item)
    && item && item.enabled !== false
    && !['inactive', 'disabled'].includes(lower(item.entityStatus)));
  return {
    controlId,
    workItemId,
    controlNumber: text(detail && (detail.controlNumber || detail.number || detail.referenceNumber)),
    name: text(detail && (detail.name || detail.displayName)),
    updatedOn: text(detail && (detail.updatedOn || detail.updatedAt)),
    opened,
    coreConcurrency,
    oeConcurrency,
    operatingEffectivenessId,
    planningCommonControlTesting,
    usePreviousAuditEvidence,
    priorEvidenceDeclined,
    priorEvidenceNotApplicable,
    priorEvidenceComplete,
    priorEvidenceDiagnostics,
    // Omnia exposes master/suggested Controls from the risk-assessment
    // catalog even when they are not associated.  Such rows are readable,
    // but PATCH rejects them with "The control is unassociated".  A live,
    // enabled risk-scope relation is therefore part of the executable
    // Control identity, not an optional display attribute.
    associated: activeRiskScopeAssociations.length > 0,
    // The recorded Tab 209 PATCH deliberately removes
    // /concurrencyTabUpdatedOn. Omnia can therefore return an exact,
    // completed OE entity without a reusable Tab 209 timestamp. That is a
    // valid terminal read-back, not permission for another mutation. The
    // only write that needs a frozen timestamp remains the Tab 201 stage.
    openVerified: opened && planningCommonControlTesting === false && priorEvidenceComplete
      && Boolean(operatingEffectivenessId),
    deleted: deleted(detail)
  };
}

async function invokeMutationStep(sdk, diagnosticId, stepId, parameters, body) {
  try { return await sdk.invokeStep(stepId, parameters, body); }
  catch (error) {
    const message = text(error && error.message) || 'The Omnia endpoint rejected the request.';
    fail(`${diagnosticId}: ${message}`);
  }
}
function mergeAssessmentIndex(workItems, commonAccounts) {
  const workRows = rows(workItems); const accountRows = rows(commonAccounts);
  const deletedIds = new Set([
    ...workRows.filter(deleted).map((item) => guid(item && (item.externalId || item.riskAssessmentId))),
    ...accountRows.filter(deleted).map((item) => guid(item && (item.id || item.riskAssessmentId)))
  ].filter(Boolean));
  const byId = new Map();
  for (const item of workRows) {
    const riskAssessmentId = guid(item && (item.externalId || item.riskAssessmentId));
    if (!riskAssessmentId || deletedIds.has(riskAssessmentId) || deleted(item)) continue;
    byId.set(riskAssessmentId, {
      riskAssessmentId,
      workItemId: guid(item.id || item.workItemId),
      referenceNumber: text(item.referenceNumber),
      names: [...new Set([item.name, item.displayName].map(text).filter(Boolean))],
      type: text(item.riskAssessmentType || item.type),
      workspaceId: guid(item.workspaceId),
      appName: text(item.itElementName),
      status: text(item.status),
      updatedOn: text(item.updatedOn || item.updatedAt)
    });
  }
  for (const item of accountRows) {
    const riskAssessmentId = guid(item && (item.id || item.riskAssessmentId));
    if (!riskAssessmentId || deletedIds.has(riskAssessmentId) || deleted(item)) continue;
    const current = byId.get(riskAssessmentId) || { riskAssessmentId, workItemId: '', referenceNumber: '', names: [], type: '', workspaceId: '', appName: '', status: '', updatedOn: '' };
    current.workItemId ||= guid(item.workItemId);
    current.referenceNumber ||= text(item.referenceNumber || item.riskAssessmentReferenceNumber);
    current.names = [...new Set([...current.names, item.name, item.displayName].map(text).filter(Boolean))];
    current.type ||= text(item.riskAssessmentType || item.type);
    current.workspaceId ||= guid(item.workspaceId);
    current.appName ||= text(item.itElementName);
    current.status ||= text(item.status);
    current.updatedOn ||= text(item.updatedOn || item.updatedAt);
    byId.set(riskAssessmentId, current);
  }
  if (byId.size > MAX_GRAS) fail('APP GRA directory exceeds the signed 500 item bound.');
  return [...byId.values()].sort((left, right) => left.riskAssessmentId.localeCompare(right.riskAssessmentId));
}
function authoritativeWorkspaces(payload, engagementId) {
  const directory = rows(payload).find((item) => guid(item && item.engagementId) === guid(engagementId));
  const facets = rows(directory && directory.facets);
  if (facets.length > 5000 || facets.some((item) => guid(item && item.engagementId) !== guid(engagementId))) {
    fail('Workspace authority directory crossed the current Engagement or exceeded its bound.');
  }
  const result = facets.filter((item) => guid(item && item.facetTypeId) === CUSTOM_WORKSPACE && !deleted(item))
    .map((item) => ({ id: guid(item.id), name: text(item.name || item.value) })).filter((item) => item.id && item.name);
  if (!result.length || result.length > MAX_WORKSPACES || new Set(result.map((item) => item.id)).size !== result.length) {
    fail('Workspace authority directory is empty, duplicate, or exceeds its bound.');
  }
  return result;
}
async function mapLimit(values, concurrency, mapper) {
  const result = new Array(values.length); let cursor = 0;
  async function consume() { while (cursor < values.length) { const index = cursor; cursor += 1; result[index] = await mapper(values[index], index); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => consume()));
  return result;
}
function isMissingWorkpaperDetail(error) {
  const statuses = [error?.status, error?.statusCode, error?.response?.status].map(Number);
  if (statuses.includes(404)) return true;
  const missingCodes = new Set(['NOT_FOUND', 'REMOTE.NOT_FOUND', 'CONNECTOR.NOT_FOUND']);
  return missingCodes.has(text(error?.code).toUpperCase());
}
async function invokeOptionalWorkpaperStep(sdk, stepId, parameters) {
  try { return { present: true, value: await sdk.invokeStep(stepId, parameters) }; }
  catch (error) { if (isMissingWorkpaperDetail(error)) return { present: false, value: null }; throw error; }
}
async function readAppGraContext(sdk, request, prefixes = {}) {
  const riskAssessmentId = guid(request && request.riskAssessmentId);
  const expectedGraWorkItemId = guid(request && request.graWorkItemId);
  const expectedAppId = guid(request && request.appId);
  const expectedAppWorkItemId = guid(request && request.appWorkItemId);
  const expectedWorkspaceId = guid(request && request.workspaceId);
  const expectedGraContentId = catalogId(request && request.graContentId);
  if (!riskAssessmentId || !expectedGraWorkItemId || !expectedAppId || !expectedAppWorkItemId || !expectedWorkspaceId || !expectedGraContentId) {
    fail('APP GRA request lacks its immutable GRA/APP/Work Item/Workspace identity.');
  }
  const detail = exactObject(await sdk.invokeStep(prefixes.gra || 'gra-detail', { riskAssessmentId }), 'GRA detail');
  const actualGraId = guid(detail.id || detail.riskAssessmentId);
  const graWorkItemId = guid(detail.workItemId || detail.riskAssessmentWorkItemId);
  const graWorkspaceIds = detailWorkspaceIds(detail);
  const appId = assessmentAppId(detail);
  if (actualGraId !== riskAssessmentId || graWorkItemId !== expectedGraWorkItemId || appId !== expectedAppId
    || graWorkspaceIds.length !== 1 || graWorkspaceIds[0] !== expectedWorkspaceId || !applicationType(detail) || deleted(detail)
    || graContentId(detail) !== expectedGraContentId) {
    fail('APP GRA identity/type/Work Item/Workspace drifted.');
  }
  const app = exactObject(await sdk.invokeStep(prefixes.app || 'app-detail', { appId }), 'APP detail');
  const appWorkItemId = guid(app.workItemId || app.applicationWorkItemId);
  if (guid(app.id || app.itElementId || app.applicationId) !== appId || appWorkItemId !== expectedAppWorkItemId || !applicationElementType(app) || deleted(app)) {
    fail('APP identity/type/Work Item drifted.');
  }
  const mapping = await sdk.invokeStep(prefixes.mapping || 'app-facet-mapping', { workItemId: appWorkItemId });
  const mapped = workspaceIds(mapping);
  if (mapped.length !== 1 || mapped[0] !== expectedWorkspaceId) fail('APP Workspace mapping drifted.');
  return {
    riskAssessmentId, graWorkItemId, appId, appWorkItemId, workspaceId: expectedWorkspaceId, graContentId: expectedGraContentId,
    graName: text(detail.name || detail.displayName || detail.referenceNumber),
    graReferenceNumber: text(detail.referenceNumber),
    graStatus: text(detail.status), graUpdatedOn: text(detail.updatedOn || detail.updatedAt),
    appName: text(app.name || app.displayName || app.number), appNumber: text(app.number || app.referenceNumber),
    graContentName: 'Generic'
  };
}
async function readControl(sdk, stepId, controlId, expectedWorkItemId = '') {
  const actualControlId = guid(controlId);
  if (!actualControlId) fail('Control identity is invalid.');
  const detailResult = await invokeOptionalWorkpaperStep(sdk, stepId, { controlId: actualControlId });
  if (!detailResult.present) return { controlId: actualControlId, absent: true };
  const detail = exactObject(detailResult.value, 'Control detail');
  const state = controlState(detail);
  if (state.controlId !== actualControlId || state.deleted || (expectedWorkItemId && state.workItemId !== guid(expectedWorkItemId))) {
    fail('Control detail identity/Work Item changed or was deleted.');
  }
  if (!state.workItemId) fail('Control detail lacks an immutable Work Item identity.');
  return { ...state, absent: false };
}
async function readFrozenControlContext(sdk, request, prefixes = {}) {
  const context = await readAppGraContext(sdk, request, prefixes);
  const control = await readControl(sdk, prefixes.control || 'control-detail', request.controlId, request.controlWorkItemId);
  if (control.absent) return { ...context, ...control };
  return { ...context, ...control };
}

function phase2Snapshot(detail) {
  // Read-only Phase 2 field snapshot. Only identity + present scalar/editor
  // fields are projected; missing values remain empty so the generator never
  // invents evidence. Sub-entity ids are projected for later write-back.
  const procedures = rows(detail && (detail.gitcNonDetailedTestingProcedures || detail.nonDetailedTestingProcedures))
    .map((procedure) => ({ id: guid(procedure && procedure.id), phaseType: text(procedure && procedure.phaseType),
      documentProcedureResults: text(procedure && procedure.documentProcedureResults) }));
  const design = detail && detail.controlDesignEvaluation && typeof detail.controlDesignEvaluation === 'object'
    ? detail.controlDesignEvaluation : null;
  const riskScopes = rows(detail && detail.controlRiskScopes).map((scope) => {
    const detailRows = rows(scope && scope.controlRiskScopeDetails).map((item) => ({
      id: guid(item && item.id), appropriatenessAndCorrelation: text(item && item.appropriatenessAndCorrelation) }));
    return { id: guid(scope && scope.id), riskId: guid(scope && scope.riskId), details: detailRows };
  });
  const oe = detail && detail.controlOperatingEffectiveness && typeof detail.controlOperatingEffectiveness === 'object'
    ? detail.controlOperatingEffectiveness : null;
  return {
    controlId: guid(detail && (detail.id || detail.controlId)),
    workItemId: guid(detail && (detail.workItemId || detail.controlWorkItemId)),
    controlNumber: text(detail && (detail.controlNumber || detail.number || detail.referenceNumber)),
    name: text(detail && (detail.name || detail.displayName)),
    description: text(detail && detail.description),
    controlType: text(detail && detail.controlType),
    approach: text(detail && detail.approach),
    riskAssociationType: text(detail && detail.riskAssociationType),
    riskAssociationDescription: text(detail && detail.riskAssociationDescription),
    planningOperatingEffectivenessTesting: detail && detail.planningOperatingEffectivenessTesting === true,
    planningCommonControlTesting: detail && detail.planningCommonControlTesting === true,
    usePreviousAuditEvidence: typeof detail && detail.usePreviousAuditEvidence === 'boolean' ? detail.usePreviousAuditEvidence : null,
    designEvaluation: design ? {
      id: guid(design.id), competenceAndAuthorityDocumentation: text(design.competenceAndAuthorityDocumentation),
      frequencyAndConsistency: text(design.frequencyAndConsistency), levelOfAggregation: text(design.levelOfAggregation),
      criteriaForInvestigation: text(design.criteriaForInvestigation), dependentOnOtherControls: text(design.dependentOnOtherControls),
      designEffective: design.designEffective, properlyImplemented: design.properlyImplemented
    } : null,
    procedures,
    riskScopes,
    operatingEffectiveness: oe ? {
      id: guid(oe.id), procedureTiming: text(oe.procedureTiming), procedureTimingRationale: text(oe.procedureTimingRationale),
      frequencyOfPerformance: text(oe.frequencyOfPerformance), frequencyOfPerformanceExplanation: text(oe.frequencyOfPerformanceExplanation),
      useRecommendedSampleSize: oe.useRecommendedSampleSize, actualSampleSize: oe.actualSampleSize,
      actualSampleSizeRationale: text(oe.actualSampleSizeRationale), operatingEffectively: oe.operatingEffectively
    } : null
  };
}

function resolveWritebackPath(template, snapshot) {
  // Replace sub-entity placeholders with the exact live ids read from the
  // authoritative Control detail. Any placeholder that cannot be resolved to a
  // unique live id fails closed (never write to ':missing').
  const placeholders = {
    designEvaluationId: snapshot.designEvaluation && snapshot.designEvaluation.id,
    operatingEffectivenessId: snapshot.operatingEffectiveness && snapshot.operatingEffectiveness.id
  };
  let path = template;
  for (const [name, id] of Object.entries(placeholders)) {
    path = path.replaceAll(`{${name}}`, id || '');
  }
  if (/\{(procedureId|riskScopeId|riskScopeDetailId)\}/u.test(path)) {
    fail('Write-back path requires a procedure or risk-scope sub-entity id that is not directly resolvable.');
  }
  if (/\{[A-Za-z]+\}/u.test(path) || path.includes('//') || path === template && /\{[A-Za-z]+\}/u.test(template)) {
    fail('Write-back path contains an unresolved sub-entity identity.');
  }
  return path;
}
function procedureWritebackPath(template, snapshot, phaseType) {
  const procedure = (snapshot.procedures || []).find((item) => item.phaseType === phaseType);
  if (!procedure || !procedure.id) fail(`Write-back requires a unique ${phaseType} procedure id.`);
  return template.replaceAll('{procedureId}', procedure.id);
}
function riskScopeWritebackPath(template, snapshot) {
  const detail = (snapshot.riskScopes || []).flatMap((scope) => (scope.details || []).map((item) => ({ scopeId: scope.id, detailId: item.id })))[0];
  if (!detail || !detail.scopeId || !detail.detailId) fail('Write-back requires a unique risk-scope detail id.');
  return template.replaceAll('{riskScopeId}', detail.scopeId).replaceAll('{riskScopeDetailId}', detail.detailId);
}
function normalizeWritebackValue(value, valueKind) {
  if (valueKind === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) fail('Write-back number value is invalid.');
    return number;
  }
  if (valueKind === 'boolean') {
    if (value === true || value === false) return value;
    if (value === '是' || value === 'true' || value === '1') return true;
    if (value === '否' || value === 'false' || value === '0') return false;
    fail('Write-back boolean value is invalid.');
  }
  return text(value);
}
function extractSnapshotField(snapshot, template, phaseType) {
  // Map a writePath template back to the flattened phase2Snapshot field so the
  // write-back readback can compare the written value against the same semantic
  // field (phase2Snapshot uses `procedures`/`designEvaluation`/`riskScopes`,
  // not the raw Omnia entity names).
  if (template.startsWith('/controlDesignEvaluation/')) {
    const field = template.split('/').pop();
    return snapshot.designEvaluation ? snapshot.designEvaluation[field] : undefined;
  }
  if (template.startsWith('/gitcNonDetailedTestingProcedures/')) {
    const procedure = (snapshot.procedures || []).find((item) => item.phaseType === (phaseType || 'TestOfDesign'));
    return procedure ? procedure.documentProcedureResults : undefined;
  }
  if (template.startsWith('/controlRiskScopes/')) {
    const detail = (snapshot.riskScopes || []).flatMap((scope) => scope.details || [])[0];
    return detail ? detail.appropriatenessAndCorrelation : undefined;
  }
  if (template.startsWith('/controlOperatingEffectiveness/')) {
    const field = template.split('/').pop();
    return snapshot.operatingEffectiveness ? snapshot.operatingEffectiveness[field] : undefined;
  }
  const field = template.replace(/^\//u, '');
  return snapshot[field];
}
function valueSatisfied(snapshot, template, expected, valueKind, phaseType) {
  const current = extractSnapshotField(snapshot, template, phaseType);
  if (valueKind === 'number') return Number(current) === Number(expected);
  if (valueKind === 'boolean') return current === expected;
  return text(current) === text(expected);
}

function createOperationHandler() {
  return Object.freeze({ async run(operationId, request, sdk) {
    if (operationId === 'omnia.workpaper.directory.read.v1') {
      const requestedIds = rows(request && request.workspaceIds).map(guid);
      if (!requestedIds.length || requestedIds.some((value) => !value) || new Set(requestedIds).size !== requestedIds.length) {
        fail('APP GRA directory requires unique valid Workspace IDs.');
      }
      await sdk.invokeStep('pack-hierarchy');
      const authority = authoritativeWorkspaces(await sdk.invokeStep('authority-directory', { engagementId: sdk.binding.engagementId }), sdk.binding.engagementId);
      const authorityById = new Map(authority.map((item) => [item.id, item]));
      if (requestedIds.some((workspaceId) => !authorityById.has(workspaceId))) fail('Requested Workspace is absent from current authority.');
      const [workItems, commonAccounts, graContentAuthority] = await Promise.all([
        sdk.invokeStep('gra-workitem-index', {}, { workItemIds: [], engagementIds: [sdk.binding.engagementId], workItemTypes: ['RiskFactorEvaluation'] }),
        sdk.invokeStep('gra-common-account-index', {}, { riskAssessmentType: [] }),
        sdk.invokeStep('directory-gra-content-authority', { catalogType: 'Standardized Accounts List', releaseDate: 'null' })
      ]);
      const genericContentId = genericApplicationContentId(graContentAuthority, sdk.binding.engagementId);
      const allowed = new Set(requestedIds);
      const projected = await mapLimit(mergeAssessmentIndex(workItems, commonAccounts), 6, async (indexed) => {
        const detailResult = await invokeOptionalWorkpaperStep(sdk, 'directory-gra-detail', { riskAssessmentId: indexed.riskAssessmentId });
        if (!detailResult.present || deleted(detailResult.value)) return null;
        const detail = exactObject(detailResult.value, 'GRA detail');
        if (!applicationType({ ...indexed, ...detail })) return null;
        const riskAssessmentId = guid(detail.id || detail.riskAssessmentId);
        const graWorkItemId = guid(detail.workItemId || detail.riskAssessmentWorkItemId || indexed.workItemId);
        const mappedGra = detailWorkspaceIds(detail, indexed);
        const appId = assessmentAppId(detail);
        const contentId = graContentId(detail);
        const workspaceId = mappedGra.length === 1 ? mappedGra[0] : '';
        if (riskAssessmentId !== indexed.riskAssessmentId || !graWorkItemId || !appId || contentId !== genericContentId
          || !workspaceId || !allowed.has(workspaceId)) return null;
        const appResult = await invokeOptionalWorkpaperStep(sdk, 'directory-app-detail', { appId });
        if (!appResult.present) return null;
        const app = exactObject(appResult.value, 'APP detail');
        const appWorkItemId = guid(app.workItemId || app.applicationWorkItemId);
        if (guid(app.id || app.itElementId || app.applicationId) !== appId || !appWorkItemId || !applicationElementType(app) || deleted(app)) return null;
        const appMapping = workspaceIds(await sdk.invokeStep('directory-app-facet-mapping', { workItemId: appWorkItemId }));
        if (appMapping.length !== 1 || appMapping[0] !== workspaceId) return null;
        const graName = text(detail.name || detail.displayName || indexed.names && indexed.names[0] || indexed.referenceNumber);
        return {
          riskAssessmentId, graWorkItemId, appId, appWorkItemId, workspaceId, graContentId: genericContentId,
          workspaceName: authorityById.get(workspaceId).name,
          graName, graReferenceNumber: text(detail.referenceNumber || indexed.referenceNumber),
          graStatus: text(detail.status || indexed.status), graUpdatedOn: text(detail.updatedOn || detail.updatedAt || indexed.updatedOn),
          appName: text(app.name || app.displayName || indexed.appName), appNumber: text(app.number || app.referenceNumber),
          graContentName: 'Generic',
          selectable: true, disabledReason: ''
        };
      });
      const gras = projected.filter(Boolean);
      if (new Set(gras.map((item) => item.riskAssessmentId)).size !== gras.length) fail('APP GRA directory contains duplicate identities.');
      return {
        connectorId: sdk.binding.connectorId, sessionGeneration: sdk.binding.sessionGeneration,
        engagementId: sdk.binding.engagementId, authorityInstanceId: sdk.binding.authorityInstanceId,
        tenantOrOrgId: sdk.binding.tenantOrOrgId, packId: sdk.binding.packId,
        workspaces: requestedIds.map((workspaceId) => authorityById.get(workspaceId)), gras
      };
    }
    if (operationId === 'omnia.workpaper.controls.read.v1') {
      const context = await readAppGraContext(sdk, request, { gra: 'controls-gra-detail', app: 'controls-app-detail', mapping: 'controls-app-facet-mapping' });
      const payload = await sdk.invokeStep('control-catalog', { riskAssessmentId: context.riskAssessmentId });
      const indexed = rows(payload, ['controls']).filter((item) => !deleted(item));
      if (indexed.length > MAX_CONTROLS) fail('Control catalog exceeds the signed 500 item bound.');
      const controls = await mapLimit(indexed, 8, async (item) => {
        const controlId = guid(item && (item.id || item.controlId));
        const workItemId = guid(item && (item.workItemId || item.controlWorkItemId));
        if (!controlId) fail('Control catalog row lacks its immutable identity.');
        const result = await readControl(sdk, 'controls-control-detail', controlId, workItemId);
        if (result.absent) fail('Control disappeared while reading the selected GRA catalog.');
        return result;
      });
      if (new Set(controls.map((item) => item.controlId)).size !== controls.length) fail('Control catalog contains duplicate identities.');
      const associatedControls = controls.filter((item) => item.associated);
      return { ...context, controls: associatedControls.sort((left, right) => left.controlId.localeCompare(right.controlId)) };
    }
    if (operationId === 'omnia.workpaper.control.preflight.v1') {
      const value = await readFrozenControlContext(sdk, request, { gra: 'preflight-gra-detail', app: 'preflight-app-detail', mapping: 'preflight-app-facet-mapping', control: 'preflight-control-detail' });
      if (value.absent) fail('Control is absent before opening its hidden Tab.');
      if (!value.associated) fail('Control is no longer associated and cannot enter a hidden-Tab execution plan.');
      if (value.opened && !value.operatingEffectivenessId) {
        fail('Control reports an enabled OE Tab without its exact OE entity.');
      }
      return value;
    }
    if (operationId === 'omnia.workpaper.control.open-hidden-tab.v1') {
      const payload = request && request.command && request.command.payload;
      const controlId = guid(payload && payload.controlId);
      const expectedControlId = guid(request && request.controlId);
      if (!controlId || controlId !== expectedControlId || payload.planningOperatingEffectivenessTesting !== true
        || payload.planningCommonControlTesting !== false
        || payload.usePreviousAuditEvidence !== false
        || typeof payload.baselinePlanningCommonControlTesting !== 'boolean'
        || Number(payload.concurrencyTabId) !== CONTROL_CORE_TAB_ID) {
        fail('Signed hidden-Tab command differs from its frozen Control identity, desired hidden-Tab state, or Tab 201 token.');
      }
      let live = await readFrozenControlContext(sdk, request, {
        gra: 'mutation-gra-detail', app: 'mutation-app-detail', mapping: 'mutation-app-facet-mapping', control: 'mutation-control-detail'
      });
      if (live.absent) fail('Control disappeared immediately before the hidden-Tab update.');
      if (!live.associated) fail('Control is no longer associated; no hidden-Tab mutation was submitted.');
      if (live.openVerified) return { controlId, accepted: true, mutation: 'already_applied' };
      if (!live.opened) {
        if (live.planningCommonControlTesting !== payload.baselinePlanningCommonControlTesting
          || (live.coreConcurrency
            ? live.coreConcurrency.updatedOn !== text(payload.concurrencyTabUpdatedOn)
            : Boolean(text(payload.concurrencyTabUpdatedOn)))) {
          fail('Control identity, open state, or Tab 201 token changed immediately before the hidden-Tab PATCH.');
        }
        // The recording proves that a pristine Control has no Tab 201 row and
        // cannot accept the OE PATCH directly. Omnia first materializes Tab
        // 201 by temporarily enabling common-control testing with the
        // recorded no-token PATCH. Only the subsequent authoritative read may
        // supply the concurrency token for the OE PATCH.
        if (!live.coreConcurrency) {
          await invokeMutationStep(sdk, 'WORKPAPER.CORE_BOOTSTRAP_PATCH_FAILED', 'open-hidden-tab', { controlId }, [
            { op: 'replace', path: '/planningCommonControlTesting', value: true },
            { op: 'replace', path: '/concurrencyTabId', value: CONTROL_CORE_TAB_ID },
            { op: 'replace', path: '/concurrencyTabUpdatedOn' },
            { op: 'replace', path: '/isPurgeHiddenData', value: true }
          ]);
          live = await readControl(sdk, 'mutation-stage-one-readback', controlId, request.controlWorkItemId);
          if (live.absent || live.opened || live.planningCommonControlTesting !== true
            || !live.coreConcurrency || !text(live.coreConcurrency.updatedOn)) {
            fail('The recorded Tab 201 bootstrap did not produce an exact live concurrency token.');
          }
          await invokeMutationStep(sdk, 'WORKPAPER.COMMON_VALIDATE_FAILED', 'validate-hidden-data', { controlId }, [
            { op: 'replace', path: '/planningCommonControlTesting', value: false }
          ]);
        }
        await invokeMutationStep(sdk, 'WORKPAPER.OE_VALIDATE_FAILED', 'validate-hidden-data', { controlId }, [
          { op: 'replace', path: '/planningOperatingEffectivenessTesting', value: true },
          { op: 'replace', path: '/planningCommonControlTesting', value: false }
        ]);
        const liveCoreToken = text(live.coreConcurrency && live.coreConcurrency.updatedOn);
        if (!liveCoreToken) fail('The operating-effectiveness PATCH requires the authoritative Tab 201 token.');
        await invokeMutationStep(sdk, 'WORKPAPER.OE_PATCH_FAILED', 'open-hidden-tab', { controlId }, [
          { op: 'replace', path: '/planningOperatingEffectivenessTesting', value: true },
          { op: 'replace', path: '/planningCommonControlTesting', value: false },
          { op: 'replace', path: '/concurrencyTabId', value: CONTROL_CORE_TAB_ID },
          { op: 'replace', path: '/concurrencyTabUpdatedOn', value: liveCoreToken },
          { op: 'replace', path: '/isPurgeHiddenData', value: true }
        ]);
        live = await readControl(sdk, 'mutation-stage-one-readback', controlId, request.controlWorkItemId);
      }
      if (live.absent || !live.opened || !live.operatingEffectivenessId) {
        fail('The operating-effectiveness stage did not produce the exact OE entity.');
      }
      const resumeOperatingEffectivenessId = guid(payload && payload.resumeOperatingEffectivenessId);
      if (resumeOperatingEffectivenessId && resumeOperatingEffectivenessId !== live.operatingEffectivenessId) {
        fail('The frozen partial-state OE identity differs from the current Control.');
      }
      if (live.planningCommonControlTesting !== false) {
        if (!live.coreConcurrency || live.coreConcurrency.updatedOn !== text(payload.concurrencyTabUpdatedOn)) {
          fail('The partial Control no longer has its frozen Tab 201 token for the common-control repair.');
        }
        await invokeMutationStep(sdk, 'WORKPAPER.COMMON_VALIDATE_FAILED', 'validate-hidden-data', { controlId }, [
          { op: 'replace', path: '/planningCommonControlTesting', value: false }
        ]);
        await invokeMutationStep(sdk, 'WORKPAPER.COMMON_PATCH_FAILED', 'open-hidden-tab', { controlId }, [
          { op: 'replace', path: '/planningCommonControlTesting', value: false },
          { op: 'replace', path: '/concurrencyTabId', value: CONTROL_CORE_TAB_ID },
          { op: 'replace', path: '/concurrencyTabUpdatedOn', value: text(payload.concurrencyTabUpdatedOn) },
          { op: 'replace', path: '/isPurgeHiddenData', value: true }
        ]);
        live = await readControl(sdk, 'mutation-stage-one-readback', controlId, request.controlWorkItemId);
        if (live.absent || !live.opened || !live.operatingEffectivenessId
          || live.planningCommonControlTesting !== false) {
          fail('The common-control stage did not reach its exact recorded state.');
        }
      }
      if (live.openVerified) return { controlId, accepted: true, mutation: 'already_applied' };
      if (live.priorEvidenceDeclined) return { controlId, accepted: true, mutation: 'already_applied' };
      await invokeMutationStep(sdk, 'WORKPAPER.PRIOR_EVIDENCE_VALIDATE_FAILED', 'validate-hidden-data', { controlId }, [
        { op: 'replace', path: '/usePreviousAuditEvidence', value: false }
      ]);
      // The recording proves a fresh Control removes /concurrencyTabUpdatedOn
      // in the Tab 209 prior-evidence PATCH (the OE stage already consumed the
      // token). A stale partial Control, however, still carries a live Tab 209
      // token read back from the authoritative Control; writing without it is
      // rejected as "Tab level concurrency exception". Carry the exact live
      // token when present, and only fall back to the recorded no-token form
      // when the authoritative read-back reports no Tab 209 token.
      const liveOeToken = live.oeConcurrency && text(live.oeConcurrency.updatedOn);
      await invokeMutationStep(sdk, 'WORKPAPER.PRIOR_EVIDENCE_PATCH_FAILED', 'open-hidden-tab', { controlId }, [
        { op: 'replace', path: '/usePreviousAuditEvidence', value: false },
        { op: 'replace', path: '/concurrencyTabId', value: CONTROL_OE_TAB_ID },
        ...(liveOeToken
          ? [{ op: 'replace', path: '/concurrencyTabUpdatedOn', value: liveOeToken }]
          : [{ op: 'replace', path: '/concurrencyTabUpdatedOn' }]),
        { op: 'replace', path: '/isPurgeHiddenData', value: true }
      ]);
      return { controlId, accepted: true, mutation: 'planningOperatingEffectivenessTesting=true;planningCommonControlTesting=false;usePreviousAuditEvidence=false' };
    }
    if (operationId === 'omnia.workpaper.control.reconcile.v1') {
      const value = await readFrozenControlContext(sdk, request, { gra: 'reconcile-gra-detail', app: 'reconcile-app-detail', mapping: 'reconcile-app-facet-mapping', control: 'reconcile-control-detail' });
      if (value.absent) return { ...value, outcome: 'contradiction' };
      if (value.openVerified) return { ...value, outcome: 'applied' };
      if (value.opened && value.operatingEffectivenessId && !value.openVerified) {
        return { ...value, outcome: 'partial_applied' };
      }
      const frozenToken = text(request && request.baselineCoreUpdatedOn);
      const baselineCommon = request && request.baselinePlanningCommonControlTesting;
      if (!value.opened && typeof baselineCommon === 'boolean'
        && value.planningCommonControlTesting !== baselineCommon) return { ...value, outcome: 'partial_applied' };
      if (!value.opened && (!frozenToken || value.coreConcurrency && value.coreConcurrency.updatedOn === frozenToken)) {
        return { ...value, outcome: 'not_applied' };
      }
      return { ...value, outcome: 'pending' };
    }
    if (operationId === 'omnia.workpaper.phase2.snapshot.read.v1') {
      const context = await readAppGraContext(sdk, request, { gra: 'snapshot-gra-detail', app: 'snapshot-app-detail', mapping: 'snapshot-app-facet-mapping' });
      const detail = exactObject(await sdk.invokeStep('snapshot-control-detail', { controlId: guid(request.controlId) }), 'Control detail');
      const snapshot = phase2Snapshot(detail);
      if (snapshot.controlId !== guid(request.controlId) || (request.controlWorkItemId && snapshot.workItemId !== guid(request.controlWorkItemId))) {
        fail('Control snapshot identity/Work Item drifted.');
      }
      return { ...context, ...snapshot };
    }
    if (operationId === 'omnia.workpaper.phase2.writeback.v1') {
      const payload = request && request.command && request.command.payload;
      const controlId = guid(payload && payload.controlId);
      const expectedControlId = guid(request && request.controlId);
      const changes = Array.isArray(payload && payload.changes) ? payload.changes : [];
      if (!controlId || controlId !== expectedControlId || !changes.length || changes.length > 40) {
        fail('Write-back command identity or change list is invalid.');
      }
      const detail = exactObject(await sdk.invokeStep('writeback-control-detail', { controlId }), 'Control detail');
      const snapshot = phase2Snapshot(detail);
      if (snapshot.controlId !== controlId) fail('Write-back Control identity drifted.');
      const ledger = [];
      for (const change of changes) {
        const template = text(change && change.writePath);
        const valueKind = text(change && change.valueKind) || 'text';
        if (!template) fail('Write-back change lacks a signed field path.');
        const value = normalizeWritebackValue(change.value, valueKind);
        let path;
        if (template.includes('{procedureId}')) {
          path = procedureWritebackPath(template, snapshot, text(change.phaseType || 'TestOfDesign'));
        } else if (template.includes('{riskScopeId}')) {
          path = riskScopeWritebackPath(template, snapshot);
        } else {
          path = resolveWritebackPath(template, snapshot);
        }
        const tab = Number(change.concurrencyTab) === CONTROL_OE_TAB_ID ? CONTROL_OE_TAB_ID : CONTROL_CORE_TAB_ID;
        const token = currentTab(detail, tab);
        if (!token || !token.updatedOn) fail('Write-back lacks the authoritative concurrency token for its stage.');
        const operations = [
          { op: 'replace', path, value },
          { op: 'replace', path: '/concurrencyTabId', value: tab },
          { op: 'replace', path: '/concurrencyTabUpdatedOn', value: token.updatedOn },
          { op: 'replace', path: '/isPurgeHiddenData', value: true }
        ];
        await invokeMutationStep(sdk, 'WORKPAPER.WRITEBACK_PATCH_FAILED', 'writeback-patch', { controlId }, operations);
        const readback = exactObject(await sdk.invokeStep('writeback-readback', { controlId }), 'Control detail');
        const after = phase2Snapshot(readback);
        ledger.push({ path, valueKind, confirmed: valueSatisfied(after, template, value, valueKind, text(change.phaseType || 'TestOfDesign')) });
      }
      return { controlId, accepted: true, ledger };
    }
    fail(`Unsupported signed Operation: ${operationId}`);
  } });
}

module.exports = Object.freeze({ createOperationHandler, CONTROL_CORE_TAB_ID, CONTROL_OE_TAB_ID });
