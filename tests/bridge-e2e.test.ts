import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBridgeServer } from '../src/bridge/server.ts';
import { BRIDGE_SCHEMA, type BridgeEnvelope } from '../src/shared/bridge-contracts.ts';
import {
  pairWaitingConnector,
  pairWithBridge,
  RemoteConnectorTransport
} from '../src/main/connector/remote-connector-transport.ts';
import {
  pollWaitingConnector,
  pairRemoteConnector,
  readStoredBridgeCredential,
  registerWaitingConnector
} from '../src/remote-connector/bridge-credential.ts';

test('Start waiting lease and Agent discovery session pair without an administrator bundle', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-discovery-pair-'));
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port: 0,
    pairingCode: '',
    adminToken: 'discovery-admin-token-with-twenty-characters',
    tokenSecret: 'discovery-token-secret-with-thirty-two-characters'
  });
  const address = await bridge.listen();
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  t.after(async () => {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });

  const lease = await registerWaitingConnector({ dataRoot: root, bridgeUrl: baseUrl });
  const shell = await pairWaitingConnector({ bridgeUrl: baseUrl });
  assert.equal(shell.connectorId, lease.connectorId);
  assert.match(shell.confirmationCode, /^\d{6}$/);
  assert.equal(await pollWaitingConnector({ dataRoot: root, lease }), 'matched');
  const stored = readStoredBridgeCredential(root);
  assert.equal(stored?.pairId, shell.pairId);

  const connector = new WebSocket(`ws://127.0.0.1:${address.port}/v1/connect`, {
    headers: { Authorization: `Bearer ${stored!.token}` }
  });
  await once(connector, 'open');
  t.after(() => connector.close());
  let cancelSeen = false;
  connector.on('message', (data) => {
    const envelope = JSON.parse(data.toString()) as BridgeEnvelope;
    if (envelope.kind === 'cancel') {
      cancelSeen = true;
      return;
    }
    if (envelope.kind !== 'command') return;
    const sendResult = () => connector.send(JSON.stringify({
      schemaVersion: BRIDGE_SCHEMA,
      kind: 'result',
      response: {
        schemaVersion: 'omnia.connector-ipc/v1',
        id: envelope.request.id,
        ok: true,
        value: envelope.request.operation === 'operation_register'
          ? {
              schemaVersion: 'omnia.operation-registration-result/v1',
              featureId: 'official.feature',
              featureVersion: '1.0.0',
              packageId: 'official.package',
              packageDigest: 'sha256:fixture',
              operationIds: ['official.read']
            }
          : { ready: true }
      }
    }));
    if (envelope.request.operation === 'health') setTimeout(sendResult, 100);
    else sendResult();
  });
  const config = () => ({ bridgeUrl: baseUrl, pairId: shell.pairId, token: shell.token });
  const transport = new RemoteConnectorTransport(config);
  t.after(() => transport.stop());
  await assert.rejects(
    () => (transport as any).call('health', {}, 25),
    (error: any) => error.code === 'REMOTE.TIMEOUT'
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cancelSeen, true);
  const registered = await transport.registerOperation({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'official.feature',
    featureVersion: '1.0.0',
    operationPackage: {}
  });
  assert.deepEqual(registered.operationIds, ['official.read']);

  await transport.stop();
  const reconnected = new RemoteConnectorTransport(config);
  t.after(() => reconnected.stop());
  assert.deepEqual(await reconnected.registerOperation({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'official.feature',
    featureVersion: '1.0.0',
    operationPackage: {}
  }), registered);
});

