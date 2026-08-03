import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { CoreDatabase } from '../src/main/database.js';
import { installBuiltinFeaturePackages } from '../src/main/features/builtin-features.js';
import { FeaturePackageManager } from '../src/main/features/package-manager.js';
import { packageDigest, verifyOfficialPackage } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const repository = path.resolve(import.meta.dirname, '..');
const engagementId = '11111111-1111-4111-8111-111111111111';

test('built-in bootstrap upgrades 0.1.0 once and preserves an explicit rollback on restart', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-rollback-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, { encrypt: (value) => value, decrypt: (value) => value });
  const manager = new FeaturePackageManager(database.db, paths);
  try {
    manager.install(path.join(repository, 'feature-packages', 'recording', 'candidates', 'recording-0.1.0.ofp'));
    const upgrade = installBuiltinFeaturePackages(manager, repository, false);
    assert.equal(upgrade[0]?.action, 'installed');
    assert.equal(manager.list().find((item) => item.featureId === 'omnia.recording')?.featureVersion, '0.1.1');

    manager.rollback('omnia.recording', '0.1.0');
    const generation = manager.list().find((item) => item.featureId === 'omnia.recording')?.activationGeneration;
    const restartBootstrap = installBuiltinFeaturePackages(manager, repository, false);
    assert.equal(restartBootstrap[0]?.action, 'preserved-rollback');
    assert.equal(restartBootstrap[0]?.activeVersion, '0.1.0');
    const rolledBack = manager.list().find((item) => item.featureId === 'omnia.recording');
    assert.equal(rolledBack?.featureVersion, '0.1.0');
    assert.equal(rolledBack?.activationGeneration, generation);
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('official recording Feature is built in and actions follow real Connector state', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-feature-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, { encrypt: (value) => value, decrypt: (value) => value });
  const hostEntrypoint = path.join(temporary, 'feature-worker-host.cjs');
  await build({ entryPoints: [path.join(repository, 'src/main/features/feature-worker-host.ts')], outfile: hostEntrypoint, bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
  const installer = new FeaturePackageManager(database.db, paths);
  const installed = installBuiltinFeaturePackages(installer, repository, false);
  assert.equal(installed[0]?.featureId, 'omnia.recording');
  assert.equal(installed[0]?.targetVersion, '0.1.1');
  installer.install(path.join(repository, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.2.ofp'));
  let state: Record<string, any> = { schemaVersion: 'omnia.v5.recording-status/v1', state: 'idle', active: false, recordingId: '', message: 'idle' };
  const commands: string[] = [];
  const connector: any = {
    mode: 'remote', start: async () => undefined, stop: async () => undefined,
    unavailableSnapshot: () => ({}), load: async () => ({}), connect: async () => ({}), refresh: async () => ({}), lightRead: async () => ({}),
    registerOperation: async (input: any) => {
      const envelope = verifyOfficialPackage(input.operationPackage, 'omnia-connector-operation');
      return { schemaVersion: 'omnia.operation-registration-result/v1', featureId: input.featureId, featureVersion: input.featureVersion, packageId: envelope.packageId, packageDigest: packageDigest(envelope), operationIds: [] };
    },
    invokeOperation: async () => { throw new Error('Recording Feature must not use an arbitrary HTTP Operation.'); },
    recordingCommand: async (input: any) => {
      commands.push(input.kind);
      if (input.kind === 'start') state = { ...state, state: 'recording', active: true, recordingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', eventCount: 0, integrity: { complete: true }, message: 'recording' };
      if (input.kind === 'stop_export') state = { ...state, state: 'stopped', active: false, eventCount: 17, exportPath: 'D:\\evidence\\recording.json', message: 'stopped' };
      return structuredClone(state);
    }
  };
  const runtime = new FeaturePackageManager(database.db, paths, undefined, { connector, workerHostEntrypoint: hostEntrypoint });
  const context: any = { connection: { transport: 'remote', connected: true, connectorId: 'v5-remote-connector', sessionGeneration: 7, engagementId }, safetyLock: { enabled: false, validForCurrentConnection: true } };
  try {
    await runtime.initializeRuntime();
    runtime.select('omnia.recording');
    let snapshot = runtime.snapshot(context);
    assert.equal(snapshot.groups.filter((group) => group.id === 'other').length, 1);
    assert.equal(snapshot.groups.find((group) => group.id === 'other')?.label, '其他');
    assert.deepEqual(snapshot.navigation.filter((leaf) => leaf.parentId === 'other').map((leaf) => leaf.label).sort(), ['删除元素', '录制']);
    assert.equal(snapshot.navigation.find((leaf) => leaf.featureId === 'omnia.recording')?.availability, 'available');
    assert.equal(snapshot.navigation.find((leaf) => leaf.featureId === 'omnia.recording')?.label, '录制');
    assert.equal(snapshot.groups[0]?.id, 'other');
    assert.equal(snapshot.groups[0]?.label, '其他');
    snapshot = await runtime.action({ featureId: 'omnia.recording', featureVersion: '0.1.1', surfaceId: 'recording.workbench', actionId: 'start-recording', expectedStateVersion: 1, payload: {} }, context);
    assert.equal(snapshot.surface?.actions.find((action) => action.actionId === 'start-recording')?.enabled, false);
    assert.equal(snapshot.surface?.actions.find((action) => action.actionId === 'stop-export')?.enabled, true);
    snapshot = await runtime.action({ featureId: 'omnia.recording', featureVersion: '0.1.1', surfaceId: 'recording.workbench', actionId: 'stop-export', expectedStateVersion: snapshot.surface!.stateVersion, payload: {} }, context);
    assert.match(snapshot.surface?.items[1]?.subtitle || '', /recording\.json/);
    assert.deepEqual(commands, ['start', 'status', 'stop_export']);
  } finally {
    await runtime.disposeRuntime();
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
