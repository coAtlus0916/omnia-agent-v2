import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { defaultManagedState } from '../src/remote-connector/managed-state.ts';
import type { UpdateManifest } from '../src/remote-connector/release-contract.ts';
import {
  assertUpdateSequenceAdmitted,
  workerHeartbeatRecoveryDecision,
  workerLifecycleAllowsActivation
} from '../src/remote-connector/update-policy.ts';

const now = Date.now();
const supervisorSource = fs.readFileSync(new URL('../src/remote-connector/supervisor.ts', import.meta.url), 'utf8');
test('pending activation is allowed only before any Worker has started', () => {
  assert.equal(workerLifecycleAllowsActivation(false, false), true);
  assert.equal(workerLifecycleAllowsActivation(true, false), false);
  assert.equal(workerLifecycleAllowsActivation(false, true), false);
});

test('online update checks only stage and never start or stop a Worker', () => {
  const start = supervisorSource.indexOf('async function checkForUpdate(');
  const end = supervisorSource.indexOf('\nfunction startAutomaticUpdateCheck(', start);
  const source = supervisorSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /if \(state\.pending\) return/);
  assert.match(source, /pending:\s*\{/);
  assert.doesNotMatch(source, /activatePending|startWorker|stopWorker/);
});

test('one-shot checks exit before Worker startup and cold activation precedes the first Worker', () => {
  const start = supervisorSource.indexOf('async function main()');
  const end = supervisorSource.indexOf('\nfor (const signal', start);
  const source = supervisorSource.slice(start, end);
  const onceStart = source.indexOf('if (once) {');
  const onceEnd = source.indexOf("fs.rmSync(paths.stopRequest", onceStart);
  const onceSource = source.slice(onceStart, onceEnd);
  const activation = source.indexOf('await activatePendingBeforeWorkerStart(initialState)');
  const ordinaryStart = source.indexOf('if (!worker) startWorker()');
  assert.ok(start >= 0 && end > start && onceStart >= 0 && onceEnd > onceStart);
  assert.match(onceSource, /await checkForUpdate\(\)/);
  assert.match(onceSource, /await shutdown\(false\)/);
  assert.doesNotMatch(onceSource, /startWorker\(\)/);
  assert.ok(activation >= 0 && ordinaryStart > activation);
});

test('Worker watchdog recovers only after continuous local heartbeat staleness', () => {
  const now = Date.now();
  const base = {
    expectedPid: 42,
    statusPid: 42,
    workerStartedAt: now - 60_000,
    staleSince: 0,
    loopGapMs: 1_000,
    now,
    startupGraceMs: 15_000,
    heartbeatFreshMs: 5_000,
    recoveryDelayMs: 30_000
  };
  assert.deepEqual(workerHeartbeatRecoveryDecision({ ...base, heartbeatAt: new Date(now - 1_000).toISOString() }), {
    fresh: true, staleSince: 0, recover: false
  });
  assert.deepEqual(workerHeartbeatRecoveryDecision({
    ...base,
    heartbeatAt: new Date(now + 60_000).toISOString()
  }), { fresh: false, staleSince: now, recover: false });
  const firstStale = workerHeartbeatRecoveryDecision({ ...base, heartbeatAt: new Date(now - 10_000).toISOString() });
  assert.deepEqual(firstStale, { fresh: false, staleSince: now, recover: false });
  assert.equal(workerHeartbeatRecoveryDecision({
    ...base,
    heartbeatAt: new Date(now - 40_000).toISOString(),
    staleSince: now - 31_000
  }).recover, true);
  assert.deepEqual(workerHeartbeatRecoveryDecision({
    ...base,
    heartbeatAt: new Date(now - 40_000).toISOString(),
    staleSince: now - 31_000,
    loopGapMs: 60_000
  }), { fresh: false, staleSince: now - 31_000, recover: true });
  assert.deepEqual(workerHeartbeatRecoveryDecision({
    ...base,
    heartbeatAt: new Date(now - 40_000).toISOString(),
    loopGapMs: 60_000
  }), { fresh: false, staleSince: now, recover: false });
});

test('automatic update staging cannot serialize the Worker watchdog loop', () => {
  const mainStart = supervisorSource.indexOf('async function main()');
  const mainEnd = supervisorSource.indexOf('\nfor (const signal', mainStart);
  const mainSource = supervisorSource.slice(mainStart, mainEnd);
  const ordinaryStart = mainSource.indexOf('let nextUpdateAt = 0');
  const ordinarySource = mainSource.slice(ordinaryStart);
  assert.ok(mainStart >= 0 && mainEnd > mainStart && ordinaryStart >= 0);
  assert.match(ordinarySource, /startAutomaticUpdateCheck\(\)/);
  assert.doesNotMatch(ordinarySource, /await checkForUpdate\(\)/);
  assert.ok(
    ordinarySource.indexOf('startAutomaticUpdateCheck()')
      < ordinarySource.indexOf('workerHeartbeatRecoveryDecision({')
  );
});

test('update extraction is asynchronous and has a hard timeout', () => {
  const start = supervisorSource.indexOf('async function extractRelease(');
  const end = supervisorSource.indexOf('\nfunction healthProbe(', start);
  const source = supervisorSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /const child = spawn\(/);
  assert.doesNotMatch(source, /spawnSync\(/);
  assert.match(source, /UPDATE_EXTRACTION_TIMEOUT_MS/);
  assert.match(source, /child\.kill\('SIGKILL'\)/);
});

test('owned Worker handle is retained until process exit is confirmed', () => {
  const start = supervisorSource.indexOf('async function stopWorker()');
  const end = supervisorSource.indexOf('\nfunction readWorkerStatus()', start);
  const source = supervisorSource.slice(start, end);
  const firstKill = source.indexOf("child.kill('SIGTERM')");
  const directClear = source.indexOf('worker = null');
  assert.ok(start >= 0 && end > start && firstKill >= 0 && directClear >= 0);
  assert.ok(directClear < firstKill, 'worker clearing must be guarded by clearConfirmedWorker');
  assert.match(source.slice(0, firstKill), /const clearConfirmedWorker = \(\) =>/);
  assert.doesNotMatch(source.slice(0, firstKill), /\n\s*worker = null;/);
  assert.match(source, /did not exit after owned-process termination/);
  const startWorkerStart = supervisorSource.indexOf('function startWorker()');
  const startWorkerEnd = supervisorSource.indexOf('\nfunction abandonWorkerForOwnerLoss()', startWorkerStart);
  const startWorkerSource = supervisorSource.slice(startWorkerStart, startWorkerEnd);
  assert.match(startWorkerSource, /const processConfirmedAbsent =/);
  assert.match(startWorkerSource, /worker === child && processConfirmedAbsent/);
});

test('a strict handoff can fence a stale live Supervisor but no-handoff startup remains refused', () => {
  const start = supervisorSource.indexOf('async function acquireLock()');
  const end = supervisorSource.indexOf('\nfunction releaseLock()', start);
  const source = supervisorSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(source.indexOf('lockIsLive(observed)') < source.indexOf('readWorkerRecoveryHandoff(observed)'));
  assert.match(source, /recoveryHandoff = readWorkerRecoveryHandoff\(observed\)/);
  assert.match(source, /if \(!recoveryHandoff\)[\s\S]*refused dual startup without a verified Worker recovery handoff/);
  assert.match(source, /publish\(\);[\s\S]*await publishHeartbeat\(\)[\s\S]*waitForHandoffWorkerExit/);
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
