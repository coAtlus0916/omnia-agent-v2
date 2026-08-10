import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  canonicalConnectorResponse,
  connectorResultDigest,
  type ConnectorDeliveryAck
} from '../src/shared/connector-delivery.ts';
import { resolveRemoteConnectorPaths, writeManagedState } from '../src/remote-connector/managed-state.ts';
import {
  OperationActivityStore,
  casUpdateTransaction,
  completeUpdateTransactionAndArchiveBarrier,
  createUpdateTransaction,
  isCandidateRollbackBarrierOwner,
  readRollbackBarrier,
  readUpdateTransaction,
  recordCandidateRollbackBarrier,
  writeWorkerMaintenance,
  acknowledgeWorkerMaintenance
} from '../src/remote-connector/update-transaction.ts';
import {
  readBaselineAdmission,
  requiresSealedBaselineRestart,
  writeBaselineAdmission
} from '../src/remote-connector/baseline-admission.ts';
import { processBirthMatch, processIsAlive } from '../src/remote-connector/process-liveness.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-update-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveRemoteConnectorPaths({
    installRoot: path.join(root, 'install'),
    dataRoot: path.join(root, 'data'),
    startupEntry: path.join(root, 'startup.cmd')
  });
  return { root, paths };
}

test('update transaction revision CAS admits exactly one concurrent state transition', (t) => {
  const { paths } = fixture(t);
  writeManagedState(paths, {
    schemaVersion: 'omnia.v5.remote-connector-managed/v2', revision: 0, transitionId: '',
    current: '0.3.36', previous: '', highestSequence: 39, pending: null, blocked: {},
    updatedAt: new Date().toISOString()
  });
  const transaction = createUpdateTransaction(paths,
    { version: '0.3.36', sequence: 39, supervisorVersion: '0.1.7' },
    { version: '0.3.37', sequence: 40, supervisorVersion: '0.1.8' });
  const winner = casUpdateTransaction(paths, transaction.transactionId, transaction.revision,
    (current) => ({ ...current, phase: 'maintenance_requested' }));
  assert.equal(winner.revision, transaction.revision + 1);
  assert.throws(() => casUpdateTransaction(paths, transaction.transactionId, transaction.revision,
    (current) => ({ ...current, phase: 'worker_a_quiesced' })), /CAS failed/);
  assert.equal(readUpdateTransaction(paths)?.phase, 'maintenance_requested');
});

test('permission-denied process probes remain live/unknown and fail closed', () => {
  for (const code of ['EPERM', 'EACCES']) {
    assert.equal(processIsAlive(123, () => { throw Object.assign(new Error(code), { code }); }), true);
  }
  assert.equal(processIsAlive(123, () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); }), false);
  assert.equal(processIsAlive(0, () => undefined), false);
  if (process.platform === 'win32') {
    const recordedAt = '2026-08-10T00:00:01.000Z';
    assert.equal(processBirthMatch(123, recordedAt, 0, {
      isAlive: () => true, readStartTime: () => null
    }), 'unknown', 'birth query denial must remain unknown, never reusable/dead');
    assert.equal(processBirthMatch(123, recordedAt, 0, {
      isAlive: () => true, readStartTime: () => '2026-08-10T00:00:02.000Z'
    }), 'mismatch');
    assert.equal(processBirthMatch(123, recordedAt, 0, {
      isAlive: () => true, readStartTime: () => '2026-08-10T00:00:00.999Z'
    }), 'match');
  }
});

test('rollback barrier ownership is limited to the exact candidate and rollback-capable phase', (t) => {
  const { paths } = fixture(t);
  writeManagedState(paths, {
    schemaVersion: 'omnia.v5.remote-connector-managed/v2', revision: 0, transitionId: '',
    current: '0.3.36', previous: '', highestSequence: 39, pending: null, blocked: {},
    updatedAt: new Date().toISOString()
  });
  const base = createUpdateTransaction(paths,
    { version: '0.3.36', sequence: 39, supervisorVersion: '0.1.7' },
    { version: '0.3.37', sequence: 40, supervisorVersion: '0.1.8' });
  const workerA = {
    pid: 1001, token: 'a'.repeat(48), version: '0.3.36', sequence: 39,
    startedAt: new Date().toISOString(), statusPath: path.join(paths.workerStatuses, `${'a'.repeat(48)}.json`)
  };
  const workerB = {
    pid: 1002, token: 'b'.repeat(48), version: '0.3.37', sequence: 40,
    startedAt: new Date().toISOString(), statusPath: path.join(paths.workerStatuses, `${'b'.repeat(48)}.json`)
  };
  const identity = {
    transactionId: base.transactionId, epoch: base.maintenanceEpoch,
    executionGeneration: workerB.token, version: workerB.version, sequence: workerB.sequence
  };
  const promoted = { ...base, phase: 'promoted' as const, workerA, workerB };
  assert.equal(isCandidateRollbackBarrierOwner(promoted, identity), true);
  assert.equal(isCandidateRollbackBarrierOwner({ ...promoted, phase: 'terminalizing' }, identity), false,
    'terminalizing is the irreversible roll-forward boundary');
  assert.equal(isCandidateRollbackBarrierOwner({ ...promoted, phase: 'completed' }, identity), false,
    'completed B must not recreate an archived old barrier on its first business call');
  assert.equal(isCandidateRollbackBarrierOwner(promoted, {
    ...identity, executionGeneration: workerA.token, version: workerA.version, sequence: workerA.sequence
  }), false, 'rollback replacement A must never write the candidate barrier');
});

