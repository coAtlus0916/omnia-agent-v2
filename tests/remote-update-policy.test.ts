import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { quarantineLegacyManagedStreamOrphans } from '../src/connector/managed-stream-host.ts';
import { REMOTE_CONNECTOR_SUPERVISOR_VERSION } from '../src/remote-connector/constants.ts';
import {
  assertPendingPackageIdentity,
  classifyManagedWorkerIdentity,
  defaultManagedState,
  readManagedState,
  type RemoteConnectorPaths
} from '../src/remote-connector/managed-state.ts';
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

test('online update checks enter the durable transaction state machine', () => {
  const start = supervisorSource.indexOf('async function checkForUpdate(');
  const end = supervisorSource.indexOf('\nfunction startAutomaticUpdateCheck(', start);
  const source = supervisorSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /readUpdateTransaction\(paths\)/);
  assert.match(source, /state = bindManagedPending\(transaction\)/);
  assert.match(source, /createUpdateTransaction\(/);
  assert.match(source, /await advanceOrRollback\(transaction\)/);
  assert.doesNotMatch(source, /activatePendingBeforeWorkerStart/);
});

test('one-shot checks exit before Worker startup and cold activation precedes the first Worker', () => {
  const start = supervisorSource.indexOf('async function main()');
  const end = supervisorSource.indexOf('\nfor (const signal', start);
  const source = supervisorSource.slice(start, end);
  const onceStart = source.indexOf('if (once) {');
  const onceEnd = source.indexOf("fs.rmSync(paths.stopRequest", onceStart);
  const onceSource = source.slice(onceStart, onceEnd);
  const activation = source.indexOf('await activatePendingBeforeWorkerStart(initialState)');
  const ordinaryStart = source.indexOf('if (!worker && !workerIdentity)');
  assert.ok(start >= 0 && end > start && onceStart >= 0 && onceEnd > onceStart);
  assert.match(onceSource, /await checkForUpdate\(\)/);
  assert.match(onceSource, /await shutdown\(false\)/);
  assert.doesNotMatch(onceSource, /startWorker\(\)/);
  assert.ok(activation >= 0 && ordinaryStart > activation);
});

