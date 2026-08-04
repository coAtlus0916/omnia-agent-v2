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

test('docked Feature Window keeps responsive overflow and full-width editors at narrow zoomed layouts',()=>{
  const html=fs.readFileSync(path.resolve(import.meta.dirname,'../src/renderer/feature-window.html'),'utf8');
  assert.match(html,/\*\{box-sizing:border-box;min-width:0\}/u);
  assert.match(html,/#feature-root\{[^}]*max-width:100%[^}]*overflow:auto[^}]*overflow-wrap:anywhere/u);
  assert.match(html,/\.item,.artifact\{[^}]*flex-wrap:wrap[^}]*max-width:100%/u);
  assert.match(html,/\.editor\{[^}]*grid-template-columns:minmax\(90px,1fr\) minmax\(0,2fr\)[^}]*max-width:100%/u);
  assert.match(html,/\.editor input,.editor select\{width:100%;max-width:100%\}/u);
  assert.match(html,/@media\(max-width:320px\)\{[^}]*body\{padding:9px\}\.editor\{grid-template-columns:1fr\}/u);
});
