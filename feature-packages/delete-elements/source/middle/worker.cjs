'use strict';

const crypto = require('node:crypto');

const FEATURE_ID = 'omnia.delete-elements';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const OPERATIONS = Object.freeze({
  scopeRead: 'omnia.delete.scope.read.v1',
  catalogRead: 'omnia.delete.catalog.heavy-read.v1',
  preflight: 'omnia.delete.information.preflight.v1',
  direct: 'omnia.delete.information.direct.v1',
  reconcile: 'omnia.delete.information.reconcile.v1'
});

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite plan value.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Non-JSON plan value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) fail('PLAN.INVALID_INPUT', `${field} is invalid.`);
  return value;
}

function freezeBinding(value) {
  if (!value || typeof value !== 'object') fail('PLAN.INVALID_BINDING', 'Connector binding is required.');
  const binding = {
    connectorId: nonEmpty(value.connectorId, 'connectorId'),
    sessionGeneration: Number(value.sessionGeneration),
    engagementId: nonEmpty(value.engagementId, 'engagementId')
  };
  if (!Number.isSafeInteger(binding.sessionGeneration) || binding.sessionGeneration < 1) {
    fail('PLAN.INVALID_BINDING', 'sessionGeneration is invalid.');
  }
  return Object.freeze(binding);
}

function freezeSafety(value, engagementId) {
  if (!value || typeof value !== 'object' || value.enabled !== true) fail('SAFETY.REQUIRED', 'An enabled safety lock is required.');
  if (value.engagementId !== engagementId) fail('SAFETY.ENGAGEMENT_MISMATCH', 'Safety lock is bound to another Pack.');
  if (!Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1) fail('SAFETY.INVALID_VERSION', 'Safety lock version is invalid.');
  if (!Array.isArray(value.workspaceIds) || value.workspaceIds.length < 1) fail('SAFETY.EMPTY_SCOPE', 'Safety lock has no Workspace.');
  const workspaceIds = [...new Set(value.workspaceIds.map((id) => nonEmpty(id, 'workspaceId')))].sort();
  if (workspaceIds.length !== value.workspaceIds.length) fail('SAFETY.DUPLICATE_SCOPE', 'Safety lock contains duplicate Workspace identity.');
  return Object.freeze({
    enabled: true,
    engagementId,
    stateVersion: value.stateVersion,
    authorityObservationId: nonEmpty(value.authorityObservationId, 'authorityObservationId'),
    workspaceIds: Object.freeze(workspaceIds)
  });
}

function safetyEquals(left, right) {
  return digest(left) === digest(right);
}

function uncertainTransport(error) {
  return Boolean(error && [
    'CONNECTOR.RESPONSE_LOST',
    'CONNECTOR.TIMEOUT_AFTER_COMMIT',
    'CONNECTOR.EOF_AFTER_COMMIT',
    'CONNECTOR.HTTP_502',
    'CONNECTOR.HTTP_503',
    'CONNECTOR.HTTP_504'
  ].includes(error.code));
}

