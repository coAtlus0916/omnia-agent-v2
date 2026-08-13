'use strict';

const crypto = require('node:crypto');
const { createPythonSidecarBridge } = require('./workpaper-preparation-python-bridge.cjs');

const FEATURE_ID = 'omnia.workpaper-preparation';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const CURRENT_POINTER = 'workpaper:current';
const MAX_BATCH_GRAS = 50;
const MAX_BATCH_CONTROLS = 2000;
const OPEN_CONCURRENCY = 6;
const OPERATIONS = Object.freeze({
  directory: 'omnia.workpaper.directory.read.v1',
  controls: 'omnia.workpaper.controls.read.v1',
  preflight: 'omnia.workpaper.control.preflight.v1',
  direct: 'omnia.workpaper.control.open-hidden-tab.v1',
  reconcile: 'omnia.workpaper.control.reconcile.v1',
  snapshot: 'omnia.workpaper.phase2.snapshot.read.v1',
  writeback: 'omnia.workpaper.phase2.writeback.v1'
});

// Phase 2 field contract (injected at packaging from the authoritative JSON).
// Each field maps a frontend label to a writePath template; only non-readOnly,
// non-Agent fields are user-editable workbook columns.
const PHASE2_FIELDS = Object.freeze(typeof __PHASE2_FIELDS__ !== 'undefined' ? __PHASE2_FIELDS__ : []);
// Phase 2 pre-filled template data (injected at packaging from the v4 template
// contract): the placeholder directory and the six control-point row templates.
const PHASE2_TEMPLATE = Object.freeze(typeof __PHASE2_TEMPLATE__ !== 'undefined' ? __PHASE2_TEMPLATE__ : { directory: [], headers: [], controls: [] });
const WORKBOOK_IDENTITY_HEADERS = Object.freeze(['GRA 编号', 'GRA 名称', 'APP 名称', 'Control 编号', 'controlId', 'workItemId', 'workspaceId']);

