import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.js';
import { FeaturePackageManager } from '../src/main/features/package-manager.js';
import { FeatureRuntimeStore } from '../src/main/features/feature-runtime-store.js';
import { canonicalJson } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('Delete GRA cascade intents freeze without a create/reuse disposition', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-delete-gra-disposition-'));
  const paths = resolveProductPaths(temporary); const database = new CoreDatabase(paths.database, cipher);
  new FeaturePackageManager(database.db, paths);
  const store = new FeatureRuntimeStore(database.db, paths);
  const context = { featureId: 'omnia.delete-elements', featureVersion: '0.3.32', allowMutation: true };
  const runId = '11111111-1111-4111-8111-111111111111'; const workspaceId = '22222222-2222-4222-8222-222222222222';
  const engagementId = '33333333-3333-4333-8333-333333333333'; const graId = '55555555-5555-4555-8555-555555555555';
  const now = new Date().toISOString();
  const binding = { connectorId: 'connector-1', sessionGeneration: 7, engagementId, authorityInstanceId: 'authority-1', tenantOrOrgId: 'tenant-1', packId: 'pack-1' };
  const authorityDigest = sha256(canonicalJson({ ...binding, workspaceIds: [workspaceId] }));
  try {
    database.db.prepare(`INSERT INTO feature_registry(feature_id,feature_version,lifecycle,package_digest,publisher_key_id,health,activated_at) VALUES('omnia.delete-elements',?,'active',?,'test-key','healthy',?)`)
      .run(context.featureVersion, `sha256:${'1'.repeat(64)}`, now);
    database.db.prepare(`INSERT INTO feature_activation_heads(feature_id,feature_version,activation_generation,runtime_enabled,runtime_reason,package_path,package_digest,updated_at) VALUES('omnia.delete-elements',?,1,1,'','test-package',?,?)`)
      .run(context.featureVersion, `sha256:${'1'.repeat(64)}`, now);
    database.db.prepare(`UPDATE workspace_safety SET enabled=1,engagement_id=?,workspace_ids_json=?,state_version=2 WHERE singleton=1`).run(engagementId, JSON.stringify([workspaceId]));
    database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.delete-elements',?,?,'ready_for_review',1,'','','','','',?,?)`)
      .run(runId, '66666666-6666-4666-8666-666666666666', context.featureVersion, engagementId, now, now);
    const safetyLock = { enabled: true, engagementId, workspaceIds: [workspaceId], globalEnabled: false,
      globalSectionIds: [], globalWorkspaceIds: [], stateVersion: 2 };
    // A delete GRA cascade intent carries no disposition; it must still freeze.
    const frozen = store.call('prepareReturnIntent', {
      runId, connectorBinding: binding, safetyLock, credentialDigest: authorityDigest, preflightDigest: 'b'.repeat(64),
      plan: { schemaVersion: 'omnia.delete-intent/v2', authority: binding, targets: [{
        kind: 'object', key: `GRA|${workspaceId}|${graId}`, workspace: workspaceId, objectType: 'GRA', objectId: graId,
        mutationOperationId: 'omnia.delete.gra.direct.v1', mutationPayload: { riskAssessmentId: graId },
        evidenceOperationIds: ['omnia.delete.gra.reconcile.v1'], operationTargetIdentityKey: `GRA|${workspaceId}|${graId}`
      }] }
    }, context) as Record<string, unknown>;
    assert.ok(frozen.confirmationId);
  } finally {
    database.close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
});
