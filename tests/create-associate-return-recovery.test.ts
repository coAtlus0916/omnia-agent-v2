import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.js';
import { FeatureRuntimeStore } from '../src/main/features/feature-runtime-store.js';
import { canonicalJson } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const require = createRequire(import.meta.url);
const handlerPath = path.resolve(import.meta.dirname, '..', 'feature-packages', 'create-associate', 'source',
  'connector-capability', 'operation', 'handler.cjs');
const { createOperationHandler } = require(handlerPath) as {
  createOperationHandler(): { run(operationId: string, request: unknown, sdk: unknown): Promise<Record<string, unknown>> };
};
const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };
const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

test('Application read-back accepts Pack-normalized external identity without weakening exact description or Workspace proof', async () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const objectId = '22222222-2222-4222-8222-222222222222';
  const workItemId = '33333333-3333-4333-8333-333333333333';
  const description = JSON.stringify({
    editorData: '<p>Oracle EBS</p>', suggestionsData: [], trackChangesEnableFlagInEditor: false, plainText: 'Oracle EBS'
  });
  const result = await createOperationHandler().run('omnia.create-associate.object.reconcile.v1', {
    target: { targetIdentityKey: 'Application|Oracle EBS', workspaceId }, objectId,
    query: { externalId: 'Oracle EBS', objectType: 'Application', description }
  }, {
    binding: { engagementId: '44444444-4444-4444-8444-444444444444' },
    invokeStep: async (stepId: string) => {
      if (stepId === 'object-readback') return {
        id: objectId, number: 'ORACLE EBS', itElementType: 'Application', workItemId, description
      };
      if (stepId === 'object-readback-workspace') return [{ facetId: workspaceId }];
      throw new Error(`Unexpected step ${stepId}`);
    }
  });
  assert.equal(result.id, objectId);
  assert.equal(result.workspaceId, workspaceId);
  assert.equal(result.number, 'ORACLE EBS');
});

