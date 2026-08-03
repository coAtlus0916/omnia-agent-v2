import type { DeclarativeFeatureSurface } from '../shared/feature-contracts.js';

const root = document.getElementById('feature-root')!;
const esc = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
let surface: DeclarativeFeatureSurface | null = null;
let busy = false;

function render(): void {
  if (!surface) { root.innerHTML = '<p class="state">等待 Feature bootstrap…</p>'; return; }
  const items = surface.items.map((item) => `<label class="item ${item.selectable ? '' : 'disabled'}"><input type="radio" name="selection" value="${esc(item.id)}" ${surface!.selectedItemIds.includes(item.id) ? 'checked' : ''} ${item.selectable ? '' : 'disabled'}><span><strong>${esc(item.title)}</strong><small>${esc(item.subtitle)}</small></span><em>${esc(item.type)}</em></label>`).join('');
  const actions = surface.actions.map((action) => `<button data-action="${esc(action.actionId)}" data-selection="${esc(action.selectionMode || 'none')}" ${action.enabled && !busy ? '' : 'disabled'} title="${esc(action.reason)}">${esc(action.label)}</button>`).join('');
  root.innerHTML = `<span class="status">${esc(surface.status)}</span><h1>${esc(surface.title)}</h1><p>${esc(surface.description)}</p>${surface.statusMessage ? `<p class="state">${esc(surface.statusMessage)}</p>` : ''}${items ? `<div class="items">${items}</div>` : '<p class="state">Feature 尚未返回可显示的数据。</p>'}<div class="actions">${actions}</div>`;
  root.querySelectorAll<HTMLInputElement>('input[name=selection]').forEach((input) => input.addEventListener('change', () => void invoke('runtime.set-selection', { selectedItemIds: [input.value] })));
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const selection = button.dataset.selection;
    const selected = [...root.querySelectorAll<HTMLInputElement>('input[name=selection]:checked')].map((item) => item.value);
    void invoke(button.dataset.action || '', selection && selection !== 'none' ? { targetIds: selected } : {});
  }));
}

async function invoke(actionId: string, payload: Record<string, unknown>): Promise<void> {
  if (!surface || busy) return;
  busy = true; render();
  try {
    const snapshot = await window.featureSurface.featureAction({
      featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId,
      actionId, expectedStateVersion: surface.stateVersion, payload
    });
    surface = snapshot.features.surface;
  } catch (error) {
    root.insertAdjacentHTML('afterbegin', `<p class="error">${esc(error instanceof Error ? error.message : 'Feature 操作失败')}</p>`);
  } finally { busy = false; render(); }
}

window.featureSurface.onBootstrap((next) => { surface = next; busy = false; render(); });
render();
