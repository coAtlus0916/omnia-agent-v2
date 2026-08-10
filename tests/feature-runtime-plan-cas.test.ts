import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { CoreDatabase } from '../src/main/database.js';
import { FeatureRuntimeStore } from '../src/main/features/feature-runtime-store.js';
import { resolveProductPaths } from '../src/main/paths.js';

const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };
const context = { featureId: 'omnia.recording', featureVersion: '0.4.17', allowMutation: false };

function cas(store: FeatureRuntimeStore, planId: string, expectedStoreRevision: number, extra: Record<string, unknown> = {}) {
  return store.call('compareAndSwapPlan', {
    schemaVersion: 'omnia.feature-runtime-plan-cas/v1',
    planId,
    expectedStoreRevision,
    plan: { planId, ...extra, storeRevision: expectedStoreRevision + 1 }
  }, context) as Record<string, unknown>;
}

test('runtime plan CAS upgrades the actual legacy table and survives Store/database reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-runtime-plan-cas-'));
  const paths = resolveProductPaths(root);
  const featureRoot = path.join(paths.data, 'features', context.featureId);
  fs.mkdirSync(featureRoot, { recursive: true });
  let database = new CoreDatabase(paths.database, cipher);
  try {
    const privateStore = new DatabaseSync(path.join(featureRoot, 'store.sqlite'));
    privateStore.exec(`CREATE TABLE recording_runtime_plans(
      plan_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,updated_at TEXT NOT NULL
    )`);
    privateStore.prepare('INSERT INTO recording_runtime_plans(plan_id,payload_json,updated_at) VALUES(?,?,?)')
      .run('legacy-plan', JSON.stringify({ planId: 'legacy-plan', state: 'stopped' }), '2026-08-09T00:00:00.000Z');
    privateStore.close();

    let store = new FeatureRuntimeStore(database.db, paths);
    const first = cas(store, 'legacy-plan', 0, { state: 'finalizing' });
    assert.equal(first.storeRevision, 1);
    const verification = new DatabaseSync(path.join(featureRoot, 'store.sqlite'));
    const upgraded = JSON.parse(String((verification.prepare(
      `SELECT payload_json FROM recording_runtime_plans WHERE plan_id='legacy-plan'`
    ).get() as { payload_json: string }).payload_json));
    assert.deepEqual(upgraded, { planId: 'legacy-plan', state: 'finalizing', storeRevision: 1 });
    assert.equal((verification.prepare(
      `SELECT COUNT(*) AS count FROM __runtime_plans WHERE plan_id='legacy-plan'`
    ).get() as { count: number }).count, 0, 'CAS must not fork a legacy plan into the fallback table');
    verification.close();
    assert.equal(store.call('savePlan', { planId: 'legacy-blind-plan', state: 'one' }, context), true);
    assert.equal(store.call('savePlan', { planId: 'legacy-blind-plan', state: 'two' }, context), true);
    assert.deepEqual(store.call('loadPlan', 'legacy-blind-plan', context), {
      planId: 'legacy-blind-plan', state: 'two'
    });
    assert.throws(
      () => store.call('savePlan', { planId: 'legacy-plan', state: 'blind-overwrite' }, context),
      (error: any) => error?.code === 'FEATURE.PLAN_CAS_REQUIRED'
    );

    database.close();
    database = new CoreDatabase(paths.database, cipher);
    store = new FeatureRuntimeStore(database.db, paths);
    assert.equal((store.call('loadPlan', 'legacy-plan', context) as any).storeRevision, 1);
    assert.equal(cas(store, 'legacy-plan', 1, { state: 'complete' }).storeRevision, 2);
    assert.deepEqual(store.call('loadPlan', 'legacy-plan', context), {
      planId: 'legacy-plan', state: 'complete', storeRevision: 2
    });
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime plan CAS validates the protected revision and bounded JSON payload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-runtime-plan-cas-bounds-'));
  const paths = resolveProductPaths(root);
  fs.mkdirSync(path.join(paths.data, 'features', context.featureId), { recursive: true });
  const database = new CoreDatabase(paths.database, cipher);
  const store = new FeatureRuntimeStore(database.db, paths);
  try {
    cas(store, 'bounded-plan', 0, { state: 'first' });
    assert.throws(
      () => cas(store, 'bounded-plan', 0, { state: 'stale' }),
      (error: any) => error?.code === 'FEATURE.PLAN_CAS_MISMATCH' && error?.retryable === true
    );
    assert.equal((store.call('loadPlan', 'bounded-plan', context) as any).state, 'first');
    assert.throws(() => store.call('compareAndSwapPlan', {
      schemaVersion: 'omnia.feature-runtime-plan-cas/v1', planId: 'bounded-plan', expectedStoreRevision: 1,
      plan: { planId: 'bounded-plan', storeRevision: 99 }
    }, context), (error: any) => error?.code === 'FEATURE.PLAN_CAS_INVALID');
    assert.throws(() => store.call('compareAndSwapPlan', {
      schemaVersion: 'omnia.feature-runtime-plan-cas/v1', planId: 'bounded-plan', expectedStoreRevision: Number.MAX_SAFE_INTEGER,
      plan: { planId: 'bounded-plan', storeRevision: Number.MAX_SAFE_INTEGER }
    }, context), (error: any) => error?.code === 'FEATURE.PLAN_CAS_INVALID');
    assert.throws(() => cas(store, 'large-plan', 0, { payload: 'x'.repeat(1024 * 1024) }),
      (error: any) => error?.code === 'FEATURE.PLAN_PAYLOAD_TOO_LARGE');
    assert.throws(() => store.call('compareAndSwapPlan', {
      schemaVersion: 'omnia.feature-runtime-plan-cas/v1', planId: 'bounded-plan', expectedStoreRevision: 1,
      plan: { planId: 'bounded-plan', storeRevision: 2 }, table: '__runtime_plans'
    }, context), /unexpected or missing field/u);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two processes using the same expected plan revision produce exactly one commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-runtime-plan-cas-race-'));
  const paths = resolveProductPaths(root);
  fs.mkdirSync(path.join(paths.data, 'features', context.featureId), { recursive: true });
  const database = new CoreDatabase(paths.database, cipher);
  const store = new FeatureRuntimeStore(database.db, paths);
  cas(store, 'racing-plan', 0, { winner: 'none' });

  const runtimeStoreUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/main/features/feature-runtime-store.ts')).href;
  const childScript = `
    import { DatabaseSync } from 'node:sqlite';
    import { FeatureRuntimeStore } from ${JSON.stringify(runtimeStoreUrl)};
    const core = new DatabaseSync(':memory:');
    const store = new FeatureRuntimeStore(core, { data: process.env.CAS_DATA_ROOT });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(process.env.CAS_START_AT) - Date.now())));
    try {
      const planId = 'racing-plan';
      const result = store.call('compareAndSwapPlan', {
        schemaVersion: 'omnia.feature-runtime-plan-cas/v1', planId, expectedStoreRevision: 1,
        plan: { planId, winner: process.env.CAS_WINNER, storeRevision: 2 }
      }, { featureId: 'omnia.recording', featureVersion: '0.4.17', allowMutation: false });
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, retryable: error.retryable === true }));
    } finally { core.close(); }
  `;
  const runChild = (winner: string, startAt: number) => new Promise<Record<string, any>>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childScript], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, CAS_DATA_ROOT: paths.data, CAS_START_AT: String(startAt), CAS_WINNER: winner },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`CAS child exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
  try {
    const startAt = Date.now() + 750;
    const results = await Promise.all([runChild('left', startAt), runChild('right', startAt)]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.deepEqual(results.filter((result) => !result.ok).map((result) => [result.code, result.retryable]), [
      ['FEATURE.PLAN_CAS_MISMATCH', true]
    ]);
    const persisted = store.call('loadPlan', 'racing-plan', context) as any;
    assert.equal(persisted.storeRevision, 2);
    assert.ok(['left', 'right'].includes(persisted.winner));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
