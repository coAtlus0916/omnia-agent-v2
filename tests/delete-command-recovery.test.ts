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

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

test('an exact unsubmitted deletion command survives Core and Worker restart without allocating a second identity', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-delete-command-recovery-'));
  const paths = resolveProductPaths(temporary);
  const featureId = 'omnia.delete-elements';
  const featureVersion = '0.3.21';
  const runId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const engagementId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const planDigest = crypto.randomBytes(32).toString('hex');
  const targetKind = 'object';
  const targetKey = `object|${crypto.randomUUID()}`;
  const operationId = 'omnia.delete-elements.object.delete.v1';
  const evidenceOperationId = 'omnia.delete-elements.object.read.v1';
  const targetIdentityKey = `delete-object|${workspaceId}|${targetKey}`;
  const mutationPayload = { engagementId, workspaceId, objectId: crypto.randomUUID(), expectedRevision: 7 };
  const binding = {
    connectorId: 'connector-delete-recovery', sessionGeneration: 7, engagementId,
    authorityInstanceId: 'authority-delete-recovery', tenantOrOrgId: 'tenant-delete-recovery',
    packId: 'pack-delete-recovery'
  };
  const request = {
    runId, planDigest, targetKind, targetKey, workspaceId, binding, workspaceIds: [workspaceId],
    operationId, request: mutationPayload, evidenceOperationIds: [evidenceOperationId],
    evidenceTargetIdentityKey: targetIdentityKey
  };
  const context = { featureId, featureVersion, allowMutation: true };
  const occurredAt = new Date().toISOString();
  let database = new CoreDatabase(paths.database, cipher);
  try {
    const authorityDigest = sha256({ ...binding, workspaceIds: [workspaceId] });
    database.db.prepare(`
      UPDATE workspace_safety
      SET enabled=1,engagement_id=?,workspace_ids_json=?,state_version=5
      WHERE singleton=1
    `).run(engagementId, JSON.stringify([workspaceId]));
    database.db.prepare(`
      INSERT INTO feature_runs(
        run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
        source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,?,'returning',3,'','','',?,'',?,?)
    `).run(runId, crypto.randomUUID(), featureId, featureVersion, engagementId, planDigest, occurredAt, occurredAt);
    database.db.prepare(`
      INSERT INTO feature_confirmations(
        confirmation_id,run_id,message_id,plan_digest,connector_id,session_generation,engagement_id,
        authority_instance_id,tenant_or_org_id,pack_id,safety_revision,credential_digest,preflight_digest,
        confirmation_token_digest,decision,actor_id,decision_at,consumed_command_id,expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved','local-user',?,'',?,?)
    `).run(
      crypto.randomUUID(), runId, `return:${runId}`, planDigest, binding.connectorId,
      binding.sessionGeneration, engagementId, binding.authorityInstanceId, binding.tenantOrOrgId,
      binding.packId, 5, authorityDigest, crypto.randomBytes(32).toString('hex'),
      crypto.randomBytes(32).toString('hex'), occurredAt, '2099-01-01T00:00:00.000Z', occurredAt
    );
    database.db.prepare(`
      INSERT INTO managed_content_intents(
        intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'frozen',?,?)
    `).run(intentId, runId, planDigest, targetKind, targetKey, JSON.stringify({
      workspace: workspaceId, mutationOperationId: operationId, operationTargetIdentityKey: targetIdentityKey,
      mutationPayload, evidenceOperationIds: [evidenceOperationId]
    }), occurredAt, occurredAt);

    const first = new FeatureRuntimeStore(database.db, paths).call('prepareDeletionCommand', request, context) as Record<string, unknown>;
    assert.equal(typeof first.commandId, 'string');
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM feature_commands WHERE intent_id=?')
      .get(intentId)?.count, 1);

    database.close();
    database = new CoreDatabase(paths.database, cipher);
    const recovered = new FeatureRuntimeStore(database.db, paths).call('prepareDeletionCommand', request, context) as Record<string, unknown>;
    assert.deepEqual(recovered, first);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM feature_commands WHERE intent_id=?')
      .get(intentId)?.count, 1);

    assert.throws(
      () => new FeatureRuntimeStore(database.db, paths).call('prepareDeletionCommand', {
        ...request, request: { ...mutationPayload, expectedRevision: 8 }
      }, context),
      /approved immutable intent/u
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM feature_commands WHERE intent_id=?')
      .get(intentId)?.count, 1);

    database.db.prepare("UPDATE feature_commands SET state='submitted',submitted_at=? WHERE command_id=?")
      .run(new Date().toISOString(), String(first.commandId));
    assert.throws(
      () => new FeatureRuntimeStore(database.db, paths).call('prepareDeletionCommand', request, context),
      /no exact unsubmitted prepared command/u
    );
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM feature_commands WHERE intent_id=?')
      .get(intentId)?.count, 1);

    database.db.prepare('UPDATE workspace_safety SET enabled=0,state_version=6 WHERE singleton=1').run();
    assert.throws(
      () => new FeatureRuntimeStore(database.db, paths).call('prepareDeletionCommand', request, context),
      /outside the current durable safety lock/u
    );
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
