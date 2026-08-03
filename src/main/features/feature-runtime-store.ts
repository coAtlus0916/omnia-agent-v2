import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProductPaths } from '../paths.js';
import type { FeatureWorkerPortContext } from './worker-supervisor.js';

function now(): string { return new Date().toISOString(); }

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, any>;
}

export class FeatureRuntimeStore {
  constructor(
    private readonly core: DatabaseSync,
    private readonly paths: ProductPaths
  ) {}

  private open(featureId: string): DatabaseSync {
    const database = new DatabaseSync(path.join(this.paths.data, 'features', featureId, 'store.sqlite'));
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS "__runtime_plans" (
        plan_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "__runtime_evidence" (
        evidence_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        checkpoint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
    return database;
  }

  call(method: string, input: unknown, context: FeatureWorkerPortContext): unknown {
    if (method === 'upsertManagedContent') return this.upsertManagedContent(input, context);
    const store = this.open(context.featureId);
    try {
      if (method === 'savePlan') {
        const plan = object(input, 'Feature plan');
        const planId = String(plan.planId || '');
        if (!planId) throw new Error('Feature plan identity is missing.');
        store.prepare(`
          INSERT INTO "__runtime_plans"(plan_id, payload_json, updated_at) VALUES(?, ?, ?)
          ON CONFLICT(plan_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
        `).run(planId, JSON.stringify(plan), now());
        return true;
      }
      if (method === 'loadPlan') {
        const row = store.prepare('SELECT payload_json FROM "__runtime_plans" WHERE plan_id=?')
          .get(String(input || '')) as { payload_json: string } | undefined;
        return row ? JSON.parse(row.payload_json) : null;
      }
      if (method === 'appendEvidence') {
        const evidence = object(input, 'Feature evidence');
        store.prepare(`
          INSERT INTO "__runtime_evidence"(evidence_id, plan_id, checkpoint, payload_json, occurred_at)
          VALUES(?, ?, ?, ?, ?)
        `).run(
          randomUUID(), String(evidence.planId || ''), String(evidence.checkpoint || ''),
          JSON.stringify(evidence), String(evidence.occurredAt || now())
        );
        return true;
      }
      throw new Error(`Feature store method is not allowlisted: ${method}`);
    } finally {
      store.close();
    }
  }

  emit(input: unknown, context: FeatureWorkerPortContext): string {
    const event = object(input, 'Feature event');
    if (event.type !== 'workspace.authoritative_refresh_requested') {
      throw new Error('Feature event type is not allowlisted.');
    }
    const eventId = randomUUID();
    this.core.prepare(`
      INSERT INTO feature_runtime_events(
        event_id, feature_id, feature_version, event_type, payload_json, status, created_at, completed_at, error
      ) VALUES(?, ?, ?, ?, ?, 'pending', ?, '', '')
    `).run(eventId, context.featureId, context.featureVersion, event.type, JSON.stringify(event), now());
    return eventId;
  }

  private upsertManagedContent(input: unknown, context: FeatureWorkerPortContext): true {
    const record = object(input, 'Managed content record');
    const occurredAt = String(record.tombstoneAt || now());
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      this.core.prepare(`
        INSERT INTO managed_content_records(
          engagement_id, object_type, object_id, status, feature_id, feature_version,
          plan_id, payload_json, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(engagement_id, object_type, object_id) DO UPDATE SET
          status=excluded.status, feature_id=excluded.feature_id, feature_version=excluded.feature_version,
          plan_id=excluded.plan_id, payload_json=excluded.payload_json, updated_at=excluded.updated_at
      `).run(
        String(record.engagementId || ''), String(record.objectType || ''), String(record.objectId || ''),
        String(record.status || ''), context.featureId, context.featureVersion,
        String(record.planId || ''), JSON.stringify(record), occurredAt
      );
      this.core.prepare(`
        INSERT INTO managed_content_changes(
          change_id, engagement_id, object_type, object_id, change_type,
          feature_id, feature_version, plan_id, payload_json, occurred_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), String(record.engagementId || ''), String(record.objectType || ''), String(record.objectId || ''),
        String(record.status || ''), context.featureId, context.featureVersion,
        String(record.planId || ''), JSON.stringify(record), occurredAt
      );
      this.core.exec('COMMIT;');
      return true;
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
  }
}
