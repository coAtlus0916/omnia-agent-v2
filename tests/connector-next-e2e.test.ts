import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { ConnectorNextAgentClient } from '../src/connector-next/agent/client.js';
import { connectorNextDescriptor, connectorNextUpdaterDescriptor } from '../src/connector-next/agent/identity.js';
import { ConnectorNextLogSpool } from '../src/connector-next/agent/log-spool.js';
import { ConnectorNextAgentRuntime } from '../src/connector-next/agent/runtime.js';
import { ConnectorNextRuntimeGate } from '../src/connector-next/agent/runtime-gate.js';
import { ConnectorNextAgentStateStore } from '../src/connector-next/agent/state-store.js';
import { ConnectorNextPackOperationHost, type ConnectorNextPackOperationExecutor, type ConnectorNextPackSession } from '../src/connector-next/agent/pack-operation-host.js';
import { ConnectorOperationError } from '../src/connector/workstation-omnia-session.js';
import { connectorNextPaths } from '../src/connector-next/paths.js';
import {
  CONNECTOR_NEXT_PACKAGE_SCHEMA,
  CONNECTOR_NEXT_HEALTH_OPERATION,
  CONNECTOR_NEXT_OPERATION_EXECUTE,
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_PROTOCOL_ID,
  type ConnectorNextPackage,
  type ConnectorNextOperationEnvelope,
  type ConnectorNextTarget,
  type ConnectorNextUpdateManifestUnsigned,
  canonicalJson,
  sha256
} from '../src/connector-next/protocol.js';
import { createConnectorNextServer } from '../src/connector-next/server/server.js';
import { ConnectorNextServerStore } from '../src/connector-next/server/store.js';
import { ConnectorNextGuardian } from '../src/connector-next/updater/guardian.js';
import { manifestDigest, signConnectorNextManifest, stagePackageImmutable, writeCurrentPointerAtomic } from '../src/connector-next/updater/package.js';
import { ConnectorNextAgentProcessHost } from '../src/connector-next/updater/process-host.js';
import { ConnectorNextControlClient } from '../src/main/connector/connector-next-control-client.js';
import { ConnectorNextShellBindingStore } from '../src/main/connector/connector-next-binding-store.js';
import { ConnectorNextTransport } from '../src/main/connector/connector-next-transport.js';
import { connectorResultDigest, type ConnectorDeliveryAck } from '../src/shared/connector-delivery.js';

const target: ConnectorNextTarget = {
  agentId: 'omnia.agent.integration-01',
  deviceId: 'omnia.device.integration-01',
  connectorInstanceId: 'omnia.connector-next.instance.integration-01'
};

test('Connector Next control client rejects cleartext remote HTTP', () => {
  assert.throws(
    () => new ConnectorNextControlClient({ serverUrl: 'http://connector-next.example.test/connector-next/v3/', controlToken: 'control-token-longer-than-24-characters' }),
    /CONNECTOR_NEXT.HTTPS_REQUIRED/
  );
});

