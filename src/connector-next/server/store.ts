import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CONNECTOR_NEXT_HEALTH_OPERATION,
  CONNECTOR_NEXT_OPERATION_EXECUTE,
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_PROTOCOL_ID,
  type ConnectorNextDescriptor,
  type ConnectorNextJob,
  type ConnectorNextLogInput,
  type ConnectorNextOperationEnvelope,
  type ConnectorNextTarget,
  type ConnectorNextUpdateManifest,
  type ConnectorNextUpdateStatus,
  assertSemver,
  assertOperationEnvelope,
  assertTarget,
  newAgentToken,
  newEnrollmentCode,
  opaqueHash,
  canonicalJson,
  sha256,
  sameTarget
} from '../protocol.js';
import { redactConnectorNextDetails } from '../redaction.js';
import {
  assertConnectorDeliveryAck,
  assertConnectorDeliveryContext,
  assertConnectorDeliveryStatusRequest,
  canonicalConnectorResponse,
  connectorResultDigest,
  type ConnectorDeliveryAck,
  type ConnectorDeliveryStatusRequest,
  type ConnectorDeliveryStatusResult
} from '../../shared/connector-delivery.js';

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;

function deliveryRequestId(envelope: ConnectorNextOperationEnvelope): string | null {
  if (envelope.command !== 'operation.invoke') return null;
  const context = envelope.input.deliveryContext;
  if (context === undefined) return null;
  assertConnectorDeliveryContext(context);
  return context.requestId;
}

interface ConnectorRow {
  agent_id: string;
  device_id: string;
  connector_instance_id: string;
  token_hash: string;
  version: string;
  sequence: number;
  generation: number;
  capabilities_json: string;
  execution_principal_json: string;
  lifecycle: 'active' | 'revoked';
}

export interface EnrollmentCreated {
  sessionId: string;
  enrollmentCode: string;
  target: ConnectorNextTarget;
  expiresAt: string;
}

export interface EnrollmentConsumed {
  token: string;
  target: ConnectorNextTarget;
  version: string;
  generation: number;
}

export interface StoredUpdateOffer {
  offerId: string;
  manifest: ConnectorNextUpdateManifest;
  status: ConnectorNextUpdateStatus;
}

