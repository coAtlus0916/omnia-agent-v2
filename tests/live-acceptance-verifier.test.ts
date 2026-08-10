import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const repository = path.resolve(import.meta.dirname, '..');
const evidenceDirectory = path.join(repository, 'acceptance-evidence', 'create-associate-20260810');
const verifierUrl = pathToFileURL(path.join(repository, 'scripts', 'verify-create-delete-live-acceptance.mjs')).href;
const WORKSPACE = '70628353-3b7c-f111-b337-0017fa079a58';
const ENGAGEMENT = 'bf2ff2d6-a758-4de4-d3a0-08dec1d74b3b';
const AUTHORITY = { authority: 'authority-test', tenant: 'tenant-test', pack: 'pack-test', connector: 'connector-test', session: 7, credential: 'a'.repeat(64) };
const CONNECTOR_BINDING = { connectorId: AUTHORITY.connector, sessionGeneration: AUTHORITY.session, engagementId: ENGAGEMENT,
  authorityInstanceId: AUTHORITY.authority, tenantOrOrgId: AUTHORITY.tenant, packId: AUTHORITY.pack };

function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(value: any): string {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function createCore(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE feature_runs(run_id TEXT PRIMARY KEY,feature_id TEXT,feature_version TEXT,engagement_id TEXT,state TEXT,state_revision INTEGER,plan_digest TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE feature_artifacts(artifact_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,source_kind TEXT,original_name TEXT,sha256 TEXT);
    CREATE TABLE managed_content_intents(intent_id TEXT PRIMARY KEY,run_id TEXT,plan_digest TEXT,target_kind TEXT,target_key TEXT,intended_revision_json TEXT,state TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE feature_commands(command_id TEXT PRIMARY KEY,run_id TEXT,intent_id TEXT,operation_id TEXT,idempotency_key TEXT,plan_digest TEXT,request_digest TEXT,evidence_operation_ids_json TEXT,evidence_target_identity_key TEXT,evidence_request_digest TEXT,state TEXT,created_at TEXT);
    CREATE TABLE feature_command_specs(command_id TEXT PRIMARY KEY,run_id TEXT,spec_json TEXT,created_at TEXT);
    CREATE TABLE feature_confirmations(confirmation_id TEXT PRIMARY KEY,run_id TEXT,plan_digest TEXT,connector_id TEXT,session_generation INTEGER,engagement_id TEXT,credential_digest TEXT,decision TEXT,created_at TEXT,authority_instance_id TEXT,tenant_or_org_id TEXT,pack_id TEXT);
    CREATE TABLE feature_operation_receipts(receipt_id TEXT PRIMARY KEY,run_id TEXT,command_id TEXT,feature_id TEXT,feature_version TEXT,operation_package_digest TEXT,operation_id TEXT,authority_digest TEXT,connector_id TEXT,session_generation INTEGER,engagement_id TEXT,frozen_target_key TEXT,target_identity_key TEXT,workspace_ids_json TEXT,plan_digest TEXT,request_digest TEXT,response_digest TEXT,response_json TEXT,created_at TEXT,authority_instance_id TEXT,tenant_or_org_id TEXT,pack_id TEXT);
    CREATE TABLE feature_command_evidence(evidence_id TEXT PRIMARY KEY,command_id TEXT,run_id TEXT,evidence_type TEXT,evidence_digest TEXT,receipt_id TEXT,verified INTEGER,payload_json TEXT,occurred_at TEXT);
    CREATE TABLE managed_objects(authority_instance_id TEXT,tenant_or_org_id TEXT,pack_id TEXT,engagement_id TEXT,workspace_id TEXT,object_type TEXT,object_id TEXT,current_revision INTEGER,lifecycle TEXT,freshness TEXT,updated_at TEXT,PRIMARY KEY(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id));
    CREATE TABLE managed_object_revisions(revision_id TEXT PRIMARY KEY,authority_instance_id TEXT,tenant_or_org_id TEXT,pack_id TEXT,engagement_id TEXT,workspace_id TEXT,object_type TEXT,object_id TEXT,revision INTEGER,run_id TEXT,intent_id TEXT,command_id TEXT,evidence_id TEXT,provenance_json TEXT,payload_json TEXT,verified_at TEXT);
    CREATE TABLE managed_relations(authority_instance_id TEXT,tenant_or_org_id TEXT,pack_id TEXT,engagement_id TEXT,workspace_id TEXT,relation_type TEXT,relation_key TEXT,source_object_id TEXT,target_object_id TEXT,current_revision INTEGER,lifecycle TEXT,freshness TEXT,updated_at TEXT,PRIMARY KEY(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key));
    CREATE TABLE managed_relation_revisions(revision_id TEXT PRIMARY KEY,authority_instance_id TEXT,tenant_or_org_id TEXT,pack_id TEXT,engagement_id TEXT,workspace_id TEXT,relation_type TEXT,relation_key TEXT,source_object_id TEXT,target_object_id TEXT,revision INTEGER,run_id TEXT,intent_id TEXT,command_id TEXT,evidence_id TEXT,payload_json TEXT,verified_at TEXT);
  `);
  return db;
}

function addRun(db: DatabaseSync, runId: string, featureId: string, version: string, state = 'succeeded'): string {
  const planDigest = digest(`plan:${runId}`); const now = '2026-08-10T00:00:00.000Z';
  db.prepare('INSERT INTO feature_runs VALUES(?,?,?,?,?,?,?,?,?)').run(runId, featureId, version, ENGAGEMENT, state, 10, planDigest, now, now);
  db.prepare('INSERT INTO feature_confirmations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(`confirmation:${runId}`, runId, planDigest, AUTHORITY.connector, AUTHORITY.session, ENGAGEMENT, AUTHORITY.credential, 'approved', now, AUTHORITY.authority, AUTHORITY.tenant, AUTHORITY.pack);
  return planDigest;
}

let serial = 0;
function addTrust(db: DatabaseSync, input: { runId: string; featureId: string; version: string; planDigest: string; targetKey: string;
  operation: string; response?: any; intended?: any; request?: any; evidenceRequest?: any; evidenceOperation?: string;
  targetKind?: string; targetIdentity?: string; spec?: any; saveSpec?: boolean }): { commandId: string; intentId: string; evidenceId: string; receiptId: string } {
  serial += 1;
  const commandId = `command-${serial}`; const intentId = `intent-${serial}`; const evidenceId = `evidence-${serial}`; const receiptId = `receipt-${serial}`;
  const targetIdentity = input.targetIdentity ?? `target-${serial}`; const evidenceOperation = input.evidenceOperation ?? `${input.operation}.readback`;
  const exactRequest = input.request ?? { workspaceId: WORKSPACE }; const requestDigest = digest(exactRequest);
  const exactEvidenceRequest = input.evidenceRequest ?? exactRequest; const evidenceRequestDigest = digest(exactEvidenceRequest);
  const response = input.response ?? { verified: true };
  const evidencePayload = { ...response, __operationReceiptId: receiptId }; const responseDigest = digest(response); const now = `2026-08-10T00:00:${String(serial % 60).padStart(2, '0')}.000Z`;
  const intended = input.intended ?? { kind: input.targetKind ?? 'object', key: input.targetKey, workspace: WORKSPACE, mutationPayload: exactRequest };
  db.prepare('INSERT INTO managed_content_intents VALUES(?,?,?,?,?,?,?,?,?)').run(intentId, input.runId, input.planDigest, input.targetKind ?? intended.kind ?? 'object', input.targetKey, JSON.stringify(intended), 'verified', now, now);
  db.prepare('INSERT INTO feature_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(commandId, input.runId, intentId, input.operation, `idem-${serial}`, input.planDigest, requestDigest, JSON.stringify([evidenceOperation]), targetIdentity, evidenceRequestDigest, 'readback_verified', now);
  if (input.saveSpec !== false) db.prepare('INSERT INTO feature_command_specs VALUES(?,?,?,?)').run(commandId, input.runId,
    JSON.stringify(input.spec ?? { operationId: input.operation, targetKey: input.targetKey, request: exactRequest }), now);
  db.prepare('INSERT INTO feature_operation_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(receiptId, input.runId, commandId, input.featureId, input.version, `sha256:${digest(`package:${input.featureId}:${input.version}`)}`, evidenceOperation, AUTHORITY.credential, AUTHORITY.connector, AUTHORITY.session, ENGAGEMENT, input.targetKey, targetIdentity, JSON.stringify([WORKSPACE]), input.planDigest, evidenceRequestDigest, responseDigest, JSON.stringify(response), now, AUTHORITY.authority, AUTHORITY.tenant, AUTHORITY.pack);
  db.prepare('INSERT INTO feature_command_evidence VALUES(?,?,?,?,?,?,?,?,?)').run(evidenceId, commandId, input.runId, 'readback', responseDigest, receiptId, 1, JSON.stringify(evidencePayload), now);
  return { commandId, intentId, evidenceId, receiptId };
}

function upsertCurrentObject(db: DatabaseSync, type: string, id: string, revision: number, lifecycle: string): void {
  db.prepare(`INSERT INTO managed_objects VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET current_revision=excluded.current_revision,lifecycle=excluded.lifecycle,freshness=excluded.freshness,updated_at=excluded.updated_at`)
    .run(AUTHORITY.authority, AUTHORITY.tenant, AUTHORITY.pack, ENGAGEMENT, WORKSPACE, type, id, revision, lifecycle, 'verified_current', '2026-08-10T01:00:00.000Z');
}

function addObjectRevision(db: DatabaseSync, input: { runId: string; featureId: string; version: string; planDigest: string; type: string; id: string; revision: number; targetKey: string; payload: any; lifecycle?: string; operation?: string; intended?: any; request?: any }): any {
  const trust = addTrust(db, { runId: input.runId, featureId: input.featureId, version: input.version, planDigest: input.planDigest, targetKey: input.targetKey, operation: input.operation ?? `${input.featureId}.mutation.v1`, response: input.payload, intended: input.intended, request: input.request, targetKind: input.intended?.kind ?? 'object' });
  const revisionId = `revision-${++serial}`;
  db.prepare('INSERT INTO managed_object_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(revisionId, AUTHORITY.authority, AUTHORITY.tenant, AUTHORITY.pack, ENGAGEMENT, WORKSPACE, input.type, input.id, input.revision, input.runId, trust.intentId, trust.commandId, trust.evidenceId, JSON.stringify({ rowKey: input.targetKey.split('|')[1], targetKey: input.targetKey }), JSON.stringify(input.payload), '2026-08-10T01:00:00.000Z');
  upsertCurrentObject(db, input.type, input.id, input.revision, input.lifecycle ?? 'active');
  return { revision_id: revisionId, workspace_id: WORKSPACE, object_type: input.type, object_id: input.id, revision: input.revision, run_id: input.runId, ...trust };
}

function upsertCurrentRelation(db: DatabaseSync, type: string, key: string, source: string, target: string, revision: number, lifecycle: string): void {
  db.prepare(`INSERT INTO managed_relations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET current_revision=excluded.current_revision,lifecycle=excluded.lifecycle,freshness=excluded.freshness,updated_at=excluded.updated_at`)
    .run(AUTHORITY.authority, AUTHORITY.tenant, AUTHORITY.pack, ENGAGEMENT, WORKSPACE, type, key, source, target, revision, lifecycle, 'verified_current', '2026-08-10T01:00:00.000Z');
}

function addRelationRevision(db: DatabaseSync, input: { runId: string; featureId: string; version: string; planDigest: string; type: string; key: string; source: string; target: string; revision: number; payload: any; lifecycle?: string; operation?: string; intended?: any; request?: any; evidenceRequest?: any; evidenceOperation?: string; targetIdentity?: string; spec?: any; saveSpec?: boolean }): any {
  const trust = addTrust(db, { runId: input.runId, featureId: input.featureId, version: input.version, planDigest: input.planDigest,
    targetKey: input.key, operation: input.operation ?? `${input.featureId}.mutation.v1`, response: input.payload,
    targetKind: input.intended?.kind ?? (input.type === 'risk_control' ? 'risk_control' : 'relation'),
    ...(input.intended === undefined ? {} : { intended: input.intended }), ...(input.request === undefined ? {} : { request: input.request }),
    ...(input.evidenceRequest === undefined ? {} : { evidenceRequest: input.evidenceRequest }),
    ...(input.evidenceOperation === undefined ? {} : { evidenceOperation: input.evidenceOperation }),
    ...(input.targetIdentity === undefined ? {} : { targetIdentity: input.targetIdentity }),
    ...(input.spec === undefined ? {} : { spec: input.spec }), ...(input.saveSpec === undefined ? {} : { saveSpec: input.saveSpec }) });
  const revisionId = `relation-revision-${++serial}`;
  db.prepare('INSERT INTO managed_relation_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(revisionId, AUTHORITY.authority, AUTHORITY.tenant, AUTHORITY.pack, ENGAGEMENT, WORKSPACE, input.type, input.key, input.source, input.target, input.revision, input.runId, trust.intentId, trust.commandId, trust.evidenceId, JSON.stringify(input.payload), '2026-08-10T01:00:00.000Z');
  upsertCurrentRelation(db, input.type, input.key, input.source, input.target, input.revision, input.lifecycle ?? 'active');
  return { revision_id: revisionId, workspace_id: WORKSPACE, relation_type: input.type, relation_key: input.key, source_object_id: input.source, target_object_id: input.target, revision: input.revision, run_id: input.runId, ...trust };
}

async function buildPassingFixture(root: string, fixtureOptions: { crossGraRisk?: boolean } = {}): Promise<{ core: string; deletion: string; manifest: any }> {
  const verifier = await import(verifierUrl); const manifest = verifier.loadAcceptanceManifest(evidenceDirectory);
  const core = path.join(root, 'core.sqlite'); const db = createCore(core); db.exec('BEGIN IMMEDIATE'); const createVersion = '9.8.7'; const deleteVersion = '8.7.6';
  const allObjects: any[] = []; const allRelations: any[] = []; const allRows: any[] = [];
  for (const [batchIndex, batch] of manifest.batches.entries()) {
    const runId = `create-run-${batchIndex}`; const planDigest = addRun(db, runId, 'omnia.create-associate', createVersion);
    db.prepare('INSERT INTO feature_artifacts VALUES(?,?,?,?,?,?)').run(`artifact-${batchIndex}`, runId, 'source', 'user_import', batch.workbookName, batch.workbookSha256);
    const appIds = new Map<string, string>(); const rowData: any[] = [];
    for (const [rowIndex, expected] of batch.rows.entries()) {
      const rowKey = digest(`${batch.workbookName}:${expected.elementId}`); const objectId = `object-${batchIndex}-${rowIndex}`; const graId = `gra-${batchIndex}-${rowIndex}`;
      const objectType = ({ APP: 'Application', DB: 'Infrastructure', OS: 'Infrastructure', TOOL: 'ITTool', DCNO: 'Infrastructure' } as any)[expected.kind];
      const object = addObjectRevision(db, { runId, featureId: 'omnia.create-associate', version: createVersion, planDigest, type: objectType, id: objectId, revision: 1, targetKey: `object|${rowKey}`, payload: { id: objectId, name: expected.elementId, number: expected.elementId } });
      const inkContentId = `content-${batchIndex}-${rowIndex}`; const typeId = `type-${expected.kind}`;
      const gra = addObjectRevision(db, { runId, featureId: 'omnia.create-associate', version: createVersion, planDigest, type: 'GRA', id: graId, revision: 1, targetKey: `gra|${rowKey}`,
        payload: { id: graId, entityId: objectId, name: `GRA-${expected.elementId}`, inkContentId },
        intended: { key: `gra|${rowKey}`, contentName: expected.subtype, contentIdentity: { inkContentId, typeId } },
        request: { workspaceId: WORKSPACE, inkContentId, typeId } });
      addObjectRevision(db, { runId, featureId: 'omnia.create-associate', version: createVersion, planDigest, type: 'GRA', id: graId, revision: 2, targetKey: `gra-rait|${rowKey}`, payload: { verified: true, value: expected.rait } });
      addObjectRevision(db, { runId, featureId: 'omnia.create-associate', version: createVersion, planDigest, type: 'GRA', id: graId, revision: 3, targetKey: `evaluation|${rowKey}`, payload: { verified: true, status: 'EvaluationComplete' } });
      if (expected.kind === 'APP') appIds.set(expected.elementId, objectId);
      const riskRelations = []; const riskControlIdentities = [];
      for (let relationIndex = 0; relationIndex < expected.riskControlRequired; relationIndex += 1) {
        const identity = { riskId: fixtureOptions.crossGraRisk && relationIndex === 0 ? 'shared-cross-gra-risk' : `risk-${batchIndex}-${rowIndex}-${relationIndex}`,
          riskRiskScopeId: `risk-risk-scope-${batchIndex}-${rowIndex}-${relationIndex}`,
          riskScopeId: `risk-scope-${batchIndex}-${rowIndex}-${relationIndex}`, controlId: `control-${batchIndex}-${rowIndex}-${relationIndex}`,
          assertionType: 'Assertion', assertion: `assertion-${relationIndex}` };
        const key = `risk-control|${rowKey}|REL-${relationIndex}`; const targetIdentity = `risk-control-target|${rowKey}|${relationIndex}`;
        const readOperation = 'omnia.create-associate.risk-control.reconcile.v1';
        const readRequest = { target: { targetIdentityKey: targetIdentity, workspaceId: WORKSPACE }, query: { ...identity } };
        const mutationPayload = { riskAssessmentId: graId, riskId: identity.riskId, controlRiskScopes: [{ controlId: identity.controlId,
          riskScopeId: identity.riskScopeId, assertionType: identity.assertionType, assertions: [{ assertion: identity.assertion }] }] };
        const payload = { verified: true, ...identity, graId };
        riskRelations.push(addRelationRevision(db, { runId, featureId: 'omnia.create-associate', version: createVersion, planDigest,
          type: 'risk_control', key, source: identity.riskId, target: identity.controlId, revision: 1, payload,
          operation: 'omnia.create-associate.risk-control.associate.v1', evidenceOperation: readOperation, targetIdentity,
          request: mutationPayload, evidenceRequest: { connectorBinding: CONNECTOR_BINDING, ...readRequest },
          intended: { kind: 'risk_control', key, rowKey, workspace: WORKSPACE, objectType: 'GRA', graTargetKey: `gra|${rowKey}`,
            resolvedCatalog: { ...identity, updatedOn: '2026-08-10T00:00:00.000Z' } },
          spec: { mutationPayload, readOperation, readRequest } }));
        riskControlIdentities.push(identity);
      }
      rowData.push({ expected, rowKey, object, gra, riskRelations, riskControlIdentities }); allObjects.push(object, gra);
    }
    const inheritanceRevisionByGra = new Map<string, number>();
    for (const row of rowData.filter((candidate) => candidate.expected.kind === 'DCNO')) for (const dependency of row.expected.dependencies) {
      const source = rowData.find((candidate) => candidate.expected.kind === 'APP' && candidate.expected.elementId === dependency);
      assert.ok(source, `DCNO inheritance source ${dependency} must exist in the frozen batch`);
      const revision = (inheritanceRevisionByGra.get(source.gra.object_id) ?? 3) + 1;
      inheritanceRevisionByGra.set(source.gra.object_id, revision);
      addObjectRevision(db, { runId, featureId: 'omnia.create-associate', version: createVersion, planDigest, type: 'GRA', id: source.gra.object_id,
        revision, targetKey: `inheritance-source|${row.rowKey}|${source.rowKey}`,
        payload: { verified: true, itElementRaitConclusionLevelId: row.expected.rait },
        intended: { kind: 'field', key: `inheritance-source|${row.rowKey}|${source.rowKey}`, workspace: WORKSPACE, objectType: 'GRA',
          graTargetKey: `gra|${source.rowKey}`, sourceRowKey: source.rowKey, value: row.expected.rait } });
    }
    for (const row of rowData) for (const dependency of row.expected.dependencies) {
      const relationType = row.expected.kind === 'TOOL' ? 'ItToolApplication' : 'InfrastructureApplication';
      const relation = addRelationRevision(db, { runId, featureId: 'omnia.create-associate', version: createVersion, planDigest, type: relationType, key: `element-relation|${row.rowKey}|${dependency}`, source: row.object.object_id, target: appIds.get(dependency)!, revision: 1, payload: { associated: true, inconsistent: false } });
      allRelations.push(relation);
    }
    allRows.push(...rowData);
  }
  const deleteRun = 'delete-run'; const deletePlanDigest = addRun(db, deleteRun, 'omnia.delete-elements', deleteVersion);
  const deleteSteps: any[] = []; const deleteOutcomes: any[] = []; const tombstoneAt = '2026-08-10T01:30:00.000Z';
  const insertObjectProjection = (type: string, id: string, revision: number, trust: any, provenance: any, payload: any) => {
    db.prepare('INSERT INTO managed_object_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`revision-${++serial}`,
      AUTHORITY.authority, AUTHORITY.tenant, AUTHORITY.pack, ENGAGEMENT, WORKSPACE, type, id, revision, deleteRun,
      trust.intentId, trust.commandId, trust.evidenceId, JSON.stringify(provenance), JSON.stringify(payload), tombstoneAt);
  };
  const insertRelationProjection = (relation: any, revision: number, trust: any, payload: any) => {
    db.prepare('INSERT INTO managed_relation_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`relation-revision-${++serial}`,
      AUTHORITY.authority, AUTHORITY.tenant, AUTHORITY.pack, ENGAGEMENT, WORKSPACE, 'risk_control', relation.relationKey,
      relation.riskId, relation.controlId, revision, deleteRun, trust.intentId, trust.commandId, trust.evidenceId,
      JSON.stringify(payload), tombstoneAt);
  };
  for (const row of allRows) {
    const graId = row.gra.object_id; const stepKey = `GRA|${WORKSPACE}|${graId}`;
    const riskControls = row.riskControlIdentities.map((identity: any) => ({ ...identity }))
      .sort((left: any, right: any) => `${left.riskId}\0${left.riskRiskScopeId}\0${left.controlId}\0${left.assertionType}\0${left.assertion}`
        .localeCompare(`${right.riskId}\0${right.riskRiskScopeId}\0${right.controlId}\0${right.assertionType}\0${right.assertion}`));
    const risks: any[] = [...new Map<string, any>(riskControls.map((identity: any) => [`${identity.riskId}\0${identity.riskRiskScopeId}`,
      { riskId: identity.riskId, riskRiskScopeId: identity.riskRiskScopeId, riskScopeId: identity.riskScopeId, updatedOn: '2026-08-10T00:30:00.000Z' }])).values()]
      .sort((left: any, right: any) => `${left.riskId}\0${left.riskRiskScopeId}`.localeCompare(`${right.riskId}\0${right.riskRiskScopeId}`));
    const controls: any[] = [...new Map<string, any>(riskControls.map((identity: any) => [identity.controlId,
      { controlId: identity.controlId, workItemId: `work-item-${identity.controlId}`, updatedOn: '2026-08-10T00:30:00.000Z' }])).values()]
      .sort((left: any, right: any) => `${left.controlId}\0${left.workItemId}`.localeCompare(`${right.controlId}\0${right.workItemId}`));
    const snapshotIdentity = { schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1',
      assessment: { riskAssessmentId: graId, workItemId: `work-item-${graId}`, workspaceId: WORKSPACE, updatedOn: '2026-08-10T00:30:00.000Z' },
      risks, controls, riskControls };
    const frozenSnapshot = { ...snapshotIdentity, snapshotDigest: digest(snapshotIdentity) };
    const observedSnapshot = { ...snapshotIdentity,
      risks: risks.map((identity: any) => ({ ...identity, absent: true })),
      controls: controls.map((identity: any) => ({ ...identity, absent: true })),
      riskControls: riskControls.map((identity: any) => ({ ...identity, absent: true })), snapshotDigest: frozenSnapshot.snapshotDigest };
    const response = { objectId: graId, riskAssessmentId: graId, objectType: 'GRA', workspaceIds: [WORKSPACE],
      deleted: true, verifiedCascade: true, cascadeSnapshot: observedSnapshot };
    const mutationPayload = { riskAssessmentId: graId };
    const readRequest = { connectorBinding: CONNECTOR_BINDING, target: { targetIdentityKey: stepKey, workspaceId: WORKSPACE },
      riskAssessmentId: graId, workspaceId: WORKSPACE, frozenCascadeSnapshot: frozenSnapshot };
    const trust = addTrust(db, { runId: deleteRun, featureId: 'omnia.delete-elements', version: deleteVersion,
      planDigest: deletePlanDigest, targetKey: stepKey, targetIdentity: stepKey, targetKind: 'object',
      operation: 'omnia.delete.gra.direct.v1', evidenceOperation: 'omnia.delete.gra.reconcile.v1', request: mutationPayload,
      evidenceRequest: readRequest, response, saveSpec: false,
      intended: { kind: 'object', key: stepKey, workspace: WORKSPACE, objectType: 'GRA', objectId: graId,
        mutationOperationId: 'omnia.delete.gra.direct.v1', mutationPayload, evidenceOperationIds: ['omnia.delete.gra.reconcile.v1'],
        operationTargetIdentityKey: stepKey, baseline: { cascadeSnapshot: frozenSnapshot } } });
    const metadata = { deleted: true, parentCommandId: trust.commandId, evidenceId: trust.evidenceId,
      snapshotDigest: frozenSnapshot.snapshotDigest };
    const graCurrent = db.prepare("SELECT current_revision FROM managed_objects WHERE workspace_id=? AND object_type='GRA' AND object_id=?")
      .get(WORKSPACE, graId) as any;
    const graRevision = Number(graCurrent.current_revision) + 1;
    insertObjectProjection('GRA', graId, graRevision, trust, { source: 'agent_verified_gra_cascade_delete', ...metadata }, { ...metadata, tombstoneAt });
    upsertCurrentObject(db, 'GRA', graId, graRevision, 'deleted');
    for (const risk of risks) {
      insertObjectProjection('Risk', risk.riskId, 1, trust, { source: 'adopted_on_verified_gra_cascade', ...metadata }, risk);
      insertObjectProjection('Risk', risk.riskId, 2, trust, { source: 'agent_verified_gra_cascade_delete', ...metadata }, { ...metadata, tombstoneAt });
      upsertCurrentObject(db, 'Risk', risk.riskId, 2, 'deleted');
    }
    for (const control of controls) {
      insertObjectProjection('Control', control.controlId, 1, trust, { source: 'adopted_on_verified_gra_cascade', ...metadata }, control);
      insertObjectProjection('Control', control.controlId, 2, trust, { source: 'agent_verified_gra_cascade_delete', ...metadata }, { ...metadata, tombstoneAt });
      upsertCurrentObject(db, 'Control', control.controlId, 2, 'deleted');
    }
    for (const identity of riskControls) {
      const createRelation = row.riskRelations.find((candidate: any) => candidate.source_object_id === identity.riskId
        && candidate.target_object_id === identity.controlId);
      assert.ok(createRelation, `Create relation is required for ${identity.riskId}/${identity.controlId}`);
      const relation = { ...identity, graId, relationKey: createRelation.relation_key };
      const { relationKey: _relationKey, ...riskControlIdentity } = relation;
      insertRelationProjection(relation, 2, trust, { ...metadata, ...riskControlIdentity, tombstoneAt });
      upsertCurrentRelation(db, 'risk_control', relation.relationKey, relation.riskId, relation.controlId, 2, 'deleted');
    }
    deleteSteps.push({ kind: 'cascade', key: stepKey, workspace: WORKSPACE, objectType: 'GRA', objectId: graId,
      preflight: { cascadeSnapshot: frozenSnapshot }, request: { riskAssessmentId: graId, workspaceId: WORKSPACE, frozenCascadeSnapshot: frozenSnapshot } });
    deleteOutcomes.push({ stepId: stepKey, state: 'succeeded', commandId: trust.commandId });
  }
  for (const object of allObjects.filter((candidate) => candidate.object_type !== 'GRA')) {
    const key = `${object.object_type}|${WORKSPACE}|${object.object_id}`; const request = { objectId: object.object_id, objectType: object.object_type };
    const revision = addObjectRevision(db, { runId: deleteRun, featureId: 'omnia.delete-elements', version: deleteVersion,
      planDigest: deletePlanDigest, type: object.object_type, id: object.object_id, revision: 2, targetKey: key,
      payload: { deleted: true, objectId: object.object_id }, lifecycle: 'deleted', operation: 'omnia.delete.object.execute.v1',
      request, intended: { kind: 'object', key, workspace: WORKSPACE, objectType: object.object_type, objectId: object.object_id,
        mutationPayload: request, baseline: { objectId: object.object_id } } });
    deleteSteps.push({ kind: 'object', key, workspace: WORKSPACE, objectType: object.object_type, objectId: object.object_id });
    deleteOutcomes.push({ stepId: key, state: 'succeeded', commandId: revision.commandId });
  }
  for (const relation of allRelations) {
    const request = { relationType: relation.relation_type, sourceObjectId: relation.source_object_id, targetObjectId: relation.target_object_id };
    const revision = addRelationRevision(db, { runId: deleteRun, featureId: 'omnia.delete-elements', version: deleteVersion,
      planDigest: deletePlanDigest, type: relation.relation_type, key: relation.relation_key, source: relation.source_object_id,
      target: relation.target_object_id, revision: 2, payload: { deleted: true }, lifecycle: 'deleted',
      operation: 'omnia.delete.relation.execute.v1', request,
      intended: { kind: 'relation', key: relation.relation_key, workspace: WORKSPACE, relationType: relation.relation_type,
        relationKey: relation.relation_key, sourceObjectId: relation.source_object_id, targetObjectId: relation.target_object_id,
        mutationPayload: request, baseline: { relationKey: relation.relation_key } } });
    deleteSteps.push({ kind: 'relation', key: relation.relation_key, workspace: WORKSPACE,
      objectType: relation.relation_type, objectId: relation.relation_key });
    deleteOutcomes.push({ stepId: relation.relation_key, state: 'succeeded', commandId: revision.commandId });
  }
  db.exec('COMMIT'); db.close();
  const deletion = path.join(root, 'delete.sqlite'); const privateDb = new DatabaseSync(deletion);
  privateDb.exec('CREATE TABLE __runtime_plans(plan_id TEXT PRIMARY KEY,payload_json TEXT,updated_at TEXT)');
  const verifiedAbsentTargetIds = allObjects.map((object) => `${object.object_type}|${object.object_id}`).sort();
  const steps = deleteSteps;
  privateDb.prepare('INSERT INTO __runtime_plans VALUES(?,?,?)').run(deleteRun, JSON.stringify({
    schemaVersion: 'omnia.delete-plan/v5', planId: deleteRun, runId: deleteRun, featureId: 'omnia.delete-elements', featureVersion: deleteVersion,
    planDigest: deletePlanDigest, state: 'completed', binding: { connectorId: AUTHORITY.connector, sessionGeneration: AUTHORITY.session,
      engagementId: ENGAGEMENT, authorityInstanceId: AUTHORITY.authority, tenantOrOrgId: AUTHORITY.tenant, packId: AUTHORITY.pack },
    safety: { enabled: true, validForCurrentConnection: true, connectorId: AUTHORITY.connector, sessionGeneration: AUTHORITY.session,
      engagementId: ENGAGEMENT, authorityInstanceId: AUTHORITY.authority, tenantOrOrgId: AUTHORITY.tenant, packId: AUTHORITY.pack,
      workspaceIds: [WORKSPACE], allowedWorkspaceIds: [WORKSPACE], stateVersion: 2, authorityObservationId: 'authority-observation-1' },
    targets: allObjects.map((object) => ({ workspace: WORKSPACE, objectType: object.object_type, objectId: object.object_id })),
    steps, outcomes: deleteOutcomes,
    finalVerification: { schemaVersion: 'omnia.delete-final-catalog-verification/v1', state: 'verified', capturedAt: '2026-08-10T02:00:00.000Z', expectedDeletedTargetIds: verifiedAbsentTargetIds, verifiedAbsentTargetIds, catalogItemCount: 0, catalogDigest: digest([]) }
  }), '2026-08-10T02:00:00.000Z');
  privateDb.close();
  return { core, deletion, manifest };
}

test('frozen input is exactly eight SHA-bound batches and 30 Higher/Lower combinations', async () => {
  const verifier = await import(verifierUrl); const manifest = verifier.loadAcceptanceManifest(evidenceDirectory);
  assert.equal(manifest.batches.length, 8); assert.equal(manifest.rows.length, 30);
  assert.deepEqual(manifest.counts, { APP: 8, DB: 6, OS: 8, TOOL: 6, DCNO: 2 });
  assert.equal(manifest.rows.every((row: any) => ['Higher', 'Lower'].includes(row.rait)), true);
});

test('isolated SQLite evidence passes only with exact Create receipts and final empty-catalog Delete proof', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-live-acceptance-')); const fixture = await buildPassingFixture(root); const verifier = await import(verifierUrl);
  const options = { coreDb: fixture.core, deleteDb: fixture.deletion, evidenceDirectory, createVersion: '9.8.7', deleteVersion: '8.7.6', workspaceId: WORKSPACE, engagementId: ENGAGEMENT, phase: 'all' };
  const result = verifier.verifyLiveAcceptance(options);
  assert.equal(result.status, 'passed'); assert.equal(result.input.rows, 30); assert.equal(result.create.batches.length, 8); assert.equal(result.deletion.finalCatalog.catalogItemCount, 0);
  const deleteDb = new DatabaseSync(fixture.deletion); const row = deleteDb.prepare('SELECT payload_json FROM __runtime_plans WHERE plan_id=?').get('delete-run') as any;
  const plan = JSON.parse(row.payload_json); plan.finalVerification.catalogItemCount = 1;
  deleteDb.prepare('UPDATE __runtime_plans SET payload_json=? WHERE plan_id=?').run(JSON.stringify(plan), 'delete-run'); deleteDb.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /final catalog proof differs/u.test(error.message));
  const restoredDeleteDb = new DatabaseSync(fixture.deletion); plan.finalVerification.catalogItemCount = 0;
  restoredDeleteDb.prepare('UPDATE __runtime_plans SET payload_json=? WHERE plan_id=?').run(JSON.stringify(plan), 'delete-run'); restoredDeleteDb.close();
  const coreDb = new DatabaseSync(fixture.core); coreDb.prepare('DELETE FROM feature_operation_receipts WHERE receipt_id=(SELECT receipt_id FROM feature_operation_receipts ORDER BY receipt_id LIMIT 1)').run(); coreDb.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /expected exactly one live proof, found 0/u.test(error.message));
});

test('final catalog zero cannot substitute for every receipt-bound cascade child tombstone', async (t) => {
  const verifier = await import(verifierUrl);
  const optionsFor = (fixture: any) => ({ coreDb: fixture.core, deleteDb: fixture.deletion, evidenceDirectory,
    createVersion: '9.8.7', deleteVersion: '8.7.6', workspaceId: WORKSPACE, engagementId: ENGAGEMENT, phase: 'all' });
  await t.test('missing Risk object tombstone fails closed', async () => {
    const fixture = await buildPassingFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-cascade-missing-risk-')));
    const db = new DatabaseSync(fixture.core); const row = db.prepare("SELECT revision_id FROM managed_object_revisions WHERE run_id='delete-run' AND object_type='Risk' AND json_extract(payload_json,'$.deleted')=1 LIMIT 1").get() as any;
    db.prepare('DELETE FROM managed_object_revisions WHERE revision_id=?').run(row.revision_id); db.close();
    assert.throws(() => verifier.verifyLiveAcceptance(optionsFor(fixture)), (error: any) => error.name === 'PendingAcceptanceError' && /extra or missing child object tombstone/u.test(error.message));
  });
  await t.test('missing Risk-Control tombstone fails closed', async () => {
    const fixture = await buildPassingFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-cascade-missing-relation-')));
    const db = new DatabaseSync(fixture.core); const row = db.prepare("SELECT revision_id FROM managed_relation_revisions WHERE run_id='delete-run' AND relation_type='risk_control' AND json_extract(payload_json,'$.deleted')=1 LIMIT 1").get() as any;
    db.prepare('DELETE FROM managed_relation_revisions WHERE revision_id=?').run(row.revision_id); db.close();
    assert.throws(() => verifier.verifyLiveAcceptance(optionsFor(fixture)), (error: any) => error.name === 'PendingAcceptanceError' && /extra or missing Risk-Control tombstone/u.test(error.message));
  });
  await t.test('child metadata must name the parent command and evidence', async () => {
    const fixture = await buildPassingFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-cascade-metadata-')));
    const db = new DatabaseSync(fixture.core); const row = db.prepare("SELECT revision_id,payload_json FROM managed_object_revisions WHERE run_id='delete-run' AND object_type='Control' AND json_extract(payload_json,'$.deleted')=1 LIMIT 1").get() as any;
    const payload = JSON.parse(row.payload_json); payload.parentCommandId = 'untraced-parent-command';
    db.prepare('UPDATE managed_object_revisions SET payload_json=? WHERE revision_id=?').run(JSON.stringify(payload), row.revision_id); db.close();
    assert.throws(() => verifier.verifyLiveAcceptance(optionsFor(fixture)), (error: any) => error.name === 'PendingAcceptanceError' && /not bound to the parent cascade/u.test(error.message));
  });
  await t.test('parent cascade receipt cannot be missing', async () => {
    const fixture = await buildPassingFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-cascade-receipt-')));
    const db = new DatabaseSync(fixture.core); const row = db.prepare(`SELECT e.receipt_id FROM managed_object_revisions v
      JOIN feature_command_evidence e ON e.evidence_id=v.evidence_id
      WHERE v.run_id='delete-run' AND v.object_type='GRA' AND json_extract(v.payload_json,'$.deleted')=1 LIMIT 1`).get() as any;
    db.prepare('DELETE FROM feature_operation_receipts WHERE receipt_id=?').run(row.receipt_id); db.close();
    assert.throws(() => verifier.verifyLiveAcceptance(optionsFor(fixture)), (error: any) => error.name === 'PendingAcceptanceError' && /expected exactly one live proof, found 0/u.test(error.message));
  });
  await t.test('an extra child tombstone bound to the parent still fails', async () => {
    const fixture = await buildPassingFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-cascade-extra-child-')));
    const db = new DatabaseSync(fixture.core); const parent = db.prepare("SELECT * FROM managed_object_revisions WHERE run_id='delete-run' AND object_type='GRA' AND json_extract(payload_json,'$.deleted')=1 ORDER BY revision_id LIMIT 1").get() as any;
    db.prepare('INSERT INTO managed_object_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('extra-cascade-risk-revision',
      parent.authority_instance_id, parent.tenant_or_org_id, parent.pack_id, parent.engagement_id, parent.workspace_id,
      'Risk', 'extra-cascade-risk', 1, parent.run_id, parent.intent_id, parent.command_id, parent.evidence_id,
      parent.provenance_json, parent.payload_json, parent.verified_at);
    upsertCurrentObject(db, 'Risk', 'extra-cascade-risk', 1, 'deleted'); db.close();
    assert.throws(() => verifier.verifyLiveAcceptance(optionsFor(fixture)), (error: any) => error.name === 'PendingAcceptanceError' && /extra or missing child object tombstone/u.test(error.message));
  });
  await t.test('a child current pointer cannot lag its verified tombstone', async () => {
    const fixture = await buildPassingFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-cascade-current-')));
    const db = new DatabaseSync(fixture.core); const row = db.prepare("SELECT object_id FROM managed_object_revisions WHERE run_id='delete-run' AND object_type='Risk' AND json_extract(payload_json,'$.deleted')=1 LIMIT 1").get() as any;
    db.prepare("UPDATE managed_objects SET current_revision=1 WHERE workspace_id=? AND object_type='Risk' AND object_id=?").run(WORKSPACE, row.object_id); db.close();
    assert.throws(() => verifier.verifyLiveAcceptance(optionsFor(fixture)), (error: any) => error.name === 'PendingAcceptanceError' && /exact deleted, verified-current/u.test(error.message));
  });
});

test('Create child identity must be receipt-backed and cannot cross GRA ownership', async (t) => {
  const verifier = await import(verifierUrl);
  await t.test('projection-only identity drift is rejected', async () => {
    const fixture = await buildPassingFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-untraced-child-')));
    const options = { coreDb: fixture.core, deleteDb: fixture.deletion, evidenceDirectory, createVersion: '9.8.7', deleteVersion: '8.7.6', workspaceId: WORKSPACE, engagementId: ENGAGEMENT, phase: 'all' };
    const db = new DatabaseSync(fixture.core); const row = db.prepare("SELECT revision_id,payload_json FROM managed_relation_revisions WHERE run_id LIKE 'create-run-%' AND relation_type='risk_control' LIMIT 1").get() as any;
    const payload = JSON.parse(row.payload_json); payload.graId = 'payload-only-untraced-gra';
    db.prepare('UPDATE managed_relation_revisions SET payload_json=? WHERE revision_id=?').run(JSON.stringify(payload), row.revision_id); db.close();
    assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /exact receipt-backed Create readback/u.test(error.message));
  });
  await t.test('one Risk identity cannot be owned by multiple GRAs', async () => {
    const fixture = await buildPassingFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-cross-gra-')), { crossGraRisk: true });
    const options = { coreDb: fixture.core, deleteDb: fixture.deletion, evidenceDirectory, createVersion: '9.8.7', deleteVersion: '8.7.6', workspaceId: WORKSPACE, engagementId: ENGAGEMENT, phase: 'all' };
    assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /multiple Create GRAs/u.test(error.message));
  });
});

test('current Core DB reports pending instead of promoting offline validation to live acceptance', async () => {
  const verifier = await import(verifierUrl); const options = { coreDb: path.join(repository, 'releases', 'data', 'stores', 'core.sqlite'), deleteDb: path.join(repository, 'releases', 'data', 'features', 'omnia.delete-elements', 'store.sqlite'), evidenceDirectory, createVersion: '0.2.103', deleteVersion: '0.3.20', workspaceId: WORKSPACE, engagementId: '', phase: 'all' };
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /expected exactly one live proof, found 0/u.test(error.message));
});

test('GRA content identity and dependency relation type must be exact live evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-live-identity-')); const fixture = await buildPassingFixture(root); const verifier = await import(verifierUrl);
  const options = { coreDb: fixture.core, deleteDb: fixture.deletion, evidenceDirectory, createVersion: '9.8.7', deleteVersion: '8.7.6', workspaceId: WORKSPACE, engagementId: ENGAGEMENT, phase: 'all' };
  assert.equal(verifier.verifyLiveAcceptance(options).status, 'passed');
  const db = new DatabaseSync(fixture.core);
  const graIntent = db.prepare("SELECT i.intent_id,i.intended_revision_json FROM managed_content_intents i JOIN feature_runs r ON r.run_id=i.run_id WHERE r.feature_id='omnia.create-associate' AND i.target_key GLOB 'gra|*' ORDER BY i.target_key LIMIT 1").get() as any;
  const intended = JSON.parse(graIntent.intended_revision_json); const originalIntended = graIntent.intended_revision_json;
  intended.contentName = `${intended.contentName}-drift`;
  db.prepare('UPDATE managed_content_intents SET intended_revision_json=? WHERE intent_id=?').run(JSON.stringify(intended), graIntent.intent_id);
  db.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /exact frozen/u.test(error.message));
  const restore = new DatabaseSync(fixture.core); restore.prepare('UPDATE managed_content_intents SET intended_revision_json=? WHERE intent_id=?').run(originalIntended, graIntent.intent_id);
  const wrongIdentity = JSON.parse(originalIntended); wrongIdentity.contentIdentity.inkContentId = `${wrongIdentity.contentIdentity.inkContentId}-drift`;
  restore.prepare('UPDATE managed_content_intents SET intended_revision_json=? WHERE intent_id=?').run(JSON.stringify(wrongIdentity), graIntent.intent_id); restore.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /exact frozen/u.test(error.message));
  const specDb = new DatabaseSync(fixture.core); specDb.prepare('UPDATE managed_content_intents SET intended_revision_json=? WHERE intent_id=?').run(originalIntended, graIntent.intent_id);
  const graSpec = specDb.prepare('SELECT s.command_id,s.spec_json FROM feature_command_specs s JOIN feature_commands c ON c.command_id=s.command_id WHERE c.intent_id=?').get(graIntent.intent_id) as any;
  const changedSpec = JSON.parse(graSpec.spec_json); changedSpec.request.inkContentId = `${changedSpec.request.inkContentId}-drift`;
  specDb.prepare('UPDATE feature_command_specs SET spec_json=? WHERE command_id=?').run(JSON.stringify(changedSpec), graSpec.command_id); specDb.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /does not reproduce/u.test(error.message));
  const relationDb = new DatabaseSync(fixture.core); relationDb.prepare('UPDATE feature_command_specs SET spec_json=? WHERE command_id=?').run(graSpec.spec_json, graSpec.command_id);
  const dependency = relationDb.prepare("SELECT revision_id,relation_type FROM managed_relation_revisions WHERE relation_key LIKE 'element-relation|%' ORDER BY relation_key LIMIT 1").get() as any;
  relationDb.prepare('UPDATE managed_relation_revisions SET relation_type=? WHERE revision_id=?').run('WrongRelation', dependency.revision_id); relationDb.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /expected exactly one live proof, found 0/u.test(error.message));
});

test('DCNO inheritance and the dependency relation inventory are exact, not subset checks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-live-dcno-')); const fixture = await buildPassingFixture(root); const verifier = await import(verifierUrl);
  const options = { coreDb: fixture.core, deleteDb: fixture.deletion, evidenceDirectory, createVersion: '9.8.7', deleteVersion: '8.7.6', workspaceId: WORKSPACE, engagementId: ENGAGEMENT, phase: 'all' };
  assert.equal(verifier.verifyLiveAcceptance(options).status, 'passed');
  const db = new DatabaseSync(fixture.core);
  const inheritance = db.prepare("SELECT intent_id,intended_revision_json FROM managed_content_intents WHERE target_key LIKE 'inheritance-source|%' ORDER BY target_key LIMIT 1").get() as any;
  const originalInheritance = inheritance.intended_revision_json; const changedInheritance = JSON.parse(originalInheritance);
  changedInheritance.value = changedInheritance.value === 'Higher' ? 'Lower' : 'Higher';
  db.prepare('UPDATE managed_content_intents SET intended_revision_json=? WHERE intent_id=?').run(JSON.stringify(changedInheritance), inheritance.intent_id);
  db.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /inheritance source/u.test(error.message));
  const restore = new DatabaseSync(fixture.core); restore.prepare('UPDATE managed_content_intents SET intended_revision_json=? WHERE intent_id=?').run(originalInheritance, inheritance.intent_id);
  const relation = restore.prepare("SELECT * FROM managed_relation_revisions WHERE relation_key LIKE 'element-relation|%' ORDER BY relation_key LIMIT 1").get() as any;
  const run = restore.prepare('SELECT plan_digest FROM feature_runs WHERE run_id=?').get(relation.run_id) as any;
  addRelationRevision(restore, { runId: relation.run_id, featureId: 'omnia.create-associate', version: '9.8.7', planDigest: run.plan_digest,
    type: relation.relation_type, key: `${relation.relation_key}|EXTRA`, source: relation.source_object_id, target: relation.target_object_id,
    revision: 1, payload: { associated: true, inconsistent: false } });
  restore.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /dependency relation set/u.test(error.message));
});

test('Delete private final verification must be derived from its exact succeeded step inventory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-live-delete-plan-')); const fixture = await buildPassingFixture(root); const verifier = await import(verifierUrl);
  const options = { coreDb: fixture.core, deleteDb: fixture.deletion, evidenceDirectory, createVersion: '9.8.7', deleteVersion: '8.7.6', workspaceId: WORKSPACE, engagementId: ENGAGEMENT, phase: 'all' };
  const db = new DatabaseSync(fixture.deletion); const row = db.prepare('SELECT payload_json FROM __runtime_plans WHERE plan_id=?').get('delete-run') as any;
  const plan = JSON.parse(row.payload_json); plan.outcomes.pop();
  db.prepare('UPDATE __runtime_plans SET payload_json=? WHERE plan_id=?').run(JSON.stringify(plan), 'delete-run'); db.close();
  assert.throws(() => verifier.verifyLiveAcceptance(options), (error: any) => error.name === 'PendingAcceptanceError' && /exact completed/u.test(error.message));
});

test('a changed workbook is rejected before any Core evidence is considered', async () => {
  const verifier = await import(verifierUrl); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-live-hash-'));
  for (const name of fs.readdirSync(evidenceDirectory).filter((entry) => /^Phase1-TEST-supported-/u.test(entry))) fs.copyFileSync(path.join(evidenceDirectory, name), path.join(root, name));
  const workbook = fs.readdirSync(root).find((name) => name.endsWith('.xlsx'))!; fs.appendFileSync(path.join(root, workbook), Buffer.from([0]));
  assert.throws(() => verifier.loadAcceptanceManifest(root), /differs from its frozen SHA256/u);
});
