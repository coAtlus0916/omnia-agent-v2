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
function text(value) { return String(value == null ? '' : value).trim(); }
function lower(value) { return text(value).toLowerCase(); }
function fail(message) { throw new Error(message); }
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
function assessmentAppId(value) {
  const scope = rows(value && value.riskScopes).find((item) => lower(item && item.riskScopeType) === 'application' && guid(item && item.entityId));
  return guid(value && (value.entityId || value.itElementId || value.applicationId) || scope && scope.entityId);
}
function currentTab(value, tabId) {
  const candidates = rows(value && value.concurrencyTabs)
    .filter((item) => Number(item && item.entityTabTypeId) === tabId)
    .map((item) => ({ entityTabTypeId: tabId, updatedOn: text(item && item.updatedOn) }))
    .filter((item) => item.updatedOn && Number.isFinite(Date.parse(item.updatedOn)));
  if (candidates.length !== 1) return null;
  return candidates[0];
}
function controlState(detail) {
  const controlId = guid(detail && (detail.id || detail.controlId));
  const workItemId = guid(detail && (detail.workItemId || detail.controlWorkItemId));
  const coreConcurrency = currentTab(detail, CONTROL_CORE_TAB_ID);
  const oeConcurrency = currentTab(detail, CONTROL_OE_TAB_ID);
  const operatingEffectivenessId = guid(detail && detail.controlOperatingEffectiveness && detail.controlOperatingEffectiveness.id);
  const opened = detail && detail.planningOperatingEffectivenessTesting === true;
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
    openVerified: opened && Boolean(operatingEffectivenessId) && Boolean(oeConcurrency),
    deleted: deleted(detail)
  };
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
function notFound(error) {
  return [error && error.status, error && error.statusCode, error && error.response && error.response.status].some((value) => Number(value) === 404)
    || ['NOT_FOUND', 'REMOTE.NOT_FOUND', 'CONNECTOR.NOT_FOUND'].includes(text(error && error.code).toUpperCase());
}
async function optionalStep(sdk, stepId, parameters) {
  try { return { present: true, value: await sdk.invokeStep(stepId, parameters) }; }
  catch (error) { if (notFound(error)) return { present: false, value: null }; throw error; }
}
async function readAppGraContext(sdk, request, prefixes = {}) {
  const riskAssessmentId = guid(request && request.riskAssessmentId);
  const expectedGraWorkItemId = guid(request && request.graWorkItemId);
  const expectedAppId = guid(request && request.appId);
  const expectedAppWorkItemId = guid(request && request.appWorkItemId);
  const expectedWorkspaceId = guid(request && request.workspaceId);
  if (!riskAssessmentId || !expectedGraWorkItemId || !expectedAppId || !expectedAppWorkItemId || !expectedWorkspaceId) {
    fail('APP GRA request lacks its immutable GRA/APP/Work Item/Workspace identity.');
  }
  const detail = exactObject(await sdk.invokeStep(prefixes.gra || 'gra-detail', { riskAssessmentId }), 'GRA detail');
  const actualGraId = guid(detail.id || detail.riskAssessmentId);
  const graWorkItemId = guid(detail.workItemId || detail.riskAssessmentWorkItemId);
  const graWorkspaceIds = detailWorkspaceIds(detail);
  const appId = assessmentAppId(detail);
  if (actualGraId !== riskAssessmentId || graWorkItemId !== expectedGraWorkItemId || appId !== expectedAppId
    || graWorkspaceIds.length !== 1 || graWorkspaceIds[0] !== expectedWorkspaceId || !applicationType(detail) || deleted(detail)) {
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
    riskAssessmentId, graWorkItemId, appId, appWorkItemId, workspaceId: expectedWorkspaceId,
    graName: text(detail.name || detail.displayName || detail.referenceNumber),
    graReferenceNumber: text(detail.referenceNumber),
    graStatus: text(detail.status), graUpdatedOn: text(detail.updatedOn || detail.updatedAt),
    appName: text(app.name || app.displayName || app.number), appNumber: text(app.number || app.referenceNumber)
  };
}
async function readControl(sdk, stepId, controlId, expectedWorkItemId = '') {
  const actualControlId = guid(controlId);
  if (!actualControlId) fail('Control identity is invalid.');
  const detailResult = await optionalStep(sdk, stepId, { controlId: actualControlId });
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
      const [workItems, commonAccounts] = await Promise.all([
        sdk.invokeStep('gra-workitem-index', {}, { workItemIds: [], engagementIds: [sdk.binding.engagementId], workItemTypes: ['RiskFactorEvaluation'] }),
        sdk.invokeStep('gra-common-account-index', {}, { riskAssessmentType: [] })
      ]);
      const allowed = new Set(requestedIds);
      const projected = await mapLimit(mergeAssessmentIndex(workItems, commonAccounts), 6, async (indexed) => {
        const detailResult = await optionalStep(sdk, 'directory-gra-detail', { riskAssessmentId: indexed.riskAssessmentId });
        if (!detailResult.present || deleted(detailResult.value)) return null;
        const detail = exactObject(detailResult.value, 'GRA detail');
        if (!applicationType({ ...indexed, ...detail })) return null;
        const riskAssessmentId = guid(detail.id || detail.riskAssessmentId);
        const graWorkItemId = guid(detail.workItemId || detail.riskAssessmentWorkItemId || indexed.workItemId);
        const mappedGra = detailWorkspaceIds(detail, indexed);
        const appId = assessmentAppId(detail);
        const workspaceId = mappedGra.length === 1 ? mappedGra[0] : '';
        if (riskAssessmentId !== indexed.riskAssessmentId || !graWorkItemId || !appId || !workspaceId || !allowed.has(workspaceId)) return null;
        const appResult = await optionalStep(sdk, 'directory-app-detail', { appId });
        if (!appResult.present) return null;
        const app = exactObject(appResult.value, 'APP detail');
        const appWorkItemId = guid(app.workItemId || app.applicationWorkItemId);
        if (guid(app.id || app.itElementId || app.applicationId) !== appId || !appWorkItemId || !applicationElementType(app) || deleted(app)) return null;
        const appMapping = workspaceIds(await sdk.invokeStep('directory-app-facet-mapping', { workItemId: appWorkItemId }));
        if (appMapping.length !== 1 || appMapping[0] !== workspaceId) return null;
        const graName = text(detail.name || detail.displayName || indexed.names && indexed.names[0] || indexed.referenceNumber);
        return {
          riskAssessmentId, graWorkItemId, appId, appWorkItemId, workspaceId,
          workspaceName: authorityById.get(workspaceId).name,
          graName, graReferenceNumber: text(detail.referenceNumber || indexed.referenceNumber),
          graStatus: text(detail.status || indexed.status), graUpdatedOn: text(detail.updatedOn || detail.updatedAt || indexed.updatedOn),
          appName: text(app.name || app.displayName || indexed.appName), appNumber: text(app.number || app.referenceNumber),
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
      return { ...context, controls: controls.sort((left, right) => left.controlId.localeCompare(right.controlId)) };
    }
    if (operationId === 'omnia.workpaper.control.preflight.v1') {
      const value = await readFrozenControlContext(sdk, request, { gra: 'preflight-gra-detail', app: 'preflight-app-detail', mapping: 'preflight-app-facet-mapping', control: 'preflight-control-detail' });
      if (value.absent) fail('Control is absent before opening its hidden Tab.');
      if (value.opened && !value.openVerified) fail('Control reports an enabled OE Tab without the OE entity and unique Tab 209 token.');
      if (!value.opened && !value.coreConcurrency) fail('Control core Tab 201 has no unique live concurrency token.');
      return value;
    }
    if (operationId === 'omnia.workpaper.control.open-hidden-tab.v1') {
      const payload = request && request.command && request.command.payload;
      const controlId = guid(payload && payload.controlId);
      const expectedControlId = guid(request && request.controlId);
      if (!controlId || controlId !== expectedControlId || payload.planningOperatingEffectivenessTesting !== true
        || Number(payload.concurrencyTabId) !== CONTROL_CORE_TAB_ID || !text(payload.concurrencyTabUpdatedOn)) {
        fail('Signed hidden-Tab command differs from its frozen Control identity or Tab 201 token.');
      }
      const live = await readFrozenControlContext(sdk, request, {
        gra: 'mutation-gra-detail', app: 'mutation-app-detail', mapping: 'mutation-app-facet-mapping', control: 'mutation-control-detail'
      });
      if (live.absent || live.opened || !live.coreConcurrency
        || live.coreConcurrency.updatedOn !== text(payload.concurrencyTabUpdatedOn)) {
        fail('Control identity, open state, or Tab 201 token changed immediately before the hidden-Tab PATCH.');
      }
      await sdk.invokeStep('open-hidden-tab', { controlId }, [
        { op: 'replace', path: '/planningOperatingEffectivenessTesting', value: true },
        { op: 'replace', path: '/concurrencyTabId', value: CONTROL_CORE_TAB_ID },
        { op: 'replace', path: '/concurrencyTabUpdatedOn', value: text(payload.concurrencyTabUpdatedOn) }
      ]);
      return { controlId, accepted: true, mutation: 'planningOperatingEffectivenessTesting=true' };
    }
    if (operationId === 'omnia.workpaper.control.reconcile.v1') {
      const value = await readFrozenControlContext(sdk, request, { gra: 'reconcile-gra-detail', app: 'reconcile-app-detail', mapping: 'reconcile-app-facet-mapping', control: 'reconcile-control-detail' });
      if (value.absent) return { ...value, outcome: 'contradiction' };
      if (value.openVerified) return { ...value, outcome: 'applied' };
      const frozenToken = text(request && request.baselineCoreUpdatedOn);
      if (!value.opened && value.coreConcurrency && value.coreConcurrency.updatedOn === frozenToken) return { ...value, outcome: 'not_applied' };
      return { ...value, outcome: 'pending' };
    }
    fail(`Unsupported signed Operation: ${operationId}`);
  } });
}

module.exports = Object.freeze({ createOperationHandler, CONTROL_CORE_TAB_ID, CONTROL_OE_TAB_ID });
