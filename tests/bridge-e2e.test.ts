import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBridgeServer, _test as bridgeTest } from '../src/bridge/server.ts';
import { BridgeBindingStore } from '../src/bridge/binding-store.ts';
import { BRIDGE_PROTOCOL, BRIDGE_SCHEMA, type BridgeEnvelope } from '../src/shared/bridge-contracts.ts';
import {
  beginPairingSession,
  cancelPairingSession,
  commitPairingSession,
  pollPairingSession,
  RemoteConnectorTransport
} from '../src/main/connector/remote-connector-transport.ts';
import {
  pairRemoteConnector,
  readCandidateBridgeCredential
} from '../src/remote-connector/bridge-credential.ts';

const secret = 'remote-only-bridge-test-secret-at-least-32-bytes';

test('Bridge compatibility accepts only supported 0.3.x Remote Connector patches', () => {
  assert.equal(bridgeTest.connectorVersionCompatible('0.3.4'), true);
  assert.equal(bridgeTest.connectorVersionCompatible('0.3.5'), true);
  assert.equal(bridgeTest.connectorVersionCompatible('0.3.3'), false);
  assert.equal(bridgeTest.connectorVersionCompatible('0.4.0'), false);
  assert.equal(bridgeTest.connectorVersionCompatible('malformed'), false);
});

