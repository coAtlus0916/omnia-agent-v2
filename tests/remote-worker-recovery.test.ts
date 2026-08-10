import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workerUrl = new URL('../src/remote-connector/worker.ts', import.meta.url);
const workerPath = fileURLToPath(workerUrl);
const workerSource = fs.readFileSync(workerUrl, 'utf8');

function probe(input: Record<string, unknown>): Record<string, any> {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', workerPath, '--recovery-contract-probe'],
    { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as Record<string, any>;
}

test('Worker acknowledges takeover only for a live new lock with a fresh matching heartbeat', () => {
  const now = Date.now();
  const oldPid = 101;
  const oldToken = 'old-owner-token-000000000000';
  const newPid = 202;
  const newToken = 'new-owner-token-000000000000';
  const processStartedAt = new Date(now - 5_000).toISOString();
  const lock = {
    schemaVersion: 'omnia.v5.remote-connector-supervisor-lock/v2',
    product: 'omnia-agent-v5-remote-connector',
    pid: newPid,
    token: newToken,
    processStartedAt,
    createdAt: new Date(now - 500).toISOString()
  };
  const heartbeat = {
    schemaVersion: 'omnia.v5.remote-connector-supervisor-heartbeat/v2',
    product: 'omnia-agent-v5-remote-connector',
    pid: newPid,
    token: newToken,
    processStartedAt,
    workerPid: 0,
    heartbeatAt: new Date(now - 100).toISOString()
  };
  const base = {
    lock,
    heartbeat,
    expectedOwnerPid: oldPid,
    expectedOwnerToken: oldToken,
    workerPid: 303,
    minimumCreatedAt: now - 1_000,
    now,
    newSupervisorAlive: true
  };
  const output = probe({
    takeoverCases: [
      base,
      { ...base, lock: { ...lock, pid: oldPid } },
      { ...base, lock: { ...lock, token: oldToken } },
      { ...base, heartbeat: { ...heartbeat, token: 'different-token-00000000000' } },
      { ...base, heartbeat: { ...heartbeat, heartbeatAt: new Date(now - 10_001).toISOString() } },
      { ...base, newSupervisorAlive: false },
      { ...base, heartbeat: { ...heartbeat, workerPid: -1 } }
    ]
  });
  assert.deepEqual(output.takeover.map((entry: Record<string, unknown>) => entry.acknowledged), [
    true, false, false, false, false, false, false
  ]);
  assert.equal(output.takeover[0].supervisorPid, newPid);
  assert.equal(output.takeover[0].reason, 'replacement_supervisor_acknowledged');
  assert.equal(JSON.stringify(output).includes(newToken), false, 'probe output must not expose the lock token');
});
test('Worker recovery stays fail-closed for active commands and uses bounded retry backoff', () => {
  const now = Date.now();
  const base = {
    ownerHealthy: false,
    recoveryInProgress: false,
    missingForMs: 40_000,
    ownerLeaseMs: 35_000,
    activeOperations: 0,
    now,
    retryAt: 0
  };
  const output = probe({
    decisionCases: [
      { ...base, ownerHealthy: true },
      { ...base, recoveryInProgress: true },
      { ...base, missingForMs: 34_999 },
      { ...base, activeOperations: 1, missingForMs: 600_000 },
      { ...base, retryAt: now + 1_000 },
      base
    ],
    retryFailures: [1, 2, 3, 6]
  });
  assert.deepEqual(output.decisions, [
    'healthy', 'in_progress', 'wait_lease', 'drain_active', 'wait_retry', 'recover'
  ]);
  assert.deepEqual(output.retryDelays, [1_000, 2_000, 4_000, 30_000]);
  assert.equal(output.maxAttempts, 3);
});

test('Worker rejects new commands before dispatch and exits only after takeover acknowledgement', () => {
  assert.match(workerSource, /REMOTE\.SUPERVISOR_RECOVERY_QUIESCING/);
  const recoverStart = workerSource.indexOf('async function recoverSupervisorAfterOwnerLoss()');
  const recoverEnd = workerSource.indexOf('\nfunction sendDiagnostics(', recoverStart);
  const recoverySource = workerSource.slice(recoverStart, recoverEnd);
  const acknowledged = recoverySource.indexOf('if (takeover.acknowledged)');
  const exitAfterAck = recoverySource.indexOf('await exitAfterSupervisorTakeover(takeover, attempt)', acknowledged);
  assert.ok(recoverStart >= 0 && recoverEnd > recoverStart && acknowledged >= 0 && exitAfterAck > acknowledged);
  assert.doesNotMatch(recoverySource, /finally\s*\{\s*process\.exit/);
  const exitHelperStart = workerSource.indexOf('async function exitAfterSupervisorTakeover(');
  const exitHelperEnd = workerSource.indexOf('\nfunction clearWorkerRecoveryHandoff(', exitHelperStart);
  const exitHelper = workerSource.slice(exitHelperStart, exitHelperEnd);
  assert.match(exitHelper, /await shutdown\(\)/);
  assert.match(exitHelper, /process\.exit\(1\)/);
});
