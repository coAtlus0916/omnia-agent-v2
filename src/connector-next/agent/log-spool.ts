import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectorNextLogInput, ConnectorNextLogSeverity, ConnectorNextLogSource } from '../protocol.js';
import { redactConnectorNextDetails } from '../redaction.js';
import type { ConnectorNextAgentClient } from './client.js';

export class ConnectorNextLogSpool {
  readonly db: DatabaseSync;

  constructor(filename: string, private readonly capacityBytes = 16 * 1024 * 1024) {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 64 * 1024) throw new Error('CONNECTOR_NEXT.INVALID_LOG_CAPACITY');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS spool_records (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        event TEXT NOT NULL,
        details_json TEXT NOT NULL,
        approx_bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spool_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
  }

  close(): void { this.db.close(); }

  append(source: ConnectorNextLogSource, severity: ConnectorNextLogSeverity, event: string, details: Record<string, unknown> = {}): number {
    const safeDetails = redactConnectorNextDetails(details);
    const detailsJson = JSON.stringify(safeDetails);
    const approxBytes = Buffer.byteLength(detailsJson) + Buffer.byteLength(event) + 128;
    const inserted = this.db.prepare(`INSERT INTO spool_records(occurred_at,source,severity,event,details_json,approx_bytes) VALUES(?,?,?,?,?,?)`)
      .run(new Date().toISOString(), source, severity, event.slice(0, 160), detailsJson, approxBytes);
    this.enforceCapacity();
    return Number(inserted.lastInsertRowid);
  }

  private enforceCapacity(): void {
    const row = this.db.prepare(`SELECT COALESCE(SUM(approx_bytes),0) total FROM spool_records`).get() as { total: number };
    if (row.total <= this.capacityBytes) return;
    let removed = 0;
    let removedBytes = 0;
    while (row.total - removedBytes > Math.floor(this.capacityBytes * 0.9)) {
      const oldest = this.db.prepare(`SELECT record_id,approx_bytes FROM spool_records ORDER BY record_id LIMIT 1`).get() as { record_id: number; approx_bytes: number } | undefined;
      if (!oldest) break;
      this.db.prepare(`DELETE FROM spool_records WHERE record_id=?`).run(oldest.record_id);
      removed += 1;
      removedBytes += oldest.approx_bytes;
    }
    const details = JSON.stringify({ removedRecords: removed, removedBytes, capacityBytes: this.capacityBytes, reason: 'bounded_offline_spool_capacity' });
    this.db.prepare(`INSERT INTO spool_records(occurred_at,source,severity,event,details_json,approx_bytes) VALUES(?,?,?,?,?,?)`)
      .run(new Date().toISOString(), 'audit', 'error', 'spool.capacity_eviction', details, Buffer.byteLength(details) + 128);
  }

  pending(limit = 200): ConnectorNextLogInput[] {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    return (this.db.prepare(`SELECT record_id,occurred_at,source,severity,event,details_json FROM spool_records ORDER BY record_id LIMIT ?`).all(safeLimit) as Array<{
      record_id: number; occurred_at: string; source: ConnectorNextLogSource; severity: ConnectorNextLogSeverity; event: string; details_json: string;
    }>).map((row) => ({ recordId: row.record_id, occurredAt: row.occurred_at, source: row.source, severity: row.severity, event: row.event, details: JSON.parse(row.details_json) as Record<string, unknown> }));
  }

  acknowledge(recordIds: number[]): number {
    if (recordIds.length === 0) return 0;
    let deleted = 0;
    const statement = this.db.prepare(`DELETE FROM spool_records WHERE record_id=?`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of recordIds) deleted += Number(statement.run(id).changes);
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async flush(client: ConnectorNextAgentClient, limit = 200): Promise<number> {
    const records = this.pending(limit);
    if (records.length === 0) return 0;
    const response = await client.uploadLogs(records);
    const offered = new Set(records.map((record) => record.recordId));
    if (response.ackedRecordIds.some((id) => !offered.has(id))) throw new Error('CONNECTOR_NEXT.INVALID_LOG_ACK');
    return this.acknowledge(response.ackedRecordIds);
  }

  stats(): { records: number; bytes: number; capacityBytes: number } {
    const row = this.db.prepare(`SELECT COUNT(*) records,COALESCE(SUM(approx_bytes),0) bytes FROM spool_records`).get() as { records: number; bytes: number };
    return { ...row, capacityBytes: this.capacityBytes };
  }
}
