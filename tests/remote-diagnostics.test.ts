import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSupervisorDiagnostics } from '../src/remote-connector/diagnostics.ts';
import type { RemoteConnectorPaths } from '../src/remote-connector/managed-state.ts';

test('Supervisor diagnostics return a redacted Worker heartbeat recovery event', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-remote-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'supervisor.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(),
    level: 'warn',
    product: 'omnia-agent-v5-remote-connector',
    message: 'Remote Connector Worker heartbeat remained stale; Supervisor is recovering the owned Worker.',
    version: '0.3.31',
    pid: 4321,
    staleForMs: 31_000,
    error: 'Authorization=Bearer must-not-leak'
  })}\n`);
  const events = readSupervisorDiagnostics({ logs } as RemoteConnectorPaths);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, 'worker_heartbeat_recovery');
  assert.doesNotMatch(JSON.stringify(events), /must-not-leak|Bearer must/u);
});
