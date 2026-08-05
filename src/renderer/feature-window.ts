import type {
  DeclarativeFeatureAction,
  DeclarativeFeatureReview,
  DeclarativeFeatureScope,
  DeclarativeFeatureSurface,
  DeclarativeReviewElementKind,
  DeclarativeReviewField
} from '../shared/feature-contracts.js';

const root = (typeof document === 'undefined' ? null : document.getElementById('feature-root')) as HTMLElement;
const esc = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
let surface: DeclarativeFeatureSurface | null = null;
let busy = false;
let errorMessage = '';
let selectedReviewKind: DeclarativeReviewElementKind | '' = '';
let selectedReviewRowKey = '';
let dirtyReviewValues = new Map<string, string>();
let hostPlacement: 'docked' | 'detached' | 'minimized' | 'closed' = 'docked';
let recorderProjectedAt = Date.now();
let renderedSurface = '';
let renderedError = '';
let pendingActionId = '';
let renderedPendingActionId = '';
let selectionUiIdentity = '';
let selectionQuery = '';
let selectedScopeId = '';
let collapsedScopeIds = new Set<string>();
const busyDisabledState = new WeakMap<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement, boolean>();
const backgroundActionAttempts = new Set<string>();
const backgroundActionScheduled = new Set<string>();

