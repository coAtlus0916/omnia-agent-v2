import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectorNextTarget } from '../../connector-next/protocol.js';
import type { ConnectorNextControlClient } from './connector-next-control-client.js';

export class ConnectorNextShellBindingStore {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS connector_next_shell_binding(
        agent_id TEXT NOT NULL,device_id TEXT NOT NULL,connector_instance_id TEXT NOT NULL,
        enrollment_session_id TEXT,enrollment_state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,device_id)
      );
    `);
  }
  close(): void { this.db.close(); }
  binding(agentId: string, deviceId: string): (ConnectorNextTarget & { enrollmentSessionId: string; enrollmentState: string; updatedAt: string }) | null {
    const row = this.db.prepare(`SELECT connector_instance_id,enrollment_session_id,enrollment_state,updated_at FROM connector_next_shell_binding WHERE agent_id=? AND device_id=?`)
      .get(agentId, deviceId) as { connector_instance_id: string; enrollment_session_id: string | null; enrollment_state: string; updated_at: string } | undefined;
    return row ? {
      agentId,
      deviceId,
      connectorInstanceId: row.connector_instance_id,
      enrollmentSessionId: row.enrollment_session_id || '',
      enrollmentState: row.enrollment_state,
      updatedAt: row.updated_at
    } : null;
  }
  stableTarget(agentId: string, deviceId: string): ConnectorNextTarget {
    if (!agentId || !deviceId) throw new Error('CONNECTOR_NEXT.STABLE_AGENT_DEVICE_ID_REQUIRED');
    const existing = this.db.prepare(`SELECT connector_instance_id FROM connector_next_shell_binding WHERE agent_id=? AND device_id=?`).get(agentId, deviceId) as { connector_instance_id: string } | undefined;
    if (existing) return { agentId, deviceId, connectorInstanceId: existing.connector_instance_id };
    const connectorInstanceId = `omnia.connector-next.instance.${randomUUID()}`;
    this.db.prepare(`INSERT INTO connector_next_shell_binding(agent_id,device_id,connector_instance_id,enrollment_state,created_at,updated_at) VALUES(?,?,?,'not_started',?,?)`)
      .run(agentId, deviceId, connectorInstanceId, new Date().toISOString(), new Date().toISOString());
    return { agentId, deviceId, connectorInstanceId };
  }
  async beginEnrollment(client: ConnectorNextControlClient, agentId: string, deviceId: string): Promise<{ sessionId: string; enrollmentCode: string; target: ConnectorNextTarget; expiresAt: string }> {
    const target = this.stableTarget(agentId, deviceId);
    const created = await client.createEnrollment(target);
    this.db.prepare(`UPDATE connector_next_shell_binding SET enrollment_session_id=?,enrollment_state='waiting',updated_at=? WHERE agent_id=? AND device_id=?`)
      .run(created.sessionId, new Date().toISOString(), agentId, deviceId);
    return created;
  }
  markEnrollmentState(target: ConnectorNextTarget, state: 'waiting' | 'enrolled' | 'expired' | 'failed'): void {
    this.db.prepare(`UPDATE connector_next_shell_binding SET enrollment_state=?,updated_at=? WHERE agent_id=? AND device_id=? AND connector_instance_id=?`)
      .run(state, new Date().toISOString(), target.agentId, target.deviceId, target.connectorInstanceId);
  }

  async refreshEnrollment(client: ConnectorNextControlClient, agentId: string, deviceId: string): Promise<ConnectorNextTarget & { enrollmentSessionId: string; enrollmentState: string; updatedAt: string }> {
    const binding = this.binding(agentId, deviceId);
    if (!binding?.enrollmentSessionId) throw new Error('CONNECTOR_NEXT.ENROLLMENT_NOT_STARTED');
    const observed = await client.getEnrollment(binding.enrollmentSessionId) as {
      agent_id?: string; device_id?: string; connector_instance_id?: string; state?: string;
    };
    if (observed.agent_id !== binding.agentId || observed.device_id !== binding.deviceId || observed.connector_instance_id !== binding.connectorInstanceId
      || !['waiting', 'enrolled', 'expired'].includes(observed.state || '')) throw new Error('CONNECTOR_NEXT.ENROLLMENT_STATUS_IDENTITY_MISMATCH');
    this.markEnrollmentState(binding, observed.state as 'waiting' | 'enrolled' | 'expired');
    return this.binding(agentId, deviceId)!;
  }
}
