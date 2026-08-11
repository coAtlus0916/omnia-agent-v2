import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createConnectorNextServer } from '../src/connector-next/server/server.js';
import { ConnectorNextServerStore } from '../src/connector-next/server/store.js';
import { ConnectorNextControlClient } from '../src/main/connector/connector-next-control-client.js';
import {
  CONNECTOR_NEXT_PACKAGE_SCHEMA,
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_PROTOCOL_ID,
  canonicalJson,
  sha256,
  type ConnectorNextPackage,
  type ConnectorNextTarget,
  type ConnectorNextUpdateManifestUnsigned
} from '../src/connector-next/protocol.js';
import { connectorNextPaths } from '../src/connector-next/paths.js';
import { signConnectorNextManifest } from '../src/connector-next/updater/package.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const candidateRoot = path.join(repositoryRoot, 'connector-next', 'candidates', '0.1.2-3');
const candidateAvailable = fs.existsSync(path.join(candidateRoot, 'connector-next-package.ocn3'));

function capture(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${message}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

function createOnlineArtifact(version: string, sequence: number, privateKey: string) {
  const inputs = [
    ['agent.cjs', fs.readFileSync(path.join(repositoryRoot, 'dist', 'connector-next', 'agent.cjs'))],
    ['updater.cjs', fs.readFileSync(path.join(repositoryRoot, 'dist', 'connector-next', 'updater.cjs'))],
    ['runtime/node.exe', fs.readFileSync(process.execPath)]
  ] as const;
  const value: ConnectorNextPackage = {
    schemaVersion: CONNECTOR_NEXT_PACKAGE_SCHEMA,
    productId: CONNECTOR_NEXT_PRODUCT_ID,
    protocolId: CONNECTOR_NEXT_PROTOCOL_ID,
    version,
    sequence,
    entrypoint: 'agent.cjs',
    updaterEntrypoint: 'updater.cjs',
    runtimeEntrypoint: 'runtime/node.exe',
    files: inputs.map(([memberPath, bytes]) => ({ path: memberPath, size: bytes.length, digest: sha256(bytes), contentBase64: bytes.toString('base64') }))
  };
  const bytes = gzipSync(Buffer.from(canonicalJson(value)), { level: 9 });
  const unsigned: ConnectorNextUpdateManifestUnsigned = {
    schemaVersion: 'omnia.connector-next-update-manifest/v1',
    productId: CONNECTOR_NEXT_PRODUCT_ID,
    protocolId: CONNECTOR_NEXT_PROTOCOL_ID,
    artifactId: `omnia.connector-next.artifact.${version}.${sequence}`,
    version,
    sequence,
    minimumUpdaterVersion: '0.1.0',
    packageDigest: sha256(bytes),
    packageSize: bytes.length,
    signingKeyId: 'omnia.connector-next.publisher.2026-01',
    createdAt: new Date().toISOString()
  };
  return { bytes, manifest: signConnectorNextManifest(unsigned, privateKey) };
}

test('frozen Connector Next candidate installs, enrolls and starts its self-contained Bootstrap/Updater/Agent chain', { skip: !candidateAvailable, timeout: 180_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-next-candidate-'));
  const store = new ConnectorNextServerStore(path.join(root, 'server', 'server.sqlite'));
  const controlToken = 'candidate-control-token-longer-than-24-characters';
  const publicKey = fs.readFileSync(path.join(candidateRoot, 'publisher-public-key.pem'), 'utf8');
  const server = createConnectorNextServer({ store, controlToken, publisherKeys: { 'omnia.connector-next.publisher.2026-01': publicKey }, port: 0 });
  let bootstrap: ChildProcess | null = null;
  let stage = 'server.listen';
  let completed = false;
  try {
    const address = await server.listen();
    const control = new ConnectorNextControlClient({ serverUrl: `${address.baseUrl}/`, controlToken });
    const target: ConnectorNextTarget = {
      agentId: 'omnia.agent.candidate-smoke',
      deviceId: 'omnia.device.candidate-smoke',
      connectorInstanceId: 'omnia.connector-next.instance.candidate-smoke'
    };
    stage = 'enrollment.create';
    const enrollment = await control.createEnrollment(target);
    const installRoot = path.join(root, 'Omnia Connector Next install');
    const dataRoot = path.join(root, 'Omnia Connector Next data');
    const installer = spawn(path.join(candidateRoot, 'runtime', 'node.exe'), [
      path.join(candidateRoot, 'connector-next-installer.cjs'),
      '--install-root', installRoot,
      '--data-root', dataRoot,
      '--manifest', path.join(candidateRoot, 'connector-next-manifest.json'),
      '--package', path.join(candidateRoot, 'connector-next-package.ocn3'),
      '--publisher-public-key', path.join(candidateRoot, 'publisher-public-key.pem'),
      '--bootstrap', path.join(candidateRoot, 'connector-next-bootstrap.cjs'),
      '--server-url', `${address.baseUrl}/`,
      '--enrollment-code', enrollment.enrollmentCode,
      '--target-json', JSON.stringify(target),
      '--register-startup', 'false',
      '--start', 'false'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    stage = 'installer.run';
    const installed = await capture(installer);
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).enrolled, true);

    const paths = connectorNextPaths({ installRoot, dataRoot });
    bootstrap = spawn(path.join(installRoot, 'bootstrap-v3', 'node.exe'), [path.join(installRoot, 'bootstrap-v3', 'connector-next-bootstrap.cjs')], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', OMNIA_CONNECTOR_NEXT_INSTALL_ROOT: installRoot, OMNIA_CONNECTOR_NEXT_DATA_ROOT: dataRoot }
    });
    stage = 'process_chain.ready';
    await waitUntil(() => fs.existsSync(paths.bootstrapLock) && fs.existsSync(paths.updaterLock) && fs.existsSync(paths.agentLock), 30_000, 'installed process chain did not become ready');
    stage = 'health_job.enqueue';
    const queued = await control.enqueueSystemHealthRead(target, { smoke: 'frozen-candidate' });
    stage = 'health_job.wait';
    await waitUntil(async () => (await control.getJob(queued.jobId)).status === 'succeeded', 30_000, 'installed Agent did not complete real system health job');
    stage = 'initial_logs.wait';
    await waitUntil(async () => {
      const events = new Set((await control.queryLogs(target)).records.map((record) => record.event));
      return ['installer.enrolled', 'bootstrap.runtime_started', 'updater.started', 'agent.started', 'job.succeeded'].every((event) => events.has(event));
    }, 30_000, 'not all installed process logs reached the server');

    const privateKeyFile = process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_PRIVATE_KEY_FILE || '';
    if (privateKeyFile) {
      const update = createOnlineArtifact('0.1.3', 4, fs.readFileSync(privateKeyFile, 'utf8'));
      stage = 'update.register';
      await control.registerUpdateArtifact(update.manifest, update.bytes);
      stage = 'update.offer';
      const offered = await control.offerUpdate(target, update.manifest.artifactId);
      stage = 'update.succeeded.wait';
      try {
        await waitUntil(async () => (await control.getUpdateOffer(offered.offerId)).status === 'succeeded', 90_000, 'installed Updater did not complete online update');
      } catch (error) {
        const observed = await control.getUpdateOffer(offered.offerId);
        const recentLogs = await control.queryLogs(target, { limit: 500 });
        throw new Error(`${error instanceof Error ? error.message : String(error)}; offer=${JSON.stringify(observed)}; recentEvents=${JSON.stringify(recentLogs.records.slice(-30).map((record) => ({ source: record.source, event: record.event, details: record.details })))}`);
      }
      stage = 'updated_runtime_logs.wait';
      try {
        await waitUntil(async () => {
          const records = (await control.queryLogs(target, { limit: 500 })).records;
          return records.some((record) => record.event === 'bootstrap.runtime_started' && (record.details as Record<string, unknown>).version === '0.1.3')
            && records.some((record) => record.event === 'updater.started' && (record.details as Record<string, unknown>).version === '0.1.3');
        }, 30_000, 'Bootstrap did not switch to the updated Updater Runtime');
      } catch (error) {
        const records = (await control.queryLogs(target, { limit: 500 })).records;
        const files = [paths.currentPointer, paths.bootstrapLock, paths.updaterLock, paths.agentLock, paths.stateDatabase]
          .map((filename) => ({ filename, exists: fs.existsSync(filename), text: fs.existsSync(filename) && !filename.endsWith('.sqlite') ? fs.readFileSync(filename, 'utf8') : '' }));
        throw new Error(`${error instanceof Error ? error.message : String(error)}; root=${root}; files=${JSON.stringify(files)}; events=${JSON.stringify(records.slice(-50).map((record) => ({ source: record.source, event: record.event, version: record.version, generation: record.generation, details: record.details })))}`);
      }
      const pointer = JSON.parse(fs.readFileSync(paths.currentPointer, 'utf8')) as { version?: string; sequence?: number; generation?: number };
      assert.deepEqual({ version: pointer.version, sequence: pointer.sequence, generation: pointer.generation }, { version: '0.1.3', sequence: 4, generation: 2 });
      stage = 'post_update_job.enqueue';
      const postUpdateJob = await control.enqueueSystemHealthRead(target, { smoke: 'post-online-update' });
      stage = 'post_update_job.wait';
      await waitUntil(async () => (await control.getJob(postUpdateJob.jobId)).status === 'succeeded', 30_000, 'updated Agent did not accept a post-update health job');
    }
    completed = true;
  } catch (error) {
    throw new Error(`Connector Next candidate smoke failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (bootstrap && bootstrap.exitCode === null) {
      bootstrap.kill('SIGTERM');
      await Promise.race([capture(bootstrap), delay(20_000)]);
    }
    await server.close();
    store.close();
    if (completed) fs.rmSync(root, { recursive: true, force: true });
  }
});
