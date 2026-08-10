import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OperationInvocationRequest } from '../shared/operation-contracts.js';
import {
  canonicalConnectorResponse,
  connectorResultDigest,
  assertConnectorDeliveryAck,
  assertConnectorDeliveryContext,
  assertConnectorDeliveryStatusRequest,
  type ConnectorDeliveryAck,
  type ConnectorDeliveryStatusRequest,
  type ConnectorDeliveryStatusResult
} from '../shared/connector-delivery.js';
import {
  type RemoteConnectorPaths,
  readManagedState,
  withRemoteConnectorMutex,
  writeJsonAtomic
} from './managed-state.js';

export type ConnectorUpdatePhase =
  | 'staged'
  | 'maintenance_requested'
  | 'worker_a_quiesced'
  | 'supervisor_switch_requested'
  | 'supervisor_acknowledged'
  | 'worker_b_probation'
  | 'promotion_prepared'
  | 'promoted'
  | 'terminalizing'
  | 'completed'
  | 'rollback_requested'
  | 'rolled_back';

export interface ConnectorReleaseIdentity {
  version: string;
  sequence: number;
  supervisorVersion: string;
}

export interface ConnectorUpdateTransaction {
  schemaVersion: 'omnia.v5.connector-update-transaction/v1';
  transactionId: string;
  revision: number;
  phase: ConnectorUpdatePhase;
  current: ConnectorReleaseIdentity;
  candidate: ConnectorReleaseIdentity;
  maintenanceEpoch: string;
  /** Stable transaction authority shared by Supervisor A/B and Guardian restarts. */
  maintenanceAuthorityToken: string;
  managedRevisionAtStage: number;
  workerA: WorkerProcessIdentity | null;
  workerB: WorkerProcessIdentity | null;
  previousSupervisorSlot: 'a' | 'b' | null;
  candidateSupervisorSlot: 'a' | 'b' | null;
  error: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerProcessIdentity {
  pid: number;
  token: string;
  version: string;
  sequence: number;
  startedAt: string;
  statusPath: string;
}

interface TransactionEnvelope {
  schemaVersion: 'omnia.v5.connector-update-transaction-envelope/v1';
  transaction: ConnectorUpdateTransaction;
  checksum: string;
}

export interface WorkerMaintenanceRecord {
  schemaVersion: 'omnia.v5.connector-worker-maintenance/v2';
  revision: number;
  transactionId: string;
  epoch: string;
  ownerGuardianToken: string;
  target: { pid: number; token: string; version: string; sequence: number };
  action: 'quiesce' | 'resume' | 'retire';
  requestedAt: string;
  acknowledgement: null | {
    pid: number;
    executionGeneration: string;
    admissionClosed: boolean;
    admissionSealed: boolean;
    state: 'draining' | 'quiesced' | 'running' | 'retiring' | 'failed_closed';
    acknowledgedAt: string;
  };
}

export interface WorkerClaim {
  schemaVersion: 'omnia.v5.connector-worker-claim/v1';
  product: 'omnia-agent-v5-remote-connector';
  pid: number;
  executionGeneration: string;
  version: string;
  sequence: number;
  state: 'admitted' | 'quiescing';
  claimedAt: string;
  heartbeatAt: string;
}

export interface RollbackBarrier {
  schemaVersion: 'omnia.v5.connector-rollback-barrier/v1';
  transactionId: string;
  epoch: string;
  executionGeneration: string;
  requestId: string;
  recordedAt: string;
}

export function isCandidateRollbackBarrierOwner(
  transaction: ConnectorUpdateTransaction | null,
  identity: {
    transactionId: string;
    epoch: string;
    executionGeneration: string;
    version: string;
    sequence: number;
  }
): boolean {
  return Boolean(transaction
    && transaction.transactionId === identity.transactionId
    && transaction.maintenanceEpoch === identity.epoch
    && transaction.phase === 'promoted'
    && transaction.workerB?.token === identity.executionGeneration
    && transaction.workerB.version === identity.version
    && transaction.workerB.sequence === identity.sequence);
}

function assertRollbackBarrier(value: RollbackBarrier): void {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'transactionId', 'epoch', 'executionGeneration', 'requestId', 'recordedAt'
  ]) || value.schemaVersion !== 'omnia.v5.connector-rollback-barrier/v1'
    || !/^[a-f0-9]{48}$/u.test(value.transactionId) || !/^[a-f0-9]{48}$/u.test(value.epoch)
    || !/^[a-f0-9]{48}$/u.test(value.executionGeneration)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.requestId) || !isIso(value.recordedAt)) {
    throw new Error('Rollback barrier identity is invalid.');
  }
}

