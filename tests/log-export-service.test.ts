import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { createTestContentCipher } from '../src/main/content-cipher.ts';
import { CoreDatabase } from '../src/main/database.ts';
import { resolveProductPaths } from '../src/main/paths.ts';
import { InteractionLogService } from '../src/main/services/interaction-log-service.ts';
import { LogExportService, _test } from '../src/main/services/log-export-service.ts';

function unzip(bytes: Buffer): Map<string, Buffer> {
  const endSignature = 0x06054b50;
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === endSignature) { end = offset; break; }
  }
  if (end < 0) throw new Error('ZIP end record is missing.');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const result = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(payloadStart, payloadStart + compressedSize);
    result.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

test('today log export packages real redacted sources, plan identities and a downloadable integrity-checked ZIP', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-log-export-'));
  const paths = resolveProductPaths(root);
  const database = new CoreDatabase(paths.database, createTestContentCipher());
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const interactions = new InteractionLogService(database.db);
  await interactions.run({
    plane: 'core', component: 'log-export-fixture', surface: 'settings.logs', action: 'fixture',
    failurePoint: 'test.fixture', details: { sessionGeneration: 17, featureId: 'omnia.workpaper-preparation' }
  }, async () => undefined);

  const featureRoot = path.join(paths.data, 'features', 'omnia.workpaper-preparation');
  fs.mkdirSync(featureRoot, { recursive: true });
  const featureStore = new DatabaseSync(path.join(featureRoot, 'store.sqlite'));
  featureStore.exec(`CREATE TABLE "__runtime_plans"(plan_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  featureStore.prepare(`INSERT INTO "__runtime_plans"(plan_id,payload_json,updated_at) VALUES(?,?,?)`).run(
    'workpaper:current',
    JSON.stringify({
      schemaVersion: 'omnia.workpaper-plan/v1', planId: 'workpaper:current', stage: 'upload',
      binding: { connectorId: 'connector-fixture', sessionGeneration: 17, engagementId: 'engagement-fixture', packId: 'pack-fixture' },
      businessContent: 'THIS_CUSTOMER_TEXT_MUST_NOT_BE_EXPORTED'
    }),
    new Date().toISOString()
  );
  featureStore.close();

  let clock = new Date();
  const range = _test.localDay(clock);
  const midpoint = new Date((Date.parse(range.since) + Date.parse(range.until)) / 2);
  const previous = new Date(Date.parse(range.since) - 60_000).toISOString();
  const connectorLogRoot = path.join(root, 'connector-next-data-v3', 'logs');
  fs.mkdirSync(connectorLogRoot, { recursive: true });
  const processLog = path.join(connectorLogRoot, 'embedded-host.log');
  fs.writeFileSync(processLog, [
    JSON.stringify({ occurredAt: previous, event: 'old.event' }),
    JSON.stringify({ occurredAt: midpoint.toISOString(), event: 'agent.spawned', pid: 321 })
  ].join('\n') + '\n');
  fs.utimesSync(processLog, midpoint, midpoint);

  const connector = {
    readDiagnosticLogs: async () => ({
      records: [{ server_log_id: 9, occurred_at: midpoint.toISOString(), source: 'agent', event: 'agent.started', details: { generation: 4 } }],
      scannedRecords: 1,
      truncated: false
    }),
    diagnosticContext: () => ({ endpointKind: 'loopback' })
  } as any;
  const service = new LogExportService(database, paths, interactions, connector, () => clock);
  const first = await service.generateToday({
    shellVersion: '0.5.0',
    connection: { connectorId: 'connector-fixture', sessionGeneration: 17 },
    connector: { endpointKind: 'loopback' },
    features: [{ featureId: 'omnia.workpaper-preparation', featureVersion: '0.1.83' }]
  });
  assert.equal(first.available, true);
  assert.equal(first.state, 'ready');
  assert.equal(first.warnings.length, 0);
  const downloadable = service.download(first.exportId);
  const archive = fs.readFileSync(downloadable.source);
  assert.equal(archive.length, first.size);
  assert.equal(downloadable.suggestedName, first.fileName);

  const files = unzip(archive);
  for (const required of [
    'manifest.json', 'shell/interaction-logs.jsonl', 'shell/feature-plan-identities.jsonl',
    'connector-next/operational-logs.jsonl', 'local/connector-next-process-logs/embedded-host.log',
    'diagnostics/runtime-context.json'
  ]) assert.ok(files.has(required), `${required} is missing`);
  const plans = files.get('shell/feature-plan-identities.jsonl')!.toString('utf8');
  assert.match(plans, /"sessionGeneration":17/u);
  assert.doesNotMatch(plans, /THIS_CUSTOMER_TEXT_MUST_NOT_BE_EXPORTED/u);
  const localLog = files.get('local/connector-next-process-logs/embedded-host.log')!.toString('utf8');
  assert.match(localLog, /agent\.spawned/u);
  assert.doesNotMatch(localLog, /old\.event/u);
  const context = JSON.parse(files.get('diagnostics/runtime-context.json')!.toString('utf8')) as any;
  assert.equal(context.connector.endpointKind, 'loopback');
  assert.equal(context.connection.sessionGeneration, 17);

  const restored = new LogExportService(database, paths, interactions, connector, () => clock);
  assert.equal(restored.snapshot().exportId, first.exportId, 'latest managed export must survive a Shell restart');
  assert.doesNotThrow(() => restored.download(first.exportId));

  clock = new Date(clock.getTime() + 1_000);
  const second = await service.generateToday({
    shellVersion: '0.5.0', connection: {}, connector: { endpointKind: 'loopback' }, features: []
  });
  assert.notEqual(second.exportId, first.exportId);
  assert.equal(fs.existsSync(downloadable.source), false, 'regeneration must replace the previous managed export');
  assert.throws(() => service.download(first.exportId), /重新生成/u);
  assert.doesNotThrow(() => service.download(second.exportId));
});

test('log export remains downloadable and explicitly reports partial Connector collection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-log-export-partial-'));
  const paths = resolveProductPaths(root);
  const database = new CoreDatabase(paths.database, createTestContentCipher());
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const interactions = new InteractionLogService(database.db);
  const connector = { readDiagnosticLogs: async () => { throw new Error('CONNECTOR_NEXT.HTTP_503'); } } as any;
  const service = new LogExportService(database, paths, interactions, connector);
  const generated = await service.generateToday({ shellVersion: '0.5.0', connection: {}, connector: null, features: [] });
  assert.equal(generated.state, 'partial');
  assert.equal(generated.available, true);
  assert.match(generated.warnings.join('\n'), /HTTP_503/u);
  assert.doesNotThrow(() => service.download(generated.exportId));
});
