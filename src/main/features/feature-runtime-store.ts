import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProductPaths } from '../paths.js';
import type { FeatureReviewValidationCommit } from '../../shared/feature-contracts.js';
import type { FeatureWorkerPortContext } from './worker-supervisor.js';

function now(): string { return new Date().toISOString(); }

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, any>;
}
function canonical(value: unknown): string {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Canonical payload contains an unsupported value.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
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

  private runtimePlanTables(store: DatabaseSync): string[] {
    const tables = store.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE WHEN name='__runtime_plans' THEN 0 ELSE 1 END, name
    `).all() as Array<{ name: string }>;
    return tables.map((row) => row.name).filter((table) => {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const columns = store.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      return columns.length === 3
        && names.has('plan_id') && names.has('payload_json') && names.has('updated_at');
    });
  }

  private findRuntimePlan(store: DatabaseSync, planId: string): { table: string; payload_json: string; updated_at: string } | undefined {
    return this.runtimePlanTables(store).flatMap((table) => {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const row = store.prepare(`SELECT payload_json,updated_at FROM ${quoted} WHERE plan_id=?`).get(planId) as {
        payload_json: string;
        updated_at: string;
      } | undefined;
      return row ? [{ table, ...row }] : [];
    }).sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  }

  call(method: string, input: unknown, context: FeatureWorkerPortContext): unknown {
    if (method === 'upsertManagedContent') return this.upsertManagedContent(input, context);
    if (method === 'readArtifactBytes') return this.readArtifactBytes(input, context);
    if (method === 'readManagedAssetBytes') return this.readManagedAssetBytes(input, context);
    if (method === 'commitArtifact') return this.commitArtifact(input, context);
    if (method === 'commitStandaloneArtifact') return this.commitStandaloneArtifact(input, context);
    if (method === 'recordTemplateMetadata') return this.recordTemplateMetadata(input, context);
    if (method === 'loadLatestRun') return this.loadLatestRun(context);
    if (method === 'transitionRun') return this.transitionRun(input, context);
    if (method === 'recordFieldRevisions') return this.recordFieldRevisions(input, context);
    if (method === 'recordIssues') return this.recordIssues(input, context);
    if (method === 'loadRunReview') return this.loadRunReview(input, context);
    if (method === 'applyIssueRevisions') return this.applyIssueRevisions(input, context);
    if (method === 'commitReviewValidation') return this.commitReviewValidation(input, context);
    if (method === 'prepareReturnIntent') return this.prepareReturnIntent(input, context);
    if (method === 'approveReturnIntent') return this.approveReturnIntent(input, context);
    if (method === 'prepareReturnCommand') return this.prepareReturnCommand(input, context);
    if (method === 'freezeReturnEvidenceSpec') return this.freezeReturnEvidenceSpec(input, context);
    if (method === 'recordReturnEvidence') return this.recordReturnEvidence(input, context);
    if (method === 'projectVerifiedReturn') return this.projectVerifiedReturn(input, context);
    if (method === 'finishReturn') return this.finishReturn(input, context);
    if (method === 'recordBootstrapCapabilityEvidence') return this.recordBootstrapCapabilityEvidence(input, context);
    if (method === 'getCapabilityEvidenceState') {
      const request=object(input,'Capability evidence lookup'); const binding=object(request.connectorBinding,'Capability evidence binding');
      const workspaceIds=Array.isArray(request.workspaceIds)?[...new Set(request.workspaceIds.map(String))]:[];
      if(!binding.authorityInstanceId||!binding.tenantOrOrgId||!binding.packId||!binding.engagementId||workspaceIds.length<1)return{verified:false};
      const count=this.core.prepare(`SELECT COUNT(DISTINCT workspace_id) AS count FROM feature_capability_evidence WHERE feature_id=? AND feature_version=? AND scenario_id=? AND capability_id=? AND authority_instance_id=? AND tenant_or_org_id=? AND pack_contract_id=? AND engagement_id=? AND workspace_id IN (${workspaceIds.map(()=>'?').join(',')}) AND automated_status='passed' AND portable_status='passed' AND canary_status='passed' AND readback_status='passed' AND verified=1 AND revoked_at='' AND expires_at>?`).get(context.featureId,context.featureVersion,String(request.scenarioId||''),String(request.capabilityId||''),String(binding.authorityInstanceId),String(binding.tenantOrOrgId),String(binding.packId),String(binding.engagementId),...workspaceIds,now()) as {count:number};
      return{verified:count.count===workspaceIds.length};
    }
    if (method === 'validateReturnAuthority') return this.validateReturnAuthority(input, context);
    if (method === 'loadReturnProgress') {
      const request=object(input,'Return progress'); const runId=String(request.runId||'');
      if(!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`).get(runId,context.featureId,context.featureVersion)) throw new Error('Return progress Run is not owned by this Feature.');
      return this.core.prepare(`SELECT target_key,state FROM managed_content_intents WHERE run_id=? ORDER BY created_at`).all(runId);
    }
    if (method === 'saveReturnReconcileSpec') {
      const request=object(input,'Return reconcile specification'); const commandId=String(request.commandId||''); const runId=String(request.runId||'');
      const command=this.core.prepare(`SELECT state FROM feature_commands WHERE command_id=? AND run_id=?`).get(commandId,runId) as {state:string}|undefined;
      if(!command||!['prepared','submitted'].includes(command.state)) throw new Error('Reconcile specification must precede or accompany mutation submission.');
      const spec=object(request.spec,'Serializable reconcile specification'); const encoded=JSON.stringify(spec);
      if(encoded.length>256_000) throw new Error('Reconcile specification exceeds the bounded Store contract.');
      this.core.prepare(`INSERT INTO feature_command_specs(command_id,run_id,spec_json,created_at) VALUES(?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET spec_json=excluded.spec_json`).run(commandId,runId,encoded,now()); return true;
    }
    if (method === 'loadReturnReconcileSpec') {
      const request=object(input,'Return reconcile lookup'); const runId=String(request.runId||'');
      const row=this.core.prepare(`SELECT s.spec_json FROM feature_command_specs s JOIN feature_commands c ON c.command_id=s.command_id AND c.run_id=s.run_id JOIN feature_runs r ON r.run_id=c.run_id WHERE s.run_id=? AND c.state='uncertain' AND r.feature_id=? AND r.feature_version=? ORDER BY s.created_at DESC LIMIT 1`).get(runId,context.featureId,context.featureVersion) as {spec_json:string}|undefined;
      return row?JSON.parse(row.spec_json):null;
    }
    const store = this.open(context.featureId);
    try {
      if (method === 'savePlan') {
        const plan = object(input, 'Feature plan');
        const planId = String(plan.planId || '');
        if (!planId) throw new Error('Feature plan identity is missing.');
        const table = this.findRuntimePlan(store, planId)?.table || '__runtime_plans';
        const quoted = `"${table.replaceAll('"', '""')}"`;
        store.prepare(`
          INSERT INTO ${quoted}(plan_id, payload_json, updated_at) VALUES(?, ?, ?)
          ON CONFLICT(plan_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
        `).run(planId, JSON.stringify(plan), now());
        return true;
      }
      if (method === 'loadPlan') {
        const row = this.findRuntimePlan(store, String(input || ''));
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
        const revision = store.prepare(`SELECT COUNT(*) AS count FROM "__runtime_evidence"`).get() as { count: number };
        return { revision: Math.max(1, revision.count) };
      }
      throw new Error(`Feature store method is not allowlisted: ${method}`);
    } finally {
      store.close();
    }
  }

  private loadLatestRun(context: FeatureWorkerPortContext): Record<string, unknown> | null {
    let run = this.core.prepare(`
      SELECT * FROM feature_runs WHERE feature_id=? AND feature_version=? ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1
    `).get(context.featureId, context.featureVersion) as Record<string, unknown> | undefined;
    if (!run) return null;
    if(run.state==='reconciling'){
      const recoveredAt=now();
      this.core.exec('BEGIN IMMEDIATE;');
      try{
        const updated=this.core.prepare(`UPDATE feature_runs SET state='uncertain',state_revision=state_revision+1,last_error='Read-only reconcile was interrupted; no mutation was replayed.',updated_at=? WHERE run_id=? AND state='reconciling'`).run(recoveredAt,String(run.run_id));
        if(updated.changes===1)this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'reconciling','uncertain','return.reconcile_crash_recovered','{}',? FROM feature_runs WHERE run_id=?`).run(randomUUID(),recoveredAt,String(run.run_id));
        this.core.exec('COMMIT;');
      }catch(error){this.core.exec('ROLLBACK;');throw error;}
      run=this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(String(run.run_id)) as Record<string,unknown>;
    }
    if (run.state === 'returning') {
      const stranded = this.core.prepare(`SELECT command_id,intent_id FROM feature_commands WHERE run_id=? AND state IN ('submitted','committed') ORDER BY created_at LIMIT 1`)
        .get(String(run.run_id)) as {command_id:string;intent_id:string}|undefined;
      if (stranded) {
        const recoveredAt = now();
        this.core.exec('BEGIN IMMEDIATE;');
        try {
          this.core.prepare(`UPDATE feature_commands SET state='uncertain',last_error='Worker exited after mutation submission; read-only reconcile is required.' WHERE command_id=? AND state IN ('submitted','committed')`).run(stranded.command_id);
          this.core.prepare(`UPDATE managed_content_intents SET state='uncertain',updated_at=? WHERE intent_id=?`).run(recoveredAt,stranded.intent_id);
          this.core.prepare(`UPDATE feature_runs SET state='uncertain',state_revision=state_revision+1,last_error='Recovered an in-flight mutation without a verified response.',updated_at=? WHERE run_id=? AND state='returning'`).run(recoveredAt,String(run.run_id));
          this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'returning','uncertain','return.crash_recovered',?,? FROM feature_runs WHERE run_id=?`).run(randomUUID(),JSON.stringify({commandId:stranded.command_id}),recoveredAt,String(run.run_id));
          this.core.exec('COMMIT;');
        } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
        run = this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(String(run.run_id)) as Record<string,unknown>;
      }else{
        const pending=this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state='prepared'`).get(String(run.run_id)) as {count:number};
        if((pending.count>0||this.core.prepare(`SELECT 1 FROM feature_confirmations WHERE run_id=? AND decision='approved'`).get(String(run.run_id)))&&String(run.last_error||'')!=='Recovered a confirmed Return before mutation submission; explicit continuation is required.'){
          const recoveredAt=now();
          this.core.prepare(`UPDATE feature_runs SET state_revision=state_revision+1,last_error='Recovered a confirmed Return before mutation submission; explicit continuation is required.',updated_at=? WHERE run_id=? AND state='returning'`).run(recoveredAt,String(run.run_id));
          this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'returning','returning','return.pre_submit_crash_recovered',?,? FROM feature_runs WHERE run_id=?`).run(randomUUID(),JSON.stringify({preparedCommands:pending.count}),recoveredAt,String(run.run_id));
          run=this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(String(run.run_id)) as Record<string,unknown>;
        }
      }
    }
    const issues = this.core.prepare(`
      SELECT issue_id, field_key, issue_type, state, message, resolution_revision_id
      FROM feature_issues WHERE run_id=? ORDER BY created_at, issue_id
    `).all(String(run.run_id));
    const artifacts = this.core.prepare(`
      SELECT artifact_id, kind, original_name, sha256, size_bytes
      FROM feature_artifacts WHERE run_id=? ORDER BY created_at, artifact_id
    `).all(String(run.run_id));
    const events=this.core.prepare(`SELECT event_id,revision,from_state,to_state,event_type,details_json,occurred_at FROM feature_run_events WHERE run_id=? ORDER BY revision,event_id`).all(String(run.run_id));
    const returnProgress=this.core.prepare(`
      SELECT i.target_key,i.target_kind,i.state,
        COALESCE((SELECT c.state FROM feature_commands c WHERE c.intent_id=i.intent_id ORDER BY c.created_at DESC LIMIT 1),'pending') AS command_state
      FROM managed_content_intents i WHERE i.run_id=? ORDER BY i.created_at,i.intent_id
    `).all(String(run.run_id));
    return { run, issues, artifacts, events, returnProgress };
  }

  private readArtifactBytes(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const artifactId = String(object(input, 'Artifact request').artifactId || '');
    const row = this.core.prepare(`
      SELECT a.artifact_id, a.run_id, r.trace_id, a.kind, a.original_name, a.media_type,
             a.managed_path, a.sha256, a.size_bytes, a.imported_at
      FROM feature_artifacts a
      JOIN feature_runs r ON r.run_id=a.run_id AND r.feature_id=a.feature_id
      WHERE a.artifact_id=? AND a.feature_id=?
    `).get(artifactId, context.featureId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Managed Feature artifact was not found.');
    const managedPath = path.resolve(this.paths.data, ...String(row.managed_path).split('/'));
    const root = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
    if (!managedPath.startsWith(`${root}${path.sep}`) || !fs.statSync(managedPath).isFile()) {
      throw new Error('Managed Feature artifact path is invalid.');
    }
    const bytes = fs.readFileSync(managedPath);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Managed Feature artifact exceeds the worker transfer limit.');
    const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualDigest !== row.sha256 || bytes.length !== Number(row.size_bytes)) {
      throw new Error('Managed Feature artifact bytes drifted from their durable digest or size.');
    }
    return {
      artifactId: String(row.artifact_id), runId: String(row.run_id), traceId: String(row.trace_id),
      kind: String(row.kind), originalName: String(row.original_name),
      mediaType: String(row.media_type), sha256: String(row.sha256), sizeBytes: Number(row.size_bytes),
      importedAt: String(row.imported_at), contentBase64: bytes.toString('base64')
    };
  }

  private readManagedAssetBytes(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Managed asset request');
    const memberPath = String(request.memberPath || '');
    if (!/^backend\/[A-Za-z0-9._/-]{1,240}$/u.test(memberPath) || memberPath.includes('..')) {
      throw new Error('Managed asset member path is invalid.');
    }
    const row = this.core.prepare(`
      SELECT package_digest, member_path, member_digest, asset_kind, managed_path, imported_at
      FROM feature_managed_assets
      WHERE feature_id=? AND feature_version=? AND member_path=?
    `).get(context.featureId, context.featureVersion, memberPath) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Managed Feature asset was not found for the active Feature version.');
    const managedPath = path.resolve(this.paths.data, ...String(row.managed_path).split('/'));
    const installedRoot = path.resolve(this.paths.data, 'packages', 'installed', context.featureId, context.featureVersion);
    if (!managedPath.startsWith(`${installedRoot}${path.sep}`) || !fs.statSync(managedPath).isFile()) {
      throw new Error('Managed Feature asset path is invalid.');
    }
    const bytes = fs.readFileSync(managedPath);
    if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) throw new Error('Managed Feature asset size is invalid.');
    const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualDigest !== row.member_digest) throw new Error('Managed Feature asset digest drifted from the signed package manifest.');
    return {
      packageDigest: String(row.package_digest), memberPath: String(row.member_path),
      memberDigest: String(row.member_digest), assetKind: String(row.asset_kind),
      importedAt: String(row.imported_at), sizeBytes: bytes.length, contentBase64: bytes.toString('base64')
    };
  }

  private commitArtifact(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Artifact commit');
    if (!['template_candidate', 'template_instance', 'result', 'evidence'].includes(String(request.kind || ''))) {
      throw new Error('Artifact commit kind is not allowlisted.');
    }
    if (typeof request.contentBase64 !== 'string' || typeof request.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(request.sha256)) {
      throw new Error('Artifact commit requires strict base64 bytes and a lowercase SHA-256 digest.');
    }
    const bytes = Buffer.from(request.contentBase64, 'base64');
    if (bytes.toString('base64') !== request.contentBase64) throw new Error('Artifact commit base64 is not canonical.');
    if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) throw new Error('Artifact commit payload size is invalid.');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (request.sha256 && String(request.sha256).toLowerCase() !== sha256) throw new Error('Artifact commit digest mismatch.');
    const artifactId = randomUUID();
    const runId = String(request.runId || '');
    const sourceArtifactId = String(request.sourceArtifactId || '');
    const run = this.core.prepare(`
      SELECT source_artifact_id FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?
    `).get(runId, context.featureId, context.featureVersion) as { source_artifact_id: string } | undefined;
    if (!run) throw new Error('Artifact commit Run is unavailable for the active Feature version.');
    if (!sourceArtifactId || sourceArtifactId !== run.source_artifact_id) {
      throw new Error('Artifact commit source artifact is not owned by the Run.');
    }
    const extension = String(request.extension || '');
    if (!/^\.[a-z0-9]{1,12}$/u.test(extension)) throw new Error('Artifact extension is invalid.');
    const relative = path.posix.join('features', context.featureId, 'artifacts', artifactId, `artifact${extension}`);
    const destination = path.resolve(this.paths.data, ...relative.split('/'));
    const root = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('Artifact commit path escaped its Feature root.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    const createdAt = now();
    try {
      this.core.prepare(`
        INSERT INTO feature_artifacts(
        artifact_id, run_id, feature_id, kind, media_type, original_name, source_kind, source_ref,
        managed_path, sha256, size_bytes, source_version, imported_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'worker_output', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifactId, runId, context.featureId, String(request.kind),
        String(request.mediaType || 'application/octet-stream'), path.basename(String(request.originalName || `artifact${extension}`)),
        sourceArtifactId, relative, sha256, bytes.length, context.featureVersion, createdAt, createdAt
      );
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    }
    return { artifactId, sha256, sizeBytes: bytes.length, createdAt };
  }

  private commitStandaloneArtifact(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Standalone Artifact commit');
    const kind = String(request.kind || '');
    if (!['result', 'evidence'].includes(kind)) throw new Error('Standalone Artifact kind is not allowlisted.');
    if (typeof request.contentBase64 !== 'string') throw new Error('Standalone Artifact requires strict base64 bytes.');
    const bytes = Buffer.from(request.contentBase64, 'base64');
    if (bytes.toString('base64') !== request.contentBase64) throw new Error('Standalone Artifact base64 is not canonical.');
    if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) throw new Error('Standalone Artifact payload size is invalid.');
    const originalName = path.basename(String(request.originalName || ''));
    if (!originalName || originalName !== String(request.originalName) || originalName.length > 255) throw new Error('Standalone Artifact name is invalid.');
    const extension = path.extname(originalName).toLowerCase();
    if (!/^\.[a-z0-9]{1,12}$/u.test(extension)) throw new Error('Standalone Artifact extension is invalid.');
    const engagementId = String(request.engagementId || '');
    if (engagementId.length > 200) throw new Error('Standalone Artifact Engagement identity is invalid.');
    const surfaceId = String(request.surfaceId || '');
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(surfaceId)) throw new Error('Standalone Artifact Surface identity is invalid.');
    const artifactId = randomUUID();
    const runId = randomUUID();
    const traceId = randomUUID();
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const createdAt = now();
    const relative = path.posix.join('features', context.featureId, 'artifacts', artifactId, `artifact${extension}`);
    const destination = path.resolve(this.paths.data, ...relative.split('/'));
    const root = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('Standalone Artifact path escaped its Feature root.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    try {
      this.core.exec('BEGIN IMMEDIATE;');
      this.core.prepare(`
        INSERT INTO feature_runs(
          run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
          source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
        ) VALUES(?,?,?,?,?,'succeeded',1,'','',?,'','',?,?)
      `).run(runId, traceId, context.featureId, context.featureVersion, engagementId, artifactId, createdAt, createdAt);
      this.core.prepare(`
        INSERT INTO feature_artifacts(
          artifact_id,run_id,feature_id,kind,media_type,original_name,source_kind,source_ref,
          managed_path,sha256,size_bytes,source_version,imported_at,created_at
        ) VALUES(?,?,?,?,?,?,'connector_evidence',?,?,?,?,?,?,?)
      `).run(
        artifactId, runId, context.featureId, kind, String(request.mediaType || 'application/octet-stream'), originalName,
        String(request.sourceRef || ''), relative, sha256, bytes.length, context.featureVersion, createdAt, createdAt
      );
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        VALUES(?,?,1,'','succeeded','artifact.connector_evidence_committed',?,?)
      `).run(randomUUID(), runId, JSON.stringify({ artifactId, sizeBytes: bytes.length, sourceRef: String(request.sourceRef || '') }), createdAt);
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      fs.rmSync(destination, { force: true });
      throw error;
    }
    return {
      schemaVersion: 'omnia.feature-artifact/v1', artifactId, runId, traceId,
      featureId: context.featureId, featureVersion: context.featureVersion, surfaceId,
      kind, originalName, mediaType: String(request.mediaType || 'application/octet-stream'),
      sizeBytes: bytes.length, sha256, importedAt: createdAt
    };
  }

  private transitionRun(input: unknown, context: FeatureWorkerPortContext): number {
    const change = object(input, 'Run transition');
    const runId = String(change.runId || '');
    const expectedRevision = Number(change.expectedRevision);
    const row = this.core.prepare(`SELECT state, state_revision FROM feature_runs WHERE run_id=? AND feature_id=?`)
      .get(runId, context.featureId) as { state: string; state_revision: number } | undefined;
    if (!row || row.state_revision !== expectedRevision) throw new Error('Run state revision changed; reload before continuing.');
    const transitions: Record<string, string[]> = {
      draft: ['acquiring', 'cancelled'], acquiring: ['processing', 'failed', 'cancelled'],
      processing: ['needs_input', 'converting', 'failed', 'cancelled'],
      needs_input: ['processing', 'converting', 'cancelled'], converting: ['validating_output', 'failed'],
      validating_output: ['ready_for_review', 'needs_input', 'failed'],
      ready_for_review: ['waiting_confirmation', 'cancelled'], waiting_confirmation: ['returning', 'cancelled'],
      returning: ['verifying', 'failed', 'uncertain'], verifying: ['succeeded', 'failed', 'uncertain'],
      uncertain: ['reconciling'], reconciling: ['returning', 'succeeded', 'failed', 'uncertain'],
      succeeded: [], failed: [], cancelled: [], not_evaluable: []
    };
    const toState = String(change.toState || '');
    if (!transitions[row.state]?.includes(toState)) throw new Error(`Illegal run transition: ${row.state} -> ${toState}.`);
    const nextRevision = expectedRevision + 1;
    const occurredAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const updated = this.core.prepare(`
        UPDATE feature_runs SET state=?, state_revision=?, last_error=?, updated_at=?
        WHERE run_id=? AND feature_id=? AND state_revision=?
      `).run(toState, nextRevision, String(change.error || ''), occurredAt,
        runId, context.featureId, expectedRevision);
      if (updated.changes !== 1) throw new Error('Run state revision changed; reload before continuing.');
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), runId, nextRevision, row.state, toState,
        String(change.eventType || 'run.transition'), JSON.stringify(change.details || {}), occurredAt);
      this.core.exec('COMMIT;');
      return nextRevision;
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
  }

  private recordFieldRevisions(input: unknown, context: FeatureWorkerPortContext): number {
    const request = object(input, 'Field revision batch');
    const fields = request.fields;
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > 2_000) throw new Error('Field revision batch is invalid.');
    const run = this.core.prepare(`SELECT run_id, source_artifact_id FROM feature_runs WHERE run_id=? AND feature_id=?`)
      .get(String(request.runId || ''), context.featureId) as { run_id: string; source_artifact_id: string } | undefined;
    if (!run) throw new Error('Field revision run is unavailable.');
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      for (const candidate of fields) {
        const field = object(candidate, 'Field revision');
        const provenance = object(field.provenance, 'Field provenance');
        for (const required of ['sourceArtifactId', 'sourceSheet', 'sourceRow', 'rowKey', 'fieldKey', 'sourceTraceId']) {
          if (provenance[required] === undefined || provenance[required] === '') throw new Error(`Field provenance is missing ${required}.`);
        }
        if (String(field.fieldKey || '') !== String(provenance.fieldKey || '')) throw new Error('Field revision key differs from provenance field key.');
        const valueKind = String(field.valueKind || '');
        if (!['source', 'derived', 'inherited', 'rule_default', 'user_revision'].includes(valueKind)) {
          throw new Error('Field revision value kind is invalid.');
        }
        if (valueKind === 'source' && String(provenance.sourceArtifactId) !== run.source_artifact_id) {
          throw new Error('Source field provenance artifact is not the Run source artifact.');
        }
        if (['derived', 'rule_default'].includes(valueKind)) {
          const memberPath = String(provenance.sourceArtifactId).replace(/^ofp-member:/u, '').replace(/:sha256:[0-9a-f]{64}$/u, '');
          const managed = this.core.prepare(`
            SELECT managed_path,member_digest FROM feature_managed_assets WHERE feature_id=? AND feature_version=? AND member_path=? AND asset_kind='governance'
          `).get(context.featureId, context.featureVersion, memberPath) as {managed_path:string;member_digest:string}|undefined;
          if (!managed) throw new Error('Derived/default field provenance is not a signed managed governance asset.');
          const claimedDigest=String(provenance.sourceArtifactId).match(/:sha256:([0-9a-f]{64})$/u)?.[1]||'';
          if(claimedDigest!==managed.member_digest) throw new Error('Derived/default field provenance does not freeze the exact signed governance member digest.');
          const rulesAsset=this.core.prepare(`SELECT managed_path FROM feature_managed_assets WHERE feature_id=? AND feature_version=? AND member_path='backend/governance.json' AND asset_kind='governance'`).get(context.featureId,context.featureVersion) as {managed_path:string}|undefined;
          if(!rulesAsset) throw new Error('Signed governance rule IR is unavailable.');
          const governance=JSON.parse(fs.readFileSync(path.resolve(this.paths.data,...rulesAsset.managed_path.split('/')),'utf8')) as {
            fields?:Array<Record<string,unknown>>; derivationRules?:Array<Record<string,unknown>>;
          };
          if(valueKind==='rule_default'){
            const declaration=governance.fields?.find((item)=>String(item.fieldId||'')===String(field.canonicalFieldId||''));
            const rule=governance.derivationRules?.find((item)=>String(item.ruleId||'')===String(provenance.derivationRule||'')
              &&String(item.targetFieldId||'')===String(field.canonicalFieldId||''));
            if(!declaration||!String(declaration.defaultRuleId||'')||!Object.hasOwn(declaration,'defaultValue')
              ||String(declaration.defaultRuleId)!==String(provenance.derivationRule||'')
              ||canonical(declaration.defaultValue)!==canonical(field.value)
              ||!rule||String(rule.algorithm||'')!=='constant_boolean_false'||rule.constantValue!==false
              ||String(rule.sourceTraceId||'')!==String(provenance.sourceTraceId||'')) throw new Error('Rule default is not an exact formally declared signed governance default.');
          } else {
            const rule=governance.derivationRules?.find((item)=>String(item.ruleId||'')===String(provenance.derivationRule||'')
              &&String(item.targetFieldId||'')===String(field.canonicalFieldId||''));
            if(!rule||!['canonical_element_id','prefix_literal'].includes(String(rule.algorithm||''))
              ||String(rule.sourceTraceId||'')!==String(provenance.sourceTraceId||'')) throw new Error('Derived field is not bound to an exact formally declared signed governance rule.');
            const dependencyFieldKey=String(provenance.dependencyFieldKey||'');
            const dependency=this.core.prepare(`
              SELECT r.value_json,p.row_key FROM feature_field_revisions r
              JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id
              WHERE r.run_id=? AND p.row_key=? AND (${dependencyFieldKey?'r.field_key=?':'r.canonical_field_id=?'}) AND r.status IN ('accepted','needs_input')
              ORDER BY r.revision DESC LIMIT 1
            `).get(String(request.runId),String(provenance.rowKey),dependencyFieldKey||String(rule.dependencyFieldId)) as {value_json:string;row_key:string}|undefined;
            const dependencyValue=dependency?String(JSON.parse(dependency.value_json)??''):'';
            const expectedValue=String(rule.algorithm)==='prefix_literal'?`${String(rule.prefix||'')}${dependencyValue}`:dependencyValue;
            if(!dependency||!dependencyFieldKey&&String(rule.dependencyFieldId||'')!=='P1.APP.IT.ELEMENT_ID'||canonical(expectedValue)!==canonical(field.value)) throw new Error('Derived field value differs from its signed dependency algorithm result.');
          }
        }
        if (valueKind === 'inherited') {
          const evidence = this.core.prepare(`
            SELECT 1 FROM feature_artifacts WHERE artifact_id=? AND run_id=? AND feature_id=? AND kind='evidence'
          `).get(String(provenance.sourceArtifactId), String(request.runId), context.featureId);
          const plannedSourceEdge=String(provenance.sourceArtifactId)===run.source_artifact_id
            &&String(provenance.derivationRule||'').includes('remote_verification_required_before_return');
          if (!evidence&&!plannedSourceEdge) throw new Error('Inherited field provenance is neither verified Run evidence nor an explicitly unverified source edge gated before Return.');
        }
        if (valueKind === 'user_revision') {
          throw new Error('Initial field batches cannot claim user_revision; use the issue revision CAS contract.');
        }
        const latest = this.core.prepare(`
          SELECT revision FROM feature_field_revisions WHERE run_id=? AND field_key=? ORDER BY revision DESC LIMIT 1
        `).get(String(request.runId), String(field.fieldKey || '')) as { revision: number } | undefined;
        const requestedRevision = Number(field.revision || 1);
        if (requestedRevision !== (latest?.revision || 0) + 1) throw new Error('Field revision is not monotonic.');
        const revisionId = randomUUID();
        this.core.prepare(`
          INSERT INTO feature_field_revisions(
            field_revision_id, run_id, template_instance_id, field_key, raw_field_key, canonical_field_id, revision, value_kind,
            value_json, status, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(revisionId, String(request.runId), String(request.templateInstanceId || ''), String(field.fieldKey || ''),
          String(field.rawFieldKey || ''), String(field.canonicalFieldId || ''), requestedRevision,
          valueKind, JSON.stringify(field.value ?? null),
          String(field.status || 'accepted'), now());
        this.core.prepare(`
          INSERT INTO feature_field_provenance(
            provenance_id, field_revision_id, source_artifact_id, source_sheet, source_row,
            row_key, field_key, source_trace_id, derivation_rule, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), revisionId, String(provenance.sourceArtifactId), String(provenance.sourceSheet),
          Number(provenance.sourceRow), String(provenance.rowKey), String(provenance.fieldKey),
          String(provenance.sourceTraceId), String(provenance.derivationRule || ''), now());
        this.core.prepare(`INSERT INTO template_instance_field_revisions(template_instance_id,field_revision_id,field_key,revision,bound_at) VALUES(?,?,?,?,?) ON CONFLICT(template_instance_id,field_key) DO UPDATE SET field_revision_id=excluded.field_revision_id,revision=excluded.revision,bound_at=excluded.bound_at WHERE excluded.revision>template_instance_field_revisions.revision`).run(String(request.templateInstanceId||''),revisionId,String(field.fieldKey||''),requestedRevision,now());
        if (latest) {
          this.core.prepare(`
            UPDATE feature_field_revisions SET status='superseded'
            WHERE run_id=? AND field_key=? AND revision=? AND status IN ('accepted','needs_input','blocked')
          `).run(String(request.runId), String(field.fieldKey), latest.revision);
        }
      }
      this.core.exec('COMMIT;');
      return fields.length;
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
  }

  private recordIssues(input: unknown, context: FeatureWorkerPortContext): number {
    const request = object(input, 'Issue batch');
    const issues = request.issues;
    if (!Array.isArray(issues) || issues.length > 2_000) throw new Error('Issue batch is invalid.');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=?`).get(String(request.runId || ''), context.featureId)) {
      throw new Error('Issue run is unavailable.');
    }
    for (const value of issues) {
      const issue = object(value, 'Feature issue');
      const issueId=String(issue.issueId || randomUUID());const owner=this.core.prepare(`SELECT run_id FROM feature_issues WHERE issue_id=?`).get(issueId) as {run_id:string}|undefined;if(owner&&owner.run_id!==String(request.runId))throw new Error('Feature issue identity belongs to another Run.');
      this.core.prepare(`
        INSERT INTO feature_issues(
          issue_id, run_id, field_key, issue_type, state, message, resolution_revision_id, created_at, resolved_at
        ) VALUES(?, ?, ?, ?, ?, ?, '', ?, '')
        ON CONFLICT(issue_id) DO UPDATE SET field_key=excluded.field_key,issue_type=excluded.issue_type,state=excluded.state,message=excluded.message,resolution_revision_id='',created_at=excluded.created_at,resolved_at=''
      `).run(issueId, String(request.runId), String(issue.fieldKey || ''),
        String(issue.issueType || ''), String(issue.state || 'needs_input'), String(issue.message || ''), now());
    }
    return issues.length;
  }

  private loadRunReview(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const runId = String(object(input, 'Run review request').runId || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=?`).get(runId, context.featureId)) {
      throw new Error('Run review is unavailable.');
    }
    const unresolved = this.core.prepare(`
      SELECT i.issue_id, i.field_key, i.issue_type, i.message,
             r.revision, r.value_json, r.raw_field_key, r.canonical_field_id
      FROM feature_issues i
      LEFT JOIN feature_field_revisions r ON r.field_revision_id=(
        SELECT r2.field_revision_id FROM feature_field_revisions r2
        WHERE r2.run_id=i.run_id AND r2.field_key=i.field_key
        ORDER BY r2.revision DESC LIMIT 1
      )
      WHERE i.run_id=? AND i.state IN ('needs_input','blocking')
      ORDER BY i.created_at, i.issue_id
    `).all(runId) as Array<Record<string, unknown>>;
    return {
      unresolvedCount: unresolved.length,
      editors: unresolved.filter((row) => Number(row.revision) >= 1).map((row) => ({
        issueId: String(row.issue_id), fieldKey: String(row.field_key), expectedRevision: Number(row.revision),
        inputKind: 'text', label: String(row.message), currentValue: String(JSON.parse(String(row.value_json || '""')) ?? ''),
        allowedValues: [], required: true, maxLength: 2_000
      }))
    };
  }

  private applyIssueRevisions(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Issue revision request');
    const runId = String(request.runId || '');
    const revisions = request.revisions;
    if (!Array.isArray(revisions) || revisions.length < 1 || revisions.length > 500) throw new Error('Issue revision batch is invalid.');
    const run = this.core.prepare(`
      SELECT r.state, r.source_artifact_id,
             (SELECT template_instance_id FROM template_instances WHERE run_id=r.run_id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS template_instance_id
      FROM feature_runs r WHERE r.run_id=? AND r.feature_id=?
    `).get(runId, context.featureId) as { state: string; source_artifact_id: string; template_instance_id: string } | undefined;
    if (!run || run.state !== 'needs_input' || !run.template_instance_id) throw new Error('Issue revisions require a needs_input Run with a TemplateInstance.');
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      for (const raw of revisions) {
        const change = object(raw, 'Issue revision');
        const issueId = String(change.issueId || '');
        const fieldKey = String(change.fieldKey || '');
        const expectedRevision = Number(change.expectedRevision);
        const value = String(change.value ?? '').normalize('NFC').trim();
        if (!value || value.length > 2_000) throw new Error('Issue revision value is invalid.');
        const row = this.core.prepare(`
          SELECT i.field_key, i.state, r.field_revision_id, r.revision, r.raw_field_key, r.canonical_field_id,
                 r.value_kind, p.source_artifact_id, p.source_sheet, p.source_row, p.row_key, p.source_trace_id
          FROM feature_issues i
          JOIN feature_field_revisions r ON r.field_revision_id=(
            SELECT r2.field_revision_id FROM feature_field_revisions r2 WHERE r2.run_id=i.run_id AND r2.field_key=i.field_key
            ORDER BY r2.revision DESC LIMIT 1
          )
          JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id
          WHERE i.issue_id=? AND i.run_id=?
        `).get(issueId, runId) as Record<string, unknown> | undefined;
        if (!row || row.state !== 'needs_input' || row.field_key !== fieldKey || Number(row.revision) !== expectedRevision) {
          throw new Error('Issue or field revision changed; reload before saving.');
        }
        const revisionId = randomUUID();
        const createdAt = now();
        this.core.prepare(`
          INSERT INTO feature_field_revisions(
            field_revision_id, run_id, template_instance_id, field_key, raw_field_key, canonical_field_id,
            revision, value_kind, value_json, status, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, 'user_revision', ?, 'accepted', ?)
        `).run(revisionId, runId, '', fieldKey, String(row.raw_field_key || ''),
          String(row.canonical_field_id || ''), expectedRevision + 1, JSON.stringify(value), createdAt);
        this.core.prepare(`
          INSERT INTO feature_field_provenance(
            provenance_id, field_revision_id, source_artifact_id, source_sheet, source_row,
            row_key, field_key, source_trace_id, derivation_rule, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'explicit_user_revision_with_cas', ?)
        `).run(randomUUID(), revisionId, String(row.source_artifact_id), String(row.source_sheet), Number(row.source_row),
          String(row.row_key), fieldKey, `${String(row.source_trace_id)}:revision:${expectedRevision + 1}`, createdAt);
        this.core.prepare(`UPDATE feature_field_revisions SET status='superseded' WHERE field_revision_id=?`).run(String(row.field_revision_id));
        this.core.prepare(`UPDATE feature_issues SET state='resolved', resolution_revision_id=?, resolved_at=? WHERE issue_id=? AND state='needs_input'`)
          .run(revisionId, createdAt, issueId);
      }
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
    return this.loadRunReview({ runId }, context);
  }

  private commitReviewValidation(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request=object(input,'Review validation commit') as FeatureReviewValidationCommit&Record<string,any>;const runId=String(request.runId||'');const expectedRunRevision=Number(request.expectedRunRevision);
    const revisions=Array.isArray(request.revisions)?request.revisions:[];const derivedRevisions=Array.isArray(request.derivedRevisions)?request.derivedRevisions:[];const issues=Array.isArray(request.issues)?request.issues:[];
    if(revisions.length>500||derivedRevisions.length>1000||issues.length>2000)throw new Error('Review validation batch exceeds limits.');
    const run=this.core.prepare(`SELECT state,state_revision,(SELECT template_instance_id FROM template_instances WHERE run_id=feature_runs.run_id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS template_instance_id FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`).get(runId,context.featureId,context.featureVersion) as {state:string;state_revision:number;template_instance_id:string}|undefined;
    if(!run||!['needs_input','ready_for_review'].includes(run.state)||run.state_revision!==expectedRunRevision)throw new Error('Review Run revision changed; reload before saving.');
    if(!request.templateInstanceId||String(request.templateInstanceId)!==String(run.template_instance_id||''))throw new Error('Review commit must bind the latest compiled TemplateInstance.');
    const nextState=String(request.nextState||'');if(!['needs_input','ready_for_review'].includes(nextState))throw new Error('Review validation next state is invalid.');
    const occurredAt=now();this.core.exec('BEGIN IMMEDIATE;');
    try{const revisedDependencies=new Map<string,{canonicalFieldId:string;rowKey:string;nextRevision:number}>();
      for(const raw of revisions){const change=object(raw,'Review field change');const fieldKey=String(change.fieldKey||'');const expectedRevision=Number(change.expectedRevision);const value=String(change.value??'').normalize('NFC').trim();
        if(value.length>8000)throw new Error('Review value exceeds the maximum supported field limit.');const row=this.core.prepare(`SELECT r.field_revision_id,r.revision,r.raw_field_key,r.canonical_field_id,r.value_kind,p.source_artifact_id,p.source_sheet,p.source_row,p.row_key,p.source_trace_id FROM feature_field_revisions r JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id WHERE r.run_id=? AND r.field_key=? ORDER BY r.revision DESC LIMIT 1`).get(runId,fieldKey) as Record<string,unknown>|undefined;
        if(!row||Number(row.revision)!==expectedRevision||['derived','rule_default','inherited'].includes(String(row.value_kind)))throw new Error('Review field revision changed or is not editable.');
        const revisionId=randomUUID(),nextRevision=expectedRevision+1;this.core.prepare(`INSERT INTO feature_field_revisions(field_revision_id,run_id,template_instance_id,field_key,raw_field_key,canonical_field_id,revision,value_kind,value_json,status,created_at) VALUES(?,?,?,?,?,?,?,'user_revision',?,'accepted',?)`).run(revisionId,runId,String(request.templateInstanceId||''),fieldKey,String(row.raw_field_key||''),String(row.canonical_field_id||''),nextRevision,JSON.stringify(value),occurredAt);
        this.core.prepare(`INSERT INTO feature_field_provenance(provenance_id,field_revision_id,source_artifact_id,source_sheet,source_row,row_key,field_key,source_trace_id,derivation_rule,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),revisionId,String(row.source_artifact_id),String(row.source_sheet),Number(row.source_row),String(row.row_key),fieldKey,`${String(row.source_trace_id)}:revision:${nextRevision}`,'explicit_user_revision_with_cas',occurredAt);
        this.core.prepare(`INSERT INTO template_instance_field_revisions(template_instance_id,field_revision_id,field_key,revision,bound_at) VALUES(?,?,?,?,?) ON CONFLICT(template_instance_id,field_key) DO UPDATE SET field_revision_id=excluded.field_revision_id,revision=excluded.revision,bound_at=excluded.bound_at WHERE excluded.revision>template_instance_field_revisions.revision`).run(String(request.templateInstanceId||''),revisionId,fieldKey,nextRevision,occurredAt);
        this.core.prepare(`UPDATE feature_field_revisions SET status='superseded' WHERE field_revision_id=?`).run(String(row.field_revision_id));
        revisedDependencies.set(fieldKey,{canonicalFieldId:String(row.canonical_field_id||''),rowKey:String(row.row_key||''),nextRevision});
      }
      const derivedByDependency=new Map<string,Set<string>>();
      for(const raw of derivedRevisions){const change=object(raw,'Derived review revision');const fieldKey=String(change.fieldKey||''),dependencyFieldKey=String(change.dependencyFieldKey||'');const expectedRevision=Number(change.expectedRevision),dependencyRevision=Number(change.dependencyRevision);const value=String(change.value??'').normalize('NFC').trim();
        const dependency=revisedDependencies.get(dependencyFieldKey);if(!dependency||dependency.nextRevision!==dependencyRevision)throw new Error('Derived review revision is not bound to a dependency changed in the same atomic commit.');
        const row=this.core.prepare(`SELECT r.field_revision_id,r.revision,r.raw_field_key,r.canonical_field_id,r.value_kind,p.source_artifact_id,p.source_sheet,p.source_row,p.row_key,p.source_trace_id,p.derivation_rule FROM feature_field_revisions r JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id WHERE r.run_id=? AND r.field_key=? ORDER BY r.revision DESC LIMIT 1`).get(runId,fieldKey) as Record<string,unknown>|undefined;
        if(!row||String(row.value_kind)!=='derived'||Number(row.revision)!==expectedRevision||String(row.row_key)!==dependency.rowKey)throw new Error('Derived review field revision changed or has invalid lineage.');
        const dependencyRow=this.core.prepare(`SELECT value_json,revision FROM feature_field_revisions WHERE run_id=? AND field_key=? ORDER BY revision DESC LIMIT 1`).get(runId,dependencyFieldKey) as {value_json:string;revision:number}|undefined;if(!dependencyRow||dependencyRow.revision!==dependencyRevision)throw new Error('Derived review dependency revision changed.');
        const rulesAsset=this.core.prepare(`SELECT managed_path FROM feature_managed_assets WHERE feature_id=? AND feature_version=? AND member_path='backend/governance.json' AND asset_kind='governance'`).get(context.featureId,context.featureVersion) as {managed_path:string}|undefined;if(!rulesAsset)throw new Error('Signed governance rule IR is unavailable.');
        const governance=JSON.parse(fs.readFileSync(path.resolve(this.paths.data,...rulesAsset.managed_path.split('/')),'utf8')) as {derivationRules?:Array<Record<string,unknown>>};const rule=governance.derivationRules?.find((candidate)=>String(candidate.ruleId||'')===String(row.derivation_rule||'')&&String(candidate.targetFieldId||'')===String(row.canonical_field_id||''));
        if(!rule||!['canonical_element_id','prefix_literal'].includes(String(rule.algorithm||''))||String(rule.sourceTraceId||'')!==String(row.source_trace_id||''))throw new Error('Derived review field is not backed by its signed rule.');const dependencyValue=String(JSON.parse(dependencyRow.value_json)??'');const expectedValue=String(rule.algorithm)==='prefix_literal'?`${String(rule.prefix||'')}${dependencyValue}`:dependencyValue;if(value!==expectedValue)throw new Error('Derived review value differs from its signed dependency rule.');
        const revisionId=randomUUID(),nextRevision=expectedRevision+1;this.core.prepare(`INSERT INTO feature_field_revisions(field_revision_id,run_id,template_instance_id,field_key,raw_field_key,canonical_field_id,revision,value_kind,value_json,status,created_at) VALUES(?,?,?,?,?,?,?,'derived',?,'accepted',?)`).run(revisionId,runId,String(request.templateInstanceId),fieldKey,String(row.raw_field_key||''),String(row.canonical_field_id||''),nextRevision,JSON.stringify(value),occurredAt);
        this.core.prepare(`INSERT INTO feature_field_provenance(provenance_id,field_revision_id,source_artifact_id,source_sheet,source_row,row_key,field_key,source_trace_id,derivation_rule,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),revisionId,String(row.source_artifact_id||''),String(row.source_sheet||''),Number(row.source_row),String(row.row_key||''),fieldKey,String(row.source_trace_id||''),String(row.derivation_rule||''),occurredAt);
        this.core.prepare(`INSERT INTO template_instance_field_revisions(template_instance_id,field_revision_id,field_key,revision,bound_at) VALUES(?,?,?,?,?) ON CONFLICT(template_instance_id,field_key) DO UPDATE SET field_revision_id=excluded.field_revision_id,revision=excluded.revision,bound_at=excluded.bound_at WHERE excluded.revision>template_instance_field_revisions.revision`).run(String(request.templateInstanceId),revisionId,fieldKey,nextRevision,occurredAt);this.core.prepare(`UPDATE feature_field_revisions SET status='superseded' WHERE field_revision_id=?`).run(String(row.field_revision_id));
        const targets=derivedByDependency.get(dependencyFieldKey)||new Set<string>();targets.add(String(row.canonical_field_id||''));derivedByDependency.set(dependencyFieldKey,targets);
      }
      for(const [fieldKey,dependency] of revisedDependencies){if(!/P1\.(?:APP|DB|OS|TOOL)\.IT\.ELEMENT_ID/u.test(dependency.canonicalFieldId))continue;const actual=derivedByDependency.get(fieldKey)||new Set<string>();if(!actual.has('P1.RUNTIME.GRA.NAME')||(dependency.canonicalFieldId==='P1.APP.IT.ELEMENT_ID'&&!actual.has('P1.APP.IT.DESCRIPTION')))throw new Error('Element ID revision must atomically include every signed derived field revision.');}
      this.core.prepare(`UPDATE feature_issues SET state='resolved',resolved_at=? WHERE run_id=? AND state IN ('needs_input','blocking','waived')`).run(occurredAt,runId);
      for(const raw of issues){const issue=object(raw,'Revalidated issue');const issueId=String(issue.issueId||randomUUID());const owner=this.core.prepare(`SELECT run_id FROM feature_issues WHERE issue_id=?`).get(issueId) as {run_id:string}|undefined;if(owner&&owner.run_id!==runId)throw new Error('Revalidated issue identity belongs to another Run.');this.core.prepare(`INSERT INTO feature_issues(issue_id,run_id,field_key,issue_type,state,message,resolution_revision_id,created_at,resolved_at) VALUES(?,?,?,?,?,?,'',?,'') ON CONFLICT(issue_id) DO UPDATE SET field_key=excluded.field_key,issue_type=excluded.issue_type,state=excluded.state,message=excluded.message,resolution_revision_id='',created_at=excluded.created_at,resolved_at=''`).run(issueId,runId,String(issue.fieldKey||''),String(issue.issueType||''),String(issue.state||'needs_input'),String(issue.message||''),occurredAt);}
      const nextRevision=expectedRunRevision+1;const changed=this.core.prepare(`UPDATE feature_runs SET state=?,state_revision=?,last_error='',updated_at=? WHERE run_id=? AND feature_id=? AND state_revision=?`).run(nextState,nextRevision,occurredAt,runId,context.featureId,expectedRunRevision);if(changed.changes!==1)throw new Error('Review Run revision changed; reload before saving.');
      this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(),runId,nextRevision,run.state,nextState,String(request.eventType||'review.revalidated'),JSON.stringify({revisionCount:revisions.length,derivedRevisionCount:derivedRevisions.length,issueCount:issues.length,excludedRowKey:String(request.excludedRowKey||'')}),occurredAt);
      this.core.exec('COMMIT;');return{state:nextState,stateRevision:nextRevision};
    }catch(error){this.core.exec('ROLLBACK;');throw error;}
  }

  private prepareReturnIntent(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Return intent request');
    const runId = String(request.runId || '');
    const plan = object(request.plan, 'Return plan');
    const targets = plan.targets;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2_000) throw new Error('Return plan target inventory is invalid.');
    const run = this.core.prepare(`SELECT state, state_revision, engagement_id FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`)
      .get(runId, context.featureId, context.featureVersion) as { state: string; state_revision: number; engagement_id: string } | undefined;
    if (!run || run.state !== 'ready_for_review') throw new Error('Return intent requires a ready_for_review Run.');
    const binding = object(request.connectorBinding, 'Return Connector binding');
    const safety = object(request.safetyLock, 'Return safety lock');
    const workspaceIds = Array.isArray(safety.workspaceIds) ? safety.workspaceIds.map(String) : [];
    if (!binding.connectorId || Number(binding.sessionGeneration) < 1 || !binding.engagementId
      || !binding.authorityInstanceId || !binding.tenantOrOrgId || !binding.packId
      || safety.enabled !== true || safety.engagementId !== binding.engagementId || workspaceIds.length < 1) {
      throw new Error('Return intent binding or safety lock is invalid.');
    }
    if (run.engagement_id && run.engagement_id !== String(binding.engagementId)) {
      throw new Error('Return intent engagement differs from the engagement already frozen on this Run.');
    }
    const planAuthority = object(plan.authority, 'Return plan authority snapshot');
    if (String(planAuthority.authorityInstanceId || '') !== String(binding.authorityInstanceId)
      || String(planAuthority.tenantOrOrgId || '') !== String(binding.tenantOrOrgId)
      || String(planAuthority.packId || '') !== String(binding.packId)
      || String(planAuthority.engagementId || '') !== String(binding.engagementId)) {
      throw new Error('Return plan authority snapshot differs from the exact current Connector authority.');
    }
    const durableSafety = this.core.prepare(`SELECT enabled, engagement_id, workspace_ids_json, state_version FROM workspace_safety WHERE singleton=1`)
      .get() as { enabled: number; engagement_id: string; workspace_ids_json: string; state_version: number };
    if (durableSafety.enabled !== 1 || durableSafety.engagement_id !== binding.engagementId
      || canonical(JSON.parse(durableSafety.workspace_ids_json)) !== canonical(workspaceIds)
      || durableSafety.state_version !== Number(safety.stateVersion)) throw new Error('Return intent safety lock differs from durable Core state.');
    const authorityDigest = crypto.createHash('sha256').update(canonical({
      connectorId: binding.connectorId, sessionGeneration: Number(binding.sessionGeneration), engagementId: binding.engagementId,
      authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId,
      workspaceIds
    })).digest('hex');
    if (String(request.credentialDigest || '') !== authorityDigest) throw new Error('Return authority credential digest is absent or does not match the exact frozen authority scope.');
    if (!/^[0-9a-f]{64}$/u.test(String(request.preflightDigest || ''))) throw new Error('Return intent requires a real preflight digest.');
    const planDigest = crypto.createHash('sha256').update(canonical(plan)).digest('hex');
    const confirmationId = randomUUID(); const messageId = `create-associate-return:${runId}`;
    const confirmationToken = randomUUID(); const tokenDigest = crypto.createHash('sha256').update(confirmationToken).digest('hex');
    const createdAt = now(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      for (const raw of targets) {
        const target = object(raw, 'Return intent target');
        if (!['object', 'relation', 'field', 'risk_control', 'documentation', 'evaluation'].includes(String(target.kind))
          || !String(target.key || '')) throw new Error('Return intent target identity is invalid.');
        if (target.workspace !== undefined && !workspaceIds.includes(String(target.workspace))) {
          throw new Error('Return intent target Workspace is outside the exact durable safety scope.');
        }
        this.core.prepare(`
          INSERT INTO managed_content_intents(intent_id, run_id, plan_digest, target_kind, target_key, intended_revision_json, state, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, 'frozen', ?, ?)
        `).run(randomUUID(), runId, planDigest, String(target.kind), String(target.key), JSON.stringify(target), createdAt, createdAt);
      }
      this.core.prepare(`
        INSERT INTO feature_confirmations(
          confirmation_id, run_id, message_id, plan_digest, connector_id, session_generation, engagement_id,
          authority_instance_id, tenant_or_org_id, pack_id,
          safety_revision, credential_digest, preflight_digest, confirmation_token_digest, decision, actor_id,
          decision_at, consumed_command_id, expires_at, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', ?, ?)
      `).run(confirmationId, runId, messageId, planDigest, String(binding.connectorId), Number(binding.sessionGeneration),
        String(binding.engagementId), String(binding.authorityInstanceId), String(binding.tenantOrOrgId), String(binding.packId),
        Number(safety.stateVersion), authorityDigest,
        String(request.preflightDigest || ''), tokenDigest, expiresAt, createdAt);
      const updated = this.core.prepare(`UPDATE feature_runs SET state='waiting_confirmation', state_revision=state_revision+1, engagement_id=?, plan_digest=?, updated_at=? WHERE run_id=? AND state_revision=? AND (engagement_id='' OR engagement_id=?)`)
        .run(String(binding.engagementId), planDigest, createdAt, runId, run.state_revision, String(binding.engagementId));
      if (updated.changes !== 1) throw new Error('Run changed while freezing the return intent.');
      this.core.prepare(`INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at) VALUES(?, ?, ?, 'ready_for_review', 'waiting_confirmation', 'return.intent_frozen', ?, ?)`)
        .run(randomUUID(), runId, run.state_revision + 1, JSON.stringify({ confirmationId, messageId, planDigest }), createdAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { confirmationId, confirmationToken, messageId, planDigest, stateVersion: 1, expiresAt,
      authoritySnapshot: { authorityInstanceId: String(binding.authorityInstanceId), tenantOrOrgId: String(binding.tenantOrOrgId),
        packId: String(binding.packId), engagementId: String(binding.engagementId) } };
  }

  private approveReturnIntent(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    if (!context.allowMutation) throw new Error('Return confirmation is only available from an authorized mutation action.');
    const request = object(input, 'Return approval request');
    const confirmationId = String(request.confirmationId || '');
    const tokenDigest = crypto.createHash('sha256').update(String(request.confirmationToken || '')).digest('hex');
    const row = this.core.prepare(`
      SELECT c.*, r.state, r.state_revision, r.engagement_id AS run_engagement_id FROM feature_confirmations c JOIN feature_runs r ON r.run_id=c.run_id
      WHERE c.confirmation_id=? AND r.feature_id=? AND r.feature_version=?
    `).get(confirmationId, context.featureId, context.featureVersion) as Record<string, any> | undefined;
    const binding = object(request.connectorBinding, 'Current Return Connector binding');
    const safety = object(request.safetyLock, 'Current Return safety lock');
    const durableSafety = this.core.prepare(`SELECT enabled, engagement_id, workspace_ids_json, state_version FROM workspace_safety WHERE singleton=1`)
      .get() as { enabled: number; engagement_id: string; workspace_ids_json: string; state_version: number };
    if (!row || row.decision !== 'pending' || row.state !== 'waiting_confirmation' || row.confirmation_token_digest !== tokenDigest
      || row.expires_at <= now() || Number(request.expectedStateVersion) !== 1
      || String(binding.connectorId) !== String(row.connector_id) || Number(binding.sessionGeneration) !== Number(row.session_generation)
      || String(binding.engagementId) !== String(row.engagement_id) || String(row.run_engagement_id) !== String(row.engagement_id)
      || safety.enabled !== true
      || String(binding.authorityInstanceId || '') !== String(row.authority_instance_id)
      || String(binding.tenantOrOrgId || '') !== String(row.tenant_or_org_id)
      || String(binding.packId || '') !== String(row.pack_id)
      || crypto.createHash('sha256').update(canonical({
        connectorId: binding.connectorId, sessionGeneration: Number(binding.sessionGeneration), engagementId: binding.engagementId,
        authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId,
        workspaceIds: safety.workspaceIds
      })).digest('hex') !== String(row.credential_digest)
      || String(safety.engagementId) !== String(row.engagement_id) || Number(safety.stateVersion) !== Number(row.safety_revision)
      || durableSafety.enabled !== 1 || durableSafety.engagement_id !== String(row.engagement_id)
      || durableSafety.state_version !== Number(row.safety_revision)
      || canonical(JSON.parse(durableSafety.workspace_ids_json)) !== canonical(safety.workspaceIds)) {
      throw new Error('Return confirmation is stale, invalid, expired, or no longer bound to the durable safety scope.');
    }
    const approvedAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const confirmationUpdate=this.core.prepare(`UPDATE feature_confirmations SET decision='approved', actor_id='local-user', decision_at=? WHERE confirmation_id=? AND decision='pending'`)
        .run(approvedAt, confirmationId);
      if(confirmationUpdate.changes!==1) throw new Error('Return confirmation changed before approval CAS completed.');
      const runUpdate=this.core.prepare(`UPDATE feature_runs SET state='returning', state_revision=state_revision+1, updated_at=? WHERE run_id=? AND state='waiting_confirmation' AND state_revision=? AND engagement_id=?`)
        .run(approvedAt, String(row.run_id),Number(row.state_revision),String(row.engagement_id));
      if(runUpdate.changes!==1) throw new Error('Return Run changed before approval CAS completed.');
      this.core.prepare(`INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at) VALUES(?, ?, ?, 'waiting_confirmation', 'returning', 'return.confirmed_in_comments', ?, ?)`)
        .run(randomUUID(), String(row.run_id), Number(row.state_revision) + 1, JSON.stringify({ confirmationId }), approvedAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { runId: String(row.run_id), planDigest: String(row.plan_digest), stateRevision: Number(row.state_revision) + 1 };
  }

  private validateReturnAuthority(input: unknown, context: FeatureWorkerPortContext): true {
    const request=object(input,'Return authority validation'); const runId=String(request.runId||'');
    const binding=object(request.connectorBinding,'Current Return Connector binding'); const safety=object(request.safetyLock,'Current Return safety lock');
    const confirmation=this.core.prepare(`SELECT c.credential_digest,c.engagement_id,c.authority_instance_id,c.tenant_or_org_id,c.pack_id,c.safety_revision,r.engagement_id AS run_engagement_id FROM feature_confirmations c JOIN feature_runs r ON r.run_id=c.run_id WHERE c.run_id=? AND c.decision='approved' AND r.feature_id=? AND r.feature_version=? ORDER BY c.created_at DESC LIMIT 1`).get(runId,context.featureId,context.featureVersion) as Record<string,any>|undefined;
    const durable=this.core.prepare(`SELECT enabled,engagement_id,workspace_ids_json,state_version FROM workspace_safety WHERE singleton=1`).get() as {enabled:number;engagement_id:string;workspace_ids_json:string;state_version:number};
    const workspaceIds=Array.isArray(safety.workspaceIds)?safety.workspaceIds.map(String):[];
    const authorityDigest=crypto.createHash('sha256').update(canonical({connectorId:binding.connectorId,sessionGeneration:Number(binding.sessionGeneration),engagementId:binding.engagementId,authorityInstanceId:binding.authorityInstanceId,tenantOrOrgId:binding.tenantOrOrgId,packId:binding.packId,workspaceIds})).digest('hex');
    if(!confirmation||confirmation.credential_digest!==authorityDigest||confirmation.engagement_id!==binding.engagementId
      ||confirmation.run_engagement_id!==binding.engagementId||confirmation.authority_instance_id!==binding.authorityInstanceId
      ||confirmation.tenant_or_org_id!==binding.tenantOrOrgId||confirmation.pack_id!==binding.packId
      ||confirmation.safety_revision!==Number(safety.stateVersion)||durable.enabled!==1||durable.engagement_id!==binding.engagementId
      ||durable.state_version!==Number(safety.stateVersion)||canonical(JSON.parse(durable.workspace_ids_json))!==canonical(workspaceIds)) throw new Error('Current Return authority differs from the approved exact scope.');
    return true;
  }

  private prepareReturnCommand(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    if (!context.allowMutation) throw new Error('Return commands require an authorized mutation action.');
    const request = object(input, 'Return command');
    const runId = String(request.runId || ''); const planDigest = String(request.planDigest || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=? AND state='returning'`).get(runId, context.featureId, context.featureVersion)) {
      throw new Error('Return command Run is not owned by the active returning Feature version.');
    }
    const targetKind = String(request.targetKind || ''); const targetKey = String(request.targetKey || '');
    const intent = this.core.prepare(`SELECT intent_id, state, intended_revision_json FROM managed_content_intents WHERE run_id=? AND plan_digest=? AND target_kind=? AND target_key=?`)
      .get(runId, planDigest, targetKind, targetKey) as { intent_id: string; state: string; intended_revision_json: string } | undefined;
    const confirmation = this.core.prepare(`SELECT decision, credential_digest, authority_instance_id, tenant_or_org_id, pack_id, engagement_id FROM feature_confirmations WHERE run_id=? AND plan_digest=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, planDigest) as Record<string, any> | undefined;
    const binding = object(request.binding, 'Return command authority binding');
    const workspaceIds = Array.isArray(request.workspaceIds) ? request.workspaceIds.map(String) : [];
    const authorityDigest = crypto.createHash('sha256').update(canonical({
      connectorId: binding.connectorId, sessionGeneration: Number(binding.sessionGeneration), engagementId: binding.engagementId,
      authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId, workspaceIds
    })).digest('hex');
    const intended = intent ? JSON.parse(intent.intended_revision_json) as Record<string, unknown> : {};
    const evidenceOperationIds = Array.isArray(request.evidenceOperationIds) ? request.evidenceOperationIds.map(String) : [];
    const evidenceTargetIdentityKey = String(request.evidenceTargetIdentityKey || '');
    const commandRequest = object(request.request, 'Exact Return command request');
    const projectedObjectId = (targetKeyToResolve: unknown): string => {
      const projected = this.core.prepare(`SELECT o.object_id FROM managed_content_intents i JOIN feature_commands c ON c.intent_id=i.intent_id AND c.run_id=i.run_id AND c.state='readback_verified' JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified' ORDER BY o.verified_at DESC LIMIT 1`).get(runId,String(targetKeyToResolve||'')) as {object_id:string}|undefined;
      return String(projected?.object_id || '');
    };
    let intendedTargetIdentityKey = String(intended.operationTargetIdentityKey || '');
    if (intended.operationTargetIdentityMode === 'resolved_relation') {
      const relationQuery = commandRequest.query && typeof commandRequest.query === 'object' ? commandRequest.query as Record<string, unknown> : commandRequest;
      const sourceObjectId = String(relationQuery.itElementId || relationQuery.ItElementId || '');
      const targetIds = Array.isArray(relationQuery.AssociatingEntityIds) ? relationQuery.AssociatingEntityIds.map(String) : [String(relationQuery.associatingEntityId || '')];
      const relationWorkspace = String(relationQuery.workspaceId || intended.workspace || '');
      const relationType = String(relationQuery.associationType || intended.relationType || '');
      const expectedSource = projectedObjectId(intended.sourceObjectTargetKey);
      const expectedTarget = projectedObjectId(intended.targetObjectTargetKey);
      if (!expectedSource || !expectedTarget || sourceObjectId !== expectedSource || targetIds.length !== 1 || targetIds[0] !== expectedTarget
        || relationWorkspace !== String(intended.workspace || '') || relationType !== String(intended.relationType || '')) {
        throw new Error('Return relation command IDs differ from the receipt-backed frozen source and target object intents.');
      }
      intendedTargetIdentityKey = `relation|${relationWorkspace}|${expectedSource}|${expectedTarget}|${relationType}`;
    }
    const desired = commandRequest.query && typeof commandRequest.query === 'object'
      ? commandRequest.query as Record<string, any> : commandRequest;
    let commandIntentValid = true;
    if (String(intended.kind) === 'object' && String(intended.objectType) !== 'GRA') {
      if (String(intended.disposition) === 'reuse') commandIntentValid = String(commandRequest.objectId || '') === String(intended.resolvedObjectId || '')
        && String(desired.externalId || '') === String(intended.externalId || '') && String(desired.objectType || '') === String(intended.objectType || '')
        && (String(intended.objectType)!=='Application'||String(desired.description||'')===JSON.stringify({editorData:`<p>${String(intended.description||'').replace(/[&<>"]/gu,(char)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[char] || char))}</p>`,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:String(intended.description||'')}));
      else commandIntentValid = String(commandRequest.number || '') === String(intended.externalId || '')
        && String(commandRequest.name || '') === String(intended.externalId || '')
        && String(commandRequest.workspaceId || '') === String(intended.workspace || '')
        && String(commandRequest.itElementType || '') === String(intended.objectType || '')
        && (String(intended.objectType)!=='Application'||String(commandRequest.description||'')===JSON.stringify({editorData:`<p>${String(intended.description||'').replace(/[&<>"]/gu,(char)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[char] || char))}</p>`,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:String(intended.description||'')}));
    } else if (String(intended.kind) === 'object' && String(intended.objectType) === 'GRA') {
      if (String(intended.disposition) === 'reuse') commandIntentValid = String(commandRequest.riskAssessmentId || '') === String(intended.resolvedObjectId || '')
        && String(desired.name || '') === String(intended.externalId || '');
      else {
        const contentIdentity = intended.contentIdentity as Record<string, unknown> | undefined;
        commandIntentValid = String(commandRequest.entityId || '') === projectedObjectId(intended.entityObjectTargetKey)
          && String(commandRequest.name || '') === String(intended.externalId || '')
          && String(commandRequest.facetId || '') === String(intended.workspace || '')
          && String(commandRequest.inkContentId || '') === String(contentIdentity?.inkContentId || '')
          && String(commandRequest.typeId || '') === String(contentIdentity?.typeId || '');
      }
    } else if (String(intended.key || '').startsWith('object-settings|')) {
      const parentId = projectedObjectId(intended.objectTargetKey);
      commandIntentValid = String(desired.objectId || '') === parentId
        && String(desired.typeId || '') === String(intended.typeId || '')
        && desired.isRelevant === intended.isRelevant && desired.isDataAvailable === intended.isDataAvailable;
    } else if (String(intended.key || '').startsWith('gra-status|') || String(intended.key || '').startsWith('gra-rait|') || String(intended.key || '').startsWith('inheritance-source|')) {
      const expectedPatchKind = String(intended.fieldId) === 'status' ? 'status' : 'rait';
      commandIntentValid = String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey)
        && String(desired.patchKind || '') === expectedPatchKind && String(desired.value || '') === String(intended.value || '');
    } else if (String(intended.key || '').startsWith('risk-factor|')) {
      const factor=intended.resolvedFactor as Record<string,unknown>|undefined;
      commandIntentValid = String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey)
        && String(desired.itemId || '') === String(intended.fieldId || '') && String(desired.selectionMode || '') === String(intended.value || '')
        &&(!factor||(!!commandRequest.query||(String(desired.factorId||'')===String(factor.factorId||'')&&Number(desired.selectedValue)===Number(factor.selectedValue)
        &&String(desired.spectrumDigest||'')===String(factor.spectrumDigest||''))));
    } else if (String(intended.kind) === 'documentation') {
      commandIntentValid = String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey)
        && String(desired.plainText || commandRequest.plainText || '') === String(intended.plainText || '');
    } else if (String(intended.kind) === 'evaluation') {
      commandIntentValid = String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey);
    } else if (String(intended.kind) === 'risk_control') {
      const catalog=intended.resolvedCatalog as Record<string,unknown>|undefined;
      const scope=Array.isArray(commandRequest.controlRiskScopes)?commandRequest.controlRiskScopes[0] as Record<string,any>:undefined;
      commandIntentValid=!catalog
        ?(!commandRequest.query&&String(commandRequest.riskAssessmentId||'')===projectedObjectId(intended.graTargetKey)
          &&String(commandRequest.riskName||'')===String(intended.riskName||'')&&String(commandRequest.controlName||'')===String(intended.controlName||'')
          &&String(commandRequest.riskClassification||'')===String(intended.classification||''))
        :(commandRequest.query
        ?String(desired.riskId||'')===String(catalog.riskId||'')&&String(desired.riskRiskScopeId||'')===String(catalog.riskRiskScopeId||'')
          &&String(desired.controlId||'')===String(catalog.controlId||'')&&String(desired.assertion||'')===String(catalog.assertion||'')
        :String(commandRequest.riskAssessmentId||'')===projectedObjectId(intended.graTargetKey)
          &&String(commandRequest.riskName||'')===String(intended.riskName||'')&&String(commandRequest.controlName||'')===String(intended.controlName||'')
          &&String(commandRequest.riskClassification||'')===String(intended.classification||'')&&String(commandRequest.riskId||'')===String(catalog.riskId||'')
          &&String(commandRequest.updatedOn||'')===String(catalog.updatedOn||'')&&String(scope?.riskScopeId||'')===String(catalog.riskRiskScopeId||'')
          &&String(scope?.controlId||'')===String(catalog.controlId||'')&&String(scope?.assertionType||'')===String(catalog.assertion||''));
    }
    if (!intent || intent.state !== 'frozen' || confirmation?.decision !== 'approved' || confirmation.credential_digest !== authorityDigest
      || confirmation.authority_instance_id !== binding.authorityInstanceId || confirmation.tenant_or_org_id !== binding.tenantOrOrgId
      || confirmation.pack_id !== binding.packId || confirmation.engagement_id !== binding.engagementId
      || String(request.operationId || '') !== String(intended.mutationOperationId || '')
      || !commandIntentValid
      || canonical(evidenceOperationIds) !== canonical(intended.evidenceOperationIds || [])
      || evidenceTargetIdentityKey !== intendedTargetIdentityKey
      || evidenceOperationIds.length < 1 || evidenceOperationIds.some((value)=>!value) || !evidenceTargetIdentityKey) {
      throw new Error(`Return command is not bound to the approved immutable intent: target=${targetKey}, operation=${String(request.operationId||'')}, expectedOperation=${String(intended.mutationOperationId||'')}, commandIntentValid=${commandIntentValid}.`);
    }
    const commandId = randomUUID();
    const idempotencyKey = crypto.createHash('sha256').update(canonical({ runId, planDigest, targetKind, targetKey, operationId: request.operationId })).digest('hex');
    const requestDigest = crypto.createHash('sha256').update(canonical(request.request || {})).digest('hex');
    const createdAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const claimedIntent=this.core.prepare(`UPDATE managed_content_intents SET state='commanded', updated_at=? WHERE intent_id=? AND state='frozen'`).run(createdAt,intent.intent_id);
      if(claimedIntent.changes!==1) throw new Error('Return intent was already claimed by another command.');
      if(String(intended.kind)==='object'&&String(intended.disposition)==='create'){
        const leaseExpiresAt=new Date(Date.parse(createdAt)+15*60_000).toISOString();
        const reservation=this.core.prepare(`INSERT INTO feature_mutation_reservations(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,logical_identity_key,owner_run_id,owner_intent_id,owner_command_id,lifecycle,acquired_at,lease_expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,logical_identity_key) DO UPDATE SET owner_run_id=excluded.owner_run_id,owner_intent_id=excluded.owner_intent_id,owner_command_id=excluded.owner_command_id,lifecycle='active',acquired_at=excluded.acquired_at,lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at WHERE feature_mutation_reservations.lifecycle='released' OR (feature_mutation_reservations.lifecycle='active' AND feature_mutation_reservations.lease_expires_at<excluded.acquired_at AND EXISTS(SELECT 1 FROM feature_commands prior WHERE prior.command_id=feature_mutation_reservations.owner_command_id AND prior.state='prepared' AND prior.submitted_at='' AND prior.commit_point_at=''))`).run(
          String(binding.authorityInstanceId||''),String(binding.tenantOrOrgId||''),String(binding.packId||''),String(binding.engagementId||''),String(intended.workspace||''),intendedTargetIdentityKey,runId,intent.intent_id,commandId,createdAt,leaseExpiresAt,createdAt);
        if(reservation.changes!==1) throw new Error('Another Run owns the durable mutation reservation for this exact authority and logical identity.');
      }
      this.core.prepare(`INSERT INTO feature_commands(command_id, run_id, intent_id, operation_id, idempotency_key, plan_digest, request_digest, evidence_operation_ids_json, evidence_target_identity_key, evidence_request_digest, state, commit_point_at, submitted_at, completed_at, last_error, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'prepared', '', '', '', '', ?)`)
        .run(commandId, runId, intent.intent_id, String(request.operationId || ''), idempotencyKey, planDigest, requestDigest, canonical(evidenceOperationIds), evidenceTargetIdentityKey, createdAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { commandId, intentId: intent.intent_id, idempotencyKey, requestDigest };
  }

  private freezeReturnEvidenceSpec(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Return evidence specification');
    const commandId = String(request.commandId || ''); const runId = String(request.runId || '');
    const operationId = String(request.operationId || '');
    const evidenceRequest = object(request.request, 'Exact evidence read request');
    const row = this.core.prepare(`
      SELECT c.evidence_operation_ids_json,c.evidence_target_identity_key,c.evidence_request_digest,c.state,
        i.intended_revision_json,f.credential_digest,f.authority_instance_id,f.tenant_or_org_id,f.pack_id,f.engagement_id
      FROM feature_commands c
      JOIN feature_runs r ON r.run_id=c.run_id
      JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
      JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
      WHERE c.command_id=? AND c.run_id=? AND r.feature_id=? AND r.feature_version=?
      ORDER BY f.created_at DESC LIMIT 1
    `).get(commandId, runId, context.featureId, context.featureVersion) as Record<string, any> | undefined;
    const binding = object(evidenceRequest.connectorBinding, 'Evidence authority binding');
    const target = object(evidenceRequest.target, 'Evidence target identity');
    const safety = this.core.prepare(`SELECT workspace_ids_json FROM workspace_safety WHERE singleton=1`).get() as {workspace_ids_json:string};
    const workspaceIds = JSON.parse(safety.workspace_ids_json) as string[];
    const authorityDigest = crypto.createHash('sha256').update(canonical({
      connectorId:binding.connectorId,sessionGeneration:Number(binding.sessionGeneration),engagementId:binding.engagementId,
      authorityInstanceId:binding.authorityInstanceId,tenantOrOrgId:binding.tenantOrOrgId,packId:binding.packId,workspaceIds
    })).digest('hex');
    const intended = row ? JSON.parse(String(row.intended_revision_json)) as Record<string, unknown> : {};
    const digest = crypto.createHash('sha256').update(canonical(evidenceRequest)).digest('hex');
    if (!row || !['prepared','committed','uncertain'].includes(String(row.state))
      || !(JSON.parse(String(row.evidence_operation_ids_json)) as string[]).includes(operationId)
      || String(target.targetIdentityKey || '') !== String(row.evidence_target_identity_key)
      || (intended.operationTargetIdentityMode !== 'resolved_relation' && String(target.targetIdentityKey || '') !== String(intended.operationTargetIdentityKey || ''))
      || String(target.workspaceId || '') !== String(intended.workspace || '')
      || !workspaceIds.includes(String(target.workspaceId || ''))
      || authorityDigest !== String(row.credential_digest)
      || String(binding.authorityInstanceId || '') !== String(row.authority_instance_id)
      || String(binding.tenantOrOrgId || '') !== String(row.tenant_or_org_id)
      || String(binding.packId || '') !== String(row.pack_id)
      || String(binding.engagementId || '') !== String(row.engagement_id)
      || (String(row.evidence_request_digest) && String(row.evidence_request_digest) !== digest)) {
      throw new Error('Exact evidence specification differs from the frozen target, authority, read Operation, or prior request digest.');
    }
    this.core.prepare(`UPDATE feature_commands SET evidence_request_digest=? WHERE command_id=? AND evidence_request_digest=''`).run(digest, commandId);
    return { requestDigest: digest };
  }

  private recordReturnEvidence(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Return command evidence');
    const commandId = String(request.commandId || ''); const runId = String(request.runId || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=? AND state IN ('returning','verifying','uncertain','reconciling')`).get(runId, context.featureId, context.featureVersion)) {
      throw new Error('Return evidence Run is not owned by an active Return state.');
    }
    const row = this.core.prepare(`SELECT c.state,c.intent_id,i.intended_revision_json FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id WHERE c.command_id=? AND c.run_id=?`).get(commandId, runId) as { state: string; intent_id: string; intended_revision_json:string } | undefined;
    if (!row) throw new Error('Return command evidence has no owned command.');
    const evidenceType = String(request.evidenceType || '');
    if (!['preflight', 'request', 'commit', 'readback', 'reconcile', 'projection'].includes(evidenceType)) throw new Error('Return evidence type is invalid.');
    const payload = request.payload ?? null; const evidenceId = randomUUID(); const occurredAt = now();
    const receiptId = String(request.receiptId || '');
    const receiptPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== '__operationReceiptId'))
      : payload;
    const evidenceDigest = crypto.createHash('sha256').update(canonical(receiptPayload)).digest('hex');
    const nextState = String(request.commandState || row.state);
    if (!['prepared','submitted','committed','verifying','readback_verified','closed_not_applied','failed','uncertain'].includes(nextState)) throw new Error('Return command state is invalid.');
    const transitions: Record<string, string[]> = {
      prepared: ['prepared','submitted','readback_verified','closed_not_applied','failed'],
      submitted: ['committed','uncertain','failed'], committed: ['verifying','readback_verified','failed','uncertain'],
      verifying: ['readback_verified','failed','uncertain'], uncertain: ['readback_verified','closed_not_applied','failed','uncertain'],
      readback_verified: [], closed_not_applied: [], failed: []
    };
    if (!transitions[row.state]?.includes(nextState)) throw new Error(`Illegal Return command transition: ${row.state} -> ${nextState}.`);
    if (nextState === 'submitted' && evidenceType !== 'request') throw new Error('Submitted state requires request evidence.');
    if(nextState==='submitted'){
      const intended=JSON.parse(row.intended_revision_json) as Record<string,unknown>;
      if(String(intended.kind)==='object'&&String(intended.disposition)==='create'){
        const owned=this.core.prepare(`SELECT 1 FROM feature_mutation_reservations WHERE owner_command_id=? AND lifecycle='active'`).get(commandId);
        if(!owned) throw new Error('Create mutation reservation was superseded or released before submission.');
      }
    }
    if (nextState === 'committed' && evidenceType !== 'commit') throw new Error('Committed state requires commit evidence.');
    const receiptRequired = nextState === 'readback_verified' || nextState === 'closed_not_applied';
    if (nextState === 'readback_verified' && !['readback','reconcile'].includes(evidenceType)) {
      throw new Error('Read-back verified state requires authoritative readback/reconcile evidence.');
    }
    if (nextState === 'closed_not_applied' && evidenceType !== 'reconcile') {
      throw new Error('Closed-not-applied state requires authoritative reconcile evidence.');
    }
    if (receiptRequired) {
      const receipt = this.core.prepare(`
        SELECT o.*,c.plan_digest AS command_plan_digest,c.evidence_operation_ids_json,c.evidence_target_identity_key,
          c.evidence_request_digest,i.target_key,c.state AS command_state,
          f.credential_digest,f.connector_id AS confirmation_connector_id,
          f.session_generation AS confirmation_session_generation,f.engagement_id AS confirmation_engagement_id,
          f.authority_instance_id AS confirmation_authority_instance_id,
          f.tenant_or_org_id AS confirmation_tenant_or_org_id,f.pack_id AS confirmation_pack_id
        FROM feature_operation_receipts o
        JOIN feature_commands c ON c.command_id=o.command_id AND c.run_id=o.run_id
        JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
        JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
        WHERE o.receipt_id=? AND o.command_id=? AND o.run_id=? AND o.feature_id=? AND o.feature_version=?
        ORDER BY f.created_at DESC LIMIT 1
      `).get(receiptId, commandId, runId, context.featureId, context.featureVersion) as Record<string, any> | undefined;
      const payloadReceiptId = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? String((payload as Record<string, unknown>).__operationReceiptId || '') : '';
      if (
        !receipt || payloadReceiptId !== receiptId
        || String(receipt.plan_digest) !== String(receipt.command_plan_digest)
        || String(receipt.frozen_target_key) !== String(receipt.target_key)
        || !(JSON.parse(String(receipt.evidence_operation_ids_json)) as string[]).includes(String(receipt.operation_id))
        || String(receipt.target_identity_key) !== String(receipt.evidence_target_identity_key)
        || String(receipt.request_digest) !== String(receipt.evidence_request_digest)
        || String(receipt.authority_digest) !== String(receipt.credential_digest)
        || String(receipt.connector_id) !== String(receipt.confirmation_connector_id)
        || Number(receipt.session_generation) !== Number(receipt.confirmation_session_generation)
        || String(receipt.engagement_id) !== String(receipt.confirmation_engagement_id)
        || String(receipt.authority_instance_id) !== String(receipt.confirmation_authority_instance_id)
        || String(receipt.tenant_or_org_id) !== String(receipt.confirmation_tenant_or_org_id)
        || String(receipt.pack_id) !== String(receipt.confirmation_pack_id)
        || !/^sha256:[0-9a-f]{64}$/u.test(String(receipt.operation_package_digest))
        || crypto.createHash('sha256').update(canonical(receiptPayload)).digest('hex') !== String(receipt.response_digest)
        || canonical(JSON.parse(String(receipt.response_json))) !== canonical(receiptPayload)
      ) throw new Error('Verified Return state requires an exact trusted Operation receipt bound to the frozen authority, plan, command, target, and response.');
    }
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      this.core.prepare(`INSERT INTO feature_command_evidence(evidence_id, command_id, run_id, evidence_type, evidence_digest, receipt_id, verified, payload_json, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(evidenceId, commandId, runId, evidenceType, evidenceDigest, receiptRequired ? receiptId : '', receiptRequired ? 1 : (request.verified === true ? 1 : 0), JSON.stringify(payload), occurredAt);
      this.core.prepare(`UPDATE feature_commands SET state=?, commit_point_at=CASE WHEN ?='commit' THEN ? ELSE commit_point_at END, submitted_at=CASE WHEN ?='request' THEN ? ELSE submitted_at END, completed_at=CASE WHEN ? IN ('readback_verified','closed_not_applied','failed') THEN ? ELSE completed_at END, last_error=? WHERE command_id=?`)
        .run(nextState, evidenceType, occurredAt, evidenceType, occurredAt, nextState, occurredAt, String(request.error || ''), commandId);
      if (['readback_verified','closed_not_applied'].includes(nextState)) this.core.prepare(`UPDATE managed_content_intents SET state='verified', updated_at=? WHERE intent_id=?`).run(occurredAt, row.intent_id);
      if (nextState==='readback_verified') this.core.prepare(`UPDATE feature_mutation_reservations SET lifecycle='completed',updated_at=? WHERE owner_command_id=? AND lifecycle='active'`).run(occurredAt,commandId);
      if (nextState==='closed_not_applied'||(nextState==='failed'&&row.state==='prepared')) this.core.prepare(`UPDATE feature_mutation_reservations SET lifecycle='released',updated_at=? WHERE owner_command_id=? AND lifecycle='active'`).run(occurredAt,commandId);
      if (nextState === 'uncertain') this.core.prepare(`UPDATE managed_content_intents SET state='uncertain', updated_at=? WHERE intent_id=?`).run(occurredAt, row.intent_id);
      if (nextState === 'failed') this.core.prepare(`UPDATE managed_content_intents SET state='failed', updated_at=? WHERE intent_id=?`).run(occurredAt, row.intent_id);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { evidenceId, evidenceDigest };
  }

  private projectVerifiedReturn(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Verified Return projection');
    const commandId = String(request.commandId || ''); const runId = String(request.runId || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=? AND state IN ('returning','verifying','reconciling')`).get(runId, context.featureId, context.featureVersion)) {
      throw new Error('Projection Run is not owned by the active Feature Return state.');
    }
    const command = this.core.prepare(`SELECT c.intent_id,c.state,c.plan_digest,i.target_kind,i.target_key,i.intended_revision_json,i.state AS intent_state FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest WHERE c.command_id=? AND c.run_id=?`).get(commandId, runId) as { intent_id: string; state: string; plan_digest:string; target_kind:string; target_key:string; intended_revision_json:string; intent_state:string } | undefined;
    const evidence = this.core.prepare(`SELECT evidence_id FROM feature_command_evidence WHERE command_id=? AND evidence_type IN ('readback','reconcile') AND receipt_id<>'' AND verified=1 ORDER BY occurred_at DESC LIMIT 1`).get(commandId) as { evidence_id: string } | undefined;
    if (!command || command.state !== 'readback_verified' || command.intent_state !== 'verified' || !evidence) throw new Error('Managed projection requires verified current read-back evidence.');
    const binding = object(request.binding, 'Projection authority binding');
    for (const field of ['authorityInstanceId', 'tenantOrOrgId', 'packId', 'engagementId']) if (!String(binding[field] || '')) throw new Error(`Projection authority is missing ${field}.`);
    const confirmation = this.core.prepare(`SELECT credential_digest,authority_instance_id,tenant_or_org_id,pack_id,engagement_id FROM feature_confirmations WHERE run_id=? AND plan_digest=? AND decision='approved' ORDER BY created_at DESC LIMIT 1`).get(runId, command.plan_digest) as Record<string,any>|undefined;
    const safety = this.core.prepare(`SELECT workspace_ids_json FROM workspace_safety WHERE singleton=1`).get() as {workspace_ids_json:string};
    const workspaceIds = JSON.parse(safety.workspace_ids_json) as string[];
    const authorityDigest = crypto.createHash('sha256').update(canonical({ connectorId:binding.connectorId,sessionGeneration:Number(binding.sessionGeneration),engagementId:binding.engagementId,authorityInstanceId:binding.authorityInstanceId,tenantOrOrgId:binding.tenantOrOrgId,packId:binding.packId,workspaceIds })).digest('hex');
    const workspaceId = String(request.workspaceId || ''); const projectionKind = String(request.projectionKind || ''); const occurredAt = now();
    const intended = JSON.parse(command.intended_revision_json) as Record<string, any>;
    if (!confirmation || confirmation.credential_digest !== authorityDigest
      || confirmation.authority_instance_id !== binding.authorityInstanceId
      || confirmation.tenant_or_org_id !== binding.tenantOrOrgId || confirmation.pack_id !== binding.packId
      || confirmation.engagement_id !== binding.engagementId || !workspaceIds.includes(workspaceId)
      || intended.workspace !== workspaceId || intended.key !== command.target_key || intended.kind !== command.target_kind
      || projectionKind !== (['relation','risk_control'].includes(command.target_kind) ? 'relation' : 'object')) {
      throw new Error('Projection differs from the frozen authority scope or intended target.');
    }
    this.core.exec('BEGIN IMMEDIATE;');
    try {
    if (projectionKind === 'object') {
      const objectType = String(request.objectType || ''); const objectId = String(request.objectId || '');
      if (objectType !== String(intended.objectType || '')) throw new Error('Object projection type differs from the frozen intent.');
      if (intended.graTargetKey) {
        const gra = this.core.prepare(`SELECT o.object_id FROM managed_content_intents i JOIN feature_commands c ON c.intent_id=i.intent_id AND c.state='readback_verified' JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified' AND o.object_type='GRA' ORDER BY o.verified_at DESC LIMIT 1`).get(runId,String(intended.graTargetKey)) as {object_id:string}|undefined;
        if (!gra || gra.object_id !== objectId) throw new Error('GRA revision projection is not bound to the verified frozen GRA target.');
      }
      if (intended.objectTargetKey) {
        const parent=this.core.prepare(`SELECT o.object_id FROM managed_content_intents i JOIN feature_commands c ON c.intent_id=i.intent_id AND c.state='readback_verified' JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified' ORDER BY o.verified_at DESC LIMIT 1`).get(runId,String(intended.objectTargetKey)) as {object_id:string}|undefined;
        if(!parent||parent.object_id!==objectId) throw new Error('IT Element settings projection is not bound to the verified frozen object target.');
      }
      const current = this.core.prepare(`SELECT current_revision FROM managed_objects WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND object_type=? AND object_id=?`)
        .get(binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId, workspaceId, objectType, objectId) as { current_revision: number } | undefined;
      const revision = Number(current?.current_revision || 0) + 1;
      this.core.prepare(`INSERT INTO managed_objects(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,current_revision,lifecycle,freshness,updated_at) VALUES(?,?,?,?,?,?,?,?,'active','verified_current',?) ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id) DO UPDATE SET current_revision=excluded.current_revision,lifecycle='active',freshness='verified_current',updated_at=excluded.updated_at`)
        .run(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,objectType,objectId,revision,occurredAt);
      this.core.prepare(`INSERT INTO managed_object_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,revision,run_id,intent_id,command_id,evidence_id,provenance_json,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,objectType,objectId,revision,runId,command.intent_id,commandId,evidence.evidence_id,JSON.stringify(request.provenance || {}),JSON.stringify(request.payload || {}),occurredAt);
    } else if (projectionKind === 'relation') {
      const relationType=String(request.relationType||''); const relationKey=String(request.relationKey||''); const source=String(request.sourceObjectId||''); const targetId=String(request.targetObjectId||'');
      const resolvedRelationObject=(targetKey:string)=>this.core.prepare(`SELECT o.object_id FROM managed_content_intents i JOIN feature_commands c ON c.intent_id=i.intent_id AND c.run_id=i.run_id AND c.state='readback_verified' JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified' ORDER BY o.verified_at DESC LIMIT 1`).get(runId,targetKey) as {object_id:string}|undefined;
      if(command.target_kind==='risk_control'){
        const catalog=intended.resolvedCatalog as Record<string,unknown>|undefined;
        const storedSpec=this.core.prepare(`SELECT spec_json FROM feature_command_specs WHERE command_id=? AND run_id=?`).get(commandId,runId) as {spec_json:string}|undefined;
        const spec=storedSpec?JSON.parse(storedSpec.spec_json) as Record<string,any>:undefined;
        const payload=spec?.mutationPayload as Record<string,any>|undefined; const scope=Array.isArray(payload?.controlRiskScopes)?payload.controlRiskScopes[0]:undefined;
        const frozenRiskId=String(catalog?.riskId||payload?.riskId||''); const frozenControlId=String(catalog?.controlId||scope?.controlId||'');
        if(relationType!=='risk_control'||relationKey!==command.target_key||!catalog
          &&(!payload||String(payload.riskName||'')!==String(intended.riskName||'')||String(payload.controlName||'')!==String(intended.controlName||''))
          ||!frozenRiskId||!frozenControlId||source!==frozenRiskId||targetId!==frozenControlId) throw new Error('Risk-Control projection differs from the frozen/signed catalog identities.');
      }else{
        const expectedSource=resolvedRelationObject(String(intended.sourceObjectTargetKey||'')); const expectedTarget=resolvedRelationObject(String(intended.targetObjectTargetKey||''));
        if (relationType !== String(intended.relationType || '') || relationKey !== command.target_key
          ||!expectedSource||!expectedTarget||source!==expectedSource.object_id||targetId!==expectedTarget.object_id) throw new Error('Relation projection differs from the frozen intent or its receipt-backed source/target object IDs.');
      }
      const current=this.core.prepare(`SELECT current_revision FROM managed_relations WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND relation_type=? AND relation_key=?`).get(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey) as {current_revision:number}|undefined;
      const revision=Number(current?.current_revision||0)+1;
      this.core.prepare(`INSERT INTO managed_relations(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,current_revision,lifecycle,freshness,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'active','verified_current',?) ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key) DO UPDATE SET current_revision=excluded.current_revision,lifecycle='active',freshness='verified_current',updated_at=excluded.updated_at`).run(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey,source,targetId,revision,occurredAt);
      this.core.prepare(`INSERT INTO managed_relation_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,revision,run_id,intent_id,command_id,evidence_id,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey,source,targetId,revision,runId,command.intent_id,commandId,evidence.evidence_id,JSON.stringify(request.payload||{}),occurredAt);
    } else throw new Error('Unsupported verified projection kind.');
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return true;
  }

  private finishReturn(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Return completion'); const runId = String(request.runId || '');
    const run = this.core.prepare(`SELECT state,state_revision FROM feature_runs WHERE run_id=? AND feature_id=?`).get(runId, context.featureId) as {state:string;state_revision:number}|undefined;
    if (!run || !['returning','verifying','uncertain','reconciling'].includes(run.state)) throw new Error('Return completion Run state is invalid.');
    const outcome=String(request.outcome||''); const toState=outcome==='succeeded'?'succeeded':outcome==='uncertain'?'uncertain':'failed';
    const transitions:Record<string,string[]>={returning:['verifying','failed','uncertain'],verifying:['succeeded','failed','uncertain'],uncertain:['reconciling'],reconciling:['succeeded','failed','uncertain']};
    let state=run.state; let revision=run.state_revision;
    if (toState === 'succeeded') {
      const incomplete = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state<>'verified'`).get(runId) as {count:number};
      const openCommands = this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state NOT IN ('readback_verified','closed_not_applied')`).get(runId) as {count:number};
      const missingProjection = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents i WHERE i.run_id=? AND i.state='verified' AND NOT EXISTS (SELECT 1 FROM feature_commands c WHERE c.intent_id=i.intent_id AND (c.state='closed_not_applied' OR (c.state='readback_verified' AND (EXISTS(SELECT 1 FROM managed_object_revisions o WHERE o.command_id=c.command_id AND o.run_id=c.run_id) OR EXISTS(SELECT 1 FROM managed_relation_revisions r WHERE r.command_id=c.command_id AND r.run_id=c.run_id)))))`).get(runId) as {count:number};
      if (incomplete.count || openCommands.count || missingProjection.count) throw new Error('Return cannot succeed while intents, commands, or required verified projections are incomplete.');
    }
    if (state==='returning' && toState==='succeeded') { revision=this.transitionRun({runId,expectedRevision:revision,toState:'verifying',eventType:'return.commit_batch_complete'},context); state='verifying'; }
    if (!transitions[state]?.includes(toState)) throw new Error(`Illegal return completion: ${state} -> ${toState}.`);
    this.transitionRun({runId,expectedRevision:revision,toState,eventType:`return.${toState}`,error:String(request.error||'')},context);
    return true;
  }

  private recordBootstrapCapabilityEvidence(input: unknown, context: FeatureWorkerPortContext): { recorded: boolean; expiresAt: string } {
    if (!context.allowMutation) throw new Error('Bootstrap capability evidence requires an authorized mutation invocation.');
    const request = object(input, 'Bootstrap capability evidence'); const runId = String(request.runId || '');
    const scenarioId = String(request.scenarioId || ''); const capabilityId = String(request.capabilityId || '');
    if (request.schemaVersion !== 'omnia.feature-capability-evidence-bootstrap/v1'
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(scenarioId)
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(capabilityId)) {
      throw new Error('Bootstrap capability evidence schema or capability declaration is invalid.');
    }
    const binding = object(request.connectorBinding, 'Bootstrap Connector binding'); const safety = object(request.safetyLock, 'Bootstrap safety scope');
    const run = this.core.prepare(`SELECT state FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`)
      .get(runId, context.featureId, context.featureVersion) as { state: string } | undefined;
    if (!run || !['returning','verifying'].includes(run.state)) throw new Error('Bootstrap evidence requires the current verified Return batch before terminal completion.');
    const durableIntents = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=?`).get(runId) as { count: number };
    const durableCommands = this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=?`).get(runId) as { count: number };
    const incomplete = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state<>'verified'`).get(runId) as { count: number };
    const badCommands = this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state NOT IN ('readback_verified','closed_not_applied')`).get(runId) as { count: number };
    const badReadback = this.core.prepare(`
      SELECT COUNT(*) AS count FROM feature_commands c
      WHERE c.run_id=? AND c.state='readback_verified' AND NOT EXISTS(
        SELECT 1 FROM feature_command_evidence e
        JOIN feature_operation_receipts r ON r.receipt_id=e.receipt_id
        WHERE e.command_id=c.command_id AND e.run_id=c.run_id
          AND e.evidence_type IN ('readback','reconcile') AND e.verified=1
          AND r.command_id=c.command_id AND r.run_id=c.run_id AND r.plan_digest=c.plan_digest
          AND r.feature_id=? AND r.feature_version=?
      )
    `).get(runId, context.featureId, context.featureVersion) as { count: number };
    if (durableIntents.count < 1 || durableCommands.count < 1 || incomplete.count || badCommands.count || badReadback.count) {
      throw new Error('Bootstrap evidence requires durable intents, commands, and authoritative read-back evidence for the completed Return batch.');
    }
    const confirmation = this.core.prepare(`SELECT authority_instance_id,tenant_or_org_id,pack_id,engagement_id FROM feature_confirmations WHERE run_id=? AND decision='approved' ORDER BY created_at DESC LIMIT 1`).get(runId) as Record<string, unknown> | undefined;
    const workspaceIds = Array.isArray(safety.workspaceIds) ? [...new Set(safety.workspaceIds.map(String))].sort() : [];
    if (!confirmation || workspaceIds.length < 1 || safety.enabled !== true
      || String(binding.authorityInstanceId || '') !== String(confirmation.authority_instance_id)
      || String(binding.tenantOrOrgId || '') !== String(confirmation.tenant_or_org_id)
      || String(binding.packId || '') !== String(confirmation.pack_id)
      || String(binding.engagementId || '') !== String(confirmation.engagement_id)
      || String(safety.engagementId || '') !== String(binding.engagementId || '')) throw new Error('Bootstrap evidence scope differs from the approved authority and safety lock.');
    const operationRows = this.core.prepare(`SELECT DISTINCT operation_package_digest FROM feature_operation_receipts WHERE run_id=? AND feature_id=? AND feature_version=?`).all(runId, context.featureId, context.featureVersion) as Array<{ operation_package_digest: string }>;
    if (operationRows.length !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(operationRows[0]!.operation_package_digest)) throw new Error('Bootstrap evidence requires one exact verified Operation package digest.');
    const commandEvidence = this.core.prepare(`
      SELECT c.command_id,c.operation_id,c.plan_digest,i.target_key,c.state,e.evidence_type,e.evidence_digest,e.receipt_id,
        r.operation_package_digest,r.target_identity_key,r.workspace_ids_json
      FROM feature_commands c
      JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
      JOIN feature_command_evidence e ON e.command_id=c.command_id AND e.run_id=c.run_id AND e.verified=1
      JOIN feature_operation_receipts r ON r.receipt_id=e.receipt_id AND r.command_id=c.command_id AND r.run_id=c.run_id
        AND r.plan_digest=c.plan_digest AND r.feature_id=? AND r.feature_version=?
      WHERE c.run_id=? AND e.evidence_type IN ('readback','reconcile')
      ORDER BY c.command_id,e.occurred_at
    `).all(context.featureId, context.featureVersion, runId);
    if (commandEvidence.length < 1) throw new Error('Bootstrap capability evidence requires at least one authoritative read-back receipt in the declared scope.');
    const evidenceDigest = crypto.createHash('sha256').update(canonical({ runId, scenarioId, capabilityId, commandEvidence })).digest('hex');
    const verifiedAt = now(); const expiresAt = new Date(Date.parse(verifiedAt) + 30 * 24 * 60 * 60_000).toISOString();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      for (const workspaceId of workspaceIds) this.core.prepare(`
        INSERT INTO feature_capability_evidence(capability_evidence_id,feature_id,feature_version,operation_package_digest,scenario_id,capability_id,authority_instance_id,tenant_or_org_id,pack_contract_id,engagement_id,workspace_id,automated_status,portable_status,canary_status,readback_status,evidence_digest,verified,verified_at,expires_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'passed','passed','passed','passed',?,1,?,?,'')
        ON CONFLICT(feature_id,feature_version,operation_package_digest,scenario_id,capability_id,authority_instance_id,tenant_or_org_id,pack_contract_id,engagement_id,workspace_id)
        DO UPDATE SET automated_status='passed',portable_status='passed',canary_status='passed',readback_status='passed',evidence_digest=excluded.evidence_digest,verified=1,verified_at=excluded.verified_at,expires_at=excluded.expires_at,revoked_at=''
      `).run(randomUUID(),context.featureId,context.featureVersion,operationRows[0]!.operation_package_digest,scenarioId,capabilityId,String(binding.authorityInstanceId),String(binding.tenantOrOrgId),String(binding.packId),String(binding.engagementId),workspaceId,evidenceDigest,verifiedAt,expiresAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { recorded: true, expiresAt };
  }

  private recordTemplateMetadata(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Template metadata');
    if (request.status !== 'candidate') throw new Error('Worker-created TemplateVersion must remain candidate until separately authorized.');
    const output = this.core.prepare(`
      SELECT sha256 FROM feature_artifacts WHERE artifact_id=? AND feature_id=? AND run_id=? AND kind='template_instance'
    `).get(String(request.outputArtifactId || ''), context.featureId, String(request.runId || '')) as { sha256: string } | undefined;
    if (!output || output.sha256 !== request.outputFileDigest) throw new Error('TemplateInstance output artifact digest mismatch.');
    if (!/^[0-9a-f]{64}$/u.test(String(request.baseFileDigest || ''))) throw new Error('TemplateVersion base digest is invalid.');
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(request.basePackageDigest || ''))) throw new Error('TemplateVersion package digest is invalid.');
    const base = this.core.prepare(`
      SELECT member_digest, package_digest, asset_kind
      FROM feature_managed_assets
      WHERE feature_id=? AND feature_version=? AND member_path=?
    `).get(context.featureId, context.featureVersion, String(request.baseAssetPath || '')) as {
      member_digest: string; package_digest: string; asset_kind: string;
    } | undefined;
    if (!base || base.asset_kind !== 'runtime_template_base'
      || base.member_digest !== request.baseFileDigest || base.package_digest !== request.basePackageDigest) {
      throw new Error('TemplateVersion base is not the signed managed runtime-template asset.');
    }
    const governancePath = String(request.governanceArtifactId || '').replace(/^ofp-member:/u, '');
    const governance = this.core.prepare(`
      SELECT member_digest, asset_kind FROM feature_managed_assets
      WHERE feature_id=? AND feature_version=? AND member_path=?
    `).get(context.featureId, context.featureVersion, governancePath) as { member_digest: string; asset_kind: string } | undefined;
    if (!governance || governance.asset_kind !== 'governance') {
      throw new Error('TemplateVersion governance source is not a signed managed governance asset.');
    }
    for (const field of ['semanticDigest', 'instanceSemanticDigest', 'patchDigest', 'outputFileDigest']) {
      if (!/^[0-9a-f]{64}$/u.test(String(request[field] || ''))) throw new Error(`Template metadata ${field} is invalid.`);
    }
    for (const field of ['templateVersionId', 'templateInstanceId', 'templateId', 'version', 'schemaVersion', 'owner', 'license']) {
      if (!String(request[field] || '').trim()) throw new Error(`Template metadata ${field} is required.`);
    }
    const createdAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      this.core.prepare(`
        INSERT OR IGNORE INTO template_versions(
          template_version_id, template_id, version, status, source_artifact_id, file_digest,
          semantic_digest, schema_version, owner, license, authorization_ref, requested_by,
          published_by, published_at, created_at
        ) VALUES(?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, '', '', '', '', ?)
      `).run(
        String(request.templateVersionId || ''), String(request.templateId || ''), String(request.version || ''),
        `ofp-member:${governancePath}:sha256:${governance.member_digest}`, String(request.baseFileDigest || ''), String(request.semanticDigest || ''),
        String(request.schemaVersion || ''), String(request.owner || 'unassigned'), String(request.license || 'unconfirmed'), createdAt
      );
      const version = this.core.prepare(`
        SELECT file_digest, semantic_digest, status FROM template_versions WHERE template_version_id=?
      `).get(String(request.templateVersionId)) as { file_digest: string; semantic_digest: string; status: string } | undefined;
      if (!version || version.file_digest !== request.baseFileDigest || version.semantic_digest !== request.semanticDigest || version.status !== 'candidate') {
        throw new Error('TemplateVersion identity or immutable base digest drifted.');
      }
      this.core.prepare(`
        INSERT INTO template_instances(
          template_instance_id, run_id, template_version_id, source_artifact_id, output_artifact_id,
          patch_digest, semantic_digest, output_file_digest, governance_digest, state, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
      `).run(String(request.templateInstanceId || ''), String(request.runId), String(request.templateVersionId),
        String(request.sourceArtifactId), String(request.outputArtifactId), String(request.patchDigest || ''),
        String(request.instanceSemanticDigest || ''), String(request.outputFileDigest), governance.member_digest, createdAt, createdAt);
      this.core.prepare(`INSERT INTO template_instance_field_revisions(template_instance_id,field_revision_id,field_key,revision,bound_at) SELECT ?,r.field_revision_id,r.field_key,r.revision,? FROM feature_field_revisions r WHERE r.run_id=? AND r.revision=(SELECT MAX(r2.revision) FROM feature_field_revisions r2 WHERE r2.run_id=r.run_id AND r2.field_key=r.field_key)`).run(String(request.templateInstanceId||''),createdAt,String(request.runId));
      this.core.prepare(`UPDATE feature_field_revisions SET template_instance_id=? WHERE run_id=? AND template_instance_id='' AND field_revision_id IN (SELECT field_revision_id FROM template_instance_field_revisions WHERE template_instance_id=?)`).run(String(request.templateInstanceId||''),String(request.runId),String(request.templateInstanceId||''));
      this.core.prepare(`
        UPDATE feature_runs SET template_version_id=?, output_artifact_id=?, updated_at=?
        WHERE run_id=? AND feature_id=?
      `).run(String(request.templateVersionId), String(request.outputArtifactId), createdAt, String(request.runId), context.featureId);
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
    return true;
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
    object(input, 'Managed content record');
    void context;
    throw new Error('Legacy Managed Content projection is disabled; only receipt-backed signed Operation projection may advance current state.');
  }
}
