import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.js';
import {
  FEATURE_RUNTIME_STORE_PORT_POLICIES,
  FeatureRuntimeStore
} from '../src/main/features/feature-runtime-store.js';
import { _test as packageManagerTest } from '../src/main/features/package-manager.js';
import { resolveProductPaths } from '../src/main/paths.js';

const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };
const repo = path.resolve(import.meta.dirname, '..');

function seedRun(
  database: CoreDatabase,
  featureId: string,
  featureVersion: string,
  state: 'returning' | 'uncertain' = 'returning'
): { runId: string; intentId: string; commandId: string } {
  const runId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const planDigest = crypto.randomBytes(32).toString('hex');
  database.db.prepare(`
    INSERT INTO feature_runs(
      run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
      source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,1,'','','',?,'',?,?)
  `).run(runId,crypto.randomUUID(),featureId,featureVersion,'engagement-owner',state,planDigest,occurredAt,occurredAt);
  database.db.prepare(`
    INSERT INTO managed_content_intents(
      intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at
    ) VALUES(?,?,?,'field',?,'{}','commanded',?,?)
  `).run(intentId,runId,planDigest,`field|${intentId}`,occurredAt,occurredAt);
  database.db.prepare(`
    INSERT INTO feature_commands(
      command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,
      evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,
      commit_point_at,submitted_at,completed_at,last_error,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared','','','','',?)
  `).run(
    commandId,runId,intentId,`${featureId}.write.v1`,crypto.randomBytes(32).toString('hex'),
    planDigest,crypto.randomBytes(32).toString('hex'),'[]',`field|${intentId}`,'',occurredAt
  );
  return {runId,intentId,commandId};
}

