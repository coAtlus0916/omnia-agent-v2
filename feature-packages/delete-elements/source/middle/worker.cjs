'use strict';

const crypto = require('node:crypto');
const { createPythonSidecarBridge } = require('./python-bridge.cjs');

const FEATURE_ID = 'omnia.delete-elements';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const OPERATIONS = Object.freeze({
  scopeRead: 'omnia.delete.scope.read.v1',
  catalogRead: 'omnia.delete.catalog.heavy-read.v1',
  information: Object.freeze({ preflight: 'omnia.delete.information.preflight.v1', direct: 'omnia.delete.information.direct.v1', reconcile: 'omnia.delete.information.reconcile.v1' }),
  itElement: Object.freeze({ preflight: 'omnia.delete.it-element.preflight.v1', direct: 'omnia.delete.it-element.direct.v1', reconcile: 'omnia.delete.it-element.reconcile.v1' }),
  gra: Object.freeze({ preflight: 'omnia.delete.gra.preflight.v1', direct: 'omnia.delete.gra.direct.v1', reconcile: 'omnia.delete.gra.reconcile.v1' }),
  relations: Object.freeze({
    InfrastructureApplication: Object.freeze({ preflight: 'omnia.delete.infrastructure-application.preflight.v1', direct: 'omnia.delete.infrastructure-application.disassociate.v1', reconcile: 'omnia.delete.infrastructure-application.reconcile.v1' }),
    ItToolApplication: Object.freeze({ preflight: 'omnia.delete.it-tool-application.preflight.v1', direct: 'omnia.delete.it-tool-application.disassociate.v1', reconcile: 'omnia.delete.it-tool-application.reconcile.v1' })
  })
});
const CATALOG_TYPES = Object.freeze(['Information', 'GRA', 'APP', 'DB', 'OS', 'DCNO', 'TOOL']);
const MUTATION_TYPES = Object.freeze(['Information', 'GRA', 'APP', 'DB', 'OS', 'DCNO', 'TOOL']);
const INTERACTIVE_CATALOG_TIMEOUT_MS = 90_000;
const PLAN_PREFLIGHT_CONCURRENCY = 8;
const PLAN_PREPARATION_BATCH_SIZE = 8;
const TYPE_DISABLED_REASONS = Object.freeze({});
const UNSUPPORTED = Object.freeze([['Workpaper', 'Workpaper'], ['Control', 'Control'], ['Document', '文档'], ['Deficiency', 'Deficiency']]);

