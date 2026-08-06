import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeSocketHeartbeatDecision } from '../src/remote-connector/socket-health.ts';

test('Bridge socket heartbeat pings before the server stale deadline and terminates a half-open connection', () => {
  const now = Date.now();
  assert.deepEqual(bridgeSocketHeartbeatDecision({
    now,
    lastPongAt: now - 5_000,
    lastPingAt: now - 11_000,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 30_000
  }), { sendPing: true, terminate: false });
  assert.deepEqual(bridgeSocketHeartbeatDecision({
    now,
    lastPongAt: now - 31_000,
    lastPingAt: now - 11_000,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 30_000
  }), { sendPing: true, terminate: true });
});
test('Bridge socket heartbeat fails closed on an implausible future clock', () => {
  const now = Date.now();
  assert.deepEqual(bridgeSocketHeartbeatDecision({
    now,
    lastPongAt: now + 60_000,
    lastPingAt: now,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 30_000
  }), { sendPing: false, terminate: true });
});
