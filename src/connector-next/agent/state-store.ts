import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectorNextTarget } from '../protocol.js';
import { protectConnectorNextCredential, unprotectConnectorNextCredential } from './credential-protection.js';

export interface ConnectorNextAgentState extends ConnectorNextTarget {
  serverUrl: string;
  token: string;
  version: string;
  sequence: number;
  generation: number;
}

export class ConnectorNextAgentStateStore {
  readonly db: DatabaseSync;
  private readonly dataRoot: string;
  constructor(filename: string) {
    this.dataRoot = path.dirname(filename);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS agent_identity(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),server_url TEXT NOT NULL,agent_id TEXT NOT NULL,device_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,token TEXT NOT NULL,version TEXT NOT NULL,sequence INTEGER NOT NULL,generation INTEGER NOT NULL,updated_at TEXT NOT NULL
      );
    `);
  }
  close(): void { this.db.close(); }
  save(value: ConnectorNextAgentState): void {
    this.db.prepare(`INSERT INTO agent_identity(singleton,server_url,agent_id,device_id,connector_instance_id,token,version,sequence,generation,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET server_url=excluded.server_url,agent_id=excluded.agent_id,device_id=excluded.device_id,connector_instance_id=excluded.connector_instance_id,token=excluded.token,version=excluded.version,sequence=excluded.sequence,generation=excluded.generation,updated_at=excluded.updated_at`)
      .run(value.serverUrl, value.agentId, value.deviceId, value.connectorInstanceId, protectConnectorNextCredential(value.token, this.dataRoot), value.version, value.sequence, value.generation, new Date().toISOString());
  }
  load(): ConnectorNextAgentState {
    const row = this.db.prepare(`SELECT server_url,agent_id,device_id,connector_instance_id,token,version,sequence,generation FROM agent_identity WHERE singleton=1`).get() as {
      server_url: string; agent_id: string; device_id: string; connector_instance_id: string; token: string; version: string; sequence: number; generation: number;
    } | undefined;
    if (!row) throw new Error('CONNECTOR_NEXT.AGENT_NOT_ENROLLED');
    return { serverUrl: row.server_url, agentId: row.agent_id, deviceId: row.device_id, connectorInstanceId: row.connector_instance_id, token: unprotectConnectorNextCredential(row.token, this.dataRoot), version: row.version, sequence: row.sequence, generation: row.generation };
  }
}