export function recordRollbackBarrier(paths: RemoteConnectorPaths, value: RollbackBarrier): RollbackBarrier {
  assertRollbackBarrier(value);
  return withRemoteConnectorMutex(`${paths.rollbackBarrier}.lock`, 10_000, () => {
    try {
      const existing = JSON.parse(fs.readFileSync(paths.rollbackBarrier, 'utf8')) as RollbackBarrier;
      if (checksum(existing) !== checksum(value)) {
        throw new Error('Another durable business admission already owns the rollback barrier.');
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    writeJsonAtomic(paths.rollbackBarrier, value);
    return value;
  });
}

function recordRollbackBarrierUnlocked(paths: RemoteConnectorPaths, value: RollbackBarrier): RollbackBarrier {
  try {
    const existing = JSON.parse(fs.readFileSync(paths.rollbackBarrier, 'utf8')) as RollbackBarrier;
    if (checksum(existing) !== checksum(value)) {
      throw new Error('Another durable business admission already owns the rollback barrier.');
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeJsonAtomic(paths.rollbackBarrier, value);
  return value;
}

/** Linearizes the first candidate business admission against transaction
 * completion. The authoritative transaction is re-read while holding the
 * same cross-process update mutex used by terminal completion. */
export function recordCandidateRollbackBarrier(
  paths: RemoteConnectorPaths,
  value: RollbackBarrier,
  candidate: { version: string; sequence: number }
): RollbackBarrier | null {
  assertRollbackBarrier(value);
  return withRemoteConnectorMutex(paths.updateMutex, 35_000, () => {
    const transaction = readUpdateTransaction(paths);
    if (isCandidateRollbackBarrierOwner(transaction, {
      transactionId: value.transactionId,
      epoch: value.epoch,
      executionGeneration: value.executionGeneration,
      version: candidate.version,
      sequence: candidate.sequence
    })) {
      return withRemoteConnectorMutex(`${paths.rollbackBarrier}.lock`, 10_000,
        () => recordRollbackBarrierUnlocked(paths, value));
    }
    const terminalCandidate = transaction?.transactionId === value.transactionId
      && transaction.maintenanceEpoch === value.epoch
      && ['terminalizing', 'completed'].includes(transaction.phase)
      && transaction.workerB?.token === value.executionGeneration
      && transaction.workerB.version === candidate.version
      && transaction.workerB.sequence === candidate.sequence;
    const terminalRollback = transaction?.transactionId === value.transactionId
      && transaction.maintenanceEpoch === value.epoch
      && transaction.phase === 'rolled_back'
      && transaction.workerA?.token === value.executionGeneration
      && transaction.workerA.version === candidate.version
      && transaction.workerA.sequence === candidate.sequence;
    if (terminalCandidate || terminalRollback) return null;
    throw new Error('Candidate business admission lost its exact rollback-capable transaction phase.');
  });
}

export function readRollbackBarrier(paths: RemoteConnectorPaths): RollbackBarrier | null {
  try {
    const value = JSON.parse(fs.readFileSync(paths.rollbackBarrier, 'utf8')) as RollbackBarrier;
    if (!record(value) || !exactKeys(value, [
      'schemaVersion', 'transactionId', 'epoch', 'executionGeneration', 'requestId', 'recordedAt'
    ]) || value.schemaVersion !== 'omnia.v5.connector-rollback-barrier/v1'
      || !/^[a-f0-9]{48}$/u.test(value.transactionId) || !/^[a-f0-9]{48}$/u.test(value.epoch)
      || !/^[a-f0-9]{48}$/u.test(value.executionGeneration)
      || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.requestId) || !isIso(value.recordedAt)) {
      throw new Error('invalid rollback barrier');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Rollback barrier is invalid; automatic rollback is fail-closed.');
  }
}

function archiveRollbackBarrierUnlocked(paths: RemoteConnectorPaths, transactionId: string): string | null {
  const current = readRollbackBarrier(paths);
  if (!current) return null;
  if (current.transactionId !== transactionId) {
    throw new Error('Another update transaction owns the durable rollback barrier.');
  }
  const archiveRoot = path.join(paths.dataRoot, 'rollback-barrier-history');
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const target = path.join(archiveRoot, `${transactionId}-${current.epoch}.json`);
  if (fs.existsSync(target)) {
    const archived = JSON.parse(fs.readFileSync(target, 'utf8')) as RollbackBarrier;
    if (checksum(archived) !== checksum(current)) throw new Error('Rollback barrier archive identity collision.');
    fs.rmSync(paths.rollbackBarrier, { force: true });
    return target;
  }
  fs.renameSync(paths.rollbackBarrier, target);
  return target;
}

export function archiveRollbackBarrier(paths: RemoteConnectorPaths, transactionId: string): string | null {
  return withRemoteConnectorMutex(`${paths.rollbackBarrier}.lock`, 10_000,
    () => archiveRollbackBarrierUnlocked(paths, transactionId));
}

/** Atomically closes rollback admission and archives any first-business
 * barrier under updateMutex -> barrierLock. A Worker can therefore observe
 * either a rollback-capable phase and publish before this transaction, or the
 * completed phase after it, but never publish into the archive/CAS gap. */
export function completeUpdateTransactionAndArchiveBarrier(
  paths: RemoteConnectorPaths,
  transactionId: string,
  expectedRevision: number,
  fault?: { afterBarrierArchive?: () => void }
): ConnectorUpdateTransaction {
  return withRemoteConnectorMutex(paths.updateMutex, 35_000, () => {
    const current = readUpdateTransaction(paths);
    if (!current || current.transactionId !== transactionId || current.revision !== expectedRevision
      || current.phase !== 'terminalizing') {
      throw Object.assign(new Error('Remote Connector terminal completion CAS failed.'), {
        code: 'CONNECTOR.UPDATE_CAS_MISMATCH'
      });
    }
    withRemoteConnectorMutex(`${paths.rollbackBarrier}.lock`, 10_000,
      () => archiveRollbackBarrierUnlocked(paths, transactionId));
    fault?.afterBarrierArchive?.();
    const next = validateUpdateTransaction({
      ...current,
      phase: 'completed',
      revision: current.revision + 1,
      updatedAt: new Date().toISOString()
    });
    writeTransaction(paths, next);
    return next;
  });
}

export interface OperationReceiptIdentity {
  featureId: string;
  featureVersion: string;
  operationId: string;
  operationPackageDigest: string;
  runId: string;
  commandId: string;
}

interface OperationActivityEntry extends OperationReceiptIdentity {
  requestId: string;
  connectorId: string;
  sessionGeneration: number;
  purpose: 'mutation' | 'readback' | 'reconcile' | 'recovery';
  executionGeneration: string;
  reconcileOf: {
    requestId: string;
    featureId: string;
    featureVersion: string;
    operationId: string;
    operationPackageDigest: string;
    connectorId: string;
    sessionGeneration: number;
    executionGeneration: string;
  } | null;
  mutation: boolean;
  state: 'running' | 'delivery_pending' | 'receipt_committed' | 'effect_uncertain';
  startedAt: string;
  updatedAt: string;
  errorCode: string;
  resultDigest: string;
  responseJson: string;
}

interface OperationActivityLedger {
  schemaVersion: 'omnia.v5.connector-operation-activity/v1';
  revision: number;
  entries: OperationActivityEntry[];
  completedAcks: Array<{
    ackId: string;
    ackDigest: string;
    clearedMutationCount: number;
    completedAt: string;
  }>;
  updatedAt: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function isIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function checksum(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function assertRelease(value: unknown, label: string): asserts value is ConnectorReleaseIdentity {
  if (!record(value) || !exactKeys(value, ['version', 'sequence', 'supervisorVersion'])
    || !/^\d+\.\d+\.\d+$/u.test(String(value.version || ''))
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0
    || !/^\d+\.\d+\.\d+$/u.test(String(value.supervisorVersion || ''))) {
    throw new Error(`${label} identity is invalid.`);
  }
}

function assertWorker(value: unknown, label: string): asserts value is WorkerProcessIdentity {
  if (!record(value) || !exactKeys(value, ['pid', 'token', 'version', 'sequence', 'startedAt', 'statusPath'])
    || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || typeof value.token !== 'string' || value.token.length < 24
    || !/^\d+\.\d+\.\d+$/u.test(String(value.version || ''))
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0
    || !isIso(value.startedAt) || typeof value.statusPath !== 'string' || !path.isAbsolute(value.statusPath)) {
    throw new Error(`${label} process identity is invalid.`);
  }
}

export function validateUpdateTransaction(value: unknown): ConnectorUpdateTransaction {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'transactionId', 'revision', 'phase', 'current', 'candidate', 'maintenanceEpoch',
    'maintenanceAuthorityToken',
    'managedRevisionAtStage',
    'workerA', 'workerB', 'previousSupervisorSlot', 'candidateSupervisorSlot', 'error', 'createdAt', 'updatedAt'
  ]) || value.schemaVersion !== 'omnia.v5.connector-update-transaction/v1'
    || typeof value.transactionId !== 'string' || !/^[a-f0-9]{48}$/u.test(value.transactionId)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !new Set<ConnectorUpdatePhase>([
      'staged', 'maintenance_requested', 'worker_a_quiesced', 'supervisor_switch_requested',
      'supervisor_acknowledged', 'worker_b_probation', 'promotion_prepared', 'promoted',
      'terminalizing', 'completed',
      'rollback_requested', 'rolled_back'
    ]).has(value.phase as ConnectorUpdatePhase)
    || typeof value.maintenanceEpoch !== 'string' || !/^[a-f0-9]{48}$/u.test(value.maintenanceEpoch)
    || typeof value.maintenanceAuthorityToken !== 'string' || !/^[a-f0-9]{48}$/u.test(value.maintenanceAuthorityToken)
    || !Number.isSafeInteger(value.managedRevisionAtStage) || Number(value.managedRevisionAtStage) < 0
    || ![null, 'a', 'b'].includes(value.previousSupervisorSlot as null | 'a' | 'b')
    || ![null, 'a', 'b'].includes(value.candidateSupervisorSlot as null | 'a' | 'b')
    || typeof value.error !== 'string' || value.error.length > 500
    || !isIso(value.createdAt) || !isIso(value.updatedAt)) {
    throw new Error('Remote Connector update transaction is invalid.');
  }
  assertRelease(value.current, 'Current release');
  assertRelease(value.candidate, 'Candidate release');
  if (Number(value.candidate.sequence) <= Number(value.current.sequence)) {
    throw new Error('Remote Connector candidate sequence must exceed the current sequence.');
  }
  if (value.workerA !== null) assertWorker(value.workerA, 'Worker A');
  if (value.workerB !== null) assertWorker(value.workerB, 'Worker B');
  return value as unknown as ConnectorUpdateTransaction;
}

export function readUpdateTransaction(paths: RemoteConnectorPaths): ConnectorUpdateTransaction | null {
  try {
    const envelope = JSON.parse(fs.readFileSync(paths.updateTransaction, 'utf8')) as TransactionEnvelope;
    if (!record(envelope)
      || !exactKeys(envelope, ['schemaVersion', 'transaction', 'checksum'])
      || envelope.schemaVersion !== 'omnia.v5.connector-update-transaction-envelope/v1'
      || !/^[a-f0-9]{64}$/u.test(String(envelope.checksum || ''))
      || envelope.checksum !== checksum(envelope.transaction)) {
      throw new Error('invalid envelope');
    }
    const transaction = validateUpdateTransaction(envelope.transaction);
    for (const worker of [transaction.workerA, transaction.workerB]) {
      if (worker && path.resolve(worker.statusPath) !== path.resolve(
        path.join(paths.workerStatuses, `${worker.token}.json`)
      )) throw new Error('worker status path escaped its exact execution generation');
    }
    return transaction;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Remote Connector update transaction is corrupt; automatic update is fail-closed.');
  }
}

function writeTransaction(paths: RemoteConnectorPaths, transaction: ConnectorUpdateTransaction): void {
  const envelope: TransactionEnvelope = {
    schemaVersion: 'omnia.v5.connector-update-transaction-envelope/v1',
    transaction,
    checksum: checksum(transaction)
  };
  writeJsonAtomic(paths.updateTransaction, envelope);
}

function assertWorkerStatusPaths(paths: RemoteConnectorPaths, transaction: ConnectorUpdateTransaction): void {
  for (const worker of [transaction.workerA, transaction.workerB]) {
    if (worker && path.resolve(worker.statusPath) !== path.resolve(
      path.join(paths.workerStatuses, `${worker.token}.json`)
    )) throw new Error('Worker status path escaped its exact execution generation.');
  }
}

export function createUpdateTransaction(
  paths: RemoteConnectorPaths,
  current: ConnectorReleaseIdentity,
  candidate: ConnectorReleaseIdentity
): ConnectorUpdateTransaction {
  return withRemoteConnectorMutex(paths.updateMutex, 35_000, () => {
    const existing = readUpdateTransaction(paths);
    if (existing) {
      if (existing.candidate.version === candidate.version && existing.candidate.sequence === candidate.sequence) return existing;
      if (!['completed', 'rolled_back'].includes(existing.phase)) {
        throw new Error('Another Remote Connector update transaction is still active.');
      }
    }
    const now = new Date().toISOString();
    const managedRevisionAtStage = readManagedState(paths).revision;
    const transaction: ConnectorUpdateTransaction = {
      schemaVersion: 'omnia.v5.connector-update-transaction/v1',
      transactionId: crypto.randomBytes(24).toString('hex'),
      revision: 0,
      phase: 'staged',
      current,
      candidate,
      maintenanceEpoch: crypto.randomBytes(24).toString('hex'),
      maintenanceAuthorityToken: crypto.randomBytes(24).toString('hex'),
      managedRevisionAtStage,
      workerA: null,
      workerB: null,
      previousSupervisorSlot: null,
      candidateSupervisorSlot: null,
      error: '',
      createdAt: now,
      updatedAt: now
    };
    writeTransaction(paths, transaction);
    return transaction;
  });
}

export function casUpdateTransaction(
  paths: RemoteConnectorPaths,
  transactionId: string,
  expectedRevision: number,
  update: (current: ConnectorUpdateTransaction) => Omit<ConnectorUpdateTransaction, 'revision' | 'updatedAt'>
): ConnectorUpdateTransaction {
  return withRemoteConnectorMutex(paths.updateMutex, 35_000, () => {
    const current = readUpdateTransaction(paths);
    if (!current || current.transactionId !== transactionId || current.revision !== expectedRevision) {
      throw Object.assign(new Error('Remote Connector update transaction CAS failed.'), {
        code: 'CONNECTOR.UPDATE_CAS_MISMATCH'
      });
    }
    const candidate = update(structuredClone(current));
    const next = validateUpdateTransaction({
      ...candidate,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString()
    });
    assertWorkerStatusPaths(paths, next);
    if (next.transactionId !== current.transactionId || next.createdAt !== current.createdAt
      || next.current.sequence !== current.current.sequence || next.candidate.sequence !== current.candidate.sequence
      || next.maintenanceEpoch !== current.maintenanceEpoch
      || next.maintenanceAuthorityToken !== current.maintenanceAuthorityToken
      || next.managedRevisionAtStage !== current.managedRevisionAtStage) {
      throw new Error('Remote Connector update CAS attempted to rewrite immutable transaction identity.');
    }
    writeTransaction(paths, next);
    return next;
  });
}

function validateWorkerMaintenance(value: unknown): WorkerMaintenanceRecord {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'revision', 'transactionId', 'epoch', 'ownerGuardianToken', 'target',
    'action', 'requestedAt', 'acknowledgement'
  ]) || value.schemaVersion !== 'omnia.v5.connector-worker-maintenance/v2'
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !/^[a-f0-9]{48}$/u.test(String(value.transactionId || ''))
    || !/^[a-f0-9]{48}$/u.test(String(value.epoch || ''))
    || typeof value.ownerGuardianToken !== 'string' || value.ownerGuardianToken.length < 24
    || !record(value.target)
    || !exactKeys(value.target, ['pid', 'token', 'version', 'sequence'])
    || !Number.isSafeInteger(value.target.pid) || Number(value.target.pid) <= 0
    || typeof value.target.token !== 'string' || value.target.token.length < 24
    || !/^\d+\.\d+\.\d+$/u.test(String(value.target.version || ''))
    || !Number.isSafeInteger(value.target.sequence) || Number(value.target.sequence) <= 0
    || !['quiesce', 'resume', 'retire'].includes(String(value.action))
    || !isIso(value.requestedAt)
    || (value.acknowledgement !== null && (!record(value.acknowledgement)
      || !exactKeys(value.acknowledgement, [
        'pid', 'executionGeneration', 'admissionClosed', 'admissionSealed', 'state', 'acknowledgedAt'
      ])
      || !Number.isSafeInteger(value.acknowledgement.pid) || Number(value.acknowledgement.pid) <= 0
      || typeof value.acknowledgement.executionGeneration !== 'string'
      || !/^[a-f0-9]{48}$/u.test(value.acknowledgement.executionGeneration)
      || typeof value.acknowledgement.admissionClosed !== 'boolean'
      || typeof value.acknowledgement.admissionSealed !== 'boolean'
      || !['draining', 'quiesced', 'running', 'retiring', 'failed_closed'].includes(String(value.acknowledgement.state))
      || !isIso(value.acknowledgement.acknowledgedAt)))) {
    throw new Error('Worker maintenance record is invalid.');
  }
  return value as unknown as WorkerMaintenanceRecord;
}

