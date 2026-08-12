import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.js';
import { FeatureRuntimeStore } from '../src/main/features/feature-runtime-store.js';
import { resolveProductPaths } from '../src/main/paths.js';

const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };

type DeletionRelationResolver = {
  resolveDeletionRelation(
    binding: Record<string, unknown>, workspaceId: string, relationType: string,
    canonicalRelationKey: string, sourceObjectId: string, targetObjectId: string,
    riskControlIdentity: Record<string, string>
  ): { relationKey: string; currentRevision: number };
};

test('legacy Risk-Control projection uses its exact durable command identity when the old response omits the GRA id', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-delete-legacy-risk-control-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, cipher);
  try {
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    const intentId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const relationKey = `risk-control|${crypto.randomBytes(32).toString('hex')}|REL.TEST`;
    const workspaceId = crypto.randomUUID();
    const identity = {
      graId: crypto.randomUUID(), riskId: crypto.randomUUID(), controlId: crypto.randomUUID(),
      riskRiskScopeId: crypto.randomUUID(), riskScopeId: crypto.randomUUID(), relationId: 'REL.TEST'
    };
    const binding = {
      authorityInstanceId: 'authority-test', tenantOrOrgId: 'tenant-test', packId: 'pack-test',
      engagementId: 'engagement-test'
    };
    const planDigest = crypto.randomBytes(32).toString('hex');
    const legacyPayload = {
      verified: true,
      detail: {
        plannedRiskFactorCategory: [],
        planResponseRisk: [{
          id: identity.riskId, riskScopeId: identity.riskScopeId,
          riskRiskScopeIds: [identity.riskRiskScopeId]
        }],
        planResponseSelectedControl: [{
          controlId: identity.controlId, riskId: identity.riskId, riskScopeId: identity.riskScopeId
        }]
      }
    };
    database.db.prepare(`
      INSERT INTO feature_runs(
        run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
        source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,?,'succeeded',1,'','','',?,'',?,?)
    `).run(runId, crypto.randomUUID(), 'omnia.create-associate', '0.2.131', binding.engagementId, planDigest, now, now);
    database.db.prepare(`
      INSERT INTO managed_content_intents(
        intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at
      ) VALUES(?,?,?,'risk_control',?,?,'verified',?,?)
    `).run(intentId, runId, planDigest, relationKey, '{}', now, now);
    database.db.prepare(`
      INSERT INTO feature_commands(
        command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,
        evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,
        commit_point_at,submitted_at,completed_at,last_error,created_at
      ) VALUES(?,?,?,'omnia.create-associate.risk-control.associate.v1',?,?,?,'[]','target',?,'readback_verified',?,?,?,'',?)
    `).run(
      commandId, runId, intentId, crypto.randomUUID(), planDigest,
      crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex'),
      now, now, now, now
    );
    const commandSpec = {
      commandId,
      mutationPayload: {
        riskAssessmentId: identity.graId,
        riskRiskScopeId: identity.riskRiskScopeId,
        riskId: identity.riskId,
        controlRiskScopes: [{
          controlId: identity.controlId, riskId: identity.riskId, riskScopeId: identity.riskScopeId
        }]
      }
    };
    database.db.prepare(`
      INSERT INTO feature_command_specs(command_id,run_id,feature_id,feature_version,spec_json,created_at)
      VALUES(?,?,?,?,?,?)
    `).run(commandId, runId, 'omnia.create-associate', '0.2.131', JSON.stringify(commandSpec), now);
    database.db.prepare(`
      INSERT INTO managed_relations(
        authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,
        relation_key,source_object_id,target_object_id,current_revision,lifecycle,freshness,updated_at
      ) VALUES(?,?,?,?,?,'risk_control',?,?,?,1,'active','verified_current',?)
    `).run(
      binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
      workspaceId, relationKey, identity.riskId, identity.controlId, now
    );
    database.db.prepare(`
      INSERT INTO managed_relation_revisions(
        revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,
        relation_type,relation_key,source_object_id,target_object_id,revision,run_id,intent_id,
        command_id,evidence_id,payload_json,verified_at
      ) VALUES(?,?,?,?,?,?,'risk_control',?,?,?,1,?,?,?,?,?,?)
    `).run(
      crypto.randomUUID(), binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId,
      binding.engagementId, workspaceId, relationKey, identity.riskId, identity.controlId,
      runId, intentId, commandId, crypto.randomUUID(), JSON.stringify(legacyPayload), now
    );

    const resolver = (new FeatureRuntimeStore(database.db, paths) as unknown as DeletionRelationResolver);
    assert.deepEqual(
      resolver.resolveDeletionRelation(
        binding, workspaceId, 'risk_control', `risk-control|canonical`,
        identity.riskId, identity.controlId, identity
      ),
      { relationKey, currentRevision: 1 }
    );

    commandSpec.mutationPayload.riskAssessmentId = crypto.randomUUID();
    database.db.prepare('UPDATE feature_command_specs SET spec_json=? WHERE command_id=?')
      .run(JSON.stringify(commandSpec), commandId);
    assert.throws(
      () => resolver.resolveDeletionRelation(
        binding, workspaceId, 'risk_control', `risk-control|canonical`,
        identity.riskId, identity.controlId, identity
      ),
      /none matches the frozen\/readback GRA/u
    );
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
