'use strict';

const crypto = require('node:crypto');
const { createPythonSidecarBridge } = require('./workpaper-preparation-python-bridge.cjs');

const FEATURE_ID = 'omnia.workpaper-preparation';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const CURRENT_POINTER = 'workpaper:current';
const OPERATIONS = Object.freeze({
  directory: 'omnia.workpaper.directory.read.v1',
  controls: 'omnia.workpaper.controls.read.v1',
  preflight: 'omnia.workpaper.control.preflight.v1',
  direct: 'omnia.workpaper.control.open-hidden-tab.v1',
  reconcile: 'omnia.workpaper.control.reconcile.v1'
});

function canonicalWorkpaperState(value) {
  function encodeWorkpaperNode(node) {
    if (node === null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
      return JSON.stringify(node);
    }
    if (Array.isArray(node)) return `[${node.map(encodeWorkpaperNode).join(',')}]`;
    if (!node || typeof node !== 'object') throw new Error('Workpaper state contains a non-JSON value.');
    const fields = Object.keys(node).sort().map((key) => `${JSON.stringify(key)}:${encodeWorkpaperNode(node[key])}`);
    return `{${fields.join(',')}}`;
  }
  return encodeWorkpaperNode(value);
}
function digest(value) { return crypto.createHash('sha256').update(canonicalWorkpaperState(value)).digest('hex'); }
function text(value) { return String(value == null ? '' : value).trim(); }
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function required(value, label) {
  const result = text(value);
  if (!result || result.length > 800) fail('WORKPAPER.INVALID_INPUT', `${label} is invalid.`);
  return result;
}
function optional(value, label) {
  const result = text(value);
  if (result.length > 800) fail('WORKPAPER.INVALID_INPUT', `${label} is invalid.`);
  return result;
}
function unique(values) { return [...new Set((values || []).map(text).filter(Boolean))].sort(); }
function errorSummary(error) {
  return { code: text(error && error.code || 'WORKPAPER.FAILED').slice(0, 160),
    message: text(error && error.message || error || 'Workpaper preparation failed.').slice(0, 800) };
}
function binding(value) {
  if (!value || typeof value !== 'object') fail('WORKPAPER.BINDING_REQUIRED', 'Connector binding is required.');
  const result = {
    connectorId: required(value.connectorId, 'connectorId'), sessionGeneration: Number(value.sessionGeneration),
    engagementId: required(value.engagementId, 'engagementId'), authorityInstanceId: required(value.authorityInstanceId, 'authorityInstanceId'),
    tenantOrOrgId: optional(value.tenantOrOrgId, 'tenantOrOrgId'), packId: required(value.packId, 'packId')
  };
  if (!Number.isSafeInteger(result.sessionGeneration) || result.sessionGeneration < 1) fail('WORKPAPER.BINDING_INVALID', 'Session generation is invalid.');
  return Object.freeze(result);
}
function safety(value, engagementId) {
  if (!value || value.enabled !== true || value.validForCurrentConnection !== true) {
    fail('WORKPAPER.SAFETY_REQUIRED', text(value && value.invalidReason || 'An enabled current safety lock is required.'));
  }
  if (text(value.engagementId) !== engagementId || !Number.isSafeInteger(Number(value.stateVersion)) || Number(value.stateVersion) < 1) {
    fail('WORKPAPER.SAFETY_DRIFT', 'Safety lock binding is invalid.');
  }
  const workspaceIds = unique(value.workspaceIds);
  if (!workspaceIds.length) fail('WORKPAPER.SAFETY_EMPTY', 'Safety lock has no explicit Workspace.');
  return Object.freeze({
    enabled: true, validForCurrentConnection: true, globalEnabled: value.globalEnabled === true,
    globalSectionIds: unique(value.globalSectionIds), globalWorkspaceIds: value.globalEnabled === true ? unique(value.globalWorkspaceIds) : [],
    connectorId: required(value.connectorId, 'safety.connectorId'), sessionGeneration: Number(value.sessionGeneration),
    authorityInstanceId: required(value.authorityInstanceId, 'safety.authorityInstanceId'), tenantOrOrgId: optional(value.tenantOrOrgId, 'safety.tenantOrOrgId'),
    packId: required(value.packId, 'safety.packId'), engagementId, stateVersion: Number(value.stateVersion),
    authorityObservationId: required(value.authorityObservationId, 'safety.authorityObservationId'), workspaceIds
  });
}
function sameAuthority(current, frozen) {
  for (const key of ['connectorId', 'sessionGeneration', 'engagementId', 'authorityInstanceId', 'tenantOrOrgId', 'packId']) {
    if (String(current[key]) !== String(frozen[key])) fail('WORKPAPER.AUTHORITY_DRIFT', `Current ${key} differs from the frozen authority.`);
  }
}
function sameSafety(current, frozen) {
  if (Number(current.stateVersion) !== Number(frozen.stateVersion)
    || current.authorityObservationId !== frozen.authorityObservationId
    || canonicalWorkpaperState(current.workspaceIds) !== canonicalWorkpaperState(frozen.workspaceIds)
    || canonicalWorkpaperState(current.globalSectionIds) !== canonicalWorkpaperState(frozen.globalSectionIds)
    || canonicalWorkpaperState(current.globalWorkspaceIds) !== canonicalWorkpaperState(frozen.globalWorkspaceIds)) {
    fail('WORKPAPER.SAFETY_DRIFT', 'Current safety lock differs from the frozen plan.');
  }
}
function credentialDigest(b, s) {
  return digest({ connectorId: b.connectorId, sessionGeneration: b.sessionGeneration, engagementId: b.engagementId,
    authorityInstanceId: b.authorityInstanceId, tenantOrOrgId: b.tenantOrOrgId, packId: b.packId, workspaceIds: s.workspaceIds });
}
function normalizeGra(value, allowedWorkspaces) {
  const item = {
    riskAssessmentId: required(value && value.riskAssessmentId, 'riskAssessmentId'),
    graWorkItemId: required(value && value.graWorkItemId, 'graWorkItemId'),
    appId: required(value && value.appId, 'appId'), appWorkItemId: required(value && value.appWorkItemId, 'appWorkItemId'),
    workspaceId: required(value && value.workspaceId, 'workspaceId'), workspaceName: required(value && value.workspaceName, 'workspaceName'),
    graName: required(value && value.graName, 'graName'), graReferenceNumber: optional(value && value.graReferenceNumber, 'graReferenceNumber'),
    graStatus: optional(value && value.graStatus, 'graStatus'), graUpdatedOn: optional(value && value.graUpdatedOn, 'graUpdatedOn'),
    appName: required(value && value.appName, 'appName'), appNumber: optional(value && value.appNumber, 'appNumber'),
    graType: 'Application'
  };
  if (!allowedWorkspaces.includes(item.workspaceId)) fail('WORKPAPER.OUTSIDE_SAFETY', 'APP GRA is outside the explicit safety Workspace scope.');
  return item;
}
function normalizeDirectory(value, b, s) {
  if (!value || value.connectorId !== b.connectorId || Number(value.sessionGeneration) !== b.sessionGeneration
    || value.engagementId !== b.engagementId || value.authorityInstanceId !== b.authorityInstanceId
    || text(value.tenantOrOrgId) !== b.tenantOrOrgId || value.packId !== b.packId
    || !Array.isArray(value.workspaces) || !Array.isArray(value.gras) || value.gras.length > 500) {
    fail('WORKPAPER.DIRECTORY_INVALID', 'APP GRA directory differs from the current signed authority.');
  }
  const workspaces = value.workspaces.map((item) => ({ id: required(item && item.id, 'workspace.id'), name: required(item && item.name, 'workspace.name') }));
  if (workspaces.length !== s.workspaceIds.length || canonicalWorkpaperState(unique(workspaces.map((item) => item.id))) !== canonicalWorkpaperState(s.workspaceIds)) {
    fail('WORKPAPER.DIRECTORY_SCOPE_DRIFT', 'Directory Workspace scope differs from the explicit safety lock.');
  }
  const gras = value.gras.map((item) => normalizeGra(item, s.workspaceIds));
  if (new Set(gras.map((item) => item.riskAssessmentId)).size !== gras.length) fail('WORKPAPER.DIRECTORY_DUPLICATE', 'APP GRA directory contains duplicate identities.');
  return { workspaces, gras };
}
function controlRequest(selected, control = null) {
  const request = {
    riskAssessmentId: selected.riskAssessmentId, graWorkItemId: selected.graWorkItemId,
    appId: selected.appId, appWorkItemId: selected.appWorkItemId, workspaceId: selected.workspaceId
  };
  if (control) {
    request.controlId = control.controlId;
    request.controlWorkItemId = control.workItemId;
  }
  return request;
}
function selectedIdentity(value) {
  return {
    riskAssessmentId: value.riskAssessmentId, graWorkItemId: value.graWorkItemId,
    appId: value.appId, appWorkItemId: value.appWorkItemId, workspaceId: value.workspaceId,
    workspaceName: value.workspaceName, graName: value.graName, graReferenceNumber: value.graReferenceNumber,
    graStatus: value.graStatus, graUpdatedOn: value.graUpdatedOn, appName: value.appName, appNumber: value.appNumber,
    graType: 'Application'
  };
}
function normalizePreflight(value, selected, expectedControl = null) {
  if (!value || value.riskAssessmentId !== selected.riskAssessmentId || value.graWorkItemId !== selected.graWorkItemId
    || value.appId !== selected.appId || value.appWorkItemId !== selected.appWorkItemId || value.workspaceId !== selected.workspaceId) {
    fail('WORKPAPER.PREFLIGHT_CONTEXT_DRIFT', 'Control preflight returned another APP GRA context.');
  }
  const control = {
    controlId: required(value.controlId, 'controlId'), workItemId: required(value.workItemId, 'control.workItemId'),
    controlNumber: optional(value.controlNumber, 'controlNumber'), name: optional(value.name, 'control.name'),
    updatedOn: optional(value.updatedOn, 'control.updatedOn'), opened: value.opened === true, openVerified: value.openVerified === true,
    coreConcurrency: value.coreConcurrency || null, oeConcurrency: value.oeConcurrency || null,
    operatingEffectivenessId: optional(value.operatingEffectivenessId, 'operatingEffectivenessId'), absent: value.absent === true, deleted: value.deleted === true
  };
  if (expectedControl && (control.controlId !== expectedControl.controlId || control.workItemId !== expectedControl.workItemId)) {
    fail('WORKPAPER.PREFLIGHT_IDENTITY_DRIFT', 'Control preflight returned another Control or Work Item.');
  }
  if (control.absent || control.deleted) fail('WORKPAPER.CONTROL_ABSENT', 'Control is absent or deleted.');
  if (control.opened && !control.openVerified) fail('WORKPAPER.OPEN_STATE_CONTRADICTION', 'Control reports the OE flag without the OE entity and unique Tab 209 token.');
  if (!control.opened && (!control.coreConcurrency || Number(control.coreConcurrency.entityTabTypeId) !== 201 || !text(control.coreConcurrency.updatedOn))) {
    fail('WORKPAPER.CORE_TOKEN_MISSING', 'Closed Control has no unique live Tab 201 token.');
  }
  return { ...selected, ...control };
}
function applied(value, step) {
  return value && value.outcome === 'applied' && value.controlId === step.controlId && value.workItemId === step.workItemId
    && value.riskAssessmentId === step.riskAssessmentId && value.appId === step.appId && value.workspaceId === step.workspaceId
    && value.opened === true && value.openVerified === true && value.operatingEffectivenessId
    && value.oeConcurrency && Number(value.oeConcurrency.entityTabTypeId) === 209 && text(value.oeConcurrency.updatedOn);
}
function notApplied(value, step) {
  return value && value.outcome === 'not_applied' && value.controlId === step.controlId && value.workItemId === step.workItemId
    && value.opened === false && value.coreConcurrency && Number(value.coreConcurrency.entityTabTypeId) === 201
    && text(value.coreConcurrency.updatedOn) === text(step.mutationPayload.concurrencyTabUpdatedOn);
}