function ensureHandoffLedger(database: CoreDatabase): void {
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS feature_operation_handoffs(
      handoff_id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      source_feature_version TEXT NOT NULL,
      source_package_digest TEXT NOT NULL,
      source_operation_package_digest TEXT NOT NULL,
      source_activation_generation INTEGER NOT NULL,
      target_feature_version TEXT NOT NULL,
      target_package_digest TEXT NOT NULL,
      target_operation_package_digest TEXT NOT NULL,
      target_activation_generation INTEGER NOT NULL,
      registration_token TEXT NOT NULL,
      replaced_package_digests_json TEXT NOT NULL,
      phase TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL
    );
  `);
}

test('cross-Workspace relation commands bind both frozen authorities and verified relation heads advance without losing history', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-relation-recovery-'));
  const paths = resolveProductPaths(temporary); const database = new CoreDatabase(paths.database, cipher);
  ensureHandoffLedger(database);
  const store = new FeatureRuntimeStore(database.db, paths);
  const featureVersion = '0.2.142';
  const context = { featureId: 'omnia.create-associate', featureVersion, allowMutation: true };
  const runId = '55555555-5555-4555-8555-555555555555';
  const engagementId = '66666666-6666-4666-8666-666666666666';
  const sourceWorkspaceId = '77777777-7777-4777-8777-777777777777';
  const targetWorkspaceId = '88888888-8888-4888-8888-888888888888';
  const sourceObjectId = '99999999-9999-4999-8999-999999999999';
  const targetObjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const oldSourceObjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const oldTargetObjectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const binding = {
    connectorId: 'connector-next-1', sessionGeneration: 9, engagementId,
    authorityInstanceId: 'authority-1', tenantOrOrgId: 'tenant-1', packId: 'pack-1'
  };
  const workspaceIds = [sourceWorkspaceId, targetWorkspaceId];
  const authorityDigest = sha256(canonicalJson({ ...binding, workspaceIds }));
  const planDigest = 'd'.repeat(64); const now = new Date().toISOString();
  const sourceTargetKey = 'object|source-row'; const targetTargetKey = 'object|target-row';
  const relationKey = 'relation|source-row|target-row'; const relationType = 'InfrastructureApplication';
  const relationTargetIdentity = `relation|${sourceWorkspaceId}|${targetWorkspaceId}|${sourceObjectId}|${targetObjectId}|${relationType}`;
  const relationOperation = 'omnia.create-associate.relation.associate.v1';
  const relationEvidenceOperation = 'omnia.create-associate.relation.reconcile.v1';
  try {
    database.db.prepare(`INSERT INTO feature_registry(feature_id,feature_version,lifecycle,package_digest,publisher_key_id,health,activated_at) VALUES('omnia.create-associate',?,'active',?,'official','ready',?)`)
      .run(featureVersion, `sha256:${'1'.repeat(64)}`, now);
    database.db.prepare(`INSERT INTO feature_activation_heads(feature_id,feature_version,activation_generation,runtime_enabled,runtime_reason,package_path,package_digest,updated_at) VALUES('omnia.create-associate',?,1,1,'','','sha256:${'1'.repeat(64)}',?)`)
      .run(featureVersion, now);
    database.db.prepare(`UPDATE workspace_safety SET enabled=1,engagement_id=?,workspace_ids_json=?,state_version=2 WHERE singleton=1`)
      .run(engagementId, JSON.stringify(workspaceIds));
    database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate',?,?,'returning',3,'','','',?,'',?,?)`)
      .run(runId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', featureVersion, engagementId, planDigest, now, now);
    database.db.prepare(`INSERT INTO feature_confirmations(confirmation_id,run_id,message_id,plan_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,safety_revision,credential_digest,preflight_digest,confirmation_token_digest,decision,actor_id,decision_at,consumed_command_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved','local-user',?,'',?,?)`)
      .run('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', runId, `return:${runId}`, planDigest,
        binding.connectorId, binding.sessionGeneration, engagementId, binding.authorityInstanceId, binding.tenantOrOrgId,
        binding.packId, 2, authorityDigest, 'e'.repeat(64), 'f'.repeat(64), now, '2099-01-01T00:00:00.000Z', now);

    const addProjectedObject = (input: { intentId: string; commandId: string; targetKey: string; workspaceId: string; objectId: string }) => {
      database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,'object',?,?,'verified',?,?)`)
        .run(input.intentId, runId, planDigest, input.targetKey,
          JSON.stringify({ kind: 'object', key: input.targetKey, workspace: input.workspaceId, objectType: 'Application' }), now, now);
      database.db.prepare(`INSERT INTO feature_commands(command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,commit_point_at,submitted_at,completed_at,last_error,created_at) VALUES(?,?,?,?,?,?,?,'[]','','','readback_verified','','','','',?)`)
        .run(input.commandId, runId, input.intentId, 'omnia.create-associate.object.create.v1', sha256(input.commandId), planDigest, sha256(input.targetKey), now);
      database.db.prepare(`INSERT INTO managed_object_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,revision,run_id,intent_id,command_id,evidence_id,provenance_json,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, engagementId,
          input.workspaceId, 'Application', input.objectId, runId, input.intentId, input.commandId, crypto.randomUUID(), '{}', '{}', now);
    };
    addProjectedObject({ intentId: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', commandId: '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', targetKey: sourceTargetKey, workspaceId: sourceWorkspaceId, objectId: sourceObjectId });
    addProjectedObject({ intentId: '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', commandId: '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa', targetKey: targetTargetKey, workspaceId: targetWorkspaceId, objectId: targetObjectId });

    const relationIntentId = '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,'relation',?,?,'frozen',?,?)`)
      .run(relationIntentId, runId, planDigest, relationKey, JSON.stringify({
        kind: 'relation', key: relationKey, workspace: sourceWorkspaceId, targetWorkspace: targetWorkspaceId,
        sourceObjectTargetKey: sourceTargetKey, targetSourceType: 'in_batch', targetObjectTargetKey: targetTargetKey,
        relationType, mutationOperationId: relationOperation, operationTargetIdentityMode: 'resolved_relation',
        operationTargetIdentityKey: 'legacy-unresolved-relation', evidenceOperationIds: [relationEvidenceOperation]
      }), now, now);
    const mutationRequest = {
      ItElementId: sourceObjectId, AssociatingEntityIds: [targetObjectId], associationType: relationType,
      ConcurrencyTabId: 602, workspaceId: sourceWorkspaceId, engagementId
    };
    const commandInput = {
      runId, planDigest, targetKind: 'relation', targetKey: relationKey, operationId: relationOperation,
      request: mutationRequest, evidenceOperationIds: [relationEvidenceOperation], binding, workspaceIds
    };
    assert.throws(() => store.call('prepareReturnCommand', {
      ...commandInput,
      evidenceTargetIdentityKey: `relation|${sourceWorkspaceId}|${sourceObjectId}|${targetObjectId}|${relationType}`
    }, context), /approved immutable intent/u);
    assert.throws(() => store.call('prepareReturnCommand', {
      ...commandInput, request: { ...mutationRequest, targetWorkspaceId: sourceWorkspaceId },
      evidenceTargetIdentityKey: relationTargetIdentity
    }, context), /receipt-backed frozen source and target/u);
    const prepared = store.call('prepareReturnCommand', {
      ...commandInput, evidenceTargetIdentityKey: relationTargetIdentity
    }, context) as { commandId: string };

    const requestDigest = sha256(canonicalJson({ readback: relationKey }));
    database.db.prepare(`UPDATE feature_commands SET state='readback_verified',evidence_request_digest=? WHERE command_id=?`)
      .run(requestDigest, prepared.commandId);
    database.db.prepare(`UPDATE managed_content_intents SET state='verified' WHERE intent_id=?`).run(relationIntentId);
    const receiptPayload = {
      associated: true, sourceObjectId, targetObjectId, sourceWorkspaceId, targetWorkspaceId, relationType
    };
    const responseJson = canonicalJson(receiptPayload); const responseDigest = sha256(responseJson);
    const receiptId = '66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const evidenceId = '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    database.db.prepare(`INSERT INTO feature_operation_receipts(receipt_id,run_id,command_id,feature_id,feature_version,operation_package_digest,operation_id,authority_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,frozen_target_key,target_identity_key,workspace_ids_json,plan_digest,request_digest,response_digest,response_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(receiptId, runId, prepared.commandId, 'omnia.create-associate', featureVersion, `sha256:${'2'.repeat(64)}`,
        relationEvidenceOperation, authorityDigest, binding.connectorId, binding.sessionGeneration, engagementId,
        binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, relationKey, relationTargetIdentity,
        canonicalJson(workspaceIds), planDigest, requestDigest, responseDigest, responseJson, now);
    database.db.prepare(`INSERT INTO feature_command_evidence(evidence_id,command_id,run_id,evidence_type,evidence_digest,receipt_id,verified,payload_json,occurred_at) VALUES(?,?,?,'readback',?,?,1,?,?)`)
      .run(evidenceId, prepared.commandId, runId, responseDigest, receiptId,
        JSON.stringify({ ...receiptPayload, __operationReceiptId: receiptId }), now);

    database.db.prepare(`INSERT INTO managed_relations(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,current_revision,lifecycle,freshness,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,'active','verified_current',?)`)
      .run(binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, engagementId, sourceWorkspaceId,
        relationType, relationKey, oldSourceObjectId, oldTargetObjectId, now);
    database.db.prepare(`INSERT INTO managed_relation_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,revision,run_id,intent_id,command_id,evidence_id,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`)
      .run('88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId,
        engagementId, sourceWorkspaceId, relationType, relationKey, oldSourceObjectId, oldTargetObjectId,
        'historical-run', 'historical-intent', 'historical-command', 'historical-evidence', '{}', now);

    store.call('projectVerifiedReturn', {
      runId, commandId: prepared.commandId, binding, workspaceId: sourceWorkspaceId, projectionKind: 'relation',
      relationType, relationKey, sourceObjectId, targetObjectId, payload: receiptPayload
    }, context);
    const head = database.db.prepare(`SELECT source_object_id,target_object_id,current_revision FROM managed_relations WHERE relation_key=?`)
      .get(relationKey) as Record<string, unknown>;
    assert.deepEqual({ ...head }, { source_object_id: sourceObjectId, target_object_id: targetObjectId, current_revision: 2 });
    const revisions = database.db.prepare(`SELECT revision,source_object_id,target_object_id FROM managed_relation_revisions WHERE relation_key=? ORDER BY revision`)
      .all(relationKey) as Array<Record<string, unknown>>;
    assert.deepEqual(revisions.map((row) => ({ ...row })), [
      { revision: 1, source_object_id: oldSourceObjectId, target_object_id: oldTargetObjectId },
      { revision: 2, source_object_id: sourceObjectId, target_object_id: targetObjectId }
    ]);
  } finally {
    database.close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
});