test('terminal completion recovers after barrier archive and before transaction write', (t) => {
  const { paths } = fixture(t);
  writeManagedState(paths, {
    schemaVersion: 'omnia.v5.remote-connector-managed/v2', revision: 0, transitionId: '',
    current: '0.3.36', previous: '', highestSequence: 39, pending: null, blocked: {},
    updatedAt: new Date().toISOString()
  });
  let transaction = createUpdateTransaction(paths,
    { version: '0.3.36', sequence: 39, supervisorVersion: '0.1.7' },
    { version: '0.3.37', sequence: 40, supervisorVersion: '0.1.8' });
  const workerA = {
    pid: 2001, token: 'c'.repeat(48), version: '0.3.36', sequence: 39,
    startedAt: new Date().toISOString(), statusPath: path.join(paths.workerStatuses, `${'c'.repeat(48)}.json`)
  };
  const workerB = {
    pid: 2002, token: 'd'.repeat(48), version: '0.3.37', sequence: 40,
    startedAt: new Date().toISOString(), statusPath: path.join(paths.workerStatuses, `${'d'.repeat(48)}.json`)
  };
  transaction = casUpdateTransaction(paths, transaction.transactionId, transaction.revision,
    (current) => ({ ...current, phase: 'promoted', workerA, workerB }));
  const barrier = {
    schemaVersion: 'omnia.v5.connector-rollback-barrier/v1' as const,
    transactionId: transaction.transactionId,
    epoch: transaction.maintenanceEpoch,
    executionGeneration: workerB.token,
    requestId: 'business-before-terminal',
    recordedAt: new Date().toISOString()
  };
  assert.ok(recordCandidateRollbackBarrier(paths, barrier,
    { version: workerB.version, sequence: workerB.sequence }));
  transaction = casUpdateTransaction(paths, transaction.transactionId, transaction.revision,
    (current) => ({ ...current, phase: 'terminalizing' }));
  assert.throws(() => completeUpdateTransactionAndArchiveBarrier(
    paths, transaction.transactionId, transaction.revision,
    { afterBarrierArchive: () => { throw new Error('crash-after-archive'); } }
  ), /crash-after-archive/);
  assert.equal(readUpdateTransaction(paths)?.phase, 'terminalizing');
  assert.equal(readRollbackBarrier(paths), null);
  assert.equal(recordCandidateRollbackBarrier(paths, {
    ...barrier, requestId: 'business-after-terminal'
  }, { version: workerB.version, sequence: workerB.sequence }), null,
  'terminalizing B may proceed but cannot recreate an archived rollback barrier');
  const completed = completeUpdateTransactionAndArchiveBarrier(
    paths, transaction.transactionId, transaction.revision
  );
  assert.equal(completed.phase, 'completed');
  assert.equal(readRollbackBarrier(paths), null);
});

