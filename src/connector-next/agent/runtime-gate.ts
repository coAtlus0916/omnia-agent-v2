import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectorNextEffect } from '../protocol.js';

export interface RuntimeGateSnapshot {
  admitting: boolean;
  admissionMode: 'open' | 'read_only_only' | 'closed';
  activeReadOnly: number;
  activeMutation: number;
  uncertainMutation: number;
}

export class ConnectorNextRuntimeGate {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS runtime_gate(singleton INTEGER PRIMARY KEY CHECK(singleton=1),admitting INTEGER NOT NULL,updated_at TEXT NOT NULL);
      INSERT OR IGNORE INTO runtime_gate(singleton,admitting,updated_at) VALUES(1,1,datetime('now'));
      CREATE TABLE IF NOT EXISTS runtime_leases(
        lease_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect IN ('read_only','mutation')),
        status TEXT NOT NULL CHECK(status IN ('active','completed','uncertain')),
        process_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const gateColumns = this.db.prepare(`PRAGMA table_info(runtime_gate)`).all() as Array<{ name: string }>;
    if (!gateColumns.some((column) => column.name === 'admission_mode')) {
      this.db.exec(`ALTER TABLE runtime_gate ADD COLUMN admission_mode TEXT NOT NULL DEFAULT 'open'`);
      this.db.exec(`UPDATE runtime_gate SET admission_mode=CASE WHEN admitting=1 THEN 'open' ELSE 'closed' END`);
    }
  }

  close(): void { this.db.close(); }

  recoverInterrupted(): void {
    this.db.prepare(`UPDATE runtime_leases SET status='completed',updated_at=? WHERE status='active' AND effect='read_only'`).run(new Date().toISOString());
    this.db.prepare(`UPDATE runtime_leases SET status='uncertain',updated_at=? WHERE status='active' AND effect='mutation'`).run(new Date().toISOString());
  }

  setAdmission(admitting: boolean): void {
    this.setAdmissionMode(admitting ? 'open' : 'closed');
  }

  setAdmissionMode(mode: 'open' | 'read_only_only' | 'closed'): void {
    this.db.prepare(`UPDATE runtime_gate SET admitting=?,admission_mode=?,updated_at=? WHERE singleton=1`)
      .run(mode === 'closed' ? 0 : 1, mode, new Date().toISOString());
  }

  begin(jobId: string, effect: ConnectorNextEffect): string {
    const leaseId = `ocn3.lease.${randomUUID()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const gate = this.db.prepare(`SELECT admitting,admission_mode FROM runtime_gate WHERE singleton=1`).get() as { admitting: number; admission_mode: string };
      if (gate.admitting !== 1 || gate.admission_mode === 'closed'
        || (gate.admission_mode === 'read_only_only' && effect === 'mutation')) {
        throw new Error('CONNECTOR_NEXT.ADMISSION_CLOSED');
      }
      this.db.prepare(`INSERT INTO runtime_leases(lease_id,job_id,effect,status,process_id,created_at,updated_at) VALUES(?,?,?,'active',?,?,?)`)
        .run(leaseId, jobId, effect, process.pid, new Date().toISOString(), new Date().toISOString());
      this.db.exec('COMMIT');
      return leaseId;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  complete(leaseId: string): void {
    this.db.prepare(`UPDATE runtime_leases SET status='completed',updated_at=? WHERE lease_id=? AND status='active'`).run(new Date().toISOString(), leaseId);
  }

  markUncertain(leaseId: string): void {
    this.db.prepare(`UPDATE runtime_leases SET status='uncertain',updated_at=? WHERE lease_id=? AND status='active'`).run(new Date().toISOString(), leaseId);
  }

  uncertainMutationJobIds(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT job_id FROM runtime_leases WHERE effect='mutation' AND status='uncertain' ORDER BY job_id`).all() as Array<{ job_id: string }>;
    return rows.map((row) => row.job_id);
  }

  resolveMutationNotStarted(jobId: string): number {
    return Number(this.db.prepare(`UPDATE runtime_leases SET status='completed',updated_at=? WHERE job_id=? AND effect='mutation' AND status='uncertain'`)
      .run(new Date().toISOString(), jobId).changes);
  }

  snapshot(): RuntimeGateSnapshot {
    const gate = this.db.prepare(`SELECT admitting,admission_mode FROM runtime_gate WHERE singleton=1`).get() as { admitting: number; admission_mode: string };
    const rows = this.db.prepare(`SELECT effect,status,COUNT(*) count FROM runtime_leases WHERE status IN ('active','uncertain') GROUP BY effect,status`).all() as Array<{ effect: ConnectorNextEffect; status: string; count: number }>;
    const count = (effect: ConnectorNextEffect, status: string) => rows.find((row) => row.effect === effect && row.status === status)?.count || 0;
    const admissionMode = ['open', 'read_only_only', 'closed'].includes(gate.admission_mode)
      ? gate.admission_mode as RuntimeGateSnapshot['admissionMode']
      : gate.admitting === 1 ? 'open' : 'closed';
    return { admitting: admissionMode !== 'closed', admissionMode, activeReadOnly: count('read_only', 'active'), activeMutation: count('mutation', 'active'), uncertainMutation: count('mutation', 'uncertain') };
  }
}