test('Connector Next server refuses a non-loopback listener without TLS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-next-tls-'));
  const store = new ConnectorNextServerStore(path.join(root, 'server.sqlite'));
  try {
    assert.throws(
      () => createConnectorNextServer({ store, controlToken: 'control-token-longer-than-24-characters', publisherKeys: {}, host: '0.0.0.0' }),
      /CONNECTOR_NEXT\.SERVER_TLS_REQUIRED/
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Connector Next closes a mutation uncertainty only from an exact durable final Core acknowledgement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-next-final-ack-'));
  const store = new ConnectorNextServerStore(path.join(root, 'server.sqlite'));
  try {
    const jobId = 'ocn3.job.11111111-1111-4111-8111-111111111111';
    const envelopeRequestId = 'ocn3.request.final-ack-proof';
    const deliveryRequestId = '22222222-2222-4222-8222-222222222222';
    const executionGeneration = 'a'.repeat(48);
    const operationDigest = `sha256:${'b'.repeat(64)}`;
    const context = {
      schemaVersion: 'omnia.connector-delivery-context/v1' as const,
      requestId: deliveryRequestId,
      featureId: 'omnia.create-associate', featureVersion: '0.2.131',
      operationId: 'omnia.create-associate.synthetic.mutation.v1', operationPackageDigest: operationDigest,
      runId: 'run-final-ack', commandId: 'command-final-ack', connectorId: target.connectorInstanceId,
      sessionGeneration: 77, purpose: 'mutation' as const
    };
    const envelope: ConnectorNextOperationEnvelope = {
      schemaVersion: 'omnia.connector-next-operation-envelope/v1', requestId: envelopeRequestId, target,
      command: 'operation.invoke', effect: 'mutation',
      packBinding: { connectorId: target.connectorInstanceId, sessionGeneration: 77, engagementId: 'engagement', authorityInstanceId: 'authority', tenantOrOrgId: 'tenant', packId: 'pack' },
      input: { schemaVersion: 'omnia.operation-invocation/v1', featureId: context.featureId, featureVersion: context.featureVersion,
        operationId: context.operationId, request: {}, operationPackageDigest: operationDigest, mutationAuthorized: true, deliveryContext: context }
    };
    const wireResponse = { schemaVersion: 'omnia.connector-ipc/v1', id: deliveryRequestId, ok: false,
      error: { code: 'CONNECTOR_NEXT.OPERATION_JOB_FAILED', message: 'synthetic pre-closure failure', retryable: false } };
    const result = { schemaVersion: 'omnia.connector-next-operation-result/v1', requestId: envelopeRequestId,
      command: envelope.command, target, descriptor: {}, completedAt: new Date().toISOString(), value: {
        schemaVersion: 'omnia.connector-next-durable-delivery/v1', ok: false, error: wireResponse.error, wireResponse,
        witness: { schemaVersion: 'omnia.connector-delivery-witness/v1', requestId: deliveryRequestId,
          resultDigest: connectorResultDigest(wireResponse), sessionGeneration: 77, executionGeneration }
      } };
    store.db.prepare(`INSERT INTO connector_next_jobs(job_id,agent_id,device_id,connector_instance_id,operation,effect,payload_json,status,result_json,created_at,deadline_at,completed_at,execution_effect) VALUES(?,?,?,?,?,'read_only',?,'succeeded',?,?,?,?, 'mutation')`)
      .run(jobId, target.agentId, target.deviceId, target.connectorInstanceId, CONNECTOR_NEXT_OPERATION_EXECUTE,
        JSON.stringify(envelope), JSON.stringify(result), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    store.db.prepare(`INSERT INTO connector_next_operation_requests(request_id,delivery_request_id,agent_id,device_id,connector_instance_id,envelope_digest,job_id,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(envelopeRequestId, deliveryRequestId, target.agentId, target.deviceId, target.connectorInstanceId,
        sha256(canonicalJson(envelope)), jobId, new Date().toISOString());

    const ack: ConnectorDeliveryAck = {
      schemaVersion: 'omnia.connector-delivery-ack/v1', ackId: '33333333-3333-4333-8333-333333333333',
      deliveredRequestId: '44444444-4444-4444-8444-444444444444', resultDigest: 'c'.repeat(64),
      connectorId: target.connectorInstanceId, sessionGeneration: 77, executionGeneration: 'd'.repeat(48),
      featureId: context.featureId, featureVersion: context.featureVersion, operationId: context.operationId,
      operationPackageDigest: operationDigest, runId: context.runId, commandId: context.commandId,
      receiptId: '55555555-5555-4555-8555-555555555555', receiptResponseDigest: 'e'.repeat(64),
      resolution: 'closed_not_applied', effectOutcome: 'not_applied',
      reconciles: { requestId: deliveryRequestId, featureId: context.featureId, featureVersion: context.featureVersion,
        operationId: context.operationId, operationPackageDigest: operationDigest, connectorId: target.connectorInstanceId,
        sessionGeneration: 77, executionGeneration }
    };
    store.db.prepare(`INSERT INTO connector_next_delivery_acks(ack_id,ack_digest,request_id,resolution,cleared_mutation_count,created_at,payload_json,reconciles_request_id) VALUES(?,?,?,?,1,?,?,?)`)
      .run(ack.ackId, sha256(canonicalJson(ack)), ack.deliveredRequestId, ack.resolution, new Date().toISOString(), JSON.stringify(ack), deliveryRequestId);
    const checker = store as unknown as { finalAckResolvesMutationJob(jobId: string, exactTarget: ConnectorNextTarget): boolean };
    assert.equal(checker.finalAckResolvesMutationJob(jobId, target), true);
    store.db.prepare(`UPDATE connector_next_delivery_acks SET payload_json=json_set(payload_json,'$.reconciles.executionGeneration',?) WHERE ack_id=?`)
      .run('f'.repeat(48), ack.ackId);
    assert.equal(checker.finalAckResolvesMutationJob(jobId, target), false, 'a mismatched source execution generation cannot clear the gate');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Omnia Connector Next test-'));
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyId = 'omnia.connector-next.test.publisher';
  const controlToken = randomBytes(32).toString('base64url');
  const store = new ConnectorNextServerStore(path.join(root, 'server', 'next-v3.sqlite'));
  const runtime = createConnectorNextServer({ store, controlToken, publisherKeys: { [keyId]: publicKey }, port: 0 });
  const address = await runtime.listen();
  const control = new ConnectorNextControlClient({ serverUrl: `${address.baseUrl}/`, controlToken });
  return { root, keyId, publicKey, privateKey, controlToken, store, runtime, control, serverUrl: `${address.baseUrl}/` };
}

test('Connector Next performs exact enrollment, durable read-only job, result and acked log query', async () => {
  const f = await fixture();
  try {
    const enrollment = await f.control.createEnrollment(target);
    const descriptor = connectorNextDescriptor(target, '0.1.0', 1, 1);
    const agent = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor });
    const enrolled = await agent.enroll(enrollment.enrollmentCode);
    const paths = connectorNextPaths({ installRoot: path.join(f.root, 'Omnia Connector Next install'), dataRoot: path.join(f.root, 'Omnia Connector Next data') });
    const logs = new ConnectorNextLogSpool(paths.logDatabase, 128 * 1024);
    const gate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
    const run = new ConnectorNextAgentRuntime({ client: agent, descriptor, logs, gate });
    logs.append('agent', 'info', 'agent.enrolled', { token: enrolled.token, agentId: target.agentId });
    const queued = await f.control.enqueueSystemHealthRead(target, { requestedBy: 'connector-next-e2e' });
    const result = await run.runOnce();
    assert.equal(result.executedJobId, queued.jobId);
    const job = await f.control.getJob(queued.jobId);
    assert.equal(job.status, 'succeeded');
    assert.equal((job.result as Record<string, unknown>).connectorInstanceId, target.connectorInstanceId);
    assert.equal(logs.stats().records, 0, 'server ACK deletes the local durable records');
    const queried = await f.control.queryLogs(target, { version: '0.1.0', generation: 1 });
    assert.ok(queried.records.some((record) => record.event === 'job.succeeded'));
    assert.ok(queried.records.every((record) => record.agent_id === target.agentId && record.device_id === target.deviceId && record.connector_instance_id === target.connectorInstanceId));
    assert.equal(JSON.stringify(queried.records).includes(enrolled.token), false, 'redaction prevents token upload');

    const crossed = connectorNextDescriptor({ ...target, connectorInstanceId: 'omnia.connector-next.instance.wrong-01' }, '0.1.0', 1, 1);
    const wrong = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor: crossed, token: enrolled.token });
    await assert.rejects(() => wrong.pollJob(), /CONNECTOR_NEXT.IDENTITY_FENCE_REJECTED/);
    gate.close();
    logs.close();
  } finally {
    await f.runtime.close();
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('Connector Next refills eight execution lanes while draining durable jobs and reattaches the same result wait after a transient connection loss', async () => {
  const f = await fixture();
  try {
    const enrollment = await f.control.createEnrollment(target);
    const descriptor = connectorNextDescriptor(target, '0.1.3', 4, 1);
    const agent = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor });
    await agent.enroll(enrollment.enrollmentCode);
    const paths = connectorNextPaths({ installRoot: path.join(f.root, 'batch-install'), dataRoot: path.join(f.root, 'batch-data') });
    const logs = new ConnectorNextLogSpool(paths.logDatabase);
    const gate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
    const runtime = new ConnectorNextAgentRuntime({ client: agent, descriptor, logs, gate });

    const queued = await Promise.all(Array.from({ length: 10 }, (_unused, index) =>
      f.control.enqueueSystemHealthRead(target, { batchIndex: index })));
    const drained = await runtime.runBatch(8);
    assert.equal(drained.executedJobIds.length, 10, 'a drain turn must refill freed lanes instead of stopping at the original eight-job claim');
    assert.deepEqual(new Set(drained.executedJobIds), new Set(queued.map((item) => item.jobId)));
    assert.equal((f.store.db.prepare(`SELECT COUNT(*) count FROM connector_next_jobs WHERE status='succeeded'`).get() as { count: number }).count, 10);

    const reconnectJob = await f.control.enqueueSystemHealthRead(target, { reconnect: true });
    let injected = false;
    const reconnectingControl = new ConnectorNextControlClient({
      serverUrl: f.serverUrl,
      controlToken: f.controlToken,
      fetchImpl: async (input, init) => {
        if (!injected && String(input).includes(`/jobs/${encodeURIComponent(reconnectJob.jobId)}`)) {
          injected = true;
          throw new TypeError('synthetic transient connection loss');
        }
        return fetch(input, init);
      }
    });
    const waiting = reconnectingControl.waitForJob(reconnectJob.jobId, 5_000);
    await runtime.runBatch(8);
    const terminal = await waiting;
    assert.equal(injected, true);
    assert.equal(terminal.status, 'succeeded');
    assert.equal((f.store.db.prepare(`SELECT COUNT(*) count FROM connector_next_jobs WHERE job_id=?`).get(reconnectJob.jobId) as { count: number }).count, 1,
      'a lost wait connection must reattach to the same durable job instead of enqueueing a replacement');

    gate.close();
    logs.close();
  } finally {
    await f.runtime.close();
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('Connector Next Pack host reconnects one explicit pre-effect authorization loss without redundant status reads', async () => {
  const descriptor = connectorNextDescriptor(target, '0.1.3', 4, 1);
  const engagementId = '11111111-1111-4111-8111-111111111111';
  const binding = {
    connectorId: target.connectorInstanceId,
    sessionGeneration: 77,
    engagementId,
    authorityInstanceId: 'https://deloitteomnia.deloitte.com.cn',
    tenantOrOrgId: 'tenant-01',
    packId: engagementId
  };
  let invokes = 0;
  let connects = 0;
  let statuses = 0;
  const session = {
    async close() {},
    async status() { statuses += 1; return { status: 'connected', connected: true, ...binding }; },
    async connect() {
      connects += 1;
      return { status: 'connected', connected: true, connectorName: 'Next', connectorVersion: '0.1.3', engagementName: 'Pack', clientName: 'Client', checkedAt: new Date().toISOString(), message: 'connected', connecting: false, ...binding };
    },
    async refresh() { statuses += 1; return { status: 'connected', connected: true, ...binding }; },
    async workspaceAuthorityRead() { return {}; },
    async registerOperation() { return {}; },
    async invokeOperation() {
      invokes += 1;
      if (invokes === 1) throw new ConnectorOperationError('CONNECTOR.AUTH_REQUIRED', 'expired before handler invocation');
      return { recovered: true };
    }
  } as unknown as ConnectorNextPackSession;
  const events: string[] = [];
  const host = new ConnectorNextPackOperationHost('unused-test-root', descriptor, fetch, (event) => events.push(event), session);
  const envelope: ConnectorNextOperationEnvelope = {
    schemaVersion: 'omnia.connector-next-operation-envelope/v1',
    requestId: 'ocn3.request.pre-effect-reconnect',
    target,
    command: 'operation.invoke',
    effect: 'read_only',
    packBinding: binding,
    input: {
      schemaVersion: 'omnia.operation-invocation/v1',
      featureId: 'omnia.create-associate',
      featureVersion: '0.2.109',
      operationId: 'omnia.create-associate.synthetic.read.v1',
      request: { connectorBinding: binding },
      operationPackageDigest: `sha256:${'a'.repeat(64)}`,
      mutationAuthorized: false
    }
  };
  assert.deepEqual(await host.execute(envelope, descriptor), { recovered: true });
  assert.equal(invokes, 2);
  assert.equal(connects, 1);
  assert.equal(statuses, 0, 'signed invoke uses its exact frozen binding and does not perform extra hierarchy/status reads around the Operation');
  assert.deepEqual(events, ['pack.reconnect.started', 'pack.reconnect.succeeded']);
  await host.close();
});

test('Connector Next transport drives durable Pack binding and Recording operation envelopes', { timeout: 20_000 }, async () => {
  const f = await fixture();
  let pump: Promise<void> | undefined;
  let stopPump = () => {};
  let logs: ConnectorNextLogSpool | undefined;
  let gate: ConnectorNextRuntimeGate | undefined;
  let transport: ConnectorNextTransport | undefined;
  try {
    const enrollment = await f.control.createEnrollment(target);
    const descriptor = connectorNextDescriptor(target, '0.1.6', 7, 1);
    const agent = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor });
    await agent.enroll(enrollment.enrollmentCode);
    const paths = connectorNextPaths({ installRoot: path.join(f.root, 'Omnia Connector Next install'), dataRoot: path.join(f.root, 'Omnia Connector Next data') });
    logs = new ConnectorNextLogSpool(paths.logDatabase);
    gate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
    const engagementId = '11111111-1111-4111-8111-111111111111';
    const binding = {
      connectorId: target.connectorInstanceId, sessionGeneration: 77, engagementId,
      authorityInstanceId: 'https://deloitteomnia.deloitte.com.cn', tenantOrOrgId: 'tenant-01', packId: engagementId
    };
    const observedCommands: string[] = [];
    const observedOperationIds: string[] = [];
    let state: 'observing' | 'paused' | 'stopped' = 'observing';
    const observationId = `observation_${'a'.repeat(32)}`;
    const streamId = `stream_${'b'.repeat(32)}`;
    const status = () => ({
      schemaVersion: 'omnia.page-observation-status/v1', observationId, streamId,
      policyId: 'omnia.page-observation.current-pack.v1', state, engagementId,
      startedAt: '2026-08-11T00:00:00.000Z', updatedAt: new Date().toISOString(),
      stoppedAt: state === 'stopped' ? '2026-08-11T00:01:00.000Z' : null,
      lastSequence: 2, eventCount: 2, omissionCount: 0, complete: state === 'stopped', terminalReason: state === 'stopped' ? 'requested' : null
    });
    const packOperations: ConnectorNextPackOperationExecutor = {
      async execute(envelope: ConnectorNextOperationEnvelope) {
        observedCommands.push(envelope.command);
        if (envelope.command.startsWith('pack.session.')) return {
          status: 'connected', connected: true, connecting: false, connectorId: binding.connectorId,
          connectorName: 'Omnia Agent Connector Next', connectorVersion: '0.1.6', sessionGeneration: binding.sessionGeneration,
          authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId,
          engagementId, engagementName: 'Exact Pack', clientName: 'Exact Client', checkedAt: new Date().toISOString(), message: 'connected'
        };
        if (envelope.command === 'operation.register') return {
          schemaVersion: 'omnia.operation-registration-result/v1', featureId: 'omnia.recording', featureVersion: '0.4.20',
          packageId: 'omnia.recording.operation', packageDigest: `sha256:${'c'.repeat(64)}`,
          operationIds: [], registrationState: 'committed', registrationToken: 'd'.repeat(64), replacedPackageDigests: []
        };
        const operationId = String(envelope.input.operationId || '');
        observedOperationIds.push(operationId);
        if (operationId === 'omnia.recording.synthetic.readback-failure.v1') throw new Error('synthetic read-back failed');
        if (operationId.endsWith('.pause.v1')) state = 'paused';
        if (operationId.endsWith('.resume.v1')) state = 'observing';
        if (operationId.endsWith('.stop.v1')) state = 'stopped';
        if (operationId.endsWith('.read-chunk.v1')) return {
          schemaVersion: 'omnia.managed-stream-chunk/v1', streamId, mediaType: 'application/x-ndjson', offset: 0,
          nextOffset: 0, availableBytes: 0, ready: true, bytesBase64: '', chunkDigest: sha256(Buffer.alloc(0)).slice(7),
          streamDigest: sha256(Buffer.alloc(0)).slice(7), eof: true
        };
        return status();
      },
      async close() {}
    };
    const runtime = new ConnectorNextAgentRuntime({
      client: agent, descriptor, logs, gate, packOperations, executionGeneration: 'a'.repeat(48)
    });
    let running = true;
    stopPump = () => { running = false; };
    pump = (async () => {
      while (running) {
        await runtime.runOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const activeTransport = new ConnectorNextTransport(() => ({ serverUrl: f.serverUrl, controlToken: f.controlToken, target }));
    transport = activeTransport;
    await activeTransport.start();
    const connected = await activeTransport.connect();
    assert.equal(connected.adapter, 'connector_next_v3');
    assert.equal(connected.connectorId, binding.connectorId);
    const packageDigestValue = `sha256:${'c'.repeat(64)}`;
    await activeTransport.registerOperation({ schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.recording', featureVersion: '0.4.20', operationPackage: {} });
    const invoke = (operationId: string, request: Record<string, unknown>) => activeTransport.invokeOperation({
      schemaVersion: 'omnia.operation-invocation/v1', featureId: 'omnia.recording', featureVersion: '0.4.20', operationId,
      request: { connectorBinding: binding, ...request }, operationPackageDigest: packageDigestValue, mutationAuthorized: false
    });
    await invoke('omnia.recording.observation.open.v1', { recordingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    await invoke('omnia.recording.observation.pause.v1', { observationId });
    await invoke('omnia.recording.observation.resume.v1', { observationId });
    await invoke('omnia.recording.observation.stop.v1', { observationId });
    const stopped = await invoke('omnia.recording.observation.status.v1', { observationId }) as Record<string, unknown>;
    assert.equal(stopped.state, 'stopped');
    const chunk = await invoke('omnia.recording.observation.read-chunk.v1', { streamId, offset: 0 }) as Record<string, unknown>;
    assert.equal(chunk.eof, true);
    const failedReadback = await activeTransport.invokeOperationWithWitness({
      schemaVersion: 'omnia.operation-invocation/v1', featureId: 'omnia.recording', featureVersion: '0.4.20',
      operationId: 'omnia.recording.synthetic.readback-failure.v1', request: { connectorBinding: binding },
      operationPackageDigest: packageDigestValue, mutationAuthorized: false,
      deliveryContext: {
        schemaVersion: 'omnia.connector-delivery-context/v1', requestId: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        featureId: 'omnia.recording', featureVersion: '0.4.20', operationId: 'omnia.recording.synthetic.readback-failure.v1',
        operationPackageDigest: packageDigestValue, runId: 'run-readback-failure', commandId: 'command-readback-failure',
        connectorId: binding.connectorId, sessionGeneration: binding.sessionGeneration, purpose: 'readback'
      }
    });
    assert.equal(failedReadback.ok, false);
    assert.equal(failedReadback.error?.code, 'CONNECTOR_NEXT.OPERATION_JOB_FAILED');
    assert.notEqual(failedReadback.error?.code, 'CONNECTOR_NEXT.MUTATION_NOT_STARTED');
    assert.deepEqual(observedOperationIds, [
      'omnia.recording.observation.open.v1', 'omnia.recording.observation.pause.v1',
      'omnia.recording.observation.resume.v1', 'omnia.recording.observation.stop.v1',
      'omnia.recording.observation.status.v1', 'omnia.recording.observation.read-chunk.v1',
      'omnia.recording.synthetic.readback-failure.v1'
    ]);
    const durable = f.store.db.prepare(`SELECT COUNT(*) count FROM connector_next_jobs WHERE operation=? AND status='succeeded'`).get(CONNECTOR_NEXT_OPERATION_EXECUTE) as { count: number };
    assert.equal(durable.count, 9);
    assert.ok(observedCommands.includes('operation.register'));
    await activeTransport.stop();
    transport = undefined;
    stopPump();
    await pump;
    pump = undefined;
    gate.close();
    gate = undefined;
    logs.close();
    logs = undefined;
  } finally {
    await transport?.stop().catch(() => undefined);
    stopPump();
    if (pump) await pump.catch(() => undefined);
    try { gate?.close(); } catch { /* already closed */ }
    try { logs?.close(); } catch { /* already closed */ }
    await f.runtime.close();
    f.store.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Shell binding keeps one stable Connector Next instance for the exact Agent and device', async () => {
  const f = await fixture();
  const bindings = new ConnectorNextShellBindingStore(path.join(f.root, 'shell', 'bindings.sqlite'));
  try {
    const created = await bindings.beginEnrollment(f.control, 'omnia.agent.binding-01', 'omnia.device.binding-01');
    assert.deepEqual(bindings.stableTarget(created.target.agentId, created.target.deviceId), created.target);
    assert.equal((await bindings.refreshEnrollment(f.control, created.target.agentId, created.target.deviceId)).enrollmentState, 'waiting');
    const descriptor = connectorNextDescriptor(created.target, '0.1.0', 1, 1);
    const agent = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor });
    await agent.enroll(created.enrollmentCode);
    const enrolled = await bindings.refreshEnrollment(f.control, created.target.agentId, created.target.deviceId);
    assert.equal(enrolled.enrollmentState, 'enrolled');
    assert.equal(enrolled.connectorInstanceId, created.target.connectorInstanceId);
  } finally {
    bindings.close();
    await f.runtime.close();
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('online upgrade promotes candidate capabilities before the new generation polls', async () => {
  const f = await fixture();
  try {
    const enrollment = await f.control.createEnrollment(target);
    const oldAgent = connectorNextDescriptor(target, '0.1.2', 3, 1);
    oldAgent.capabilities = [CONNECTOR_NEXT_HEALTH_OPERATION];
    const enrollmentClient = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor: oldAgent });
    const enrolled = await enrollmentClient.enroll(enrollment.enrollmentCode);
    const oldUpdater = connectorNextUpdaterDescriptor(target, '0.1.2', 3, 1);
    oldUpdater.capabilities = [CONNECTOR_NEXT_HEALTH_OPERATION];
    const updater = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor: oldUpdater, token: enrolled.token });
    const candidate = connectorNextDescriptor(target, '0.1.3', 4, 2);
    assert.ok(candidate.capabilities.includes(CONNECTOR_NEXT_OPERATION_EXECUTE));
    const candidateClient = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor: candidate, token: enrolled.token });
    const artifact = updateArtifact('0.1.3', 4, f.keyId, f.privateKey);
    await f.control.registerUpdateArtifact(artifact.manifest, artifact.bytes);
    const offer = await f.control.offerUpdate(target, artifact.manifest.artifactId);
    await updater.downloadUpdate(offer.offerId, artifact.manifest.artifactId);
    await updater.updateStatus(offer.offerId, 'verified');
    await updater.updateStatus(offer.offerId, 'staged');
    await candidateClient.candidateHeartbeat(offer.offerId, 'candidate');
    await updater.updateStatus(offer.offerId, 'activating');
    await updater.updateStatus(offer.offerId, 'probation');
    await candidateClient.candidateHeartbeat(offer.offerId, 'probation');
    await updater.updateStatus(offer.offerId, 'succeeded');
    const queued = await f.control.enqueueSystemHealthRead(target);
    const claimed = await candidateClient.pollJob();
    assert.equal(claimed.job?.jobId, queued.jobId);
    assert.deepEqual((f.store.db.prepare(`SELECT capabilities_json FROM connector_next_connectors WHERE connector_instance_id=?`).get(target.connectorInstanceId) as { capabilities_json: string }).capabilities_json,
      JSON.stringify(candidate.capabilities));
  } finally {
    await f.runtime.close();
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('offline spool stays bounded and uncertain mutation remains a durable upgrade blocker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Omnia Connector Next bounded-'));
  try {
    const paths = connectorNextPaths({ installRoot: path.join(root, 'Omnia Connector Next install'), dataRoot: path.join(root, 'Omnia Connector Next data') });
    const logs = new ConnectorNextLogSpool(paths.logDatabase, 64 * 1024);
    for (let index = 0; index < 300; index += 1) logs.append('protocol', 'warn', 'offline.retry', { index, message: 'x'.repeat(500) });
    assert.ok(logs.stats().bytes <= logs.stats().capacityBytes);
    assert.ok(logs.pending(500).some((record) => record.event === 'spool.capacity_eviction'));
    const gate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
    const competingGate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
    const pollLease = gate.begin('ocn3.poll.linearization-contract', 'read_only');
    competingGate.setAdmission(false);
    assert.equal(competingGate.snapshot().activeReadOnly, 1, 'poll lease is visible to updater drain after admission closes');
    gate.complete(pollLease);
    assert.throws(() => competingGate.begin('ocn3.poll.after-close', 'read_only'), /CONNECTOR_NEXT.ADMISSION_CLOSED/);
    competingGate.setAdmission(true);
    competingGate.close();
    const lease = gate.begin('ocn3.job.mutation-contract', 'mutation');
    gate.markUncertain(lease);
    assert.equal(gate.snapshot().uncertainMutation, 1);
    gate.setAdmission(false);
    assert.throws(() => gate.begin('ocn3.job.read-contract', 'read_only'), /CONNECTOR_NEXT.ADMISSION_CLOSED/);
    gate.close(); logs.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const childScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const data = process.env.OMNIA_CONNECTOR_NEXT_DATA_ROOT;
const db = new DatabaseSync(path.join(data, 'connector-next-state-v3.sqlite'));
const row = db.prepare('SELECT server_url,agent_id,device_id,connector_instance_id,token,version,sequence,generation FROM agent_identity WHERE singleton=1').get();
let token=row.token;
if(token.startsWith('dpapi-current-user:')){const script="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($value);$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))";token=cp.execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{input:token.slice('dpapi-current-user:'.length),encoding:'utf8',windowsHide:true});}
if(token.startsWith('development-aes-gcm:')){const key=fs.readFileSync(path.join(data,'connector-next-development-secret-key-v3.bin'));const e=Buffer.from(token.slice('development-aes-gcm:'.length),'base64');const d=crypto.createDecipheriv('aes-256-gcm',key,e.subarray(0,12));d.setAuthTag(e.subarray(12,28));token=Buffer.concat([d.update(e.subarray(28)),d.final()]).toString('utf8');}
const version = process.env.OMNIA_CONNECTOR_NEXT_VERSION || process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_VERSION || row.version;
const sequence = Number(process.env.OMNIA_CONNECTOR_NEXT_SEQUENCE || process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_SEQUENCE || row.sequence);
const generation = Number(process.env.OMNIA_CONNECTOR_NEXT_CANDIDATE_GENERATION || process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_GENERATION || row.generation);
const descriptor = {agentId:row.agent_id,deviceId:row.device_id,connectorInstanceId:row.connector_instance_id,productId:'com.deloitte.omnia-agent.connector-next',protocolId:'omnia.connector-next/v3',version,sequence,generation,capabilities:['connector.next.system-health.read/v1','connector.next.operation.execute/v1'],executionPrincipal:{kind:'os_user',subjectHash:crypto.createHash('sha256').update(os.userInfo().username+'\0'+os.hostname()+'\0connector-next/v3').digest('hex'),processName:'OmniaConnectorNextAgent'}};
async function heartbeat(phase, offerId) {
 const r=await fetch(new URL('agent/updates/'+encodeURIComponent(offerId)+'/candidate-heartbeat',row.server_url),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({descriptor,phase})});
 const p=await r.json(); if(!r.ok) throw new Error(p.error&&p.error.code||'heartbeat'); return p;
}
(async()=>{
 const candidate=process.argv.includes('--connector-next-candidate-health');
 const probation=process.argv.includes('--connector-next-probation-health');
 if(candidate||probation){const phase=probation?'probation':'candidate';await heartbeat(phase,process.env.OMNIA_CONNECTOR_NEXT_CANDIDATE_OFFER_ID);console.log(JSON.stringify({healthy:true,admission:'health_only',productId:descriptor.productId,protocolId:descriptor.protocolId,version,sequence,generation}));return;}
 if(process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_OFFER_ID) await heartbeat('probation',process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_OFFER_ID);
 const ready=process.env.OMNIA_CONNECTOR_NEXT_READINESS_FILE;fs.mkdirSync(path.dirname(ready),{recursive:true});const tmp=ready+'.tmp';fs.writeFileSync(tmp,JSON.stringify({ready:true,pid:process.pid,version,sequence,generation}));fs.renameSync(tmp,ready);
 let running=true;process.on('SIGTERM',()=>{running=false});process.on('SIGINT',()=>{running=false});while(running)await new Promise(r=>setTimeout(r,50));
})().catch(e=>{console.error(e.message);process.exit(1)});
`;

function updateArtifact(version: string, sequence: number, keyId: string, privateKey: string) {
  const content = Buffer.from(childScript);
  const updater = Buffer.from(`// updater runtime fixture ${version}`);
  const runtime = Buffer.from('connector-next-runtime-fixture');
  const value: ConnectorNextPackage = {
    schemaVersion: CONNECTOR_NEXT_PACKAGE_SCHEMA,
    productId: CONNECTOR_NEXT_PRODUCT_ID,
    protocolId: CONNECTOR_NEXT_PROTOCOL_ID,
    version,
    sequence,
    entrypoint: 'agent.cjs',
    updaterEntrypoint: 'updater.cjs',
    runtimeEntrypoint: 'runtime/node.exe',
    files: [
      { path: 'agent.cjs', size: content.length, digest: sha256(content), contentBase64: content.toString('base64') },
      { path: 'updater.cjs', size: updater.length, digest: sha256(updater), contentBase64: updater.toString('base64') },
      { path: 'runtime/node.exe', size: runtime.length, digest: sha256(runtime), contentBase64: runtime.toString('base64') }
    ]
  };
  const bytes = gzipSync(Buffer.from(canonicalJson(value)), { level: 9 });
  const unsigned: ConnectorNextUpdateManifestUnsigned = {
    schemaVersion: 'omnia.connector-next-update-manifest/v1', productId: CONNECTOR_NEXT_PRODUCT_ID, protocolId: CONNECTOR_NEXT_PROTOCOL_ID,
    artifactId: `omnia.connector-next.artifact.${version}`, version, sequence, minimumUpdaterVersion: '0.1.0', packageDigest: sha256(bytes), packageSize: bytes.length,
    signingKeyId: keyId, createdAt: new Date().toISOString()
  };
  return { value, bytes, manifest: signConnectorNextManifest(unsigned, privateKey) };
}

test('Updater contains a transient control-plane poll failure without stopping the active Agent host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Omnia Connector Next updater poll-'));
  const paths = connectorNextPaths({
    installRoot: path.join(root, 'Omnia Connector Next install'),
    dataRoot: path.join(root, 'Omnia Connector Next data')
  });
  const pointer = {
    schemaVersion: 'omnia.connector-next-current/v1' as const,
    slot: 'a' as const,
    relativeRoot: 'a/current',
    version: '0.1.39',
    sequence: 41,
    generation: 28,
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    updatedAt: new Date().toISOString()
  };
  writeCurrentPointerAtomic(paths.currentPointer, pointer);
  const logs = new ConnectorNextLogSpool(paths.logDatabase);
  const gate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
  let hostStops = 0;
  const descriptor = connectorNextUpdaterDescriptor(target, pointer.version, pointer.sequence, pointer.generation);
  const guardian = new ConnectorNextGuardian({
    version: pointer.version,
    client: {
      pollUpdate: async () => { throw new Error('CONNECTOR_NEXT.HTTP_503'); },
      updateStatus: async () => { throw new Error('updateStatus must not run without an offer identity'); }
    } as any,
    descriptor,
    paths,
    gate,
    logs,
    publisherKeys: {},
    processHost: {
      start: async () => undefined,
      stop: async () => { hostStops += 1; },
      isRunning: () => true
    } as any,
    persistActivatedState() { throw new Error('poll failure must not mutate active state'); }
  });
  try {
    const result = await guardian.checkOnce();
    assert.deepEqual(result, { status: 'failed', reason: 'CONNECTOR_NEXT.HTTP_503' });
    assert.equal(hostStops, 0, 'a transient update poll failure must not stop the active Agent host');
    assert.equal(logs.pending().at(-1)?.event, 'update.poll_failed');
  } finally {
    gate.close();
    logs.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server offer drives two consecutive signed online upgrades with process replacement and immutable generations', async () => {
  const f = await fixture();
  const paths = connectorNextPaths({ installRoot: path.join(f.root, 'Omnia Connector Next install'), dataRoot: path.join(f.root, 'Omnia Connector Next data') });
  let processHost: ConnectorNextAgentProcessHost | undefined;
  try {
    const enrollment = await f.control.createEnrollment(target);
    const agentDescriptor = connectorNextDescriptor(target, '0.1.0', 1, 1);
    const enrollmentClient = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor: agentDescriptor });
    const enrolled = await enrollmentClient.enroll(enrollment.enrollmentCode);
    const stateStore = new ConnectorNextAgentStateStore(paths.stateDatabase);
    const state = { ...target, serverUrl: f.serverUrl, token: enrolled.token, version: '0.1.0', sequence: 1, generation: 1 };
    stateStore.save(state);
    const initial = updateArtifact('0.1.0', 1, f.keyId, f.privateKey);
    const initialDigest = manifestDigest(initial.manifest);
    const initialRoot = stagePackageImmutable(paths.slotsRoot, 'a', initial.value, initialDigest);
    const initialPointer = { schemaVersion: 'omnia.connector-next-current/v1' as const, slot: 'a' as const, relativeRoot: path.relative(paths.slotsRoot, initialRoot).replaceAll('\\', '/'), version: '0.1.0', sequence: 1, generation: 1, manifestDigest: initialDigest, updatedAt: new Date().toISOString() };
    writeCurrentPointerAtomic(paths.currentPointer, initialPointer);
    const updaterDescriptor = connectorNextUpdaterDescriptor(target, '0.1.0', 1, 1);
    const updaterClient = new ConnectorNextAgentClient({ serverUrl: f.serverUrl, descriptor: updaterDescriptor, token: enrolled.token });
    const logs = new ConnectorNextLogSpool(paths.logDatabase);
    const gate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
    processHost = new ConnectorNextAgentProcessHost(paths, process.execPath);
    await processHost.start(initialPointer);
    const guardian = new ConnectorNextGuardian({
      version: '0.1.0', client: updaterClient, descriptor: updaterDescriptor, paths, gate, logs,
      publisherKeys: { [f.keyId]: f.publicKey }, processHost, runtimeExecutableOverride: process.execPath,
      persistActivatedState(next) { Object.assign(state, next); stateStore.save(state); }
    });

    for (const [version, sequence] of [['0.2.0', 2], ['0.3.0', 3]] as const) {
      const artifact = updateArtifact(version, sequence, f.keyId, f.privateKey);
      await f.control.registerUpdateArtifact(artifact.manifest, artifact.bytes);
      const offer = await f.control.offerUpdate(target, artifact.manifest.artifactId);
      const upgraded = await guardian.checkOnce();
      assert.equal(upgraded.status, 'updated');
      assert.equal(upgraded.offerId, offer.offerId);
      assert.equal(upgraded.pointer?.version, version);
      assert.equal(upgraded.pointer?.generation, sequence);
      assert.equal(processHost.isRunning(), true);
      const serverOffer = await f.control.getUpdateOffer(offer.offerId);
      assert.equal(serverOffer.status, 'succeeded');
      assert.ok((serverOffer.details as Record<string, unknown>).candidateHeartbeat);
      assert.ok((serverOffer.details as Record<string, unknown>).probationHeartbeat);
    }
    const generations = fs.readdirSync(paths.slotsRoot).flatMap((slot) => fs.readdirSync(path.join(paths.slotsRoot, slot)).map((generation) => `${slot}/${generation}`));
    assert.equal(generations.length, 3, 'N, N+1 and N+2 bytes remain immutable in per-slot generation roots');
    const updateLogs = await f.control.queryLogs(target);
    assert.equal(updateLogs.records.filter((record) => record.source === 'updater' && record.event === 'update.succeeded').length, 2);
    assert.equal(logs.stats().records, 0, 'server ACK removes uploaded updater logs from the local spool');
    await processHost.stop();
    gate.close(); logs.close(); stateStore.close();
  } finally {
    if (processHost?.isRunning()) await processHost.stop();
    await f.runtime.close();
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