test('maintenance acknowledgement is idempotent for the same exact Worker state', (t) => {
  const { paths } = fixture(t);
  const transactionId = 'a'.repeat(48);
  const epoch = 'b'.repeat(48);
  const token = 'c'.repeat(48);
  const owner = 'd'.repeat(48);
  const requested = writeWorkerMaintenance(paths, {
    schemaVersion: 'omnia.v5.connector-worker-maintenance/v2', revision: 0, transactionId, epoch,
    ownerGuardianToken: owner, target: { pid: process.pid, token, version: '0.3.36', sequence: 39 },
    action: 'quiesce', requestedAt: new Date().toISOString(), acknowledgement: null
  });
  const acknowledgement = {
    pid: process.pid, executionGeneration: token, admissionClosed: true, admissionSealed: true,
    state: 'quiesced' as const, acknowledgedAt: new Date().toISOString()
  };
  const first = acknowledgeWorkerMaintenance(paths, requested.revision, transactionId, epoch, token, acknowledgement);
  const repeated = acknowledgeWorkerMaintenance(paths, first.revision, transactionId, epoch, token,
    { ...acknowledgement, acknowledgedAt: new Date(Date.now() + 1_000).toISOString() });
  assert.equal(repeated.revision, first.revision);
  assert.equal(repeated.acknowledgement?.acknowledgedAt, first.acknowledgement?.acknowledgedAt);
});

test('delivery ledger reports exact not_found and removes ordinary read after receipt ack', (t) => {
  const { paths } = fixture(t);
  const store = new OperationActivityStore(paths);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const identity = {
    featureId: 'omnia.test-feature', featureVersion: '1.0.0', operationId: 'omnia.test.read.v1',
    operationPackageDigest: `sha256:${'1'.repeat(64)}`, runId: 'run-1', commandId: 'command-1',
    connectorId: 'connector-1', sessionGeneration: 7
  };
  assert.equal(store.deliveryStatus({
    schemaVersion: 'omnia.connector-delivery-status-request/v1', requestId, ...identity
  }).state, 'not_found');
  const executionGeneration = '2'.repeat(48);
  store.begin(requestId, {
    schemaVersion: 'omnia.operation-invocation/v1',
    featureId: identity.featureId, featureVersion: identity.featureVersion,
    operationId: identity.operationId, operationPackageDigest: identity.operationPackageDigest,
    request: {}, mutationAuthorized: false,
    deliveryContext: {
      schemaVersion: 'omnia.connector-delivery-context/v1', requestId, ...identity, purpose: 'readback'
    }
  }, executionGeneration);
  const response = { schemaVersion: 'omnia.connector-ipc/v1' as const, id: requestId, ok: true, value: { found: false } };
  const resultDigest = connectorResultDigest(response);
  store.finish(requestId, resultDigest, '', canonicalConnectorResponse(response));
  const ack: ConnectorDeliveryAck = {
    schemaVersion: 'omnia.connector-delivery-ack/v1', ackId: '22222222-2222-4222-8222-222222222222',
    deliveredRequestId: requestId, resultDigest, connectorId: identity.connectorId,
    sessionGeneration: identity.sessionGeneration, executionGeneration,
    featureId: identity.featureId, featureVersion: identity.featureVersion,
    operationId: identity.operationId, operationPackageDigest: identity.operationPackageDigest,
    runId: identity.runId, commandId: identity.commandId,
    receiptId: '33333333-3333-4333-8333-333333333333', receiptResponseDigest: '3'.repeat(64),
    resolution: 'receipt_committed', effectOutcome: null, reconciles: null
  };
  assert.deepEqual(store.acknowledge(ack), { acknowledged: true, clearedMutationCount: 0 });
  assert.equal(store.deliveryStatus({
    schemaVersion: 'omnia.connector-delivery-status-request/v1', requestId, ...identity
  }).state, 'not_found');
});

test('every mutation error remains effect_uncertain until exact reconcile', (t) => {
  const { paths } = fixture(t);
  const store = new OperationActivityStore(paths);
  const requestId = '44444444-4444-4444-8444-444444444444';
  const identity = {
    featureId: 'omnia.test-feature', featureVersion: '1.0.0', operationId: 'omnia.test.write.v1',
    operationPackageDigest: `sha256:${'4'.repeat(64)}`, runId: 'run-2', commandId: 'command-2',
    connectorId: 'connector-2', sessionGeneration: 8
  };
  const executionGeneration = '5'.repeat(48);
  store.begin(requestId, {
    schemaVersion: 'omnia.operation-invocation/v1', featureId: identity.featureId,
    featureVersion: identity.featureVersion, operationId: identity.operationId,
    operationPackageDigest: identity.operationPackageDigest, request: {}, mutationAuthorized: true,
    deliveryContext: {
      schemaVersion: 'omnia.connector-delivery-context/v1', requestId, ...identity, purpose: 'mutation'
    }
  }, executionGeneration);
  const response = {
    schemaVersion: 'omnia.connector-ipc/v1' as const, id: requestId, ok: false,
    error: { code: 'CONNECTOR.AUTH_REQUIRED', message: 'denied', retryable: false }
  };
  store.finish(requestId, connectorResultDigest(response), response.error.code, canonicalConnectorResponse(response));
  assert.equal(store.deliveryStatus({
    schemaVersion: 'omnia.connector-delivery-status-request/v1', requestId, ...identity
  }).state, 'effect_uncertain');
  assert.deepEqual(store.counts(), { active: 0, uncertain: 1 });
});