export function writeWorkerMaintenance(paths: RemoteConnectorPaths, value: WorkerMaintenanceRecord): WorkerMaintenanceRecord {
  return withRemoteConnectorMutex(`${paths.workerMaintenance}.lock`, 10_000, () => {
    const current = readWorkerMaintenance(paths);
    const expectedRevision = current?.revision ?? 0;
    if (value.revision !== expectedRevision) throw Object.assign(new Error('Worker maintenance CAS failed.'), {
      code: 'CONNECTOR.UPDATE_CAS_MISMATCH'
    });
    if (current && (current.transactionId !== value.transactionId || current.ownerGuardianToken !== value.ownerGuardianToken)) {
      throw new Error('Another Supervisor transaction owns Worker maintenance.');
    }
    const next = validateWorkerMaintenance({ ...value, revision: expectedRevision + 1 });
    writeJsonAtomic(paths.workerMaintenance, next);
    return next;
  });
}

export function readWorkerMaintenance(paths: RemoteConnectorPaths): WorkerMaintenanceRecord | null {
  try {
    return validateWorkerMaintenance(JSON.parse(fs.readFileSync(paths.workerMaintenance, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Worker maintenance record is invalid; command admission is fail-closed.');
  }
}

export function acknowledgeWorkerMaintenance(
  paths: RemoteConnectorPaths,
  expectedRevision: number,
  transactionId: string,
  epoch: string,
  executionGeneration: string,
  acknowledgement: NonNullable<WorkerMaintenanceRecord['acknowledgement']>
): WorkerMaintenanceRecord {
  return withRemoteConnectorMutex(`${paths.workerMaintenance}.lock`, 10_000, () => {
    const current = readWorkerMaintenance(paths);
    if (!current || current.transactionId !== transactionId
      || current.epoch !== epoch || current.target.token !== executionGeneration) {
      throw Object.assign(new Error('Worker maintenance acknowledgement CAS failed.'), {
        code: 'CONNECTOR.UPDATE_CAS_MISMATCH'
      });
    }
    const existing = current.acknowledgement;
    if (existing && existing.pid === acknowledgement.pid
      && existing.executionGeneration === acknowledgement.executionGeneration
      && existing.admissionClosed === acknowledgement.admissionClosed
      && existing.admissionSealed === acknowledgement.admissionSealed
      && existing.state === acknowledgement.state) return current;
    if (current.revision !== expectedRevision) throw Object.assign(new Error('Worker maintenance acknowledgement CAS failed.'), {
      code: 'CONNECTOR.UPDATE_CAS_MISMATCH'
    });
    const next = validateWorkerMaintenance({
      ...current,
      revision: current.revision + 1,
      acknowledgement
    });
    writeJsonAtomic(paths.workerMaintenance, next);
    return next;
  });
}

export function archiveWorkerMaintenance(
  paths: RemoteConnectorPaths,
  transactionId: string,
  ownerGuardianToken: string,
  expectedRevision: number
): string {
  return withRemoteConnectorMutex(`${paths.workerMaintenance}.lock`, 10_000, () => {
    const current = readWorkerMaintenance(paths);
    if (!current || current.transactionId !== transactionId || current.ownerGuardianToken !== ownerGuardianToken
      || current.revision !== expectedRevision) throw Object.assign(new Error('Worker maintenance archive CAS failed.'), {
      code: 'CONNECTOR.UPDATE_CAS_MISMATCH'
    });
    const archiveRoot = path.join(paths.dataRoot, 'worker-maintenance-history');
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    const target = path.join(archiveRoot, `${transactionId}-${expectedRevision}.json`);
    if (fs.existsSync(target)) {
      const archived = validateWorkerMaintenance(JSON.parse(fs.readFileSync(target, 'utf8')));
      if (archived.transactionId !== transactionId || archived.revision !== expectedRevision) {
        throw new Error('Worker maintenance archive identity collision.');
      }
      fs.rmSync(paths.workerMaintenance, { force: true });
      return target;
    }
    fs.renameSync(paths.workerMaintenance, target);
    return target;
  });
}

function validateWorkerClaim(value: unknown): WorkerClaim {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'product', 'pid', 'executionGeneration', 'version', 'sequence',
    'state', 'claimedAt', 'heartbeatAt'
  ]) || value.schemaVersion !== 'omnia.v5.connector-worker-claim/v1'
    || value.product !== 'omnia-agent-v5-remote-connector'
    || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || typeof value.executionGeneration !== 'string' || !/^[a-f0-9]{48}$/u.test(value.executionGeneration)
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.version)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0
    || !['admitted', 'quiescing'].includes(String(value.state))
    || !isIso(value.claimedAt) || !isIso(value.heartbeatAt)) {
    throw new Error('Worker global claim is invalid.');
  }
  return value as unknown as WorkerClaim;
}

