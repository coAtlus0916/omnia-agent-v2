'use strict';

const crypto = require('node:crypto');
const { createPythonSidecarBridge } = require('./workpaper-preparation-python-bridge.cjs');

const FEATURE_ID = 'omnia.workpaper-preparation';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const CURRENT_POINTER = 'workpaper:current';
// The current release intentionally freezes one GRA / one APP per plan.
// Multi-GRA selection must remain unavailable until resolution reconciliation
// is keyed by the full GRA + APP identity instead of only the APP.xx code.
const MAX_BATCH_GRAS = 1;
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
// contract): the placeholder directory, Controls headers, and six Control row templates.
const PHASE2_TEMPLATE = Object.freeze(typeof __PHASE2_TEMPLATE__ !== 'undefined' ? __PHASE2_TEMPLATE__ : { directory: [], headers: [], controls: [] });
const WORKBOOK_IDENTITY_HEADERS = Object.freeze(['GRA 编号', 'GRA 名称', 'APP 名称', 'Control 编号', 'controlId', 'workItemId', 'workspaceId']);

function valueKindRead(current, kind) {
  if (current === null || current === undefined) return '';
  if (kind === 'number') return typeof current === 'number' ? current : text(current);
  if (kind === 'boolean') return current === true ? '是' : current === false ? '否' : text(current);
  if (kind === 'editor') return omniaEditorPlainText(current);
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
function parseOmniaEditorValue(value) {
  const raw = text(value);
  if (!raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && typeof parsed.editorData === 'string' && Array.isArray(parsed.suggestionsData)
      && typeof parsed.trackChangesEnableFlagInEditor === 'boolean' && typeof parsed.plainText === 'string'
      ? parsed : null;
  } catch { return null; }
}
function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/gu, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&#39;/giu, "'");
}
function omniaEditorPlainText(value) {
  const parsed = parseOmniaEditorValue(value);
  if (!parsed) return text(value);
  const html = parsed.editorData.replace(/\r\n?/gu, '\n')
    .replace(/<p\b[^>]*>\s*<br\s*\/?\s*>\s*<\/p>/giu, '\n')
    .replace(/<\/p>\s*<p\b[^>]*>/giu, '\n')
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/?p\b[^>]*>/giu, '')
    .replace(/<\/(?:div|li|h[1-6])>\s*/giu, '\n')
    .replace(/<[^>]+>/gu, '');
  return text(decodeHtmlEntities(html));
}
function escapeOmniaEditorHtml(value) {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}
function omniaEditorValue(value) {
  const plain = text(String(value == null ? '' : value).replace(/\r\n?/gu, '\n'));
  const editorData = plain.split('\n').map((line) => line
    ? `<p>${escapeOmniaEditorHtml(line)}</p>` : '<p><br></p>').join('');
  return JSON.stringify({ editorData, suggestionsData: [], trackChangesEnableFlagInEditor: false, plainText: '' });
}
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
function bindReplacementSystems(expectedSystemsInput, replacement) {
  const expectedSystems = unique(expectedSystemsInput);
  const uploadedSystems = unique(replacement && replacement.systems);
  const replacements = Array.isArray(replacement && replacement.replacements)
    ? replacement.replacements.map((item) => ({ ...item })) : [];
  const controls = Array.isArray(replacement && replacement.controls)
    ? replacement.controls.map((item) => ({ ...item, values: Array.isArray(item && item.values) ? [...item.values] : [] })) : [];
  const controlHeaders = Array.isArray(replacement && replacement.controlHeaders) ? [...replacement.controlHeaders] : [];
  if (!expectedSystems.length || !uploadedSystems.length) {
    fail('WORKPAPER.REPLACEMENT_SCOPE_DRIFT', '填写件的系统范围与冻结合同不一致。');
  }
  if (canonicalWorkpaperState(expectedSystems) === canonicalWorkpaperState(uploadedSystems)) {
    return { replacements, controls, controlHeaders, systems: expectedSystems,
      templateMode: text(replacement && replacement.templateMode) || 'legacy_replacements_only',
      binding: { mode: 'exact', uploadedSystems, targetSystems: expectedSystems } };
  }
  // A user-provided single-APP template is reusable for another single frozen
  // APP.  The workbook's row identity (code/control point/placeholder) remains
  // unchanged; only its explicit source-system label is rebound to the one
  // selected target. Multi-APP mismatches remain ambiguous and are rejected.
  if (expectedSystems.length !== 1 || uploadedSystems.length !== 1) {
    fail('WORKPAPER.REPLACEMENT_SCOPE_DRIFT', '多系统填写件无法唯一映射到当前冻结范围。');
  }
  const sourceSystem = uploadedSystems[0];
  const targetSystem = expectedSystems[0];
  const rebound = replacements.map((item) => {
    if (text(item && item.system) !== sourceSystem) {
      fail('WORKPAPER.REPLACEMENT_SCOPE_DRIFT', '填写件包含无法映射到唯一源系统的替换行。');
    }
    return { ...item, system: targetSystem };
  });
  const identities = rebound.map((item) => `${text(item.system)}\u0000${text(item.code)}`);
  if (new Set(identities).size !== identities.length) {
    fail('WORKPAPER.REPLACEMENT_DUPLICATE', '填写件映射后包含重复的系统/编号。');
  }
  const reboundControls = controls.map((item) => {
    if (text(item && item.system) !== sourceSystem || !Array.isArray(item && item.values)) {
      fail('WORKPAPER.REPLACEMENT_SCOPE_DRIFT', '填写件 Controls 行无法映射到唯一源系统。');
    }
    const values = item.values.map((value) => String(value == null ? '' : value).replaceAll(sourceSystem, targetSystem));
    return { ...item, system: targetSystem,
      controlNumber: text(item.controlNumber).replaceAll(sourceSystem, targetSystem), values };
  });
  return { replacements: rebound, controls: reboundControls, controlHeaders, systems: expectedSystems,
    templateMode: text(replacement && replacement.templateMode) || 'legacy_replacements_only',
    binding: { mode: 'single_system_rebind', uploadedSystems, targetSystems: expectedSystems } };
}
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
  const writebackTarget = (control) => ({
    targetIdentityKey: `workpaper-writeback|${control.workspaceId}|${control.riskAssessmentId}|${control.controlId}|phase2-fields`,
    workspaceId: control.workspaceId, riskAssessmentId: control.riskAssessmentId, controlId: control.controlId
  });
  const testOfDesignValue = (snapshot) => {
    const procedure = Array.isArray(snapshot && snapshot.procedures)
      ? snapshot.procedures.find((item) => item && item.phaseType === 'TestOfDesign') : null;
    return text(procedure && procedure.documentProcedureResults);
  };
  const testOfDesignText = (snapshot) => omniaEditorPlainText(testOfDesignValue(snapshot));
  function retryablePlaintextEditorWriteback(plan) {
    const wp = plan && plan.workpaper;
    const writeback = wp && wp.writeback;
    const outcomes = writeback && Array.isArray(writeback.outcomes) ? writeback.outcomes : [];
    const pending = wp && wp.writebackRun;
    const candidates = pending && Array.isArray(pending.candidates) ? pending.candidates : [];
    const policySource = wp && Array.isArray(wp.sources)
      ? wp.sources.find((item) => item && item.actionId === 'upload-policy') : null;
    return Boolean(plan && plan.featureVersion === '0.1.69'
      && wp && wp.state === 'writeback_uncertain' && pending && pending.state === 'uncertain'
      && wp.replacement && wp.replacement.state === 'filled'
      && wp.policy && /^[0-9a-f]{64}$/u.test(text(wp.policy.uploadedSha256))
      && policySource && text(policySource.artifactId)
      && text(policySource.sha256) === text(wp.policy.uploadedSha256)
      && outcomes.length > 0 && candidates.length === outcomes.length
      && outcomes.every((item) => item && ['succeeded', 'uncertain'].includes(item.state) && text(item.commandId))
      && candidates.every((candidate) => {
        const changes = candidate && Array.isArray(candidate.changes) ? candidate.changes : [];
        const change = changes.length === 1 ? changes[0] : null;
        return Boolean(candidate && candidate.control && text(candidate.control.controlId)
          && typeof candidate.finalText === 'string' && text(candidate.finalText)
          && change && change.valueKind === 'editor' && change.phaseType === 'TestOfDesign'
          && text(change.value) === text(candidate.finalText) && !parseOmniaEditorValue(change.value));
      })
      && wp.writebackCounts && Number(wp.writebackCounts.total) === outcomes.length
      && Number(wp.writebackCounts.skipped) === 0
      && Number(wp.writebackCounts.succeeded) + Number(wp.writebackCounts.uncertain) === outcomes.length);
  }
  function retryableRejectedWriteback(plan) {
    const wp = plan && plan.workpaper;
    const writeback = wp && wp.writeback;
    const outcomes = writeback && Array.isArray(writeback.outcomes) ? writeback.outcomes : [];
    const policySource = wp && Array.isArray(wp.sources)
      ? wp.sources.find((item) => item && item.actionId === 'upload-policy') : null;
    const durableWitnessRejection = Boolean(wp && wp.state === 'writeback_uncertain'
      && !wp.writebackRun
      && wp.replacement && wp.replacement.state === 'filled'
      && wp.policy && /^[0-9a-f]{64}$/u.test(text(wp.policy.uploadedSha256))
      && policySource && text(policySource.artifactId)
      && text(policySource.sha256) === text(wp.policy.uploadedSha256)
      && outcomes.length > 0
      && outcomes.every((item) => item && item.state === 'uncertain'
        && item.code === 'CONNECTOR_NEXT.DURABLE_MUTATION_REQUIRED' && !text(item.commandId))
      && wp.writebackCounts && Number(wp.writebackCounts.total) === outcomes.length
      && Number(wp.writebackCounts.succeeded) === 0
      && Number(wp.writebackCounts.uncertain) === outcomes.length);
    return durableWitnessRejection || retryablePlaintextEditorWriteback(plan);
  }
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
    const rejectedRetry = retryableRejectedWriteback(plan);
    const editorRepair = retryablePlaintextEditorWriteback(plan);
    return [
      { actionId: 'bootstrap-workpaper-directory', enabled: false, visible: false, reason: 'Initial authoritative APP GRA read has completed.' },
      { actionId: 'refresh-workpaper-directory', enabled: directory, visible: directory, reason: directory ? '' : '底稿流程已开始。' },
      { actionId: 'select-elements', enabled: directory, visible: directory, reason: directory ? '' : '填写件模板已生成。' },
      { actionId: 'upload-filled-workbook', enabled: generated, visible: generated, reason: generated ? '' : '请先生成填写件模板，再上传填写好的参数表。' },
      { actionId: 'upload-policy', enabled: generated, visible: generated, reason: generated ? '' : '请先生成填写件模板，再上传制度资料。' },
      { actionId: 'next-to-writeback', enabled: materialsReady, visible: materialsReady, reason: materialsReady ? '' : '请先上传填写件与制度资料，再进入确认回传。' },
      { actionId: 'confirm-writeback', enabled: awaitingWriteback || rejectedRetry, visible: awaitingWriteback || writebackUncertain,
        reason: awaitingWriteback ? '' : editorRepair ? '上次正文使用了 Omnia 无法渲染的裸文本；可用原始材料改为编辑器 JSON 后安全补写。'
          : rejectedRetry ? '上次写回在 mutation 启动前被拒绝；可使用原始材料安全重试。' : '请先进入确认回传步骤。' },
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
  // A clean, minimal surface once the input template is generated: no Control
  // catalog, only the input artifact and next-stage action. The resolved
  // workbook remains a backend artifact and does not add a review step.
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
        ? `可编辑填写件已生成：${wp.rowCount} 个 Control。请填写“替换字段”E 列或直接修改 Controls 后上传，并上传制度资料。`
        : wpState === 'awaiting_writeback'
          ? '填写件与制度资料已完成系统转换；可以确认回传。'
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
      const pointer = await store.call('loadPlan', CURRENT_POINTER);
      const previousPlan = pointer && pointer.currentPlanId ? await store.call('loadPlan', pointer.currentPlanId) : null;
      if (retryableRejectedWriteback(previousPlan)) return workpaperSurface(previousPlan);
      return directorySurface((await readDirectory(context)).directory);
    }
    catch (error) {
      const issue = errorSummary(error);
      return { schemaVersion: 'omnia.declarative-feature-surface-patch/v1', status: 'error', statusMessage: `${issue.code}: ${issue.message}`,
        scopes: [], items: [], selectedItemIds: [], workflow: workflowSurface(null), clearFields: ['progress'], actions: actionPatch(null) };
    }
  }
  async function selectElements(context, targetIds, expectedStateVersion) {
    if (!Array.isArray(targetIds) || targetIds.length !== MAX_BATCH_GRAS) {
      fail('WORKPAPER.SELECT_GRA_BATCH', '当前版本每次只能选择 1 个 Generic Application GRA。');
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
      const procedureIndex = Number.isInteger(field.procedureIndex) && field.procedureIndex >= 0 ? field.procedureIndex : 0;
      const procedure = (snapshot.procedures || []).filter((item) => item.phaseType === phaseType)[procedureIndex];
      return procedure ? procedure.documentProcedureResults : '';
    }
    return snapshot ? snapshot[key] : '';
  }
  function writebackValue(sourceValue, valueKind) {
    if (valueKind === 'editor') return omniaEditorValue(sourceValue);
    if (valueKind === 'boolean') {
      const normalized = text(sourceValue).normalize('NFKC').toLowerCase();
      if (['true', '1', '是', 'yes'].includes(normalized)) return true;
      if (['false', '0', '否', 'no'].includes(normalized)) return false;
      fail('WORKPAPER.WRITEBACK_BOOLEAN', `无法将母版值转换为布尔值：${text(sourceValue)}`);
    }
    if (valueKind === 'number' || valueKind === 'choice') {
      const normalized = Number(text(sourceValue));
      if (!Number.isFinite(normalized)) fail('WORKPAPER.WRITEBACK_NUMBER', `无法将母版值转换为${valueKind}：${text(sourceValue)}`);
      return normalized;
    }
    return text(sourceValue);
  }
  function fieldValueSatisfied(snapshot, field, expected) {
    const current = readFieldValue(snapshot, field);
    if (expected === null || expected === undefined) return current === null || current === undefined || text(current) === '';
    if (field.valueKind === 'number' || field.valueKind === 'choice') return Number(current) === Number(expected);
    if (field.valueKind === 'boolean') return current === expected;
    return text(current) === text(expected);
  }
  function resolutionFields(resolution) {
    if (Array.isArray(resolution && resolution.fields)) return resolution.fields;
    if (!resolution || typeof resolution.resolvedText !== 'string') return [];
    const field = PHASE2_FIELDS.find((item) => item.backendKey === 'gitcNonDetailedTestingProcedures[phaseType=TestOfDesign].documentProcedureResults');
    return field ? [{ ...field, sourceHeader: field.sourceHeader || 'documentProcedureResults - TestOfDesign',
      sourceState: text(resolution.resolvedText) ? 'present' : 'empty', resolvedText: resolution.resolvedText,
      supported: Boolean(field.writePath) }] : [];
  }
  async function generateWorkpaper(plan, context) {
    if (!plan || plan.workpaper) {
      fail('WORKPAPER.GENERATE_INVALID', '填写件模板已生成或没有当前计划；请先选择元素。');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    if (!PHASE2_TEMPLATE.directory.length || !PHASE2_TEMPLATE.headers.length || !PHASE2_TEMPLATE.controls.length) {
      fail('WORKPAPER.TEMPLATE_EMPTY', 'Phase 2 预置模板数据缺失。');
    }
    // The editable template is generated from the selected APP names, not from
    // live Control field values. It carries both the replacement directory and
    // the six Controls row templates (APP.01/02/05/06/10/13), with placeholders
    // left for user input plus policy-AI resolution.
    const systems = plan.selectedGras.map((item) => item.appName || item.appNumber).filter(text);
    if (!systems.length) fail('WORKPAPER.NO_SYSTEMS', '当前计划没有可生成填写件的 APP。');
    const scope = workpaperScope(plan, { b, s });
    const runId = plan.runId || plan.planId;
    const built = await planner().invoke('build_phase2_template', {
      schemaVersion: 'omnia.workpaper-phase2-workbook/v1', systems,
      directory: PHASE2_TEMPLATE.directory, headers: PHASE2_TEMPLATE.headers,
      controls: PHASE2_TEMPLATE.controls, scope
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
      semanticDigest: built.semanticDigest, rowCount: built.controlRowCount,
      replacementRowCount: built.replacementRowCount, headers: built.sheetNames,
      scope, scopeDigest: digest(scope), generatedAt: plan.updatedAt, state: 'generated',
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
      sha256: bytes.sha256 || '', sizeBytes: bytes.sizeBytes || 0,
      runId: bytes.runId || '', reason: reason || '' };
    if (actionId) entry.actionId = actionId;
    if (existing) Object.assign(existing, entry); else plan.workpaper.sources.push(entry);
  }
  // Feature AI review is authorized against a Core-owned Feature Run, not the
  // private plan id used by this Worker's SQLite store. Source intake Runs are
  // valid Core identities even after their bytes have been parsed and the Run
  // has been closed. Prefer the policy upload because it is the evidence being
  // reviewed, then fall back to another current source or an existing Core
  // mutation Run for historical recovery plans.
  function featureAiReviewRunId(plan) {
    const sources = Array.isArray(plan && plan.workpaper && plan.workpaper.sources)
      ? plan.workpaper.sources : [];
    const policy = [...sources].reverse().find((item) => item && item.actionId === 'upload-policy' && text(item.runId));
    if (policy) return text(policy.runId);
    const source = [...sources].reverse().find((item) => item && text(item.runId));
    if (source) return text(source.runId);
    return text(plan && plan.runId);
  }
  async function uploadPolicy(plan, context, artifactDescriptor) {
    if (!plan || !plan.workpaper || plan.workpaper.state !== 'generated') {
      fail('WORKPAPER.POLICY_INVALID', '请先生成控制底稿模板，再上传制度资料。');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const runId = plan.runId || plan.planId;
    if (!artifactDescriptor || artifactDescriptor.schemaVersion !== 'omnia.feature-artifact/v1'
      || artifactDescriptor.featureId !== FEATURE_ID || artifactDescriptor.kind !== 'source'
      || !text(artifactDescriptor.runId)) {
      fail('WORKPAPER.POLICY_IDENTITY', '制度压缩包身份无效；请重新选择。');
    }
    // Never transfer policy bytes through the Worker or Python JSON-RPC frame.
    // Core verifies the managed Artifact and exposes a bounded read-only handle.
    let handle = null;
    let extraction;
    try {
      handle = await store.call('openPythonArtifactHandle', {
        runId: artifactDescriptor.runId, artifactId: artifactDescriptor.artifactId
      });
      extraction = await planner().invoke('extract_policy_archive', {
        schemaVersion: 'omnia.workpaper-policy-archive/v1', zipPath: handle.path,
        sourceName: handle.originalName
      }, { runId });
    } finally {
      if (handle && handle.handleId) await store.call('releasePythonArtifactHandles', { handleIds: [handle.handleId] });
    }
    if (!extraction || extraction.schemaVersion !== 'omnia.workpaper-policy-extraction/v1'
      || !Array.isArray(extraction.documents)) {
      fail('WORKPAPER.POLICY_EXTRACT', '制度压缩包文本提取失败。');
    }
    await closeSourceIntakeRun(handle);
    recordSourceFile(plan, artifactDescriptor, handle, '制度资料', 'upload-policy');
    plan.workpaper.policy = {
      documents: extraction.documents, skipped: extraction.skipped || [],
      documentCount: extraction.documentCount, skippedCount: extraction.skippedCount,
      uploadedSha256: handle.sha256, state: 'extracted'
    };
    plan.surfaceStateVersion += 1; await save(plan);
    // Uploading materials never advances the workflow; resolution runs only on
    // the explicit 下一步 transition once both inputs are present.
    return plan;
  }
  // Parse the user-filled editable template. Legacy uploads may contain only
  // 替换字段; current uploads also return the edited Controls rows. In both
  // modes, the workbook identity and frozen system scope are validated before
  // user content can enter policy resolution.
  async function applyReplacementFields(plan, context, artifactDescriptor) {
    if (!plan || !plan.workpaper || plan.workpaper.state !== 'generated') {
      fail('WORKPAPER.REPLACEMENT_INVALID', '请先生成填写件模板，再上传填写好的参数表。');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const runId = plan.runId || plan.planId;
    if (!artifactDescriptor || artifactDescriptor.schemaVersion !== 'omnia.feature-artifact/v1'
      || artifactDescriptor.featureId !== FEATURE_ID || artifactDescriptor.kind !== 'source'
      || !text(artifactDescriptor.runId)) {
      fail('WORKPAPER.REPLACEMENT_IDENTITY', '填写件身份无效；请重新选择。');
    }
    let handle = null;
    let replacement;
    try {
      handle = await store.call('openPythonArtifactHandle', {
        runId: artifactDescriptor.runId, artifactId: artifactDescriptor.artifactId
      });
      replacement = await planner().invoke('apply_replacement_fields', {
        schemaVersion: 'omnia.workpaper-replacement-input/v1', xlsxPath: handle.path,
        expectedDirectory: PHASE2_TEMPLATE.directory,
        expectedHeaders: PHASE2_TEMPLATE.headers, controlTemplates: PHASE2_TEMPLATE.controls,
        expectedScope: plan.workpaper.scope || workpaperScope(plan, { b, s })
      }, { runId });
    } finally {
      if (handle && handle.handleId) await store.call('releasePythonArtifactHandles', { handleIds: [handle.handleId] });
    }
    if (!replacement || replacement.schemaVersion !== 'omnia.workpaper-replacement/v1'
      || !Array.isArray(replacement.replacements) || !Array.isArray(replacement.systems)
      || !Array.isArray(replacement.controls) || !Array.isArray(replacement.controlHeaders)) {
      fail('WORKPAPER.REPLACEMENT_PARSE', '填写件母版解析失败。');
    }
    await closeSourceIntakeRun(handle);
    recordSourceFile(plan, artifactDescriptor, handle, '填写件', 'upload-filled-workbook');
    // Bind a one-system user template to the one frozen target APP. Exact
    // multi-system templates remain supported; ambiguous multi-system drift is
    // rejected instead of guessing a row-to-APP mapping.
    const bound = bindReplacementSystems(plan.workpaper.systems, replacement);
    plan.workpaper.replacement = {
      replacements: bound.replacements, uploadedSystems: unique(replacement.systems),
      targetSystems: bound.systems, scopeBinding: bound.binding,
      controls: bound.controls, controlHeaders: bound.controlHeaders, templateMode: bound.templateMode,
      uploadedSha256: handle.sha256, state: 'filled'
    };
    plan.surfaceStateVersion += 1; await save(plan);
    return plan;
  }
  // Apply the user-filled 替换字段 values to a Control's TestOfDesign text.
  // System-level placeholders (controlPoint === 'AA通用') replace every row;
  // control-point placeholders (controlPoint === 'APP.xx') replace only the
  // matching control point. Empty values are never substituted.
  const USER_REPLACEMENT_OPEN_BRACKET = '\uE000';
  const USER_REPLACEMENT_CLOSE_BRACKET = '\uE001';
  function protectUserReplacementValue(value) {
    if (value.includes(USER_REPLACEMENT_OPEN_BRACKET) || value.includes(USER_REPLACEMENT_CLOSE_BRACKET)) {
      fail('WORKPAPER.REPLACEMENT_RESERVED_CHAR', '填写件包含保留字符，请删除私用区字符后重试。');
    }
    return value.replaceAll('【', USER_REPLACEMENT_OPEN_BRACKET)
      .replaceAll('】', USER_REPLACEMENT_CLOSE_BRACKET);
  }
  function restoreUserReplacementValue(value) {
    return String(value || '').replaceAll(USER_REPLACEMENT_OPEN_BRACKET, '【')
      .replaceAll(USER_REPLACEMENT_CLOSE_BRACKET, '】');
  }
  function protectUserAuthoredBracketTokens(value, masterValue) {
    const source = String(value || '');
    if (source.includes(USER_REPLACEMENT_OPEN_BRACKET) || source.includes(USER_REPLACEMENT_CLOSE_BRACKET)) {
      fail('WORKPAPER.REPLACEMENT_RESERVED_CHAR', '填写件包含保留字符，请删除私用区字符后重试。');
    }
    const masterCounts = new Map();
    for (const match of String(masterValue || '').matchAll(/【[^【】]*】/gu)) {
      masterCounts.set(match[0], (masterCounts.get(match[0]) || 0) + 1);
    }
    return source.replace(/【[^【】]*】/gu, (token) => {
      const remaining = masterCounts.get(token) || 0;
      if (remaining > 0) {
        masterCounts.set(token, remaining - 1);
        return token;
      }
      return protectUserReplacementValue(token);
    });
  }
  function applyReplacementValues(sourceText, system, controlNumber, replacements) {
    let output = sourceText;
    for (const item of replacements || []) {
      if (String(item.system || '') !== String(system || '')) continue;
      const point = String(item.controlPoint || '');
      if (point !== 'AA通用' && !(point && String(controlNumber || '').startsWith(point))) continue;
      const placeholder = String(item.placeholder || '');
      const value = String(item.value || '');
      if (!placeholder || !value) continue;
      output = output.split(placeholder).join(protectUserReplacementValue(value));
    }
    return output;
  }
  // Resolve placeholders across every source-backed Phase 2 master field.
  // Only fields with a recorded writePath are eligible for mutation later;
  // the others remain durable coverage gaps instead of disappearing silently.
  async function resolvePlaceholders(plan, context) {
    if (!plan || !plan.workpaper || plan.workpaper.state !== 'generated' || !plan.workpaper.policy) {
      fail('WORKPAPER.RESOLVE_INVALID', '请先上传制度资料，再生成底稿内容。');
    }
    const runId = plan.runId || plan.planId;
    const aiRunId = featureAiReviewRunId(plan);
    const aiFallbacks = [];
    let aiReviewCount = 0;
    if (!Array.isArray(plan.workpaper.policy.documents) || plan.workpaper.policy.documents.length === 0) {
      // No indexable policy text (e.g. all scanned PDFs were skipped). The
      // pre-filled template is still the authoritative write-back payload:
      // fall through and mark every placeholder as missing_evidence. The
      // original placeholder is retained for later manual completion in Pack;
      // no content is invented.
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
    const sourceFields = PHASE2_FIELDS.filter((field) => text(field && field.sourceHeader));
    if (!sourceFields.length) fail('WORKPAPER.PHASE2_SOURCE_FIELDS', 'Phase 2 母版字段合同缺少 sourceHeader。');
    const sourceIndex = new Map(PHASE2_TEMPLATE.headers.map((header, index) => [text(header), index]));
    for (const field of sourceFields) {
      if (!sourceIndex.has(text(field.sourceHeader))) {
        fail('WORKPAPER.PHASE2_SOURCE_HEADER', `Phase 2 母版缺少字段列：${text(field.sourceHeader)}`);
      }
    }
    const locatedPlaceholder = (p, state, value, evidenceRefs, reason) => ({
      placeholderId: String(p.placeholderId || ''), originalPlaceholder: String(p.originalPlaceholder || ''),
      index: Number.isInteger(p.index) ? p.index : undefined, state, value: String(value || ''),
      evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs.map(String) : [], reason: String(reason || '')
    });
    const missingEvidence = (placeholders, reason) => placeholders.map((p) =>
      locatedPlaceholder(p, 'missing_evidence', '', [], reason));
    const uploadedControls = plan.workpaper.replacement && Array.isArray(plan.workpaper.replacement.controls)
      ? plan.workpaper.replacement.controls : [];
    const sourceControlRows = uploadedControls.length
      ? uploadedControls.map((control) => ({ system: text(control.system), control }))
      : plan.workpaper.systems.flatMap((system) => PHASE2_TEMPLATE.controls.map((control) => ({ system, control })));
    for (const row of sourceControlRows) {
      const controlNumber = String(row.control.controlNumber || '').replace('系统ID', row.system);
      const masterControl = PHASE2_TEMPLATE.controls.find((control) =>
        String(control && control.controlNumber || '').replace('系统ID', row.system) === controlNumber);
      const fields = [];
      const allPlaceholders = [];
      for (const field of sourceFields) {
        const sourceHeader = text(field.sourceHeader);
        let sourceText = String((row.control.values || [])[sourceIndex.get(sourceHeader)] || '').replaceAll('系统ID', row.system);
        if (uploadedControls.length) {
          const masterText = masterControl && Array.isArray(masterControl.values)
            ? String(masterControl.values[sourceIndex.get(sourceHeader)] || '').replaceAll('系统ID', row.system) : '';
          sourceText = protectUserAuthoredBracketTokens(sourceText, masterText);
        }
        const protectedSourceText = applyReplacementValues(sourceText, row.system, controlNumber, replacements);
        let placeholders = [];
        if (text(protectedSourceText)) {
          const extracted = await planner().invoke('extract_placeholders', {
            schemaVersion: 'omnia.workpaper-placeholder-input/v1', controlNumber,
            sourceField: sourceHeader, sourceText: protectedSourceText
          }, { runId });
          placeholders = Array.isArray(extracted && extracted.placeholders) ? extracted.placeholders : [];
        }
        sourceText = restoreUserReplacementValue(protectedSourceText);
        allPlaceholders.push(...placeholders);
        fields.push({
          sourceHeader, backendKey: text(field.backendKey), frontendKey: text(field.frontendKey),
          valueKind: text(field.valueKind) || 'text', writePath: field.writePath || null,
          concurrencyTab: Number(field.concurrencyTab) || null,
          concurrencyMode: text(field.concurrencyMode) || 'live_token',
          purgeHiddenData: field.purgeHiddenData !== false,
          wireShape: text(field.wireShape), phaseType: text(field.phaseType),
          procedureIndex: Number.isInteger(field.procedureIndex) ? field.procedureIndex : 0,
          sourceText, sourceState: text(sourceText) ? 'present' : 'empty', placeholders
        });
      }
      let located = [];
      let snippets = [];
      if (allPlaceholders.length && !hasPolicyText) {
        located = missingEvidence(allPlaceholders, '未上传可索引的制度资料。');
      } else if (allPlaceholders.length) {
        const retrieved = await planner().invoke('retrieve_policy_snippets', {
          schemaVersion: 'omnia.workpaper-policy-retrieve-input/v1', index: policyIndex,
          control: { controlNumber, description: String((row.control.values || [])[2] || ''),
            documentProcedureResults: fields.map((field) => field.sourceText).filter(text).join('\n') }
        }, { runId });
        snippets = Array.isArray(retrieved && retrieved.snippets) ? retrieved.snippets : [];
        if (!snippets.length) located = missingEvidence(allPlaceholders, '未检索到相关制度片段。');
      }
      if (allPlaceholders.length && snippets.length) {
        const instructions = [
          '你是 IT 审计专家。只能根据给出的制度片段为已列出的占位符给出 resolution。',
          '不得重写原文；不得编造人名、日期、系统、流程或审计结论。',
          '每个 placeholderId 恰好返回一次。只有 state=evidence_supported 时 value 才能非空，且必须引用至少一个给出的 snippetId。',
          '资料不足用 missing_evidence；无法唯一判断用 ambiguous；这两种 value 必须是空字符串。',
          'evidenceRefs 只能使用给出的 snippetId。严格返回 {"resolutions":[...]}，每项含 placeholderId/state/value/evidenceRefs/reason。'
        ].join(' ');
        let fallback = null;
        if (!ai || typeof ai.review !== 'function') {
          fallback = { code: 'WORKPAPER.POLICY_AI_UNAVAILABLE', message: 'Feature AI 端口不可用。' };
        } else if (!aiRunId) {
          fallback = { code: 'WORKPAPER.POLICY_AI_RUN_IDENTITY_MISSING',
            message: '当前计划没有可用于 Feature AI review 的 Core Run identity。' };
        } else {
          try {
            aiReviewCount += 1;
            const result = await ai.review({ schemaVersion: 'omnia.feature-ai-review-request/v1',
              capabilityId: 'phase2-policy-resolution/v1', runId: aiRunId, instructions,
              input: { control: { controlNumber }, fields: fields.map((field) => ({ sourceHeader: field.sourceHeader,
                sourceText: field.sourceText })), placeholders: allPlaceholders, policySnippets: snippets } });
            const output = result && result.output;
            const res = Array.isArray(output && output.resolutions) ? output.resolutions : [];
            const byId = new Map();
            for (const item of res) {
              const id = String(item && item.placeholderId || '');
              if (!id || byId.has(id)) fail('WORKPAPER.POLICY_AI_INVALID', '制度解析 AI 返回了缺失或重复的 placeholderId。');
              byId.set(id, item);
            }
            const allowedRefs = new Set(snippets.map((item) => text(item && item.snippetId)).filter(Boolean));
            located = allPlaceholders.map((p) => {
              const r = byId.get(p.placeholderId);
              if (!r || !['evidence_supported', 'missing_evidence', 'ambiguous'].includes(String(r.state))) {
                fail('WORKPAPER.POLICY_AI_INVALID', '制度解析 AI 没有完整返回每一个占位符。');
              }
              const state = String(r.state);
              const value = String(r.value || '');
              const evidenceRefs = Array.isArray(r.evidenceRefs) ? r.evidenceRefs.map(String) : [];
              if (state === 'evidence_supported' && (!text(value) || !evidenceRefs.length
                || evidenceRefs.some((ref) => !allowedRefs.has(ref)))) {
                fail('WORKPAPER.POLICY_AI_INVALID', '制度解析 AI 的证据支持结果缺少正文或合法 evidenceRefs。');
              }
              if (state !== 'evidence_supported' && (text(value) || evidenceRefs.length)) {
                fail('WORKPAPER.POLICY_AI_INVALID', '无证据或歧义结果不得携带正文或 evidenceRefs。');
              }
              return locatedPlaceholder(p, state, value, evidenceRefs, String(r.reason || ''));
            });
          } catch (error) {
            fallback = errorSummary(error);
          }
        }
        if (fallback) {
          const failure = { controlNumber, code: text(fallback.code) || 'WORKPAPER.POLICY_AI_UNAVAILABLE',
            message: text(fallback.message).slice(0, 800), placeholderCount: allPlaceholders.length };
          aiFallbacks.push(failure);
          located = missingEvidence(allPlaceholders,
            `制度解析 AI 未完成，已保留母版占位符继续回传（${failure.code}）：${failure.message}`);
          for (const field of fields) {
            if (Array.isArray(field.placeholders) && field.placeholders.length) {
              field.placeholderWriteback = { mode: 'ai_failure_fallback', code: failure.code };
            }
          }
        }
      }
      const byPlaceholderId = new Map(located.map((item) => [item.placeholderId, item]));
      for (const field of fields) {
        field.placeholders = field.placeholders.map((item) => byPlaceholderId.get(item.placeholderId)
          || locatedPlaceholder(item, 'missing_evidence', '', [], '未解析。'));
        field.resolvedText = applyResolutions(field.sourceText, field.placeholders);
        field.supported = Boolean(field.writePath);
      }
      const tod = fields.find((field) => field.phaseType === 'TestOfDesign');
      resolutions.push({ controlNumber, fields, placeholders: located,
        resolvedText: tod ? tod.resolvedText : '', coverage: {
          total: fields.length, sourcePresent: fields.filter((field) => field.sourceState === 'present').length,
          supported: fields.filter((field) => field.sourceState === 'present' && field.supported).length,
          unsupported: fields.filter((field) => field.sourceState === 'present' && !field.supported).length
        } });
    }
    const placeholderResolutions = resolutions.flatMap((item) => Array.isArray(item.placeholders) ? item.placeholders : []);
    const coverage = {
      total: placeholderResolutions.length,
      evidenceSupported: placeholderResolutions.filter((item) => item.state === 'evidence_supported').length,
      missingEvidence: placeholderResolutions.filter((item) => item.state === 'missing_evidence').length,
      ambiguous: placeholderResolutions.filter((item) => item.state === 'ambiguous').length,
      aiFallback: resolutions.flatMap((item) => item.fields || []).filter((field) =>
        field && field.placeholderWriteback && field.placeholderWriteback.mode === 'ai_failure_fallback').length
    };
    coverage.manualCompletion = coverage.missingEvidence + coverage.ambiguous;
    plan.workpaper.resolution = {
      state: 'resolved', resolutions, coverage,
      manualCompletionRequired: coverage.manualCompletion > 0,
      ai: { state: aiFallbacks.length ? 'fallback' : aiReviewCount ? 'completed' : 'not_required',
        reviewRunId: aiRunId, fallbackMode: aiFallbacks.length ? 'placeholder_writeback' : '',
        reviewCount: aiReviewCount, failures: aiFallbacks },
      resolvedAt: new Date().toISOString()
    };
    plan.surfaceStateVersion += 1; await save(plan);
    return plan;
  }
  async function commitResolvedWorkbook(plan, context) {
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const resolutions = plan.workpaper && plan.workpaper.resolution && plan.workpaper.resolution.resolutions;
    if (!Array.isArray(resolutions) || !resolutions.length) {
      fail('WORKPAPER.RESOLVED_WORKBOOK_INVALID', '没有可生成已填写母版的解析字段。');
    }
    const resolutionByControl = new Map(resolutions.map((item) => [text(item && item.controlNumber), item]));
    const uploadedControls = plan.workpaper.replacement && Array.isArray(plan.workpaper.replacement.controls)
      ? plan.workpaper.replacement.controls : [];
    const baseControls = uploadedControls.length ? uploadedControls
      : plan.workpaper.systems.flatMap((system) => PHASE2_TEMPLATE.controls.map((control) => ({
          system, controlNumber: text(control.controlNumber).replaceAll('系统ID', system),
          values: (control.values || []).map((value) => String(value == null ? '' : value).replaceAll('系统ID', system))
        })));
    const headerIndex = new Map(PHASE2_TEMPLATE.headers.map((header, index) => [text(header), index]));
    const rows = baseControls.map((control) => {
      const values = Array.isArray(control.values) ? [...control.values] : [];
      if (values.length !== PHASE2_TEMPLATE.headers.length) {
        fail('WORKPAPER.RESOLVED_WORKBOOK_SHAPE', `Control ${text(control.controlNumber)} 的母版列数不正确。`);
      }
      const resolution = resolutionByControl.get(text(control.controlNumber));
      if (!resolution || !Array.isArray(resolution.fields)) {
        fail('WORKPAPER.RESOLVED_WORKBOOK_COVERAGE', `Control ${text(control.controlNumber)} 缺少制度解析结果。`);
      }
      for (const field of resolution.fields) {
        const index = headerIndex.get(text(field && field.sourceHeader));
        if (index !== undefined) values[index] = String(field.resolvedText == null ? '' : field.resolvedText);
      }
      return values;
    });
    const scope = plan.workpaper.scope || workpaperScope(plan, { b, s });
    const built = await planner().invoke('build_phase2_workbook', {
      schemaVersion: 'omnia.workpaper-phase2-workbook/v1', headers: PHASE2_TEMPLATE.headers, rows, scope
    }, { runId: plan.runId || plan.planId });
    if (!built || built.schemaVersion !== 'omnia.workpaper-phase2-workbook-result/v1'
      || !/^[0-9a-f]{64}$/u.test(built.sha256 || '') || !built.xlsxBase64 || built.rowCount !== rows.length) {
      fail('WORKPAPER.RESOLVED_WORKBOOK_INVALID', 'CPython 返回的已填写母版无效。');
    }
    const artifact = await store.call('commitStandaloneArtifact', {
      kind: 'result', contentBase64: built.xlsxBase64,
      originalName: `workpaper-phase2-filled-${plan.runId || plan.planId}.xlsx`,
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      engagementId: b.engagementId, surfaceId: 'workpaper-preparation.workbench', sourceRef: 'workpaper-phase2-filled'
    });
    if (!artifact || !artifact.artifactId || artifact.sha256 !== built.sha256) {
      fail('WORKPAPER.RESOLVED_ARTIFACT_COMMIT_FAILED', '已填写母版 Artifact 提交失败或摘要漂移。');
    }
    plan.workpaper.completedArtifact = { artifactId: artifact.artifactId, sha256: built.sha256,
      sizeBytes: built.sizeBytes, semanticDigest: built.semanticDigest, rowCount: built.rowCount,
      sheetNames: built.sheetNames, generatedAt: new Date().toISOString() };
    await save(plan);
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
      // Missing or ambiguous evidence is a real, incomplete state. Keep the
      // original placeholder visible so users may finish it in Pack instead
      // of silently converting it to an indistinguishable blank cell.
      const replacement = resolution.state === 'evidence_supported' ? String(resolution.value || '') : original;
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
    await commitResolvedWorkbook(plan, context);
    plan.workpaper.state = 'awaiting_writeback';
    plan.surfaceStateVersion += 1;
    await save(plan);
    return plan;
  }
  async function reprepareRejectedWriteback(plan, context) {
    if (!retryableRejectedWriteback(plan)) {
      fail('WORKPAPER.WRITEBACK_RETRY_UNSAFE', 'The previous write-back is not an exact supported historical repair case.');
    }
    const editorRepair = retryablePlaintextEditorWriteback(plan);
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    const sourcePlanId = plan.planId;
    plan = JSON.parse(JSON.stringify(plan));
    const wp = plan.workpaper;
    const policySource = wp.sources.find((item) => item && item.actionId === 'upload-policy');
    let sourceMetadata = policySource;
    // Historical plans did not persist the source intake Run id. Retain the
    // old metadata lookup only for those plans; every new upload is handle-only.
    if (!text(sourceMetadata && sourceMetadata.runId)) {
      sourceMetadata = await store.call('readArtifactBytes', { artifactId: policySource.artifactId });
    }
    if (!text(policySource.runId) && text(sourceMetadata && sourceMetadata.runId)) {
      policySource.runId = text(sourceMetadata.runId);
    }
    let handle = null;
    let extraction;
    try {
      handle = await store.call('openPythonArtifactHandle', {
        runId: sourceMetadata.runId, artifactId: policySource.artifactId
      });
      if (text(handle.sha256) !== text(policySource.sha256)
        || text(handle.sha256) !== text(wp.policy.uploadedSha256)) {
        fail('WORKPAPER.WRITEBACK_RETRY_ARTIFACT_DRIFT', 'The original policy artifact is unavailable or its SHA-256 has changed.');
      }
      extraction = await planner().invoke('extract_policy_archive', {
        schemaVersion: 'omnia.workpaper-policy-archive/v1', zipPath: handle.path,
        sourceName: handle.originalName
      }, { runId: plan.runId || plan.planId });
    } finally {
      if (handle && handle.handleId) {
        await store.call('releasePythonArtifactHandles', { handleIds: [handle.handleId] });
      }
    }
    if (!extraction || extraction.schemaVersion !== 'omnia.workpaper-policy-extraction/v1'
      || !Array.isArray(extraction.documents) || extraction.documents.length < 1) {
      fail('WORKPAPER.WRITEBACK_RETRY_POLICY_EMPTY', 'The original policy artifact still contains no indexable policy text.');
    }
    const previousWriteback = wp.writeback;
    wp.writebackRetry = {
      schemaVersion: 'omnia.workpaper-writeback-retry/v1', sourcePlanId,
      fromFeatureVersion: text(plan.featureVersion), toFeatureVersion: FEATURE_VERSION,
      rejectionCode: editorRepair ? 'WORKPAPER.EDITOR_PAYLOAD_PLAINTEXT_V0_1_69' : 'CONNECTOR_NEXT.DURABLE_MUTATION_REQUIRED',
      reason: editorRepair ? 'Rewrite the exact prior semantic text using the recorded Omnia rich-editor JSON envelope.'
        : 'Retry a mutation proven not to have started.', sourceArtifactId: policySource.artifactId,
      sourceSha256: handle.sha256, rejectedOutcomes: previousWriteback.outcomes,
      reprocessedAt: new Date().toISOString()
    };
    wp.policy = {
      documents: extraction.documents, skipped: extraction.skipped || [],
      documentCount: extraction.documentCount, skippedCount: extraction.skippedCount,
      uploadedSha256: handle.sha256, state: 'extracted'
    };
    wp.policyDocuments = extraction.documents;
    delete wp.resolution;
    delete wp.writeback;
    delete wp.writebackCounts;
    delete wp.writebackRun;
    wp.state = 'generated';
    plan.planId = crypto.randomUUID();
    plan.runId = '';
    plan.featureVersion = FEATURE_VERSION;
    await resolvePlaceholders(plan, context);
    wp.state = 'awaiting_writeback';
    plan.surfaceStateVersion += 1;
    await save(plan);
    return plan;
  }
  async function prepareWritebackRun(plan, candidates, b, s) {
    const coreRun = await store.call('createMutationRun', { engagementId: b.engagementId });
    const targets = candidates.map((candidate) => ({
      kind: 'field', key: candidate.target.targetIdentityKey, workspace: candidate.control.workspaceId,
      objectType: 'Control', objectId: candidate.control.controlId, workItemId: candidate.control.workItemId,
      riskAssessmentId: candidate.control.riskAssessmentId, appId: candidate.control.appId,
      baseline: { controlId: candidate.snapshot.controlId, workItemId: candidate.snapshot.workItemId,
        fields: candidate.changes.map((change) => ({ backendKey: change.backendKey, sourceHeader: change.sourceHeader,
          procedureIndex: change.procedureIndex, expectedValue: change.expectedValue })) },
      preflightDigest: digest({ controlId: candidate.snapshot.controlId, workItemId: candidate.snapshot.workItemId,
        fields: candidate.changes.map((change) => ({ backendKey: change.backendKey, sourceHeader: change.sourceHeader,
          procedureIndex: change.procedureIndex, expectedValue: change.expectedValue })) }),
      mutationOperationId: OPERATIONS.writeback, mutationPayload: candidate.mutationPayload,
      evidenceOperationIds: [OPERATIONS.snapshot], operationTargetIdentityKey: candidate.target.targetIdentityKey
    }));
    const graphDigest = digest(targets.map((item) => ({ key: item.key, preflightDigest: item.preflightDigest,
      mutationPayload: item.mutationPayload })));
    const frozen = await store.call('prepareReturnIntent', { runId: coreRun.runId,
      plan: { schemaVersion: 'omnia.workpaper-writeback-return-intent/v1', authority: {
        authorityInstanceId: b.authorityInstanceId, tenantOrOrgId: b.tenantOrOrgId,
        packId: b.packId, engagementId: b.engagementId }, selectedGras: plan.selectedGras, graphDigest, targets },
      connectorBinding: b, safetyLock: s, credentialDigest: credentialDigest(b, s), preflightDigest: graphDigest });
    plan.workpaper.hiddenTabRunId = plan.runId || '';
    plan.workpaper.writebackRun = { runId: coreRun.runId, graphDigest, planDigest: frozen.planDigest,
      state: 'waiting_confirmation', candidates, outcomes: [], completedCount: 0 };
    Object.assign(plan, { planId: coreRun.runId, runId: coreRun.runId, graphDigest, planDigest: frozen.planDigest,
      confirmationId: frozen.confirmationId, confirmationToken: frozen.confirmationToken,
      confirmationStateVersion: frozen.stateVersion });
    await save(plan);
    await store.call('approveReturnIntent', { confirmationId: frozen.confirmationId,
      confirmationToken: frozen.confirmationToken, expectedStateVersion: Number(frozen.stateVersion),
      connectorBinding: b, safetyLock: s });
    await store.call('validateReturnAuthority', { runId: plan.runId, connectorBinding: b, safetyLock: s });
    plan.workpaper.writebackRun = Object.assign(plan.workpaper.writebackRun || {}, {
      runId: coreRun.runId, graphDigest, planDigest: frozen.planDigest, state: 'returning',
      candidates, outcomes: [], completedCount: 0
    });
    await save(plan);
  }
  async function executeWritebackCandidate(plan, candidate, b, s) {
    const { control, target, mutationPayload } = candidate;
    const changes = Array.isArray(candidate.changes) ? candidate.changes : [];
    try {
      const live = await invoke(OPERATIONS.snapshot, { connectorBinding: b, target, planDigest: plan.planDigest,
        ...controlRequest(control, control) });
      if (!live || live.controlId !== control.controlId || live.workItemId !== control.workItemId) {
        fail('WORKPAPER.WRITEBACK_PREFLIGHT_IDENTITY_DRIFT', '写回前 Control 身份或 Work Item 已变化。');
      }
      if (!changes.length || changes.some((change) => !fieldValueSatisfied(live, change, change.expectedValue))) {
        fail('WORKPAPER.WRITEBACK_PREFLIGHT_DRIFT', '写回前一个或多个 Phase 2 字段已变化。');
      }
    } catch (error) {
      return { terminal: 'failed', phase: 'preflight', error, commandId: '' };
    }

    let command;
    try {
      command = await store.call('prepareDeletionCommand', { runId: plan.runId, planDigest: plan.planDigest,
        targetKind: 'field', targetKey: target.targetIdentityKey, workspaceId: control.workspaceId,
        binding: b, workspaceIds: s.workspaceIds, operationId: OPERATIONS.writeback, request: mutationPayload,
        evidenceOperationIds: [OPERATIONS.snapshot], evidenceTargetIdentityKey: target.targetIdentityKey });
    } catch (error) {
      return { terminal: 'failed', phase: 'command_prepare', error, commandId: '' };
    }

    const readRequest = { connectorBinding: b, target, ...controlRequest(control, control) };
    try {
      await store.call('freezeReturnEvidenceSpec', { runId: plan.runId, commandId: command.commandId,
        operationId: OPERATIONS.snapshot, request: readRequest });
      await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
        evidenceType: 'request', commandState: 'submitted', payload: { operationId: OPERATIONS.writeback } });
    } catch (error) {
      try {
        await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
          evidenceType: 'request', commandState: 'failed', payload: { code: errorSummary(error).code },
          error: errorSummary(error).message });
      } catch {}
      return { terminal: 'failed', phase: 'before_mutation', error, commandId: command.commandId };
    }

    let mutationResult;
    try {
      mutationResult = await invoke(OPERATIONS.writeback, { connectorBinding: b, target,
        planDigest: plan.planDigest, ...controlRequest(control, control), command: {
          commandId: command.commandId, idempotencyKey: command.idempotencyKey, payload: mutationPayload } });
      if (mutationResult && mutationResult.__connectorMutationNotStarted === true) {
        fail('WORKPAPER.WRITEBACK_NOT_STARTED', 'Connector 已证明正文写回未开始。');
      }
      await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
        evidenceType: 'commit', commandState: 'committed', payload: mutationResult });
    } catch (error) {
      return { terminal: 'uncertain', phase: 'submitted', error, commandId: command.commandId };
    }

    let observed;
    try {
      observed = await invoke(OPERATIONS.snapshot, { ...readRequest,
        receiptContext: { runId: plan.runId, commandId: command.commandId } });
      if (!observed || observed.controlId !== control.controlId || observed.workItemId !== control.workItemId
        || changes.some((change) => !fieldValueSatisfied(observed, change, change.value))) {
        fail('WORKPAPER.WRITEBACK_READBACK_MISMATCH', '权威读回未证明全部 Phase 2 字段已写入。');
      }
      await store.call('recordReturnEvidence', { runId: plan.runId, commandId: command.commandId,
        evidenceType: 'readback', commandState: 'readback_verified', payload: observed,
        receiptId: observed.__operationReceiptId });
    } catch (error) {
      return { terminal: 'uncertain', phase: 'readback', error, commandId: command.commandId };
    }
    try {
      await store.call('projectVerifiedReturn', { runId: plan.runId, commandId: command.commandId,
        binding: b, workspaceId: control.workspaceId, projectionKind: 'object', objectType: 'Control',
        objectId: control.controlId, provenance: { riskAssessmentId: control.riskAssessmentId,
          appId: control.appId, purpose: 'phase2_control_fields_writeback' }, payload: observed });
    } catch (error) {
      return { terminal: 'uncertain', phase: 'projection', error, commandId: command.commandId };
    }
    const ledger = Array.isArray(mutationResult && mutationResult.ledger) ? mutationResult.ledger : [];
    if (ledger.length !== changes.length || ledger.some((item) => item && item.confirmed !== true)) {
      return { terminal: 'uncertain', phase: 'connector_ledger',
        error: Object.assign(new Error('Connector ledger did not confirm every Phase 2 field.'), { code: 'WORKPAPER.WRITEBACK_LEDGER_MISMATCH' }),
        commandId: command.commandId };
    }
    return { terminal: 'succeeded', phase: 'readback_verified', commandId: command.commandId, ledger };
  }
  async function resumeWritebackRun(plan, context) {
    const pending = plan && plan.workpaper && plan.workpaper.writebackRun;
    if (!pending || !['waiting_confirmation','returning'].includes(pending.state) || !Array.isArray(pending.candidates)) {
      fail('WORKPAPER.WRITEBACK_RECOVERY_INVALID', '待恢复的正文写回计划缺少冻结候选清单。');
    }
    const { b, s } = contextAuthority(context); sameAuthority(b, plan.binding); sameSafety(s, plan.safety);
    if (pending.state === 'waiting_confirmation') {
      await store.call('approveReturnIntent', { confirmationId: plan.confirmationId,
        confirmationToken: plan.confirmationToken, expectedStateVersion: Number(plan.confirmationStateVersion),
        connectorBinding: b, safetyLock: s });
      pending.state = 'returning';
      await save(plan);
    }
    await store.call('validateReturnAuthority', { runId: plan.runId, connectorBinding: b, safetyLock: s });
    const outcomes = Array.isArray(pending.outcomes) ? pending.outcomes : [];
    const completed = new Set(outcomes.map((item) => text(item && item.controlId)).filter(Boolean));
    let writebackOutcome = outcomes.some((item) => item.state === 'uncertain') ? 'uncertain' : 'succeeded';
    for (const candidate of pending.candidates) {
      if (completed.has(candidate.control.controlId)) continue;
      const result = await executeWritebackCandidate(plan, candidate, b, s);
      if (result.terminal === 'succeeded') {
        outcomes.push({ controlId: candidate.control.controlId, state: 'succeeded', phase: result.phase,
          commandId: result.commandId, ledger: result.ledger });
      } else {
        writebackOutcome = result.terminal === 'uncertain' ? 'uncertain'
          : writebackOutcome === 'succeeded' ? 'failed' : writebackOutcome;
        const summary = errorSummary(result.error);
        outcomes.push({ controlId: candidate.control.controlId, state: 'uncertain', phase: result.phase,
          commandId: result.commandId, code: summary.code, message: summary.message });
      }
      pending.outcomes = outcomes;
      pending.completedCount = outcomes.length;
      await save(plan);
    }
    await store.call('finishReturn', { runId: plan.runId, outcome: writebackOutcome,
      ...(writebackOutcome !== 'succeeded' ? { error: 'Recovered Control body write-back lacks verified read-back.' } : {}) });
    pending.state = writebackOutcome;
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
    const candidates = [];
    const fieldCoverage = [];
    for (const row of reconcile.rows) {
      if (!row.matched) {
        outcomes.push({ controlId: row.controlId, state: 'skipped', reason: '无匹配的写回控制点' });
        continue;
      }
      const control = plan.controls.find((item) => item.controlId === row.controlId);
      if (!control) {
        outcomes.push({ controlId: row.controlId, state: 'skipped', reason: '读回 Control 不在冻结清单中' });
        continue;
      }
      const resolution = row.resolution;
      const resolvedFields = resolutionFields(resolution);
      if (!resolvedFields.length) {
        outcomes.push({ controlId: row.controlId, state: 'skipped', reason: '母版没有可核对的 Phase 2 字段' });
        continue;
      }
      const presentFields = resolvedFields.filter((field) => field.sourceState === 'present' && text(field.resolvedText));
      const requiresManualCompletion = (field) => Array.isArray(field && field.placeholders)
        && field.placeholders.some((placeholder) => text(placeholder && placeholder.state) !== 'evidence_supported');
      const allowsPlaceholderFallback = (field) => requiresManualCompletion(field)
        && ['editor', 'text'].includes(text(field && field.valueKind) || 'text');
      for (const field of resolvedFields) {
        const manualCompletion = text(field.resolvedText) && requiresManualCompletion(field);
        const fallbackAllowed = manualCompletion && allowsPlaceholderFallback(field);
        const fallbackRequested = manualCompletion && field && field.placeholderWriteback
          && field.placeholderWriteback.mode === 'ai_failure_fallback';
        fieldCoverage.push({ controlId: row.controlId, controlNumber: row.controlNumber,
          sourceHeader: text(field.sourceHeader), backendKey: text(field.backendKey), frontendKey: text(field.frontendKey),
          sourceState: field.sourceState || (text(field.resolvedText) ? 'present' : 'empty'),
          supportState: field.writePath ? 'recorded' : 'recording_required',
          manualCompletionRequired: Boolean(manualCompletion),
          writebackMode: fallbackAllowed && fallbackRequested ? 'ai_failure_placeholder_fallback'
            : fallbackAllowed ? 'unresolved_placeholder_fallback'
            : fallbackRequested ? 'ai_failure_placeholder_type_incompatible' : 'normal',
          state: !text(field.resolvedText) ? 'source_empty'
            : !field.writePath ? 'unsupported'
              : manualCompletion && !fallbackAllowed ? 'manual_completion' : 'pending' });
      }
      // Missing/ambiguous evidence remains visibly unresolved, but recorded
      // text/editor APIs still receive the unchanged master placeholder so the
      // Pack is never left blank. Typed fields cannot safely carry a placeholder
      // string and remain manual-only, including when Feature AI itself fails.
      const supportedFields = presentFields.filter((field) => field.writePath
        && (!requiresManualCompletion(field) || allowsPlaceholderFallback(field)));
      if (!supportedFields.length) {
        const manualFields = presentFields.filter((field) => field.writePath && requiresManualCompletion(field));
        outcomes.push({ controlId: row.controlId, state: 'skipped',
          reason: manualFields.length ? '母版字段仍含待人工补录占位符' : '母版非空字段均缺少已录制写入协议',
          manualCompletionFields: manualFields.map((field) => field.sourceHeader),
          unsupportedFields: presentFields.filter((field) => !field.writePath).map((field) => field.sourceHeader) });
        continue;
      }
      let snapshot;
      try {
        snapshot = await invoke(OPERATIONS.snapshot, { connectorBinding: b, ...controlRequest(control, control) });
      } catch (error) {
        const summary = errorSummary(error);
        outcomes.push({ controlId: row.controlId, state: 'uncertain', phase: 'snapshot', code: summary.code, message: summary.message });
        continue;
      }
      if (!snapshot || snapshot.controlId !== control.controlId || snapshot.workItemId !== control.workItemId) {
        outcomes.push({ controlId: row.controlId, state: 'uncertain', reason: '实时快照身份或 Work Item 漂移' });
        continue;
      }
      const changes = [];
      try {
        for (const field of supportedFields) {
          const observedValue = readFieldValue(snapshot, field);
          const expectedValue = observedValue === undefined ? null : observedValue;
          const value = writebackValue(field.resolvedText, field.valueKind);
          const coverage = fieldCoverage.find((item) => item.controlId === row.controlId
            && item.sourceHeader === field.sourceHeader);
          if (fieldValueSatisfied(snapshot, field, value)) {
            if (coverage) coverage.state = 'unchanged';
            continue;
          }
          changes.push({ writePath: field.writePath, value, expectedValue,
            valueKind: field.valueKind || 'text', concurrencyTab: field.concurrencyTab,
            concurrencyMode: field.concurrencyMode || 'live_token', purgeHiddenData: field.purgeHiddenData !== false,
            wireShape: field.wireShape || '', phaseType: field.phaseType || '',
            procedureIndex: Number.isInteger(field.procedureIndex) ? field.procedureIndex : 0,
            backendKey: field.backendKey, sourceHeader: field.sourceHeader, frontendKey: field.frontendKey });
        }
      } catch (error) {
        const summary = errorSummary(error);
        outcomes.push({ controlId: row.controlId, state: 'uncertain', phase: 'field_conversion',
          code: summary.code, message: summary.message });
        continue;
      }
      if (!changes.length) {
        outcomes.push({ controlId: row.controlId, state: 'skipped', reason: '母版字段与实时 Control 已一致',
          fieldCount: supportedFields.length });
        continue;
      }
      candidates.push({ row, control, resolution, snapshot, changes,
        target: writebackTarget(control), mutationPayload: { controlId: control.controlId, changes } });
    }

    if (candidates.length) {
      try {
        await prepareWritebackRun(plan, candidates, b, s);
        let writebackOutcome = 'succeeded';
        for (const candidate of candidates) {
          const result = await executeWritebackCandidate(plan, candidate, b, s);
          if (result.terminal === 'succeeded') {
            outcomes.push({ controlId: candidate.control.controlId, state: 'succeeded', phase: result.phase,
              commandId: result.commandId, fieldCount: candidate.changes.length, ledger: result.ledger });
            for (const coverage of fieldCoverage.filter((item) => item.controlId === candidate.control.controlId
              && item.state === 'pending')) coverage.state = 'confirmed';
          } else {
            writebackOutcome = result.terminal === 'uncertain' ? 'uncertain'
              : writebackOutcome === 'succeeded' ? 'failed' : writebackOutcome;
            const summary = errorSummary(result.error);
            outcomes.push({ controlId: candidate.control.controlId, state: 'uncertain', phase: result.phase,
              commandId: result.commandId, code: summary.code, message: summary.message });
            for (const coverage of fieldCoverage.filter((item) => item.controlId === candidate.control.controlId
              && item.state === 'pending')) coverage.state = 'uncertain';
          }
          plan.workpaper.writebackRun.outcomes = outcomes.filter((item) => candidates.some((candidateItem) => (
            candidateItem.control.controlId === item.controlId)));
          plan.workpaper.writebackRun.completedCount = plan.workpaper.writebackRun.outcomes.length;
          const completed = Math.min(total, outcomes.length);
          progress.capsules[2] = { capsuleId: 'writeback', label: '写回 Control', state: 'running',
            completed, total, detail: `${completed}/${total}` };
          plan.surfaceStateVersion += 1; await save(plan);
        }
        await store.call('finishReturn', { runId: plan.runId,
          outcome: writebackOutcome,
          ...(writebackOutcome !== 'succeeded' ? { error: 'One or more Control body write-backs lack verified read-back.' } : {}) });
        plan.workpaper.writebackRun.state = writebackOutcome;
      } catch (error) {
        const summary = errorSummary(error);
        for (const candidate of candidates) {
          if (!outcomes.some((item) => item.controlId === candidate.control.controlId)) {
            outcomes.push({ controlId: candidate.control.controlId, state: 'uncertain', phase: 'return_intent',
              code: summary.code, message: summary.message });
          }
        }
        if (plan.workpaper.writebackRun && plan.workpaper.writebackRun.state === 'returning') {
          try {
            await store.call('finishReturn', { runId: plan.runId, outcome: 'uncertain', error: `${summary.code}: ${summary.message}` });
          } catch {}
          plan.workpaper.writebackRun.state = 'uncertain';
        }
      }
    }
    const uncertainCount = outcomes.filter((item) => item.state === 'uncertain').length;
    const succeededCount = outcomes.filter((item) => item.state === 'succeeded').length;
    const skippedCount = outcomes.filter((item) => item.state === 'skipped').length;
    progress.capsules[2] = { capsuleId: 'writeback', label: '写回 Control', state: uncertainCount ? 'uncertain' : 'passed', completed: total, total, detail: `${total}/${total}` };
    progress.state = uncertainCount ? 'uncertain' : 'passed';
    plan.workpaper.writeback = { ...progress, outcomes };
    plan.workpaper.state = uncertainCount ? 'writeback_uncertain' : 'writeback_complete';
    const unsupportedFieldCount = fieldCoverage.filter((item) => item.state === 'unsupported').length;
    const manualCompletionFieldCount = fieldCoverage.filter((item) => item.manualCompletionRequired).length;
    const placeholderFallbackFieldCount = fieldCoverage.filter((item) => ['ai_failure_placeholder_fallback',
      'unresolved_placeholder_fallback'].includes(item.writebackMode)
      && ['confirmed', 'unchanged'].includes(item.state)).length;
    const placeholderFallbackIncompatibleFieldCount = fieldCoverage.filter((item) =>
      item.writebackMode === 'ai_failure_placeholder_type_incompatible').length;
    plan.workpaper.writeback.coverage = fieldCoverage;
    plan.workpaper.writeback.coverageState = uncertainCount ? 'uncertain'
      : unsupportedFieldCount || manualCompletionFieldCount ? 'partial' : 'complete';
    plan.workpaper.writebackCounts = { total, succeeded: succeededCount, skipped: skippedCount, uncertain: uncertainCount,
      fields: { total: fieldCoverage.length,
        sourcePresent: fieldCoverage.filter((item) => item.sourceState === 'present').length,
        confirmed: fieldCoverage.filter((item) => item.state === 'confirmed').length,
        unchanged: fieldCoverage.filter((item) => item.state === 'unchanged').length,
        unsupported: unsupportedFieldCount,
        manualCompletion: manualCompletionFieldCount,
        placeholderFallback: placeholderFallbackFieldCount,
        placeholderFallbackTypeIncompatible: placeholderFallbackIncompatibleFieldCount,
        sourceEmpty: fieldCoverage.filter((item) => item.state === 'source_empty').length,
        uncertain: fieldCoverage.filter((item) => item.state === 'uncertain').length } };
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
    const recoverable = input.actionId === 'confirm-writeback' ? await openPlan() : null;
    if (recoverable && recoverable.workpaper && recoverable.workpaper.writebackRun
      && ['waiting_confirmation','returning'].includes(recoverable.workpaper.writebackRun.state)) {
      const resumed = await resumeWritebackRun(recoverable, context);
      return { surfacePatch: workpaperSurface(resumed) };
    }
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
      const prepared = retryableRejectedWriteback(plan) ? await reprepareRejectedWriteback(plan, context) : plan;
      const written = await confirmWriteback(prepared, context);
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

module.exports = Object.freeze({ createFeatureWorker, FEATURE_ID, FEATURE_VERSION, OPERATIONS, normalizeDirectory,
  bindReplacementSystems });