test('expired candidate cannot activate after consuming its one-time link code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-expired-candidate-'));
  const filename = path.join(root, 'bindings.json');
  try {
    const store = new BridgeBindingStore(filename);
    const session = store.createSession();
    const candidate = store.consumeCode({
      pairingCode: session.pairingCode, connectorId: 'v5-connector-expired', connectorName: 'Expired',
      connectorVersion: '0.3.5', platform: 'win32-x64', protocol: BRIDGE_PROTOCOL
    });
    const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
    document.bindings[0].activationExpiresAt = new Date(Date.now() - 1_000).toISOString();
    fs.writeFileSync(filename, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const reloaded = new BridgeBindingStore(filename);
    assert.equal(reloaded.activate(candidate.pairId), null);
    assert.equal(reloaded.binding(candidate.pairId)?.lifecycle, 'revoked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only one concurrent replacement candidate can CAS-activate the same old generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-concurrent-replacement-'));
  const filename = path.join(root, 'bindings.json');
  try {
    const store = new BridgeBindingStore(filename);
    const firstSession = store.createSession();
    const first = store.consumeCode({
      pairingCode: firstSession.pairingCode, connectorId: 'v5-connector-first', connectorName: 'First',
      connectorVersion: '0.3.5', platform: 'win32-x64', protocol: BRIDGE_PROTOCOL
    });
    assert.equal(store.activate(first.pairId)?.lifecycle, 'active');
    const leftSession = store.createSession(first.pairId);
    const rightSession = store.createSession(first.pairId);
    const left = store.consumeCode({
      pairingCode: leftSession.pairingCode, connectorId: 'v5-connector-left', connectorName: 'Left',
      connectorVersion: '0.3.5', platform: 'win32-x64', protocol: BRIDGE_PROTOCOL
    });
    const right = store.consumeCode({
      pairingCode: rightSession.pairingCode, connectorId: 'v5-connector-right', connectorName: 'Right',
      connectorVersion: '0.3.5', platform: 'win32-x64', protocol: BRIDGE_PROTOCOL
    });
    assert.equal(store.activate(left.pairId)?.lifecycle, 'active');
    assert.equal(store.activate(right.pairId), null);
    assert.equal(store.binding(right.pairId)?.lifecycle, 'revoked');
    const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(document.bindings.filter((binding: any) => binding.lifecycle === 'active').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ready candidate survives link-code expiry and prune until recovery commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-ready-recovery-'));
  const filename = path.join(root, 'bindings.json');
  try {
    let store = new BridgeBindingStore(filename);
    const session = store.createSession();
    const candidate = store.consumeCode({
      pairingCode: session.pairingCode, connectorId: 'v5-connector-ready', connectorName: 'Ready',
      connectorVersion: '0.3.5', platform: 'win32-x64', protocol: BRIDGE_PROTOCOL
    });
    assert.equal(store.markReady(candidate.pairId)?.lifecycle, 'candidate');
    const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
    document.sessions[0].expiresAt = new Date(Date.now() - 60_000).toISOString();
    document.bindings[0].activationExpiresAt = document.sessions[0].expiresAt;
    document.bindings[0].recoveryExpiresAt = new Date(Date.now() + 60_000).toISOString();
    fs.writeFileSync(filename, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    store = new BridgeBindingStore(filename);
    store.createSession();
    assert.equal(store.session(session.sessionId, session.pollSecret)?.state, 'candidate');
    assert.equal(store.commitSession(session.sessionId, session.pollSecret)?.lifecycle, 'active');
    assert.equal(store.session(session.sessionId, session.pollSecret)?.state, 'matched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Bridge restart and candidate reconnect after code expiry preserve the recovery commit window', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-ready-bridge-restart-'));
  const statePath = path.join(root, 'bindings.json');
  let bridge = createBridgeServer({ host: '127.0.0.1', port: 0, tokenSecret: secret, statePath });
  try {
    let address = await bridge.listen();
    let baseUrl = `http://127.0.0.1:${address.port}/`;
    const session = await beginPairingSession({ bridgeUrl: baseUrl });
    const dataRoot = path.join(root, 'connector');
    await pairRemoteConnector({ dataRoot, bridgeUrl: baseUrl, pairingCode: session.pairingCode, name: 'Recovery workstation' });
    const credential = readCandidateBridgeCredential(dataRoot)!;
    const device = JSON.parse(fs.readFileSync(path.join(dataRoot, 'device-identity.json'), 'utf8'));
    const firstSocket = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
      Authorization: `Bearer ${credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
      'X-Omnia-Connector-Id': device.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
    }});
    await once(firstSocket, 'open');
    assert.equal((await pollPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret })).state, 'candidate');
    await bridge.close();

    const document = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    document.sessions[0].expiresAt = new Date(Date.now() - 60_000).toISOString();
    document.bindings[0].activationExpiresAt = document.sessions[0].expiresAt;
    document.bindings[0].recoveryExpiresAt = new Date(Date.now() + 60_000).toISOString();
    fs.writeFileSync(statePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    bridge = createBridgeServer({ host: '127.0.0.1', port: 0, tokenSecret: secret, statePath });
    address = await bridge.listen();
    baseUrl = `http://127.0.0.1:${address.port}/`;
    const reconnected = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
      Authorization: `Bearer ${credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
      'X-Omnia-Connector-Id': device.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
    }});
    await once(reconnected, 'open');
    assert.equal((await pollPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret })).state, 'candidate');
    await commitPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret });
    assert.equal((await pollPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret })).state, 'matched');
    reconnected.close();
  } finally {
    await bridge.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

async function fixture(t: test.TestContext, timing: { heartbeatIntervalMs?: number; staleSocketTimeoutMs?: number } = {}) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-link-code-'));
  const statePath = path.join(root, 'bridge-bindings.json');
  const bridge = createBridgeServer({ host: '127.0.0.1', port: 0, tokenSecret: secret, statePath, ...timing });
  const address = await bridge.listen();
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  t.after(async () => {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  return { root, statePath, bridge, baseUrl };
}

test('heartbeat removes a half-open Connector and projects offline state without a long wait', async (t) => {
  const { root, baseUrl } = await fixture(t, { heartbeatIntervalMs: 20, staleSocketTimeoutMs: 60 });
  const { session, credential } = await pairCandidate(baseUrl, path.join(root, 'connector'));
  const device = JSON.parse(fs.readFileSync(path.join(root, 'connector', 'device-identity.json'), 'utf8'));
  const connector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), {
    autoPong: false,
    headers: {
      Authorization: `Bearer ${credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
      'X-Omnia-Connector-Id': device.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
    }
  });
  await once(connector, 'open');
  const matched = await commitReadyCandidate(baseUrl, session);
  const shell = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${matched.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL
  }});
  await once(shell, 'open');
  await once(shell, 'message');
  const offline = new Promise<BridgeEnvelope>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('half-open Connector was not pruned')), 1_000);
    shell.on('message', (data) => {
      const envelope = JSON.parse(data.toString()) as BridgeEnvelope;
      if (envelope.kind === 'state' && !envelope.connectorOnline) {
        clearTimeout(timeout);
        resolve(envelope);
      }
    });
  });
  const state = await offline;
  assert.equal(state.kind, 'state');
  const health = await (await fetch(`${baseUrl}v1/health`)).json() as any;
  assert.equal(health.onlineConnectors, 0);
  connector.close();
  shell.close();
});