function renderHostToolbar(): void {
  const toolbar = document.getElementById('surface-window-toolbar');
  if (toolbar) toolbar.hidden = hostPlacement !== 'detached';
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compatibleReviewField(previous: DeclarativeReviewField, next: DeclarativeReviewField): boolean {
  return previous.fieldKey === next.fieldKey
    && previous.rowKey === next.rowKey
    && previous.kind === next.kind
    && previous.rawFieldKey === next.rawFieldKey
    && previous.expectedRevision === next.expectedRevision
    && previous.inputKind === next.inputKind
    && previous.currentValue === next.currentValue
    && previous.required === next.required
    && previous.maxLength === next.maxLength
    && previous.editable === next.editable
    && previous.sourceSheet === next.sourceSheet
    && previous.sourceRow === next.sourceRow
    && previous.derivation === next.derivation
    && sameValues(previous.allowedValues, next.allowedValues);
}

export function reconcileBootstrapReviewDrafts(
  previous: DeclarativeFeatureSurface | null,
  next: DeclarativeFeatureSurface,
  drafts: ReadonlyMap<string, string>
): Map<string, string> {
  const sameProjection = previous?.featureId === next.featureId
    && previous.featureVersion === next.featureVersion
    && previous.surfaceId === next.surfaceId
    && previous.stateVersion === next.stateVersion;
  if (!sameProjection || !previous?.review || !next.review || drafts.size === 0) return new Map();
  const previousFields = new Map(previous.review.fields.map((field) => [field.fieldKey, field]));
  const nextFields = new Map(next.review.fields.map((field) => [field.fieldKey, field]));
  const preserved = new Map<string, string>();
  for (const [fieldKey, value] of drafts) {
    const previousField = previousFields.get(fieldKey);
    const nextField = nextFields.get(fieldKey);
    if (previousField && nextField && compatibleReviewField(previousField, nextField)) preserved.set(fieldKey, value);
  }
  return preserved;
}

function actionButton(action: DeclarativeFeatureAction, extra = ''): string {
  return `<button data-action="${esc(action.actionId)}" data-selection="${esc(action.selectionMode || 'none')}" ${extra} ${action.enabled ? '' : 'disabled'} title="${esc(action.reason)}">${esc(action.label)}</button>`;
}

function syncSelectionBrowserUi(): void {
  if (!surface?.selectionBrowser) return;
  const identity = `${surface.featureId}\u0000${surface.featureVersion}\u0000${surface.surfaceId}`;
  const scopeIds = new Set(surface.scopes.map((scope) => scope.id));
  if (identity !== selectionUiIdentity) {
    selectionUiIdentity = identity;
    selectionQuery = surface.search;
    selectedScopeId = surface.scopes.find((scope) => scope.selected)?.id || '';
    collapsedScopeIds = new Set(surface.scopes.filter((scope) => scope.initialExpanded === false).map((scope) => scope.id));
    return;
  }
  if (selectedScopeId && !scopeIds.has(selectedScopeId)) selectedScopeId = '';
  collapsedScopeIds = new Set([...collapsedScopeIds].filter((scopeId) => scopeIds.has(scopeId)));
}

function descendantScopeIds(scopeId: string): Set<string> {
  const descendants = new Set<string>([scopeId]);
  if (!surface) return descendants;
  let changed = true;
  while (changed) {
    changed = false;
    for (const scope of surface.scopes) {
      if (scope.parentId && descendants.has(scope.parentId) && !descendants.has(scope.id)) {
        descendants.add(scope.id);
        changed = true;
      }
    }
  }
  return descendants;
}

function visibleSelectionItems() {
  if (!surface) return [];
  const allowedScopes = selectedScopeId ? descendantScopeIds(selectedScopeId) : null;
  const normalizedQuery = selectionQuery.trim().toLocaleLowerCase('zh-CN');
  const scopeById = new Map(surface.scopes.map((scope) => [scope.id, scope]));
  return surface.items.filter((item) => {
    if (allowedScopes && !allowedScopes.has(item.scopeId)) return false;
    if (!normalizedQuery) return true;
    const labels: string[] = [];
    const visited = new Set<string>();
    let current = scopeById.get(item.scopeId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      labels.push(current.label, current.parentLabel);
      current = current.parentId ? scopeById.get(current.parentId) : undefined;
    }
    return [item.id, item.type, item.title, item.subtitle, ...labels]
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
  });
}

function selectionBrowserUnavailable(): boolean {
  return !surface || ['loading', 'blocked', 'error', 'stale'].includes(surface.status);
}

function renderSelectionBrowser(): string {
  if (!surface?.selectionBrowser) return '';
  syncSelectionBrowserUi();
  const browser = surface.selectionBrowser;
  const scopes = surface.scopes;
  const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
  const children = new Map<string, DeclarativeFeatureScope[]>();
  const roots: DeclarativeFeatureScope[] = [];
  for (const scope of scopes) {
    if (scope.parentId && scopeById.has(scope.parentId)) {
      const siblings = children.get(scope.parentId) || [];
      siblings.push(scope);
      children.set(scope.parentId, siblings);
    } else roots.push(scope);
  }
  const scopeCounts = (scopeId: string) => {
    const ids = descendantScopeIds(scopeId);
    const items = surface!.items.filter((item) => ids.has(item.scopeId));
    return {total: items.length, selectable: items.filter((item) => item.selectable).length};
  };
  const renderScope = (scope: DeclarativeFeatureScope, ancestors: ReadonlySet<string>): string => {
    if (ancestors.has(scope.id)) return '';
    const nested = children.get(scope.id) || [];
    const collapsed = collapsedScopeIds.has(scope.id);
    const counts = scopeCounts(scope.id);
    const nextAncestors = new Set(ancestors).add(scope.id);
    const disabled = Boolean(scope.disabledReason);
    return `<li class="catalog-scope level-${scope.level || 1} ${selectedScopeId === scope.id ? 'selected' : ''} ${disabled ? 'disabled' : ''}"><div class="catalog-scope-row" style="--scope-level:${scope.level || 1}" title="${esc(scope.disabledReason || '')}">${nested.length ? `<button type="button" class="catalog-collapse" data-catalog-collapse="${esc(scope.id)}" aria-expanded="${String(!collapsed)}" aria-label="${collapsed ? '展开' : '折叠'} ${esc(scope.label)}">${collapsed ? '›' : '⌄'}</button>` : '<span class="catalog-collapse-spacer"></span>'}<button type="button" class="catalog-scope-select" data-catalog-scope="${esc(scope.id)}" ${disabled ? 'aria-disabled="true"' : ''}><span class="catalog-scope-kind">${esc(scope.kind || '')}</span><strong>${esc(scope.label)}</strong><small>${counts.total} / ${counts.selectable}</small></button></div>${disabled ? `<small class="catalog-scope-disabled-reason">${esc(scope.disabledReason || '')}</small>` : ''}${nested.length && !collapsed ? `<ul>${nested.map((child) => renderScope(child, nextAncestors)).join('')}</ul>` : ''}</li>`;
  };
  const visibleItems = visibleSelectionItems();
  const visibleSelectable = visibleItems.filter((item) => item.selectable);
  const selectedIds = new Set(surface.selectedItemIds);
  const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every((item) => selectedIds.has(item.id));
  const selectionDisabled = selectionBrowserUnavailable();
  const itemRows = visibleItems.map((item) => {
    const reason = item.selectable ? '' : item.disabledReason;
    return `<label class="catalog-item ${item.selectable ? '' : 'disabled'}" title="${esc(reason)}"><input type="checkbox" name="selection" value="${esc(item.id)}" ${selectedIds.has(item.id) ? 'checked' : ''} ${item.selectable && !selectionDisabled ? '' : 'disabled'}><span><strong>${esc(item.title)}</strong><small>${esc(item.subtitle)}</small>${reason ? `<small class="catalog-disabled-reason">${esc(reason)}</small>` : ''}</span><em>${esc(item.type)}</em></label>`;
  }).join('');
  const statusPanel = surface.status === 'loading'
    ? `<div class="catalog-state loading" role="status"><strong>正在读取权威目录</strong><span>${esc(surface.statusMessage)}</span></div>`
    : surface.status === 'error'
      ? `<div class="catalog-state error" role="alert"><strong>目录读取失败</strong><span>${esc(surface.statusMessage)}</span></div>`
      : surface.status === 'stale'
        ? `<div class="catalog-state stale" role="alert"><strong>当前目录已过期</strong><span>${esc(surface.statusMessage)}</span></div>`
        : surface.status === 'blocked'
          ? `<div class="catalog-state blocked" role="status"><strong>当前不可选择</strong><span>${esc(surface.statusMessage)}</span></div>`
          : '';
  const empty = surface.status === 'empty' || visibleItems.length === 0
    ? `<div class="catalog-empty"><strong>${esc(browser.emptyMessage)}</strong><span>${surface.status === 'empty' ? esc(surface.statusMessage) : '当前搜索或目录范围没有匹配项。'}</span></div>`
    : '';
  const footerActions = browser.footerActionIds.map((actionId) => surface!.actions.find((action) => action.actionId === actionId)).filter((action): action is DeclarativeFeatureAction => Boolean(action)).map((action) => {
    const needsSelection = (action.selectionMode || 'none') !== 'none';
    const missingSelection = needsSelection && selectedIds.size === 0;
    const unavailable = needsSelection && selectionDisabled;
    const effective = {
      ...action,
      enabled: action.enabled && !missingSelection && !unavailable,
      reason: unavailable ? surface!.statusMessage : missingSelection ? '请先选择至少一项。' : action.reason
    };
    return actionButton(effective, `class="${action.actionId === browser.primaryActionId ? 'primary' : ''}"`);
  }).join('');
  return `<section class="selection-browser" aria-label="${esc(browser.resultsLabel)}"><div class="catalog-toolbar"><label><span>搜索</span><input type="search" data-catalog-search value="${esc(selectionQuery)}" placeholder="${esc(browser.searchPlaceholder)}" ${selectionDisabled ? 'disabled' : ''}></label><div><strong>${visibleItems.length}</strong> 个结果 · <strong>${visibleSelectable.length}</strong> 个可选</div></div>${statusPanel}<div class="catalog-layout"><nav class="catalog-hierarchy" aria-label="${esc(browser.hierarchyLabel)}"><header><strong>${esc(browser.hierarchyLabel)}</strong><small>${scopes.length} 个目录节点</small></header><button type="button" class="catalog-all-scopes ${selectedScopeId ? '' : 'selected'}" data-catalog-scope="">${esc(browser.allScopesLabel)}<small>${surface.items.length}</small></button><ul>${roots.map((scope) => renderScope(scope, new Set())).join('')}</ul></nav><section class="catalog-results"><header><strong>${esc(browser.resultsLabel)}</strong><div><button type="button" data-catalog-select-visible ${visibleSelectable.length && !selectionDisabled ? '' : 'disabled'}>${esc(allVisibleSelected ? browser.clearSelectionLabel : browser.selectVisibleLabel)}</button></div></header><div class="catalog-item-list">${empty || itemRows}</div></section></div><footer class="catalog-footer"><span>已选 <strong>${selectedIds.size}</strong> 项</span><div>${footerActions}</div></footer></section>`;
}

function recorderTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function recorderElapsed(): number {
  const recorder = surface?.recorder;
  if (!recorder) return 0;
  return recorder.elapsedMs + (recorder.state === 'recording' ? Math.max(0, Date.now() - recorderProjectedAt) : 0);
}

function recorderControl(action: DeclarativeFeatureAction): string {
  const presentation = action.presentation || 'default';
  return `<button class="recorder-control ${esc(presentation)}" data-action="${esc(action.actionId)}" data-selection="${esc(action.selectionMode || 'none')}" ${action.enabled ? '' : 'disabled'} title="${esc(action.reason || action.label)}" aria-label="${esc(action.label)}"><span class="control-icon" aria-hidden="true"></span><span class="control-label">${esc(action.label)}</span></button>`;
}

function renderRecorder(): string {
  const recorder = surface?.recorder;
  if (!recorder) return '';
  const controls = surface!.actions.filter((action) => ['record', 'pause', 'stop', 'export'].includes(action.presentation || '')).map(recorderControl).join('');
  const refresh = surface!.actions.find((action) => action.presentation === 'refresh');
  const stateLabel = recorder.state === 'recording' ? '正在录制' : recorder.state === 'paused' ? '已暂停' : recorder.state === 'stopped' ? '已停止' : recorder.state === 'exported' ? '已导出' : recorder.state === 'cancelled' ? '已取消' : recorder.state === 'error' ? '异常' : '待机';
  return `<section class="recorder-player ${esc(recorder.state)}" aria-label="录制播放器"><header><div class="recorder-state"><span aria-hidden="true"></span><strong>${stateLabel}</strong></div><time data-recorder-clock>${recorderTime(recorderElapsed())}</time>${refresh ? recorderControl(refresh) : ''}</header><div class="recorder-track"><span style="width:${recorder.state === 'recording' ? '100' : recorder.state === 'paused' ? '66' : recorder.state === 'stopped' || recorder.state === 'exported' ? '100' : '0'}%"></span></div><div class="recorder-metrics"><span><strong>${recorder.eventCount}</strong><small>事件</small></span><span><strong>${recorder.interactionCount}</strong><small>交互</small></span><span><strong>${recorder.networkRequestCount}</strong><small>网络</small></span><span><strong>${recorder.riskCount}</strong><small>Risk</small></span><span><strong>${recorder.controlCount}</strong><small>Control</small></span></div><p class="recorder-capture ${esc(recorder.captureState)}"><span>${esc(recorder.captureState)}</span>${esc(recorder.captureMessage)}</p><div class="recorder-controls">${controls}</div>${recorder.recordingId ? `<small class="recorder-id">recordingId: ${esc(recorder.recordingId)}</small>` : ''}</section>`;
}

function updateRecorderClock(): void {
  const clock = root?.querySelector<HTMLElement>('[data-recorder-clock]');
  if (clock && surface?.recorder) clock.textContent = recorderTime(recorderElapsed());
}

function activeReviewElements(review: DeclarativeFeatureReview) {
  return review.elements.filter((element) => !element.excluded);
}

function reconcileReviewSelection(review: DeclarativeFeatureReview): void {
  const elements = activeReviewElements(review);
  const contractSelected = elements.find((element) => element.rowKey === review.selectedRowKey);
  const currentSelected = elements.find((element) => element.rowKey === selectedReviewRowKey);
  const selected = currentSelected || elements.find((element) => element.blocking) || contractSelected || elements[0];
  selectedReviewRowKey = selected?.rowKey || '';
  selectedReviewKind = selected?.kind || review.selectedKind;
}

function selectReviewKind(review: DeclarativeFeatureReview, kind: DeclarativeReviewElementKind): void {
  const elements = activeReviewElements(review).filter((element) => element.kind === kind);
  const next = elements.find((element) => element.blocking) || elements[0];
  selectedReviewKind = kind;
  selectedReviewRowKey = next?.rowKey || '';
}

function visibleReviewValue(field: DeclarativeReviewField): string {
  return dirtyReviewValues.get(field.fieldKey) ?? field.currentValue;
}

function reviewFieldControl(field: DeclarativeReviewField): string {
  const value = visibleReviewValue(field);
  const common = `data-review-input data-row-key="${esc(field.rowKey)}" data-field="${esc(field.fieldKey)}" data-revision="${field.expectedRevision}" data-initial="${esc(field.currentValue)}" maxlength="${field.maxLength}" ${field.required ? 'required' : ''} ${field.editable ? '' : 'disabled'}`;
  if (field.inputKind === 'enum') {
    return `<select ${common}>${field.allowedValues.map((allowed) => `<option value="${esc(allowed)}" ${allowed === value ? 'selected' : ''}>${esc(allowed)}</option>`).join('')}</select>`;
  }
  if (field.inputKind === 'textarea') return `<textarea ${common} rows="4">${esc(value)}</textarea>`;
  if (field.inputKind === 'readonly') return `<output>${esc(value || '—')}</output>`;
  return `<input ${common} value="${esc(value)}">`;
}

function reviewDraftRevisions() {
  return (surface?.review?.fields || []).filter((field) => dirtyReviewValues.has(field.fieldKey)).map((field) => ({
    rowKey: field.rowKey,
    fieldKey: field.fieldKey,
    expectedRevision: field.expectedRevision,
    value: dirtyReviewValues.get(field.fieldKey) ?? field.currentValue
  }));
}

function reviewActionDirtyDisabled(actionId: string | undefined): boolean {
  if (actionId === 'apply-revisions') return dirtyReviewValues.size === 0;
  if (actionId === 'back-to-upload' || actionId === 'revalidate-all') return false;
  return dirtyReviewValues.size > 0;
}

function renderReview(review: DeclarativeFeatureReview): string {
  reconcileReviewSelection(review);
  const elements = activeReviewElements(review);
  const selectedElement = elements.find((element) => element.rowKey === selectedReviewRowKey);
  const typedElements = elements.filter((element) => element.kind === selectedReviewKind);
  const selectedFields = review.fields.filter((field) => field.rowKey === selectedReviewRowKey);
  const typeRail = review.elementTypes.map((type) => `<button type="button" class="review-type ${type.kind === selectedReviewKind ? 'selected' : ''}" data-review-kind="${type.kind}" ${type.disabled ? 'disabled' : ''} title="${esc(type.reason)}"><span class="type-code">${esc(type.kind)}</span><span><strong>${esc(type.label)}</strong><small>${type.count} 个元素</small><small>${type.issueCount} 问题 · ${type.warningCount} 提醒</small></span></button>`).join('');
  const options = typedElements.map((element) => `<option value="${esc(element.rowKey)}" ${element.rowKey === selectedReviewRowKey ? 'selected' : ''}>${esc(element.elementId)}${element.issueCount ? ` · ${element.issueCount} 问题` : ''}${element.warningCount ? ` · ${element.warningCount} 提醒` : ''}</option>`).join('');
  const fields = selectedFields.map((field) => `<label class="review-field ${field.message ? 'has-message' : ''}" data-review-field="${esc(field.fieldKey)}"><span class="review-field-heading"><strong>${esc(field.label)}</strong>${field.required ? '<em>必填</em>' : ''}</span>${reviewFieldControl(field)}<small class="field-source">来源：${esc(field.sourceSheet)} · 第 ${field.sourceRow} 行${field.derivation ? ` · ${esc(field.derivation)}` : ''}</small>${field.message ? `<small class="field-message">${esc(field.message)}</small>` : ''}</label>`).join('');
  const issueCards = review.issueOrder.map((issue) => {
    const field = review.fields.find((candidate) => candidate.fieldKey === issue.fieldKey);
    const element = review.elements.find((candidate) => candidate.rowKey === issue.rowKey);
    const title = field?.label || element?.elementId || '全局问题';
    return `<button type="button" class="review-issue ${issue.severity}" ${issue.rowKey ? `data-review-issue-row="${esc(issue.rowKey)}" data-review-issue-field="${esc(issue.fieldKey)}"` : 'disabled'}><strong>${esc(title)}</strong><span>${esc(issue.message)}</span></button>`;
  }).join('');
  const actionMap = new Map((surface?.actions || []).map((action) => [action.actionId, action]));
  const footerOrder = ['revalidate-all', 'remove-batch-row', 'apply-revisions', 'prepare-return'];
  const footerActions = footerOrder.map((actionId) => actionMap.get(actionId)).filter((action): action is DeclarativeFeatureAction => Boolean(action)).map((action) => {
    const selectedDisabled = action.actionId === 'remove-batch-row' && !selectedElement;
    const dirtyDisabled = reviewActionDirtyDisabled(action.actionId);
    const reason = selectedDisabled
      ? '当前没有可移除元素。'
      : dirtyDisabled
        ? action.actionId === 'apply-revisions' ? '尚未修改字段。' : '请先保存修改。'
        : action.reason;
    const effective = {...action, enabled: action.enabled && !selectedDisabled && !dirtyDisabled, reason};
    return actionButton(effective, `class="${action.actionId === 'apply-revisions' ? 'primary' : action.actionId === 'remove-batch-row' ? 'danger' : ''}"`);
  }).join('');
  return `<section class="review-shell" aria-label="元素检查与修改">${issueCards ? `<section class="review-issues" aria-label="待处理问题"><h2>待处理问题</h2>${issueCards}</section>` : ''}<div class="review-layout"><nav class="review-types" aria-label="元素类别"><p><strong>ELEMENT TYPES</strong><span>元素类别</span></p>${typeRail}</nav><section class="review-content">${selectedElement ? `<div class="element-picker"><label><span>当前 ${esc(selectedReviewKind)} 元素</span><select data-review-element>${options}</select></label><span class="element-count">${typedElements.length} 个</span></div><article class="element-card"><header><div><span class="element-kind">${esc(selectedElement.kind)}</span><strong>${esc(selectedElement.elementId)}</strong><small>来源：${esc(selectedElement.sourceSheet)} · 第 ${selectedElement.sourceRow} 行</small></div><span class="element-state ${selectedElement.blocking ? 'blocked' : 'ready'}">${selectedElement.blocking ? '需要处理' : '本地检查可继续'}</span></header><p class="derived-display">${esc(selectedElement.derivedDisplay)}</p><div class="review-fields">${fields || '<p class="state">当前元素没有可展示字段。</p>'}</div></article>` : '<p class="state">当前批次没有可检查元素。</p>'}</section></div><footer class="review-actions">${footerActions}</footer></section>`;
}

function surfaceProjection(value: DeclarativeFeatureSurface | null): string {
  return value ? JSON.stringify(value) : '';
}

type CreateAssociatePendingPresentation = {
  actionId: 'confirm-upload' | 'prepare-return' | 'confirm-return';
  currentStepId: 'validate' | 'return';
  title: string;
  message: string;
};

function createAssociatePendingPresentation(): CreateAssociatePendingPresentation | null {
  if (surface?.featureId !== 'omnia.create-associate') return null;
  if (pendingActionId === 'confirm-upload') return {
    actionId: pendingActionId,
    currentStepId: 'validate',
    title: '正在进入校验',
    message: '确认上传请求已发送；正在等待后台持久化 processing 状态。'
  };
  if (pendingActionId === 'prepare-return') return {
    actionId: pendingActionId,
    currentStepId: 'return',
    title: '正在提交审核',
    message: '正在通过 Remote Connector 复核实时对象、安全锁与回传范围；后台冻结计划后才会开放确认回传。'
  };
  if (pendingActionId === 'confirm-return') return {
    actionId: pendingActionId,
    currentStepId: 'return',
    title: '正在确认回传',
    message: '正在重新校验安全锁、Connector 会话与冻结计划；后台确认通过后才会开始写入。'
  };
  return null;
}

function pendingWorkflow(pending: CreateAssociatePendingPresentation): DeclarativeFeatureSurface['workflow'] {
  if (!surface?.workflow) return undefined;
  return {
    ...surface.workflow,
    currentStepId: pending.currentStepId,
    steps: surface.workflow.steps.map((step) => {
      if (step.stepId === pending.currentStepId) return {...step, state: 'current', detail: pending.message};
      if (pending.currentStepId === 'validate' && step.stepId === 'upload') return {...step, state: 'completed'};
      if (pending.currentStepId === 'return' && (step.stepId === 'upload' || step.stepId === 'validate')) return {...step, state: 'completed'};
      return step;
    })
  };
}

function syncBusyState(): void {
  root.setAttribute('aria-busy', String(busy));
  root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea').forEach((control) => {
    if (busy) {
      if (!busyDisabledState.has(control)) busyDisabledState.set(control, control.disabled);
      control.disabled = true;
    } else if (busyDisabledState.has(control)) {
      control.disabled = busyDisabledState.get(control) === true;
      busyDisabledState.delete(control);
    }
  });
  const dockButton = document.getElementById('dock-to-main') as HTMLButtonElement | null;
  if (dockButton) dockButton.disabled = busy;
}