function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Non-JSON value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function requiredText(value, label) { const result = String(value == null ? '' : value).trim(); if (!result || result.length > 500) fail('DELETE.INVALID_INPUT', `${label} is invalid.`); return result; }
function optionalText(value, label) { const result = String(value == null ? '' : value).trim(); if (result.length > 500) fail('DELETE.INVALID_INPUT', `${label} is invalid.`); return result; }
function uniqueSorted(values) { return [...new Set((values || []).map(String).filter(Boolean))].sort(); }
async function mapLimitOrdered(values, concurrency, mapper) {
  const result = new Array(values.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor; cursor += 1; result[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers); return result;
}
async function settlePreparationBatch(values, mapper) {
  if (values.length > PLAN_PREPARATION_BATCH_SIZE) fail('DELETE.PREPARATION_BATCH_INVALID', 'Preparation batch exceeds the signed read-only bound.');
  const settled = await Promise.allSettled(values.map((value, index) => mapper(value, index)));
  const failedIndex = settled.findIndex((result) => result.status === 'rejected');
  if (failedIndex >= 0) throw settled[failedIndex].reason;
  return settled.map((result) => result.value);
}
function binding(value) {
  if (!value || typeof value !== 'object') fail('DELETE.BINDING_REQUIRED', 'Connector binding is required.');
  const result = { connectorId: requiredText(value.connectorId, 'connectorId'), sessionGeneration: Number(value.sessionGeneration),
    engagementId: requiredText(value.engagementId, 'engagementId'), authorityInstanceId: requiredText(value.authorityInstanceId, 'authorityInstanceId'),
    tenantOrOrgId: optionalText(value.tenantOrOrgId, 'tenantOrOrgId'), packId: requiredText(value.packId, 'packId') };
  if (!Number.isSafeInteger(result.sessionGeneration) || result.sessionGeneration < 1) fail('DELETE.BINDING_INVALID', 'Session generation is invalid.');
  return Object.freeze(result);
}
function safety(value, engagementId) {
  if (!value || value.enabled !== true || value.validForCurrentConnection !== true) fail('DELETE.SAFETY_REQUIRED', String(value && value.invalidReason || 'An enabled current safety lock is required.'));
  if (value.engagementId !== engagementId || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1) fail('DELETE.SAFETY_DRIFT', 'Safety lock binding is invalid.');
  const workspaceIds = uniqueSorted(value.workspaceIds); const globalSectionIds = uniqueSorted(value.globalSectionIds);
  const globalWorkspaceIds = value.globalEnabled === true ? uniqueSorted(value.globalWorkspaceIds) : [];
  if (!workspaceIds.length || (value.globalEnabled === true && (!globalSectionIds.length || !globalWorkspaceIds.length))) fail('DELETE.SAFETY_EMPTY', 'Safety lock has no frozen authoritative scope.');
  return Object.freeze({ enabled: true, globalEnabled: value.globalEnabled === true, globalSectionIds, globalWorkspaceIds,
    connectorId: requiredText(value.connectorId, 'safety.connectorId'), sessionGeneration: Number(value.sessionGeneration),
    authorityInstanceId: requiredText(value.authorityInstanceId, 'safety.authorityInstanceId'), tenantOrOrgId: optionalText(value.tenantOrOrgId, 'safety.tenantOrOrgId'),
    packId: requiredText(value.packId, 'safety.packId'), engagementId, stateVersion: value.stateVersion,
    authorityObservationId: requiredText(value.authorityObservationId, 'authorityObservationId'), workspaceIds,
    allowedWorkspaceIds: uniqueSorted([...workspaceIds, ...globalWorkspaceIds]) });
}
function assertSameAuthority(current, frozen) {
  for (const key of ['connectorId', 'sessionGeneration', 'authorityInstanceId', 'tenantOrOrgId', 'packId', 'engagementId']) {
    if (String(current[key]) !== String(frozen[key])) fail('DELETE.SAFETY_BINDING_DRIFT', `Safety lock ${key} differs from the current Connector binding.`);
  }
}
function relationKey(type, sourceObjectId, targetObjectId) { return `${type}|${sourceObjectId}|${targetObjectId}`; }
function targetKey(value) { return `${value.objectType}|${value.workspace}|${value.objectId}`; }
function errorSummary(error) {
  return { code: String(error && error.code || 'DELETE.STEP_FAILED').slice(0, 160), message: String(error && error.message || error || 'Delete step failed.').slice(0, 800) };
}
function catalogFailureMessage(failure) {
  if (failure.code === 'DELETE.CATALOG_TIMEOUT') return '真实权威目录读取超过 90 秒，已停止界面等待。请确认 Connector 与 Pack 页面在线后点击“权威重抓取”；系统不会展示旧目录或假数据。';
  if (failure.code === 'DELETE.CATALOG_BUSY') return '上一轮真实权威目录读取仍在收尾，未启动第二轮并发读取。请稍后点击“权威重抓取”。';
  return `${failure.code}: ${failure.message}`;
}
function frozenSafetyMatches(current, frozen) {
  if (!current || !frozen || Number(current.stateVersion) !== Number(frozen.stateVersion)
    || String(current.authorityObservationId) !== String(frozen.authorityObservationId)) return false;
  for (const key of ['workspaceIds', 'globalSectionIds', 'globalWorkspaceIds', 'allowedWorkspaceIds']) {
    if (canonical(uniqueSorted(current[key])) !== canonical(uniqueSorted(frozen[key]))) return false;
  }
  return true;
}
function finalCatalogVerification(plan, catalogEntries, capturedAt = new Date().toISOString()) {
  if (!plan || !Array.isArray(plan.steps) || !Array.isArray(plan.outcomes) || !Array.isArray(catalogEntries)) {
    fail('DELETE.FINAL_CATALOG_INVALID', 'Final authoritative catalog verification input is invalid.');
  }
  const steps = new Map(plan.steps.map((step) => [step.key, step]));
  const expectedDeleted = plan.outcomes.filter((outcome) => outcome.state === 'succeeded').map((outcome) => steps.get(outcome.stepId))
    .filter((step) => step && (step.kind === 'object' || (step.kind === 'cascade' && step.objectType === 'GRA')))
    .map((step) => `${step.objectType}|${step.objectId}`).sort();
  const present = new Set(catalogEntries.map((entry) => requiredText(entry && entry.identity, 'catalog.identity')));
  const stillPresent = expectedDeleted.filter((identity) => present.has(identity));
  if (stillPresent.length) {
    fail('DELETE.FINAL_CATALOG_CONTRADICTION', `Final authoritative catalog still contains verified-deleted target(s): ${stillPresent.join(', ')}`);
  }
  return { schemaVersion: 'omnia.delete-final-catalog-verification/v1', state: 'verified', capturedAt: requiredText(capturedAt, 'capturedAt'),
    expectedDeletedTargetIds: expectedDeleted, verifiedAbsentTargetIds: expectedDeleted,
    catalogItemCount: catalogEntries.length, catalogDigest: digest(catalogEntries.map((entry) => entry.raw)) };
}

function createFeatureWorker(ports) {
  const connector = ports && ports.connector; const store = ports && ports.store; const events = ports && ports.events;
  if (!connector || typeof connector.invoke !== 'function' || !store || typeof store.call !== 'function' || !events || typeof events.emit !== 'function') {
    fail('DELETE.PORTS_INVALID', 'Connector, Store and Event ports are required.');
  }
  let scheduler = null;
  let catalogReadInFlight = null;
  const deletionScheduler = () => {
    if (!scheduler) scheduler = createPythonSidecarBridge({ timeoutMs: 120000 });
    return scheduler;
  };
  const invoke = (operationId, request) => connector.invoke({ schemaVersion: 'omnia.operation-invocation/v1', featureId: FEATURE_ID, featureVersion: FEATURE_VERSION, operationId, request });
  const save = (plan) => store.call('savePlan', { ...plan, updatedAt: new Date().toISOString() });
  const load = (runId) => store.call('loadPlan', String(runId || ''));
  const credentialDigest = (b, s) => digest({ connectorId: b.connectorId, sessionGeneration: b.sessionGeneration, engagementId: b.engagementId,
    authorityInstanceId: b.authorityInstanceId, tenantOrOrgId: b.tenantOrOrgId, packId: b.packId, workspaceIds: s.workspaceIds });
  const catalogContextKey = (context) => digest({
    connectorBinding: context && context.connectorBinding || null,
    safetyLock: context && context.safetyLock || null
  });
  const sameBinding = (left, right) => canonical(binding(left)) === canonical(binding(right));

  async function interactiveRefresh(context) {
    const key = catalogContextKey(context);
    if (catalogReadInFlight && (catalogReadInFlight.key !== key || catalogReadInFlight.timedOut === true)) {
      fail('DELETE.CATALOG_BUSY', 'A previous authoritative catalog read is still completing; no concurrent retry was started.');
    }
    if (!catalogReadInFlight) {
      const promise = Promise.resolve().then(() => refresh(context));
      catalogReadInFlight = { key, promise, timedOut: false };
      promise.finally(() => {
        if (catalogReadInFlight && catalogReadInFlight.promise === promise) catalogReadInFlight = null;
      }).catch(() => undefined);
    }
    const pending = catalogReadInFlight.promise;
    let timer = null;
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Authoritative catalog read timed out.'), { code: 'DELETE.CATALOG_TIMEOUT' })), INTERACTIVE_CATALOG_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
        })
      ]);
    } catch (error) {
      if (error && error.code === 'DELETE.CATALOG_TIMEOUT' && catalogReadInFlight && catalogReadInFlight.promise === pending) {
        catalogReadInFlight.timedOut = true;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function target(item, s) {
    if (!item || !CATALOG_TYPES.includes(String(item.objectType))) fail('DELETE.TYPE_UNSUPPORTED', 'Catalog target is outside the signed Information/GRA/APP/DB/OS/DCNO/TOOL read contract.');
    const workspaceIds = uniqueSorted(item.workspaceIds); const explicitWorkspace = workspaceIds.find((value) => s.workspaceIds.includes(value));
    if (!explicitWorkspace || workspaceIds.length !== 1 || workspaceIds.some((value) => !s.allowedWorkspaceIds.includes(value))) {
      fail('DELETE.OUTSIDE_SAFETY', 'Delete target must belong to one explicit Workspace inside the safety union.');
    }
    const objectType = String(item.objectType); const objectId = requiredText(item.objectId, 'objectId');
    return { objectId, informationId: objectType === 'Information' ? requiredText(item.informationId || objectId, 'informationId') : '',
      workItemId: requiredText(item.workItemId, 'workItemId'), objectType, workspaceIds, workspace: explicitWorkspace,
      number: String(item.number || ''), name: String(item.name || ''), updatedAt: requiredText(item.updatedAt, 'updatedAt'),
      riskAssessmentId: String(item.riskAssessmentId || ''), blockers: Array.isArray(item.blockers) ? item.blockers : [],
      relations: Array.isArray(item.relations) ? item.relations : [] };
  }
  function normalizeRelation(value) {
    return { relationType: requiredText(value.relationType, 'relationType'), sourceObjectId: requiredText(value.sourceObjectId, 'sourceObjectId'),
      targetObjectId: requiredText(value.targetObjectId, 'targetObjectId'), sourceObjectType: requiredText(value.sourceObjectType, 'sourceObjectType'),
      targetObjectType: requiredText(value.targetObjectType, 'targetObjectType'), sourceWorkItemId: requiredText(value.sourceWorkItemId, 'sourceWorkItemId'),
      targetWorkItemId: requiredText(value.targetWorkItemId, 'targetWorkItemId'), sourceWorkspaceId: requiredText(value.sourceWorkspaceId, 'sourceWorkspaceId'),
      targetWorkspaceId: requiredText(value.targetWorkspaceId, 'targetWorkspaceId') };
  }
  function normalizePreflight(value, selected, s) {
    if (!value || String(value.objectId || value.informationId) !== selected.objectId || String(value.objectType || selected.objectType) !== selected.objectType
      || String(value.workItemId) !== selected.workItemId) fail('DELETE.PREFLIGHT_IDENTITY_DRIFT', 'Preflight returned another target.');
    const workspaceIds = uniqueSorted(value.workspaceIds);
    if (workspaceIds.length !== 1 || workspaceIds[0] !== selected.workspace || workspaceIds.some((workspace) => !s.allowedWorkspaceIds.includes(workspace))) {
      fail('DELETE.PREFLIGHT_SCOPE_DRIFT', 'Preflight target Workspace differs from the frozen exact Workspace.');
    }
    if (!Array.isArray(value.blockers) || !Array.isArray(value.relations)) fail('DELETE.PREFLIGHT_INVALID', 'Preflight blockers or relation graph are unavailable.');
    const relations = value.relations.map(normalizeRelation).sort((left, right) => canonical(left).localeCompare(canonical(right)));
    const blockers = value.blockers.map((blocker) => ({ type: String(blocker.type || ''), id: String(blocker.id || ''), workItemId: String(blocker.workItemId || ''), location: String(blocker.location || '') }))
      .sort((left, right) => canonical(left).localeCompare(canonical(right)));
    return { objectId: selected.objectId, informationId: selected.informationId, objectType: selected.objectType, workItemId: selected.workItemId,
      workspaceIds, updatedAt: requiredText(value.updatedAt, 'preflight.updatedAt'), riskAssessmentId: String(value.riskAssessmentId || ''), blockers, relations,
      baseline: { objectId: selected.objectId, workItemId: selected.workItemId, objectType: selected.objectType, workspaceIds,
        number: selected.number, name: selected.name, updatedAt: String(value.updatedAt) } };
  }
  function normalizeGraPreflight(value, selected, s) {
    if (!value || selected.objectType !== 'GRA' || String(value.objectId || value.riskAssessmentId) !== selected.objectId
      || String(value.riskAssessmentId || value.objectId) !== selected.objectId || String(value.objectType) !== 'GRA'
      || String(value.workItemId) !== selected.workItemId) fail('DELETE.PREFLIGHT_IDENTITY_DRIFT', 'GRA preflight returned another immutable target.');
    const workspaceIds = uniqueSorted(value.workspaceIds);
    if (workspaceIds.length !== 1 || workspaceIds[0] !== selected.workspace || workspaceIds.some((workspace) => !s.allowedWorkspaceIds.includes(workspace))) {
      fail('DELETE.PREFLIGHT_SCOPE_DRIFT', 'GRA preflight Workspace differs from the frozen exact Workspace.');
    }
    if (!Array.isArray(value.blockers) || value.blockers.length || !Array.isArray(value.relations) || value.relations.length) {
      fail('DELETE.GRA_PREFLIGHT_BLOCKED', 'GRA preflight did not prove an empty blocking and relationship set.');
    }
    const snapshot = value.cascadeSnapshot;
    if (!snapshot || snapshot.schemaVersion !== 'omnia.delete.gra-cascade-snapshot/v1'
      || snapshot.snapshotDigest !== digest({ schemaVersion: snapshot.schemaVersion, assessment: snapshot.assessment,
        risks: snapshot.risks, controls: snapshot.controls, riskControls: snapshot.riskControls })
      || String(snapshot.assessment && snapshot.assessment.riskAssessmentId) !== selected.objectId
      || String(snapshot.assessment && snapshot.assessment.workspaceId) !== selected.workspace) {
      fail('DELETE.GRA_SNAPSHOT_INCOMPLETE', 'GRA preflight did not freeze a complete cascade snapshot for the selected root.');
    }
    return { objectId: selected.objectId, riskAssessmentId: selected.objectId, objectType: 'GRA', workItemId: selected.workItemId,
      workspaceIds, updatedAt: requiredText(value.updatedAt, 'preflight.updatedAt'), blockers: [], relations: [], cascadeSnapshot: snapshot };
  }
  async function authority(context) {
    const b = binding(context.connectorBinding); const s = safety(context.safetyLock, b.engagementId); assertSameAuthority(b, s);
    const scope = await invoke(OPERATIONS.scopeRead, { connectorBinding: b });
    if (!scope || scope.connectorId !== b.connectorId || Number(scope.sessionGeneration) !== b.sessionGeneration || scope.engagementId !== b.engagementId
      || scope.authorityInstanceId !== b.authorityInstanceId || scope.tenantOrOrgId !== b.tenantOrOrgId || scope.packId !== b.packId) {
      fail('DELETE.AUTHORITY_DRIFT', 'Authoritative directory no longer matches the Connector binding.');
    }
    const ids = new Set((scope.workspaces || []).map((workspace) => String(workspace.id || '')));
    if (s.allowedWorkspaceIds.some((workspace) => !ids.has(workspace))) fail('DELETE.WORKSPACE_DRIFT', 'A locked Workspace is absent from authority.');
    return { b, s, scope };
  }
  function authoritativeCatalog(value, b, s) {
    if (!value || value.engagementId !== b.engagementId || !Array.isArray(value.items) || value.items.length > 2000) {
      fail('DELETE.CATALOG_INVALID', 'Authoritative catalog is unavailable, drifted, or exceeds the signed bound.');
    }
    const result = []; const identities = new Set(); const objectIds = new Set();
    for (const raw of value.items) {
      const selected = target(raw, s); const identity = `${selected.objectType}|${selected.objectId}`;
      if (identities.has(identity) || objectIds.has(selected.objectId)) {
        fail('DELETE.CATALOG_AMBIGUOUS', 'Authoritative catalog contains a duplicate or cross-type object identity.');
      }
      identities.add(identity); objectIds.add(selected.objectId); result.push({ identity, raw, selected });
    }
    return result;
  }
  function scopes(scope, s) {
    const result = []; const sections = new Map((scope.sections || []).map((section) => [String(section.id || ''), section]));
    const append = (workspace, parentId, parentLabel, disabledReason = '') => {
      const workspaceId = String(workspace.id);
      result.push({ id: `workspace:${workspaceId}`, parentId, kind: 'workspace', level: 2, label: String(workspace.name || workspaceId), parentLabel,
        selected: !disabledReason, initialExpanded: true, disabledReason });
      for (const kind of CATALOG_TYPES) {
        const typeDisabledReason = disabledReason || TYPE_DISABLED_REASONS[kind] || '';
        result.push({ id: `type:${workspaceId}:${kind}`, parentId: `workspace:${workspaceId}`, kind: 'element_type', level: 3,
          label: kind, parentLabel: String(workspace.name || workspaceId), selected: !typeDisabledReason, initialExpanded: false, disabledReason: typeDisabledReason });
      }
      for (const [kind, label] of UNSUPPORTED) result.push({ id: `type:${workspaceId}:${kind}`, parentId: `workspace:${workspaceId}`, kind: 'element_type', level: 3,
        label, parentLabel: String(workspace.name || workspaceId), selected: false, initialExpanded: false, disabledReason: '当前类型没有完整的独立选择、签名 mutation 与 readback 合同。' });
    };
    for (const section of sections.values()) {
      const children = (scope.workspaces || []).filter((workspace) => String(workspace.parentSectionId || '') === String(section.id) && s.workspaceIds.includes(String(workspace.id || '')));
      if (!children.length) continue;
      result.push({ id: `section:${section.id}`, parentId: null, kind: 'section', level: 1, label: String(section.name || section.id), parentLabel: '所在部分', selected: true, initialExpanded: true, disabledReason: '' });
      for (const workspace of children) append(workspace, `section:${section.id}`, String(section.name || section.id));
    }
    const unassigned = (scope.workspaces || []).filter((workspace) => s.workspaceIds.includes(String(workspace.id || '')) && !sections.has(String(workspace.parentSectionId || '')));
    if (unassigned.length) {
      result.push({ id: 'section:unassigned', parentId: null, kind: 'section', level: 1, label: '未归属所在部分', parentLabel: '所在部分', selected: false, initialExpanded: true,
        disabledReason: 'Omnia 未返回真实所在部分；不推断规划分组。' });
      for (const workspace of unassigned) append(workspace, 'section:unassigned', '未归属所在部分', 'Omnia 未返回真实所在部分；该 Workspace 不进入可删除目录。');
    }
    return result;
  }
  function selectedOperation(value) {
    return value.objectType === 'Information' ? OPERATIONS.information : value.objectType === 'GRA' ? OPERATIONS.gra : OPERATIONS.itElement;
  }
  function selectedRequest(value, b, planDigest = '') {
    return { connectorBinding: b, ...(planDigest ? { planDigest } : {}), target: { targetIdentityKey: `${value.objectType}|${value.workspace}|${value.objectId}`,
      workspaceId: value.workspace, objectId: value.objectId, workItemId: value.workItemId, objectType: value.objectType },
    objectId: value.objectId, informationId: value.informationId, riskAssessmentId: value.objectType === 'GRA' ? value.objectId : value.riskAssessmentId,
    workItemId: value.workItemId, objectType: value.objectType, workspaceId: value.workspace };
  }
  async function refresh(context) {
    const { b, s, scope } = await authority(context);
    const catalog = await invoke(OPERATIONS.catalogRead, { connectorBinding: b, engagementId: b.engagementId, workspaceIds: s.workspaceIds });
    const catalogEntries = authoritativeCatalog(catalog, b, s);
    const tree = scopes(scope, s); const typeScopes = new Map(tree.filter((node) => node.kind === 'element_type').map((node) => [node.id, node])); const items = [];
    for (const { selected } of catalogEntries) {
      const scopeId = `type:${selected.workspace}:${selected.objectType}`; const typeScope = typeScopes.get(scopeId); if (!typeScope) continue;
      const graphCount = selected.relations.length + selected.blockers.length;
      items.push({ id: `${selected.objectType}|${selected.objectId}`, scopeId, type: selected.objectType, title: selected.number || selected.name || selected.objectId,
        subtitle: `${selected.name || selected.number || selected.objectId}${graphCount ? ` · ${graphCount} 个权威依赖` : ''}`,
        selectable: MUTATION_TYPES.includes(selected.objectType) && !typeScope.disabledReason,
        disabledReason: typeScope.disabledReason || '', concurrencyToken: selected.updatedAt });
    }
    await store.call('savePlan', { schemaVersion: 'omnia.delete-catalog-snapshot/v1', planId: `catalog:${credentialDigest(b, s)}`,
      capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(), binding: b, safetyRevision: s.stateVersion,
      items: catalogEntries.map((entry) => entry.raw) });
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', status: items.length ? 'ready' : 'empty',
      statusMessage: items.length ? `已权威读取 ${items.length} 个 Information/GRA/APP/DB/OS/DCNO/TOOL；所有可选目标的关系与 GRA 子图将在确认前完整冻结。` : '当前安全范围没有支持的删除目标。',
      scopes: tree, items, selectedItemIds: [] };
  }
  async function refreshProjection(context) {
    try {
      const patch = await interactiveRefresh(context);
      return { ...patch, clearFields: ['progress'], actions: directoryActionPatch('首次权威目录读取已完成。') };
    } catch (error) {
      const failure = errorSummary(error);
      return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', status: 'error',
        statusMessage: catalogFailureMessage(failure), scopes: [], items: [], selectedItemIds: [],
        clearFields: ['progress'], actions: directoryActionPatch('首次权威目录读取已结束，结果为失败。') };
    }
  }
  function directoryActionPatch(bootstrapReason) {
    return [
      { actionId: 'bootstrap-authoritative-catalog', enabled: false, reason: bootstrapReason },
      { actionId: 'refresh-authoritative-catalog', enabled: true, reason: '' },
      { actionId: 'create-delete-plan', enabled: true, reason: '' },
      { actionId: 'continue-delete-plan-preparation', enabled: false, reason: '当前没有正在冻结的删除计划。' },
      { actionId: 'retry-delete-plan-preparation', enabled: false, reason: '当前没有失败的只读冻结批次。' },
      { actionId: 'cancel-delete-plan', enabled: false, reason: '当前未显示待确认删除计划。' },
      { actionId: 'confirm-delete-plan', enabled: false, reason: '当前未显示待确认删除计划。' },
      { actionId: 'reconcile-delete-plan', enabled: false, reason: '当前没有只读核验义务。' }
    ];
  }
  async function latestPlanForReopen() {
    const latest = await store.call('loadLatestRun', {}); const run = latest && latest.run ? latest.run : latest;
    const runId = String(run && run.run_id || '');
    if (!runId) return null;
    const plan = await load(runId);
    if (!plan) fail('DELETE.REOPEN_PLAN_MISSING', '最新 Delete Core Run 缺少 Feature 计划投影；重新打开已失败关闭。');
    if (String(plan.featureId || FEATURE_ID) !== FEATURE_ID) fail('DELETE.REOPEN_PLAN_IDENTITY_DRIFT', '最新计划不属于 Delete Elements。');
    if (!['preparing', 'pending_confirmation', 'executing', 'uncertain', 'completed', 'failed', 'cancelled'].includes(String(plan.state || ''))) {
      fail('DELETE.REOPEN_PLAN_STATE_INVALID', '最新 Delete 计划处于未知状态。');
    }
    return plan;
  }
  function preservesFrozenPlanOnReopen(plan) {
    return Boolean(plan) && ['preparing', 'pending_confirmation', 'executing', 'uncertain'].includes(plan.state);
  }
  function frozenPlanRefreshFailureProjection(plan, error) {
    const failure = errorSummary(error); const patch = planSurface(plan);
    const canCancel = ['preparing', 'pending_confirmation'].includes(plan.state);
    return { ...patch, status: 'error',
      statusMessage: `DELETE.REOPEN_REFRESH_FAILED: ${catalogFailureMessage(failure)} 冻结删除计划保持不变；未创建、确认、执行 mutation 或启动只读核验。`,
      actions: patch.actions.map((action) => action.actionId === 'cancel-delete-plan'
        ? { ...action, enabled: canCancel, reason: canCancel ? '' : '当前权威读取失败；该计划保持失败关闭，直到后续重新打开读取成功。' }
        : { ...action, enabled: false, reason: '当前权威读取失败；该计划保持失败关闭，直到后续重新打开读取成功。' }) };
  }
  function catalogFailureProjection(error) {
    const failure = errorSummary(error);
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', status: 'error',
      statusMessage: catalogFailureMessage(failure), scopes: [], items: [], selectedItemIds: [],
      clearFields: ['progress'], actions: directoryActionPatch('权威目录读取已结束，结果为失败。') };
  }
  async function reopenProjection(context) {
    let plan;
    try {
      plan = await latestPlanForReopen();
    } catch (error) {
      return catalogFailureProjection(error);
    }
    if (plan && plan.state === 'preparing') {
      try {
        preparationAuthority(context, plan);
        return planSurface(plan);
      } catch (error) {
        return frozenPlanRefreshFailureProjection(plan, error);
      }
    }
    try {
      const patch = await interactiveRefresh(context);
      if (preservesFrozenPlanOnReopen(plan)) return planSurface(plan);
      return { ...patch, clearFields: ['progress'], actions: directoryActionPatch('重新打开后的权威目录读取已完成。') };
    } catch (error) {
      return preservesFrozenPlanOnReopen(plan) ? frozenPlanRefreshFailureProjection(plan, error) : catalogFailureProjection(error);
    }
  }
  async function recaptureFinalCatalog(plan, context) {
    const { b, s } = await authority(context);
    assertSameAuthority(b, plan.binding);
    if (!frozenSafetyMatches(s, plan.safety)) fail('DELETE.FINAL_SAFETY_DRIFT', 'Final authoritative recapture no longer matches the frozen safety scope.');
    await store.call('validateReturnAuthority', { runId: plan.runId, connectorBinding: b, safetyLock: s });
    const catalog = await invoke(OPERATIONS.catalogRead, { connectorBinding: b, engagementId: b.engagementId, workspaceIds: s.workspaceIds });
    const catalogEntries = authoritativeCatalog(catalog, b, s);
    const verification = finalCatalogVerification(plan, catalogEntries);
    plan.finalVerification = verification; await save(plan);
    return { b, s, verification };
  }
  function blockerKind(blocker) {
    const type = String(blocker && blocker.type || '').trim().toLowerCase();
    if (['riskassessment', 'riskfactorevaluation', 'gra'].includes(type)) return 'GRA';
    if (type === 'infrastructure') return 'INFRASTRUCTURE';
    if (type === 'application') return 'APPLICATION';
    if (['ittool', 'tool'].includes(type)) return 'TOOL';
    return 'UNKNOWN';
  }
  function relationRequest(type, source, targetValue) {
    return { relationType: type, sourceObjectId: source.objectId, targetObjectId: targetValue.objectId,
      sourceObjectType: source.objectType, targetObjectType: targetValue.objectType, sourceWorkItemId: source.workItemId,
      targetWorkItemId: targetValue.workItemId, sourceWorkspaceId: source.workspace, targetWorkspaceId: targetValue.workspace };
  }
  function relationGroupKey(type, sourceObjectId, targetObjectIds) {
    return `${type}|${sourceObjectId}|group:${digest(uniqueSorted(targetObjectIds))}`;
  }
  function relationGroupRequest(type, source, targets) {
    const ordered = [...targets].sort((left, right) => left.objectId.localeCompare(right.objectId));
    return { relationType: type, sourceObjectId: source.objectId, targetObjectIds: ordered.map((item) => item.objectId),
      sourceObjectType: source.objectType, sourceWorkItemId: source.workItemId, sourceWorkspaceId: source.workspace,
      targets: ordered.map((item) => ({ objectId: item.objectId, objectType: item.objectType, workItemId: item.workItemId, workspaceId: item.workspace })) };
  }
  function preparationAuthority(context, plan) {
    const b = binding(context && context.connectorBinding); const s = safety(context && context.safetyLock, b.engagementId); assertSameAuthority(b, s);
    assertSameAuthority(b, plan.binding);
    if (!frozenSafetyMatches(s, plan.safety)) fail('DELETE.PREPARATION_SAFETY_DRIFT', 'Current safety lock differs from the preparing deletion plan.');
    return { b, s };
  }
  async function loadCatalogSnapshot(b, s) {
    const planId = `catalog:${credentialDigest(b, s)}`; const snapshot = await load(planId);
    const expiresAt = Date.parse(String(snapshot && snapshot.expiresAt || ''));
    if (!snapshot || snapshot.schemaVersion !== 'omnia.delete-catalog-snapshot/v1' || snapshot.planId !== planId
      || !sameBinding(snapshot.binding, b) || Number(snapshot.safetyRevision) !== Number(s.stateVersion)
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !Array.isArray(snapshot.items)) {
      fail('DELETE.CATALOG_SNAPSHOT_REQUIRED', '当前权威目录快照缺失、过期或与 Connector/安全锁不一致；请先点击“权威重抓取”，再创建删除计划。');
    }
    return authoritativeCatalog({ engagementId: b.engagementId, items: snapshot.items }, b, s);
  }
  function compilerTarget(value) {
    return { objectId: value.objectId, informationId: value.informationId, workItemId: value.workItemId,
      objectType: value.objectType, workspace: value.workspace, workspaceIds: value.workspaceIds, riskAssessmentId: value.riskAssessmentId };
  }
  function compilerPreflight(value) {
    return { objectId: value.objectId, informationId: value.informationId, workItemId: value.workItemId,
      objectType: value.objectType, workspaceIds: value.workspaceIds, riskAssessmentId: value.riskAssessmentId,
      blockers: value.blockers, relations: value.relations };
  }
  function verifyCompiledPreparation(value, plan, objectPreflights) {
    const exactKeys = ['compilationDigest', 'dependencySkeleton', 'derivedGraSeeds', 'graSeeds', 'planId', 'relationDescriptors', 'runId', 'schemaVersion'];
    if (!value || typeof value !== 'object' || canonical(Object.keys(value).sort()) !== canonical(exactKeys.sort())
      || value.schemaVersion !== 'omnia.delete-preparation-compile-output/v1' || value.planId !== plan.planId || value.runId !== plan.runId
      || !Array.isArray(value.graSeeds) || value.graSeeds.length > plan.targets.length * 4
      || !Array.isArray(value.derivedGraSeeds) || value.derivedGraSeeds.length > value.graSeeds.length
      || !Array.isArray(value.relationDescriptors) || value.relationDescriptors.length > plan.targets.length * 2
      || !Array.isArray(value.dependencySkeleton) || value.dependencySkeleton.length > plan.targets.length * 7) {
      fail('DELETE.PREPARATION_COMPILER_OUTPUT_INVALID', 'Managed Python graph compiler returned an invalid bounded envelope.');
    }
    const body = { schemaVersion: value.schemaVersion, planId: value.planId, runId: value.runId,
      graSeeds: value.graSeeds, derivedGraSeeds: value.derivedGraSeeds,
      relationDescriptors: value.relationDescriptors, dependencySkeleton: value.dependencySkeleton };
    if (!/^[0-9a-f]{64}$/u.test(String(value.compilationDigest || '')) || digest(body) !== value.compilationDigest) {
      fail('DELETE.PREPARATION_COMPILER_DIGEST_INVALID', 'Managed Python graph compiler digest is invalid.');
    }
    if (objectPreflights.length !== plan.targets.length) fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Object preflight checkpoint is incomplete.');
    const selectedById = new Map(plan.targets.map((item) => [item.objectId, item]));
    if (selectedById.size !== plan.targets.length) fail('DELETE.PREPARATION_COMPILER_OUTPUT_INVALID', 'Frozen target identities are ambiguous.');
    const allowedEdges = new Map(); const allowedGra = new Map();
    const addEdge = (edge) => {
      if (!edge || !['InfrastructureApplication', 'ItToolApplication'].includes(edge.relationType)) fail('DELETE.PREPARATION_COMPILER_OUTPUT_INVALID', 'Compiled relation type is not allowlisted.');
      const source = selectedById.get(edge.sourceObjectId); const targetValue = selectedById.get(edge.targetObjectId);
      if (!source || !targetValue || source.workspace !== targetValue.workspace
        || edge.sourceObjectType !== source.objectType || edge.targetObjectType !== targetValue.objectType
        || edge.sourceWorkItemId !== source.workItemId || edge.targetWorkItemId !== targetValue.workItemId
        || edge.sourceWorkspaceId !== source.workspace || edge.targetWorkspaceId !== targetValue.workspace) {
        fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled relation evidence contains an extra or drifted endpoint.');
      }
      const validPair = edge.relationType === 'InfrastructureApplication' && ['DB', 'OS', 'DCNO'].includes(source.objectType) && targetValue.objectType === 'APP'
        || edge.relationType === 'ItToolApplication' && source.objectType === 'TOOL' && targetValue.objectType === 'APP';
      if (!validPair) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled relation endpoint types are invalid.');
      const key = relationKey(edge.relationType, source.objectId, targetValue.objectId); const existing = allowedEdges.get(key);
      if (existing && canonical(existing) !== canonical(edge)) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled relation evidence conflicts by identity.');
      allowedEdges.set(key, edge);
    };
    for (let index = 0; index < plan.targets.length; index += 1) {
      const selected = plan.targets[index]; const preflight = objectPreflights[index];
      for (const edge of preflight.relations) addEdge(edge);
      const graIds = uniqueSorted([selected.riskAssessmentId, preflight.riskAssessmentId,
        ...preflight.blockers.filter((blocker) => blockerKind(blocker) === 'GRA').map((blocker) => blocker.id)]);
      for (const riskAssessmentId of graIds) {
        const key = `GRA|${selected.workspace}|${riskAssessmentId}`; const previous = allowedGra.get(key);
        allowedGra.set(key, { key, riskAssessmentId, workspace: selected.workspace,
          affectedTargetKeys: uniqueSorted([...(previous && previous.affectedTargetKeys || []), targetKey(selected)]) });
      }
      for (const blocker of preflight.blockers) {
        const kind = blockerKind(blocker); if (kind === 'GRA') continue;
        if (selected.objectType === 'APP' && kind === 'INFRASTRUCTURE') {
          const source = selectedById.get(blocker.id); if (!source) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled blocker endpoint is absent.');
          if (blocker.workItemId && blocker.workItemId !== source.workItemId) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled blocker Work Item identity drifted.');
          addEdge(relationRequest('InfrastructureApplication', source, selected)); continue;
        }
        if (['DB', 'OS', 'DCNO'].includes(selected.objectType) && kind === 'APPLICATION') {
          const targetValue = selectedById.get(blocker.id); if (!targetValue) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled blocker endpoint is absent.');
          if (blocker.workItemId && blocker.workItemId !== targetValue.workItemId) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled blocker Work Item identity drifted.');
          addEdge(relationRequest('InfrastructureApplication', selected, targetValue)); continue;
        }
        if ((selected.objectType === 'APP' && kind === 'TOOL') || (selected.objectType === 'TOOL' && kind === 'APPLICATION')) {
          const blockerEndpoint = selectedById.get(blocker.id);
          if (!blockerEndpoint || blocker.workItemId && blocker.workItemId !== blockerEndpoint.workItemId) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled blocker endpoint identity drifted.');
          const sourceId = selected.objectType === 'TOOL' ? selected.objectId : blocker.id;
          const targetId = selected.objectType === 'APP' ? selected.objectId : blocker.id;
          if (!allowedEdges.has(relationKey('ItToolApplication', sourceId, targetId))) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled Tool/Application blocker has no authoritative edge.');
          continue;
        }
        fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled blocker direction is invalid.');
      }
    }
    const expectedGraSeeds = [...allowedGra.values()].sort((left, right) => left.key.localeCompare(right.key));
    const expectedDerived = expectedGraSeeds.filter((seed) => !plan.targets.some((item) => item.objectType === 'GRA'
      && item.objectId === seed.riskAssessmentId && item.workspace === seed.workspace));
    if (canonical(value.graSeeds) !== canonical(expectedGraSeeds) || canonical(value.derivedGraSeeds) !== canonical(expectedDerived)) {
      fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Managed Python GRA seed set, Workspace, order, or affected targets drifted.');
    }
    const consumedEdges = new Set(); const relationDescriptors = value.relationDescriptors.map((compiled, index) => {
      if (!compiled || typeof compiled !== 'object' || !['InfrastructureApplication', 'ItToolApplication'].includes(compiled.relationType)
        || !Array.isArray(compiled.targets) || !compiled.targets.length || compiled.targets.length > plan.targets.length
        || !Array.isArray(compiled.affectedTargetKeys)) fail('DELETE.PREPARATION_COMPILER_OUTPUT_INVALID', 'Compiled relation group is invalid.');
      const source = selectedById.get(String(compiled.source && compiled.source.objectId || ''));
      const targetValues = compiled.targets.map((item) => selectedById.get(String(item && item.objectId || '')));
      if (!source || targetValues.some((item) => !item) || compiled.workspace !== source.workspace
        || canonical(compiled.source) !== canonical({ objectId: source.objectId, objectType: source.objectType, workItemId: source.workItemId, workspace: source.workspace })
        || compiled.targets.some((item, targetIndex) => canonical(item) !== canonical({ objectId: targetValues[targetIndex].objectId,
          objectType: targetValues[targetIndex].objectType, workItemId: targetValues[targetIndex].workItemId, workspace: targetValues[targetIndex].workspace }))) {
        fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled relation group contains a drifted endpoint.');
      }
      const targetObjectIds = targetValues.map((item) => item.objectId);
      if (canonical(targetObjectIds) !== canonical(uniqueSorted(targetObjectIds))
        || compiled.key !== relationGroupKey(compiled.relationType, source.objectId, targetObjectIds)
        || canonical(compiled.affectedTargetKeys) !== canonical(uniqueSorted([targetKey(source), ...targetValues.map(targetKey)]))) {
        fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled relation group key, order, or affected target set drifted.');
      }
      for (const targetValue of targetValues) {
        const edgeKey = relationKey(compiled.relationType, source.objectId, targetValue.objectId);
        if (!allowedEdges.has(edgeKey) || consumedEdges.has(edgeKey)) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Compiled relation group added or duplicated an edge.');
        consumedEdges.add(edgeKey);
      }
      if (index > 0) {
        const previous = value.relationDescriptors[index - 1]; const previousOwner = `${previous.relationType}|${previous.source.objectId}`;
        const owner = `${compiled.relationType}|${source.objectId}`;
        if (previousOwner.localeCompare(owner) >= 0) fail('DELETE.PREPARATION_COMPILER_OUTPUT_INVALID', 'Compiled relation groups are not deterministically ordered.');
      }
      const operations = OPERATIONS.relations[compiled.relationType]; const request = relationGroupRequest(compiled.relationType, source, targetValues);
      return { key: compiled.key, workspace: source.workspace, objectType: compiled.relationType, source, targetValues, operations, request,
        operationTarget: { targetIdentityKey: compiled.key, workspaceId: source.workspace }, affectedTargetKeys: compiled.affectedTargetKeys };
    });
    if (consumedEdges.size !== allowedEdges.size) fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Managed Python omitted an authoritative relation edge.');
    const objectOrder = { DB: 1, OS: 2, DCNO: 3, TOOL: 4, Information: 5, APP: 6 };
    const expectedNodes = [
      ...relationDescriptors.map((item) => ({ stepId: item.key, kind: 'relation', affectedTargetKeys: item.affectedTargetKeys })),
      ...expectedGraSeeds.map((item) => ({ stepId: item.key, kind: 'cascade', affectedTargetKeys: item.affectedTargetKeys })),
      ...plan.targets.filter((item) => item.objectType !== 'GRA')
        .sort((left, right) => objectOrder[left.objectType] - objectOrder[right.objectType] || left.objectId.localeCompare(right.objectId))
        .map((item) => ({ stepId: targetKey(item), kind: 'object', affectedTargetKeys: [targetKey(item)] }))
    ];
    const rank = { relation: 0, cascade: 1, object: 2 };
    const expectedSkeleton = expectedNodes.map((node, index) => ({ ...node,
      dependsOn: expectedNodes.slice(0, index).filter((candidate) => rank[candidate.kind] < rank[node.kind]
        && candidate.affectedTargetKeys.some((key) => node.affectedTargetKeys.includes(key))).map((candidate) => candidate.stepId) }));
    if (canonical(value.dependencySkeleton) !== canonical(expectedSkeleton)) {
      fail('DELETE.PREPARATION_COMPILER_IDENTITY_DRIFT', 'Managed Python dependency skeleton drifted from the verified target sets.');
    }
    return { graSeeds: value.graSeeds, derivedGraSeeds: value.derivedGraSeeds, relationDescriptors: value.relationDescriptors,
      dependencySkeleton: value.dependencySkeleton, compilationDigest: value.compilationDigest };
  }
  async function compilePreparationGraph(plan, objectPreflights) {
    const value = await deletionScheduler().invoke('compile_delete_preparation', {
      schemaVersion: 'omnia.delete-preparation-compile-input/v1', planId: plan.planId, runId: plan.runId,
      targets: plan.targets.map(compilerTarget), objectPreflights: objectPreflights.map(compilerPreflight)
    }, { runId: plan.runId });
    return verifyCompiledPreparation(value, plan, objectPreflights);
  }
  function verifiedCheckpointCompilation(plan) {
    const preparation = plan.preparation || {};
    return verifyCompiledPreparation({ schemaVersion: 'omnia.delete-preparation-compile-output/v1', planId: plan.planId, runId: plan.runId,
      graSeeds: preparation.graSeeds, derivedGraSeeds: preparation.derivedGraSeeds,
      relationDescriptors: preparation.relationDescriptors, dependencySkeleton: preparation.dependencySkeleton,
      compilationDigest: preparation.compilationDigest }, plan, preparation.objectPreflights || []);
  }
  function enrichRelationDescriptor(plan, compiled) {
    const selectedById = new Map(plan.targets.map((item) => [item.objectId, item])); const source = selectedById.get(compiled.source.objectId);
    const targetValues = compiled.targets.map((item) => selectedById.get(item.objectId));
    if (!source || targetValues.some((item) => !item)) fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Compiled relation endpoint is missing from the frozen plan.');
    const operations = OPERATIONS.relations[compiled.relationType]; const request = relationGroupRequest(compiled.relationType, source, targetValues);
    return { key: compiled.key, workspace: source.workspace, objectType: compiled.relationType, source, targetValues, operations, request,
      operationTarget: { targetIdentityKey: compiled.key, workspaceId: source.workspace }, affectedTargetKeys: compiled.affectedTargetKeys };
  }
  function normalizedDerivedGraPreflight(value, seed, s) {
    if (!value || String(value.objectId || value.riskAssessmentId) !== seed.riskAssessmentId
      || String(value.riskAssessmentId || value.objectId) !== seed.riskAssessmentId || String(value.objectType) !== 'GRA') {
      fail('DELETE.PREFLIGHT_IDENTITY_DRIFT', 'Derived GRA preflight returned another immutable target.');
    }
    const workspaceIds = uniqueSorted(value.workspaceIds);
    if (workspaceIds.length !== 1 || workspaceIds[0] !== seed.workspace || workspaceIds.some((workspace) => !s.allowedWorkspaceIds.includes(workspace))) {
      fail('DELETE.PREFLIGHT_SCOPE_DRIFT', 'Derived GRA preflight Workspace differs from the frozen exact Workspace.');
    }
    const snapshot = value.cascadeSnapshot;
    if (!snapshot || snapshot.schemaVersion !== 'omnia.delete.gra-cascade-snapshot/v1'
      || snapshot.snapshotDigest !== digest({ schemaVersion: snapshot.schemaVersion, assessment: snapshot.assessment,
        risks: snapshot.risks, controls: snapshot.controls, riskControls: snapshot.riskControls })
      || String(snapshot.assessment && snapshot.assessment.riskAssessmentId) !== seed.riskAssessmentId
      || String(snapshot.assessment && snapshot.assessment.workspaceId) !== seed.workspace) {
      fail('DELETE.GRA_SNAPSHOT_INCOMPLETE', 'Derived GRA preflight did not freeze the complete Risk/Control/Risk-Control snapshot.');
    }
    return value;
  }
  async function createPlan(context, targetIds, requestedSurfaceStateVersion = 0) {
    const b = binding(context && context.connectorBinding); const s = safety(context && context.safetyLock, b.engagementId); assertSameAuthority(b, s);
    if (!Array.isArray(targetIds) || targetIds.length < 1 || targetIds.length > 200 || new Set(targetIds).size !== targetIds.length) fail('DELETE.TARGETS_INVALID', 'Select 1-200 unique targets.');
    const catalogEntries = await loadCatalogSnapshot(b, s); const byKey = new Map(catalogEntries.map((entry) => [entry.identity, entry.selected]));
    const targets = targetIds.map((key) => {
      const selected = byKey.get(String(key));
      if (!selected) fail('DELETE.SELECTION_STALE', 'A selected target is absent from the current authoritative catalog snapshot; please refresh before planning.');
      if (!MUTATION_TYPES.includes(selected.objectType)) fail('DELETE.TYPE_UNSUPPORTED', `${selected.objectType} has no signed mutation/readback contract and cannot enter a deletion plan.`);
      return selected;
    });
    const coreRun = await store.call('createMutationRun', { engagementId: b.engagementId });
    const runId = requiredText(coreRun && (coreRun.runId || coreRun.run_id), 'coreRun.runId');
    const initialCoreRevision = Number(coreRun && (coreRun.stateRevision || coreRun.state_revision));
    const surfaceStateVersion = Number.isSafeInteger(Number(requestedSurfaceStateVersion)) && Number(requestedSurfaceStateVersion) >= 1
      ? Number(requestedSurfaceStateVersion) + 1 : 1;
    const plan = { schemaVersion: 'omnia.delete-plan/v5', planId: runId, runId, featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
      state: 'preparing', stateVersion: Number.isSafeInteger(initialCoreRevision) && initialCoreRevision >= 1 ? initialCoreRevision : 1,
      surfaceStateVersion, preparationDigest: digest({ binding: b, safety: s, targets }), planDigest: '', graphDigest: '',
      binding: b, safety: s, targets, steps: [], intents: [], scheduleGraph: [], outcomes: [], results: [], nextIndex: 0,
      preparation: { schemaVersion: 'omnia.delete-plan-preparation/v1', phase: 'object_preflight', checkpointRevision: 0,
        objectCursor: 0, objectPreflights: [], graSeeds: [], derivedGraSeeds: [], derivedGraCursor: 0, derivedGraPreflights: [],
        relationDescriptors: [], relationCursor: 0, relationPreflights: [] }, createdAt: new Date().toISOString() };
    await save(plan); return plan;
  }
  function preparationFailure(plan, error, batch) {
    const failure = errorSummary(error); const preparation = plan.preparation || {};
    return { ...plan, surfaceStateVersion: Number(plan.surfaceStateVersion) + 1,
      preparation: { ...preparation, checkpointRevision: Number(preparation.checkpointRevision || 0) + 1,
        failure: { ...failure, phase: String(preparation.phase || ''), batchStart: Number(batch.start || 0),
          batchSize: Number(batch.size || 0), attemptedAt: new Date().toISOString() } } };
  }
  function preparationSuccess(plan, values) {
    const { failure: _failure, ...checkpoint } = plan.preparation || {};
    return { ...plan, surfaceStateVersion: Number(plan.surfaceStateVersion) + 1,
      preparation: { ...checkpoint, ...values, checkpointRevision: Number(checkpoint.checkpointRevision || 0) + 1 } };
  }
  async function finalizePreparedPlan(plan, b, s) {
    const preparation = plan.preparation; const objectPreflights = preparation.objectPreflights;
    const compiled = verifiedCheckpointCompilation(plan);
    const relationSteps = compiled.relationDescriptors.map((pureDescriptor, index) => {
      const descriptor = enrichRelationDescriptor(plan, pureDescriptor);
      const before = preparation.relationPreflights[index];
      if (!before) fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Relation preflight checkpoint is incomplete.');
      return { kind: 'relation', key: descriptor.key, workspace: descriptor.workspace, objectType: descriptor.objectType,
        objectId: descriptor.key, operations: descriptor.operations, request: descriptor.request,
        mutationPayload: { relationType: descriptor.request.relationType, sourceObjectId: descriptor.source.objectId,
          targetObjectIds: descriptor.request.targetObjectIds, concurrency: before.concurrency },
        operationTarget: descriptor.operationTarget, baseline: before, preflight: before, affectedTargetKeys: descriptor.affectedTargetKeys };
    });
    const derivedGraPreflights = new Map(compiled.derivedGraSeeds.map((seed, index) => [seed.key, preparation.derivedGraPreflights[index]]));
    const graSteps = compiled.graSeeds.map((seed) => {
      const selectedGraIndex = plan.targets.findIndex((item) => item.objectType === 'GRA' && item.objectId === seed.riskAssessmentId && item.workspace === seed.workspace);
      const before = selectedGraIndex >= 0 ? objectPreflights[selectedGraIndex] : derivedGraPreflights.get(seed.key);
      if (!before || !before.cascadeSnapshot || !before.cascadeSnapshot.snapshotDigest) fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'GRA preflight checkpoint is incomplete.');
      return { kind: 'cascade', key: seed.key, workspace: seed.workspace, objectType: 'GRA', objectId: seed.riskAssessmentId, operations: OPERATIONS.gra,
        request: { riskAssessmentId: seed.riskAssessmentId, workspaceId: seed.workspace, frozenCascadeSnapshot: before.cascadeSnapshot },
        mutationPayload: { riskAssessmentId: seed.riskAssessmentId }, operationTarget: { targetIdentityKey: seed.key, workspaceId: seed.workspace },
        baseline: before, preflight: before, affectedTargetKeys: seed.affectedTargetKeys };
    });
    const order = { DB: 1, OS: 2, DCNO: 3, TOOL: 4, Information: 5, APP: 6 };
    const objectSteps = plan.targets.map((selected, index) => ({ selected, preflight: objectPreflights[index] }))
      .filter(({ selected }) => selected.objectType !== 'GRA')
      .sort((left, right) => order[left.selected.objectType] - order[right.selected.objectType] || left.selected.objectId.localeCompare(right.selected.objectId))
      .map(({ selected, preflight }) => {
        const operations = selectedOperation(selected);
        return { kind: 'object', key: `${selected.objectType}|${selected.workspace}|${selected.objectId}`, workspace: selected.workspace,
          objectType: selected.objectType, objectId: selected.objectId, operations,
          request: { objectId: selected.objectId, informationId: selected.informationId, workItemId: selected.workItemId, objectType: selected.objectType, workspaceId: selected.workspace },
          mutationPayload: selected.objectType === 'Information' ? { informationId: selected.informationId } : { objectId: selected.objectId, objectType: selected.objectType },
          operationTarget: { targetIdentityKey: `${selected.objectType}|${selected.workspace}|${selected.objectId}`, workspaceId: selected.workspace },
          baseline: preflight.baseline, preflight, dependenciesPlanned: preflight.blockers.length > 0 || preflight.relations.length > 0 || Boolean(preflight.riskAssessmentId),
          affectedTargetKeys: [targetKey(selected)] };
      });
    const steps = [...relationSteps, ...graSteps, ...objectSteps]; const stepsByKey = new Map(steps.map((step) => [step.key, step]));
    const scheduleGraph = compiled.dependencySkeleton.map((node) => {
      const step = stepsByKey.get(node.stepId);
      if (!step || step.kind !== node.kind || canonical(step.affectedTargetKeys) !== canonical(node.affectedTargetKeys)) {
        fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Compiled dependency node differs from the frozen graph step.');
      }
      return { stepId: step.key, targetKey: step.key, dependsOn: node.dependsOn, operationId: step.operations.direct, effect: 'omnia_mutation' };
    });
    if (scheduleGraph.length !== steps.length || new Set(scheduleGraph.map((step) => step.stepId)).size !== steps.length) {
      fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Compiled dependency skeleton does not cover the frozen graph exactly once.');
    }
    const graphDigest = digest({ compilationDigest: compiled.compilationDigest,
      preflights: steps.map((step) => ({ key: step.key, preflight: step.preflight })), scheduleGraph });
    const intents = steps.map((step) => ({ kind: step.kind === 'cascade' ? 'object' : step.kind, key: step.key, workspace: step.workspace, objectType: step.objectType, objectId: step.objectId,
      ...(step.kind === 'relation' ? { relationType: step.request.relationType, relationKey: step.key, sourceObjectId: step.request.sourceObjectId,
        targetObjectId: step.request.targetObjectIds[0], targetObjectIds: step.request.targetObjectIds } : {}),
      baseline: step.preflight, preflightDigest: digest(step.preflight), mutationOperationId: step.operations.direct,
      mutationPayload: step.mutationPayload, evidenceOperationIds: [step.operations.reconcile], operationTargetIdentityKey: step.operationTarget.targetIdentityKey }));
    const corePlan = { schemaVersion: 'omnia.delete-intent/v2', authority: { authorityInstanceId: b.authorityInstanceId, tenantOrOrgId: b.tenantOrOrgId,
      packId: b.packId, engagementId: b.engagementId }, graphDigest, targets: intents };
    const frozen = await store.call('prepareReturnIntent', { runId: plan.runId, plan: corePlan, connectorBinding: b, safetyLock: s,
      credentialDigest: credentialDigest(b, s), preflightDigest: graphDigest });
    const { failure: _failure, ...checkpoint } = preparation;
    const result = { ...plan, state: 'pending_confirmation', stateVersion: frozen.stateVersion,
      confirmationId: frozen.confirmationId, confirmationToken: frozen.confirmationToken,
      surfaceStateVersion: Number(plan.surfaceStateVersion) + 1, planDigest: frozen.planDigest, graphDigest, steps, intents, scheduleGraph,
      preparation: { ...checkpoint, phase: 'completed', checkpointRevision: Number(checkpoint.checkpointRevision || 0) + 1 },
      expiresAt: requiredText(frozen.expiresAt, 'confirmation.expiresAt') };
    await save(result); return result;
  }
  async function continuePlanPreparation(plan, context) {
    if (!plan || plan.state !== 'preparing' || !plan.preparation) fail('DELETE.PREPARATION_INVALID', 'No preparing deletion plan is available.');
    const { b, s } = preparationAuthority(context, plan); const preparation = plan.preparation;
    try {
      if (preparation.phase === 'object_preflight') {
        const start = Number(preparation.objectCursor || 0); const selectedBatch = plan.targets.slice(start, start + PLAN_PREPARATION_BATCH_SIZE);
        if (!selectedBatch.length) fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Object preflight cursor is outside the frozen target set.');
        const batchPreflights = await settlePreparationBatch(selectedBatch, async (selected) => {
          const observed = await invoke(selectedOperation(selected).preflight, selectedRequest(selected, b));
          return selected.objectType === 'GRA' ? normalizeGraPreflight(observed, selected, s) : normalizePreflight(observed, selected, s);
        });
        const objectPreflights = [...preparation.objectPreflights, ...batchPreflights]; const objectCursor = start + selectedBatch.length;
        let values = { objectPreflights, objectCursor };
        if (objectCursor === plan.targets.length) {
          const graph = await compilePreparationGraph(plan, objectPreflights);
          values = { ...values, ...graph, phase: graph.derivedGraSeeds.length ? 'gra_preflight' : graph.relationDescriptors.length ? 'relation_preflight' : 'finalizing' };
        }
        const result = preparationSuccess(plan, values); await save(result); return result;
      }
      if (preparation.phase === 'gra_preflight') {
        const compiled = verifiedCheckpointCompilation(plan);
        const start = Number(preparation.derivedGraCursor || 0); const seedBatch = compiled.derivedGraSeeds.slice(start, start + PLAN_PREPARATION_BATCH_SIZE);
        if (!seedBatch.length) fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Derived GRA preflight cursor is outside the frozen seed set.');
        const batchPreflights = await settlePreparationBatch(seedBatch, async (seed) => {
          const observed = await invoke(OPERATIONS.gra.preflight, { connectorBinding: b,
            target: { targetIdentityKey: seed.key, workspaceId: seed.workspace }, riskAssessmentId: seed.riskAssessmentId, workspaceId: seed.workspace });
          return normalizedDerivedGraPreflight(observed, seed, s);
        });
        const derivedGraPreflights = [...preparation.derivedGraPreflights, ...batchPreflights]; const derivedGraCursor = start + seedBatch.length;
        const result = preparationSuccess(plan, { derivedGraPreflights, derivedGraCursor,
          ...(derivedGraCursor === compiled.derivedGraSeeds.length
            ? { phase: compiled.relationDescriptors.length ? 'relation_preflight' : 'finalizing' } : {}) });
        await save(result); return result;
      }
      if (preparation.phase === 'relation_preflight') {
        const compiled = verifiedCheckpointCompilation(plan);
        const start = Number(preparation.relationCursor || 0); const descriptorBatch = compiled.relationDescriptors.slice(start, start + PLAN_PREPARATION_BATCH_SIZE);
        if (!descriptorBatch.length) fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Relation preflight cursor is outside the frozen relation groups.');
        const batchPreflights = await settlePreparationBatch(descriptorBatch, async (pureDescriptor) => {
          const descriptor = enrichRelationDescriptor(plan, pureDescriptor);
          const before = await invoke(descriptor.operations.preflight, { connectorBinding: b, target: descriptor.operationTarget, ...descriptor.request });
          if (!before || before.relationGroupKey !== descriptor.key || canonical(before.targetObjectIds) !== canonical(descriptor.request.targetObjectIds)) {
            fail('DELETE.RELATION_GROUP_DRIFT', 'Relation preflight returned another source group or target set.');
          }
          return before;
        });
        const relationPreflights = [...preparation.relationPreflights, ...batchPreflights]; const relationCursor = start + descriptorBatch.length;
        const result = preparationSuccess(plan, { relationPreflights, relationCursor,
          ...(relationCursor === compiled.relationDescriptors.length ? { phase: 'finalizing' } : {}) });
        await save(result); return result;
      }
      if (preparation.phase === 'finalizing') return finalizePreparedPlan(plan, b, s);
      fail('DELETE.PREPARATION_CHECKPOINT_INVALID', 'Deletion plan preparation phase is invalid.');
    } catch (error) {
      const start = preparation.phase === 'object_preflight' ? preparation.objectCursor
        : preparation.phase === 'gra_preflight' ? preparation.derivedGraCursor : preparation.phase === 'relation_preflight' ? preparation.relationCursor : 0;
      const size = preparation.phase === 'object_preflight' ? Math.min(PLAN_PREPARATION_BATCH_SIZE, plan.targets.length - Number(start || 0))
        : preparation.phase === 'gra_preflight' ? Math.min(PLAN_PREPARATION_BATCH_SIZE, preparation.derivedGraSeeds.length - Number(start || 0))
          : preparation.phase === 'relation_preflight' ? Math.min(PLAN_PREPARATION_BATCH_SIZE, preparation.relationDescriptors.length - Number(start || 0)) : 0;
      const failed = preparationFailure(plan, error, { start, size }); await save(failed); return failed;
    }
  }
  function planActionPatch(plan) {
    const preparing = plan.state === 'preparing'; const preparationFailed = Boolean(preparing && plan.preparation && plan.preparation.failure);
    const pending = plan.state === 'pending_confirmation'; const uncertain = plan.state === 'uncertain';
    const terminal = ['completed', 'failed', 'cancelled'].includes(plan.state);
    return [
      { actionId: 'bootstrap-authoritative-catalog', enabled: false, reason: '计划界面不执行目录首次读取。' },
      { actionId: 'refresh-authoritative-catalog', enabled: terminal, reason: terminal ? '' : '计划确认或核验完成前不能切回目录。' },
      { actionId: 'create-delete-plan', enabled: false, reason: preparing ? '正在分批冻结当前删除计划。' : '当前已有冻结删除计划。' },
      { actionId: 'continue-delete-plan-preparation', enabled: preparing && !preparationFailed,
        reason: preparing ? preparationFailed ? '当前只读冻结批次失败，等待显式重试。' : '' : '当前没有正在冻结的删除计划。' },
      { actionId: 'retry-delete-plan-preparation', enabled: preparationFailed,
        reason: preparationFailed ? '' : '当前没有失败的只读冻结批次。' },
      { actionId: 'cancel-delete-plan', enabled: preparing || pending, reason: preparing || pending ? '' : '只有正在冻结或待确认计划可以取消。' },
      { actionId: 'confirm-delete-plan', enabled: pending, reason: pending ? '' : '当前计划不处于待确认状态。' },
      { actionId: 'reconcile-delete-plan', enabled: uncertain, reason: uncertain ? '' : '当前计划没有只读核验义务。',
        label: uncertain && plan.uncertain && plan.uncertain.phase === 'final_catalog' ? '重试最终权威核验'
          : uncertain && plan.uncertain && plan.uncertain.phase === 'core_terminal' ? '重试 Core 终态核验' : '只读核验' }
    ];
  }
  function stepProgressState(plan, step) {
    const outcome = (plan.outcomes || []).find((candidate) => candidate.stepId === step.key);
    if (!outcome) return plan.state === 'executing' ? 'running' : 'pending';
    return outcome.state === 'succeeded' ? 'passed' : outcome.state === 'skipped' ? 'skipped'
      : outcome.state === 'uncertain' ? 'uncertain' : 'failed';
  }
  function planProgress(plan) {
    const groups = [
      { label: '关系', steps: plan.steps.filter((step) => step.kind === 'relation') },
      { label: 'GRA', steps: plan.steps.filter((step) => step.kind === 'cascade') },
      { label: '元素', steps: plan.steps.filter((step) => step.kind === 'object') }
    ].filter((group) => group.steps.length);
    const items = groups.map((group, index) => {
      const states = group.steps.map((step) => stepProgressState(plan, step));
      const completed = states.filter((state) => ['passed', 'failed', 'skipped', 'uncertain'].includes(state)).length;
      const state = states.includes('uncertain') ? 'uncertain' : states.includes('failed') ? 'failed'
        : completed === group.steps.length ? 'passed' : states.includes('running') || completed ? 'running' : 'pending';
      return { itemId: `return-group-${index}`, label: group.label, state,
        detail: `${completed}/${group.steps.length}`, completed, total: group.steps.length,
        percent: group.steps.length ? Math.round(completed * 100 / group.steps.length) : 0 };
    });
    const completed = items.reduce((total, item) => total + item.completed, 0); const total = plan.steps.length;
    const state = plan.state === 'completed' ? 'passed' : plan.state === 'failed' ? 'failed' : plan.state === 'cancelled' ? 'skipped'
      : plan.state === 'uncertain' ? 'uncertain' : plan.state === 'executing' ? 'running' : 'pending';
    return { label: '冻结删除图', completed, total, percent: total ? Math.round(completed * 100 / total) : 0, state,
      message: plan.state === 'pending_confirmation' ? '计划已冻结，尚未提交任何 mutation。'
        : plan.state === 'uncertain' ? '只允许权威只读核验；不会自动重放 mutation。'
          : plan.state === 'completed' ? '所有 mutation、readback、投影与最终目录核验均已完成。'
            : plan.state === 'cancelled' ? '确认前已取消，没有提交 mutation。' : '请查看每个冻结步骤的真实结果。', items };
  }
  function preparationProgress(plan) {
    const preparation = plan.preparation || {}; const objectTotal = plan.targets.length;
    const graphKnown = Number(preparation.objectCursor || 0) === objectTotal;
    const graTotal = graphKnown ? (preparation.derivedGraSeeds || []).length : 0;
    const relationTotal = graphKnown ? (preparation.relationDescriptors || []).length : 0;
    const items = [
      { itemId: 'prepare-objects', label: '元素预检', completed: Number(preparation.objectCursor || 0), total: objectTotal },
      { itemId: 'prepare-gra', label: '派生 GRA 预检', completed: Number(preparation.derivedGraCursor || 0), total: graTotal },
      { itemId: 'prepare-relations', label: '关系组预检', completed: Number(preparation.relationCursor || 0), total: relationTotal }
    ].filter((item) => item.total > 0);
    for (const item of items) {
      item.percent = item.total ? Math.round(item.completed * 100 / item.total) : 0;
      item.state = preparation.failure && ((preparation.phase === 'object_preflight' && item.itemId === 'prepare-objects')
        || (preparation.phase === 'gra_preflight' && item.itemId === 'prepare-gra')
        || (preparation.phase === 'relation_preflight' && item.itemId === 'prepare-relations')) ? 'failed'
        : item.completed === item.total ? 'passed' : item.completed ? 'running' : 'pending';
      item.detail = `${item.completed}/${item.total}`;
    }
    const total = objectTotal + graTotal + relationTotal; const completed = Number(preparation.objectCursor || 0)
      + Number(preparation.derivedGraCursor || 0) + Number(preparation.relationCursor || 0);
    return { label: '分批冻结删除计划', completed, total, percent: total ? Math.round(completed * 100 / total) : 0,
      state: preparation.failure ? 'failed' : 'running',
      message: preparation.failure ? '当前只读批次失败；检查真实错误后可显式重试，同一批次不会推进或部分落盘。'
        : '每次最多执行 8 个同类只读预检；用户确认前 mutation 数为 0。', items };
  }
  function planSurface(plan) {
    const targetTypes = uniqueSorted(plan.targets.map((item) => item.objectType));
    const stepTypes = uniqueSorted(plan.steps.map((step) => step.kind === 'relation' ? '关系组' : step.kind === 'cascade' ? 'GRA 子图' : '元素'));
    const scopes = [
      { id: 'plan:root', parentId: null, kind: 'section', level: 1, label: '当前冻结计划', parentLabel: '删除计划', selected: true, initialExpanded: true, disabledReason: '' },
      { id: 'plan:targets', parentId: 'plan:root', kind: 'workspace', level: 2, label: '冻结目标', parentLabel: '当前冻结计划', selected: true, initialExpanded: true, disabledReason: '' },
      { id: 'plan:steps', parentId: 'plan:root', kind: 'workspace', level: 2, label: '图步骤与结果', parentLabel: '当前冻结计划', selected: true, initialExpanded: true, disabledReason: '' },
      ...targetTypes.map((type) => ({ id: `plan:target-type:${type}`, parentId: 'plan:targets', kind: 'element_type', level: 3,
        label: type, parentLabel: '冻结目标', selected: true, initialExpanded: true, disabledReason: '' })),
      ...stepTypes.map((type) => ({ id: `plan:step-type:${type}`, parentId: 'plan:steps', kind: 'element_type', level: 3,
        label: type, parentLabel: '图步骤与结果', selected: true, initialExpanded: true, disabledReason: '' }))
    ];
    const targetItems = plan.targets.map((item, index) => ({ id: `plan-target:${index}`, scopeId: `plan:target-type:${item.objectType}`, type: item.objectType,
      title: item.number || item.name || item.objectId,
      subtitle: `${item.name || item.number || item.objectId} · ${item.objectId} · Workspace ${item.workspace}`,
      selectable: false, disabledReason: '目标已冻结；不能在计划界面修改选择。', concurrencyToken: item.updatedAt }));
    const stepItems = plan.steps.map((step, index) => {
      const outcome = (plan.outcomes || []).find((candidate) => candidate.stepId === step.key); const state = stepProgressState(plan, step);
      const type = step.kind === 'relation' ? '关系组' : step.kind === 'cascade' ? 'GRA 子图' : '元素';
      const affected = step.kind === 'relation' ? `${uniqueSorted(step.request.targetObjectIds || [step.request.targetObjectId]).length} 个目标端点` : `${step.affectedTargetKeys.length} 个受影响目标`;
      return { id: `plan-step:${index}`, scopeId: `plan:step-type:${type}`, type,
        title: `步骤 ${index + 1} · ${step.objectType}`, subtitle: `${state} · ${affected} · ${step.key}${outcome && outcome.code ? ` · ${outcome.code}: ${outcome.message}` : ''}`,
        selectable: false, disabledReason: '冻结图步骤只由 Worker/Core 状态机推进。', concurrencyToken: outcome ? `${outcome.phase}:${outcome.state}` : 'frozen' };
    });
    const counts = (plan.results || []).reduce((value, result) => {
      if (result.state === 'deleted') value.deleted += 1; else if (result.state === 'skipped_dependency') value.skipped += 1;
      else if (result.state === 'uncertain') value.uncertain += 1; else value.failed += 1; return value;
    }, { deleted: 0, failed: 0, skipped: 0, uncertain: 0 });
    const preparing = plan.state === 'preparing'; const failure = preparing && plan.preparation && plan.preparation.failure;
    const statusMessage = preparing
      ? failure ? `状态 preparing · 只读冻结批次失败 · ${failure.code}: ${failure.message} · 游标保持在 ${failure.batchStart}，可显式重试或取消。`
        : `状态 preparing · ${plan.targets.length} 个目标已从未过期权威目录快照冻结 · 正在分批只读预检 · 用户确认前 mutation 数为 0。`
      : `状态 ${plan.state} · ${plan.targets.length} 个冻结目标 · ${plan.steps.length} 个图步骤 · 成功/失败/跳过/待核验 ${counts.deleted}/${counts.failed}/${counts.skipped}/${counts.uncertain} · 计划 ${plan.planDigest}`;
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', stateVersion: Number(plan.surfaceStateVersion || plan.stateVersion),
      status: failure ? 'error' : 'ready', statusMessage,
      scopes, items: [...targetItems, ...stepItems], selectedItemIds: [], search: '', progress: preparing ? preparationProgress(plan) : planProgress(plan), actions: planActionPatch(plan) };
  }
  function invocation(step, b, planDigest) { return { connectorBinding: b, planDigest, target: step.operationTarget, ...step.request }; }
  function readbackValid(step, value) {
    if (!value) return false;
    if (step.kind === 'relation') return value.relationGroupKey === step.key && value.relationType === step.request.relationType
      && value.source && value.source.objectId === step.request.sourceObjectId && value.source.objectType === step.request.sourceObjectType
      && canonical(value.targetObjectIds) === canonical(step.request.targetObjectIds)
      && Array.isArray(value.targets) && value.targets.length === step.request.targets.length
      && value.targets.every((target, index) => target.objectId === step.request.targets[index].objectId && target.objectType === 'APP'
        && target.associated === false && target.inconsistent === false && target.deleted === true)
      && value.deleted === true && value.associated === false && value.inconsistent === false;
    if (step.kind === 'cascade') return String(value.riskAssessmentId || value.objectId) === String(step.objectId)
      && value.objectType === 'GRA' && Array.isArray(value.workspaceIds) && value.workspaceIds.length === 1 && value.workspaceIds[0] === step.workspace
      && value.deleted === true && value.verifiedCascade === true && value.cascadeSnapshot && value.cascadeSnapshot.snapshotDigest === step.preflight.cascadeSnapshot.snapshotDigest;
    return String(value.objectId || value.informationId) === String(step.objectId) && value.objectType === step.objectType
      && Array.isArray(value.workspaceIds) && value.workspaceIds.length === 1 && value.workspaceIds[0] === step.workspace && value.deleted === true;
  }
  function readbackNotAppliedValid(step, value) {
    if (!value) return false;
    if (step.kind === 'relation') return value.relationGroupKey === step.key && value.relationType === step.request.relationType
      && value.source && value.source.objectId === step.request.sourceObjectId && value.source.objectType === step.request.sourceObjectType
      && canonical(value.targetObjectIds) === canonical(step.request.targetObjectIds)
      && Array.isArray(value.targets) && value.targets.length === step.request.targets.length
      && value.targets.every((target, index) => target.objectId === step.request.targets[index].objectId && target.objectType === 'APP'
        && target.associated === true && target.inconsistent === false && target.deleted === false)
      && value.associated === true && value.inconsistent === false && value.deleted === false;
    if (step.kind === 'cascade') {
      const observed = value.cascadeSnapshot; const frozen = step.preflight && step.preflight.cascadeSnapshot;
      const active = (items) => Array.isArray(items) && items.every((item) => item && item.deleted === false && item.absent !== true);
      const withoutState = (items) => items.map(({ deleted: _deleted, absent: _absent, ...item }) => item);
      return String(value.riskAssessmentId || value.objectId) === String(step.objectId) && value.objectType === 'GRA'
        && Array.isArray(value.workspaceIds) && value.workspaceIds.length === 1 && value.workspaceIds[0] === step.workspace && value.deleted === false
        && observed && frozen && observed.snapshotDigest === frozen.snapshotDigest && active(observed.risks) && active(observed.controls) && active(observed.riskControls)
        && digest({ schemaVersion: observed.schemaVersion, assessment: observed.assessment, risks: withoutState(observed.risks),
          controls: withoutState(observed.controls), riskControls: withoutState(observed.riskControls) }) === frozen.snapshotDigest;
    }
    return String(value.objectId || value.informationId) === String(step.objectId) && value.objectType === step.objectType
      && Array.isArray(value.workspaceIds) && value.workspaceIds.length === 1 && value.workspaceIds[0] === step.workspace && value.deleted === false;
  }
  async function verifyFrozen(plan, b, s) {
    const observed = [];
    for (const step of plan.steps) {
      let before;
      if (step.kind === 'object') {
        const selected = plan.targets.find((value) => value.objectId === step.objectId && value.objectType === step.objectType);
        before = normalizePreflight(await invoke(step.operations.preflight, invocation(step, b, plan.planDigest)), selected, s);
      } else before = await invoke(step.operations.preflight, invocation(step, b, plan.planDigest));
      if (digest(before) !== digest(step.preflight)) fail('DELETE.PREFLIGHT_DRIFT', `Frozen graph/token changed: ${step.key}`);
      observed.push({ key: step.key, preflight: before });
    }
    if (digest({ compilationDigest: plan.preparation && plan.preparation.compilationDigest,
      preflights: observed, scheduleGraph: plan.scheduleGraph }) !== plan.graphDigest) fail('DELETE.GRAPH_DRIFT', 'Complete graph digest changed after confirmation.');
  }
  async function invalidatePendingPlan(plan, error, eventType) {
    const failure = errorSummary(error); const run = owned(await store.call('loadLatestRun', {}), plan);
    const returned = await store.call('returnRunToReview', { runId: plan.runId, expectedRevision: Number(run.state_revision) });
    await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(returned.stateRevision), toState: 'cancelled',
      eventType, error: `${failure.code}: ${failure.message}` });
    plan.state = 'cancelled'; plan.stateVersion += 1; plan.invalidatedReason = `${failure.code}: ${failure.message}`; await save(plan); return plan;
  }
  async function cancelPreparingPlan(plan, error, expectedSurfaceStateVersion) {
    if (!plan || plan.state !== 'preparing') fail('DELETE.CANCEL_INVALID', 'Only a preparing plan can use the ready-for-review cancellation path.');
    if (Number(expectedSurfaceStateVersion) !== Number(plan.surfaceStateVersion)) fail('DELETE.PREPARATION_STALE', 'Delete preparation Surface revision is stale.');
    const failure = errorSummary(error); const run = owned(await store.call('loadLatestRun', {}), plan);
    if (String(run.state) !== 'ready_for_review') fail('DELETE.CANCEL_CORE_STATE_DRIFT', 'Preparing Delete Core Run is no longer ready_for_review.');
    await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(run.state_revision), toState: 'cancelled',
      eventType: 'delete.preparation_cancelled', error: `${failure.code}: ${failure.message}` });
    plan.state = 'cancelled'; plan.stateVersion = Number(run.state_revision) + 1;
    plan.surfaceStateVersion = Number(plan.surfaceStateVersion) + 1; plan.invalidatedReason = `${failure.code}: ${failure.message}`;
    await save(plan); return plan;
  }
  async function failPlan(plan, error) {
    const failure = errorSummary(error);
    try {
      await store.call('finishReturn', { runId: plan.runId, outcome: 'failed', error: `${failure.code}: ${failure.message}` });
    } catch (completionError) {
      let verifiedFailed = false;
      try {
        const run = owned(await store.call('loadLatestRun', {}), plan);
        verifiedFailed = String(run.state) === 'failed';
      } catch { /* preserve the original Core completion uncertainty */ }
      if (!verifiedFailed) {
        plan.state = 'uncertain'; plan.stateVersion += 1;
        plan.uncertain = { phase: 'core_terminal', terminal: 'failed', failure, completionFailure: errorSummary(completionError) };
        await save(plan); return plan;
      }
    }
    delete plan.uncertain; plan.failure = failure; plan.state = 'failed'; plan.stateVersion += 1; await save(plan); return plan;
  }
  function outcomeResult(plan, outcome) {
    const step = plan.steps.find((candidate) => candidate.key === outcome.stepId);
    return { key: outcome.stepId, kind: step && step.kind || '', objectId: step && step.objectId || '', objectType: step && step.objectType || '',
      state: outcome.state === 'succeeded' ? 'deleted' : outcome.state === 'skipped' ? 'skipped_dependency' : outcome.state,
      commandId: outcome.commandId || '', code: outcome.code || '', error: outcome.message || '' };
  }
  async function persistOutcome(plan, step, state, phase, error = null, commandId = '', persist = true) {
    const failure = error ? errorSummary(error) : { code: '', message: '' };
    const outcome = { stepId: step.key, state, phase: String(phase || ''), commandId: String(commandId || ''), code: failure.code, message: failure.message };
    const existing = (plan.outcomes || []).findIndex((candidate) => candidate.stepId === step.key);
    if (existing >= 0) {
      if (plan.outcomes[existing].state !== 'uncertain' || !['succeeded', 'failed', 'uncertain'].includes(state)) fail('DELETE.OUTCOME_CONFLICT', 'Deletion outcome is already terminal.');
      plan.outcomes[existing] = outcome;
    } else plan.outcomes.push(outcome);
    const order = new Map(plan.scheduleGraph.map((candidate, index) => [candidate.stepId, index]));
    plan.outcomes.sort((left, right) => order.get(left.stepId) - order.get(right.stepId));
    plan.results = plan.outcomes.map((value) => outcomeResult(plan, value)); plan.nextIndex = plan.outcomes.length;
    if (persist) await save(plan); return outcome;
  }
  async function schedule(plan) {
    if (!Array.isArray(plan.scheduleGraph) || !Array.isArray(plan.outcomes)) fail('DELETE.SCHEDULER_STATE_MISSING', 'Frozen Python scheduler graph or durable outcome ledger is missing.');
    const value = await deletionScheduler().invoke('schedule_deletion', { schemaVersion: 'omnia.delete-scheduler-input/v1', planId: plan.planId, runId: plan.runId,
      steps: plan.scheduleGraph, outcomes: plan.outcomes, concurrencyBudget: 1 }, { runId: plan.runId });
    const ids = new Set(plan.scheduleGraph.map((step) => step.stepId)); const outcomeIds = new Set(plan.outcomes.map((outcome) => outcome.stepId));
    if (!value || value.schemaVersion !== 'omnia.delete-scheduler-decision/v1' || value.planId !== plan.planId || value.runId !== plan.runId
      || !Array.isArray(value.readyStepIds) || !Array.isArray(value.skipStepIds) || !value.counts || typeof value.counts !== 'object'
      || !['running', 'succeeded', 'failed', 'uncertain'].includes(value.terminal) || !/^[0-9a-f]{64}$/u.test(String(value.ledgerDigest || ''))
      || value.readyStepIds.length > 1 || new Set(value.readyStepIds).size !== value.readyStepIds.length || new Set(value.skipStepIds).size !== value.skipStepIds.length
      || value.readyStepIds.some((id) => !ids.has(id) || outcomeIds.has(id)) || value.skipStepIds.some((id) => !ids.has(id) || outcomeIds.has(id) || value.readyStepIds.includes(id))
      || ['total', 'pending', 'ready', 'succeeded', 'failed', 'skipped', 'uncertain'].some((key) => !Number.isSafeInteger(value.counts[key]) || value.counts[key] < 0)
      || value.counts.total !== plan.scheduleGraph.length) fail('DELETE.SCHEDULER_OUTPUT_INVALID', 'Managed Python scheduler returned an invalid decision.');
    return value;
  }
  function owned(value, plan) {
    const run = value && value.run ? value.run : value;
    if (!run || String(run.run_id) !== String(plan.runId)) fail('DELETE.RUN_IDENTITY_DRIFT', 'Core Run differs from deletion plan.');
    return run;
  }
  async function markUncertain(plan, step, commandId, intent, phase, error) {
    try { await store.call('recordReturnEvidence', { runId: plan.runId, commandId, evidenceType: 'commit', commandState: 'uncertain', payload: { code: String(error && error.code || 'DELETE.RESULT_UNCERTAIN') } }); } catch {}
    try { await store.call('finishReturn', { runId: plan.runId, outcome: 'uncertain', error: String(error && error.message || error) }); } catch {}
    await persistOutcome(plan, step, 'uncertain', phase, error, commandId, false);
    plan.state = 'uncertain'; plan.stateVersion += 1; plan.uncertain = { stepId: step.key, commandId, intent, phase }; await save(plan); return plan;
  }
  async function projectVerified(plan, step, commandId, b) {
    if (step.kind === 'cascade') {
      return store.call('projectVerifiedDeletionCascade', { runId: plan.runId, commandId, binding: b, workspaceId: step.workspace,
        targetKey: step.key, cascadeType: 'GRA', objectType: 'GRA', objectId: step.objectId });
    }
    return store.call('projectVerifiedDeletion', { runId: plan.runId, commandId, binding: b, workspaceId: step.workspace,
      ...(step.kind === 'relation' ? { relationType: step.request.relationType, relationKey: step.key,
        sourceObjectId: step.request.sourceObjectId, targetObjectId: uniqueSorted(step.request.targetObjectIds || [step.request.targetObjectId])[0] }
        : { objectType: step.objectType, objectId: step.objectId }) });
  }
  async function emitAuthoritativeRefresh(plan, b, s) {
    try {
      await events.emit({ type: 'workspace.authoritative_refresh_requested', featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
        engagementId: b.engagementId, workspaceIds: s.allowedWorkspaceIds, runId: plan.runId });
    } catch {}
  }
  async function finishAfterFinalRecapture(plan, context, terminal) {
    let recaptured;
    try { recaptured = await recaptureFinalCatalog(plan, context); }
    catch (error) {
      const failure = errorSummary(error);
      plan.finalVerification = { schemaVersion: 'omnia.delete-final-catalog-verification/v1', state: 'pending', attemptedAt: new Date().toISOString(), error: failure };
      plan.uncertain = { phase: 'final_catalog', terminal }; plan.state = 'uncertain'; plan.stateVersion += 1; await save(plan);
      await emitAuthoritativeRefresh(plan, plan.binding, plan.safety); return plan;
    }
    const succeeded = terminal === 'succeeded';
    try {
      await store.call('finishReturn', { runId: plan.runId, outcome: succeeded ? 'succeeded' : 'failed',
        ...(succeeded ? {} : { error: 'One or more deletion graph steps failed or were skipped.' }) });
    } catch (error) {
      try {
        const run = owned(await store.call('loadLatestRun', {}), plan);
        const expectedCoreState = succeeded ? 'succeeded' : 'failed';
        if (String(run.state) === expectedCoreState) {
          delete plan.uncertain; plan.finalVerification = recaptured.verification;
          plan.state = succeeded ? 'completed' : 'failed'; plan.stateVersion += 1; await save(plan);
          await emitAuthoritativeRefresh(plan, recaptured.b, recaptured.s); return plan;
        }
      } catch { /* preserve the original completion failure below */ }
      const failure = errorSummary(error);
      plan.finalVerification = { ...recaptured.verification, state: 'pending', error: failure };
      plan.uncertain = { phase: 'final_catalog', terminal }; plan.state = 'uncertain'; plan.stateVersion += 1; await save(plan);
      await emitAuthoritativeRefresh(plan, recaptured.b, recaptured.s); return plan;
    }
    delete plan.uncertain; plan.finalVerification = recaptured.verification;
    plan.state = succeeded ? 'completed' : 'failed'; plan.stateVersion += 1; await save(plan);
    await emitAuthoritativeRefresh(plan, recaptured.b, recaptured.s); return plan;
  }
  async function execute(plan, context, verifyWholeGraph) {
    let b; let s;
    try {
      b = binding(context.connectorBinding); s = safety(context.safetyLock, b.engagementId); assertSameAuthority(b, s);
      await store.call('validateReturnAuthority', { runId: plan.runId, connectorBinding: b, safetyLock: s });
      if (verifyWholeGraph) await verifyFrozen(plan, b, s);
    } catch (error) {
      await failPlan(plan, error); return plan;
    }
    plan.state = 'executing'; plan.stateVersion += 1; await save(plan);
    while (true) {
      let decision;
      try { decision = await schedule(plan); }
      catch (error) { await failPlan(plan, error); await emitAuthoritativeRefresh(plan, b, s); return plan; }
      if (decision.skipStepIds.length) {
        for (const stepId of decision.skipStepIds) {
          const step = plan.steps.find((candidate) => candidate.key === stepId);
          if (!step) fail('DELETE.SCHEDULER_OUTPUT_INVALID', 'Python scheduler selected an unknown dependency skip.');
          await persistOutcome(plan, step, 'skipped', 'dependency', Object.assign(new Error('A prerequisite graph step failed; no mutation was attempted.'), { code: 'DELETE.DEPENDENCY_FAILED' }));
        }
        continue;
      }
      if (decision.terminal !== 'running') {
        if (decision.terminal === 'uncertain') {
          const outcome = plan.outcomes.find((candidate) => candidate.state === 'uncertain');
          const intent = outcome && plan.intents.find((candidate) => candidate.key === outcome.stepId);
          if (!outcome || !intent || !outcome.commandId) {
            const error = Object.assign(new Error('Durable uncertain scheduler state has no exact reconcile identity.'), { code: 'DELETE.UNCERTAIN_STATE_INVALID' });
            await failPlan(plan, error); await emitAuthoritativeRefresh(plan, b, s); return plan;
          }
          plan.uncertain = { stepId: outcome.stepId, commandId: outcome.commandId, intent, phase: outcome.phase };
          plan.state = 'uncertain'; plan.stateVersion += 1; await save(plan); return plan;
        }
        return finishAfterFinalRecapture(plan, context, decision.terminal);
      }
      if (decision.readyStepIds.length !== 1) {
        const error = Object.assign(new Error('Python scheduler reported a running plan without exactly one ready step.'), { code: 'DELETE.SCHEDULER_STALLED' });
        await failPlan(plan, error); await emitAuthoritativeRefresh(plan, b, s); return plan;
      }
      const step = plan.steps.find((candidate) => candidate.key === decision.readyStepIds[0]);
      const intent = plan.intents.find((candidate) => candidate.key === decision.readyStepIds[0]);
      if (!step || !intent) {
        const error = Object.assign(new Error('Python scheduler selected a step absent from the frozen Worker plan.'), { code: 'DELETE.SCHEDULER_OUTPUT_INVALID' });
        await failPlan(plan, error); await emitAuthoritativeRefresh(plan, b, s); return plan;
      }
      try {
        if (step.kind === 'object') {
          const selected = plan.targets.find((value) => value.objectId === step.objectId && value.objectType === step.objectType);
          const before = normalizePreflight(await invoke(step.operations.preflight, invocation(step, b, plan.planDigest)), selected, s);
          if (before.updatedAt !== step.preflight.updatedAt) fail('DELETE.PREFLIGHT_DRIFT', `Object token changed before mutation: ${step.key}`);
          if (before.blockers.length || before.relations.length) fail('DELETE.GRAPH_NOT_CLEARED', `Planned dependencies remain for ${step.key}.`);
          if (before.riskAssessmentId) {
            const graStep = plan.steps.find((candidate) => candidate.kind === 'cascade' && candidate.objectId === before.riskAssessmentId
              && candidate.affectedTargetKeys.includes(step.key));
            const graOutcome = graStep && plan.outcomes.find((candidate) => candidate.stepId === graStep.key);
            if (!graStep || !graOutcome || graOutcome.state !== 'succeeded') {
              fail('DELETE.GRA_DRIFT', `An unverified active GRA appeared before object deletion: ${step.key}`);
            }
          }
        } else if (step.kind === 'cascade') {
          const before = await invoke(step.operations.preflight, invocation(step, b, plan.planDigest));
          if (digest(before) !== digest(step.preflight)) fail('DELETE.PREFLIGHT_DRIFT', `GRA cascade changed before mutation: ${step.key}`);
        } else {
          const before = await invoke(step.operations.preflight, invocation(step, b, plan.planDigest));
          if (digest(before) !== digest(step.preflight)) fail('DELETE.PREFLIGHT_DRIFT', `Relation changed before mutation: ${step.key}`);
        }
      } catch (error) {
        await persistOutcome(plan, step, 'failed', 'preflight', error); continue;
      }

      let command;
      try {
        command = await store.call('prepareDeletionCommand', { runId: plan.runId, planDigest: plan.planDigest, targetKind: intent.kind, targetKey: intent.key,
          workspaceId: intent.workspace, binding: b, workspaceIds: s.workspaceIds, operationId: step.operations.direct, request: intent.mutationPayload,
          evidenceOperationIds: intent.evidenceOperationIds, evidenceTargetIdentityKey: intent.operationTargetIdentityKey });
      } catch (error) {
        await persistOutcome(plan, step, 'failed', 'command_prepare', error); continue;
      }
      try {
        await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId, evidenceType: 'request', commandState: 'submitted', payload: { operationId: step.operations.direct } });
      } catch (error) {
        let closed = false;
        try {
          await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId, evidenceType: 'request', commandState: 'failed',
            payload: { code: String(error && error.code || 'DELETE.REQUEST_EVIDENCE_FAILED') }, error: String(error && error.message || error) });
          closed = true;
        } catch {}
        if (!closed) {
          await failPlan(plan, error); await emitAuthoritativeRefresh(plan, b, s); return plan;
        }
        await persistOutcome(plan, step, 'failed', 'before_mutation', error, command.commandId); continue;
      }
      let response;
      try {
        response = await invoke(step.operations.direct, { connectorBinding: b, planDigest: plan.planDigest, target: step.operationTarget,
          command: { commandId: command.commandId, idempotencyKey: command.idempotencyKey, payload: intent.mutationPayload }, ...step.request });
      } catch (error) { return markUncertain(plan, step, command.commandId, intent, 'submitted', error); }
      try { await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId, evidenceType: 'commit', commandState: 'committed', payload: response }); }
      catch (error) { return markUncertain(plan, step, command.commandId, intent, 'committed', error); }
      const readRequest = { connectorBinding: b, target: step.operationTarget, ...step.request }; let observed;
      try {
        await store.call('freezeReturnEvidenceSpec', { runId: plan.runId, commandId: command.commandId, operationId: step.operations.reconcile, request: readRequest });
        observed = await invoke(step.operations.reconcile, { ...readRequest, receiptContext: { runId: plan.runId, commandId: command.commandId } });
        if (!readbackValid(step, observed)) fail('DELETE.READBACK_PENDING', 'Readback does not prove the complete frozen graph step; mutation is not replayed.');
        await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId, evidenceType: 'readback', commandState: 'readback_verified',
          payload: observed, receiptId: observed.__operationReceiptId });
      } catch (error) { return markUncertain(plan, step, command.commandId, intent, 'readback', error); }
      try { await projectVerified(plan, step, command.commandId, b); }
      catch (error) { return markUncertain(plan, step, command.commandId, intent, 'projection', error); }
      await persistOutcome(plan, step, 'succeeded', 'readback_verified', null, command.commandId);
    }
  }
  async function confirm(plan, context, expected) {
    if (!plan) fail('DELETE.CONFIRMATION_STALE', 'Delete confirmation is stale.');
    const expectedProjectionVersion = Number(plan.surfaceStateVersion || plan.stateVersion);
    if (plan.state !== 'pending_confirmation' || Number(expected) !== expectedProjectionVersion) fail('DELETE.CONFIRMATION_STALE', 'Delete confirmation is stale.');
    let b; let s;
    try {
      b = binding(context.connectorBinding); s = safety(context.safetyLock, b.engagementId); assertSameAuthority(b, s);
      const expiresAt = Date.parse(String(plan.expiresAt || ''));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) fail('DELETE.CONFIRMATION_EXPIRED', 'Delete confirmation expired or has no frozen Core expiry.');
      await verifyFrozen(plan, b, s);
    } catch (error) { return invalidatePendingPlan(plan, error, 'delete.confirmation_invalidated'); }
    try {
      await store.call('approveReturnIntent', { confirmationId: plan.confirmationId, confirmationToken: plan.confirmationToken,
        expectedStateVersion: Number(plan.stateVersion), connectorBinding: b, safetyLock: s });
    } catch (error) { return invalidatePendingPlan(plan, error, 'delete.confirmation_invalidated'); }
    return execute(plan, context, false);
  }
  async function reconcile(plan, context) {
    if (!plan || plan.state !== 'uncertain' || !plan.uncertain) fail('DELETE.RECONCILE_INVALID', 'No uncertain command is available.');
    const b = binding(context.connectorBinding); const s = safety(context.safetyLock, b.engagementId); assertSameAuthority(b, s);
    if (plan.uncertain.phase === 'final_catalog') {
      const terminal = String(plan.uncertain.terminal || '');
      if (!['succeeded', 'failed'].includes(terminal)) fail('DELETE.RECONCILE_INVALID', 'Final catalog reconcile has no frozen terminal outcome.');
      plan.state = 'executing'; plan.stateVersion += 1; await save(plan);
      return finishAfterFinalRecapture(plan, context, terminal);
    }
    if (plan.uncertain.phase === 'core_terminal') {
      if (String(plan.uncertain.terminal || '') !== 'failed') fail('DELETE.RECONCILE_INVALID', 'Core terminal reconcile has no frozen failed outcome.');
      let verifiedFailed = false; let completionError = null;
      try {
        const failure = plan.uncertain.failure || { code: 'DELETE.STEP_FAILED', message: 'Deletion plan failed before a verified Core terminal state.' };
        await store.call('finishReturn', { runId: plan.runId, outcome: 'failed', error: `${failure.code}: ${failure.message}` });
        verifiedFailed = true;
      } catch (error) {
        completionError = error;
        try {
          const run = owned(await store.call('loadLatestRun', {}), plan);
          verifiedFailed = String(run.state) === 'failed';
        } catch { /* keep the plan uncertain below */ }
      }
      if (!verifiedFailed) {
        plan.uncertain = { ...plan.uncertain, completionFailure: errorSummary(completionError) };
        plan.stateVersion += 1; await save(plan); return plan;
      }
      const failure = plan.uncertain.failure; delete plan.uncertain; plan.failure = failure;
      plan.state = 'failed'; plan.stateVersion += 1; await save(plan); await emitAuthoritativeRefresh(plan, b, s); return plan;
    }
    const run = owned(await store.call('loadLatestRun', {}), plan);
    await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(run.state_revision), toState: 'reconciling', eventType: 'delete.reconcile_started' });
    const step = plan.steps.find((candidate) => candidate.key === plan.uncertain.stepId); const intent = plan.uncertain.intent;
    const commandId = plan.uncertain.commandId; const reconcilePhase = plan.uncertain.phase;
    if (!step) fail('DELETE.RECONCILE_INVALID', 'Uncertain step is absent from the frozen plan.');
    const readRequest = { connectorBinding: b, target: step.operationTarget, ...step.request };
    try {
      if (reconcilePhase === 'projection') {
        await projectVerified(plan, step, commandId, b);
        await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(run.state_revision) + 1, toState: 'returning', eventType: 'return.reconcile_resolved' });
        await persistOutcome(plan, step, 'succeeded', 'reconciled_projection', null, commandId, false); delete plan.uncertain; await save(plan);
      } else {
        await store.call('freezeReturnEvidenceSpec', { runId: plan.runId, commandId, operationId: step.operations.reconcile, request: readRequest });
        const observed = await invoke(step.operations.reconcile, { ...readRequest, receiptContext: { runId: plan.runId, commandId } });
        const applied = readbackValid(step, observed); const notApplied = readbackNotAppliedValid(step, observed);
        if (!applied && !notApplied) fail('DELETE.READBACK_PENDING', 'Read-only reconcile cannot prove whether the frozen graph step was applied.');
        await store.call('recordReturnEvidence', { runId: plan.runId, commandId, evidenceType: 'reconcile',
          commandState: applied ? 'readback_verified' : 'closed_not_applied', payload: observed, receiptId: observed.__operationReceiptId,
          verified: applied, error: applied ? '' : 'Authoritative reconcile proved the uncertain deletion mutation was not applied.' });
        if (applied) await projectVerified(plan, step, commandId, b);
        await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(run.state_revision) + 1, toState: 'returning',
          eventType: applied ? 'return.reconcile_resolved' : 'return.reconcile_not_applied', details: { applied } });
        await persistOutcome(plan, step, applied ? 'succeeded' : 'failed', applied ? 'reconciled_readback' : 'reconciled_not_applied',
          applied ? null : Object.assign(new Error('Authoritative reconcile proved the deletion mutation was not applied.'), { code: 'DELETE.NOT_APPLIED' }), commandId, false);
        delete plan.uncertain; await save(plan);
      }
    } catch (error) { return markUncertain(plan, step, commandId, intent, reconcilePhase, error); }
    return execute(plan, context, false);
  }
  async function handleAction(input) {
    const context = input.context || {};
    if (input.actionId === 'refresh-on-reopen') return { surfacePatch: await reopenProjection(context) };
    if (input.actionId === 'bootstrap-authoritative-catalog' || input.actionId === 'refresh-authoritative-catalog') return { surfacePatch: await refreshProjection(context) };
    if (input.actionId === 'create-delete-plan') {
      const plan = await createPlan(context, input.payload && input.payload.targetIds, input.expectedStateVersion);
      return { surfacePatch: planSurface(plan) };
    }
    let requestedRunId = String(input.payload && input.payload.runId || '');
    if (!requestedRunId) {
      const latest = await store.call('loadLatestRun', {}); const run = latest && latest.run ? latest.run : latest;
      requestedRunId = String(run && run.run_id || '');
    }
    const plan = await load(requestedRunId); if (!plan) fail('DELETE.PLAN_NOT_FOUND', 'Delete plan was not found.');
    if (['continue-delete-plan-preparation', 'retry-delete-plan-preparation'].includes(input.actionId)) {
      if (plan.state !== 'preparing') fail('DELETE.PREPARATION_INVALID', 'No preparing deletion plan is available.');
      if (Number(input.expectedStateVersion) !== Number(plan.surfaceStateVersion)) fail('DELETE.PREPARATION_STALE', 'Delete preparation Surface revision is stale.');
      const failed = Boolean(plan.preparation && plan.preparation.failure);
      if (input.actionId === 'continue-delete-plan-preparation' && failed) fail('DELETE.PREPARATION_RETRY_REQUIRED', 'The failed read-only batch requires explicit retry.');
      if (input.actionId === 'retry-delete-plan-preparation' && !failed) fail('DELETE.PREPARATION_RETRY_INVALID', 'No failed read-only batch is available for retry.');
      const result = await continuePlanPreparation(plan, context);
      return { surfacePatch: planSurface(result) };
    }
    const legacyPlan = String(plan.featureVersion || '') !== FEATURE_VERSION || !Number.isSafeInteger(Number(plan.surfaceStateVersion));
    if (legacyPlan && ['cancel-delete-plan', 'confirm-delete-plan'].includes(input.actionId)) {
      if (plan.state !== 'pending_confirmation') fail('DELETE.CANCEL_INVALID', 'Only an unconfirmed legacy plan can be migrated.');
      const result = await invalidatePendingPlan(plan, Object.assign(new Error('The 0.3.14 Comments plan was cancelled during the one-time Feature-surface migration; no mutation was submitted.'), { code: 'DELETE.LEGACY_PLAN_MIGRATED' }),
        'delete.legacy_comments_plan_migrated');
      result.surfaceStateVersion = Number(input.expectedStateVersion) + 1; await save(result);
      return { surfacePatch: planSurface(result) };
    }
    if (input.actionId === 'cancel-delete-plan') {
      if (plan.state === 'preparing') {
        const result = await cancelPreparingPlan(plan, Object.assign(new Error('User cancelled deletion plan preparation before confirmation or mutation.'), { code: 'DELETE.USER_CANCELLED' }), input.expectedStateVersion);
        return { surfacePatch: planSurface(result) };
      }
      if (plan.state !== 'pending_confirmation') fail('DELETE.CANCEL_INVALID', 'Only a preparing or unconfirmed plan can be cancelled.');
      const result = await invalidatePendingPlan(plan, Object.assign(new Error('User cancelled the frozen deletion plan before mutation.'), { code: 'DELETE.USER_CANCELLED' }),
        'delete.cancelled_in_feature');
      result.surfaceStateVersion = Number(input.expectedStateVersion) + 1; await save(result);
      return { surfacePatch: planSurface(result) };
    }
    if (input.actionId === 'confirm-delete-plan') {
      const result = await confirm(plan, context, input.expectedStateVersion);
      result.surfaceStateVersion = Number(input.expectedStateVersion) + 1; await save(result);
      return { surfacePatch: planSurface(result) };
    }
    if (input.actionId === 'reconcile-delete-plan') {
      const result = await reconcile(plan, context); result.surfaceStateVersion = Number(input.expectedStateVersion) + 1; await save(result);
      return { surfacePatch: planSurface(result) };
    }
    fail('DELETE.ACTION_UNKNOWN', 'Action is not implemented.');
  }
  async function health() {
    try {
      await deletionScheduler().start();
      return { schemaVersion: 'omnia.feature-worker-health/v1', featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
        ready: true, mutationEnabled: true, requiresConnector: true, requiresSafetyLock: true, supportedTransports: ['remote'],
        python: { implementation: 'cpython', version: '3.13.14', scheduler: 'ready' } };
    } catch (error) {
      const failure = errorSummary(error);
      return { schemaVersion: 'omnia.feature-worker-health/v1', featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
        ready: false, mutationEnabled: false, requiresConnector: true, requiresSafetyLock: true, supportedTransports: ['remote'],
        reason: `${failure.code}: ${failure.message}`, python: { implementation: 'cpython', version: '3.13.14', scheduler: 'failed' } };
    }
  }
  return Object.freeze({ health, shutdown: () => scheduler ? scheduler.close() : undefined, refreshCatalog: refresh, handleAction });
}

module.exports = Object.freeze({ createFeatureWorker, createDeleteElementsWorker: createFeatureWorker, FEATURE_ID, FEATURE_VERSION, OPERATIONS,
  finalCatalogVerification, frozenSafetyMatches });