test('cold Supervisor startup preserves legacy stream evidence before any Worker can start', () => {
  const start = supervisorSource.indexOf('async function main()');
  const end = supervisorSource.indexOf('\nfor (const signal', start);
  const source = supervisorSource.slice(start, end);
  const quarantine = source.indexOf('preserveLegacyManagedStreamEvidenceBeforeWorkerStart()');
  const activation = source.indexOf('await activatePendingBeforeWorkerStart(initialState)');
  const durableRecovery = source.indexOf('await advanceOrRollback(durableTransaction)');
  const ordinaryStart = source.indexOf('if (!worker && !workerIdentity)');
  assert.ok(start >= 0 && end > start && quarantine >= 0);
  assert.ok(quarantine < durableRecovery && quarantine < activation && quarantine < ordinaryStart);
  const preservationStart = supervisorSource.indexOf('function preserveLegacyManagedStreamEvidenceBeforeWorkerStart()');
  const preservationEnd = supervisorSource.indexOf('\nasync function checkForUpdate(', preservationStart);
  const preservationSource = supervisorSource.slice(preservationStart, preservationEnd);
  assert.match(preservationSource, /result\.failed > 0 \|\| result\.remainingOrphans\.length > 0/);
  assert.match(preservationSource, /throw new Error\(/);
});

test('quarantine failure injection leaves orphan evidence in place and the Supervisor gate fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-quarantine-failure-'));
  try {
    fs.writeFileSync(path.join(root, `stream_${'a'.repeat(32)}.bin`), 'first');
    fs.writeFileSync(path.join(root, `stream_${'b'.repeat(32)}.bin`), 'second');
    const result = quarantineLegacyManagedStreamOrphans(root, {
      maxQuarantineCount: 1,
      maxQuarantineBytes: 1024
    });
    assert.equal(result.failed, 1);
    assert.equal(result.remainingOrphans.length, 1);
    assert.equal(fs.existsSync(path.join(root, `${result.remainingOrphans[0]}.bin`)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probation crash points retain pending state and promotion is the first managed-state write', () => {
  const start = supervisorSource.indexOf('async function activatePendingBeforeWorkerStart(');
  const end = supervisorSource.indexOf('\nfunction preserveLegacyManagedStreamEvidenceBeforeWorkerStart()', start);
  const source = supervisorSource.slice(start, end);
  const packageIdentity = source.indexOf('verifyPendingCandidatePackage(pending)');
  const probe = source.indexOf('healthProbe(candidateRoot, pending.version, pending.sequence');
  const candidateStart = source.indexOf("startWorker(pending.version, baselineEpoch, '')");
  const probation = source.indexOf('await probation(pending.version, pending.sequence, candidate)');
  const promotion = source.indexOf('state = writeManagedState(paths');
  assert.ok(start >= 0 && end > start);
  assert.ok(packageIdentity >= 0 && packageIdentity < probe);
  assert.ok(probe < candidateStart && candidateStart < probation && probation < promotion);
  assert.doesNotMatch(source.slice(0, probation), /writeManagedState\(/,
    'a crash before or during probation must leave current/pending unchanged on disk');
  assert.match(source.slice(promotion), /current: pending\.version[\s\S]*pending: null/);
});

test('stale 0.3.34 identity is rejected before health or Worker execution', () => {
  const pending = { version: '0.3.34', sequence: 37, stagedAt: new Date(now).toISOString() };
  let candidateExecutionReached = false;
  assert.throws(() => {
    assertPendingPackageIdentity(pending, {
      schemaVersion: 'omnia.v5.remote-connector-identity/v1',
      product: 'omnia-agent-v5-remote-connector',
      version: '0.3.34',
      sequence: 37,
      supervisorVersion: '0.1.5'
    }, REMOTE_CONNECTOR_SUPERVISOR_VERSION);
    candidateExecutionReached = true;
  }, /requires Supervisor 0\.1\.7 package identity/);
  assert.equal(candidateExecutionReached, false);

  const verifyStart = supervisorSource.indexOf('function verifyPendingCandidatePackage(');
  const verifyEnd = supervisorSource.indexOf('\nfunction healthProbe(', verifyStart);
  const verifySource = supervisorSource.slice(verifyStart, verifyEnd);
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart);
  assert.match(verifySource, /manifest\.version !== pending\.version \|\| manifest\.sequence !== pending\.sequence/);
  assert.match(verifySource, /assertPendingPackageIdentity\(pending, identity, REMOTE_CONNECTOR_SUPERVISOR_VERSION\)/);

  const probeStart = supervisorSource.indexOf('function healthProbe(');
  const probeEnd = supervisorSource.indexOf('\nasync function probation(', probeStart);
  const probeSource = supervisorSource.slice(probeStart, probeEnd);
  assert.match(probeSource, /status\.version !== expectedVersion/);
  assert.match(probeSource, /status\.sequence !== expectedSequence/);
  assert.match(probeSource, /status\.supervisorVersion !== expectedSupervisorVersion/);
});

test('recovery handoff classifies pending/current exactly and never treats an unknown Worker as authoritative', () => {
  const state = {
    ...defaultManagedState(),
    current: '0.3.33',
    highestSequence: 36,
    pending: { version: '0.3.35', sequence: 38, stagedAt: new Date(now).toISOString() }
  };
  assert.equal(classifyManagedWorkerIdentity(state, { version: '0.3.35', sequence: 38 }, 36), 'pending');
  assert.equal(classifyManagedWorkerIdentity(state, { version: '0.3.33', sequence: 36 }, 36), 'current');
  assert.equal(classifyManagedWorkerIdentity(state, { version: '0.3.35', sequence: 37 }, 36), null);
  assert.equal(classifyManagedWorkerIdentity(state, { version: '0.3.34', sequence: 37 }, 36), null);
  assert.equal(classifyManagedWorkerIdentity(state, { version: '0.3.33', sequence: 35 }, 36), null);

  const acquireStart = supervisorSource.indexOf('async function acquireLock()');
  const acquireEnd = supervisorSource.indexOf('\nfunction releaseLock()', acquireStart);
  const acquireSource = supervisorSource.slice(acquireStart, acquireEnd);
  const identityGate = acquireSource.indexOf('identifyRecoveryHandoffWorker(recoveryHandoff)');
  const publish = acquireSource.indexOf('publish();');
  const waitForExit = acquireSource.indexOf('await waitForHandoffWorkerExit(observed, recoveryHandoff)');
  assert.ok(identityGate >= 0 && identityGate < publish && publish < waitForExit);
  assert.match(acquireSource.slice(identityGate, publish), /if \(!recoveryHandoffIdentity\)[\s\S]*return false/);
  assert.doesNotMatch(acquireSource, /worker\s*=\s*recoveryHandoff/);
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
  const startWorkerStart = supervisorSource.indexOf('function startWorker(');
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

test('managed state validates pending and blocked identities strictly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-managed-state-contract-'));
  const statePath = path.join(root, 'managed-state.json');
  const paths = { state: statePath } as RemoteConnectorPaths;
  const valid = {
    ...defaultManagedState(),
    current: '0.3.33',
    highestSequence: 36,
    pending: { version: '0.3.35', sequence: 38, stagedAt: new Date(now).toISOString() },
    blocked: {
      '0.3.34': { sequence: 37, reason: 'superseded', blockedAt: new Date(now).toISOString() }
    }
  };
  const write = (value: unknown) => fs.writeFileSync(statePath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    write(valid);
    assert.deepEqual(readManagedState(paths), valid);
    for (const invalid of [
      { ...valid, highestSequence: -1 },
      { ...valid, current: 33 },
      { ...valid, previous: 33 },
      { ...valid, pending: { ...valid.pending, version: '0.3' } },
      { ...valid, pending: { ...valid.pending, sequence: 36 } },
      { ...valid, pending: { ...valid.pending, stagedAt: 'not-a-date' } },
      { ...valid, pending: { ...valid.pending, stagedAt: 0 } },
      { ...valid, pending: { ...valid.pending, stagedAt: '2026-02-30T00:00:00.000Z' } },
      { ...valid, pending: { ...valid.pending, unexpected: true } },
      { ...valid, blocked: { invalid: valid.blocked['0.3.34'] } },
      { ...valid, blocked: { '0.3.34': { ...valid.blocked['0.3.34'], sequence: 0 } } },
      { ...valid, blocked: { '0.3.34': { ...valid.blocked['0.3.34'], reason: '' } } },
      { ...valid, blocked: { '0.3.34': { ...valid.blocked['0.3.34'], blockedAt: 'not-a-date' } } },
      { ...valid, blocked: { '0.3.34': { ...valid.blocked['0.3.34'], blockedAt: 0 } } },
      { ...valid, updatedAt: 0 },
      { ...valid, updatedAt: '2026-08-10T00:00:00Z' },
      { ...valid, blocked: { '0.3.34': { ...valid.blocked['0.3.34'], unexpected: true } } }
    ]) {
      write(invalid);
      assert.throws(() => readManagedState(paths), /managed state is invalid/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