test('cold baseline journal keeps every promoted-but-unadmitted restart sealed under a fresh generation', (t) => {
  const { paths } = fixture(t);
  writeManagedState(paths, {
    schemaVersion: 'omnia.v5.remote-connector-managed/v2', revision: 0, transitionId: '',
    current: '0.3.36', previous: '0.3.35', highestSequence: 39, pending: null, blocked: {},
    updatedAt: new Date().toISOString()
  });
  const firstEpoch = '6'.repeat(48);
  const firstGeneration = '7'.repeat(48);
  writeBaselineAdmission(paths, {
    phase: 'prepared', version: '0.3.36', sequence: 39,
    epoch: firstEpoch, executionGeneration: firstGeneration, admittedAt: ''
  });
  assert.equal(requiresSealedBaselineRestart(readBaselineAdmission(paths), '0.3.36'), true);

  // Models Supervisor recovery after a crash between managed-state promotion
  // and Core protocol admission: a new Worker gets a new fenced identity.
  const restartedEpoch = '8'.repeat(48);
  const restartedGeneration = '9'.repeat(48);
  writeBaselineAdmission(paths, {
    phase: 'promoted', version: '0.3.36', sequence: 39,
    epoch: restartedEpoch, executionGeneration: restartedGeneration, admittedAt: ''
  });
  const restarted = readBaselineAdmission(paths)!;
  assert.equal(requiresSealedBaselineRestart(restarted, '0.3.36'), true);
  assert.equal(restarted.epoch, restartedEpoch);
  assert.equal(restarted.executionGeneration, restartedGeneration);
  assert.notEqual(restarted.executionGeneration, firstGeneration);

  writeBaselineAdmission(paths, {
    phase: 'admitted', version: restarted.version, sequence: restarted.sequence,
    epoch: restarted.epoch, executionGeneration: restarted.executionGeneration,
    admittedAt: new Date().toISOString()
  });
  assert.equal(requiresSealedBaselineRestart(readBaselineAdmission(paths), '0.3.36'), false);
  fs.writeFileSync(paths.baselineAdmission, '{"schemaVersion":"corrupt"}');
  assert.throws(() => readBaselineAdmission(paths), /fail-closed/);
});

test('Guardian-managed owner loss has no direct Supervisor spawn and cold baseline stays sealed until protocol admission', () => {
  const worker = fs.readFileSync(new URL('../src/remote-connector/worker.ts', import.meta.url), 'utf8');
  const guardianBranch = worker.slice(
    worker.indexOf('async function recoverGuardianManagedSupervisorAfterOwnerLoss'),
    worker.indexOf("const timer = setInterval", worker.indexOf('async function recoverGuardianManagedSupervisorAfterOwnerLoss'))
  );
  assert.match(guardianBranch, /beginMaintenance/);
  assert.match(guardianBranch, /sealMaintenance/);
  assert.match(guardianBranch, /releaseWorkerClaim/);
  assert.match(guardianBranch, /workerRecoveryHandoff/);
  assert.doesNotMatch(guardianBranch, /spawn\(/);
  const supervisor = fs.readFileSync(new URL('../src/remote-connector/supervisor.ts', import.meta.url), 'utf8');
  const cold = supervisor.slice(supervisor.indexOf('async function activatePendingBeforeWorkerStart'),
    supervisor.indexOf('function preserveLegacyManagedStreamEvidenceBeforeWorkerStart'));
  assert.match(cold, /startWorker\(pending\.version, baselineEpoch, ''\)/);
  assert.match(cold, /writeBaselineAdmission/);
  assert.doesNotMatch(cold, /endMaintenance/);
  const cli = fs.readFileSync(new URL('../src/remote-connector/cli.ts', import.meta.url), 'utf8');
  const installBody = cli.slice(cli.indexOf('function install(): void'));
  const freshInstall = installBody.slice(installBody.indexOf('if (!state.current) {'), installBody.indexOf('} else if (promotesNewVersion)'));
  assert.ok(freshInstall.indexOf('writeBaselineAdmission') >= 0);
  assert.ok(freshInstall.indexOf('writeBaselineAdmission') < freshInstall.indexOf('writeManagedState'));
});