export function readWorkerClaim(paths: RemoteConnectorPaths): WorkerClaim | null {
  try { return validateWorkerClaim(JSON.parse(fs.readFileSync(paths.workerClaim, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Worker global claim is corrupt; Bridge command admission is fail-closed.');
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return pid > 0; }
  catch (error) { return ['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code || '')); }
}

export function acquireWorkerClaim(
  paths: RemoteConnectorPaths,
  identity: Pick<WorkerClaim, 'executionGeneration' | 'version' | 'sequence'>
): WorkerClaim {
  return withRemoteConnectorMutex(`${paths.workerClaim}.lock`, 10_000, () => {
    const existing = readWorkerClaim(paths);
    if (existing) {
      if (existing.pid === process.pid && existing.executionGeneration === identity.executionGeneration) return existing;
      if (processAlive(existing.pid)) throw Object.assign(new Error('Another live Worker owns the global Bridge claim.'), {
        code: 'REMOTE.WORKER_CLAIMED'
      });
      const stale = `${paths.workerClaim}.stale-${existing.executionGeneration}`;
      fs.renameSync(paths.workerClaim, stale);
      fs.rmSync(stale, { force: true });
    }
    const now = new Date().toISOString();
    const claim = validateWorkerClaim({
      schemaVersion: 'omnia.v5.connector-worker-claim/v1',
      product: 'omnia-agent-v5-remote-connector',
      pid: process.pid,
      executionGeneration: identity.executionGeneration,
      version: identity.version,
      sequence: identity.sequence,
      state: 'admitted',
      claimedAt: now,
      heartbeatAt: now
    });
    writeJsonAtomic(paths.workerClaim, claim);
    return claim;
  });
}

export function updateWorkerClaim(
  paths: RemoteConnectorPaths,
  executionGeneration: string,
  state: WorkerClaim['state']
): WorkerClaim {
  return withRemoteConnectorMutex(`${paths.workerClaim}.lock`, 10_000, () => {
    const existing = readWorkerClaim(paths);
    if (!existing || existing.pid !== process.pid || existing.executionGeneration !== executionGeneration) {
      throw new Error('Worker lost its global Bridge claim.');
    }
    const next = validateWorkerClaim({ ...existing, state, heartbeatAt: new Date().toISOString() });
    writeJsonAtomic(paths.workerClaim, next);
    return next;
  });
}

export function releaseWorkerClaim(paths: RemoteConnectorPaths, executionGeneration: string): void {
  withRemoteConnectorMutex(`${paths.workerClaim}.lock`, 10_000, () => {
    const existing = readWorkerClaim(paths);
    if (!existing) return;
    if (existing.pid !== process.pid || existing.executionGeneration !== executionGeneration) {
      throw new Error('Worker cannot release another execution generation claim.');
    }
    fs.rmSync(paths.workerClaim, { force: true });
  });
}

function emptyActivity(): OperationActivityLedger {
  return {
    schemaVersion: 'omnia.v5.connector-operation-activity/v1',
    revision: 0,
    entries: [],
    completedAcks: [],
    updatedAt: new Date().toISOString()
  };
}

function receiptIdentity(request: OperationInvocationRequest): OperationReceiptIdentity | null {
  const context = request.deliveryContext;
  if (!context) return null;
  assertConnectorDeliveryContext(context);
  if (context.featureId !== request.featureId || context.featureVersion !== request.featureVersion
    || context.operationId !== request.operationId
    || context.operationPackageDigest !== request.operationPackageDigest) {
    throw new Error('Connector delivery identity differs from the signed Operation invocation.');
  }
  return {
    featureId: request.featureId,
    featureVersion: request.featureVersion,
    operationId: request.operationId,
    operationPackageDigest: request.operationPackageDigest,
    runId: context.runId,
    commandId: context.commandId
  };
}

function validateActivity(value: unknown): OperationActivityLedger {
  if (!record(value) || value.schemaVersion !== 'omnia.v5.connector-operation-activity/v1'
    || !exactKeys(value, ['schemaVersion', 'revision', 'entries', 'completedAcks', 'updatedAt'])
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !Array.isArray(value.entries)
    || !Array.isArray(value.completedAcks) || !isIso(value.updatedAt)) {
    throw new Error('Operation activity ledger is invalid.');
  }
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry) || !exactKeys(entry, [
      'requestId', 'featureId', 'featureVersion', 'operationId', 'operationPackageDigest',
      'runId', 'commandId', 'connectorId', 'sessionGeneration', 'purpose', 'executionGeneration',
      'reconcileOf', 'mutation', 'state',
      'startedAt', 'updatedAt', 'errorCode', 'resultDigest', 'responseJson'
    ]) || typeof entry.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(entry.requestId)
      || typeof entry.featureId !== 'string' || typeof entry.featureVersion !== 'string'
      || typeof entry.operationId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(String(entry.operationPackageDigest || ''))
      || typeof entry.runId !== 'string' || typeof entry.commandId !== 'string'
      || typeof entry.connectorId !== 'string' || !Number.isSafeInteger(entry.sessionGeneration) || Number(entry.sessionGeneration) <= 0
      || !['mutation', 'readback', 'reconcile', 'recovery'].includes(String(entry.purpose))
      || typeof entry.executionGeneration !== 'string' || !/^[a-f0-9]{48}$/u.test(entry.executionGeneration)
      || (entry.reconcileOf !== null && (!record(entry.reconcileOf)
        || !exactKeys(entry.reconcileOf, [
          'requestId', 'featureId', 'featureVersion', 'operationId', 'operationPackageDigest',
          'connectorId', 'sessionGeneration', 'executionGeneration'
        ])
        || typeof entry.reconcileOf.featureId !== 'string' || typeof entry.reconcileOf.featureVersion !== 'string'
        || typeof entry.reconcileOf.requestId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(entry.reconcileOf.requestId)
        || typeof entry.reconcileOf.operationId !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(String(entry.reconcileOf.operationPackageDigest || ''))
        || typeof entry.reconcileOf.connectorId !== 'string'
        || !Number.isSafeInteger(entry.reconcileOf.sessionGeneration) || Number(entry.reconcileOf.sessionGeneration) <= 0
        || typeof entry.reconcileOf.executionGeneration !== 'string'
        || !/^[a-f0-9]{48}$/u.test(entry.reconcileOf.executionGeneration)))
      || typeof entry.mutation !== 'boolean'
      || !['running', 'delivery_pending', 'receipt_committed', 'effect_uncertain'].includes(String(entry.state))
      || !isIso(entry.startedAt) || !isIso(entry.updatedAt)
      || typeof entry.errorCode !== 'string' || entry.errorCode.length > 100
      || typeof entry.resultDigest !== 'string'
      || (entry.resultDigest !== '' && !/^[a-f0-9]{64}$/u.test(entry.resultDigest))
      || typeof entry.responseJson !== 'string' || Buffer.byteLength(entry.responseJson, 'utf8') > 4 * 1024 * 1024
      || seen.has(entry.requestId)) throw new Error('Operation activity entry is invalid.');
    if (entry.state === 'delivery_pending' && (!entry.resultDigest || !entry.responseJson)) {
      throw new Error('Pending delivery is missing its recoverable response.');
    }
    if (entry.responseJson) {
      let response: unknown;
      try { response = JSON.parse(entry.responseJson); }
      catch { throw new Error('Operation activity response is not JSON.'); }
      if (canonicalConnectorResponse(response) !== entry.responseJson
        || connectorResultDigest(response) !== entry.resultDigest
        || !record(response) || response.id !== entry.requestId
        || Object.prototype.hasOwnProperty.call(response, 'delivery')) {
        throw new Error('Operation activity response does not match its exact wire identity.');
      }
    } else if (entry.resultDigest && entry.state !== 'receipt_committed') {
      throw new Error('Operation activity result digest has no recoverable response.');
    }
    seen.add(entry.requestId);
  }
  for (const ack of value.completedAcks) {
    if (!record(ack) || !exactKeys(ack, ['ackId', 'ackDigest', 'clearedMutationCount', 'completedAt'])
      || typeof ack.ackId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(ack.ackId)
      || typeof ack.ackDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(ack.ackDigest)
      || !Number.isSafeInteger(ack.clearedMutationCount) || Number(ack.clearedMutationCount) < 0
      || !isIso(ack.completedAt)) throw new Error('Operation delivery acknowledgement ledger is invalid.');
  }
  return value as unknown as OperationActivityLedger;
}

export class OperationActivityStore {
  constructor(private readonly paths: RemoteConnectorPaths) {}

  read(): OperationActivityLedger {
    try {
      if (fs.statSync(this.paths.operationActivity).size > 32 * 1024 * 1024) {
        throw new Error('Operation activity ledger exceeds its fail-closed disk quota.');
      }
      return validateActivity(JSON.parse(fs.readFileSync(this.paths.operationActivity, 'utf8')));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyActivity();
      throw new Error('Operation activity ledger is corrupt; mutation admission is fail-closed.');
    }
  }

  recoverColdStart(): OperationActivityLedger {
    return this.mutate((ledger) => ({
      ...ledger,
      entries: ledger.entries.flatMap((entry) => {
        if (entry.state !== 'running') return [entry];
        if (!entry.mutation) return [];
        return [{ ...entry, state: 'effect_uncertain' as const, errorCode: 'CONNECTOR.WORKER_RESTART', updatedAt: new Date().toISOString() }];
      })
    }));
  }

  begin(requestId: string, request: OperationInvocationRequest, executionGeneration: string): void {
    const identity = receiptIdentity(request);
    if (!identity) {
      if (request.mutationAuthorized) throw new Error('Mutation Operation requires a Core-authored durable deliveryContext.');
      return;
    }
    const delivery = request.deliveryContext!;
    if (delivery.requestId !== requestId) throw new Error('Wire request ID differs from the Core-authored delivery request ID.');
    if (!/^[a-f0-9]{48}$/u.test(executionGeneration)) throw new Error('Worker execution generation is invalid.');
    if (delivery.purpose === 'mutation' !== request.mutationAuthorized) {
      throw new Error('Connector delivery purpose differs from the signed Operation effect.');
    }
    this.mutate((ledger) => {
      if (ledger.entries.some((entry) => entry.requestId === requestId)) {
        throw new Error('Operation request is already present in the durable activity ledger.');
      }
      const now = new Date().toISOString();
      return {
        ...ledger,
        entries: [...ledger.entries, {
          requestId,
          ...identity,
          connectorId: delivery.connectorId,
          sessionGeneration: delivery.sessionGeneration,
          purpose: delivery.purpose,
          executionGeneration,
          reconcileOf: request.reconcileOf ? {
            requestId: request.reconcileOf.requestId,
            featureId: request.reconcileOf.featureId,
            featureVersion: request.reconcileOf.featureVersion,
            operationId: request.reconcileOf.operationId,
            operationPackageDigest: request.reconcileOf.operationPackageDigest,
            connectorId: request.reconcileOf.connectorId,
            sessionGeneration: request.reconcileOf.sessionGeneration,
            executionGeneration: request.reconcileOf.executionGeneration
          } : null,
          mutation: request.mutationAuthorized,
          state: 'running' as const,
          startedAt: now,
          updatedAt: now,
          errorCode: '',
          resultDigest: '',
          responseJson: ''
        }]
      };
    });
  }

  finish(requestId: string, resultDigest: string, errorCode = '', responseJson = ''): void {
    if (resultDigest && !/^[a-f0-9]{64}$/u.test(resultDigest)) throw new Error('Connector result digest is invalid.');
    this.mutate((ledger) => ({
      ...ledger,
      entries: ledger.entries.flatMap((entry) => {
        if (entry.requestId !== requestId) return [entry];
        if (!entry.mutation && errorCode) return [];
        // A Connector error response is not proof that the remote effect never
        // began. Every mutation error remains uncertain until an exact
        // authoritative read-back resolves it.
        if (entry.mutation && errorCode) {
          return [{ ...entry, state: 'effect_uncertain' as const, resultDigest, responseJson, errorCode, updatedAt: new Date().toISOString() }];
        }
        return [{
          ...entry,
          state: 'delivery_pending' as const,
          resultDigest,
          responseJson,
          errorCode,
          updatedAt: new Date().toISOString()
        }];
      })
    }));
  }

  acknowledge(acknowledgement: ConnectorDeliveryAck): { acknowledged: true; clearedMutationCount: number } {
    assertConnectorDeliveryAck(acknowledgement);
    const acknowledgementDigest = checksum(acknowledgement);
    let clearedMutationCount = 0;
    let completedResult: { acknowledged: true; clearedMutationCount: number } | null = null;
    this.mutate((ledger) => ({
      ...(() => {
        const existing = ledger.completedAcks.find((entry) => entry.ackId === acknowledgement.ackId);
        if (existing) {
          if (existing.ackDigest !== acknowledgementDigest) {
            throw new Error('Delivery acknowledgement id was replayed with another result identity.');
          }
          completedResult = { acknowledged: true, clearedMutationCount: existing.clearedMutationCount };
          return ledger;
        }
        const reconciliation = acknowledgement.reconciles;
        const deliveredFound = ledger.entries.some((entry) => entry.requestId === acknowledgement.deliveredRequestId
          && (entry.state === 'delivery_pending'
            || (acknowledgement.resolution !== 'receipt_committed' && entry.state === 'receipt_committed')) && !entry.mutation
          && entry.resultDigest === acknowledgement.resultDigest
          && entry.connectorId === acknowledgement.connectorId
          && entry.sessionGeneration === acknowledgement.sessionGeneration
          && entry.executionGeneration === acknowledgement.executionGeneration
          && entry.featureId === acknowledgement.featureId
          && entry.featureVersion === acknowledgement.featureVersion
          && entry.operationId === acknowledgement.operationId
          && entry.operationPackageDigest === acknowledgement.operationPackageDigest
          && entry.runId === acknowledgement.runId && entry.commandId === acknowledgement.commandId
          && ['readback', 'reconcile', 'recovery'].includes(entry.purpose)
          && (reconciliation === null || (entry.reconcileOf !== null
            && entry.reconcileOf.featureId === reconciliation.featureId
            && entry.reconcileOf.featureVersion === reconciliation.featureVersion
            && entry.reconcileOf.operationId === reconciliation.operationId
            && entry.reconcileOf.operationPackageDigest === reconciliation.operationPackageDigest
            && entry.reconcileOf.connectorId === reconciliation.connectorId
            && entry.reconcileOf.sessionGeneration === reconciliation.sessionGeneration
            && entry.reconcileOf.requestId === reconciliation.requestId
            && entry.reconcileOf.executionGeneration === reconciliation.executionGeneration)));
        if (!deliveredFound) throw new Error('Delivery acknowledgement has no exact pending read-only result.');
        const entries = ledger.entries.filter((entry) => {
        const delivered = entry.requestId === acknowledgement.deliveredRequestId
          && (entry.state === 'delivery_pending'
            || (acknowledgement.resolution !== 'receipt_committed' && entry.state === 'receipt_committed')) && !entry.mutation
          && entry.resultDigest === acknowledgement.resultDigest
          && entry.connectorId === acknowledgement.connectorId
          && entry.sessionGeneration === acknowledgement.sessionGeneration
          && entry.executionGeneration === acknowledgement.executionGeneration
          && entry.featureId === acknowledgement.featureId
          && entry.featureVersion === acknowledgement.featureVersion
          && entry.operationId === acknowledgement.operationId
          && entry.operationPackageDigest === acknowledgement.operationPackageDigest
          && entry.runId === acknowledgement.runId && entry.commandId === acknowledgement.commandId
          && ['readback', 'reconcile', 'recovery'].includes(entry.purpose)
          && (reconciliation === null || (entry.reconcileOf !== null
            && entry.reconcileOf.requestId === reconciliation.requestId
            && entry.reconcileOf.executionGeneration === reconciliation.executionGeneration
            && entry.reconcileOf.connectorId === reconciliation.connectorId
            && entry.reconcileOf.sessionGeneration === reconciliation.sessionGeneration
            && entry.reconcileOf.operationPackageDigest === reconciliation.operationPackageDigest
            && entry.reconcileOf.operationId === reconciliation.operationId
            && entry.reconcileOf.featureId === reconciliation.featureId
            && entry.reconcileOf.featureVersion === reconciliation.featureVersion));
        if (delivered) {
          if (acknowledgement.resolution === 'receipt_committed') {
            if (entry.reconcileOf === null) return false;
            // Keep a compact exact identity for the later conclusive Core
            // outcome transaction; release only the potentially large body.
            (entry as OperationActivityEntry).state = 'receipt_committed';
            (entry as OperationActivityEntry).responseJson = '';
            return true;
          }
          return false;
        }
        const resolvesMutation = reconciliation !== null && entry.mutation
          && ['delivery_pending', 'effect_uncertain'].includes(entry.state)
          && entry.featureId === reconciliation.featureId
          && entry.featureVersion === reconciliation.featureVersion
          && entry.operationId === reconciliation.operationId
          && entry.operationPackageDigest === reconciliation.operationPackageDigest
          && entry.connectorId === reconciliation.connectorId
          && entry.sessionGeneration === reconciliation.sessionGeneration
          && entry.executionGeneration === reconciliation.executionGeneration
          && entry.requestId === reconciliation.requestId
          && entry.runId === acknowledgement.runId && entry.commandId === acknowledgement.commandId;
        if (resolvesMutation) {
          clearedMutationCount += 1;
          return false;
        }
        return true;
        });
        return {
          ...ledger,
          entries,
          completedAcks: [...ledger.completedAcks, {
            ackId: acknowledgement.ackId,
            ackDigest: acknowledgementDigest,
            clearedMutationCount,
            completedAt: new Date().toISOString()
          }]
        };
      })()
    }));
    return completedResult ?? { acknowledged: true, clearedMutationCount };
  }

  counts(): { active: number; uncertain: number } {
    const ledger = this.read();
    return {
      active: ledger.entries.filter((entry) => entry.state === 'running').length,
      uncertain: ledger.entries.filter((entry) => ['delivery_pending', 'effect_uncertain'].includes(entry.state)).length
    };
  }

  deliveryStatus(request: ConnectorDeliveryStatusRequest): ConnectorDeliveryStatusResult {
    assertConnectorDeliveryStatusRequest(request);
    const matches = this.read().entries.filter((entry) => entry.requestId === request.requestId
      && entry.featureId === request.featureId && entry.featureVersion === request.featureVersion
      && entry.operationId === request.operationId && entry.operationPackageDigest === request.operationPackageDigest
      && entry.runId === request.runId && entry.commandId === request.commandId
      && entry.connectorId === request.connectorId && entry.sessionGeneration === request.sessionGeneration);
    if (matches.length === 0) return {
      schemaVersion: 'omnia.connector-delivery-status-result/v1',
      requestId: request.requestId,
      featureId: request.featureId,
      featureVersion: request.featureVersion,
      operationId: request.operationId,
      operationPackageDigest: request.operationPackageDigest,
      runId: request.runId,
      commandId: request.commandId,
      connectorId: request.connectorId,
      sessionGeneration: request.sessionGeneration,
      state: 'not_found',
      executionGeneration: '',
      resultDigest: '',
      responseJson: ''
    };
    if (matches.length !== 1) throw new Error('Connector delivery status has no unique exact durable operation identity.');
    const entry = matches[0]!;
    return {
      schemaVersion: 'omnia.connector-delivery-status-result/v1',
      requestId: entry.requestId,
      featureId: entry.featureId,
      featureVersion: entry.featureVersion,
      operationId: entry.operationId,
      operationPackageDigest: entry.operationPackageDigest,
      runId: entry.runId,
      commandId: entry.commandId,
      connectorId: entry.connectorId,
      sessionGeneration: entry.sessionGeneration,
      state: entry.state,
      executionGeneration: entry.executionGeneration,
      resultDigest: entry.resultDigest,
      responseJson: entry.responseJson
    };
  }

  private mutate(update: (current: OperationActivityLedger) => OperationActivityLedger): OperationActivityLedger {
    return withRemoteConnectorMutex(`${this.paths.operationActivity}.lock`, 10_000, () => {
      const current = this.read();
      const updated = update(structuredClone(current));
      const next = validateActivity({
        ...updated,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString()
      });
      writeJsonAtomic(this.paths.operationActivity, next);
      return next;
    });
  }
}
