import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.js';
import { FeatureRuntimeStore } from '../src/main/features/feature-runtime-store.js';
import { canonicalJson } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };

test('Create reuse and read-only closure paths freeze a durable command specification before readback', () => {
  const worker = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'feature-packages', 'create-associate', 'source', 'middle', 'worker.cjs'), 'utf8');
  const verifiedExisting = worker.slice(worker.indexOf('async function verifiedExisting'), worker.indexOf('async function closeVerified'));
  const closeVerified = worker.slice(worker.indexOf('async function closeVerified'), worker.indexOf('async function projectObject'));
  for (const [label, source] of [['verifiedExisting', verifiedExisting], ['closeVerified', closeVerified]] as const) {
    assert.match(source, /saveReturnReconcileSpec/u, `${label} must persist an immutable command spec`);
    assert.match(source, /mutationPayload:/u, `${label} spec must reproduce the prepared command request digest`);
    assert.match(source, /noMutation:\s*true/u, `${label} must declare that the closure performs no mutation`);
  }
});

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function addReceiptBackedReadback(database: CoreDatabase, input: {
  commandId: string; runId: string; featureVersion: string; evidenceId: string; receiptId: string;
  binding: Record<string, any>; workspaceId: string; authorityDigest: string; payload: Record<string, unknown>; occurredAt: string;
}): void {
  const command = database.db.prepare(`
    SELECT c.plan_digest,c.evidence_operation_ids_json,c.evidence_target_identity_key,c.evidence_request_digest,i.target_key
    FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id
    WHERE c.command_id=? AND c.run_id=?
  `).get(input.commandId, input.runId) as Record<string, any>;
  const operationIds = JSON.parse(String(command.evidence_operation_ids_json)) as string[];
  assert.ok(operationIds.length > 0);
  const requestDigest = String(command.evidence_request_digest || '') || sha256(canonicalJson({ readback: input.commandId }));
  database.db.prepare(`UPDATE feature_commands SET evidence_request_digest=? WHERE command_id=?`).run(requestDigest, input.commandId);
  const responseJson = canonicalJson(input.payload); const responseDigest = sha256(responseJson);
  database.db.prepare(`
    INSERT INTO feature_operation_receipts(
      receipt_id,run_id,command_id,feature_id,feature_version,operation_package_digest,operation_id,
      authority_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,
      frozen_target_key,target_identity_key,workspace_ids_json,plan_digest,request_digest,response_digest,response_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(input.receiptId, input.runId, input.commandId, 'omnia.create-associate', input.featureVersion,
    `sha256:${'2'.repeat(64)}`, operationIds[0]!, input.authorityDigest,
    input.binding.connectorId, input.binding.sessionGeneration, input.binding.engagementId, input.binding.authorityInstanceId,
    input.binding.tenantOrOrgId, input.binding.packId, command.target_key, command.evidence_target_identity_key,
    canonicalJson([input.workspaceId]), command.plan_digest, requestDigest, responseDigest, responseJson, input.occurredAt);
  database.db.prepare(`
    INSERT INTO feature_command_evidence(evidence_id,command_id,run_id,evidence_type,evidence_digest,receipt_id,verified,payload_json,occurred_at)
    VALUES(?,?,?,'readback',?,?,1,?,?)
  `).run(input.evidenceId, input.commandId, input.runId, responseDigest, input.receiptId,
    JSON.stringify({ ...input.payload, __operationReceiptId: input.receiptId }), input.occurredAt);
}

test('Create GRA command and projection require the frozen semantic content identity', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-gra-identity-'));
  const paths = resolveProductPaths(temporary); const database = new CoreDatabase(paths.database, cipher);
  const store = new FeatureRuntimeStore(database.db, paths);
  const context = { featureId: 'omnia.create-associate', featureVersion: '0.2.101', allowMutation: true };
  const runId = '11111111-1111-4111-8111-111111111111'; const workspaceId = '22222222-2222-4222-8222-222222222222';
  const engagementId = '33333333-3333-4333-8333-333333333333'; const objectId = '44444444-4444-4444-8444-444444444444';
  const graId = '55555555-5555-4555-8555-555555555555'; const planDigest = 'a'.repeat(64); const now = new Date().toISOString();
  const binding = { connectorId: 'connector-1', sessionGeneration: 7, engagementId, authorityInstanceId: 'authority-1', tenantOrOrgId: 'tenant-1', packId: 'pack-1' };
  const authorityDigest = sha256(canonicalJson({ ...binding, workspaceIds: [workspaceId] }));
  const objectTargetKey = 'object|row-1'; const graTargetKey = 'gra|row-1';
  const graTargetIdentity = 'target-gra-row-1'; const graEvidenceOperation = 'omnia.create-associate.gra.reconcile.v1';
  const contentIdentity = { inkContentId: '66176468', typeId: '3' };
  try {
    database.db.prepare(`UPDATE workspace_safety SET enabled=1,engagement_id=?,workspace_ids_json=?,state_version=2 WHERE singleton=1`).run(engagementId, JSON.stringify([workspaceId]));
    database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.2.101',?,'returning',3,'','','',?,'',?,?)`)
      .run(runId, '66666666-6666-4666-8666-666666666666', engagementId, planDigest, now, now);
    database.db.prepare(`INSERT INTO feature_confirmations(confirmation_id,run_id,message_id,plan_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,safety_revision,credential_digest,preflight_digest,confirmation_token_digest,decision,actor_id,decision_at,consumed_command_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved','local-user',?,'',?,?)`)
      .run('77777777-7777-4777-8777-777777777777', runId, `return:${runId}`, planDigest, binding.connectorId, binding.sessionGeneration, engagementId, binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, 2, authorityDigest, 'b'.repeat(64), 'c'.repeat(64), now, '2099-01-01T00:00:00.000Z', now);

    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'verified',?,?)`)
      .run('88888888-8888-4888-8888-888888888888', runId, planDigest, 'object', objectTargetKey, JSON.stringify({ kind: 'object', key: objectTargetKey, workspace: workspaceId, objectType: 'Application' }), now, now);
    database.db.prepare(`INSERT INTO feature_commands(command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,commit_point_at,submitted_at,completed_at,last_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'readback_verified','','','', '',?)`)
      .run('99999999-9999-4999-8999-999999999999', runId, '88888888-8888-4888-8888-888888888888', 'omnia.create-associate.object.create.v1', 'd'.repeat(64), planDigest, 'e'.repeat(64), '[]', 'target-object-row-1', '', now);
    database.db.prepare(`INSERT INTO managed_object_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,revision,run_id,intent_id,command_id,evidence_id,provenance_json,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`)
      .run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, engagementId, workspaceId, 'Application', objectId, runId, '88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999', 'object-evidence', '{}', JSON.stringify({ id: objectId }), now);

    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'frozen',?,?)`)
      .run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', runId, planDigest, 'object', graTargetKey, JSON.stringify({
        kind: 'object', key: graTargetKey, workspace: workspaceId, objectType: 'GRA', externalId: 'GRA-APP-1', disposition: 'create',
        entityObjectTargetKey: objectTargetKey, contentName: 'Oracle EBS', contentIdentity,
        mutationOperationId: 'omnia.create-associate.gra.create.v1', operationTargetIdentityKey: graTargetIdentity,
        evidenceOperationIds: [graEvidenceOperation]
      }), now, now);
    const invalidRunId = '12121212-1212-4212-8212-121212121212';
    database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.2.101',?,'ready_for_review',1,'','','','','',?,?)`)
      .run(invalidRunId, '13131313-1313-4313-8313-131313131313', engagementId, now, now);
    const safetyLock = { enabled: true, engagementId, workspaceIds: [workspaceId], globalEnabled: false,
      globalSectionIds: [], globalWorkspaceIds: [], stateVersion: 2 };
    assert.throws(() => store.call('prepareReturnIntent', {
      runId: invalidRunId, connectorBinding: binding, safetyLock, credentialDigest: authorityDigest, preflightDigest: 'b'.repeat(64),
      plan: { authority: binding, targets: [{ kind: 'object', key: 'gra|invalid-row', workspace: workspaceId, objectType: 'GRA',
        disposition: 'resume', contentName: 'Oracle EBS', contentIdentity, mutationOperationId: 'omnia.create-associate.gra.create.v1',
        operationTargetIdentityKey: 'target-invalid-gra', evidenceOperationIds: [graEvidenceOperation] }] }
    }, context), /disposition must be exactly create or reuse/u);
    const request = { ...contentIdentity, facetId: workspaceId, entityId: objectId, name: 'GRA-APP-1', engagementId };
    const baseCommand = { runId, planDigest, targetKind: 'object', targetKey: graTargetKey, operationId: 'omnia.create-associate.gra.create.v1', evidenceOperationIds: [graEvidenceOperation], evidenceTargetIdentityKey: graTargetIdentity, binding, workspaceIds: [workspaceId] };
    assert.throws(() => store.call('prepareReturnCommand', { ...baseCommand, request: { ...request, inkContentId: 'drift' } }, context), /commandIntentValid=false/u);
    const graIntentRow = database.db.prepare(`SELECT intended_revision_json FROM managed_content_intents WHERE target_key=?`).get(graTargetKey) as { intended_revision_json: string };
    const invalidGraIntent = JSON.parse(graIntentRow.intended_revision_json); invalidGraIntent.disposition = 'resume';
    database.db.prepare(`UPDATE managed_content_intents SET intended_revision_json=? WHERE target_key=?`).run(JSON.stringify(invalidGraIntent), graTargetKey);
    assert.throws(() => store.call('prepareReturnCommand', { ...baseCommand, request }, context), /commandIntentValid=false/u);
    database.db.prepare(`UPDATE managed_content_intents SET intended_revision_json=? WHERE target_key=?`).run(graIntentRow.intended_revision_json, graTargetKey);
    const command = store.call('prepareReturnCommand', { ...baseCommand, request }, context) as { commandId: string };
    assert.ok(command.commandId);

    database.db.prepare(`UPDATE feature_commands SET state='readback_verified' WHERE command_id=?`).run(command.commandId);
    database.db.prepare(`UPDATE managed_content_intents SET state='verified' WHERE intent_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`).run();
    const graPayload = { id: graId, inkContentId: contentIdentity.inkContentId };
    addReceiptBackedReadback(database, { commandId: command.commandId, runId, featureVersion: context.featureVersion,
      evidenceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', receiptId: 'receipt-gra', binding, workspaceId, authorityDigest, payload: graPayload, occurredAt: now });
    assert.throws(() => store.call('projectVerifiedReturn', { runId, commandId: command.commandId, binding, workspaceId, projectionKind: 'object', objectType: 'GRA', objectId: graId, payload: { id: graId } }, context), /trusted Operation receipt/u);
    store.call('projectVerifiedReturn', { runId, commandId: command.commandId, binding, workspaceId, projectionKind: 'object', objectType: 'GRA', objectId: graId, payload: graPayload }, context);
    const projected = database.db.prepare(`SELECT payload_json FROM managed_object_revisions WHERE run_id=? AND command_id=?`).get(runId, command.commandId) as { payload_json: string } | undefined;
    assert.equal(JSON.parse(String(projected?.payload_json)).inkContentId, contentIdentity.inkContentId);

    const fieldIntentId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',fieldCommandId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'verified',?,?)`)
      .run(fieldIntentId,runId,planDigest,'field','gra-rait|row-1',JSON.stringify({kind:'field',key:'gra-rait|row-1',workspace:workspaceId,objectType:'GRA',graTargetKey:graTargetKey,value:'Higher'}),now,now);
    database.db.prepare(`INSERT INTO feature_commands(command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,commit_point_at,submitted_at,completed_at,last_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'readback_verified','','','', '',?)`)
      .run(fieldCommandId,runId,fieldIntentId,'omnia.create-associate.gra-state.patch.v1','f'.repeat(64),planDigest,'1'.repeat(64),JSON.stringify(['omnia.create-associate.gra-state.read.v1']),'target-gra-rait','',now);
    const fieldPayload = { verified: true, value: 'Higher' };
    addReceiptBackedReadback(database, { commandId: fieldCommandId, runId, featureVersion: context.featureVersion,
      evidenceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', receiptId: 'receipt-gra-rait', binding, workspaceId, authorityDigest, payload: fieldPayload, occurredAt: now });
    store.call('projectVerifiedReturn',{runId,commandId:fieldCommandId,binding,workspaceId,projectionKind:'object',objectType:'GRA',objectId:graId,payload:fieldPayload},context);
  } finally {
    database.close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
});
