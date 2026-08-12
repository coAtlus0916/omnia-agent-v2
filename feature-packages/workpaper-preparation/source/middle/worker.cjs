'use strict';

const crypto = require('node:crypto');
const { createPythonSidecarBridge } = require('./workpaper-preparation-python-bridge.cjs');

const FEATURE_ID = 'omnia.workpaper-preparation';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const CURRENT_POINTER = 'workpaper:current';
const MAX_BATCH_GRAS = 50;
const MAX_BATCH_CONTROLS = 2000;
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
  const contentName = required(value && value.graContentName, 'graContentName');
  if (!['generic', 'generic application'].includes(contentName.normalize('NFKC').toLowerCase())) {
    fail('WORKPAPER.GENERIC_APP_ONLY', 'Only a Generic Application GRA can enter this Workpaper phase.');
  }
  const item = {
    riskAssessmentId: required(value && value.riskAssessmentId, 'riskAssessmentId'),
    graWorkItemId: required(value && value.graWorkItemId, 'graWorkItemId'),
    appId: required(value && value.appId, 'appId'), appWorkItemId: required(value && value.appWorkItemId, 'appWorkItemId'),
    graContentId: required(value && value.graContentId, 'graContentId'),
    workspaceId: required(value && value.workspaceId, 'workspaceId'), workspaceName: required(value && value.workspaceName, 'workspaceName'),
    graName: required(value && value.graName, 'graName'), graReferenceNumber: optional(value && value.graReferenceNumber, 'graReferenceNumber'),
    graStatus: optional(value && value.graStatus, 'graStatus'), graUpdatedOn: optional(value && value.graUpdatedOn, 'graUpdatedOn'),
    appName: required(value && value.appName, 'appName'), appNumber: optional(value && value.appNumber, 'appNumber'),
    graContentName: 'Generic',
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
  request.graContentId = selected.graContentId;
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
    graContentId: value.graContentId,
    workspaceName: value.workspaceName, graName: value.graName, graReferenceNumber: value.graReferenceNumber,
    graStatus: value.graStatus, graUpdatedOn: value.graUpdatedOn, appName: value.appName, appNumber: value.appNumber,
    graContentName: value.graContentName,
    graType: 'Application'
  };
}
function observationState(value) {
  const { outcome: _outcome, ...state } = value || {};
  return state;
}
function createFeatureWorker(ports) {
  const connector = ports && ports.connector; const store = ports && ports.store; const events = ports && ports.events;
  if (!connector || typeof connector.invoke !== 'function' || !store || typeof store.call !== 'function' || !events || typeof events.emit !== 'function') {
    fail('WORKPAPER.PORTS_INVALID', 'Connector, Store and Event ports are required.');
  }
  let bridge = null;
  const planner = () => { if (!bridge) bridge = createPythonSidecarBridge({ timeoutMs: 120000 }); return bridge; };
  async function classifyObservation(value, selected, expectedControl, runId) {
    const classified = await planner().invoke('classify_control_observation', {
      schemaVersion: 'omnia.workpaper-control-observation-input/v1', selectedGra: selected,
      expectedControl: { controlId: expectedControl.controlId, workItemId: expectedControl.workItemId,
        mutationPayload: expectedControl.mutationPayload || {}, baselineCoreUpdatedOn: expectedControl.baselineCoreUpdatedOn || '' },
      observation: value
    }, { runId });
    if (!classified || classified.schemaVersion !== 'omnia.workpaper-control-observation-classification/v1'
      || !['applied','partial_applied','not_applied','pending','contradiction'].includes(classified.outcome)
      || !classified.control || typeof classified.control !== 'object') {
      fail('WORKPAPER.PYTHON_OBSERVATION_INVALID', 'CPython returned an invalid Control observation classification.');
    }
    return { ...classified.control, outcome: classified.outcome };
  }
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
    const pending = state === 'pending_confirmation' || state === 'pending_continuation';
    const uncertain = state === 'uncertain' || state === 'pending_continuation';
    return [
      { actionId: 'bootstrap-workpaper-directory', enabled: false, reason: 'Initial authoritative APP GRA read has completed.' },
      { actionId: 'refresh-workpaper-directory', enabled: directory, reason: directory ? '' : 'A frozen hidden-Tab plan is active.' },
      { actionId: 'prepare-hidden-tabs', enabled: directory, reason: directory ? '' : 'A frozen hidden-Tab plan is active.' },
      { actionId: 'cancel-hidden-tab-plan', enabled: state === 'pending_confirmation', reason: state === 'pending_confirmation' ? '' : 'Only an unconfirmed plan can be cancelled.' },
      { actionId: 'confirm-hidden-tabs', enabled: pending, reason: pending ? '' : 'No frozen plan or reconciled continuation is awaiting confirmation.' },
      { actionId: 'reconcile-hidden-tabs', enabled: uncertain,
        label: state === 'pending_continuation' ? '确认继续未完成步骤' : '核验并继续未完成步骤',
        reason: uncertain ? '' : 'No uncertain Control command or reconciled continuation is available.' }
    ];
  };
  function directorySurface(directory) {
    const scopes = [{ id: 'app-gra:root', parentId: null, kind: 'section', level: 1, label: 'Generic APP GRA', parentLabel: '底稿编制', selected: true, initialExpanded: true, disabledReason: '' }];
    for (const workspace of directory.workspaces) {
      scopes.push({ id: `workspace:${workspace.id}`, parentId: 'app-gra:root', kind: 'workspace', level: 2, label: workspace.name,
        parentLabel: 'Generic APP GRA', selected: true, initialExpanded: true, disabledReason: '' });
      scopes.push({ id: `type:${workspace.id}:APP-GRA`, parentId: `workspace:${workspace.id}`, kind: 'element_type', level: 3,
        label: 'Generic Application GRA', parentLabel: workspace.name, selected: true, initialExpanded: true, disabledReason: '' });
    }
    const items = directory.gras.map((item) => ({ id: item.riskAssessmentId, scopeId: `type:${item.workspaceId}:APP-GRA`, type: 'Generic APP GRA',
      title: item.graReferenceNumber || item.graName, subtitle: `${item.graName} · APP ${item.appNumber || item.appName} · ${item.graStatus || '当前状态未返回'}`,
      selectable: true, disabledReason: '', concurrencyToken: item.graUpdatedOn || item.riskAssessmentId }));
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', status: items.length ? 'ready' : 'empty',
      statusMessage: items.length ? `已从当前 Pack 精确读取 ${items.length} 个 Generic Application GRA；可多选后创建一个冻结批次。`
        : '当前显式安全锁 Workspace 中没有可用的 Generic Application GRA。', scopes, items, selectedItemIds: [], search: '',
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
        : plan.state === 'pending_continuation' ? '只读核验已证明第一阶段生效；第二阶段已停在人工确认前，不会自动重放。'
        : plan.state === 'uncertain' ? '仅允许精确只读核验；不会重放 PATCH。'
          : plan.state === 'completed' ? '所有 Control 均已由精确读回证明隐藏 Tab 可用。' : '按 Control 逐项执行并核验。',
      items: [
        { itemId: 'already-open', label: '原本已打开', state: already ? 'passed' : 'skipped', detail: `${already}/${already}`, completed: already, total: already, percent: 100 },
        { itemId: 'opened-now', label: '本次打开并核验', state: uncertain ? 'uncertain' : failed ? 'failed' : succeeded === plan.counts.toOpen ? 'passed' : plan.state === 'executing' ? 'running' : 'pending',
          detail: `${succeeded}/${plan.counts.toOpen}`, completed: succeeded, total: plan.counts.toOpen, percent: plan.counts.toOpen ? Math.round(succeeded * 100 / plan.counts.toOpen) : 100 }
      ] };
  }
  function planSurface(plan) {
    const selectedGras = Array.isArray(plan.selectedGras) && plan.selectedGras.length ? plan.selectedGras : [plan.selectedGra];
    const scopes = [{ id: 'plan:root', parentId: null, kind: 'section', level: 1, label: `${selectedGras.length} 个 Generic APP GRA`,
      parentLabel: '底稿编制', selected: true, initialExpanded: true, disabledReason: '' }];
    for (const selected of selectedGras) {
      scopes.push({ id: `plan:gra:${selected.riskAssessmentId}`, parentId: 'plan:root', kind: 'workspace', level: 2,
        label: selected.graReferenceNumber || selected.graName, parentLabel: selected.appName, selected: true, initialExpanded: true, disabledReason: '' });
      scopes.push({ id: `plan:controls:${selected.riskAssessmentId}`, parentId: `plan:gra:${selected.riskAssessmentId}`,
        kind: 'element_type', level: 3, label: 'Controls', parentLabel: selected.graReferenceNumber || selected.graName,
        selected: true, initialExpanded: true, disabledReason: '' });
    }
    const outcomeById = new Map(plan.outcomes.map((item) => [item.stepId, item]));
    const openIds = new Set(plan.alreadyOpen.map((item) => `${item.riskAssessmentId}|${item.controlId}`));
    const items = plan.controls.map((item) => {
      const stepId = `control-hidden-tab|${item.workspaceId}|${item.riskAssessmentId}|${item.controlId}`;
      const outcome = outcomeById.get(stepId);
      const result = openIds.has(`${item.riskAssessmentId}|${item.controlId}`) ? '原本已打开' : outcome ? outcome.state === 'succeeded' ? '已打开并核验' : outcome.state === 'uncertain' ? '结果待只读核验' : '失败' : '待执行';
      return { id: `control:${item.riskAssessmentId}:${item.controlId}`, scopeId: `plan:controls:${item.riskAssessmentId}`, type: 'Control', title: item.controlNumber || item.name || item.controlId,
        subtitle: `${item.name || item.controlNumber || item.controlId} · ${result} · ${item.controlId}`,
        selectable: false, disabledReason: 'Control 清单已冻结，只由当前计划状态机推进。', concurrencyToken: item.updatedOn || item.controlId };
    });
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', stateVersion: Number(plan.surfaceStateVersion || 1), status: 'ready',
      statusMessage: `Generic APP GRA ${selectedGras.length} 个 · Control ${plan.counts.total} 个 · 待打开 ${plan.counts.toOpen} 个 · 状态 ${plan.state}`,
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
    if (!Array.isArray(targetIds) || targetIds.length < 1 || targetIds.length > MAX_BATCH_GRAS) {
      fail('WORKPAPER.SELECT_GRA_BATCH', `Please select between 1 and ${MAX_BATCH_GRAS} Generic Application GRAs.`);
    }
    const requestedIds = targetIds.map(text);
    if (requestedIds.some((value) => !value) || new Set(requestedIds).size !== requestedIds.length) {
      fail('WORKPAPER.SELECT_GRA_BATCH', 'Selected Generic Application GRA identities are empty or duplicated.');
    }
    const { b, s, directory } = await readDirectory(context);
    const directoryById = new Map(directory.gras.map((item) => [item.riskAssessmentId, item]));
    const selectedGras = requestedIds.map((riskAssessmentId) => directoryById.get(riskAssessmentId));
    if (selectedGras.some((item) => !item)) fail('WORKPAPER.GRA_STALE', 'A selected Generic Application GRA is absent from the current authoritative directory.');
    selectedGras.sort((left, right) => left.riskAssessmentId.localeCompare(right.riskAssessmentId));
    const localId = crypto.randomUUID();
    const bundles = [];
    for (const selected of selectedGras) {
      const controlCatalog = await invoke(OPERATIONS.controls, { connectorBinding: b, ...controlRequest(selected) });
      if (!controlCatalog || !Array.isArray(controlCatalog.controls) || controlCatalog.controls.length > 500
        || ['riskAssessmentId','graWorkItemId','appId','appWorkItemId','workspaceId','graContentId']
          .some((key) => text(controlCatalog[key]) !== text(selected[key]))) {
        fail('WORKPAPER.CONTROL_CATALOG_INVALID', 'A selected GRA Control catalog is invalid, stale, or exceeds 500 items.');
      }
      const selection = await planner().invoke('select_hidden_tab_controls', {
        schemaVersion: 'omnia.workpaper-control-selection-input/v1', controls: controlCatalog.controls
      }, { runId: localId });
      if (!selection || selection.schemaVersion !== 'omnia.workpaper-control-selection/v1'
        || !Array.isArray(selection.controls) || !selection.controls.length) {
        fail('WORKPAPER.PYTHON_SELECTION_INVALID', `CPython returned no valid Phase 2 Control selection for GRA ${selected.riskAssessmentId}.`);
      }
      const rawByIdentity = new Map();
      for (const raw of controlCatalog.controls) {
        const identity = `${required(raw && raw.controlId, 'controlId')}|${required(raw && raw.workItemId, 'control.workItemId')}`;
        if (rawByIdentity.has(identity)) fail('WORKPAPER.CONTROL_IDENTITY_DUPLICATE', 'Control catalog contains duplicate identities.');
        rawByIdentity.set(identity, raw);
      }
      const eligibleControls = selection.controls.map((item) => {
        const identity = `${required(item && item.controlId, 'selection.controlId')}|${required(item && item.workItemId, 'selection.workItemId')}`;
        const raw = rawByIdentity.get(identity);
        if (!raw) fail('WORKPAPER.PYTHON_SELECTION_DRIFT', 'CPython selected a Control outside the authoritative catalog.');
        return raw;
      });
      if (new Set(eligibleControls.map((raw) => `${raw.controlId}|${raw.workItemId}`)).size !== eligibleControls.length) {
        fail('WORKPAPER.PYTHON_SELECTION_DRIFT', 'CPython selected a Control identity more than once.');
      }
      const preflights = [];
      for (const raw of eligibleControls) {
        const observed = await invoke(OPERATIONS.preflight, { connectorBinding: b, ...controlRequest(selected, raw) });
        preflights.push(await classifyObservation(observed, selected, raw, localId));
      }
      const pythonPlan = await planner().invoke('build_hidden_tab_plan', { schemaVersion: 'omnia.workpaper-hidden-tab-input/v1',
        selectedGra: selected, controlPreflights: preflights }, { runId: localId });
      if (!pythonPlan || pythonPlan.schemaVersion !== 'omnia.workpaper-hidden-tab-plan/v1'
        || pythonPlan.selectedGra.riskAssessmentId !== selected.riskAssessmentId
        || !Array.isArray(pythonPlan.steps) || !Array.isArray(pythonPlan.controls) || !Array.isArray(pythonPlan.alreadyOpen)) {
        fail('WORKPAPER.PYTHON_PLAN_INVALID', 'CPython returned an invalid hidden-Tab plan.');
      }
      const byId = new Map(preflights.map((item) => [item.controlId, item]));
      const steps = pythonPlan.steps.map((step) => {
        const preflight = byId.get(step.controlId);
        if (!preflight) fail('WORKPAPER.PYTHON_PLAN_DRIFT', 'CPython plan contains a Control outside the frozen inventory.');
        const frozenPreflight = observationState(preflight);
        return { ...step, ...selected, preflight: frozenPreflight, preflightDigest: digest(frozenPreflight), outcome: null };
      });
      bundles.push({ selected, pythonPlan, steps,
        controls: pythonPlan.controls.map((item) => ({ ...selected, ...item })),
        alreadyOpen: pythonPlan.alreadyOpen.map((item) => ({ ...selected, ...item })) });
    }
    const controls = bundles.flatMap((bundle) => bundle.controls);
    const steps = bundles.flatMap((bundle) => bundle.steps);
    const alreadyOpen = bundles.flatMap((bundle) => bundle.alreadyOpen);
    if (controls.length > MAX_BATCH_CONTROLS || new Set(steps.map((step) => step.stepId)).size !== steps.length) {
      fail('WORKPAPER.BATCH_INVALID', `The frozen batch is duplicated or exceeds ${MAX_BATCH_CONTROLS} Controls.`);
    }
    const counts = { total: controls.length, toOpen: steps.length, alreadyOpen: alreadyOpen.length };
    const pythonPlanDigest = digest(bundles.map((bundle) => ({
      riskAssessmentId: bundle.selected.riskAssessmentId, planDigest: bundle.pythonPlan.planDigest
    })));
    let plan = {
      schemaVersion: 'omnia.workpaper-plan/v1', planId: localId, runId: '', featureVersion: FEATURE_VERSION,
      state: steps.length ? 'preparing' : 'completed', surfaceStateVersion: Number(expectedStateVersion) + 1,
      binding: b, safety: s, selectedGras, controls, steps, alreadyOpen,
      counts, outcomes: [], pythonPlanDigest,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
    };
    if (!steps.length) return save(plan);
    const coreRun = await store.call('createMutationRun', { engagementId: b.engagementId });
    const targets = steps.map((step) => ({
      kind: 'field', key: step.stepId, workspace: step.workspaceId, objectType: 'Control', objectId: step.controlId,
      workItemId: step.workItemId, riskAssessmentId: step.riskAssessmentId, appId: step.appId,
      baseline: step.preflight, preflightDigest: step.preflightDigest, mutationOperationId: OPERATIONS.direct,
      mutationPayload: step.mutationPayload, evidenceOperationIds: [OPERATIONS.reconcile], operationTargetIdentityKey: step.stepId
    }));
    const graphDigest = digest(targets.map((item) => ({ key: item.key, preflightDigest: item.preflightDigest, mutationPayload: item.mutationPayload })));
    const frozen = await store.call('prepareReturnIntent', { runId: coreRun.runId,
      plan: { schemaVersion: 'omnia.workpaper-return-intent/v1', authority: { authorityInstanceId: b.authorityInstanceId,
        tenantOrOrgId: b.tenantOrOrgId, packId: b.packId, engagementId: b.engagementId }, selectedGras, graphDigest, targets },
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
  async function currentPreflight(step, b, permitPlanDigest = '', runId = '') {
    const selected = selectedIdentity(step);
    const value = await invoke(OPERATIONS.preflight, {
      connectorBinding: b,
      ...(permitPlanDigest ? { target: operationTarget(step), planDigest: permitPlanDigest } : {}),
      ...controlRequest(selected, step)
    });
    return classifyObservation(value, selected, step, runId || crypto.randomUUID());
  }
  async function freezeReconcile(plan, step, commandId, b) {
    const request = { connectorBinding: b, target: operationTarget(step), ...controlRequest(step, step),
      baselineCoreUpdatedOn: step.mutationPayload.concurrencyTabUpdatedOn,
      baselinePlanningCommonControlTesting: step.mutationPayload.baselinePlanningCommonControlTesting };
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
    const index = plan.outcomes.findIndex((item) => item.stepId === step.stepId);
    if (index >= 0) plan.outcomes[index] = value; else plan.outcomes.push(value);
    plan.outcomes.sort((left, right) => left.stepId.localeCompare(right.stepId));
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
      const existing = plan.outcomes.find((item) => item.stepId === step.stepId);
      if (existing && existing.state === 'succeeded') continue;
      let before;
      try {
        before = await currentPreflight(step, b, plan.planDigest, plan.runId);
        const partialRecovery = plan.partialRecovery && plan.partialRecovery.stepId === step.stepId
          && plan.partialRecovery.observedDigest === digest(observationState(before));
        if (!before.openVerified && digest(observationState(before)) !== step.preflightDigest && !partialRecovery) {
          fail('WORKPAPER.PREFLIGHT_DRIFT', `Control state changed before mutation: ${step.controlId}`);
        }
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
          response = await invoke(OPERATIONS.direct, { connectorBinding: b, target: operationTarget(step), planDigest: plan.planDigest,
            ...controlRequest(step, step),
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
        const classification = await classifyObservation(observed, selectedIdentity(step), step, plan.runId);
        if (classification.outcome !== 'applied') fail('WORKPAPER.READBACK_PENDING', 'Readback does not yet prove the complete recorded hidden-Tab state.');
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
    if (!plan || !['pending_confirmation','pending_continuation'].includes(plan.state)) {
      fail('WORKPAPER.CONFIRMATION_STALE', 'Hidden-Tab confirmation is stale.');
    }
    const continuation = plan.state === 'pending_continuation';
    if (!continuation && Number(plan.surfaceStateVersion) !== Number(expectedStateVersion)) {
      fail('WORKPAPER.CONFIRMATION_STALE', 'Hidden-Tab confirmation is stale.');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    if (!continuation && (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now())) {
      fail('WORKPAPER.CONFIRMATION_EXPIRED', 'Hidden-Tab confirmation expired.');
    }
    for (const step of plan.steps) {
      const before = await currentPreflight(step, b, '', plan.runId);
      const partialRecovery = continuation && plan.partialRecovery && plan.partialRecovery.stepId === step.stepId
        && plan.partialRecovery.observedDigest === digest(observationState(before));
      if (!before.openVerified && digest(observationState(before)) !== step.preflightDigest && !partialRecovery) fail('WORKPAPER.PREFLIGHT_DRIFT', `Control changed before confirmation: ${step.controlId}`);
    }
    if (!continuation) {
      await store.call('approveReturnIntent', { confirmationId: plan.confirmationId, confirmationToken: plan.confirmationToken,
        expectedStateVersion: Number(plan.confirmationStateVersion), connectorBinding: b, safetyLock: s });
    }
    plan.surfaceStateVersion = Number(expectedStateVersion) + 1; await save(plan);
    return execute(plan, context);
  }
  async function reconcile(plan, context) {
    if (!plan || plan.state !== 'uncertain' || !plan.uncertain) fail('WORKPAPER.RECONCILE_INVALID', 'No uncertain Control command is available.');
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const step = plan.steps.find((item) => item.stepId === plan.uncertain.stepId);
    if (!step) fail('WORKPAPER.RECONCILE_INVALID', 'Uncertain Control is absent from the frozen plan.');
    const latest = await store.call('loadLatestRun', {}); const run = latest && latest.run ? latest.run : latest;
    if (!run || text(run.run_id) !== plan.runId || !['uncertain','reconciling'].includes(text(run.state))) {
      fail('WORKPAPER.RUN_DRIFT', 'Core Run is not in the matching uncertain/reconciling recovery state.');
    }
    const reconcilingRevision = text(run.state) === 'reconciling'
      ? Number(run.state_revision)
      : await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(run.state_revision),
        toState: 'reconciling', eventType: 'workpaper.hidden_tab_reconcile_started' });
    const commandId = plan.uncertain.commandId;
    if (plan.uncertain.phase === 'projection') {
      const observed = plan.uncertain.observed;
      const classification = await classifyObservation(observed, selectedIdentity(step), step, plan.runId);
      if (classification.outcome !== 'applied') {
        await store.call('finishReturn', { runId: plan.runId, outcome: 'uncertain', error: 'Projection reconcile did not prove the hidden Tab.' });
        return save(plan);
      }
      await project(plan, step, commandId, b, observed);
    } else {
      const request = await freezeReconcile(plan, step, commandId, b);
      const observed = await invoke(OPERATIONS.reconcile, { ...request, receiptContext: { runId: plan.runId, commandId } });
      const classification = await classifyObservation(observed, selectedIdentity(step), step, plan.runId);
      if (!['applied','not_applied','partial_applied'].includes(classification.outcome)) {
        await store.call('finishReturn', { runId: plan.runId, outcome: 'uncertain', error: 'Read-only reconcile remains inconclusive.' });
        return save(plan);
      }
      if (classification.outcome === 'partial_applied') {
        const evidence = await store.call('recordReturnEvidence', { runId: plan.runId, commandId, evidenceType: 'reconcile',
          commandState: 'readback_verified', intentResolution: 'partial_effect', payload: observed,
          receiptId: observed.__operationReceiptId, verified: true,
          error: 'The first mutation stage applied; the remaining signed stage requires an exact continuation command.' });
        await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(reconcilingRevision), toState: 'returning',
          eventType: 'workpaper.hidden_tab_partial_effect_reconciled' });
        plan.partialRecovery = { stepId: step.stepId, priorCommandId: commandId,
          receiptId: observed.__operationReceiptId, evidenceId: evidence.evidenceId,
          observedDigest: digest(observationState(classification)) };
        await persistOutcome(plan, step, 'partial_recovered', 'reconciled_partial_effect', null, commandId);
        delete plan.uncertain;
        plan.state = 'pending_continuation';
        return save(plan);
      }
      await store.call('recordReturnEvidence', { runId: plan.runId, commandId, evidenceType: 'reconcile',
        commandState: classification.outcome === 'applied' ? 'readback_verified' : 'closed_not_applied', payload: observed,
        receiptId: observed.__operationReceiptId, verified: classification.outcome === 'applied',
        error: classification.outcome === 'applied' ? '' : 'Authoritative readback proved the PATCH was not applied.' });
      if (classification.outcome !== 'applied') {
        await persistOutcome(plan, step, 'failed', 'reconciled_not_applied', Object.assign(new Error('The hidden-Tab PATCH was not applied.'), { code: 'WORKPAPER.NOT_APPLIED' }), commandId);
        await store.call('finishReturn', { runId: plan.runId, outcome: 'failed', error: 'WORKPAPER.NOT_APPLIED: The hidden-Tab PATCH was not applied.' });
        plan.state = 'failed'; delete plan.uncertain; return save(plan);
      }
      await project(plan, step, commandId, b, observed);
    }
    const after = await store.call('loadLatestRun', {}); const afterRun = after && after.run ? after.run : after;
    await store.call('transitionRun', { runId: plan.runId, expectedRevision: Number(afterRun.state_revision), toState: 'returning', eventType: 'workpaper.hidden_tab_reconcile_resolved' });
    await persistOutcome(plan, step, 'succeeded', 'reconciled_readback', null, commandId);
    delete plan.uncertain; delete plan.partialRecovery; return execute(plan, context);
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
    else if (input.actionId === 'reconcile-hidden-tabs') result = plan.state === 'pending_continuation'
      ? await confirm(plan, context, input.expectedStateVersion)
      : await reconcile(plan, context);
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

module.exports = Object.freeze({ createFeatureWorker, FEATURE_ID, FEATURE_VERSION, OPERATIONS, normalizeDirectory });