test('signed Store port declarations fail closed before runtime dispatch and Core rejects unknown methods', () => {
  const declared = {
    storePorts: ['loadPlan'], aiReviewCapabilities: [], pythonSidecar: null
  };
  assert.doesNotThrow(() => packageManagerTest.assertDeclaredStorePort(declared, 'loadPlan'));
  assert.throws(
    () => packageManagerTest.assertDeclaredStorePort(declared, 'savePlan'),
    (error: any) => error?.code === 'FEATURE.STORE_PORT_UNDECLARED'
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-feature-store-unknown-'));
  const paths = resolveProductPaths(root);
  const database = new CoreDatabase(paths.database,cipher);
  try {
    const store = new FeatureRuntimeStore(database.db,paths);
    assert.throws(
      () => store.call('undeclaredPrivateMethod',{}, {
        featureId:'official.alpha',featureVersion:'1.0.0',allowMutation:false
      }),
      (error: any) => error?.code === 'FEATURE.STORE_PORT_UNKNOWN'
    );
  } finally {
    database.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('command specifications bind feature, version, run, and command and remain immutable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-feature-store-owner-'));
  const paths = resolveProductPaths(root);
  const database = new CoreDatabase(paths.database,cipher);
  try {
    const alpha = seedRun(database,'official.alpha','1.0.0');
    const beta = seedRun(database,'official.beta','2.0.0');
    const store = new FeatureRuntimeStore(database.db,paths);
    const alphaContext = {featureId:'official.alpha',featureVersion:'1.0.0',allowMutation:false};
    const spec = {
      schemaVersion:'official.reconcile-spec/v1',commandId:alpha.commandId,operationId:'official.alpha.read.v1'
    };

    assert.throws(
      () => store.call('saveReturnReconcileSpec',{runId:alpha.runId,commandId:alpha.commandId,spec}, {
        featureId:'official.beta',featureVersion:'2.0.0',allowMutation:false
      }),
      (error: any) => error?.code === 'FEATURE.STORE_OWNER_MISMATCH'
    );
    assert.throws(
      () => store.call('saveReturnReconcileSpec',{runId:alpha.runId,commandId:alpha.commandId,spec}, {
        featureId:'official.alpha',featureVersion:'1.0.1',allowMutation:false
      }),
      (error: any) => error?.code === 'FEATURE.STORE_OWNER_MISMATCH'
    );
    assert.equal(store.call('saveReturnReconcileSpec',{
      runId:alpha.runId,commandId:alpha.commandId,spec
    },alphaContext),true);
    assert.equal(store.call('saveReturnReconcileSpec',{
      runId:alpha.runId,commandId:alpha.commandId,spec:{...spec}
    },alphaContext),true,'an exact retry must be idempotent');
    assert.throws(
      () => store.call('saveReturnReconcileSpec',{
        runId:alpha.runId,commandId:alpha.commandId,spec:{...spec,operationId:'official.alpha.other.v1'}
      },alphaContext),
      (error: any) => error?.code === 'FEATURE.RECONCILE_SPEC_IMMUTABLE'
    );

    const row = database.db.prepare(`
      SELECT feature_id,feature_version,run_id,command_id FROM feature_command_specs WHERE command_id=?
    `).get(alpha.commandId) as Record<string,unknown>;
    assert.deepEqual({...row},{
      feature_id:'official.alpha',feature_version:'1.0.0',run_id:alpha.runId,command_id:alpha.commandId
    });
    database.db.prepare(`UPDATE feature_commands SET state='uncertain' WHERE command_id=?`).run(alpha.commandId);
    assert.deepEqual(store.call('loadReturnReconcileSpec',{
      runId:alpha.runId,commandId:alpha.commandId
    },alphaContext),spec);
    assert.throws(
      () => store.call('loadReturnReconcileSpec',{runId:alpha.runId,commandId:beta.commandId},alphaContext),
      (error: any) => error?.code === 'FEATURE.STORE_OWNER_MISMATCH'
    );
    assert.throws(
      () => store.call('loadReturnReconcileSpec',{runId:alpha.runId,commandId:alpha.commandId},{
        featureId:'official.beta',featureVersion:'2.0.0',allowMutation:false
      }),
      (error: any) => error?.code === 'FEATURE.STORE_OWNER_MISMATCH'
    );
    assert.deepEqual(store.call('loadReturnReconcileSpec',{runId:alpha.runId},alphaContext),spec,
      'one exact historical uncertain spec remains recoverable without a caller-supplied command identity');
    assert.throws(() => database.db.prepare(`
      INSERT INTO feature_command_specs(command_id,run_id,feature_id,feature_version,spec_json,created_at)
      VALUES(?,?,?,?,?,?)
    `).run(beta.commandId,beta.runId,'official.alpha','1.0.0',JSON.stringify({commandId:beta.commandId}),new Date().toISOString()),/FOREIGN KEY constraint failed/i);
    assert.throws(() => database.db.prepare(`
      INSERT INTO feature_commands(
        command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,
        evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,
        commit_point_at,submitted_at,completed_at,last_error,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared','','','','',?)
    `).run(
      crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID(),'official.invalid.write.v1',
      crypto.randomBytes(32).toString('hex'),crypto.randomBytes(32).toString('hex'),
      crypto.randomBytes(32).toString('hex'),'[]','','',new Date().toISOString()
    ),/feature command requires an existing owned run/i);
  } finally {
    database.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('migration 25 backfills legal historical specs and quarantines unresolved legacy rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-feature-store-migration-'));
  const paths = resolveProductPaths(root);
  let database = new CoreDatabase(paths.database,cipher);
  const owned = seedRun(database,'official.history','3.2.1');
  const createdAt = new Date().toISOString();
  database.db.prepare(`
    INSERT INTO feature_command_specs(command_id,run_id,feature_id,feature_version,spec_json,created_at)
    VALUES(?,?,?,?,?,?)
  `).run(owned.commandId,owned.runId,'official.history','3.2.1',JSON.stringify({commandId:owned.commandId,legacy:true}),createdAt);
  database.db.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TRIGGER feature_commands_require_owned_run_insert;
    DROP TRIGGER feature_commands_require_owned_run_update;
    CREATE TABLE feature_command_specs_legacy(
      command_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,spec_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO feature_command_specs_legacy(command_id,run_id,spec_json,created_at)
      SELECT command_id,run_id,spec_json,created_at FROM feature_command_specs;
    DROP TABLE feature_command_specs;
    ALTER TABLE feature_command_specs_legacy RENAME TO feature_command_specs;
    DROP TABLE feature_command_spec_quarantine;
    DROP INDEX feature_commands_exact_owner;
    DROP INDEX feature_runs_exact_owner;
    DELETE FROM schema_migrations WHERE version=25;
    PRAGMA foreign_keys=ON;
  `);
  const orphanCommandId = crypto.randomUUID();
  const orphanRunId = crypto.randomUUID();
  database.db.prepare(`INSERT INTO feature_command_specs(command_id,run_id,spec_json,created_at) VALUES(?,?,?,?)`)
    .run(orphanCommandId,orphanRunId,JSON.stringify({commandId:orphanCommandId,orphan:true}),createdAt);
  database.close();

  try {
    database = new CoreDatabase(paths.database,cipher);
    assert.deepEqual({...database.db.prepare(`
      SELECT feature_id,feature_version,spec_json FROM feature_command_specs WHERE command_id=?
    `).get(owned.commandId) as Record<string,unknown>},{
      feature_id:'official.history',feature_version:'3.2.1',
      spec_json:JSON.stringify({commandId:owned.commandId,legacy:true})
    });
    assert.equal(database.db.prepare(`SELECT 1 FROM feature_command_specs WHERE command_id=?`).get(orphanCommandId),undefined);
    assert.deepEqual({...database.db.prepare(`
      SELECT run_id,quarantine_reason FROM feature_command_spec_quarantine WHERE command_id=?
    `).get(orphanCommandId) as Record<string,unknown>},{run_id:orphanRunId,quarantine_reason:'legacy_command_or_run_owner_unresolved'});
    assert.deepEqual(database.db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {
    database.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('four Feature runtime contracts exactly match real Store calls and Core contains no Feature-ID branch', () => {
  const packages = [
    ['create-associate','scripts/package-create-associate-feature.mjs'],
    ['delete-elements','scripts/package-delete-feature.mjs'],
    ['recording','scripts/package-recording-feature.mjs'],
    ['workpaper-preparation','scripts/package-workpaper-preparation-feature.mjs']
  ] as const;
  for (const [directory,scriptPath] of packages) {
    const middle = path.join(repo,'feature-packages',directory,'source','middle');
    const actual = new Set<string>();
    for (const member of fs.readdirSync(middle).filter((name)=>name.endsWith('.cjs'))) {
      const source = fs.readFileSync(path.join(middle,member),'utf8');
      for (const match of source.matchAll(/(?:ports\.)?store\.call\(\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/gu)) {
        actual.add(match[1]!);
      }
      const conveniencePorts: Readonly<Record<string,string>> = {
        append:'appendEvidence',appendEvidence:'appendEvidence',upsertManagedContent:'upsertManagedContent',
        savePlan:'savePlan',loadPlan:'loadPlan'
      };
      for (const match of source.matchAll(/(?:ports\.)?store\.(append|appendEvidence|upsertManagedContent|savePlan|loadPlan)\s*\(/gu)) {
        actual.add(conveniencePorts[match[1]!]!);
      }
    }
    const script = fs.readFileSync(path.join(repo,scriptPath),'utf8');
    const block = script.match(/storePorts\s*:\s*\[([\s\S]*?)\]/u)?.[1] || '';
    const declared = [...block.matchAll(/['"]([A-Za-z][A-Za-z0-9]*)['"]/gu)].map((match)=>match[1]!);
    assert.deepEqual([...declared].sort(),[...actual].sort(),`${directory} Store declaration drifted from its Worker/bridge calls`);
    assert.equal(new Set(declared).size,declared.length,`${directory} declares a duplicate Store method`);
    for (const method of declared) assert.ok(FEATURE_RUNTIME_STORE_PORT_POLICIES[method],`${directory} declares unknown ${method}`);
  }

  const core = [
    'src/main/features/feature-runtime-store.ts',
    'src/main/features/package-manager.ts'
  ].map((filename)=>fs.readFileSync(path.join(repo,filename),'utf8')).join('\n');
  assert.doesNotMatch(core,/omnia\.(?:create-associate|delete-elements|recording|workpaper-preparation)/u);
  assert.doesNotMatch(core,/(?:context|manifest)\.featureId\s*(?:===|!==)\s*['"]/u);
});