function valueKindRead(current, kind) {
  if (current === null || current === undefined) return '';
  if (kind === 'number') return typeof current === 'number' ? current : text(current);
  if (kind === 'boolean') return current === true ? '是' : current === false ? '否' : text(current);
  return text(current);
}

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
  const connector = ports && ports.connector; const store = ports && ports.store; const events = ports && ports.events; const ai = ports && ports.ai;
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
  const openPlan = async () => {
    const openRun = await store.call('loadOpenRun', {});
    // Only a mutation Run (hidden-Tab Return) is a durable recovery target. A
    // source-artifact intake Run (`acquiring`/`draft`/`needs_input`/…) is
    // created by the Shell for every uploaded file and carries no Workpaper
    // plan; it must never be mistaken for an interrupted mutation.
    const recoveryStates = ['waiting_confirmation', 'returning', 'verifying', 'uncertain', 'reconciling'];
    if (openRun && openRun.run_id && recoveryStates.includes(String(openRun.state))) {
      const recoveryPlan = await store.call('loadPlan', openRun.run_id);
      if (!recoveryPlan) {
        fail('WORKPAPER.RECOVERY_PLAN_MISSING', 'The nonterminal Workpaper Run has no exact durable recovery plan.');
      }
      return recoveryPlan;
    }
    return null;
  };
  const current = async () => {
    const recoveryPlan = await openPlan();
    if (recoveryPlan) return recoveryPlan;
    const pointer = await store.call('loadPlan', CURRENT_POINTER);
    return pointer && pointer.currentPlanId ? store.call('loadPlan', pointer.currentPlanId) : null;
  };
  const contextAuthority = (context) => {
    const b = binding(context && context.connectorBinding); const s = safety(context && context.safetyLock, b.engagementId);
    sameAuthority(b, s); return { b, s };
  };
  const operationTarget = (step) => ({ targetIdentityKey: step.stepId, workspaceId: step.workspaceId,
    riskAssessmentId: step.riskAssessmentId, controlId: step.controlId });
  function workflowSurface(plan) {
    const wp = plan && plan.workpaper ? plan.workpaper : null;
    const wpState = wp ? wp.state : null;
    const step = (stepId, label, detail, stepState) => ({ stepId, label, state: stepState, detail });
    // Three steps: select → upload (template + materials) → writeback.
    // Opening the hidden Tab and reading back Controls live inside the
    // writeback capsules, not as a standalone step.
    const writebackDone = ['writeback_complete', 'writeback_noop'].includes(wpState);
    const writebackUncertain = wpState === 'writeback_uncertain';
    const awaitingWriteback = wpState === 'awaiting_writeback';
    const uploadDone = awaitingWriteback || writebackDone || writebackUncertain;
    const selectState = !wpState ? 'current' : 'completed';
    const uploadState = !wpState ? 'pending' : uploadDone ? 'completed' : 'current';
    const uploadDetail = !wpState ? '等待选择元素'
      : wpState === 'generated' ? '下载填写件、上传填写件与制度资料'
        : '材料已上传；点击下一步进入确认回传';
    const writebackState = writebackDone ? 'completed'
      : writebackUncertain ? 'warning'
        : awaitingWriteback ? 'current' : 'pending';
    const writebackDetail = writebackDone ? '写回已完成'
      : writebackUncertain ? '存在不确定写回，请只读核验'
        : awaitingWriteback ? '激活 OE Tab、读回 Control 并写回' : '等待材料上传与转化';
    const steps = [
      step('select', '选择元素', '选择 Generic Application GRA', selectState),
      step('upload', '上传材料', uploadDetail, uploadState),
      step('writeback', '确认回传', writebackDetail, writebackState)
    ];
    // Materials upload never advances the workflow; only the explicit 下一步
    // (next-to-writeback) moves onto the writeback step once both inputs are
    // present.
    const currentStepId = writebackDone || writebackUncertain || awaitingWriteback ? 'writeback'
      : wpState ? 'upload' : 'select';
    return { revision: 1, currentStepId, steps };
  }
  const actionPatch = (plan) => {
    const wp = plan && plan.workpaper ? plan.workpaper : null;
    const wpState = wp ? wp.state : null;
    const directory = !wpState;
    const generated = wpState === 'generated';
    const materialsReady = generated && Boolean(wp && wp.policy) && Boolean(wp && wp.replacement);
    const awaitingWriteback = wpState === 'awaiting_writeback';
    const writebackUncertain = wpState === 'writeback_uncertain';
    return [
      { actionId: 'bootstrap-workpaper-directory', enabled: false, visible: false, reason: 'Initial authoritative APP GRA read has completed.' },
      { actionId: 'refresh-workpaper-directory', enabled: directory, visible: directory, reason: directory ? '' : '底稿流程已开始。' },
      { actionId: 'select-elements', enabled: directory, visible: directory, reason: directory ? '' : '填写件模板已生成。' },
      { actionId: 'upload-filled-workbook', enabled: generated, visible: generated, reason: generated ? '' : '请先生成填写件模板，再上传填写好的替换字段表。' },
      { actionId: 'upload-policy', enabled: generated, visible: generated, reason: generated ? '' : '请先生成填写件模板，再上传制度资料。' },
      { actionId: 'next-to-writeback', enabled: materialsReady, visible: materialsReady, reason: materialsReady ? '' : '请先上传填写件与制度资料，再进入确认回传。' },
      { actionId: 'confirm-writeback', enabled: awaitingWriteback, visible: awaitingWriteback || writebackUncertain, reason: awaitingWriteback ? '' : '请先进入确认回传步骤。' },
      { actionId: 'restart-run', enabled: Boolean(wpState), reason: wpState ? '结束当前流程并返回选择元素。' : '当前没有可结束的流程。' }
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
      workflow: workflowSurface(null), clearFields: ['progress', 'issues'], actions: actionPatch(null) };
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
    const artifacts = plan.workpaper ? [{
      artifactId: plan.workpaper.artifactId, kind: 'result', name: `workpaper-phase2-${plan.runId}.xlsx`,
      sha256: plan.workpaper.sha256, sizeBytes: plan.workpaper.sizeBytes, available: true, reason: ''
    }] : [];
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', stateVersion: Number(plan.surfaceStateVersion || 1), status: 'ready',
      statusMessage: `Generic APP GRA ${selectedGras.length} 个 · Control ${plan.counts.total} 个 · 待打开 ${plan.counts.toOpen} 个 · 状态 ${plan.state}`,
      scopes, items, selectedItemIds: [], search: '', artifacts, workflow: workflowSurface(plan), progress: planProgress(plan), actions: actionPatch(plan) };
  }
  // A clean, minimal surface once the workpaper is generated: no Control
  // catalog, only the downloaded artifact and the next-stage action. This is
  // the "下载审核 / 上传 / 预览 / 确认写回" workspace after the hidden-Tab
  // phase has completed.
  function writebackProgress(plan) {
    const wp = plan.workpaper;
    const wb = wp && wp.writeback;
    // Before the user clicks 确认回传 (resolved state), show the three empty
    // capsules so the writeback step's layout is visible ahead of progress.
    if (!wb || !Array.isArray(wb.capsules)) {
      const pendingCapsules = [
        { itemId: 'activate-oe', label: '激活 OE Tab', state: 'pending', detail: '等待回传' },
        { itemId: 'readback', label: '读回 Control', state: 'pending', detail: '等待回传' },
        { itemId: 'writeback', label: '写回 Control', state: 'pending', detail: '等待回传' }
      ].map((c) => ({ ...c, completed: 0, total: 0, percent: 0 }));
      return { label: '确认回传', completed: 0, total: 0, percent: 0, state: 'pending',
        message: '点击“确认回传”开始激活 OE Tab、读回 Control 并写回。', items: pendingCapsules };
    }
    const capsules = wb.capsules.map((capsule) => ({
      itemId: capsule.capsuleId, label: capsule.label, state: capsule.state, detail: capsule.detail || '',
      completed: Number(capsule.completed || 0), total: Number(capsule.total || 0),
      percent: Number(capsule.total) ? Math.round(Number(capsule.completed) * 100 / Number(capsule.total)) : (capsule.state === 'passed' ? 100 : 0)
    }));
    const total = capsules.reduce((sum, item) => sum + item.total, 0);
    const completed = capsules.reduce((sum, item) => sum + item.completed, 0);
    const state = wb.state === 'passed' ? 'passed' : wb.state === 'uncertain' ? 'uncertain' : wb.state === 'failed' ? 'failed' : 'running';
    return { label: '确认回传', completed, total, percent: total ? Math.round(completed * 100 / total) : 0, state,
      message: state === 'passed' ? '回传已完成。' : state === 'uncertain' ? '存在不确定写回，请只读核验。' : state === 'failed' ? '回传失败。' : '正在回传。',
      items: capsules };
  }
  function workpaperSurface(plan) {
    const wp = plan.workpaper;
    const wpState = wp ? wp.state : null;
    // The template download belongs to the upload step only; the writeback
    // step shows the capsule progress, never the template artifact.
    const showTemplate = !wp || wpState === 'generated';
    const artifacts = [];
    if (wp && showTemplate) {
      artifacts.push({ artifactId: wp.artifactId, kind: 'result', name: `workpaper-phase2-${plan.runId}.xlsx`,
        sha256: wp.sha256, sizeBytes: wp.sizeBytes, available: true, reason: '' });
    }
    // Surface the uploaded source files (填写件 / 制度) so the drop zone can
    // show their names after import. The matching upload actionId lets the
    // renderer bind each source file to its own drop zone.
    if (wp && wp.sources) {
      for (const source of wp.sources) {
        artifacts.push({ artifactId: source.artifactId, kind: 'source', name: source.name,
          sha256: source.sha256, sizeBytes: source.sizeBytes, available: true, reason: source.reason || '',
          ...(source.actionId ? { actionId: source.actionId } : {}) });
      }
    }
    const message = !wp
      ? `已选择 ${plan.selectedGras.length} 个 Generic Application GRA；生成填写件模板后开始填写。`
      : wpState === 'generated'
        ? `填写件已生成：${wp.rowCount} 行。请下载填写件，填写”替换字段”sheet 后上传，并上传制度资料。`
        : wpState === 'awaiting_writeback'
          ? '请点击”确认回传”激活 OE Tab、读回 Control 并写回。'
          : wpState === 'writeback_complete' ? '写回已完成并逐字段读回核验。'
            : wpState === 'writeback_uncertain' ? '存在不确定写回；请只读核验，禁止盲目重放。'
              : '控制底稿状态。';
    const progress = (wp && (wpState === 'awaiting_writeback' || wpState === 'writeback_complete' || wpState === 'writeback_uncertain'))
      ? writebackProgress(plan) : null;
    return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', stateVersion: Number(plan.surfaceStateVersion || 1),
      status: 'ready', statusMessage: message, scopes: [], items: [], selectedItemIds: [], search: '',
      artifacts, workflow: workflowSurface(plan),
      ...(progress ? { progress } : { clearFields: ['progress'] }), actions: actionPatch(plan) };
  }
  async function readDirectory(context) {
    const { b, s } = contextAuthority(context);
    const raw = await invoke(OPERATIONS.directory, { connectorBinding: b, workspaceIds: s.workspaceIds });
    return { b, s, directory: normalizeDirectory(raw, b, s) };
  }
  async function refresh(context) {
    try {
      const recoveryPlan = await openPlan();
      if (recoveryPlan) return recoveryPlan.workpaper ? workpaperSurface(recoveryPlan) : planSurface(recoveryPlan);
      return directorySurface((await readDirectory(context)).directory);
    }
    catch (error) {
      const issue = errorSummary(error);
      return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', status: 'error', statusMessage: `${issue.code}: ${issue.message}`,
        scopes: [], items: [], selectedItemIds: [], workflow: workflowSurface(null), clearFields: ['progress'], actions: actionPatch(null) };
    }
  }
  async function selectElements(context, targetIds, expectedStateVersion) {
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
    return save({
      schemaVersion: 'omnia.workpaper-plan/v1', planId: localId, runId: '', featureVersion: FEATURE_VERSION,
      state: 'selected', surfaceStateVersion: Number(expectedStateVersion) + 1,
      binding: b, safety: s, selectedGras, controls: [], steps: [], alreadyOpen: [],
      counts: { total: 0, toOpen: 0, alreadyOpen: 0 }, outcomes: [],
      createdAt: new Date().toISOString()
    });
  }
  // Freeze the hidden-Tab plan at writeback time. Reads each selected GRA's
  // Control catalog, selects the eligible Phase-2 Controls, preflights them,
  // and builds the exact mutation plan. A GRA with no eligible Control is
  // skipped (not an error); a fully already-open batch has no Core Run.
  async function freezeHiddenTabPlan(plan, context) {
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const localId = plan.planId;
    const bundles = [];
    for (const selected of plan.selectedGras) {
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
        // No eligible Phase-2 Control: the whole GRA has nothing to open.
        bundles.push({ selected, steps: [], controls: [], alreadyOpen: [] });
        continue;
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
      bundles.push({ selected, steps,
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
    plan.controls = controls; plan.steps = steps; plan.alreadyOpen = alreadyOpen; plan.counts = counts; plan.outcomes = [];
    if (!steps.length) return plan;
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
        tenantOrOrgId: b.tenantOrOrgId, packId: b.packId, engagementId: b.engagementId }, selectedGras: plan.selectedGras, graphDigest, targets },
      connectorBinding: b, safetyLock: s, credentialDigest: credentialDigest(b, s), preflightDigest: graphDigest });
    plan = Object.assign(plan, { planId: coreRun.runId, runId: coreRun.runId, state: 'pending_confirmation', graphDigest,
      planDigest: frozen.planDigest, confirmationId: frozen.confirmationId, confirmationToken: frozen.confirmationToken,
      confirmationStateVersion: frozen.stateVersion });
    return save(plan);
  }
  // Approve the frozen intent and open the hidden Tabs (executes the Core Return).
  async function openHiddenTabs(plan, context) {
    if (!plan.steps || !plan.steps.length) { plan.state = 'completed'; return plan; }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    for (const step of plan.steps) {
      const before = await currentPreflight(step, b, '', plan.runId);
      if (!before.openVerified && digest(observationState(before)) !== step.preflightDigest) fail('WORKPAPER.PREFLIGHT_DRIFT', `Control changed before confirmation: ${step.controlId}`);
    }
    await store.call('approveReturnIntent', { confirmationId: plan.confirmationId, confirmationToken: plan.confirmationToken,
      expectedStateVersion: Number(plan.confirmationStateVersion), connectorBinding: b, safetyLock: s });
    return execute(plan, context);
  }
  // Read back every Control of every selected GRA (not only eligible) so the
  // write-back intersection can be computed against the authoritative list.
  async function readbackAllControls(plan, context) {
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const readbackControls = [];
    for (const selected of plan.selectedGras) {
      const controlCatalog = await invoke(OPERATIONS.controls, { connectorBinding: b, ...controlRequest(selected) });
      if (!controlCatalog || !Array.isArray(controlCatalog.controls) || controlCatalog.controls.length > 500
        || ['riskAssessmentId','graWorkItemId','appId','appWorkItemId','workspaceId','graContentId']
          .some((key) => text(controlCatalog[key]) !== text(selected[key]))) {
        fail('WORKPAPER.CONTROL_CATALOG_INVALID', 'A selected GRA Control catalog is invalid, stale, or exceeds 500 items.');
      }
      for (const raw of controlCatalog.controls) {
        readbackControls.push({
          controlId: required(raw && raw.controlId, 'controlId'),
          workItemId: required(raw && raw.workItemId, 'control.workItemId'),
          controlNumber: optional(raw && raw.controlNumber, 'controlNumber'),
          riskAssessmentId: selected.riskAssessmentId, appId: selected.appId, workspaceId: selected.workspaceId
        });
      }
    }
    plan.readbackControls = readbackControls;
    plan.readbackCount = readbackControls.length;
    return plan;
  }
  async function clearCurrentPointer() {
    await store.call('savePlan', { schemaVersion: 'omnia.workpaper-current-pointer/v1', planId: CURRENT_POINTER,
      currentPlanId: '', updatedAt: new Date().toISOString() });
  }
  // The Shell creates an `acquiring` intake Run for every uploaded source
  // artifact. Once this Feature has read the bytes and parsed them into its
  // own durable plan, that intake Run is dead weight — close it so it never
  // surfaces as an ambiguous nonterminal recovery target.
  async function closeSourceIntakeRun(bytes) {
    const runId = bytes && bytes.runId;
    if (!runId) return;
    try {
      const latest = await store.call('loadLatestRun', {});
      const run = latest && latest.run ? latest.run : latest;
      if (run && String(run.run_id) === String(runId)
        && ['draft', 'acquiring', 'processing', 'needs_input'].includes(String(run.state))) {
        await store.call('transitionRun', { runId: String(runId), expectedRevision: Number(run.state_revision),
          toState: 'cancelled', eventType: 'workpaper.source_intake_closed', error: 'Source artifact was parsed into the durable Workpaper plan.' });
      }
    } catch { /* intake closure is best-effort; never fail the upload */ }
  }
  async function forceEnd(plan, context) {
    if (plan) {
      const latest = await store.call('loadLatestRun', {}); const run = latest && latest.run ? latest.run : latest;
      if (run && text(run.run_id) === plan.runId && !['succeeded', 'failed', 'cancelled', 'not_evaluable'].includes(text(run.state))) {
        let revision = Number(run.state_revision);
        if (text(run.state) === 'uncertain') {
          revision = await store.call('transitionRun', { runId: plan.runId, expectedRevision: revision, toState: 'reconciling',
            eventType: 'workpaper.hidden_tab_force_end_started', error: '用户强制结束；只读核验未执行。' });
        }
        await store.call('transitionRun', { runId: plan.runId, expectedRevision: revision, toState: 'failed',
          eventType: 'workpaper.hidden_tab_force_ended', error: '用户强制结束；已验证的远端写入保持不变，不回滚、不重放。' });
      }
    }
    await clearCurrentPointer();
    return refresh(context);
  }
  function workpaperHeaders() {
    const editable = PHASE2_FIELDS.filter((field) => field.readOnly !== true && field.fillMode !== 'Agent 填写' && field.writePath);
    return [...WORKBOOK_IDENTITY_HEADERS, ...editable.map((field) => field.frontendKey)];
  }
  function workpaperScope(plan, { b, s }) {
    return {
      schemaVersion: 'omnia.workpaper-phase2-scope/v1',
      engagementId: b.engagementId,
      connectorId: b.connectorId,
      sessionGeneration: b.sessionGeneration,
      authorityInstanceId: b.authorityInstanceId,
      tenantOrOrgId: b.tenantOrOrgId,
      packId: b.packId,
      workspaceIds: s.workspaceIds,
      selectedGraIds: plan.selectedGras.map((item) => item.riskAssessmentId).sort(),
      generatedAt: plan.updatedAt,
    };
  }
  function workpaperRow(selected, snapshot) {
    const editable = PHASE2_FIELDS.filter((field) => field.readOnly !== true && field.fillMode !== 'Agent 填写' && field.writePath);
    return [
      selected.graReferenceNumber || '',
      selected.graName || '',
      selected.appName || selected.appNumber || '',
      snapshot.controlNumber || '',
      snapshot.controlId || '',
      snapshot.workItemId || '',
      selected.workspaceId || '',
      ...editable.map((field) => valueKindRead(readFieldValue(snapshot, field), field.valueKind))
    ];
  }
  function readFieldValue(snapshot, field) {
    const key = field.backendKey || '';
    if (key === 'description') return snapshot.description;
    if (key === 'approach') return snapshot.approach;
    if (key === 'riskAssociationType') return snapshot.riskAssociationType;
    if (key === 'riskAssociationDescription') return snapshot.riskAssociationDescription;
    if (key.startsWith('controlDesignEvaluation.')) {
      return snapshot.designEvaluation ? snapshot.designEvaluation[key.slice('controlDesignEvaluation.'.length)] : '';
    }
    if (key.startsWith('controlOperatingEffectiveness.')) {
      return snapshot.operatingEffectiveness ? snapshot.operatingEffectiveness[key.slice('controlOperatingEffectiveness.'.length)] : '';
    }
    if (key.startsWith('controlRiskScopes')) {
      const detail = (snapshot.riskScopes || []).flatMap((scope) => scope.details).find((item) => item.appropriatenessAndCorrelation !== '')
        || (snapshot.riskScopes || []).flatMap((scope) => scope.details)[0];
      return detail ? detail.appropriatenessAndCorrelation : '';
    }
    if (key.startsWith('gitcNonDetailedTestingProcedures')) {
      const phaseType = field.phaseType || 'TestOfDesign';
      const procedure = (snapshot.procedures || []).find((item) => item.phaseType === phaseType);
      return procedure ? procedure.documentProcedureResults : '';
    }
    return '';
  }
  async function generateWorkpaper(plan, context) {
    if (!plan || plan.workpaper) {
      fail('WORKPAPER.GENERATE_INVALID', '填写件模板已生成或没有当前计划；请先选择元素。');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    if (!PHASE2_TEMPLATE.directory.length || !PHASE2_TEMPLATE.headers.length || !PHASE2_TEMPLATE.controls.length) {
      fail('WORKPAPER.TEMPLATE_EMPTY', 'Phase 2 预置模板数据缺失。');
    }
    // The pre-filled template is generated from the selected APP names, not
    // from live Control field values. It carries the placeholder directory
    // and the six control-point row templates (APP.01/02/05/06/10/13) with
    // 【占位符】 left for the user + policy-AI resolution.
    const systems = plan.selectedGras.map((item) => item.appName || item.appNumber).filter(text);
    if (!systems.length) fail('WORKPAPER.NO_SYSTEMS', '当前计划没有可生成填写件的 APP。');
    const scope = workpaperScope(plan, { b, s });
    const runId = plan.runId || plan.planId;
    const built = await planner().invoke('build_phase2_template', {
      schemaVersion: 'omnia.workpaper-phase2-workbook/v1', systems,
      directory: PHASE2_TEMPLATE.directory, scope
    }, { runId });
    if (!built || built.schemaVersion !== 'omnia.workpaper-phase2-template-result/v1'
      || !/^[0-9a-f]{64}$/u.test(built.sha256 || '') || !built.xlsxBase64) {
      fail('WORKPAPER.WORKBOOK_INVALID', 'CPython 返回的控制底稿模板无效。');
    }
    const artifact = await store.call('commitStandaloneArtifact', {
      kind: 'result', contentBase64: built.xlsxBase64,
      originalName: `workpaper-phase2-${plan.runId || plan.planId}.xlsx`,
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      engagementId: b.engagementId, surfaceId: 'workpaper-preparation.workbench', sourceRef: 'workpaper-phase2-template'
    });
    if (!artifact || !artifact.artifactId || artifact.sha256 !== built.sha256) {
      fail('WORKPAPER.ARTIFACT_COMMIT_FAILED', '控制底稿 Artifact 提交失败或摘要漂移。');
    }
    plan.workpaper = {
      artifactId: artifact.artifactId, sha256: built.sha256, sizeBytes: built.sizeBytes,
      semanticDigest: built.semanticDigest, rowCount: built.replacementRowCount, headers: built.sheetNames,
      scopeDigest: digest(scope), generatedAt: plan.updatedAt, state: 'generated',
      systems
    };
    plan.surfaceStateVersion += 1; await save(plan);
    return plan;
  }
  // Record an uploaded source file on the plan so the surface can render its
  // name in the matching drop zone after import.
  function recordSourceFile(plan, artifactDescriptor, bytes, reason, actionId) {
    if (!Array.isArray(plan.workpaper.sources)) plan.workpaper.sources = [];
    const existing = plan.workpaper.sources.find((item) => item.artifactId === artifactDescriptor.artifactId);
    const entry = { artifactId: artifactDescriptor.artifactId,
      name: bytes.originalName || '已上传文件',
      sha256: bytes.sha256 || '', sizeBytes: bytes.sizeBytes || 0, reason: reason || '' };
    if (actionId) entry.actionId = actionId;
    if (existing) Object.assign(existing, entry); else plan.workpaper.sources.push(entry);
  }
  async function uploadPolicy(plan, context, artifactDescriptor) {
    if (!plan || !plan.workpaper || plan.workpaper.state !== 'generated') {
      fail('WORKPAPER.POLICY_INVALID', '请先生成控制底稿模板，再上传制度资料。');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const runId = plan.runId || plan.planId;
    if (!artifactDescriptor || artifactDescriptor.schemaVersion !== 'omnia.feature-artifact/v1'
      || artifactDescriptor.featureId !== FEATURE_ID || artifactDescriptor.kind !== 'source') {
      fail('WORKPAPER.POLICY_IDENTITY', '制度压缩包身份无效；请重新选择。');
    }
    const bytes = await store.call('readArtifactBytes', { artifactId: artifactDescriptor.artifactId });
    if (!bytes || !bytes.contentBase64) fail('WORKPAPER.POLICY_BYTES', '制度压缩包字节不可用。');
    // Large archives exceed the RPC frame ceiling; hand the Python sidecar a
    // Core-managed file handle instead of an inline base64 payload.
    const handle = await store.call('openPythonArtifactHandle', { runId: bytes.runId, artifactId: artifactDescriptor.artifactId });
    const extraction = await planner().invoke('extract_policy_archive', {
      schemaVersion: 'omnia.workpaper-policy-archive/v1', zipPath: handle.path
    }, { runId });
    if (!extraction || extraction.schemaVersion !== 'omnia.workpaper-policy-extraction/v1'
      || !Array.isArray(extraction.documents)) {
      fail('WORKPAPER.POLICY_EXTRACT', '制度压缩包文本提取失败。');
    }
    await store.call('releasePythonArtifactHandles', { handleIds: [handle.handleId] });
    await closeSourceIntakeRun(bytes);
    recordSourceFile(plan, artifactDescriptor, bytes, '制度资料', 'upload-policy');
    plan.workpaper.policy = {
      documents: extraction.documents, skipped: extraction.skipped || [],
      documentCount: extraction.documentCount, skippedCount: extraction.skippedCount,
      uploadedSha256: bytes.sha256, state: 'extracted'
    };
    plan.surfaceStateVersion += 1; await save(plan);
    // Uploading materials never advances the workflow; resolution runs only on
    // the explicit 下一步 transition once both inputs are present.
    return plan;
  }
  // Parse the user-filled 替换字段 sheet back into replacement values. The
  // uploaded template must still match the frozen system scope; the returned
  // placeholder→value map is applied to TestOfDesign text during resolution.
  async function applyReplacementFields(plan, context, artifactDescriptor) {
    if (!plan || !plan.workpaper || plan.workpaper.state !== 'generated') {
      fail('WORKPAPER.REPLACEMENT_INVALID', '请先生成填写件模板，再上传填写好的替换字段表。');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const runId = plan.runId || plan.planId;
    if (!artifactDescriptor || artifactDescriptor.schemaVersion !== 'omnia.feature-artifact/v1'
      || artifactDescriptor.featureId !== FEATURE_ID || artifactDescriptor.kind !== 'source') {
      fail('WORKPAPER.REPLACEMENT_IDENTITY', '填写件身份无效；请重新选择。');
    }
    const bytes = await store.call('readArtifactBytes', { artifactId: artifactDescriptor.artifactId });
    if (!bytes || !bytes.contentBase64) fail('WORKPAPER.REPLACEMENT_BYTES', '填写件字节不可用。');
    const replacement = await planner().invoke('apply_replacement_fields', {
      schemaVersion: 'omnia.workpaper-replacement-input/v1', xlsxBase64: bytes.contentBase64
    }, { runId });
    if (!replacement || replacement.schemaVersion !== 'omnia.workpaper-replacement/v1'
      || !Array.isArray(replacement.replacements) || !Array.isArray(replacement.systems)) {
      fail('WORKPAPER.REPLACEMENT_PARSE', '填写件替换字段解析失败。');
    }
    await closeSourceIntakeRun(bytes);
    recordSourceFile(plan, artifactDescriptor, bytes, '填写件', 'upload-filled-workbook');
    // Prove the uploaded template still matches the frozen system scope.
    const expectedSystems = [...plan.workpaper.systems].sort();
    const uploadedSystems = [...replacement.systems].sort();
    if (canonicalWorkpaperState(expectedSystems) !== canonicalWorkpaperState(uploadedSystems)) {
      fail('WORKPAPER.REPLACEMENT_SCOPE_DRIFT', '填写件的系统范围与冻结合同不一致。');
    }
    plan.workpaper.replacement = {
      replacements: replacement.replacements, uploadedSha256: bytes.sha256, state: 'filled'
    };
    plan.surfaceStateVersion += 1; await save(plan);
    return plan;
  }
  // Apply the user-filled 替换字段 values to a Control's TestOfDesign text.
  // System-level placeholders (controlPoint === 'AA通用') replace every row;
  // control-point placeholders (controlPoint === 'APP.xx') replace only the
  // matching control point. Empty values are never substituted.
  function applyReplacementValues(sourceText, system, controlNumber, replacements) {
    let output = sourceText;
    for (const item of replacements || []) {
      if (String(item.system || '') !== String(system || '')) continue;
      const point = String(item.controlPoint || '');
      if (point !== 'AA通用' && !(point && String(controlNumber || '').startsWith(point))) continue;
      const placeholder = String(item.placeholder || '');
      const value = String(item.value || '');
      if (!placeholder || !value) continue;
      output = output.split(placeholder).join(value);
    }
    return output;
  }
  // Resolve 【placeholder】 occurrences in the generated Controls TestOfDesign
  // text using the extracted policy snippets. Only evidence_supported values
  // are filled; missing_evidence / ambiguous stay empty (never invented).
  async function resolvePlaceholders(plan, context) {
    if (!plan || !plan.workpaper || plan.workpaper.state !== 'generated' || !plan.workpaper.policy) {
      fail('WORKPAPER.RESOLVE_INVALID', '请先上传制度资料，再生成底稿内容。');
    }
    const runId = plan.runId || plan.planId;
    if (!ai || typeof ai.review !== 'function') {
      // AI unavailable is a warning, not a business failure: leave placeholders
      // empty and continue without blocking the workpaper.
      plan.workpaper.resolution = { state: 'ai_unavailable', message: 'AI 端口不可用；占位符保留为空，未生成内容。' };
      plan.surfaceStateVersion += 1; await save(plan);
      return plan;
    }
    if (!Array.isArray(plan.workpaper.policy.documents) || plan.workpaper.policy.documents.length === 0) {
      // No indexable policy text (e.g. all scanned PDFs were skipped). The
      // pre-filled template is still the authoritative write-back payload:
      // fall through and resolve every placeholder as missing_evidence (left
      // empty), never invented.
      plan.workpaper.policyDocuments = [];
    } else {
      plan.workpaper.policyDocuments = plan.workpaper.policy.documents;
    }
    const hasPolicyText = Array.isArray(plan.workpaper.policyDocuments) && plan.workpaper.policyDocuments.length > 0;
    const policyIndex = hasPolicyText
      ? await planner().invoke('build_policy_index', {
          schemaVersion: 'omnia.workpaper-policy-index-input/v1', documents: plan.workpaper.policyDocuments
        }, { runId })
      : null;
    if (hasPolicyText && (!policyIndex || policyIndex.schemaVersion !== 'omnia.workpaper-policy-index/v1' || !policyIndex.chunks)) {
      fail('WORKPAPER.POLICY_INDEX', '制度索引构建失败。');
    }
    const resolutions = [];
    const replacements = plan.workpaper.replacement && plan.workpaper.replacement.replacements;
    // A placeholder carries its frozen location so the final TestOfDesign text
    // can be assembled from the template source and written back exactly once.
    const locatedPlaceholder = (p, state, value, evidenceRefs, reason) => ({
      placeholderId: String(p.placeholderId || ''), originalPlaceholder: String(p.originalPlaceholder || ''),
      index: Number.isInteger(p.index) ? p.index : undefined, state, value: String(value || ''),
      evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs.map(String) : [], reason: String(reason || '')
    });
    const missingEvidence = (placeholders, reason) => placeholders.map((p) =>
      locatedPlaceholder(p, 'missing_evidence', '', [], reason));
    for (const row of plan.workpaper.systems.flatMap((system) => PHASE2_TEMPLATE.controls.map((c) => ({ system, control: c })))) {
      const controlNumber = String(row.control.controlNumber || '').replace('系统ID', row.system);
      let sourceText = String((row.control.values || [])[8] || '').replace('系统ID', row.system);
      // User-filled replacement values (替换字段) are applied first, so the
      // remaining 【placeholders】 left for the policy AI are only the
      // evidence-class ones (【...】, 【policy合集名称】, etc.).
      sourceText = applyReplacementValues(sourceText, row.system, controlNumber, replacements);
      if (!text(sourceText)) continue;
      const placeholders = await planner().invoke('extract_placeholders', {
        schemaVersion: 'omnia.workpaper-placeholder-input/v1', controlNumber,
        sourceField: 'documentProcedureResults - TestOfDesign', sourceText
      }, { runId });
      if (!placeholders || !placeholders.placeholders || !placeholders.placeholders.length) {
        // No placeholder remains after replacement-field substitution: the
        // template text is already final and must still be written back.
        resolutions.push({ controlNumber, placeholders: [], resolvedText: sourceText });
        continue;
      }
      if (!hasPolicyText) {
        const located = missingEvidence(placeholders.placeholders, '未上传可索引的制度资料。');
        resolutions.push({ controlNumber, placeholders: located, resolvedText: applyResolutions(sourceText, located) });
        continue;
      }
      const snippets = await planner().invoke('retrieve_policy_snippets', {
        schemaVersion: 'omnia.workpaper-policy-retrieve-input/v1', index: policyIndex,
        control: { controlNumber, description: String((row.control.values || [])[2] || ''), documentProcedureResults: sourceText }
      }, { runId });
      if (!snippets || !snippets.snippets || !snippets.snippets.length) {
        // No relevant policy evidence: every placeholder is missing_evidence.
        const located = missingEvidence(placeholders.placeholders, '未检索到相关制度片段。');
        resolutions.push({ controlNumber, placeholders: located, resolvedText: applyResolutions(sourceText, located) });
        continue;
      }
      const instructions = [
        '你是 IT 审计专家。只能根据给出的制度片段为已列出的占位符给出 resolution。',
        '不得重写原文；不得编造人名、日期、系统、流程或审计结论。',
        '每个 placeholderId 恰好返回一次。只有 state=evidence_supported 时 value 才能非空，且必须引用至少一个给出的 snippetId。',
        '资料不足用 missing_evidence；无法唯一判断用 ambiguous；这两种 value 必须是空字符串。',
        'evidenceRefs 只能使用给出的 snippetId。严格返回 {"resolutions":[...]}，每项含 placeholderId/state/value/evidenceRefs/reason。'
      ].join(' ');
      let result;
      try {
        result = await ai.review({ schemaVersion: 'omnia.feature-ai-review-request/v1',
          capabilityId: 'phase2-policy-resolution/v1', runId, instructions,
          input: { control: { controlNumber, sourceField: 'documentProcedureResults - TestOfDesign', originalTestOfDesign: sourceText },
            placeholders: placeholders.placeholders, policySnippets: snippets.snippets } });
      } catch (error) {
        const located = missingEvidence(placeholders.placeholders, `AI 调用失败：${text(error.message)}`);
        resolutions.push({ controlNumber, placeholders: located, resolvedText: applyResolutions(sourceText, located) });
        continue;
      }
      const output = result && result.output;
      const res = Array.isArray(output && output.resolutions) ? output.resolutions : [];
      const byId = new Map(res.map((item) => [String(item.placeholderId), item]));
      const located = placeholders.placeholders.map((p) => {
        const r = byId.get(p.placeholderId);
        if (!r || !['evidence_supported', 'missing_evidence', 'ambiguous'].includes(String(r.state))) {
          return locatedPlaceholder(p, 'missing_evidence', '', [], 'AI 返回缺失或无效。');
        }
        return locatedPlaceholder(p, String(r.state), String(r.value || ''), r.evidenceRefs, String(r.reason || ''));
      });
      resolutions.push({ controlNumber, placeholders: located, resolvedText: applyResolutions(sourceText, located) });
    }
    plan.workpaper.resolution = { state: 'resolved', resolutions, resolvedAt: new Date().toISOString() };
    plan.surfaceStateVersion += 1; await save(plan);
    return plan;
  }
  // Apply resolutions back into the source text by exact frozen offsets.
  function applyResolutions(sourceText, resolutions) {
    let output = sourceText;
    const byId = new Map((Array.isArray(resolutions) ? resolutions : []).map((item) => [String(item.placeholderId), item]));
    const occurrences = [...byId.values()].filter((item) => Number.isInteger(item.index)).sort((a, b) => b.index - a.index);
    for (const resolution of occurrences) {
      const original = String(resolution.originalPlaceholder || '');
      if (output.slice(resolution.index, resolution.index + original.length) !== original) continue;
      const replacement = resolution.state === 'evidence_supported' ? String(resolution.value || '') : '';
      output = output.slice(0, resolution.index) + replacement + output.slice(resolution.index + original.length);
    }
    return output;
  }
  // Advance from the upload step into the writeback step. This is where the AI
  // policy resolution actually runs (once both inputs are present), producing
  // the durable resolution + assembled final text. No Connector traffic here.
  async function nextToWriteback(plan, context) {
    if (!plan || !plan.workpaper || plan.workpaper.state !== 'generated'
      || !plan.workpaper.policy || !plan.workpaper.replacement) {
      fail('WORKPAPER.WRITEBACK_INVALID', '请先上传填写件与制度资料，再进入确认回传。');
    }
    await resolvePlaceholders(plan, context);
    plan.workpaper.state = 'awaiting_writeback';
    plan.surfaceStateVersion += 1;
    await save(plan);
    return plan;
  }
  // The whole write-back capsule chain, run on one explicit confirmation:
  //   1. activate OE Tab (freeze → confirm → open hidden Tabs)
  //   2. read back every Control of every selected GRA
  //   3. intersect read-back Controls with resolved rows, then write back.
  async function confirmWriteback(plan, context) {
    if (!plan || !plan.workpaper || plan.workpaper.state !== 'awaiting_writeback' || !plan.workpaper.resolution) {
      fail('WORKPAPER.WRITEBACK_INVALID', '请先上传填写件与制度资料并完成系统转化，再确认回传。');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    // Seed all three capsules up front so the writeback step shows an empty
    // progress panel immediately, then advance each capsule as work completes.
    const progress = {
      startedAt: new Date().toISOString(), state: 'running', capsules: [
        { capsuleId: 'activate-oe', label: '激活 OE Tab', state: 'running', completed: 0, total: 0, detail: '正在读取并冻结' },
        { capsuleId: 'readback', label: '读回 Control', state: 'pending', completed: 0, total: 0, detail: '等待回传' },
        { capsuleId: 'writeback', label: '写回 Control', state: 'pending', completed: 0, total: 0, detail: '等待回传' }
      ]
    };
    plan.workpaper.writeback = progress;
    plan.surfaceStateVersion += 1; await save(plan);

    // Capsule 1: activate OE Tab. Freeze the hidden-Tab plan first (reads each
    // GRA's Control catalog and preflights the eligible Controls), then open
    // the hidden Tabs. A batch whose Controls are all already open completes
    // with zero mutation steps.
    try {
      await freezeHiddenTabPlan(plan, context);
      if (!plan.steps || !plan.steps.length) {
        progress.capsules[0] = { capsuleId: 'activate-oe', label: '激活 OE Tab', state: 'passed', completed: 0, total: 0, detail: '无需要打开的隐藏 Tab' };
      } else {
        progress.capsules[0] = { capsuleId: 'activate-oe', label: '激活 OE Tab', state: 'running', completed: plan.counts.alreadyOpen, total: plan.counts.total, detail: `${plan.counts.alreadyOpen}/${plan.counts.total}` };
        await save(plan);
        await openHiddenTabs(plan, context);
        const openFailed = plan.outcomes.filter((item) => item.state === 'failed').length;
        const openUncertain = plan.outcomes.filter((item) => item.state === 'uncertain').length;
        progress.capsules[0] = openUncertain ? { capsuleId: 'activate-oe', label: '激活 OE Tab', state: 'uncertain', completed: plan.counts.total, total: plan.counts.total, detail: `${plan.counts.total}/${plan.counts.total}` }
          : openFailed ? { capsuleId: 'activate-oe', label: '激活 OE Tab', state: 'failed', completed: plan.counts.total, total: plan.counts.total, detail: `${plan.counts.total}/${plan.counts.total}` }
            : { capsuleId: 'activate-oe', label: '激活 OE Tab', state: 'passed', completed: plan.counts.total, total: plan.counts.total, detail: `${plan.counts.total}/${plan.counts.total}` };
      }
    } catch (error) {
      const summary = errorSummary(error);
      progress.capsules[0] = { capsuleId: 'activate-oe', label: '激活 OE Tab', state: 'failed', completed: 0, total: 0, detail: summary.message };
      progress.state = 'failed';
      plan.workpaper.state = 'writeback_uncertain';
      plan.surfaceStateVersion += 1; await save(plan);
      return plan;
    }
    plan.surfaceStateVersion += 1; await save(plan);

    // Capsule 2: read back every Control.
    progress.capsules[1] = { capsuleId: 'readback', label: '读回 Control', state: 'running', completed: 0, total: 0, detail: '正在读回' };
    await save(plan);
    try {
      await readbackAllControls(plan, context);
      progress.capsules[1] = { capsuleId: 'readback', label: '读回 Control', state: 'passed', completed: plan.readbackCount, total: plan.readbackCount, detail: `${plan.readbackCount}/${plan.readbackCount}` };
    } catch (error) {
      progress.capsules[1] = { capsuleId: 'readback', label: '读回 Control', state: 'failed', completed: 0, total: 0, detail: errorSummary(error).message };
      progress.state = 'failed';
      plan.workpaper.state = 'writeback_uncertain';
      plan.surfaceStateVersion += 1; await save(plan);
      return plan;
    }
    plan.surfaceStateVersion += 1; await save(plan);

    // Capsule 3: intersect read-back Controls with resolved rows, then write.
    const reconcile = await planner().invoke('reconcile_writeback_controls', {
      schemaVersion: 'omnia.workpaper-writeback-reconcile-input/v1',
      readbackControls: plan.readbackControls, resolutions: plan.workpaper.resolution.resolutions
    }, { runId: plan.runId || plan.planId });
    if (!reconcile || reconcile.schemaVersion !== 'omnia.workpaper-writeback-reconcile/v1' || !Array.isArray(reconcile.rows)) {
      fail('WORKPAPER.RECONCILE_OUTPUT_INVALID', 'CPython returned an invalid write-back reconcile.');
    }
    const total = reconcile.rows.length;
    progress.capsules[2] = { capsuleId: 'writeback', label: '写回 Control', state: 'running', completed: 0, total, detail: `0/${total}` };
    await save(plan);

    const outcomes = [];
    const field = PHASE2_FIELDS.find((item) => item.backendKey === 'gitcNonDetailedTestingProcedures[phaseType=TestOfDesign].documentProcedureResults');
    if (!field || !field.writePath) fail('WORKPAPER.WRITEBACK_FIELD', 'TestOfDesign 字段没有可写的 Phase 2 合同。');
    for (let index = 0; index < reconcile.rows.length; index += 1) {
      const row = reconcile.rows[index];
      if (!row.matched) {
        outcomes.push({ controlId: row.controlId, state: 'skipped', reason: '无匹配的写回控制点' });
        progress.capsules[2] = { capsuleId: 'writeback', label: '写回 Control', state: 'running', completed: index + 1, total, detail: `${index + 1}/${total}` };
        plan.surfaceStateVersion += 1; await save(plan);
        continue;
      }
      const control = plan.controls.find((item) => item.controlId === row.controlId);
      if (!control) {
        outcomes.push({ controlId: row.controlId, state: 'skipped', reason: '读回 Control 不在冻结清单中' });
        progress.capsules[2] = { capsuleId: 'writeback', label: '写回 Control', state: 'running', completed: index + 1, total, detail: `${index + 1}/${total}` };
        plan.surfaceStateVersion += 1; await save(plan);
        continue;
      }
      const resolution = row.resolution;
      if (!resolution || typeof resolution.resolvedText !== 'string') {
        outcomes.push({ controlId: row.controlId, state: 'skipped', reason: '无占位符需写回' });
        progress.capsules[2] = { capsuleId: 'writeback', label: '写回 Control', state: 'running', completed: index + 1, total, detail: `${index + 1}/${total}` };
        plan.surfaceStateVersion += 1; await save(plan);
        continue;
      }
      const snapshot = await invoke(OPERATIONS.snapshot, { connectorBinding: b, ...controlRequest(control, control) });
      if (!snapshot || snapshot.controlId !== control.controlId) {
        outcomes.push({ controlId: row.controlId, state: 'uncertain', reason: '实时快照身份漂移' });
      } else {
        const procedure = (snapshot.procedures || []).find((item) => item.phaseType === 'TestOfDesign');
        const currentText = procedure ? procedure.documentProcedureResults : '';
        const finalText = resolution.resolvedText;
        if (finalText === currentText) {
          outcomes.push({ controlId: row.controlId, state: 'skipped', reason: '占位符已解析，无实际变更' });
        } else {
          const changes = [{ writePath: field.writePath, value: finalText, valueKind: 'editor',
            concurrencyTab: field.concurrencyTab || 201, phaseType: 'TestOfDesign' }];
          try {
            const result = await invoke(OPERATIONS.writeback, {
              connectorBinding: b, ...controlRequest(control, control),
              command: { payload: { controlId: control.controlId, changes } }
            });
            const allConfirmed = Array.isArray(result.ledger) && result.ledger.every((entry) => entry.confirmed === true);
            outcomes.push({ controlId: row.controlId, state: allConfirmed ? 'succeeded' : 'uncertain', ledger: result.ledger });
          } catch (error) {
            outcomes.push({ controlId: row.controlId, state: 'uncertain', code: errorSummary(error).code, message: errorSummary(error).message });
          }
        }
      }
      progress.capsules[2] = { capsuleId: 'writeback', label: '写回 Control', state: 'running', completed: index + 1, total, detail: `${index + 1}/${total}` };
      plan.surfaceStateVersion += 1; await save(plan);
    }
    const uncertainCount = outcomes.filter((item) => item.state === 'uncertain').length;
    const succeededCount = outcomes.filter((item) => item.state === 'succeeded').length;
    const skippedCount = outcomes.filter((item) => item.state === 'skipped').length;
    progress.capsules[2] = { capsuleId: 'writeback', label: '写回 Control', state: uncertainCount ? 'uncertain' : 'passed', completed: total, total, detail: `${total}/${total}` };
    progress.state = uncertainCount ? 'uncertain' : 'passed';
    plan.workpaper.writeback = { ...progress, outcomes };
    plan.workpaper.state = uncertainCount ? 'writeback_uncertain' : 'writeback_complete';
    plan.workpaper.writebackCounts = { total, succeeded: succeededCount, skipped: skippedCount, uncertain: uncertainCount };
    plan.surfaceStateVersion += 1; await save(plan);
    return plan;
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
  // Execute a single Control's frozen hidden-Tab intent to completion without
  // mutating the shared plan or transitioning the Core Run. Returns a lane
  // result the caller merges under a serialized recorder. A Control is
  // independent of every other Control, so one drifted row must not block the
  // rest of the batch.
  async function executeStep(plan, step, b, s) {
    const existing = plan.outcomes.find((item) => item.stepId === step.stepId);
    if (existing && existing.state === 'succeeded') return { step, terminal: 'succeeded', phase: 'already_applied', commandId: existing.commandId || '' };
    let before;
    try {
      before = await currentPreflight(step, b, plan.planDigest, plan.runId);
      const partialRecovery = plan.partialRecovery && plan.partialRecovery.stepId === step.stepId
        && plan.partialRecovery.observedDigest === digest(observationState(before));
      if (!before.openVerified && digest(observationState(before)) !== step.preflightDigest && !partialRecovery) {
        fail('WORKPAPER.PREFLIGHT_DRIFT', `Control state changed before mutation: ${step.controlId}`);
      }
    } catch (error) {
      return { step, terminal: 'failed', phase: 'preflight', error, commandId: '' };
    }
    const intent = { kind: 'field', key: step.stepId, workspace: step.workspaceId };
    let command;
    try {
      command = await store.call('prepareDeletionCommand', { runId: plan.runId, planDigest: plan.planDigest,
        targetKind: intent.kind, targetKey: intent.key, workspaceId: step.workspaceId, binding: b, workspaceIds: s.workspaceIds,
        operationId: OPERATIONS.direct, request: step.mutationPayload, evidenceOperationIds: [OPERATIONS.reconcile], evidenceTargetIdentityKey: step.stepId });
    } catch (error) {
      return { step, terminal: 'failed', phase: 'command_prepare', error, commandId: '' };
    }
    const readRequest = await freezeReconcile(plan, step, command.commandId, b);
    if (!before.openVerified) {
      try {
        await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
          evidenceType: 'request', commandState: 'submitted', payload: { operationId: OPERATIONS.direct } });
      } catch (error) {
        await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
          evidenceType: 'request', commandState: 'failed', payload: { code: errorSummary(error).code }, error: errorSummary(error).message });
        return { step, terminal: 'failed', phase: 'before_mutation', error, commandId: command.commandId };
      }
      let response;
      try {
        response = await invoke(OPERATIONS.direct, { connectorBinding: b, target: operationTarget(step), planDigest: plan.planDigest,
          ...controlRequest(step, step),
          command: { commandId: command.commandId, idempotencyKey: command.idempotencyKey, payload: step.mutationPayload } });
      } catch (error) {
        return { step, terminal: 'uncertain', phase: 'submitted', error, commandId: command.commandId };
      }
      try {
        await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
          evidenceType: 'commit', commandState: 'committed', payload: response });
      } catch (error) {
        return { step, terminal: 'uncertain', phase: 'committed', error, commandId: command.commandId };
      }
    }
    let observed;
    try {
      observed = await invoke(OPERATIONS.reconcile, { ...readRequest, receiptContext: { runId: plan.runId, commandId: command.commandId } });
      const classification = await classifyObservation(observed, selectedIdentity(step), step, plan.runId);
      if (classification.outcome !== 'applied') fail('WORKPAPER.READBACK_PENDING', 'Readback does not yet prove the complete recorded hidden-Tab state.');
      await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
        evidenceType: before.openVerified ? 'reconcile' : 'readback', commandState: 'readback_verified', payload: observed,
        receiptId: observed.__operationReceiptId });
    } catch (error) {
      return { step, terminal: 'uncertain', phase: 'readback', error, commandId: command.commandId };
    }
    try { await project(plan, step, command.commandId, b, observed); }
    catch (error) {
      return { step, terminal: 'uncertain', phase: 'projection', error, commandId: command.commandId, observed };
    }
    return { step, terminal: 'succeeded', phase: before.openVerified ? 'already_applied' : 'readback_verified', commandId: command.commandId };
  }
  async function execute(plan, context) {
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    await store.call('validateReturnAuthority', { runId: plan.runId, connectorBinding: b, safetyLock: s });
    plan.state = 'executing'; delete plan.uncertain; await save(plan);

    // Bounded worker pool. Lanes run the expensive Connector HTTP round-trips
    // concurrently; the shared plan is only touched through the serialized
    // recorder below, and the single Core Run transition is deferred to the end.
    const steps = plan.steps;
    const results = new Array(steps.length);
    let cursor = 0;
    let recordTail = Promise.resolve();
    const lane = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= steps.length) return;
        let result;
        try {
          result = await executeStep(plan, steps[index], b, s);
        } catch (error) {
          result = { step: steps[index], terminal: 'uncertain', phase: 'unknown', error, commandId: '', observed: null };
        }
        results[index] = result;
        const value = result;
        recordTail = recordTail.catch(() => undefined).then(async () => {
          const step = value.step;
          if (value.terminal === 'succeeded') await persistOutcome(plan, step, 'succeeded', value.phase, null, value.commandId || '');
          else if (value.terminal === 'failed') await persistOutcome(plan, step, 'failed', value.phase, value.error, value.commandId || '');
          else await persistOutcome(plan, step, 'uncertain', value.phase, value.error, value.commandId || '');
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(steps.length, OPEN_CONCURRENCY) }, () => lane()));
    await recordTail;

    // Resolve the authoritative terminal state in frozen step order. An unknown
    // mutation effect (uncertain) outranks a clean failure because it must be
    // reconciled read-only before any further action.
    let terminal = 'succeeded';
    let firstUncertain = null;
    for (const result of results) {
      if (!result) continue;
      if (result.terminal === 'uncertain') { terminal = 'uncertain'; if (!firstUncertain) firstUncertain = result; }
      else if (result.terminal === 'failed' && terminal === 'succeeded') terminal = 'failed';
    }
    if (terminal === 'uncertain') {
      const failure = errorSummary(firstUncertain.error);
      if (firstUncertain.phase !== 'projection' && firstUncertain.commandId) {
        try {
          await store.call('recordReturnEvidence', { runId: plan.runId, commandId: firstUncertain.commandId,
            evidenceType: 'commit', commandState: 'uncertain', payload: { phase: firstUncertain.phase, code: failure.code }, error: failure.message });
        } catch {}
      }
      plan.uncertain = { controlId: firstUncertain.step.controlId, stepId: firstUncertain.step.stepId,
        commandId: firstUncertain.commandId, phase: firstUncertain.phase, failure,
        ...(firstUncertain.observed ? { observed: firstUncertain.observed } : {}) };
      await store.call('finishReturn', { runId: plan.runId, outcome: 'uncertain', error: `${failure.code}: ${failure.message}` });
      plan.state = 'uncertain';
    } else if (terminal === 'failed') {
      await store.call('finishReturn', { runId: plan.runId, outcome: 'failed', error: 'One or more Controls failed before a verified read-back.' });
      plan.state = 'failed';
    } else {
      await store.call('finishReturn', { runId: plan.runId, outcome: 'succeeded' });
      plan.state = 'completed';
    }
    return save(plan);
  }
  async function handleAction(input) {
    const context = input.context || {};
    if (input.actionId === 'bootstrap-workpaper-directory' || input.actionId === 'refresh-workpaper-directory') {
      return { surfacePatch: await refresh(context) };
    }
    if (input.actionId === 'select-elements') {
      const plan = await selectElements(context, input.payload && input.payload.targetIds, input.expectedStateVersion);
      // "选择元素并下一步": selecting immediately generates the pre-filled
      // template and advances into the upload step. No separate generate action.
      const generated = await generateWorkpaper(plan, context);
      return { surfacePatch: workpaperSurface(generated) };
    }
    const plan = await current();
    if (!plan) fail('WORKPAPER.PLAN_NOT_FOUND', 'Current workpaper plan was not found.');
    if (input.actionId === 'restart-run') {
      return { surfacePatch: await forceEnd(plan, context) };
    }
    if (input.actionId === 'next-to-writeback') {
      return { surfacePatch: workpaperSurface(await nextToWriteback(plan, context)) };
    }
    if (input.actionId === 'confirm-writeback') {
      const written = await confirmWriteback(plan, context);
      return { surfacePatch: workpaperSurface(written) };
    }
    if (input.actionId === 'upload-policy') {
      const uploaded = await uploadPolicy(plan, context, input.payload && input.payload.artifact);
      return { surfacePatch: workpaperSurface(uploaded) };
    }
    if (input.actionId === 'upload-filled-workbook') {
      const filled = await applyReplacementFields(plan, context, input.payload && input.payload.artifact);
      return { surfacePatch: workpaperSurface(filled) };
    }
    fail('WORKPAPER.ACTION_UNKNOWN', 'Action is not implemented.');
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
