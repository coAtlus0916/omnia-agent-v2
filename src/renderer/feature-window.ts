import type {
  DeclarativeFeatureAction,
  DeclarativeFeatureReview,
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
  return `<button data-action="${esc(action.actionId)}" data-selection="${esc(action.selectionMode || 'none')}" ${extra} ${action.enabled && !busy ? '' : 'disabled'} title="${esc(action.reason)}">${esc(action.label)}</button>`;
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
  return `<button class="recorder-control ${esc(presentation)}" data-action="${esc(action.actionId)}" data-selection="${esc(action.selectionMode || 'none')}" ${action.enabled && !busy ? '' : 'disabled'} title="${esc(action.reason || action.label)}" aria-label="${esc(action.label)}"><span class="control-icon" aria-hidden="true"></span><span class="control-label">${esc(action.label)}</span></button>`;
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
  const common = `data-review-input data-row-key="${esc(field.rowKey)}" data-field="${esc(field.fieldKey)}" data-revision="${field.expectedRevision}" data-initial="${esc(field.currentValue)}" maxlength="${field.maxLength}" ${field.required ? 'required' : ''} ${field.editable && !busy ? '' : 'disabled'}`;
  if (field.inputKind === 'enum') {
    return `<select ${common}>${field.allowedValues.map((allowed) => `<option value="${esc(allowed)}" ${allowed === value ? 'selected' : ''}>${esc(allowed)}</option>`).join('')}</select>`;
  }
  if (field.inputKind === 'textarea') return `<textarea ${common} rows="4">${esc(value)}</textarea>`;
  if (field.inputKind === 'readonly') return `<output>${esc(value || '—')}</output>`;
  return `<input ${common} value="${esc(value)}">`;
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
  const footerOrder = ['back-to-upload', 'revalidate-all', 'remove-batch-row', 'apply-revisions', 'prepare-return'];
  const footerActions = footerOrder.map((actionId) => actionMap.get(actionId)).filter((action): action is DeclarativeFeatureAction => Boolean(action)).map((action) => {
    const selectedDisabled = action.actionId === 'remove-batch-row' && !selectedElement;
    const dirtyDisabled = action.actionId === 'apply-revisions'
      ? dirtyReviewValues.size === 0
      : dirtyReviewValues.size > 0;
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

function render(): void {
  if (!surface) { root.innerHTML = '<p class="state">等待 Feature bootstrap…</p>'; return; }
  const workflow = surface.workflow;
  const steps = workflow?.steps.map((step, index) => `<li class="workflow-step ${esc(step.state)}" ${step.stepId === workflow.currentStepId ? 'aria-current="step"' : ''}><span>${index + 1}</span><div><strong>${esc(step.label)}</strong>${step.detail ? `<small>${esc(step.detail)}</small>` : ''}</div></li>`).join('') || '';
  const items = !surface.review ? surface.items.map((item) => `<label class="item ${item.selectable ? '' : 'disabled'}"><input type="radio" name="selection" value="${esc(item.id)}" ${surface!.selectedItemIds.includes(item.id) ? 'checked' : ''} ${item.selectable ? '' : 'disabled'}><span><strong>${esc(item.title)}</strong><small>${esc(item.subtitle)}</small></span><em>${esc(item.type)}</em></label>`).join('') : '';
  const actions = !surface.review && !surface.recorder ? surface.actions.map((action) => actionButton(action)).join('') : '';
  const recorder = renderRecorder();
  const artifacts = (surface.artifacts || []).map((artifact) => `<div class="artifact"><span><strong>${esc(artifact.name)}</strong><small>sha256:${esc(artifact.sha256.slice(0, 12))}… · ${artifact.sizeBytes} bytes</small></span><button data-download="${esc(artifact.artifactId)}" ${artifact.available && !busy ? '' : 'disabled'} title="${esc(artifact.reason)}">下载</button></div>`).join('');
  const editors = !surface.review ? (surface.editors || []).map((editor) => `<label class="editor"><span>${esc(editor.label)}</span>${editor.inputKind === 'enum'
    ? `<select data-editor="${esc(editor.issueId)}" data-field="${esc(editor.fieldKey)}" data-revision="${editor.expectedRevision}">${editor.allowedValues.map((value) => `<option value="${esc(value)}" ${value === editor.currentValue ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>`
    : `<input data-editor="${esc(editor.issueId)}" data-field="${esc(editor.fieldKey)}" data-revision="${editor.expectedRevision}" value="${esc(editor.currentValue)}" maxlength="${editor.maxLength}" ${editor.required ? 'required' : ''}>`}</label>`).join('') : '';
  const progress = surface.progress ? `<section class="progress-panel" aria-label="${esc(surface.progress.label)}"><div class="progress-heading"><strong>${esc(surface.progress.label)}</strong><span>${surface.progress.completed}/${surface.progress.total} · ${surface.progress.percent}%</span></div><progress max="100" value="${surface.progress.percent}">${surface.progress.percent}%</progress><p class="state">${esc(surface.progress.message)}</p><div class="checks">${surface.progress.items.map((item) => `<div class="check ${esc(item.state)}"><span>${esc(item.state)}</span><div><strong>${esc(item.label)}</strong><small>${esc(item.detail)}</small></div></div>`).join('')}</div></section>` : '';
  const issues = !surface.review ? (surface.issues || []).map((issue) => `<div class="issue ${esc(issue.severity)}"><strong>${esc(issue.scope === 'global' ? '全局' : issue.scope === 'element' ? `元素 ${issue.elementId}` : '字段')}</strong><span>${esc(issue.message)}</span></div>`).join('') : '';
  const inputAction = !surface.review ? surface.actions.find((action) => action.input?.kind === 'open_file') : undefined;
  const drop = inputAction ? `<section class="drop-zone" data-drop-action="${esc(inputAction.actionId)}" tabindex="0"><strong>上传 .xlsx 资料</strong><span>点击“${esc(inputAction.label)}”选择，或将第一个非空 .xlsx 文件拖到这里</span></section>` : '';
  const review = surface.review ? renderReview(surface.review) : '';
  const header = `<span class="status">${esc(surface.status)}</span><h1>${esc(surface.title)}</h1><p>${esc(surface.description)}</p>${surface.statusMessage ? `<p class="state">${esc(surface.statusMessage)}</p>` : ''}`;
  const activeLayer = workflow?.currentStepId === 'upload' ? 'upload' : workflow?.currentStepId === 'return' ? 'return' : surface.review ? 'review' : 'default';
  const layerContent = activeLayer === 'upload' && inputAction
    ? `<section class="surface-layer upload-layer" data-surface-layer="upload">${header}<div class="upload-card"><h2>上传资料</h2><p class="state">选择新的官方 .xlsx 后将在同一 Run 合同下重新解析和校验；当前 Artifact 在新上传成功前保留。</p>${drop}${artifacts ? `<div class="artifacts">${artifacts}</div>` : ''}${actions ? `<div class="actions">${actions}</div>` : ''}</div></section>`
    : `<section class="surface-layer ${activeLayer === 'review' ? 'review-layer' : activeLayer === 'return' ? 'return-layer' : 'default-layer'}" data-surface-layer="${activeLayer}">${header}${recorder}${progress}${issues ? `<section class="issues">${issues}</section>` : ''}${review}${items ? `<div class="items">${items}</div>` : ''}${editors ? `<div class="editors">${editors}</div>` : ''}${artifacts ? `<div class="artifacts">${artifacts}</div>` : ''}${actions ? `<div class="actions">${actions}</div>` : ''}</section>`;
  root.innerHTML = `${errorMessage ? `<p class="error page-error" role="alert">${esc(errorMessage)}</p>` : ''}<div class="feature-layout">${workflow ? `<nav class="workflow-rail" aria-label="步骤"><ol>${steps}</ol></nav>` : ''}<section class="operation-pane">${layerContent}</section></div>`;
  renderHostToolbar();
  bindInteractions(inputAction);
}

function bindInteractions(inputAction: DeclarativeFeatureAction | undefined): void {
  root.querySelectorAll<HTMLInputElement>('input[name=selection]').forEach((input) => input.addEventListener('change', () => void invoke('runtime.set-selection', {selectedItemIds: [input.value]})));
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
      const dirtyDisabled = isApply ? dirtyReviewValues.size === 0 : dirtyReviewValues.size > 0;
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
    const selected = [...root.querySelectorAll<HTMLInputElement>('input[name=selection]:checked')].map((item) => item.value);
    const action = surface?.actions.find((candidate) => candidate.actionId === button.dataset.action);
    if (surface?.review && action?.input?.kind === 'open_file') { errorMessage = '请先返回上传步骤，再重新选择资料。'; render(); return; }
    let payload: Record<string, unknown> = selection && selection !== 'none' ? {targetIds: selected} : {};
    if (action?.actionId === 'apply-revisions') {
      payload = {revisions: (surface?.review?.fields || []).filter((field) => dirtyReviewValues.has(field.fieldKey)).map((field) => ({
        rowKey: field.rowKey, fieldKey: field.fieldKey, expectedRevision: field.expectedRevision, value: dirtyReviewValues.get(field.fieldKey) ?? field.currentValue
      }))};
    } else if (action?.actionId === 'remove-batch-row') {
      payload = {rowKey: selectedReviewRowKey, expectedRunRevision: surface?.stateVersion};
    } else if (action?.actionId === 'revalidate-all') {
      payload = {expectedRunRevision: surface?.stateVersion};
    }
    if (action?.output?.kind === 'save_managed_asset' && surface) {
      busy = true; render(); errorMessage = '';
      try { await window.featureSurface.saveManagedAsset({featureId: surface.featureId, featureVersion: surface.featureVersion, actionId: action.actionId, memberPath: action.output.memberPath}); }
      catch (error) { errorMessage = error instanceof Error ? error.message : '模板下载失败'; }
      finally { busy = false; render(); }
      return;
    }
    if (action?.input?.kind === 'open_file' && surface) {
      try {
        errorMessage = '';
        const artifact = await window.featureSurface.chooseInput({featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, actionId: action.actionId, accept: action.input.accept});
        if (!artifact) return;
        payload = {...payload, artifact};
      } catch (error) { errorMessage = error instanceof Error ? error.message : '文件导入失败'; render(); return; }
    }
    if (action?.actionId === 'remove-batch-row' && !window.confirm('仅从本次上传批次中移除此元素；不会删除 Omnia 中的任何对象。是否继续？')) return;
    void invoke(button.dataset.action || '', payload);
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-download]').forEach((button) => button.addEventListener('click', async () => {
    if (!surface || busy) return;
    busy = true; render(); errorMessage = '';
    try { await window.featureSurface.saveArtifact({featureId: surface.featureId, artifactId: button.dataset.download || ''}); }
    catch (error) { errorMessage = error instanceof Error ? error.message : '下载失败'; }
    finally { busy = false; render(); }
  }));
  const dropZone = root.querySelector<HTMLElement>('[data-drop-action]');
  if (dropZone && inputAction) {
    dropZone.addEventListener('click', () => root.querySelector<HTMLButtonElement>(`[data-action="${CSS.escape(inputAction.actionId)}"]`)?.click());
    dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
    dropZone.addEventListener('drop', async (event) => {
      event.preventDefault(); dropZone.classList.remove('dragging');
      if (!surface || busy) return;
      const file = [...(event.dataTransfer?.files || [])].find((candidate) => candidate.size > 0 && candidate.name.toLocaleLowerCase('en-US').endsWith('.xlsx'));
      if (!file) { errorMessage = '请拖入第一个非空 .xlsx 文件。'; render(); return; }
      busy = true; errorMessage = ''; render();
      try {
        const artifact = await window.featureSurface.importInputBytes({featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, actionId: inputAction.actionId, accept: inputAction.input!.accept, name: file.name, bytes: new Uint8Array(await file.arrayBuffer())});
        busy = false;
        await invoke(inputAction.actionId, {artifact});
      } catch (error) { errorMessage = error instanceof Error ? error.message : '文件导入失败'; }
      finally { busy = false; render(); }
    });
  }
}

async function invoke(actionId: string, payload: Record<string, unknown>): Promise<void> {
  if (!surface || busy) return;
  busy = true; render(); errorMessage = '';
  try {
    const snapshot = await window.featureSurface.featureAction({featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, actionId, expectedStateVersion: surface.stateVersion, payload});
    surface = snapshot.features.surface;
    recorderProjectedAt = Date.now();
    dirtyReviewValues.clear();
    selectedReviewKind = '';
    selectedReviewRowKey = '';
  } catch (error) { errorMessage = error instanceof Error ? error.message : 'Feature 操作失败'; }
  finally { busy = false; render(); }
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
    recorderProjectedAt = Date.now();
    busy = false;
    errorMessage = '';
    dirtyReviewValues = preservedDrafts;
    if (!sameProjection) {
      selectedReviewKind = '';
      selectedReviewRowKey = '';
    }
    void window.featureSurface.getHostContext().then((context) => { hostPlacement = context.placement; renderHostToolbar(); })
      .catch((error) => { errorMessage = error instanceof Error ? error.message : '读取 Feature 窗口上下文失败'; render(); });
    render();
  });
  render();
  window.setInterval(updateRecorderClock, 1_000);
}