function createFeatureWorker(ports) {
  const connector = ports && ports.connector; const store = ports && ports.store; const events = ports && ports.events;
  if (!connector || typeof connector.invoke !== 'function' || !store || typeof store.call !== 'function' || !events || typeof events.emit !== 'function') {
    fail('WORKPAPER.PORTS_INVALID', 'Connector, Store and Event ports are required.');
  }
  let bridge = null;
  const planner = () => { if (!bridge) bridge = createPythonSidecarBridge({ timeoutMs: 120000 }); return bridge; };
  const invoke = (operationId, request) => connector.invoke({ schemaVersion: 'omnia.operation-invocation/v1',
    featureId: FEATURE_ID, featureVersion: FEATURE_VERSION, operationId, request });
  const save = async (plan) => {
    plan.updatedAt = new Date().toISOString();
    await store.call('savePlan', plan);
    await store.call('savePlan', { schemaVersion: 'omnia.workpaper-current-pointer/v1', planId: CURRENT_POINTER, currentPlanId: plan.planId, updatedAt: plan.updatedAt });
    return plan;
  };
  const current = async () => {
    const pointer = await store.call('loadPlan', CURRENT_POINTER);
    return pointer && pointer.currentPlanId ? store.call('loadPlan', pointer.currentPlanId) : null;
  };
  const contextAuthority = (context) => {
    const b = binding(context && context.connectorBinding); const s = safety(context && context.safetyLock, b.engagementId);
    sameAuthority(b, s); return { b, s };
  };
  const operationTarget = (step) => ({ targetIdentityKey: step.stepId, workspaceId: step.workspaceId,
    riskAssessmentId: step.riskAssessmentId, controlId: step.controlId });
  const actionPatch = (state) => {
    const directory = !state || ['completed', 'failed', 'cancelled'].includes(state);
    const pending = state === 'pending_confirmation'; const uncertain = state === 'uncertain';
    return [
      { actionId: 'bootstrap-workpaper-directory', enabled: false, reason: 'Initial authoritative APP GRA read has completed.' },
      { actionId: 'refresh-workpaper-directory', enabled: directory, reason: directory ? '' : 'A frozen hidden-Tab plan is active.' },
      { actionId: 'prepare-hidden-tabs', enabled: directory, reason: directory ? '' : 'A frozen hidden-Tab plan is active.' },
      { actionId: 'cancel-hidden-tab-plan', enabled: pending, reason: pending ? '' : 'Only an unconfirmed plan can be cancelled.' },
      { actionId: 'confirm-hidden-tabs', enabled: pending, reason: pending ? '' : 'No frozen plan is awaiting confirmation.' },
      { actionId: 'reconcile-hidden-tabs', enabled: uncertain, reason: uncertain ? '' : 'No uncertain Control command requires read-only reconciliation.' }
    ];
  };
  function directorySurface(directory) {
    const scopes = [{ id: 'app-gra:root', parentId: null, kind: 'section', level: 1, label: 'APP GRA', parentLabel: '底稿编制', selected: true, initialExpanded: true, disabledReason: '' }];
    for (const workspace of directory.workspaces) {
      scopes.push({ id: `workspace:${workspace.id}`, parentId: 'app-gra:root', kind: 'workspace', level: 2, label: workspace.name,
        parentLabel: 'APP GRA', selected: true, initialExpanded: true, disabledReason: '' });
      scopes.push({ id: `type:${workspace.id}:APP-GRA`, parentId: `workspace:${workspace.id}`, kind: 'element_type', level: 3,
        label: 'Application GRA', parentLabel: workspace.name, selected: true, initialExpanded: true, disabledReason: '' });
    }
    const items = directory.gras.map((item) => ({ id: item.riskAssessmentId, scopeId: `type:${item.workspaceId}:APP-GRA`, type: 'APP GRA',
      title: item.graReferenceNumber || item.graName, subtitle: `${item.graName} · APP ${item.appNumber || item.appName} · ${item.graStatus || '当前状态未返回'}`,
      selectable: true, disabledReason: '', concurrencyToken: item.graUpdatedOn || item.riskAssessmentId }));
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', status: items.length ? 'ready' : 'empty',
      statusMessage: items.length ? `已从当前 Pack 精确读取 ${items.length} 个 Application GRA；请选择且只能选择一个。`
        : '当前显式安全锁 Workspace 中没有可用的 Application GRA。', scopes, items, selectedItemIds: [], search: '',
      clearFields: ['progress', 'issues'], actions: actionPatch('completed') };
  }
  function planProgress(plan) {
    const total = plan.counts.total; const succeeded = plan.outcomes.filter((item) => item.state === 'succeeded').length;
    const already = plan.counts.alreadyOpen; const failed = plan.outcomes.filter((item) => item.state === 'failed').length;
    const uncertain = plan.outcomes.filter((item) => item.state === 'uncertain').length;
    const completed = Math.min(total, already + succeeded + failed + uncertain);
    const state = plan.state === 'completed' ? 'passed' : plan.state === 'failed' ? 'failed' : plan.state === 'cancelled' ? 'skipped'
      : plan.state === 'uncertain' ? 'uncertain' : plan.state === 'executing' ? 'running' : 'pending';
    return { label: 'Control 隐藏 Tab', completed, total, percent: total ? Math.round(completed * 100 / total) : 100, state,
      message: plan.state === 'pending_confirmation' ? '计划已冻结，尚未向 Omnia 提交任何写操作。'
        : plan.state === 'uncertain' ? '仅允许精确只读核验；不会重放 PATCH。'
          : plan.state === 'completed' ? '所有 Control 均已由精确读回证明隐藏 Tab 可用。' : '按 Control 逐项执行并核验。',
      items: [
        { itemId: 'already-open', label: '原本已打开', state: already ? 'passed' : 'skipped', detail: `${already}/${total}`, completed: already, total, percent: total ? Math.round(already * 100 / total) : 100 },
        { itemId: 'opened-now', label: '本次打开并核验', state: uncertain ? 'uncertain' : failed ? 'failed' : succeeded === plan.counts.toOpen ? 'passed' : plan.state === 'executing' ? 'running' : 'pending',
          detail: `${succeeded}/${plan.counts.toOpen}`, completed: succeeded, total: plan.counts.toOpen, percent: plan.counts.toOpen ? Math.round(succeeded * 100 / plan.counts.toOpen) : 100 }
      ] };
  }
  function planSurface(plan) {
    const selected = plan.selectedGra;
    const scopes = [
      { id: 'plan:root', parentId: null, kind: 'section', level: 1, label: selected.graReferenceNumber || selected.graName, parentLabel: '底稿编制', selected: true, initialExpanded: true, disabledReason: '' },
      { id: 'plan:workspace', parentId: 'plan:root', kind: 'workspace', level: 2, label: selected.appName, parentLabel: selected.graName, selected: true, initialExpanded: true, disabledReason: '' },
      { id: 'plan:controls', parentId: 'plan:workspace', kind: 'element_type', level: 3, label: 'Controls', parentLabel: selected.appName, selected: true, initialExpanded: true, disabledReason: '' }
    ];
    const outcomeById = new Map(plan.outcomes.map((item) => [item.controlId, item]));
    const openIds = new Set(plan.alreadyOpen.map((item) => item.controlId));
    const items = plan.controls.map((item) => {
      const outcome = outcomeById.get(item.controlId);
      const result = openIds.has(item.controlId) ? '原本已打开' : outcome ? outcome.state === 'succeeded' ? '已打开并核验' : outcome.state === 'uncertain' ? '结果待只读核验' : '失败' : '待执行';
      return { id: `control:${item.controlId}`, scopeId: 'plan:controls', type: 'Control', title: item.controlNumber || item.name || item.controlId,
        subtitle: `${item.name || item.controlNumber || item.controlId} · ${result} · ${item.controlId}`,
        selectable: false, disabledReason: 'Control 清单已冻结，只由当前计划状态机推进。', concurrencyToken: item.updatedOn || item.controlId };
    });
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', stateVersion: Number(plan.surfaceStateVersion || 1), status: 'ready',
      statusMessage: `APP ${selected.appName} · GRA ${selected.graReferenceNumber || selected.graName} · Control ${plan.counts.total} · 待打开 ${plan.counts.toOpen} · 状态 ${plan.state}`,
      scopes, items, selectedItemIds: [], search: '', progress: planProgress(plan), actions: actionPatch(plan.state) };
  }
  async function readDirectory(context) {
    const { b, s } = contextAuthority(context);
    const raw = await invoke(OPERATIONS.directory, { connectorBinding: b, workspaceIds: s.workspaceIds });
    return { b, s, directory: normalizeDirectory(raw, b, s) };
  }
  async function refresh(context) {
    try { return directorySurface((await readDirectory(context)).directory); }
    catch (error) {
      const issue = errorSummary(error);
      return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', status: 'error', statusMessage: `${issue.code}: ${issue.message}`,
        scopes: [], items: [], selectedItemIds: [], clearFields: ['progress'], actions: actionPatch('completed') };
    }
  }
  async function createPlan(context, targetIds, expectedStateVersion) {
    if (!Array.isArray(targetIds) || targetIds.length !== 1) fail('WORKPAPER.SELECT_ONE_GRA', 'Please select exactly one Application GRA.');
    const { b, s, directory } = await readDirectory(context);
    const selected = directory.gras.find((item) => item.riskAssessmentId === text(targetIds[0]));
    if (!selected) fail('WORKPAPER.GRA_STALE', 'Selected Application GRA is absent from the current authoritative directory.');
    const controlCatalog = await invoke(OPERATIONS.controls, { connectorBinding: b, ...controlRequest(selected) });
    if (!controlCatalog || !Array.isArray(controlCatalog.controls) || controlCatalog.controls.length > 500) {
      fail('WORKPAPER.CONTROL_CATALOG_INVALID', 'Selected GRA Control catalog is invalid or exceeds 500 items.');
    }
    const preflights = [];
    for (const raw of controlCatalog.controls) {
      const observed = await invoke(OPERATIONS.preflight, { connectorBinding: b, ...controlRequest(selected, raw) });
      preflights.push(normalizePreflight(observed, selected, raw));
    }
    const localId = crypto.randomUUID();
    const pythonPlan = await planner().invoke('build_hidden_tab_plan', { schemaVersion: 'omnia.workpaper-hidden-tab-input/v1',
      selectedGra: selected, controlPreflights: preflights }, { runId: localId });
    if (!pythonPlan || pythonPlan.schemaVersion !== 'omnia.workpaper-hidden-tab-plan/v1' || pythonPlan.selectedGra.riskAssessmentId !== selected.riskAssessmentId
      || !Array.isArray(pythonPlan.steps) || !Array.isArray(pythonPlan.controls) || !Array.isArray(pythonPlan.alreadyOpen)) {
      fail('WORKPAPER.PYTHON_PLAN_INVALID', 'CPython returned an invalid hidden-Tab plan.');
    }
    const byId = new Map(preflights.map((item) => [item.controlId, item]));
    const steps = pythonPlan.steps.map((step) => {
      const preflight = byId.get(step.controlId);
      if (!preflight) fail('WORKPAPER.PYTHON_PLAN_DRIFT', 'CPython plan contains a Control outside the frozen inventory.');
      return { ...step, ...selected, preflight, preflightDigest: digest(preflight), outcome: null };
    });
    let plan = {
      schemaVersion: 'omnia.workpaper-plan/v1', planId: localId, runId: '', featureVersion: FEATURE_VERSION,
      state: steps.length ? 'preparing' : 'completed', surfaceStateVersion: Number(expectedStateVersion) + 1,
      binding: b, safety: s, selectedGra: selected, controls: pythonPlan.controls, steps, alreadyOpen: pythonPlan.alreadyOpen,
      counts: pythonPlan.counts, outcomes: [], pythonPlanDigest: pythonPlan.planDigest,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
    };
    if (!steps.length) return save(plan);
    const coreRun = await store.call('createMutationRun', { engagementId: b.engagementId });
    const targets = steps.map((step) => ({
      kind: 'field', key: step.stepId, workspace: selected.workspaceId, objectType: 'Control', objectId: step.controlId,
      workItemId: step.workItemId, riskAssessmentId: selected.riskAssessmentId, appId: selected.appId,
      baseline: step.preflight, preflightDigest: step.preflightDigest, mutationOperationId: OPERATIONS.direct,
      mutationPayload: step.mutationPayload, evidenceOperationIds: [OPERATIONS.reconcile], operationTargetIdentityKey: step.stepId
    }));
    const graphDigest = digest(targets.map((item) => ({ key: item.key, preflightDigest: item.preflightDigest, mutationPayload: item.mutationPayload })));
    const frozen = await store.call('prepareReturnIntent', { runId: coreRun.runId,
      plan: { schemaVersion: 'omnia.workpaper-return-intent/v1', authority: { authorityInstanceId: b.authorityInstanceId,
        tenantOrOrgId: b.tenantOrOrgId, packId: b.packId, engagementId: b.engagementId }, selectedGra: selected, graphDigest, targets },
      connectorBinding: b, safetyLock: s, credentialDigest: credentialDigest(b, s), preflightDigest: graphDigest });
    plan = { ...plan, planId: coreRun.runId, runId: coreRun.runId, state: 'pending_confirmation', graphDigest,
      planDigest: frozen.planDigest, confirmationId: frozen.confirmationId, confirmationToken: frozen.confirmationToken,
      confirmationStateVersion: frozen.stateVersion, expiresAt: frozen.expiresAt };
    return save(plan);
  }
  async function cancel(plan) {
    if (!plan || plan.state !== 'pending_confirmation') fail('WORKPAPER.CANCEL_INVALID', 'Only an unconfirmed hidden-Tab plan can be cancelled.');
    const latest = await store.call('loadLatestRun', {}); const run = latest && latest.run ? latest.run : latest;
    if (!run || text(run.run_id) !== plan.runId) fail('WORKPAPER.RUN_DRIFT', 'Current Core Run differs from the frozen plan.');
    const returned = await store.call('returnRunToReview', { runId: plan.runId, expectedRevision: Number(run.state_revision) });
    await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(returned.stateRevision), toState: 'cancelled',
      eventType: 'workpaper.hidden_tab_plan_cancelled', error: 'User cancelled before any mutation was submitted.' });
    plan.state = 'cancelled'; plan.surfaceStateVersion += 1; return save(plan);
  }
  async function currentPreflight(step, b) {
    const selected = selectedIdentity(step);
    const value = await invoke(OPERATIONS.preflight, { connectorBinding: b, ...controlRequest(selected, step) });
    return normalizePreflight(value, selected, step);
  }
  async function freezeReconcile(plan, step, commandId, b) {
    const request = { connectorBinding: b, target: operationTarget(step), ...controlRequest(step, step),
      baselineCoreUpdatedOn: step.mutationPayload.concurrencyTabUpdatedOn };
    await store.call('freezeReturnEvidenceSpec', { runId: plan.runId, commandId, operationId: OPERATIONS.reconcile, request });
    return request;
  }
  async function project(plan, step, commandId, b, observed) {
    await store.call('projectVerifiedReturn', { runId: plan.runId, commandId, binding: b, workspaceId: step.workspaceId,
      projectionKind: 'object', objectType: 'Control', objectId: step.controlId,
      provenance: { riskAssessmentId: step.riskAssessmentId, appId: step.appId, purpose: 'open_operating_effectiveness_hidden_tab' }, payload: observed });
  }
  async function persistOutcome(plan, step, state, phase, error = null, commandId = '') {
    const failure = error ? errorSummary(error) : { code: '', message: '' };
    const value = { controlId: step.controlId, stepId: step.stepId, state, phase, commandId, code: failure.code, message: failure.message };
    const index = plan.outcomes.findIndex((item) => item.controlId === step.controlId);
    if (index >= 0) plan.outcomes[index] = value; else plan.outcomes.push(value);
    plan.outcomes.sort((left, right) => left.controlId.localeCompare(right.controlId));
    await save(plan); return value;
  }
  async function markUncertain(plan, step, commandId, phase, error, observed = null) {
    const failure = errorSummary(error);
    try {
      if (phase !== 'projection') await store.call('recordReturnEvidence', { runId: plan.runId, commandId,
        evidenceType: 'commit', commandState: 'uncertain', payload: { phase, code: failure.code }, error: failure.message });
    } catch {}
    try { await store.call('finishReturn', { runId: plan.runId, outcome: 'uncertain', error: `${failure.code}: ${failure.message}` }); } catch {}
    plan.state = 'uncertain'; plan.uncertain = { controlId: step.controlId, stepId: step.stepId, commandId, phase, failure,
      ...(observed ? { observed } : {}) };
    await persistOutcome(plan, step, 'uncertain', phase, error, commandId); return plan;
  }
  async function execute(plan, context) {
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    await store.call('validateReturnAuthority', { runId: plan.runId, connectorBinding: b, safetyLock: s });
    plan.state = 'executing'; delete plan.uncertain; await save(plan);
    for (const step of plan.steps) {
      const existing = plan.outcomes.find((item) => item.controlId === step.controlId);
      if (existing && existing.state === 'succeeded') continue;
      let before;
      try {
        before = await currentPreflight(step, b);
        if (!before.openVerified && digest(before) !== step.preflightDigest) fail('WORKPAPER.PREFLIGHT_DRIFT', `Control Tab 201 token changed before mutation: ${step.controlId}`);
      } catch (error) {
        await persistOutcome(plan, step, 'failed', 'preflight', error);
        await store.call('finishReturn', { runId: plan.runId, outcome: 'failed', error: `${errorSummary(error).code}: ${errorSummary(error).message}` });
        plan.state = 'failed'; return save(plan);
      }
      const intent = { kind: 'field', key: step.stepId, workspace: step.workspaceId };
      let command;
      try {
        command = await store.call('prepareDeletionCommand', { runId: plan.runId, planDigest: plan.planDigest,
          targetKind: intent.kind, targetKey: intent.key, workspaceId: step.workspaceId, binding: b, workspaceIds: s.workspaceIds,
          operationId: OPERATIONS.direct, request: step.mutationPayload, evidenceOperationIds: [OPERATIONS.reconcile], evidenceTargetIdentityKey: step.stepId });
      } catch (error) {
        await persistOutcome(plan, step, 'failed', 'command_prepare', error);
        await store.call('finishReturn', { runId: plan.runId, outcome: 'failed', error: `${errorSummary(error).code}: ${errorSummary(error).message}` });
        plan.state = 'failed'; return save(plan);
      }
      const readRequest = await freezeReconcile(plan, step, command.commandId, b);
      if (!before.openVerified) {
        try {
          await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
            evidenceType: 'request', commandState: 'submitted', payload: { operationId: OPERATIONS.direct } });
        } catch (error) {
          await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
            evidenceType: 'request', commandState: 'failed', payload: { code: errorSummary(error).code }, error: errorSummary(error).message });
          await persistOutcome(plan, step, 'failed', 'before_mutation', error, command.commandId);
          await store.call('finishReturn', { runId: plan.runId, outcome: 'failed', error: `${errorSummary(error).code}: ${errorSummary(error).message}` });
          plan.state = 'failed'; return save(plan);
        }
        let response;
        try {
          response = await invoke(OPERATIONS.direct, { connectorBinding: b, target: operationTarget(step), ...controlRequest(step, step),
            command: { commandId: command.commandId, idempotencyKey: command.idempotencyKey, payload: step.mutationPayload } });
        } catch (error) { return markUncertain(plan, step, command.commandId, 'submitted', error); }
        try {
          await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
            evidenceType: 'commit', commandState: 'committed', payload: response });
        } catch (error) { return markUncertain(plan, step, command.commandId, 'committed', error); }
      }
      let observed;
      try {
        observed = await invoke(OPERATIONS.reconcile, { ...readRequest, receiptContext: { runId: plan.runId, commandId: command.commandId } });
        if (!applied(observed, step)) fail('WORKPAPER.READBACK_PENDING', 'Readback does not yet prove the OE entity and unique Tab 209 token.');
        await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
          evidenceType: before.openVerified ? 'reconcile' : 'readback', commandState: 'readback_verified', payload: observed,
          receiptId: observed.__operationReceiptId });
      } catch (error) { return markUncertain(plan, step, command.commandId, 'readback', error); }
      try { await project(plan, step, command.commandId, b, observed); }
      catch (error) { return markUncertain(plan, step, command.commandId, 'projection', error, observed); }
      await persistOutcome(plan, step, 'succeeded', before.openVerified ? 'already_applied' : 'readback_verified', null, command.commandId);
    }
    await store.call('finishReturn', { runId: plan.runId, outcome: 'succeeded' });
    plan.state = 'completed'; return save(plan);
  }
  async function confirm(plan, context, expectedStateVersion) {
    if (!plan || plan.state !== 'pending_confirmation' || Number(plan.surfaceStateVersion) !== Number(expectedStateVersion)) {
      fail('WORKPAPER.CONFIRMATION_STALE', 'Hidden-Tab confirmation is stale.');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    if (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now()) fail('WORKPAPER.CONFIRMATION_EXPIRED', 'Hidden-Tab confirmation expired.');
    for (const step of plan.steps) {
      const before = await currentPreflight(step, b);
      if (!before.openVerified && digest(before) !== step.preflightDigest) fail('WORKPAPER.PREFLIGHT_DRIFT', `Control changed before confirmation: ${step.controlId}`);
    }
    await store.call('approveReturnIntent', { confirmationId: plan.confirmationId, confirmationToken: plan.confirmationToken,
      expectedStateVersion: Number(plan.confirmationStateVersion), connectorBinding: b, safetyLock: s });
    plan.surfaceStateVersion = Number(expectedStateVersion) + 1; await save(plan);
    return execute(plan, context);
  }
  async function reconcile(plan, context) {
    if (!plan || plan.state !== 'uncertain' || !plan.uncertain) fail('WORKPAPER.RECONCILE_INVALID', 'No uncertain Control command is available.');
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const step = plan.steps.find((item) => item.stepId === plan.uncertain.stepId);
    if (!step) fail('WORKPAPER.RECONCILE_INVALID', 'Uncertain Control is absent from the frozen plan.');
    const latest = await store.call('loadLatestRun', {}); const run = latest && latest.run ? latest.run : latest;
    if (!run || text(run.run_id) !== plan.runId || text(run.state) !== 'uncertain') fail('WORKPAPER.RUN_DRIFT', 'Core Run is not in the matching uncertain state.');
    await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(run.state_revision), toState: 'reconciling', eventType: 'workpaper.hidden_tab_reconcile_started' });
    const commandId = plan.uncertain.commandId;
    if (plan.uncertain.phase === 'projection') {
      const observed = plan.uncertain.observed;
      if (!applied(observed, step)) {
        await store.call('finishReturn', { runId: plan.runId, outcome: 'uncertain', error: 'Projection reconcile did not prove the hidden Tab.' });
        return save(plan);
      }
      await project(plan, step, commandId, b, observed);
    } else {
      const request = await freezeReconcile(plan, step, commandId, b);
      const observed = await invoke(OPERATIONS.reconcile, { ...request, receiptContext: { runId: plan.runId, commandId } });
      if (!applied(observed, step) && !notApplied(observed, step)) {
        await store.call('finishReturn', { runId: plan.runId, outcome: 'uncertain', error: 'Read-only reconcile remains inconclusive.' });
        return save(plan);
      }
      await store.call('recordReturnEvidence', { runId: plan.runId, commandId, evidenceType: 'reconcile',
        commandState: applied(observed, step) ? 'readback_verified' : 'closed_not_applied', payload: observed,
        receiptId: observed.__operationReceiptId, verified: applied(observed, step),
        error: applied(observed, step) ? '' : 'Authoritative readback proved the PATCH was not applied.' });
      if (!applied(observed, step)) {
        await persistOutcome(plan, step, 'failed', 'reconciled_not_applied', Object.assign(new Error('The hidden-Tab PATCH was not applied.'), { code: 'WORKPAPER.NOT_APPLIED' }), commandId);
        await store.call('finishReturn', { runId: plan.runId, outcome: 'failed', error: 'WORKPAPER.NOT_APPLIED: The hidden-Tab PATCH was not applied.' });
        plan.state = 'failed'; delete plan.uncertain; return save(plan);
      }
      await project(plan, step, commandId, b, observed);
    }
    const after = await store.call('loadLatestRun', {}); const afterRun = after && after.run ? after.run : after;
    await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(afterRun.state_revision), toState: 'returning', eventType: 'workpaper.hidden_tab_reconcile_resolved' });
    await persistOutcome(plan, step, 'succeeded', 'reconciled_readback', null, commandId);
    delete plan.uncertain; return execute(plan, context);
  }
  async function handleAction(input) {
    const context = input.context || {};
    if (input.actionId === 'bootstrap-workpaper-directory' || input.actionId === 'refresh-workpaper-directory') {
      return { surfacePatch: await refresh(context) };
    }
    if (input.actionId === 'prepare-hidden-tabs') {
      const plan = await createPlan(context, input.payload && input.payload.targetIds, input.expectedStateVersion);
      return { surfacePatch: planSurface(plan) };
    }
    const plan = await current();
    if (!plan) fail('WORKPAPER.PLAN_NOT_FOUND', 'Current hidden-Tab plan was not found.');
    let result;
    if (input.actionId === 'cancel-hidden-tab-plan') result = await cancel(plan);
    else if (input.actionId === 'confirm-hidden-tabs') result = await confirm(plan, context, input.expectedStateVersion);
    else if (input.actionId === 'reconcile-hidden-tabs') result = await reconcile(plan, context);
    else fail('WORKPAPER.ACTION_UNKNOWN', 'Action is not implemented.');
    result.surfaceStateVersion = Number(input.expectedStateVersion) + 1; await save(result);
    return { surfacePatch: planSurface(result) };
  }
  async function health() {
    try {
      await planner().start();
      return { schemaVersion: 'omnia.feature-worker-health/v1', featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
        ready: true, mutationEnabled: true, requiresConnector: true, requiresSafetyLock: true, supportedTransports: ['remote'],
        python: { implementation: 'cpython', version: '3.13.14', planner: 'ready' } };
    } catch (error) {
      const issue = errorSummary(error);
      return { schemaVersion: 'omnia.feature-worker-health/v1', featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
        ready: false, mutationEnabled: false, requiresConnector: true, requiresSafetyLock: true, supportedTransports: ['remote'],
        reason: `${issue.code}: ${issue.message}`, python: { implementation: 'cpython', version: '3.13.14', planner: 'failed' } };
    }
  }
  return Object.freeze({ health, shutdown: () => bridge ? bridge.close() : undefined, refreshCatalog: refresh, handleAction });
}

module.exports = Object.freeze({ createFeatureWorker, FEATURE_ID, FEATURE_VERSION, OPERATIONS, normalizeDirectory, normalizePreflight, applied, notApplied });