async function pairCandidate(baseUrl: string, dataRoot: string) {
  const session = await beginPairingSession({ bridgeUrl: baseUrl });
  const credential = await pairCandidateFromSession(baseUrl, session, dataRoot);
  return { session, credential };
}

async function pairCandidateFromSession(
  baseUrl: string,
  session: Awaited<ReturnType<typeof beginPairingSession>>,
  dataRoot: string
) {
  await pairRemoteConnector({ dataRoot, bridgeUrl: baseUrl, pairingCode: session.pairingCode, name: 'E2E workstation' });
  const credential = readCandidateBridgeCredential(dataRoot)!;
  assert.ok(credential.token);
  return credential;
}

async function commitReadyCandidate(baseUrl: string, session: Awaited<ReturnType<typeof beginPairingSession>>) {
  const ready = await pollPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret });
  assert.equal(ready.state, 'candidate');
  assert.ok(ready.token);
  await commitPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret });
  const matched = await pollPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret });
  assert.equal(matched.state, 'matched');
  return matched;
}

test('one-time Shell link code is role-bound, private and activated only by verified Connector WSS', async (t) => {
  const { root, baseUrl } = await fixture(t);
  const dataRoot = path.join(root, 'connector');
  const session = await beginPairingSession({ bridgeUrl: baseUrl });
  assert.match(session.pairingCode, /^[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)+$/);
  const discovery = await fetch(`${baseUrl}v1/waiting-connectors`);
  assert.equal(discovery.status, 404);
  assert.equal((await discovery.text()).includes('connectorId'), false);
  const unauthorizedPoll = await fetch(`${baseUrl}v1/pairing/sessions/${session.sessionId}`, {
    headers: { Authorization: 'Pairing wrong-secret' }
  });
  assert.equal(unauthorizedPoll.status, 401);

  await pairRemoteConnector({ dataRoot, bridgeUrl: baseUrl, pairingCode: session.pairingCode, name: 'Company workstation' });
  const credential = readCandidateBridgeCredential(dataRoot)!;
  const stored = fs.readFileSync(path.join(dataRoot, 'bridge-credential-candidate.json'), 'utf8');
  assert.equal(stored.includes(session.pairingCode), false);
  assert.match(stored, /"tokenCiphertext"/);
  assert.equal((await pollPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret })).state, 'candidate');
  await assert.rejects(
    () => pairRemoteConnector({ dataRoot: path.join(root, 'replay'), bridgeUrl: baseUrl, pairingCode: session.pairingCode, name: 'Replay' }),
    /链接码无效|pairing/i
  );

  const device = JSON.parse(fs.readFileSync(path.join(dataRoot, 'device-identity.json'), 'utf8'));
  const connector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), {
    headers: {
      Authorization: `Bearer ${credential.token}`,
      'X-Omnia-Protocol': BRIDGE_PROTOCOL,
      'X-Omnia-Connector-Id': device.connectorId,
      'X-Omnia-Connector-Version': '0.3.5'
    }
  });
  await once(connector, 'open');
  t.after(() => connector.close());
  const ready = await pollPairingSession({ bridgeUrl: baseUrl, sessionId: session.sessionId, pollSecret: session.pollSecret });
  assert.equal(ready.state, 'candidate');
  const matched = await commitReadyCandidate(baseUrl, session);
  assert.equal(matched.connector?.connectorId, device.connectorId);
  assert.ok(matched.token);
});

