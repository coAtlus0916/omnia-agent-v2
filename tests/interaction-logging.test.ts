import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.js';
import { createTestContentCipher } from '../src/main/content-cipher.js';
import { InteractionLogService } from '../src/main/services/interaction-log-service.js';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-interaction-log-'));
  const filename = path.join(root, 'core.sqlite');
  const database = new CoreDatabase(filename, createTestContentCipher());
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, filename };
}

test('migration 19 persists correlated start/success/failure interactions and real queries', async (t) => {
  const { database } = fixture(t);
  const logger = new InteractionLogService(database.db);
  await logger.run({
    plane: 'surface', component: 'shell-ipc', surface: 'shell.main', action: 'outer',
    failurePoint: 'main.ipc.outer', details: { featureId: 'omnia.synthetic', count: 1 }
  }, async () => {
    await logger.run({
      plane: 'connector', component: 'signed-operation', surface: 'feature.synthetic', action: 'preflight',
      failurePoint: 'connector.operation.preflight', operationId: 'omnia.synthetic.preflight.v1'
    }, async () => undefined);
  });
  await assert.rejects(logger.run({
    plane: 'core', component: 'core-test', surface: 'settings.logs', action: 'failure', failurePoint: 'core.test.failure'
  }, async () => { throw Object.assign(new Error('synthetic failure'), { code: 'TEST.SYNTHETIC' }); }));

  const page = logger.query({ limit: 20 });
  assert.equal(page.entries.length, 3);
  const root = page.entries.find((entry) => entry.action === 'outer')!;
  const child = page.entries.find((entry) => entry.action === 'preflight')!;
  const failed = page.entries.find((entry) => entry.action === 'failure')!;
  assert.equal(root.phase, 'success');
  assert.equal(child.traceId, root.traceId);
  assert.equal(child.parentId, root.interactionId);
  assert.equal(failed.phase, 'failure');
  assert.equal(failed.errorCode, 'TEST.SYNTHETIC');
  assert.equal(failed.failurePoint, 'core.test.failure');
  assert.equal(logger.trace(root.traceId).entries.length, 2);
  assert.equal(logger.query({ severity: 'error', plane: 'core', interactionId: failed.interactionId.slice(0, 8) }).entries.length, 1);
});

test('redaction forbids secrets, bodies, file contents and absolute paths in raw log storage', async (t) => {
  const { database } = fixture(t);
  const logger = new InteractionLogService(database.db);
  const secret = 'synthetic-super-secret-token';
  await assert.rejects(logger.run({
    plane: 'core', component: 'redaction-test', surface: 'settings.logs', action: 'redact', failurePoint: 'core.redaction',
    details: {
      apiKey: secret, authorization: `Bearer ${secret}`, body: 'synthetic customer body',
      filename: 'C:\\Users\\Synthetic\\customer.xlsx', basename: 'C:\\Users\\Synthetic\\customer.xlsx',
      sha256: 'a'.repeat(64), runId: 'run-safe-id'
    }
  }, async () => { throw Object.assign(new Error(`Authorization=Bearer ${secret} at C:\\Users\\Synthetic\\customer.xlsx`), { code: 'TEST.REDACTION' }); }));
  const raw = JSON.stringify(database.db.prepare('SELECT * FROM interaction_logs').all());
  assert.doesNotMatch(raw, new RegExp(secret));
  assert.doesNotMatch(raw, /synthetic customer body/u);
  assert.doesNotMatch(raw, /C:\\\\Users/u);
  assert.match(raw, /customer\.xlsx/u);
  assert.match(raw, /run-safe-id/u);
  assert.match(raw, /redacted/u);
});

test('startup recovery closes interrupted starts and retention deletes expired terminal rows', (t) => {
  const { database } = fixture(t);
  const started = new Date(Date.now() - 60_000).toISOString();
  database.db.prepare(`
    INSERT INTO interaction_logs(event_id,interaction_id,trace_id,parent_id,timestamp,completed_at,duration_ms,
      plane,component,surface,action,phase,severity,error_code,failure_point,message,details_json,
      run_id,command_id,request_id,operation_id)
    VALUES('event-old','interaction-old','interaction-old','',?,'',0,'core','test','test','old','start','info','','','','{}','','','','')
  `).run(started);
  const logger = new InteractionLogService(database.db);
  const recovered = database.db.prepare("SELECT phase,error_code,failure_point FROM interaction_logs WHERE interaction_id='interaction-old'").get() as any;
  assert.equal(recovered.phase, 'failure');
  assert.equal(recovered.error_code, 'APP.PROCESS_INTERRUPTED');
  assert.equal(recovered.failure_point, 'core.startup_recovery');
  database.db.prepare("UPDATE interaction_logs SET timestamp='2000-01-01T00:00:00.000Z' WHERE interaction_id='interaction-old'").run();
  logger.prune();
  assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM interaction_logs WHERE interaction_id='interaction-old'").get() as any).count, 0);
});

test('settings hides the log menu but keeps the query IPC for agent-side export', () => {
  const renderer = fs.readFileSync(path.resolve(import.meta.dirname, '../src/renderer/index.tsx'), 'utf8');
  const preload = fs.readFileSync(path.resolve(import.meta.dirname, '../src/preload/index.ts'), 'utf8');
  assert.doesNotMatch(renderer, />日志<\/button>/u);
  assert.doesNotMatch(renderer, /queryInteractionLogs/u);
  assert.doesNotMatch(renderer, /getInteractionTrace/u);
  assert.match(preload, /shell:query-interaction-logs/u);
  assert.match(preload, /shell:get-interaction-trace/u);
});
