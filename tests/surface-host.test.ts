import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SurfaceHost } from '../src/renderer/surface-host.ts';

test('SurfaceHost enforces one instance and keeps lifecycle state across placement changes', () => {
  const host = new SurfaceHost<{ stateVersion: number }>();
  const first = host.open('feature-a', 'context-1', { stateVersion: 1 });
  assert.equal(host.open('feature-a', 'context-1').instanceId, first.instanceId);
  assert.equal(host.snapshot().instances.length, 1);
  host.detach(first.instanceId);
  assert.equal(host.get(first.instanceId)?.placement, 'detached');
  host.minimize(first.instanceId);
  assert.equal(host.get(first.instanceId)?.placement, 'minimized');
  host.restore(first.instanceId);
  assert.equal(host.get(first.instanceId)?.placement, 'docked');
  host.close(first.instanceId);
  assert.equal(host.get(first.instanceId)?.placement, 'closed');
  assert.equal(host.open('feature-a', 'context-1').instanceId, first.instanceId);
  assert.equal(host.snapshot().instances.length, 1);
});

test('SurfaceHost opens distinct contexts but focuses an existing minimized surface', () => {
  const host = new SurfaceHost();
  const a = host.open('feature-a', 'context-1');
  host.open('feature-a', 'context-2');
  assert.equal(host.snapshot().instances.length, 2);
  host.minimize(a.instanceId);
  const restored = host.focusFeature('feature-a', 'context-1');
  assert.equal(restored?.instanceId, a.instanceId);
  assert.equal(restored?.placement, 'docked');
});

test('SurfaceHost focus preserves detached placement and never restores a closed instance', () => {
  const host = new SurfaceHost();
  const detached = host.open('feature-a', 'detached-context');
  host.detach(detached.instanceId);
  assert.equal(host.focus(detached.instanceId)?.placement, 'detached');
  assert.equal(host.open('feature-a', 'detached-context').placement, 'detached');

  const closed = host.open('feature-a', 'closed-context');
  host.close(closed.instanceId);
  assert.equal(host.focus(closed.instanceId), undefined);
  assert.equal(host.restore(closed.instanceId), undefined);
  assert.equal(host.get(closed.instanceId)?.placement, 'closed');
});

test('SurfaceHost resolves an upgraded signed identity without projecting it into the old version', () => {
  const host = new SurfaceHost<{ featureVersion: string; stateVersion: number }>();
  const oldSurface = { featureVersion: '0.4.15', stateVersion: 31 };
  const newSurface = { featureVersion: '0.4.16', stateVersion: 1 };
  const oldInstance = host.open('omnia.recording', '0.4.15:recording.workbench', oldSurface);
  const newInstance = host.ensure('omnia.recording', '0.4.16:recording.workbench', newSurface);

  const resolution = host.resolveIdentity('omnia.recording', '0.4.16:recording.workbench');
  assert.equal(resolution.instanceId, newInstance.instanceId);
  assert.strictEqual(resolution.current, newInstance);
  assert.deepEqual(resolution.superseded.map((instance) => instance.instanceId), [oldInstance.instanceId]);
  assert.strictEqual(host.get(oldInstance.instanceId)?.value, oldSurface);
  assert.strictEqual(host.get(newInstance.instanceId)?.value, newSurface);

  host.close(oldInstance.instanceId);
  assert.deepEqual(host.resolveIdentity('omnia.recording', '0.4.16:recording.workbench').superseded, []);
});

test('docked Feature Window keeps responsive overflow and full-width editors at narrow zoomed layouts',()=>{
  const html=fs.readFileSync(path.resolve(import.meta.dirname,'../src/renderer/feature-window.html'),'utf8');
  assert.match(html,/\*\{box-sizing:border-box;min-width:0\}/u);
  assert.match(html,/#feature-root\{[^}]*max-width:100%[^}]*overflow:auto[^}]*overflow-wrap:anywhere/u);
  assert.match(html,/\.item,.artifact\{[^}]*flex-wrap:wrap[^}]*max-width:100%/u);
  assert.match(html,/\.editor\{[^}]*grid-template-columns:minmax\(90px,1fr\) minmax\(0,2fr\)[^}]*max-width:100%/u);
  assert.match(html,/\.editor input,.editor select\{width:100%;max-width:100%\}/u);
  const compact = html.slice(html.indexOf('@media(max-width:560px)'), html.indexOf('@media(max-width:360px)'));
  assert.match(compact,/\.feature-layout\{grid-template-columns:1fr\}/u);
  assert.match(compact,/\.workflow-rail\{[^}]*overflow-x:auto/u);
  assert.match(compact,/\.workflow-rail ol\{display:flex/u);
  assert.match(compact,/\.editor\{grid-template-columns:1fr\}/u);
  assert.match(html,/@media\(max-width:360px\)\{\.review-content\{padding:9px\}\.element-picker\{display:grid\}\.review-types\{grid-template-columns:repeat\(4,106px\)\}\}/u);
  assert.doesNotMatch(html,/@media\(max-width:320px\)/u);
});

test('declarative catalog workbench fixes its real status/actions footer and preserves two independent scroll panes',()=>{
  const html=fs.readFileSync(path.resolve(import.meta.dirname,'../src/renderer/feature-window.html'),'utf8');
  const renderer=fs.readFileSync(path.resolve(import.meta.dirname,'../src/renderer/feature-window.ts'),'utf8');
  const contracts=fs.readFileSync(path.resolve(import.meta.dirname,'../src/shared/feature-contracts.ts'),'utf8');
  const packageManager=fs.readFileSync(path.resolve(import.meta.dirname,'../src/main/features/package-manager.ts'),'utf8');
  assert.match(contracts,/mode: 'standard' \| 'fixed_footer_split'/u);
  assert.match(packageManager,/omnia\.selection-browser-layout\/v1/u);
  assert.match(packageManager,/\['standard', 'fixed_footer_split'\]/u);
  assert.match(renderer,/selectionBrowserUsesFixedFooter/u);
  assert.match(renderer,/catalog-footer-status[\s\S]*surface\.statusMessage/u);
  assert.match(renderer,/fixed-footer-split-workbench/u);
  assert.match(renderer,/feature-root-content\$\{fixedFooterSplit \? ' fixed-footer-split-root' : ''\}/u);
  assert.match(html,/\.feature-root-content\.fixed-footer-split-root\{display:grid;grid-template-rows:auto minmax\(0,1fr\);height:100%;min-height:0\}/u);
  assert.match(html,/\.fixed-footer-split-workbench \.operation-pane\{height:100%;min-height:0;overflow:hidden\}/u);
  assert.match(html,/\.selection-browser\.fixed-footer-split\{height:100%;min-height:0[^}]*grid-template-rows:auto minmax\(0,1fr\) auto/u);
  assert.match(html,/\.selection-browser\.fixed-footer-split \.catalog-hierarchy,.selection-browser\.fixed-footer-split \.catalog-results\{overflow-x:hidden;overflow-y:auto\}/u);
  assert.match(html,/@media\(max-width:720px\)[\s\S]*grid-template-rows:minmax\(138px,42%\) minmax\(0,1fr\)/u);
  const selectionBody=renderer.slice(renderer.indexOf('function renderSelectionBrowser'),renderer.indexOf('function recorderTime'));
  assert.equal((selectionBody.match(/<footer class="catalog-footer">/gu)||[]).length,1);
  assert.equal((selectionBody.match(/catalog-footer-status/gu)||[]).length,1);
});