test('pairing cancel is proof-bound for waiting/candidate and loses safely to activation', async (t) => {
  const { root, baseUrl } = await fixture(t);
  const waiting = await beginPairingSession({ bridgeUrl: baseUrl });
  assert.equal(await cancelPairingSession({ bridgeUrl: baseUrl, sessionId: waiting.sessionId, pollSecret: waiting.pollSecret }), 'cancelled');
  await assert.rejects(
    () => pairRemoteConnector({ dataRoot: path.join(root, 'waiting-replay'), bridgeUrl: baseUrl, pairingCode: waiting.pairingCode, name: 'Replay' }),
    /链接码无效|pairing/i
  );

  const candidate = await pairCandidate(baseUrl, path.join(root, 'candidate-cancel'));
  assert.equal(await cancelPairingSession({ bridgeUrl: baseUrl, sessionId: candidate.session.sessionId, pollSecret: candidate.session.pollSecret }), 'cancelled');
  const candidateDevice = JSON.parse(fs.readFileSync(path.join(root, 'candidate-cancel', 'device-identity.json'), 'utf8'));
  const rejected = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${candidate.credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': candidateDevice.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(rejected, 'error');

  const active = await pairCandidate(baseUrl, path.join(root, 'active-race'));
  const activeDevice = JSON.parse(fs.readFileSync(path.join(root, 'active-race', 'device-identity.json'), 'utf8'));
  const connector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${active.credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': activeDevice.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(connector, 'open');
  assert.equal((await pollPairingSession({ bridgeUrl: baseUrl, sessionId: active.session.sessionId, pollSecret: active.session.pollSecret })).state, 'candidate');
  await commitPairingSession({ bridgeUrl: baseUrl, sessionId: active.session.sessionId, pollSecret: active.session.pollSecret });
  assert.equal(await cancelPairingSession({ bridgeUrl: baseUrl, sessionId: active.session.sessionId, pollSecret: active.session.pollSecret }), 'matched');
  assert.equal((await pollPairingSession({ bridgeUrl: baseUrl, sessionId: active.session.sessionId, pollSecret: active.session.pollSecret })).state, 'matched');
  connector.close();
});

test('state envelope distinguishes Bridge from Connector and in-flight disconnect is never replayable', async (t) => {
  const { root, baseUrl } = await fixture(t);
  const { session, credential } = await pairCandidate(baseUrl, path.join(root, 'connector'));
  const device = JSON.parse(fs.readFileSync(path.join(root, 'connector', 'device-identity.json'), 'utf8'));
  const connector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': device.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(connector, 'open');
  const matched = await commitReadyCandidate(baseUrl, session);
  const transport = new RemoteConnectorTransport(() => ({ bridgeUrl: baseUrl, pairId: matched.pairId!, token: matched.token!, generation: matched.generation! }));
  t.after(() => transport.stop());
  connector.on('message', (data) => {
    const envelope = JSON.parse(data.toString()) as BridgeEnvelope;
    if (envelope.kind !== 'command') return;
    if (envelope.request.operation === 'status') connector.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response: {
      schemaVersion: 'omnia.connector-ipc/v1', id: envelope.request.id, ok: true, value: {
        status: 'waiting_login', connected: false, connecting: true, connectorId: device.connectorId,
        connectorName: 'Company workstation', connectorVersion: '0.3.5', sessionGeneration: 9,
        engagementId: '', engagementName: '', clientName: '', checkedAt: new Date().toISOString(), message: 'waiting login'
      }
    }}));
  });
  const waiting = await transport.load();
  assert.equal(waiting.bridgeOnline, true);
  assert.equal(waiting.connectorOnline, true);
  assert.equal(waiting.status, 'waiting_login');
  const mutation = (transport as any).call('operation_invoke', { effect: 'omnia_mutation' }, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  connector.close();
  await assert.rejects(mutation, (error: any) =>
    ['REMOTE.CONNECTOR_DISCONNECTED', 'REMOTE.IN_FLIGHT_DISCONNECTED'].includes(error.code)
    && error.retryable === false
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const offline = await transport.load();
  assert.equal(offline.bridgeOnline, true);
  assert.equal(offline.connectorOnline, false);
});

test('failed replacement preserves old binding; verified candidate atomically revokes old generation', async (t) => {
  const { root, baseUrl } = await fixture(t);
  const first = await pairCandidate(baseUrl, path.join(root, 'first'));
  const firstDevice = JSON.parse(fs.readFileSync(path.join(root, 'first', 'device-identity.json'), 'utf8'));
  const oldConnector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${first.credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': firstDevice.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(oldConnector, 'open');
  const active = await commitReadyCandidate(baseUrl, first.session);
  const replacement = await beginPairingSession({ bridgeUrl: baseUrl, replacementPairId: active.pairId!, currentToken: active.token! });
  await pairRemoteConnector({ dataRoot: path.join(root, 'candidate'), bridgeUrl: baseUrl, pairingCode: replacement.pairingCode, name: 'Replacement' });
  assert.equal((await pollPairingSession({ bridgeUrl: baseUrl, sessionId: replacement.sessionId, pollSecret: replacement.pollSecret })).state, 'candidate');
  assert.equal(oldConnector.readyState, WebSocket.OPEN);

  const nextCredential = readCandidateBridgeCredential(path.join(root, 'candidate'))!;
  const nextDevice = JSON.parse(fs.readFileSync(path.join(root, 'candidate', 'device-identity.json'), 'utf8'));
  const nextConnector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${nextCredential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': nextDevice.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(nextConnector, 'open');
  assert.equal(oldConnector.readyState, WebSocket.OPEN);
  const oldClosed = once(oldConnector, 'close');
  await commitPairingSession({ bridgeUrl: baseUrl, sessionId: replacement.sessionId, pollSecret: replacement.pollSecret });
  await oldClosed;
  const next = await pollPairingSession({ bridgeUrl: baseUrl, sessionId: replacement.sessionId, pollSecret: replacement.pollSecret });
  assert.equal(next.state, 'matched');
  assert.equal(next.generation, 2);
  const staleShell = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: { Authorization: `Bearer ${active.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL } });
  const [error] = await once(staleShell, 'error');
  assert.ok(error);
  nextConnector.close();
});

test('candidate disconnect before commit is rejected and leaves old binding active', async (t) => {
  const { root, statePath, baseUrl } = await fixture(t);
  const first = await pairCandidate(baseUrl, path.join(root, 'disconnect-old'));
  const oldDevice = JSON.parse(fs.readFileSync(path.join(root, 'disconnect-old', 'device-identity.json'), 'utf8'));
  const oldConnector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${first.credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': oldDevice.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(oldConnector, 'open');
  const old = await commitReadyCandidate(baseUrl, first.session);
  const replacement = await beginPairingSession({ bridgeUrl: baseUrl, replacementPairId: old.pairId!, currentToken: old.token! });
  const next = await pairCandidateFromSession(baseUrl, replacement, path.join(root, 'disconnect-new'));
  const nextDevice = JSON.parse(fs.readFileSync(path.join(root, 'disconnect-new', 'device-identity.json'), 'utf8'));
  const candidateSocket = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${next.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': nextDevice.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(candidateSocket, 'open');
  const closed = once(candidateSocket, 'close');
  candidateSocket.close();
  await closed;
  await assert.rejects(
    () => commitPairingSession({ bridgeUrl: baseUrl, sessionId: replacement.sessionId, pollSecret: replacement.pollSecret }),
    (error: any) => error.code === 'REMOTE.PAIRING_COMMIT_FAILED'
  );
  assert.equal(oldConnector.readyState, WebSocket.OPEN);
  const document = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(document.bindings.find((binding: any) => binding.pairId === old.pairId).lifecycle, 'active');
  assert.equal(document.bindings.find((binding: any) => binding.pairId === next.pairId).lifecycle, 'candidate');
  oldConnector.close();
});

test('transport resets terminal repair only for a new binding identity and auto-recovers a transient socket loss', async (t) => {
  const { root, baseUrl } = await fixture(t);
  const first = await pairCandidate(baseUrl, path.join(root, 'old'));
  const oldDevice = JSON.parse(fs.readFileSync(path.join(root, 'old', 'device-identity.json'), 'utf8'));
  const respondStatus = (socket: WebSocket, connectorId: string) => socket.on('message', (data) => {
    const envelope = JSON.parse(data.toString()) as BridgeEnvelope;
    if (envelope.kind !== 'command') return;
    socket.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response: {
      schemaVersion: 'omnia.connector-ipc/v1', id: envelope.request.id, ok: true, value: {
        status: 'waiting_pack', connected: false, connecting: true, connectorId,
        connectorName: 'E2E workstation', connectorVersion: '0.3.5', sessionGeneration: 11,
        engagementId: '', engagementName: '', clientName: '', checkedAt: new Date().toISOString(), message: 'waiting pack'
      }
    }}));
  });
  const oldConnector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${first.credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': oldDevice.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  respondStatus(oldConnector, oldDevice.connectorId);
  await once(oldConnector, 'open');
  const oldShell = await commitReadyCandidate(baseUrl, first.session);
  let config = { bridgeUrl: baseUrl, pairId: oldShell.pairId!, token: oldShell.token!, generation: oldShell.generation! };
  const transport = new RemoteConnectorTransport(() => config);
  await transport.start();
  assert.equal((await transport.load()).bindingState, 'bound');

  const replacement = await beginPairingSession({ bridgeUrl: baseUrl, replacementPairId: oldShell.pairId!, currentToken: oldShell.token! });
  await pairRemoteConnector({ dataRoot: path.join(root, 'new'), bridgeUrl: baseUrl, pairingCode: replacement.pairingCode, name: 'New workstation' });
  const newCredential = readCandidateBridgeCredential(path.join(root, 'new'))!;
  const newDevice = JSON.parse(fs.readFileSync(path.join(root, 'new', 'device-identity.json'), 'utf8'));
  const newConnector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${newCredential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': newDevice.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  respondStatus(newConnector, newDevice.connectorId);
  await once(newConnector, 'open');
  await commitPairingSession({ bridgeUrl: baseUrl, sessionId: replacement.sessionId, pollSecret: replacement.pollSecret });
  const newShell = await pollPairingSession({ bridgeUrl: baseUrl, sessionId: replacement.sessionId, pollSecret: replacement.pollSecret });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await transport.load()).bindingState, 'repair_required');

  config = { bridgeUrl: baseUrl, pairId: newShell.pairId!, token: newShell.token!, generation: newShell.generation! };
  await transport.stop();
  await transport.start();
  assert.equal((await transport.load()).bindingState, 'bound');
  (transport as any).socket.terminate();
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  const recovered = await transport.load();
  assert.equal(recovered.bridgeOnline, true);
  assert.equal(recovered.connectorOnline, true);
  assert.equal(recovered.bindingState, 'bound');
  await transport.stop();
  oldConnector.close();
  newConnector.close();
});

test('Bridge accepts existing 0.3.4 connector token claims once and persists the imported binding', async (t) => {
  const { root, baseUrl } = await fixture(t);
  const pairId = 'pair-legacy-034';
  const connectorId = 'v5-connector-legacy-034';
  const token = bridgeTest.signToken({ role: 'connector', pairId, exp: Date.now() + 60_000 }, secret);
  const legacy = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': connectorId, 'X-Omnia-Connector-Version': '0.3.4'
  }});
  await once(legacy, 'open');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'bridge-bindings.json'), 'utf8'));
  assert.equal(state.bindings[0].connectorId, connectorId);
  assert.equal(state.bindings[0].connectorVersion, '0.3.4');
  legacy.close();
});

test('Bridge, Shell transport and Connector restart from persistent credentials without a new link code', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-restart-binding-'));
  const statePath = path.join(root, 'bridge-bindings.json');
  let bridge = createBridgeServer({ host: '127.0.0.1', port: 0, tokenSecret: secret, statePath });
  let address = await bridge.listen();
  let baseUrl = `http://127.0.0.1:${address.port}/`;
  const candidate = await pairCandidate(baseUrl, path.join(root, 'connector'));
  const device = JSON.parse(fs.readFileSync(path.join(root, 'connector', 'device-identity.json'), 'utf8'));
  let connector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${candidate.credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': device.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(connector, 'open');
  const shell = await commitReadyCandidate(baseUrl, candidate.session);
  await bridge.close();

  bridge = createBridgeServer({ host: '127.0.0.1', port: 0, tokenSecret: secret, statePath });
  address = await bridge.listen();
  baseUrl = `http://127.0.0.1:${address.port}/`;
  connector = new WebSocket(new URL('v1/connect', baseUrl).href.replace(/^http/, 'ws'), { headers: {
    Authorization: `Bearer ${candidate.credential.token}`, 'X-Omnia-Protocol': BRIDGE_PROTOCOL,
    'X-Omnia-Connector-Id': device.connectorId, 'X-Omnia-Connector-Version': '0.3.5'
  }});
  await once(connector, 'open');
  connector.on('message', (data) => {
    const envelope = JSON.parse(data.toString()) as BridgeEnvelope;
    if (envelope.kind !== 'command') return;
    connector.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response: {
      schemaVersion: 'omnia.connector-ipc/v1', id: envelope.request.id, ok: true, value: {
        status: 'waiting_pack', connected: false, connecting: true, connectorId: device.connectorId,
        connectorName: 'E2E workstation', connectorVersion: '0.3.5', sessionGeneration: 1,
        engagementId: '', engagementName: '', clientName: '', checkedAt: new Date().toISOString(), message: 'waiting pack'
      }
    }}));
  });
  const transport = new RemoteConnectorTransport(() => ({ bridgeUrl: baseUrl, pairId: shell.pairId!, token: shell.token!, generation: shell.generation! }));
  const restarted = await transport.load();
  assert.equal(restarted.bridgeOnline, true);
  assert.equal(restarted.connectorOnline, true);
  assert.equal(restarted.bindingState, 'bound');
  t.after(async () => {
    await transport.stop(); connector.close(); await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  });
});