export class ConnectorNextServerStore {
  readonly db: DatabaseSync;
  private readonly jobEvents = new EventEmitter();

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connector_next_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_next_enrollments (
        session_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('waiting','enrolled','expired')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        enrolled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS connector_next_connectors (
        agent_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        product_id TEXT NOT NULL,
        protocol_id TEXT NOT NULL,
        version TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        capabilities_json TEXT NOT NULL,
        execution_principal_json TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','revoked')),
        enrolled_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(agent_id, device_id, connector_instance_id)
      );
      CREATE TABLE IF NOT EXISTS connector_next_jobs (
        job_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect='read_only'),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','claimed','succeeded','failed')),
        claim_id TEXT,
        claimed_version TEXT,
        claimed_generation INTEGER,
        execution_principal_json TEXT,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS connector_next_jobs_target_status ON connector_next_jobs(agent_id,device_id,connector_instance_id,status,created_at);
      CREATE TABLE IF NOT EXISTS connector_next_operation_requests (
        request_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        envelope_digest TEXT NOT NULL,
        job_id TEXT NOT NULL UNIQUE REFERENCES connector_next_jobs(job_id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_next_logs (
        server_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        client_record_id INTEGER NOT NULL,
        version TEXT NOT NULL,
        generation INTEGER NOT NULL,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        event TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        details_json TEXT NOT NULL,
        UNIQUE(agent_id,device_id,connector_instance_id,client_record_id)
      );
      CREATE INDEX IF NOT EXISTS connector_next_logs_query ON connector_next_logs(agent_id,device_id,connector_instance_id,version,generation,server_log_id);
      CREATE TABLE IF NOT EXISTS connector_next_update_artifacts (
        artifact_id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        package_bytes BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_next_update_offers (
        offer_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES connector_next_update_artifacts(artifact_id),
        agent_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS connector_next_update_target ON connector_next_update_offers(agent_id,device_id,connector_instance_id,status,created_at);
      CREATE TABLE IF NOT EXISTS connector_next_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        event TEXT NOT NULL,
        details_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO connector_next_schema(version,applied_at) VALUES(1,datetime('now'));
    `);
    const jobColumns = this.db.prepare(`PRAGMA table_info(connector_next_jobs)`).all() as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === 'execution_effect')) {
      this.db.exec(`ALTER TABLE connector_next_jobs ADD COLUMN execution_effect TEXT NOT NULL DEFAULT 'read_only' CHECK(execution_effect IN ('read_only','mutation'));`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connector_next_delivery_acks (
        ack_id TEXT PRIMARY KEY,
        ack_digest TEXT NOT NULL,
        request_id TEXT NOT NULL,
        resolution TEXT NOT NULL,
        cleared_mutation_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO connector_next_schema(version,applied_at) VALUES(2,datetime('now'));
    `);
    const requestColumns = this.db.prepare(`PRAGMA table_info(connector_next_operation_requests)`).all() as Array<{ name: string }>;
    if (!requestColumns.some((column) => column.name === 'delivery_request_id')) {
      this.db.exec(`ALTER TABLE connector_next_operation_requests ADD COLUMN delivery_request_id TEXT;`);
    }
    // The envelope request id is the queue/idempotency identity. Durable
    // delivery uses a distinct Core-authored request id inside the immutable
    // invocation context. Persist both identities and recover pre-migration
    // rows from the already durable job payload.
    const unmapped = this.db.prepare(`
      SELECT o.request_id,o.job_id,j.payload_json
      FROM connector_next_operation_requests o
      JOIN connector_next_jobs j ON j.job_id=o.job_id
      WHERE o.delivery_request_id IS NULL
    `).all() as Array<{ request_id: string; job_id: string; payload_json: string }>;
    const mapDeliveryRequest = this.db.prepare(`
      UPDATE connector_next_operation_requests SET delivery_request_id=?
      WHERE request_id=? AND job_id=? AND delivery_request_id IS NULL
    `);
    this.transaction(() => {
      for (const row of unmapped) {
        const envelope = parse<ConnectorNextOperationEnvelope>(row.payload_json);
        assertOperationEnvelope(envelope);
        const requestId = deliveryRequestId(envelope);
        if (requestId) mapDeliveryRequest.run(requestId, row.request_id, row.job_id);
      }
    });
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS connector_next_operation_delivery_request
      ON connector_next_operation_requests(delivery_request_id)
      WHERE delivery_request_id IS NOT NULL;
      INSERT OR IGNORE INTO connector_next_schema(version,applied_at) VALUES(3,datetime('now'));
    `);
    const ackColumns = this.db.prepare(`PRAGMA table_info(connector_next_delivery_acks)`).all() as Array<{ name: string }>;
    if (!ackColumns.some((column) => column.name === 'payload_json')) {
      this.db.exec(`ALTER TABLE connector_next_delivery_acks ADD COLUMN payload_json TEXT;`);
    }
    if (!ackColumns.some((column) => column.name === 'reconciles_request_id')) {
      this.db.exec(`ALTER TABLE connector_next_delivery_acks ADD COLUMN reconciles_request_id TEXT;`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS connector_next_delivery_ack_reconciles
      ON connector_next_delivery_acks(reconciles_request_id)
      WHERE reconciles_request_id IS NOT NULL;
      INSERT OR IGNORE INTO connector_next_schema(version,applied_at) VALUES(4,datetime('now'));
      CREATE TABLE IF NOT EXISTS connector_next_gate_closures(
        job_id TEXT PRIMARY KEY REFERENCES connector_next_jobs(job_id),
        agent_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        proof_kind TEXT NOT NULL CHECK(proof_kind IN ('not_started','final_ack')),
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS connector_next_gate_closure_target
      ON connector_next_gate_closures(agent_id,device_id,connector_instance_id,consumed_at,created_at);
      INSERT OR IGNORE INTO connector_next_schema(version,applied_at) VALUES(5,datetime('now'));
      CREATE TABLE IF NOT EXISTS connector_next_authoritative_closures(
        job_id TEXT PRIMARY KEY REFERENCES connector_next_jobs(job_id),
        delivery_request_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('closed_not_applied','readback_verified')),
        proof_digest TEXT NOT NULL,
        proof_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS connector_next_authoritative_closure_target
      ON connector_next_authoritative_closures(agent_id,device_id,connector_instance_id,consumed_at,created_at);
      INSERT OR IGNORE INTO connector_next_schema(version,applied_at) VALUES(6,datetime('now'));
    `);
  }

  close(): void {
    this.jobEvents.removeAllListeners();
    this.db.close();
  }

  private targetEvent(target: ConnectorNextTarget): string {
    return `target:${target.agentId}\u0000${target.deviceId}\u0000${target.connectorInstanceId}`;
  }

  private jobEvent(jobId: string): string {
    return `job:${jobId}`;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private audit(subjectType: string, subjectId: string, event: string, details: Record<string, unknown> = {}): void {
    this.db.prepare(`INSERT INTO connector_next_audit(subject_type,subject_id,event,details_json,occurred_at) VALUES(?,?,?,?,?)`)
      .run(subjectType, subjectId, event, json(redactConnectorNextDetails(details)), now());
  }

  createEnrollment(target: ConnectorNextTarget, ttlSeconds = 600): EnrollmentCreated {
    assertTarget(target);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) throw new Error('CONNECTOR_NEXT.INVALID_ENROLLMENT_TTL');
    const sessionId = `ocn3.enrollment.${randomUUID()}`;
    const enrollmentCode = newEnrollmentCode();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.transaction(() => {
      const existing = this.db.prepare(`SELECT lifecycle FROM connector_next_connectors WHERE agent_id=? AND device_id=? AND connector_instance_id=?`)
        .get(target.agentId, target.deviceId, target.connectorInstanceId) as { lifecycle: string } | undefined;
      if (existing?.lifecycle === 'active') throw new Error('CONNECTOR_NEXT.IDENTITY_ALREADY_ENROLLED');
      this.db.prepare(`INSERT INTO connector_next_enrollments(session_id,code_hash,agent_id,device_id,connector_instance_id,state,expires_at,created_at) VALUES(?,?,?,?,?,'waiting',?,?)`)
        .run(sessionId, opaqueHash(enrollmentCode), target.agentId, target.deviceId, target.connectorInstanceId, expiresAt, createdAt);
      this.audit('enrollment', sessionId, 'enrollment.created', { ...target });
    });
    return { sessionId, enrollmentCode, target, expiresAt };
  }

  enrollmentStatus(sessionId: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT session_id,agent_id,device_id,connector_instance_id,state,expires_at,created_at,enrolled_at FROM connector_next_enrollments WHERE session_id=?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('CONNECTOR_NEXT.ENROLLMENT_NOT_FOUND');
    return row;
  }

  connectorIdentity(target: ConnectorNextTarget): Record<string, unknown> {
    assertTarget(target);
    const row = this.db.prepare(`
      SELECT agent_id,device_id,connector_instance_id,product_id,protocol_id,version,sequence,generation,
        capabilities_json,lifecycle,last_seen_at
      FROM connector_next_connectors WHERE agent_id=? AND device_id=? AND connector_instance_id=?
    `).get(target.agentId, target.deviceId, target.connectorInstanceId) as Record<string, unknown> | undefined;
    if (!row || row.lifecycle !== 'active') throw new Error('CONNECTOR_NEXT.TARGET_NOT_ENROLLED');
    return {
      agentId: row.agent_id,
      deviceId: row.device_id,
      connectorInstanceId: row.connector_instance_id,
      productId: row.product_id,
      protocolId: row.protocol_id,
      version: row.version,
      sequence: row.sequence,
      generation: row.generation,
      capabilities: parse(String(row.capabilities_json)),
      lifecycle: row.lifecycle,
      lastSeenAt: row.last_seen_at
    };
  }

  consumeEnrollment(enrollmentCode: string, descriptor: ConnectorNextDescriptor): EnrollmentConsumed {
    assertTarget(descriptor);
    if (descriptor.productId !== CONNECTOR_NEXT_PRODUCT_ID || descriptor.protocolId !== CONNECTOR_NEXT_PROTOCOL_ID) {
      throw new Error('CONNECTOR_NEXT.PRODUCT_PROTOCOL_MISMATCH');
    }
    assertSemver(descriptor.version);
    if (!Number.isInteger(descriptor.sequence) || descriptor.sequence < 1 || !Number.isInteger(descriptor.generation) || descriptor.generation !== 1) {
      throw new Error('CONNECTOR_NEXT.INVALID_INITIAL_GENERATION');
    }
    if (!descriptor.capabilities.includes(CONNECTOR_NEXT_HEALTH_OPERATION)) throw new Error('CONNECTOR_NEXT.REQUIRED_CAPABILITY_MISSING');
    if (descriptor.executionPrincipal.processName !== 'OmniaConnectorNextAgent') throw new Error('CONNECTOR_NEXT.EXECUTION_PRINCIPAL_MISMATCH');
    const codeHash = opaqueHash(enrollmentCode);
    const token = newAgentToken();
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT session_id,agent_id,device_id,connector_instance_id,state,expires_at FROM connector_next_enrollments WHERE code_hash=?`)
        .get(codeHash) as ({ session_id: string; agent_id: string; device_id: string; connector_instance_id: string; state: string; expires_at: string }) | undefined;
      if (!row || row.state !== 'waiting' || Date.parse(row.expires_at) <= Date.now()) {
        if (row?.state === 'waiting') this.db.prepare(`UPDATE connector_next_enrollments SET state='expired' WHERE session_id=?`).run(row.session_id);
        throw new Error('CONNECTOR_NEXT.ENROLLMENT_INVALID');
      }
      const expected = { agentId: row.agent_id, deviceId: row.device_id, connectorInstanceId: row.connector_instance_id };
      if (!sameTarget(expected, descriptor)) throw new Error('CONNECTOR_NEXT.ENROLLMENT_IDENTITY_MISMATCH');
      this.db.prepare(`INSERT INTO connector_next_connectors(agent_id,device_id,connector_instance_id,token_hash,product_id,protocol_id,version,sequence,generation,capabilities_json,execution_principal_json,lifecycle,enrolled_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`)
        .run(descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId, opaqueHash(token), descriptor.productId, descriptor.protocolId, descriptor.version, descriptor.sequence, descriptor.generation, json(descriptor.capabilities), json(descriptor.executionPrincipal), now(), now());
      this.db.prepare(`UPDATE connector_next_enrollments SET state='enrolled',enrolled_at=? WHERE session_id=?`).run(now(), row.session_id);
      this.audit('connector', descriptor.connectorInstanceId, 'connector.enrolled', { ...expected, version: descriptor.version, generation: 1 });
      return { token, target: expected, version: descriptor.version, generation: 1 };
    });
  }

  authenticate(token: string, descriptor: ConnectorNextDescriptor, expectedProcess: ConnectorNextDescriptor['executionPrincipal']['processName']): ConnectorRow {
    if (!token.startsWith('ocn3_')) throw new Error('CONNECTOR_NEXT.AUTHENTICATION_FAILED');
    assertTarget(descriptor);
    if (descriptor.productId !== CONNECTOR_NEXT_PRODUCT_ID || descriptor.protocolId !== CONNECTOR_NEXT_PROTOCOL_ID) throw new Error('CONNECTOR_NEXT.AUTHENTICATION_FAILED');
    const row = this.db.prepare(`SELECT * FROM connector_next_connectors WHERE token_hash=?`)
      .get(opaqueHash(token)) as ConnectorRow | undefined;
    if (!row || row.lifecycle !== 'active') throw new Error('CONNECTOR_NEXT.AUTHENTICATION_FAILED');
    const storedHash = Buffer.from(row.token_hash);
    const offeredHash = Buffer.from(opaqueHash(token));
    if (storedHash.length !== offeredHash.length || !timingSafeEqual(storedHash, offeredHash)) throw new Error('CONNECTOR_NEXT.AUTHENTICATION_FAILED');
    const expected = { agentId: row.agent_id, deviceId: row.device_id, connectorInstanceId: row.connector_instance_id };
    if (!sameTarget(expected, descriptor) || row.version !== descriptor.version || row.generation !== descriptor.generation || row.sequence !== descriptor.sequence) {
      throw new Error('CONNECTOR_NEXT.IDENTITY_FENCE_REJECTED');
    }
    if (json(parse<string[]>(row.capabilities_json).slice().sort()) !== json(descriptor.capabilities.slice().sort())) throw new Error('CONNECTOR_NEXT.CAPABILITY_FENCE_REJECTED');
    const enrolledPrincipal = parse<{ kind: string; subjectHash: string }>(row.execution_principal_json);
    if (descriptor.executionPrincipal.processName !== expectedProcess
      || enrolledPrincipal.kind !== descriptor.executionPrincipal.kind
      || enrolledPrincipal.subjectHash !== descriptor.executionPrincipal.subjectHash) throw new Error('CONNECTOR_NEXT.EXECUTION_PRINCIPAL_FENCE_REJECTED');
    this.db.prepare(`UPDATE connector_next_connectors SET last_seen_at=? WHERE token_hash=?`).run(now(), row.token_hash);
    return row;
  }

  /**
   * A read-only claim has no external effect to reconcile. If an Agent process
   * disappears after claiming one, its next authenticated startup may safely
   * put that exact job back on the durable queue. Mutation claims deliberately
   * remain untouched because their effect can be uncertain.
   */
  recoverInterruptedReadOnlyJobs(descriptor: ConnectorNextDescriptor): number {
    const recovered = this.transaction(() => {
      const rows = this.db.prepare(`SELECT job_id FROM connector_next_jobs
        WHERE agent_id=? AND device_id=? AND connector_instance_id=?
          AND status='claimed' AND execution_effect='read_only'`)
        .all(descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId) as { job_id: string }[];
      for (const row of rows) {
        this.db.prepare(`UPDATE connector_next_jobs SET
          status='queued',claim_id=NULL,claimed_version=NULL,claimed_generation=NULL,
          execution_principal_json=NULL,claimed_at=NULL
          WHERE job_id=? AND status='claimed' AND execution_effect='read_only'`).run(row.job_id);
        this.audit('job', row.job_id, 'job.read_only_requeued_after_agent_restart', {
          version: descriptor.version,
          generation: descriptor.generation
        });
      }
      return rows.length;
    });
    if (recovered > 0) this.jobEvents.emit(this.targetEvent(descriptor));
    return recovered;
  }

  enqueueReadOnlyJob(target: ConnectorNextTarget, operation: string, payload: Record<string, unknown>, deadlineSeconds = 60): { jobId: string } {
    assertTarget(target);
    if (operation !== CONNECTOR_NEXT_HEALTH_OPERATION && operation !== CONNECTOR_NEXT_OPERATION_EXECUTE) throw new Error('CONNECTOR_NEXT.OPERATION_NOT_ALLOWED');
    if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 600) throw new Error('CONNECTOR_NEXT.INVALID_JOB_DEADLINE');
    if (operation === CONNECTOR_NEXT_OPERATION_EXECUTE) {
      assertOperationEnvelope(payload);
      if (!sameTarget(target, payload.target)) throw new Error('CONNECTOR_NEXT.OPERATION_TARGET_MISMATCH');
    }
    const envelope = operation === CONNECTOR_NEXT_OPERATION_EXECUTE ? payload as unknown as ConnectorNextOperationEnvelope : null;
    const durableRequestId = envelope ? deliveryRequestId(envelope) : null;
    const connector = this.db.prepare(`SELECT lifecycle FROM connector_next_connectors WHERE agent_id=? AND device_id=? AND connector_instance_id=?`)
      .get(target.agentId, target.deviceId, target.connectorInstanceId) as { lifecycle: string } | undefined;
    if (connector?.lifecycle !== 'active') throw new Error('CONNECTOR_NEXT.TARGET_NOT_ENROLLED');
    const queued = this.transaction(() => {
      if (operation === CONNECTOR_NEXT_OPERATION_EXECUTE) {
        const digest = sha256(canonicalJson(envelope));
        const prior = this.db.prepare(`SELECT envelope_digest,job_id FROM connector_next_operation_requests WHERE request_id=?`)
          .get(envelope!.requestId) as { envelope_digest: string; job_id: string } | undefined;
        if (prior) {
          if (prior.envelope_digest !== digest) throw new Error('CONNECTOR_NEXT.OPERATION_REQUEST_IMMUTABILITY_CONFLICT');
          return { jobId: prior.job_id };
        }
      }
      const jobId = `ocn3.job.${randomUUID()}`;
      const createdAt = now();
      const executionEffect = envelope?.effect || 'read_only';
      this.db.prepare(`INSERT INTO connector_next_jobs(job_id,agent_id,device_id,connector_instance_id,operation,effect,payload_json,status,created_at,deadline_at,execution_effect) VALUES(?,?,?,?,?,'read_only',?,'queued',?,?,?)`)
        .run(jobId, target.agentId, target.deviceId, target.connectorInstanceId, operation, json(payload), createdAt, new Date(Date.now() + deadlineSeconds * 1000).toISOString(), executionEffect);
      if (operation === CONNECTOR_NEXT_OPERATION_EXECUTE) {
        this.db.prepare(`INSERT INTO connector_next_operation_requests(request_id,delivery_request_id,agent_id,device_id,connector_instance_id,envelope_digest,job_id,created_at) VALUES(?,?,?,?,?,?,?,?)`)
          .run(envelope!.requestId, durableRequestId, target.agentId, target.deviceId, target.connectorInstanceId, sha256(canonicalJson(envelope)), jobId, createdAt);
      }
      this.audit('job', jobId, 'job.queued', { ...target, operation, effect: executionEffect, ...(envelope ? { requestId: envelope.requestId, command: envelope.command } : {}) });
      return { jobId };
    });
    // Publish only after the SQLite transaction commits. Agent long-polls are
    // a latency optimization; the durable queue remains the source of truth.
    this.jobEvents.emit(this.targetEvent(target));
    return queued;
  }

  claimJob(descriptor: ConnectorNextDescriptor): ConnectorNextJob | null {
    return this.claimJobs(descriptor, 1)[0] || null;
  }

  claimJobs(descriptor: ConnectorNextDescriptor, maximum = 1): ConnectorNextJob[] {
    const limit = Number.isInteger(maximum) ? Math.max(1, Math.min(8, maximum)) : 1;
    const expiredJobIds: string[] = [];
    const jobs = this.transaction(() => {
      const claimed: ConnectorNextJob[] = [];
      while (claimed.length < limit) {
      const row = this.db.prepare(`SELECT job_id,operation,payload_json,created_at,deadline_at,execution_effect FROM connector_next_jobs WHERE agent_id=? AND device_id=? AND connector_instance_id=? AND status='queued' ORDER BY created_at LIMIT 1`)
        .get(descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId) as { job_id: string; operation: ConnectorNextJob['operation']; payload_json: string; created_at: string; deadline_at: string; execution_effect: ConnectorNextJob['effect'] } | undefined;
      if (!row) break;
      if (Date.parse(row.deadline_at) <= Date.now()) {
        this.db.prepare(`UPDATE connector_next_jobs SET status='failed',error_json=?,completed_at=? WHERE job_id=? AND status='queued'`)
          .run(json({ code: 'CONNECTOR_NEXT.JOB_DEADLINE_EXPIRED', effectState: 'not_started' }), now(), row.job_id);
        expiredJobIds.push(row.job_id);
        continue;
      }
      const claimId = `ocn3.claim.${randomUUID()}`;
      const updated = this.db.prepare(`UPDATE connector_next_jobs SET status='claimed',claim_id=?,claimed_version=?,claimed_generation=?,execution_principal_json=?,claimed_at=? WHERE job_id=? AND status='queued'`)
        .run(claimId, descriptor.version, descriptor.generation, json(descriptor.executionPrincipal), now(), row.job_id);
      if (updated.changes !== 1) continue;
      this.audit('job', row.job_id, 'job.claimed', { claimId, version: descriptor.version, generation: descriptor.generation });
      claimed.push({
        schemaVersion: 'omnia.connector-next-job/v1',
        jobId: row.job_id,
        claimId,
        target: { agentId: descriptor.agentId, deviceId: descriptor.deviceId, connectorInstanceId: descriptor.connectorInstanceId },
        operation: row.operation,
        effect: row.execution_effect,
        payload: parse<Record<string, unknown>>(row.payload_json),
        createdAt: row.created_at,
        deadlineAt: row.deadline_at
      });
      }
      return claimed;
    });
    for (const jobId of expiredJobIds) this.jobEvents.emit(this.jobEvent(jobId));
    return jobs;
  }

  async waitAndClaimJobs(descriptor: ConnectorNextDescriptor, maximum = 1, waitMs = 0): Promise<ConnectorNextJob[]> {
    const immediate = this.claimJobs(descriptor, maximum);
    if (immediate.length || waitMs <= 0) return immediate;
    const boundedWait = Math.max(1, Math.min(5_000, Math.trunc(waitMs)));
    const event = this.targetEvent(descriptor);
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.jobEvents.off(event, finish);
        resolve(this.claimJobs(descriptor, maximum));
      };
      this.jobEvents.on(event, finish);
      timer = setTimeout(finish, boundedWait);
      // Close the check/listen race: if enqueue committed immediately before
      // listener registration, claim the durable row now.
      const raced = this.claimJobs(descriptor, maximum);
      if (raced.length) {
        settled = true;
        clearTimeout(timer);
        this.jobEvents.off(event, finish);
        resolve(raced);
      }
    });
  }

  completeJob(descriptor: ConnectorNextDescriptor, jobId: string, claimId: string, outcome: { ok: true; result: unknown } | { ok: false; error: unknown }): void {
    this.transaction(() => {
      const row = this.db.prepare(`SELECT status,claim_id,claimed_version,claimed_generation,execution_principal_json FROM connector_next_jobs WHERE job_id=? AND agent_id=? AND device_id=? AND connector_instance_id=?`)
        .get(jobId, descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId) as { status: string; claim_id: string; claimed_version: string; claimed_generation: number; execution_principal_json: string } | undefined;
      if (!row || row.status !== 'claimed' || row.claim_id !== claimId) throw new Error('CONNECTOR_NEXT.JOB_CLAIM_MISMATCH');
      if (row.claimed_version !== descriptor.version || row.claimed_generation !== descriptor.generation || row.execution_principal_json !== json(descriptor.executionPrincipal)) {
        throw new Error('CONNECTOR_NEXT.JOB_EXECUTION_IDENTITY_MISMATCH');
      }
      const status = outcome.ok ? 'succeeded' : 'failed';
      this.db.prepare(`UPDATE connector_next_jobs SET status=?,result_json=?,error_json=?,completed_at=? WHERE job_id=?`)
        .run(status, outcome.ok ? json(outcome.result) : null, outcome.ok ? null : json(redactConnectorNextDetails(outcome.error)), now(), jobId);
      this.audit('job', jobId, `job.${status}`, { version: descriptor.version, generation: descriptor.generation });
    });
    this.jobEvents.emit(this.jobEvent(jobId));
  }

  getJob(jobId: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT job_id,agent_id,device_id,connector_instance_id,operation,execution_effect AS effect,status,result_json,error_json,created_at,deadline_at,claimed_at,completed_at,claimed_version,claimed_generation,execution_principal_json FROM connector_next_jobs WHERE job_id=?`)
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('CONNECTOR_NEXT.JOB_NOT_FOUND');
    for (const field of ['result_json', 'error_json', 'execution_principal_json']) {
      if (typeof row[field] === 'string') row[field.replace('_json', '')] = parse(String(row[field]));
      delete row[field];
    }
    return row;
  }

  async waitForJob(jobId: string, waitMs = 0): Promise<Record<string, unknown>> {
    const current = this.getJob(jobId);
    if (current.status === 'succeeded' || current.status === 'failed' || waitMs <= 0) return current;
    const boundedWait = Math.max(1, Math.min(25_000, Math.trunc(waitMs)));
    const event = this.jobEvent(jobId);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.jobEvents.off(event, finish);
        try { resolve(this.getJob(jobId)); } catch (error) { reject(error); }
      };
      this.jobEvents.on(event, finish);
      timer = setTimeout(finish, boundedWait);
      const raced = this.getJob(jobId);
      if (raced.status === 'succeeded' || raced.status === 'failed') {
        settled = true;
        clearTimeout(timer);
        this.jobEvents.off(event, finish);
        resolve(raced);
      }
    });
  }

  deliveryStatus(request: ConnectorDeliveryStatusRequest): ConnectorDeliveryStatusResult {
    assertConnectorDeliveryStatusRequest(request);
    const base = { ...request, schemaVersion: 'omnia.connector-delivery-status-result/v1' as const };
    // Target ids are carried in the immutable envelope; resolve by globally
    // unique request id, then validate every delivery identity below.
    const exact = this.db.prepare(`
      SELECT j.status,j.result_json,j.error_json,j.payload_json
      FROM connector_next_operation_requests o JOIN connector_next_jobs j ON j.job_id=o.job_id
      WHERE o.delivery_request_id=?
    `).get(request.requestId) as Record<string, unknown> | undefined;
    if (!exact) return { ...base, state: 'not_found', executionGeneration: '', resultDigest: '', responseJson: '' };
    const envelope = parse<ConnectorNextOperationEnvelope>(String(exact.payload_json));
    assertOperationEnvelope(envelope);
    const invocation = envelope.input as Record<string, unknown>;
    const context = invocation.deliveryContext as Record<string, unknown> | undefined;
    const identityMatches = context
      && context.requestId === request.requestId && context.featureId === request.featureId
      && context.featureVersion === request.featureVersion && context.operationId === request.operationId
      && context.operationPackageDigest === request.operationPackageDigest && context.runId === request.runId
      && context.commandId === request.commandId && context.connectorId === request.connectorId
      && Number(context.sessionGeneration) === request.sessionGeneration;
    if (!identityMatches) throw new Error('CONNECTOR_NEXT.DELIVERY_IDENTITY_MISMATCH');
    if (exact.status === 'queued' || exact.status === 'claimed') {
      return { ...base, state: 'running', executionGeneration: '', resultDigest: '', responseJson: '' };
    }
    if (exact.status !== 'succeeded' || !exact.result_json) {
      return { ...base, state: context.purpose === 'mutation' ? 'effect_uncertain' : 'not_found', executionGeneration: '', resultDigest: '', responseJson: '' };
    }
    const operationResult = parse<Record<string, unknown>>(String(exact.result_json));
    const durable = operationResult.value as Record<string, unknown> | undefined;
    const witness = durable?.witness as Record<string, unknown> | undefined;
    const wireResponse = durable?.wireResponse;
    if (durable?.schemaVersion !== 'omnia.connector-next-durable-delivery/v1' || !witness
      || witness.requestId !== request.requestId || witness.sessionGeneration !== request.sessionGeneration
      || typeof witness.executionGeneration !== 'string' || !/^[a-f0-9]{48}$/u.test(witness.executionGeneration)
      || typeof witness.resultDigest !== 'string' || connectorResultDigest(wireResponse) !== witness.resultDigest) {
      throw new Error('CONNECTOR_NEXT.DELIVERY_RESULT_INVALID');
    }
    return {
      ...base,
      state: 'delivery_pending',
      executionGeneration: witness.executionGeneration,
      resultDigest: witness.resultDigest,
      responseJson: canonicalConnectorResponse(wireResponse)
    };
  }

  acknowledgeDelivery(ack: ConnectorDeliveryAck): { acknowledged: true; clearedMutationCount: number } {
    assertConnectorDeliveryAck(ack);
    const ackDigest = sha256(canonicalJson(ack));
    const payloadJson = json(ack);
    const reconcilesRequestId = ack.reconciles?.requestId || null;
    const existing = this.db.prepare(`SELECT ack_digest,cleared_mutation_count FROM connector_next_delivery_acks WHERE ack_id=?`)
      .get(ack.ackId) as { ack_digest: string; cleared_mutation_count: number } | undefined;
    if (existing) {
      if (existing.ack_digest !== ackDigest) throw new Error('CONNECTOR_NEXT.DELIVERY_ACK_IMMUTABILITY_CONFLICT');
      // Releases before server schema v4 retained only the acknowledgement
      // digest. An exact idempotent replay may safely hydrate the canonical
      // payload because the digest above proves it is the original Core ack.
      this.db.prepare(`UPDATE connector_next_delivery_acks SET payload_json=?,reconciles_request_id=? WHERE ack_id=? AND ack_digest=?`)
        .run(payloadJson, reconcilesRequestId, ack.ackId, ackDigest);
      return { acknowledged: true, clearedMutationCount: existing.cleared_mutation_count };
    }
    const delivered = this.deliveryStatus({
      schemaVersion: 'omnia.connector-delivery-status-request/v1', requestId: ack.deliveredRequestId,
      featureId: ack.featureId, featureVersion: ack.featureVersion, operationId: ack.operationId,
      operationPackageDigest: ack.operationPackageDigest, runId: ack.runId, commandId: ack.commandId,
      connectorId: ack.connectorId, sessionGeneration: ack.sessionGeneration
    });
    if (delivered.state !== 'delivery_pending' || delivered.resultDigest !== ack.resultDigest
      || delivered.executionGeneration !== ack.executionGeneration) throw new Error('CONNECTOR_NEXT.DELIVERY_ACK_IDENTITY_MISMATCH');
    const clearedMutationCount = ack.resolution === 'receipt_committed' ? 0 : 1;
    if (clearedMutationCount === 1 && !ack.reconciles) throw new Error('CONNECTOR_NEXT.DELIVERY_ACK_RECONCILE_REQUIRED');
    this.db.prepare(`INSERT INTO connector_next_delivery_acks(ack_id,ack_digest,request_id,resolution,cleared_mutation_count,created_at,payload_json,reconciles_request_id) VALUES(?,?,?,?,?,?,?,?)`)
      .run(ack.ackId, ackDigest, ack.deliveredRequestId, ack.resolution, clearedMutationCount, now(), payloadJson, reconcilesRequestId);
    return { acknowledged: true, clearedMutationCount };
  }

  recordAuthoritativeClosure(value: unknown): { accepted: true; jobId: string; deliveryRequestId: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_INVALID');
    const proof = value as Record<string, unknown>;
    if (proof.schemaVersion !== 'omnia.connector-next-authoritative-closure/v1') throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_INVALID');
    assertTarget(proof.target);
    const target = proof.target;
    const text = (key: string, pattern: RegExp) => {
      const field = proof[key];
      if (typeof field !== 'string' || !pattern.test(field)) throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_INVALID');
      return field;
    };
    const requestId = text('requestId', /^[0-9a-f-]{36}$/u);
    const featureId = text('featureId', /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u);
    const featureVersion = text('featureVersion', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    const operationId = text('operationId', /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u);
    const operationPackageDigest = text('operationPackageDigest', /^sha256:[0-9a-f]{64}$/u);
    const runId = text('runId', /^[0-9a-f-]{36}$/u);
    const commandId = text('commandId', /^[0-9a-f-]{36}$/u);
    const connectorId = text('connectorId', /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u);
    const receiptId = text('receiptId', /^[0-9a-f-]{36}$/u);
    const receiptRequestDigest = text('receiptRequestDigest', /^[0-9a-f]{64}$/u);
    const receiptResponseDigest = text('receiptResponseDigest', /^[0-9a-f]{64}$/u);
    const completedAt = text('completedAt', /^\d{4}-\d{2}-\d{2}T/u);
    const outcome = proof.outcome === 'closed_not_applied' || proof.outcome === 'readback_verified'
      ? proof.outcome : null;
    const sessionGeneration = proof.sessionGeneration;
    const proofDigest = proof.proofDigest;
    if (outcome === null
      || !Number.isSafeInteger(sessionGeneration) || Number(sessionGeneration) < 1
      || typeof proofDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(proofDigest)) {
      throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_INVALID');
    }
    const unsigned = { ...proof };
    delete unsigned.proofDigest;
    if (sha256(canonicalJson(unsigned)) !== proofDigest) throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_DIGEST_INVALID');
    const source = this.db.prepare(`
      SELECT j.job_id,j.status,j.payload_json,j.result_json,o.delivery_request_id
      FROM connector_next_operation_requests o JOIN connector_next_jobs j ON j.job_id=o.job_id
      WHERE o.delivery_request_id=? AND j.agent_id=? AND j.device_id=? AND j.connector_instance_id=?
        AND j.execution_effect='mutation'
    `).get(requestId, target.agentId, target.deviceId, target.connectorInstanceId) as {
      job_id: string; status: string; payload_json: string; result_json: string | null; delivery_request_id: string;
    } | undefined;
    if (!source || source.result_json) throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_SOURCE_INVALID');
    const envelope = parse<ConnectorNextOperationEnvelope>(source.payload_json);
    assertOperationEnvelope(envelope);
    if (envelope.command !== 'operation.invoke' || !sameTarget(envelope.target, target)) throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_SOURCE_INVALID');
    const context = envelope.input.deliveryContext;
    assertConnectorDeliveryContext(context);
    if (context.purpose !== 'mutation' || context.requestId !== requestId || context.featureId !== featureId
      || context.featureVersion !== featureVersion || context.operationId !== operationId
      || context.operationPackageDigest !== operationPackageDigest || context.runId !== runId
      || context.commandId !== commandId || context.connectorId !== connectorId
      || context.sessionGeneration !== sessionGeneration) throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_IDENTITY_MISMATCH');
    this.transaction(() => {
      const prior = this.db.prepare(`SELECT proof_digest FROM connector_next_authoritative_closures WHERE job_id=?`).get(source.job_id) as { proof_digest: string } | undefined;
      if (prior && prior.proof_digest !== proofDigest) throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_IMMUTABILITY_CONFLICT');
      this.db.prepare(`INSERT OR IGNORE INTO connector_next_authoritative_closures(job_id,delivery_request_id,agent_id,device_id,connector_instance_id,outcome,proof_digest,proof_json,created_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)`)
        .run(source.job_id, requestId, target.agentId, target.deviceId, target.connectorInstanceId, outcome, proofDigest, json(proof), now());
      this.db.prepare(`UPDATE connector_next_jobs SET status='failed',error_json=?,completed_at=? WHERE job_id=? AND status='claimed' AND result_json IS NULL`)
        .run(json({ code: 'CONNECTOR_NEXT.MUTATION_AUTHORITATIVELY_CLOSED', effectState: outcome, receiptId, receiptRequestDigest, receiptResponseDigest, completedAt }), now(), source.job_id);
      this.audit('job', source.job_id, 'job.mutation_authoritatively_closed', { requestId, outcome, receiptId, proofDigest });
    });
    return { accepted: true, jobId: source.job_id, deliveryRequestId: requestId };
  }

  private finalAckResolvesMutationJob(jobId: string, target: ConnectorNextTarget): boolean {
    const source = this.db.prepare(`
      SELECT j.status,j.payload_json,j.result_json,o.delivery_request_id
      FROM connector_next_jobs j
      JOIN connector_next_operation_requests o ON o.job_id=j.job_id
      WHERE j.job_id=? AND j.agent_id=? AND j.device_id=? AND j.connector_instance_id=?
        AND j.execution_effect='mutation'
    `).get(jobId, target.agentId, target.deviceId, target.connectorInstanceId) as {
      status: string; payload_json: string; result_json: string | null; delivery_request_id: string | null;
    } | undefined;
    if (!source || source.status !== 'succeeded' || !source.result_json || !source.delivery_request_id) return false;

    const envelope = parse<ConnectorNextOperationEnvelope>(source.payload_json);
    assertOperationEnvelope(envelope);
    if (envelope.command !== 'operation.invoke' || !sameTarget(envelope.target, target)) return false;
    const invocation = envelope.input as Record<string, unknown>;
    const context = invocation.deliveryContext;
    assertConnectorDeliveryContext(context);
    if (context.purpose !== 'mutation' || context.requestId !== source.delivery_request_id) return false;

    const operationResult = parse<Record<string, unknown>>(source.result_json);
    const durable = operationResult.value as Record<string, unknown> | undefined;
    const witness = durable?.witness as Record<string, unknown> | undefined;
    const wireResponse = durable?.wireResponse;
    if (durable?.schemaVersion !== 'omnia.connector-next-durable-delivery/v1' || !witness
      || witness.requestId !== context.requestId || witness.sessionGeneration !== context.sessionGeneration
      || typeof witness.executionGeneration !== 'string' || !/^[a-f0-9]{48}$/u.test(witness.executionGeneration)
      || typeof witness.resultDigest !== 'string' || connectorResultDigest(wireResponse) !== witness.resultDigest) return false;

    const rows = this.db.prepare(`
      SELECT ack_digest,payload_json,cleared_mutation_count
      FROM connector_next_delivery_acks
      WHERE reconciles_request_id=? AND cleared_mutation_count=1 AND payload_json IS NOT NULL
      ORDER BY created_at
    `).all(context.requestId) as Array<{ ack_digest: string; payload_json: string; cleared_mutation_count: number }>;
    return rows.some((row) => {
      const ack = parse<ConnectorDeliveryAck>(row.payload_json);
      assertConnectorDeliveryAck(ack);
      const reconciles = ack.reconciles;
      return row.ack_digest === sha256(canonicalJson(ack)) && row.cleared_mutation_count === 1
        && ack.resolution !== 'receipt_committed' && reconciles !== null
        && reconciles.requestId === context.requestId
        && reconciles.featureId === context.featureId && reconciles.featureVersion === context.featureVersion
        && reconciles.operationId === context.operationId && reconciles.operationPackageDigest === context.operationPackageDigest
        && reconciles.connectorId === context.connectorId && reconciles.sessionGeneration === context.sessionGeneration
        && reconciles.executionGeneration === witness.executionGeneration;
    });
  }

  ingestLogs(descriptor: ConnectorNextDescriptor, records: ConnectorNextLogInput[]): number[] {
    if (records.length < 1 || records.length > 500) throw new Error('CONNECTOR_NEXT.INVALID_LOG_BATCH');
    return this.transaction(() => {
      const acked: number[] = [];
      const statement = this.db.prepare(`INSERT OR IGNORE INTO connector_next_logs(agent_id,device_id,connector_instance_id,client_record_id,version,generation,source,severity,event,occurred_at,received_at,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const record of records) {
        if (!Number.isInteger(record.recordId) || record.recordId < 1) throw new Error('CONNECTOR_NEXT.INVALID_LOG_RECORD_ID');
        statement.run(descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId, record.recordId, descriptor.version, descriptor.generation, record.source, record.severity, String(record.event).slice(0, 160), record.occurredAt, now(), json(redactConnectorNextDetails(record.details)));
        acked.push(record.recordId);
      }
      return acked;
    });
  }

  queryLogs(target: ConnectorNextTarget, filters: { version?: string; generation?: number; after?: number; limit?: number }): Record<string, unknown>[] {
    assertTarget(target);
    const clauses = ['agent_id=?', 'device_id=?', 'connector_instance_id=?', 'server_log_id>?'];
    const values: Array<string | number> = [target.agentId, target.deviceId, target.connectorInstanceId, filters.after || 0];
    if (filters.version) { clauses.push('version=?'); values.push(filters.version); }
    if (filters.generation !== undefined) { clauses.push('generation=?'); values.push(filters.generation); }
    const limit = Math.max(1, Math.min(filters.limit || 200, 500));
    values.push(limit);
    const rows = this.db.prepare(`SELECT server_log_id,client_record_id,agent_id,device_id,connector_instance_id,version,generation,source,severity,event,occurred_at,received_at,details_json FROM connector_next_logs WHERE ${clauses.join(' AND ')} ORDER BY server_log_id LIMIT ?`).all(...values) as Record<string, unknown>[];
    return rows.map((row) => ({ ...row, details: parse(String(row.details_json)), details_json: undefined }));
  }

  registerArtifact(manifest: ConnectorNextUpdateManifest, packageBytes: Buffer): void {
    const existing = this.db.prepare(`SELECT manifest_json,package_bytes FROM connector_next_update_artifacts WHERE artifact_id=?`).get(manifest.artifactId) as { manifest_json: string; package_bytes: Uint8Array } | undefined;
    if (existing) {
      if (existing.manifest_json !== json(manifest) || !Buffer.from(existing.package_bytes).equals(packageBytes)) throw new Error('CONNECTOR_NEXT.ARTIFACT_IMMUTABILITY_CONFLICT');
      return;
    }
    this.db.prepare(`INSERT INTO connector_next_update_artifacts(artifact_id,manifest_json,package_bytes,created_at) VALUES(?,?,?,?)`)
      .run(manifest.artifactId, json(manifest), packageBytes, now());
    this.audit('update_artifact', manifest.artifactId, 'update_artifact.registered', { version: manifest.version, sequence: manifest.sequence, packageSize: manifest.packageSize });
  }

  createUpdateOffer(target: ConnectorNextTarget, artifactId: string): StoredUpdateOffer {
    assertTarget(target);
    const connector = this.db.prepare(`SELECT version,sequence,lifecycle FROM connector_next_connectors WHERE agent_id=? AND device_id=? AND connector_instance_id=?`)
      .get(target.agentId, target.deviceId, target.connectorInstanceId) as { version: string; sequence: number; lifecycle: string } | undefined;
    if (connector?.lifecycle !== 'active') throw new Error('CONNECTOR_NEXT.TARGET_NOT_ENROLLED');
    const artifact = this.db.prepare(`SELECT manifest_json FROM connector_next_update_artifacts WHERE artifact_id=?`).get(artifactId) as { manifest_json: string } | undefined;
    if (!artifact) throw new Error('CONNECTOR_NEXT.UPDATE_ARTIFACT_NOT_FOUND');
    const manifest = parse<ConnectorNextUpdateManifest>(artifact.manifest_json);
    if (manifest.sequence <= connector.sequence) throw new Error('CONNECTOR_NEXT.UPDATE_SEQUENCE_NOT_NEWER');
    const offerId = `ocn3.offer.${randomUUID()}`;
    this.db.prepare(`INSERT INTO connector_next_update_offers(offer_id,artifact_id,agent_id,device_id,connector_instance_id,status,details_json,created_at,updated_at) VALUES(?,?,?,?,?,'offered','{}',?,?)`)
      .run(offerId, artifactId, target.agentId, target.deviceId, target.connectorInstanceId, now(), now());
    this.audit('update_offer', offerId, 'update.offered', { ...target, artifactId, targetVersion: manifest.version, targetSequence: manifest.sequence });
    return { offerId, manifest, status: 'offered' };
  }

  pollUpdate(descriptor: ConnectorNextDescriptor): StoredUpdateOffer | null {
    const row = this.db.prepare(`SELECT o.offer_id,o.status,a.manifest_json FROM connector_next_update_offers o JOIN connector_next_update_artifacts a ON a.artifact_id=o.artifact_id WHERE o.agent_id=? AND o.device_id=? AND o.connector_instance_id=? AND o.status IN ('offered','downloading','verified','staged','waiting_safe_window','activating','probation') ORDER BY a.created_at DESC LIMIT 1`)
      .get(descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId) as { offer_id: string; status: ConnectorNextUpdateStatus; manifest_json: string } | undefined;
    return row ? { offerId: row.offer_id, manifest: parse(row.manifest_json), status: row.status } : null;
  }

  confirmCandidateHeartbeat(token: string, descriptor: ConnectorNextDescriptor, offerId: string, phase: 'candidate' | 'probation', uncertainJobIds: unknown[] = [], gateDiagnostics: unknown[] = []): { accepted: true; offerId: string; phase: string; generation: number; notStartedJobIds: string[]; resolvedUncertainJobIds: string[] } {
    if (!token.startsWith('ocn3_') || !['candidate', 'probation'].includes(phase)) throw new Error('CONNECTOR_NEXT.AUTHENTICATION_FAILED');
    if (uncertainJobIds.length > 128 || uncertainJobIds.some((jobId) => typeof jobId !== 'string' || !/^ocn3\.job\.[0-9a-f-]{36}$/.test(jobId))) {
      throw new Error('CONNECTOR_NEXT.INVALID_UNCERTAIN_JOB_IDS');
    }
    if (gateDiagnostics.length > 8 || gateDiagnostics.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      const value = entry as Record<string, unknown>;
      return typeof value.source !== 'string' || !/^[a-z_]{1,32}$/u.test(value.source)
        || typeof value.pathHash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.pathHash)
        || typeof value.existed !== 'boolean' || !Array.isArray(value.uncertainJobIds)
        || value.uncertainJobIds.length > 128
        || value.uncertainJobIds.some((jobId) => typeof jobId !== 'string' || !/^ocn3\.job\.[0-9a-f-]{36}$/u.test(jobId));
    })) throw new Error('CONNECTOR_NEXT.INVALID_GATE_DIAGNOSTICS');
    return this.transaction(() => {
      const connector = this.db.prepare(`SELECT * FROM connector_next_connectors WHERE token_hash=?`).get(opaqueHash(token)) as ConnectorRow | undefined;
      if (!connector || connector.lifecycle !== 'active') throw new Error('CONNECTOR_NEXT.AUTHENTICATION_FAILED');
      const target = { agentId: connector.agent_id, deviceId: connector.device_id, connectorInstanceId: connector.connector_instance_id };
      if (!sameTarget(target, descriptor) || descriptor.productId !== CONNECTOR_NEXT_PRODUCT_ID || descriptor.protocolId !== CONNECTOR_NEXT_PROTOCOL_ID) throw new Error('CONNECTOR_NEXT.IDENTITY_FENCE_REJECTED');
      const enrolledPrincipal = parse<{ kind: string; subjectHash: string }>(connector.execution_principal_json);
      if (descriptor.executionPrincipal.processName !== 'OmniaConnectorNextAgent'
        || descriptor.executionPrincipal.kind !== enrolledPrincipal.kind
        || descriptor.executionPrincipal.subjectHash !== enrolledPrincipal.subjectHash) throw new Error('CONNECTOR_NEXT.EXECUTION_PRINCIPAL_FENCE_REJECTED');
      const offer = this.db.prepare(`SELECT o.status,o.details_json,a.manifest_json FROM connector_next_update_offers o JOIN connector_next_update_artifacts a ON a.artifact_id=o.artifact_id WHERE o.offer_id=? AND o.agent_id=? AND o.device_id=? AND o.connector_instance_id=?`)
        .get(offerId, descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId) as { status: ConnectorNextUpdateStatus; details_json: string; manifest_json: string } | undefined;
      if (!offer || !['staged', 'waiting_safe_window', 'activating', 'probation'].includes(offer.status)) throw new Error('CONNECTOR_NEXT.CANDIDATE_HEARTBEAT_NOT_ALLOWED');
      const manifest = parse<ConnectorNextUpdateManifest>(offer.manifest_json);
      if (descriptor.version !== manifest.version || descriptor.sequence !== manifest.sequence || descriptor.generation !== connector.generation + 1) throw new Error('CONNECTOR_NEXT.CANDIDATE_IDENTITY_MISMATCH');
      if (!descriptor.capabilities.includes(CONNECTOR_NEXT_HEALTH_OPERATION)) throw new Error('CONNECTOR_NEXT.CANDIDATE_CAPABILITIES_INVALID');
      const notStartedJobIds = [...new Set(uncertainJobIds as string[])].filter((jobId) => {
        const job = this.db.prepare(`SELECT status,execution_effect,error_json FROM connector_next_jobs WHERE job_id=? AND agent_id=? AND device_id=? AND connector_instance_id=?`)
          .get(jobId, descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId) as { status: string; execution_effect: string; error_json: string | null } | undefined;
        if (!job || job.status !== 'failed' || job.execution_effect !== 'mutation' || !job.error_json) return false;
        const error = parse<Record<string, unknown>>(job.error_json);
        return error.effectState === 'not_started';
      });
      const resolvedUncertainJobIds = [...new Set(uncertainJobIds as string[])].filter((jobId) =>
        notStartedJobIds.includes(jobId) || this.finalAckResolvesMutationJob(jobId, target));
      const rememberClosure = this.db.prepare(`INSERT OR IGNORE INTO connector_next_gate_closures(job_id,agent_id,device_id,connector_instance_id,proof_kind,created_at,consumed_at) VALUES(?,?,?,?,?,?,NULL)`);
      for (const jobId of resolvedUncertainJobIds) {
        rememberClosure.run(jobId, target.agentId, target.deviceId, target.connectorInstanceId,
          notStartedJobIds.includes(jobId) ? 'not_started' : 'final_ack', now());
      }
      const pendingClosures = this.db.prepare(`SELECT job_id,proof_kind FROM connector_next_gate_closures WHERE agent_id=? AND device_id=? AND connector_instance_id=? AND consumed_at IS NULL ORDER BY created_at LIMIT 128`)
        .all(target.agentId, target.deviceId, target.connectorInstanceId) as Array<{ job_id: string; proof_kind: 'not_started' | 'final_ack' }>;
      const pendingResolvedJobIds = pendingClosures.filter((closure) => closure.proof_kind === 'final_ack'
        ? this.finalAckResolvesMutationJob(closure.job_id, target)
        : (() => {
            const job = this.db.prepare(`SELECT status,execution_effect,error_json FROM connector_next_jobs WHERE job_id=? AND agent_id=? AND device_id=? AND connector_instance_id=?`)
              .get(closure.job_id, target.agentId, target.deviceId, target.connectorInstanceId) as { status: string; execution_effect: string; error_json: string | null } | undefined;
            return Boolean(job && job.status === 'failed' && job.execution_effect === 'mutation' && job.error_json
              && parse<Record<string, unknown>>(job.error_json).effectState === 'not_started');
          })()).map((closure) => closure.job_id);
      const authoritativeClosures = this.db.prepare(`SELECT job_id,proof_json FROM connector_next_authoritative_closures WHERE agent_id=? AND device_id=? AND connector_instance_id=? AND consumed_at IS NULL ORDER BY created_at LIMIT 128`)
        .all(target.agentId, target.deviceId, target.connectorInstanceId) as Array<{ job_id: string; proof_json: string }>;
      const pendingAuthoritativeJobIds = authoritativeClosures.filter((closure) => {
        try {
          const proof = parse<Record<string, unknown>>(closure.proof_json);
          const unsigned = { ...proof };
          const digest = unsigned.proofDigest;
          delete unsigned.proofDigest;
          return typeof digest === 'string' && digest === sha256(canonicalJson(unsigned));
        } catch { return false; }
      }).map((closure) => closure.job_id);
      const allResolvedJobIds = [...new Set([...resolvedUncertainJobIds, ...pendingResolvedJobIds, ...pendingAuthoritativeJobIds])];
      const details = { ...parse<Record<string, unknown>>(offer.details_json), [`${phase}Heartbeat`]: {
        version: descriptor.version,
        sequence: descriptor.sequence,
        generation: descriptor.generation,
        capabilities: descriptor.capabilities,
        executionPrincipal: descriptor.executionPrincipal,
        at: now(),
        gateDiagnostics
      } };
      this.db.prepare(`UPDATE connector_next_update_offers SET details_json=?,updated_at=? WHERE offer_id=?`).run(json(details), now(), offerId);
      this.audit('update_offer', offerId, `update.${phase}_heartbeat`, { version: descriptor.version, sequence: descriptor.sequence, generation: descriptor.generation, reconciledNotStarted: notStartedJobIds.length, reconciledAuthoritative: allResolvedJobIds.length - notStartedJobIds.length });
      return { accepted: true, offerId, phase, generation: descriptor.generation, notStartedJobIds, resolvedUncertainJobIds: allResolvedJobIds };
    });
  }

  downloadArtifact(descriptor: ConnectorNextDescriptor, offerId: string, artifactId: string): Buffer {
    const row = this.db.prepare(`SELECT o.status,a.package_bytes FROM connector_next_update_offers o JOIN connector_next_update_artifacts a ON a.artifact_id=o.artifact_id WHERE o.offer_id=? AND o.artifact_id=? AND o.agent_id=? AND o.device_id=? AND o.connector_instance_id=?`)
      .get(offerId, artifactId, descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId) as { status: string; package_bytes: Uint8Array } | undefined;
    if (!row) throw new Error('CONNECTOR_NEXT.UPDATE_OFFER_NOT_FOUND');
    if (row.status === 'offered') this.updateOfferStatus(descriptor, offerId, 'downloading', {});
    return Buffer.from(row.package_bytes);
  }

  updateOfferStatus(descriptor: ConnectorNextDescriptor, offerId: string, status: ConnectorNextUpdateStatus, details: Record<string, unknown>): void {
    const allowed: Record<ConnectorNextUpdateStatus, ConnectorNextUpdateStatus[]> = {
      offered: ['downloading', 'failed'],
      downloading: ['verified', 'failed'],
      verified: ['staged', 'failed'],
      staged: ['waiting_safe_window', 'activating', 'failed'],
      waiting_safe_window: ['waiting_safe_window', 'activating', 'failed'],
      activating: ['probation', 'rolled_back', 'failed'],
      probation: ['succeeded', 'rolled_back', 'failed'],
      succeeded: [], failed: [], rolled_back: []
    };
    this.transaction(() => {
      const row = this.db.prepare(`SELECT o.status,a.manifest_json FROM connector_next_update_offers o JOIN connector_next_update_artifacts a ON a.artifact_id=o.artifact_id WHERE o.offer_id=? AND o.agent_id=? AND o.device_id=? AND o.connector_instance_id=?`)
        .get(offerId, descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId) as { status: ConnectorNextUpdateStatus; manifest_json: string } | undefined;
      if (!row) throw new Error('CONNECTOR_NEXT.UPDATE_OFFER_NOT_FOUND');
      if (!allowed[row.status].includes(status)) throw new Error('CONNECTOR_NEXT.INVALID_UPDATE_TRANSITION');
      const currentDetails = this.db.prepare(`SELECT details_json FROM connector_next_update_offers WHERE offer_id=?`).get(offerId) as { details_json: string };
      const mergedDetails = { ...parse<Record<string, unknown>>(currentDetails.details_json), [status]: redactConnectorNextDetails(details) };
      this.db.prepare(`UPDATE connector_next_update_offers SET status=?,details_json=?,updated_at=? WHERE offer_id=?`).run(status, json(mergedDetails), now(), offerId);
      if (status === 'succeeded') {
        const manifest = parse<ConnectorNextUpdateManifest>(row.manifest_json);
        const probation = mergedDetails.probationHeartbeat as {
          version?: unknown; sequence?: unknown; generation?: unknown; capabilities?: unknown; executionPrincipal?: unknown;
        } | undefined;
        if (probation?.version !== manifest.version || probation.sequence !== manifest.sequence || probation.generation !== descriptor.generation + 1
          || !Array.isArray(probation.capabilities) || !probation.capabilities.every((capability) => typeof capability === 'string')
          || !probation.capabilities.includes(CONNECTOR_NEXT_HEALTH_OPERATION)
          || !probation.executionPrincipal || typeof probation.executionPrincipal !== 'object') {
          throw new Error('CONNECTOR_NEXT.PROBATION_IDENTITY_NOT_CONFIRMED');
        }
        const promoted = this.db.prepare(`UPDATE connector_next_connectors SET version=?,sequence=?,generation=generation+1,capabilities_json=?,execution_principal_json=?,last_seen_at=? WHERE agent_id=? AND device_id=? AND connector_instance_id=? AND generation=?`)
          .run(manifest.version, manifest.sequence, json(probation.capabilities), json(probation.executionPrincipal), now(), descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId, descriptor.generation);
        if (promoted.changes !== 1) throw new Error('CONNECTOR_NEXT.UPDATE_GENERATION_CAS_FAILED');
        this.db.prepare(`UPDATE connector_next_gate_closures SET consumed_at=? WHERE agent_id=? AND device_id=? AND connector_instance_id=? AND consumed_at IS NULL`)
          .run(now(), descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId);
        this.db.prepare(`UPDATE connector_next_authoritative_closures SET consumed_at=? WHERE agent_id=? AND device_id=? AND connector_instance_id=? AND consumed_at IS NULL`)
          .run(now(), descriptor.agentId, descriptor.deviceId, descriptor.connectorInstanceId);
      }
      this.audit('update_offer', offerId, `update.${status}`, details);
    });
  }

  getUpdateOffer(offerId: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT o.offer_id,o.status,o.agent_id,o.device_id,o.connector_instance_id,o.details_json,o.created_at,o.updated_at,a.manifest_json FROM connector_next_update_offers o JOIN connector_next_update_artifacts a ON a.artifact_id=o.artifact_id WHERE o.offer_id=?`).get(offerId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('CONNECTOR_NEXT.UPDATE_OFFER_NOT_FOUND');
    return { ...row, details: parse(String(row.details_json)), manifest: parse(String(row.manifest_json)), details_json: undefined, manifest_json: undefined };
  }
}
