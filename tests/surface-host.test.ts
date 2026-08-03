import assert from 'node:assert/strict';
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