function createDeleteElementsWorker(dependencies) {
  if (!dependencies || typeof dependencies !== 'object') fail('WORKER.INVALID_DEPENDENCIES', 'Worker dependencies are required.');
  const connector = dependencies.connector;
  const store = dependencies.store;
  const events = dependencies.events;
  const clock = dependencies.clock || { now: () => new Date().toISOString() };
  const uuid = dependencies.uuid || (() => crypto.randomUUID());
  if (!connector || typeof connector.invoke !== 'function') fail('WORKER.CONNECTOR_REQUIRED', 'A narrow Connector invocation port is required.');
  if (
    !store
    || typeof store.append !== 'function'
    || typeof store.upsertManagedContent !== 'function'
    || typeof store.savePlan !== 'function'
    || typeof store.loadPlan !== 'function'
  ) {
    fail('WORKER.STORE_REQUIRED', 'An evidence and managed-content store port is required.');
  }
  if (!events || typeof events.emit !== 'function') fail('WORKER.EVENTS_REQUIRED', 'A runtime event port is required.');
  const plans = new Map();

  async function invoke(operationId, request) {
    return connector.invoke(Object.freeze({
      schemaVersion: 'omnia.operation-invocation/v1',
      featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION,
      operationId,
      request
    }));
  }

  async function evidence(plan, checkpoint, details) {
    await store.append(Object.freeze({
      schemaVersion: 'omnia.delete-evidence/v1',
      featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION,
      planId: plan.planId,
      checkpoint,
      occurredAt: clock.now(),
      details
    }));
  }

  async function persist(plan) {
    plan.updatedAt = clock.now();
    await store.savePlan(structuredClone(plan));
    plans.set(plan.planId, plan);
  }

  function assertAuthoritativeScope(scope, binding, safety) {
    if (!scope || scope.engagementId !== binding.engagementId) fail('SCOPE.PACK_CHANGED', 'Authoritative scope no longer matches the frozen Pack.');
    if (scope.connectorId !== binding.connectorId || scope.sessionGeneration !== binding.sessionGeneration) {
      fail('SCOPE.CONNECTOR_CHANGED', 'Connector identity or lease generation changed.');
    }
    if (!Array.isArray(scope.workspaceIds) || safety.workspaceIds.some((id) => !scope.workspaceIds.includes(id))) {
      fail('SCOPE.WORKSPACE_CHANGED', 'A safety-locked Workspace is absent from the current authoritative scope.');
    }
  }

  function freezeTarget(item, safety) {
    if (!item || item.objectType !== 'Information') fail('TARGET.TYPE_MISMATCH', 'Only explicitly typed Information targets are accepted in this candidate.');
    const workspaceIds = [...new Set((item.workspaceIds || []).map((id) => nonEmpty(id, 'targetWorkspaceId')))].sort();
    if (workspaceIds.length < 1 || workspaceIds.some((id) => !safety.workspaceIds.includes(id))) {
      fail('SAFETY.WORKSPACE_BLOCKED', 'Target impact extends outside the safety lock.');
    }
    return Object.freeze({
      objectId: nonEmpty(item.objectId, 'objectId'),
      informationId: nonEmpty(item.informationId, 'informationId'),
      workItemId: nonEmpty(item.workItemId, 'workItemId'),
      objectType: 'Information',
      workspaceIds: Object.freeze(workspaceIds),
      updatedAt: nonEmpty(item.updatedAt, 'updatedAt')
    });
  }

  function validatePreflight(preflight, target, safety) {
    if (!preflight || preflight.informationId !== target.informationId || preflight.workItemId !== target.workItemId) {
      fail('PREFLIGHT.IDENTITY_CHANGED', 'Preflight returned another object identity.');
    }
    const workspaceIds = [...new Set((preflight.workspaceIds || []).map((id) => nonEmpty(id, 'preflightWorkspaceId')))].sort();
    if (workspaceIds.length < 1 || workspaceIds.some((id) => !safety.workspaceIds.includes(id))) {
      fail('PREFLIGHT.SAFETY_CHANGED', 'Current target impact extends outside the safety lock.');
    }
    if (!Array.isArray(preflight.blockers)) fail('PREFLIGHT.INVALID_BLOCKERS', 'Preflight blockers are not authoritative.');
    return Object.freeze({
      informationId: target.informationId,
      workItemId: target.workItemId,
      workspaceIds: Object.freeze(workspaceIds),
      updatedAt: nonEmpty(preflight.updatedAt, 'preflightUpdatedAt'),
      blockerSignature: digest(preflight.blockers),
      blockers: Object.freeze(preflight.blockers.map((value) => canonical(value)))
    });
  }

  async function createPlan(input) {
    const binding = freezeBinding(input && input.connectorBinding);
    const safety = freezeSafety(input && input.safetyLock, binding.engagementId);
    if (!Array.isArray(input.targetIds) || input.targetIds.length !== 1) {
      fail('PLAN.INVALID_TARGETS', 'This candidate requires exactly one Information target per plan.');
    }
    const targetIds = [...new Set(input.targetIds.map((id) => nonEmpty(id, 'targetId')))];
    if (targetIds.length !== input.targetIds.length) fail('PLAN.DUPLICATE_TARGET', 'Duplicate target identity is not allowed.');
    const scope = await invoke(OPERATIONS.scopeRead, { connectorBinding: binding });
    assertAuthoritativeScope(scope, binding, safety);
    const catalog = await invoke(OPERATIONS.catalogRead, {
      connectorBinding: binding,
      engagementId: binding.engagementId,
      workspaceIds: safety.workspaceIds
    });
    if (!catalog || !Array.isArray(catalog.items)) fail('CATALOG.INVALID', 'Authoritative heavy catalog is unavailable.');
    const items = new Map(catalog.items.map((item) => [item.objectId, item]));
    const frozenTargets = targetIds.map((id) => {
      const item = items.get(id);
      if (!item) fail('TARGET.NOT_FOUND', 'A selected target is absent from the authoritative catalog.');
      return freezeTarget(item, safety);
    });
    const preflights = [];
    for (const target of frozenTargets) {
      const result = await invoke(OPERATIONS.preflight, { connectorBinding: binding, target });
      preflights.push(validatePreflight(result, target, safety));
    }
    if (preflights.some((preflight) => preflight.blockers.length > 0)) {
      fail('PREFLIGHT.BLOCKED', 'At least one target has an authoritative blocking relationship.');
    }
    const planId = uuid();
    const confirmationId = uuid();
    const frozen = {
      connectorBinding: binding,
      safetyLock: safety,
      targets: Object.freeze(frozenTargets),
      preflights: Object.freeze(preflights)
    };
    const plan = {
      schemaVersion: 'omnia.delete-plan/v1',
      planId,
      confirmationId,
      featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION,
      state: 'pending_confirmation',
      stateVersion: 1,
      planDigest: digest(frozen),
      frozen,
      results: [],
      createdAt: clock.now(),
      updatedAt: clock.now()
    };
    await persist(plan);
    await evidence(plan, 'plan_created', { planDigest: plan.planDigest, targetCount: frozenTargets.length });
    return structuredClone(plan);
  }

  async function getPlan(planId) {
    const normalizedPlanId = nonEmpty(planId, 'planId');
    let plan = plans.get(normalizedPlanId);
    if (!plan) {
      plan = await store.loadPlan(normalizedPlanId);
      if (plan) plans.set(normalizedPlanId, plan);
    }
    if (!plan) fail('PLAN.NOT_FOUND', 'Delete plan was not found in the persistent Feature store.');
    return plan;
  }

  async function reconcileTarget(plan, target) {
    const observed = await invoke(OPERATIONS.reconcile, {
      connectorBinding: plan.frozen.connectorBinding,
      target
    });
    await evidence(plan, 'post_read', {
      objectId: target.objectId,
      deleted: observed && observed.deleted === true,
      observationDigest: digest(observed)
    });
    if (!observed || observed.informationId !== target.informationId) {
      fail('RECONCILE.IDENTITY_MISMATCH', 'Reconcile returned another object identity.');
    }
    if (observed.deleted !== true) return false;
    await store.upsertManagedContent(Object.freeze({
      schemaVersion: 'omnia.managed-content-record/v1',
      featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION,
      engagementId: plan.frozen.connectorBinding.engagementId,
      objectType: target.objectType,
      objectId: target.objectId,
      status: 'deleted',
      tombstoneAt: clock.now(),
      planId: plan.planId
    }));
    return true;
  }

  async function reconcile(planId) {
    const plan = await getPlan(planId);
    if (!['executing', 'uncertain'].includes(plan.state)) fail('PLAN.RECONCILE_NOT_ALLOWED', 'Only executing or uncertain plans can reconcile.');
    let allDeleted = true;
    for (const target of plan.frozen.targets) {
      try {
        if (!await reconcileTarget(plan, target)) allDeleted = false;
      } catch (error) {
        allDeleted = false;
        await evidence(plan, 'reconcile_read_failed', {
          objectId: target.objectId,
          code: error && error.code || 'UNKNOWN',
          message: error && error.message || 'Authoritative reconcile read failed.'
        });
      }
    }
    plan.state = allDeleted ? 'completed' : 'uncertain';
    plan.stateVersion += 1;
    await persist(plan);
    await evidence(plan, allDeleted ? 'completed' : 'uncertain', { authoritativeDeleted: allDeleted });
    if (allDeleted) {
      await events.emit(Object.freeze({
        type: 'workspace.authoritative_refresh_requested',
        featureId: FEATURE_ID,
        featureVersion: FEATURE_VERSION,
        engagementId: plan.frozen.connectorBinding.engagementId,
        workspaceIds: plan.frozen.safetyLock.workspaceIds,
        planId: plan.planId
      }));
    }
    return structuredClone(plan);
  }

  async function confirm(input) {
    const plan = await getPlan(input && input.planId);
    if (plan.state !== 'pending_confirmation') fail('PLAN.STATE_CONFLICT', 'Plan is not awaiting confirmation.');
    if (input.confirmationId !== plan.confirmationId || input.expectedStateVersion !== plan.stateVersion) {
      fail('PLAN.CONFIRMATION_CONFLICT', 'Confirmation identity or state version changed.');
    }
    const currentSafety = freezeSafety(input.safetyLock, plan.frozen.connectorBinding.engagementId);
    if (!safetyEquals(currentSafety, plan.frozen.safetyLock)) fail('PLAN.SAFETY_CHANGED', 'Safety lock changed after plan creation.');
    const scope = await invoke(OPERATIONS.scopeRead, { connectorBinding: plan.frozen.connectorBinding });
    assertAuthoritativeScope(scope, plan.frozen.connectorBinding, plan.frozen.safetyLock);
    plan.state = 'executing';
    plan.stateVersion += 1;
    await persist(plan);
    await evidence(plan, 'execution_started', { planDigest: plan.planDigest });
    for (let index = 0; index < plan.frozen.targets.length; index += 1) {
      const target = plan.frozen.targets[index];
      const before = validatePreflight(
        await invoke(OPERATIONS.preflight, {
          connectorBinding: plan.frozen.connectorBinding,
          target,
          planDigest: plan.planDigest
        }),
        target,
        plan.frozen.safetyLock
      );
      if (digest(before) !== digest(plan.frozen.preflights[index])) {
        plan.state = 'failed';
        plan.stateVersion += 1;
        await persist(plan);
        await evidence(plan, 'preflight_changed', { objectId: target.objectId });
        fail('PREFLIGHT.CHANGED', 'Target identity, blockers, Workspace impact, or concurrency token changed.');
      }
      await evidence(plan, 'commit_attempted', { objectId: target.objectId, operationId: OPERATIONS.direct });
      try {
        const response = await invoke(OPERATIONS.direct, {
          connectorBinding: plan.frozen.connectorBinding,
          target,
          planDigest: plan.planDigest
        });
        await evidence(plan, 'response_received', { objectId: target.objectId, responseDigest: digest(response) });
      } catch (error) {
        if (!uncertainTransport(error)) {
          plan.state = 'failed';
          plan.stateVersion += 1;
          await persist(plan);
          await evidence(plan, 'commit_failed', { objectId: target.objectId, code: error && error.code || 'UNKNOWN' });
          throw error;
        }
        plan.state = 'uncertain';
        plan.stateVersion += 1;
        await persist(plan);
        await evidence(plan, 'response_lost', { objectId: target.objectId, code: error.code });
        return reconcile(plan.planId);
      }
    }
    return reconcile(plan.planId);
  }

  async function preflight(input) {
    const binding = freezeBinding(input && input.connectorBinding);
    const safety = freezeSafety(input && input.safetyLock, binding.engagementId);
    const target = freezeTarget(input && input.target, safety);
    return validatePreflight(await invoke(OPERATIONS.preflight, { connectorBinding: binding, target }), target, safety);
  }

  function messageCard(plan) {
    if (!plan || plan.featureId !== FEATURE_ID || plan.featureVersion !== FEATURE_VERSION) {
      fail('CARD.PLAN_IDENTITY_MISMATCH', 'Message card can only project this Feature version plan.');
    }
    const stateLabels = {
      pending_confirmation: ['等待确认', '计划已冻结；确认前仍会执行第二次权威预检。'],
      executing: ['正在执行', '已进入提交阶段；请等待权威读回结果。'],
      completed: ['删除完成', '权威读回已确认删除，并已请求刷新工作区。'],
      failed: ['删除失败', '写入未完成；请查看证据并重新创建计划。'],
      cancelled: ['已取消', '计划已取消，没有执行写入。'],
      uncertain: ['结果待核验', '提交响应丢失；禁止重放，只能执行只读核验。']
    };
    const [title, summary] = stateLabels[plan.state] || ['未知状态', '计划状态无法识别。'];
    const actions = [];
    if (plan.state === 'pending_confirmation') {
      actions.push({
        actionId: 'confirm-delete-plan',
        label: '确认删除',
        effect: 'omnia_mutation',
        enabled: true,
        reason: ''
      });
    } else if (plan.state === 'uncertain') {
      actions.push({
        actionId: 'reconcile-delete-plan',
        label: '只读核验',
        effect: 'read_only',
        enabled: true,
        reason: ''
      });
    }
    return Object.freeze({
      messageId: `delete-plan:${plan.planId}`,
      featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION,
      surfaceId: 'delete-elements.workbench',
      runId: plan.planId,
      confirmationId: plan.confirmationId,
      stateVersion: plan.stateVersion,
      state: plan.state,
      title,
      summary,
      details: [
        { label: '目标数量', value: String(plan.frozen.targets.length) },
        { label: '计划摘要', value: plan.planDigest }
      ],
      actions
    });
  }

  async function status(planId) {
    return structuredClone(await getPlan(planId));
  }

  async function refreshCatalog(input) {
    const binding = freezeBinding(input && input.connectorBinding);
    const safety = freezeSafety(input && input.safetyLock, binding.engagementId);
    const scope = await invoke(OPERATIONS.scopeRead, { connectorBinding: binding });
    assertAuthoritativeScope(scope, binding, safety);
    const catalog = await invoke(OPERATIONS.catalogRead, {
      connectorBinding: binding,
      engagementId: binding.engagementId,
      workspaceIds: safety.workspaceIds
    });
    if (!catalog || !Array.isArray(catalog.items)) fail('CATALOG.INVALID', 'Authoritative heavy catalog is unavailable.');
    const items = catalog.items.map((item) => {
      const target = freezeTarget(item, safety);
      const blockers = Array.isArray(item.blockers) ? item.blockers : [];
      return {
        id: target.objectId,
        scopeId: target.workspaceIds[0],
        type: target.objectType,
        title: String(item.number || item.name || target.objectId),
        subtitle: String(item.name || item.number || ''),
        selectable: blockers.length === 0,
        disabledReason: blockers.length === 0 ? '' : `存在 ${blockers.length} 个阻塞关系`,
        concurrencyToken: target.updatedAt
      };
    });
    return {
      schemaVersion: 'omnia.declarative-feature-surface-patch/v1',
      status: items.length ? 'ready' : 'empty',
      statusMessage: items.length ? `已权威重抓取 ${items.length} 个 Information。` : '安全锁范围内没有可显示的 Information。',
      scopes: safety.workspaceIds.map((workspaceId) => ({
        id: workspaceId,
        parentId: '',
        label: workspaceId,
        parentLabel: '安全锁',
        selected: true
      })),
      items,
      selectedItemIds: []
    };
  }

  async function handleAction(input) {
    if (!input || typeof input !== 'object') fail('ACTION.INVALID', 'Feature action request is required.');
    const context = input.context || {};
    if (input.actionId === 'refresh-authoritative-catalog') {
      return { surfacePatch: await refreshCatalog(context) };
    }
    if (input.actionId === 'create-delete-plan') {
      const plan = await createPlan({
        connectorBinding: context.connectorBinding,
        safetyLock: context.safetyLock,
        targetIds: input.payload && input.payload.targetIds
      });
      return { messageCard: messageCard(plan) };
    }
    if (input.actionId === 'confirm-delete-plan') {
      const plan = await confirm({
        planId: input.payload && input.payload.runId,
        confirmationId: input.payload && input.payload.confirmationId,
        expectedStateVersion: input.expectedStateVersion,
        safetyLock: context.safetyLock
      });
      return { messageCard: messageCard(plan), surfacePatch: await refreshCatalog(context) };
    }
    if (input.actionId === 'reconcile-delete-plan') {
      const plan = await reconcile(input.payload && input.payload.runId);
      const result = { messageCard: messageCard(plan) };
      if (plan.state === 'completed') result.surfacePatch = await refreshCatalog(context);
      return result;
    }
    fail('ACTION.UNKNOWN', 'Feature action is not implemented by this signed worker.');
  }

  return Object.freeze({
    health: () => Object.freeze({
      schemaVersion: 'omnia.feature-worker-health/v1',
      featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION,
      ready: true,
      mutationEnabled: true,
      requiresConnector: true,
      requiresSafetyLock: true,
      supportedTransports: ['local']__HEALTH_OBSERVABILITY__
    }),
    createPlan,
    preflight,
    confirm,
    reconcile,
    status,
    messageCard,
    refreshCatalog,
    handleAction
  });
}

module.exports = Object.freeze({
  createFeatureWorker: createDeleteElementsWorker,
  createDeleteElementsWorker,
  FEATURE_ID,
  FEATURE_VERSION,
  OPERATIONS
});