test('discovery fails closed on multiple candidates and binds only the selected v5 device', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-candidate-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-candidate-b-'));
  const bridge = createBridgeServer({
    host: '127.0.0.1', port: 0, pairingCode: '',
    adminToken: 'candidate-admin-token-with-twenty-characters',
    tokenSecret: 'candidate-token-secret-with-thirty-two-characters'
  });
  const address = await bridge.listen();
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  t.after(async () => {
    await bridge.close();
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const [a, b] = await Promise.all([
    registerWaitingConnector({ dataRoot: rootA, bridgeUrl: baseUrl }),
    registerWaitingConnector({ dataRoot: rootB, bridgeUrl: baseUrl })
  ]);
  await assert.rejects(
    () => pairWaitingConnector({ bridgeUrl: baseUrl }),
    (error: any) => error.code === 'REMOTE.MULTIPLE_WAITING_CONNECTORS'
      && error.message.includes(a.connectorId)
      && error.message.includes(b.connectorId)
  );
  const selected = await pairWaitingConnector({ bridgeUrl: baseUrl, connectorId: b.connectorId });
  assert.equal(selected.connectorId, b.connectorId);
  assert.equal(await pollWaitingConnector({ dataRoot: rootA, lease: a }), 'waiting');
  assert.equal(await pollWaitingConnector({ dataRoot: rootB, lease: b }), 'matched');
});

test('Bridge uses one-time role-bound pairing and routes the real Connector contract', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const adminToken = 'admin-token-with-at-least-twenty-characters';
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port: 0,
    pairingCode: '',
    adminToken,
    tokenSecret: 'token-secret-with-at-least-thirty-two-characters'
  });
  const address = await bridge.listen();
  t.after(() => bridge.close());
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const bundleResponse = await fetch(`${baseUrl}v1/admin/pairing-bundles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(bundleResponse.status, 201);
  const bundle = await bundleResponse.json() as any;
  assert.match(bundle.pairId, /^pair-/);

  await assert.rejects(
    () => pairWithBridge({
      bridgeUrl: baseUrl,
      pairingCode: bundle.connectorCode,
      role: 'shell',
      name: 'wrong role'
    }),
    (error: any) => error.code === 'REMOTE.PAIRING_FAILED'
  );
  const shellIdentity = await pairWithBridge({
    bridgeUrl: baseUrl,
    pairingCode: bundle.shellCode,
    role: 'shell',
    name: 'test shell'
  });
  assert.equal(shellIdentity.pairId, bundle.pairId);
  await assert.rejects(
    () => pairWithBridge({
      bridgeUrl: baseUrl,
      pairingCode: bundle.shellCode,
      role: 'shell',
      name: 'replay'
    }),
    (error: any) => error.code === 'REMOTE.PAIRING_FAILED'
  );
  const connectorIdentity = await pairWithBridge({
    bridgeUrl: baseUrl,
    pairingCode: bundle.connectorCode,
    role: 'connector',
    name: 'test connector'
  });
  const connector = new WebSocket(`ws://127.0.0.1:${address.port}/v1/connect`, {
    headers: { Authorization: `Bearer ${connectorIdentity.token}` }
  });
  await once(connector, 'open');
  connector.on('message', (data) => {
    const envelope = JSON.parse(data.toString()) as BridgeEnvelope;
    if (envelope.schemaVersion !== BRIDGE_SCHEMA || envelope.kind !== 'command') return;
    connector.send(JSON.stringify({
      schemaVersion: BRIDGE_SCHEMA,
      kind: 'result',
      response: {
        schemaVersion: 'omnia.connector-ipc/v1',
        id: envelope.request.id,
        ok: true,
        value: {
          status: 'connected',
          connected: true,
          connecting: false,
          connectorId: 'e2e-connector',
          connectorName: 'v5 E2E Remote Connector',
          connectorVersion: '0.1.0',
          engagementId: '11111111-1111-1111-1111-111111111111',
          engagementName: 'E2E Pack',
          clientName: 'E2E',
          checkedAt: new Date().toISOString(),
          message: '真实 Bridge 合同已连通。'
        }
      }
    }));
  });
  const transport = new RemoteConnectorTransport(() => ({
    bridgeUrl: baseUrl,
    pairId: shellIdentity.pairId,
    token: shellIdentity.token
  }));
  t.after(() => transport.stop());
  const snapshot = await transport.load();
  assert.equal(snapshot.transport, 'remote');
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.connectorId, 'e2e-connector');

  connector.close();
  await once(connector, 'close');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    () => transport.refresh(),
    (error: any) => error.code === 'REMOTE.CONNECTOR_OFFLINE'
  );
});

test('Remote Connector restarts from DPAPI persisted pairing without pairing environment variables', async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-persisted-pair-'));
  const adminToken = 'admin-token-with-at-least-twenty-characters';
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port: 0,
    pairingCode: '',
    adminToken,
    tokenSecret: 'token-secret-with-at-least-thirty-two-characters'
  });
  const address = await bridge.listen();
  t.after(async () => {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const bundleResponse = await fetch(`${baseUrl}v1/admin/pairing-bundles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const bundle = await bundleResponse.json() as any;
  const paired = await pairRemoteConnector({
    dataRoot: root,
    bridgeUrl: baseUrl,
    pairingCode: bundle.connectorCode,
    name: 'persisted connector'
  });
  assert.equal(paired.pairId, bundle.pairId);
  const storedBytes = fs.readFileSync(path.join(root, 'bridge-credential.json'), 'utf8');
  assert.match(storedBytes, /dpapi:v1:/);
  assert.equal(storedBytes.includes(bundle.connectorCode), false);

  delete process.env.OMNIA_V5_REMOTE_BRIDGE_PAIRING_CODE;
  delete process.env.OMNIA_V5_REMOTE_BRIDGE_TOKEN;
  delete process.env.OMNIA_V5_REMOTE_PAIR_ID;
  delete process.env.OMNIA_V5_REMOTE_BRIDGE_URL;
  const restarted = readStoredBridgeCredential(root);
  assert.equal(restarted?.bridgeUrl, baseUrl);
  assert.equal(restarted?.pairId, bundle.pairId);
  assert.ok(restarted?.token);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/connect`, {
    headers: { Authorization: `Bearer ${restarted!.token}` }
  });
  await once(socket, 'open');
  socket.close();
  await once(socket, 'close');
});