function setBusy(next: boolean): void {
  busy = next;
  syncBusyState();
  if (!next) scheduleBackgroundActions();
}

function renderIfChanged(): void {
  if (renderedSurface !== surfaceProjection(surface) || renderedError !== errorMessage || renderedPendingActionId !== pendingActionId) render();
  else {
    syncBusyState();
    scheduleBackgroundActions();
  }
}

function render(): void {
  if (!surface) {
    root.innerHTML = '<p class="state">等待 Feature bootstrap…</p>';
    renderedSurface = '';
    renderedError = errorMessage;
    syncBusyState();
    return;
  }
  const pending = createAssociatePendingPresentation();
  const workflow = pending ? pendingWorkflow(pending) : surface.workflow;
  const hasWorkflowRail = Boolean(workflow?.steps.length);
  const steps = workflow?.steps.map((step, index) => `<li class="workflow-step ${esc(step.state)}" ${step.stepId === workflow.currentStepId ? 'aria-current="step"' : ''}><span>${index + 1}</span><div><strong>${esc(step.label)}</strong>${step.detail ? `<small>${esc(step.detail)}</small>` : ''}</div></li>`).join('') || '';
  const activeLayer = workflow?.currentStepId === 'upload' ? 'upload' : workflow?.currentStepId === 'return' ? 'return' : surface.review ? 'review' : 'default';
  const visibleReview = activeLayer === 'review' ? surface.review : undefined;
  const selectionBrowser = !visibleReview ? renderSelectionBrowser() : '';
  const hasSelectionBrowser = Boolean(selectionBrowser);
  const restartAction = surface.actions.find((action) => action.presentation === 'restart');
  const previousAction = surface.actions.find((action) => action.actionId === 'back-to-upload');
  const railNavigation = `<div class="workflow-navigation">${restartAction ? actionButton(restartAction, 'class="workflow-restart"') : ''}${previousAction ? actionButton(previousAction, 'class="workflow-previous"') : ''}</div>`;
  const items = !visibleReview && !surface.selectionBrowser ? surface.items.map((item) => `<label class="item ${item.selectable ? '' : 'disabled'}"><input type="radio" name="selection" value="${esc(item.id)}" ${surface!.selectedItemIds.includes(item.id) ? 'checked' : ''} ${item.selectable ? '' : 'disabled'}><span><strong>${esc(item.title)}</strong><small>${esc(item.subtitle)}</small></span><em>${esc(item.type)}</em></label>`).join('') : '';
  const actions = !visibleReview && !surface.recorder && !surface.selectionBrowser ? surface.actions.filter((action) => {
    if (['restart', 'file_input', 'background'].includes(action.presentation || '')) return false;
    if (surface?.featureId === 'omnia.create-associate' && activeLayer === 'return') {
      return ['confirm-return', 'continue-return', 'reconcile-return'].includes(action.actionId) && action.enabled;
    }
    return activeLayer === 'upload' ? action.presentation === 'upload' : action.presentation !== 'upload';
  }).map((action) => actionButton(action)).join('') : '';
  const recorder = renderRecorder();
  const sourceArtifact = [...(surface.artifacts || [])].reverse().find((artifact) => artifact.kind === 'source');
  const artifacts = (surface.artifacts || []).filter((artifact) => artifact.kind !== 'source').map((artifact) => `<div class="artifact"><span><strong>${esc(artifact.name)}</strong><small>sha256:${esc(artifact.sha256.slice(0, 12))}… · ${artifact.sizeBytes} bytes</small></span>${artifact.available ? `<button data-download="${esc(artifact.artifactId)}">下载</button>` : `<em>${esc(artifact.reason)}</em>`}</div>`).join('');
  const editors = !visibleReview ? (surface.editors || []).map((editor) => `<label class="editor"><span>${esc(editor.label)}</span>${editor.inputKind === 'enum'
    ? `<select data-editor="${esc(editor.issueId)}" data-field="${esc(editor.fieldKey)}" data-revision="${editor.expectedRevision}">${editor.allowedValues.map((value) => `<option value="${esc(value)}" ${value === editor.currentValue ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>`
    : `<input data-editor="${esc(editor.issueId)}" data-field="${esc(editor.fieldKey)}" data-revision="${editor.expectedRevision}" value="${esc(editor.currentValue)}" maxlength="${editor.maxLength}" ${editor.required ? 'required' : ''}>`}</label>`).join('') : '';
  const capsuleProgress = surface.progress?.items.some((item) => item.completed !== undefined && item.total !== undefined && item.percent !== undefined) === true;
  const progress = surface.progress ? `<section class="progress-panel ${capsuleProgress ? 'capsule-progress' : ''}" aria-label="${esc(surface.progress.label)}"><div class="progress-heading"><strong>${esc(surface.progress.label)}</strong><span>${surface.progress.completed}/${surface.progress.total} · ${surface.progress.percent}%</span></div><progress max="100" value="${surface.progress.percent}">${surface.progress.percent}%</progress>${!capsuleProgress && surface.progress.message ? `<p class="state">${esc(surface.progress.message)}</p>` : ''}<div class="checks">${surface.progress.items.map((item) => item.completed !== undefined && item.total !== undefined && item.percent !== undefined
    ? `<div class="check capsule ${esc(item.state)}" style="--capsule-progress:${item.percent}%"><div><strong>${esc(item.label)}</strong><small>${item.completed}/${item.total}</small></div></div>`
    : `<div class="check ${esc(item.state)}"><span>${esc(item.state)}</span><div><strong>${esc(item.label)}</strong><small>${esc(item.detail)}</small></div></div>`).join('')}</div></section>` : '';
  const issues = !visibleReview ? (surface.issues || []).map((issue) => `<div class="issue ${esc(issue.severity)}"><strong>${esc(issue.scope === 'global' ? '全局' : issue.scope === 'element' ? `元素 ${issue.elementId}` : '字段')}</strong><span>${esc(issue.message)}</span></div>`).join('') : '';
  const inputAction = activeLayer === 'upload' || !visibleReview ? surface.actions.find((action) => action.input?.kind === 'open_file') : undefined;
  const drop = inputAction ? `<section class="drop-zone ${sourceArtifact ? 'has-source' : ''}" data-drop-action="${esc(inputAction.actionId)}" tabindex="0">${sourceArtifact
    ? `<strong>${esc(sourceArtifact.name)}</strong><span>${sourceArtifact.sizeBytes} bytes · ${esc(sourceArtifact.reason || '待确认上传')}</span><small>点击或拖入另一个非空 .xlsx 文件可替换</small>`
    : `<strong>上传 .xlsx 资料</strong><span>点击“${esc(inputAction.label)}”选择，或将第一个非空 .xlsx 文件拖到这里</span>`}</section>` : '';
  const review = visibleReview ? renderReview(visibleReview) : '';
  const compactCreateAssociateReturn = surface.featureId === 'omnia.create-associate' && activeLayer === 'return';
  const header = hasSelectionBrowser ? '' : compactCreateAssociateReturn
    ? `<h1>${esc(surface.title)}</h1>`
    : `<span class="status">${esc(surface.status)}</span><h1>${esc(surface.title)}</h1><p>${esc(surface.description)}</p>${surface.statusMessage ? `<p class="state">${esc(surface.statusMessage)}</p>` : ''}`;
  const pendingContent = pending
    ? `<section class="surface-layer ${pending.currentStepId === 'return' ? 'return-layer' : 'default-layer'}" data-surface-layer="${pending.currentStepId}" data-pending-action="${esc(pending.actionId)}">${header}<section class="progress-panel" role="status" aria-live="polite"><div class="check pending"><span>PENDING</span><div><strong>${esc(pending.title)}</strong><small>${esc(pending.message)}</small></div></div></section>${pending.actionId === 'confirm-return' ? progress : ''}</section>`
    : '';
  const layerContent = pendingContent || (activeLayer === 'upload' && inputAction
    ? `<section class="surface-layer upload-layer" data-surface-layer="upload">${header}<div class="upload-card"><h2>上传资料</h2><p class="state">选择或拖入官方 .xlsx 只会暂存文件；点击“确认上传”后才进入校验。</p>${drop}${artifacts ? `<div class="artifacts">${artifacts}</div>` : ''}${actions ? `<div class="actions">${actions}</div>` : ''}</div></section>`
    : `<section class="surface-layer ${activeLayer === 'review' ? 'review-layer' : activeLayer === 'return' ? 'return-layer' : 'default-layer'}${hasSelectionBrowser ? ' catalog-priority-layer' : ''}" data-surface-layer="${activeLayer}">${header}${selectionBrowser}${recorder}${progress}${issues ? `<section class="issues">${issues}</section>` : ''}${review}${items ? `<div class="items">${items}</div>` : ''}${editors ? `<div class="editors">${editors}</div>` : ''}${artifacts ? `<div class="artifacts">${artifacts}</div>` : ''}${actions ? `<div class="actions">${actions}</div>` : ''}</section>`);
  root.innerHTML = `${errorMessage ? `<p class="error page-error" role="alert">${esc(errorMessage)}</p>` : ''}<div class="feature-layout ${hasWorkflowRail ? 'has-workflow' : 'no-workflow'}">${hasWorkflowRail ? `<nav class="workflow-rail" aria-label="步骤"><ol>${steps}</ol>${railNavigation}</nav>` : ''}<section class="operation-pane">${layerContent}</section></div>`;
  renderedSurface = surfaceProjection(surface);
  renderedError = errorMessage;
  renderedPendingActionId = pendingActionId;
  renderHostToolbar();
  bindInteractions(inputAction);
  syncBusyState();
  scheduleBackgroundActions();
}

function backgroundActionKey(
  projection: Pick<DeclarativeFeatureSurface, 'featureId' | 'featureVersion' | 'surfaceId' | 'stateVersion'>,
  actionId: string
): string {
  return `${projection.featureId}\u0000${projection.featureVersion}\u0000${projection.surfaceId}\u0000${projection.stateVersion}\u0000${actionId}`;
}

function scheduleBackgroundActions(): void {
  if (!surface || busy) return;
  const projection = {featureId:surface.featureId,featureVersion:surface.featureVersion,surfaceId:surface.surfaceId,stateVersion:surface.stateVersion};
  for (const action of surface.actions.filter((candidate) => candidate.presentation === 'background' && candidate.enabled && candidate.effect !== 'omnia_mutation')) {
    const key = backgroundActionKey(projection, action.actionId);
    if (backgroundActionAttempts.has(key) || backgroundActionScheduled.has(key)) continue;
    backgroundActionScheduled.add(key);
    requestAnimationFrame(() => {
      backgroundActionScheduled.delete(key);
      const currentAction = surface?.actions.find((candidate) => candidate.actionId === action.actionId);
      if (!surface
        || surface.featureId !== projection.featureId
        || surface.featureVersion !== projection.featureVersion
        || surface.surfaceId !== projection.surfaceId
        || surface.stateVersion !== projection.stateVersion
        || currentAction?.presentation !== 'background'
        || currentAction.enabled !== true
        || currentAction.effect === 'omnia_mutation') return;
      // Busy work will call scheduleBackgroundActions again when it releases the
      // renderer. Do not consume this revision/action attempt before that point.
      if (busy) return;
      backgroundActionAttempts.add(key);
      void invoke(action.actionId, {});
    });
  }
}

async function chooseAndStageInput(inputAction: DeclarativeFeatureAction): Promise<void> {
  if (!surface || busy || inputAction.input?.kind !== 'open_file') return;
  setBusy(true);
  let artifact;
  try {
    artifact = await window.featureSurface.chooseInput({featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, actionId: inputAction.actionId, accept: inputAction.input.accept});
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : '文件导入失败';
  } finally {
    setBusy(false);
  }
  if (artifact) await invoke(inputAction.actionId, {artifact});
  else renderIfChanged();
}

function bindInteractions(inputAction: DeclarativeFeatureAction | undefined): void {
  root.querySelectorAll<HTMLInputElement>('input[name=selection]').forEach((input) => input.addEventListener('change', () => {
    if (!surface) return;
    if (!surface.selectionBrowser) {
      void invoke('runtime.set-selection', {selectedItemIds: [input.value]});
      return;
    }
    const selected = new Set(surface.selectedItemIds);
    if (input.checked) selected.add(input.value); else selected.delete(input.value);
    void invoke('runtime.set-selection', {selectedItemIds: [...selected]});
  }));
  root.querySelector<HTMLInputElement>('[data-catalog-search]')?.addEventListener('input', (event) => {
    const control = event.currentTarget as HTMLInputElement;
    selectionQuery = control.value;
    const selectionStart = control.selectionStart;
    render();
    requestAnimationFrame(() => {
      const next = root.querySelector<HTMLInputElement>('[data-catalog-search]');
      next?.focus();
      if (next && selectionStart !== null) next.setSelectionRange(selectionStart, selectionStart);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-catalog-scope]').forEach((button) => button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    selectedScopeId = button.dataset.catalogScope || '';
    render();
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-catalog-collapse]').forEach((button) => button.addEventListener('click', () => {
    const scopeId = button.dataset.catalogCollapse || '';
    if (!scopeId) return;
    if (collapsedScopeIds.has(scopeId)) collapsedScopeIds.delete(scopeId); else collapsedScopeIds.add(scopeId);
    render();
  }));
  root.querySelector<HTMLButtonElement>('[data-catalog-select-visible]')?.addEventListener('click', () => {
    if (!surface?.selectionBrowser || selectionBrowserUnavailable()) return;
    const visibleIds = visibleSelectionItems().filter((item) => item.selectable).map((item) => item.id);
    if (!visibleIds.length) return;
    const selected = new Set(surface.selectedItemIds);
    const remove = visibleIds.every((itemId) => selected.has(itemId));
    for (const itemId of visibleIds) {
      if (remove) selected.delete(itemId); else selected.add(itemId);
    }
    void invoke('runtime.set-selection', {selectedItemIds: [...selected]});
  });
  root.querySelectorAll<HTMLButtonElement>('[data-review-kind]').forEach((button) => button.addEventListener('click', () => {
    if (!surface?.review) return;
    selectReviewKind(surface.review, button.dataset.reviewKind as DeclarativeReviewElementKind);
    render();
  }));
  root.querySelector<HTMLSelectElement>('[data-review-element]')?.addEventListener('change', (event) => {
    selectedReviewRowKey = (event.currentTarget as HTMLSelectElement).value;
    render();
  });
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-review-input]').forEach((control) => control.addEventListener('input', () => {
    const fieldKey = control.dataset.field || '';
    if (control.value === control.dataset.initial) dirtyReviewValues.delete(fieldKey); else dirtyReviewValues.set(fieldKey, control.value);
    root.querySelectorAll<HTMLButtonElement>('.review-actions [data-action]').forEach((button) => {
      const action = surface?.actions.find((candidate) => candidate.actionId === button.dataset.action);
      const isApply = action?.actionId === 'apply-revisions';
      const dirtyDisabled = reviewActionDirtyDisabled(action?.actionId);
      const selectionDisabled = action?.actionId === 'remove-batch-row' && !selectedReviewRowKey;
      button.disabled = busy || !action?.enabled || dirtyDisabled || selectionDisabled;
      button.title = selectionDisabled
        ? '当前没有可移除元素。'
        : dirtyDisabled
          ? isApply ? '尚未修改字段。' : '请先保存修改。'
          : action?.reason || '';
    });
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-review-issue-row]').forEach((button) => button.addEventListener('click', () => {
    if (!surface?.review) return;
    const rowKey = button.dataset.reviewIssueRow || '';
    const element = surface.review.elements.find((candidate) => candidate.rowKey === rowKey && !candidate.excluded);
    if (!element) return;
    selectedReviewKind = element.kind;
    selectedReviewRowKey = rowKey;
    const fieldKey = button.dataset.reviewIssueField || '';
    render();
    requestAnimationFrame(() => {
      const exact = [...root.querySelectorAll<HTMLElement>('[data-review-field]')].find((field) => field.dataset.reviewField === fieldKey);
      const fallback = root.querySelector<HTMLElement>('.review-field.has-message, .review-field [required]');
      const target = exact || fallback;
      target?.scrollIntoView({block: 'center'});
      (target?.matches('input,select,textarea') ? target : target?.querySelector<HTMLElement>('input,select,textarea'))?.focus();
    });
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => button.addEventListener('click', async () => {
    const selection = button.dataset.selection;
    const selected = surface?.selectionBrowser
      ? [...surface.selectedItemIds]
      : [...root.querySelectorAll<HTMLInputElement>('input[name=selection]:checked')].map((item) => item.value);
    const action = surface?.actions.find((candidate) => candidate.actionId === button.dataset.action);
    if (surface?.workflow?.currentStepId !== 'upload' && surface?.review && action?.input?.kind === 'open_file') { errorMessage = '请先返回上传步骤，再重新选择资料。'; render(); return; }
    let payload: Record<string, unknown> = selection && selection !== 'none' ? {targetIds: selected} : {};
    if (action?.actionId === 'apply-revisions') {
      payload = {revisions: reviewDraftRevisions()};
    } else if (action?.actionId === 'remove-batch-row') {
      payload = {rowKey: selectedReviewRowKey, expectedRunRevision: surface?.stateVersion};
    } else if (action?.actionId === 'revalidate-all') {
      payload = {expectedRunRevision: surface?.stateVersion, revisions: reviewDraftRevisions()};
    }
    if (action?.output?.kind === 'save_managed_asset' && surface) {
      setBusy(true);
      try { await window.featureSurface.saveManagedAsset({featureId: surface.featureId, featureVersion: surface.featureVersion, actionId: action.actionId, memberPath: action.output.memberPath}); }
      catch (error) { errorMessage = error instanceof Error ? error.message : '模板下载失败'; }
      finally { setBusy(false); renderIfChanged(); }
      return;
    }
    if (action?.input?.kind === 'open_file' && surface) {
      setBusy(true);
      try {
        const artifact = await window.featureSurface.chooseInput({featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, actionId: action.actionId, accept: action.input.accept});
        if (!artifact) return;
        payload = {...payload, artifact};
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : '文件导入失败';
        renderIfChanged();
        return;
      } finally {
        setBusy(false);
      }
    }
    if (action?.actionId === 'remove-batch-row' && !window.confirm('仅从本次上传批次中移除此元素；不会删除 Omnia 中的任何对象。是否继续？')) return;
    void invoke(button.dataset.action || '', payload);
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-download]').forEach((button) => button.addEventListener('click', async () => {
    if (!surface || busy) return;
    setBusy(true);
    try { await window.featureSurface.saveArtifact({featureId: surface.featureId, artifactId: button.dataset.download || ''}); }
    catch (error) { errorMessage = error instanceof Error ? error.message : '下载失败'; }
    finally { setBusy(false); renderIfChanged(); }
  }));
  const dropZone = root.querySelector<HTMLElement>('[data-drop-action]');
  if (dropZone && inputAction) {
    dropZone.addEventListener('click', () => void chooseAndStageInput(inputAction));
    dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void chooseAndStageInput(inputAction); }
    });
    dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
    dropZone.addEventListener('drop', async (event) => {
      event.preventDefault(); dropZone.classList.remove('dragging');
      if (!surface || busy) return;
      const file = [...(event.dataTransfer?.files || [])].find((candidate) => candidate.size > 0 && candidate.name.toLocaleLowerCase('en-US').endsWith('.xlsx'));
      if (!file) { errorMessage = '请拖入第一个非空 .xlsx 文件。'; render(); return; }
      setBusy(true);
      try {
        const artifact = await window.featureSurface.importInputBytes({featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, actionId: inputAction.actionId, accept: inputAction.input!.accept, name: file.name, bytes: new Uint8Array(await file.arrayBuffer())});
        setBusy(false);
        await invoke(inputAction.actionId, {artifact});
      } catch (error) { errorMessage = error instanceof Error ? error.message : '文件导入失败'; }
      finally { setBusy(false); renderIfChanged(); }
    });
  }
}

async function invoke(actionId: string, payload: Record<string, unknown>): Promise<void> {
  if (!surface || busy) return;
  if (surface.featureId === 'omnia.create-associate' && ['confirm-upload', 'prepare-return', 'confirm-return'].includes(actionId)) pendingActionId = actionId;
  setBusy(true);
  renderIfChanged();
  try {
    const snapshot = await window.featureSurface.featureAction({featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, actionId, expectedStateVersion: surface.stateVersion, payload});
    surface = snapshot.features.surface;
    recorderProjectedAt = Date.now();
    dirtyReviewValues.clear();
    selectedReviewKind = '';
    selectedReviewRowKey = '';
  } catch (error) { errorMessage = error instanceof Error ? error.message : 'Feature 操作失败'; }
  finally { pendingActionId = ''; setBusy(false); renderIfChanged(); }
}

if (typeof window !== 'undefined' && root) {
  document.getElementById('dock-to-main')?.addEventListener('click', async () => {
    const button = document.getElementById('dock-to-main') as HTMLButtonElement | null;
    if (!button || busy || hostPlacement !== 'detached') return;
    button.disabled = true;
    try { await window.featureSurface.dockToMain(); }
    catch (error) { errorMessage = error instanceof Error ? error.message : '回贴主界面失败'; button.disabled = false; render(); }
  });
  window.featureSurface.onBootstrap((next) => {
    const previous = surface;
    const preservedDrafts = reconcileBootstrapReviewDrafts(previous, next, dirtyReviewValues);
    const sameProjection = previous?.featureId === next.featureId
      && previous.featureVersion === next.featureVersion
      && previous.surfaceId === next.surfaceId
      && previous.stateVersion === next.stateVersion;
    surface = next;
    if (previous && next.stateVersion !== previous.stateVersion) pendingActionId = '';
    recorderProjectedAt = Date.now();
    errorMessage = '';
    dirtyReviewValues = preservedDrafts;
    if (!sameProjection) {
      selectedReviewKind = '';
      selectedReviewRowKey = '';
    }
    void window.featureSurface.getHostContext().then((context) => { hostPlacement = context.placement; renderHostToolbar(); })
      .catch((error) => { errorMessage = error instanceof Error ? error.message : '读取 Feature 窗口上下文失败'; render(); });
    renderIfChanged();
  });
  render();
  window.setInterval(updateRecorderClock, 1_000);
}
