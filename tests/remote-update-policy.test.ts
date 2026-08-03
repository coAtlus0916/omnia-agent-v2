import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultManagedState } from '../src/remote-connector/managed-state.ts';
import type { UpdateManifest } from '../src/remote-connector/release-contract.ts';
import { assertUpdateSequenceAdmitted, workerStatusAllowsActivation } from '../src/remote-connector/update-policy.ts';

const now = Date.now();
const status = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'omnia.v5.remote-connector-status/v1',
  product: 'omnia-agent-v5-remote-connector',
  heartbeatAt: new Date(now).toISOString(),
  activeOperations: 0,
  uncertainOperations: 0,
  ...overrides
});

test('automatic activation requires a fresh worker with no active or uncertain operation', () => {
  assert.equal(workerStatusAllowsActivation(status(), 'omnia-agent-v5-remote-connector', now), true);
  assert.equal(workerStatusAllowsActivation(status({ activeOperations: 1 }), 'omnia-agent-v5-remote-connector', now), false);
  assert.equal(workerStatusAllowsActivation(status({ uncertainOperations: 1 }), 'omnia-agent-v5-remote-connector', now), false);
  assert.equal(workerStatusAllowsActivation(status({ heartbeatAt: new Date(now - 6_000).toISOString() }), 'omnia-agent-v5-remote-connector', now), false);
});

test('automatic update rejects downgrade sequence and a repeated failed probation release', () => {
  const state = {
    ...defaultManagedState(),
    current: '0.3.2',
    highestSequence: 5,
    blocked: { '0.3.3': { sequence: 6, reason: 'probation failed', blockedAt: new Date(now).toISOString() } }
  };
  const manifest = { version: '0.3.3', sequence: 6 } as UpdateManifest;
  assert.throws(() => assertUpdateSequenceAdmitted({ ...manifest, sequence: 5 }, state), /stale or a downgrade/);
  assert.throws(() => assertUpdateSequenceAdmitted(manifest, state), /blocked after a failed probation/);
  assert.doesNotThrow(() => assertUpdateSequenceAdmitted({ ...manifest, version: '0.3.4', sequence: 7 }, state));
});
