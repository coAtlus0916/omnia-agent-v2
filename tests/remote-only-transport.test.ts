import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RemoteConnectorTransport } from '../src/main/connector/remote-connector-transport.ts';
import {
  acceptCommittedCandidateBridgeCredential,
  clearCandidateBridgeCredential,
  pairRemoteConnector,
  readCandidateBridgeCredential,
  readStoredBridgeCredential
} from '../src/remote-connector/bridge-credential.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Shell main instantiates only Remote transport and has no Local fallback or Local IPC', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(source, /new RemoteConnectorTransport/);
  assert.doesNotMatch(source, /LocalConnectorAdapter|ConnectorTransportRouter|set-connection-mode|pair-remote/);
  assert.equal(fs.existsSync(path.join(root, 'src', 'main', 'connector', 'local-connector-adapter.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'src', 'main', 'connector', 'transport-router.ts')), false);
});

test('unpaired transport fails closed as Remote and never presents a Local snapshot', async () => {
  const transport = new RemoteConnectorTransport(() => ({ bridgeUrl: '', pairId: '', token: '' }));
  const snapshot = await transport.load();
  assert.equal(snapshot.transport, 'remote');
  assert.equal(snapshot.adapter, 'v5_remote_connector');
  assert.equal(snapshot.connectorOnline, false);
  assert.equal((snapshot as any).mode, undefined);
});

test('Windows package manifest excludes the former Shell-local connector subprocess', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'package-windows.mjs'), 'utf8');
  assert.doesNotMatch(source, /connector\.cjs/);
  assert.doesNotMatch(source, /playwright-core/);
});

test('Remote terminal-state and online re-pair policies are fail-closed', () => {
  const transport = fs.readFileSync(path.join(root, 'src', 'main', 'connector', 'remote-connector-transport.ts'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'src', 'remote-connector', 'worker.ts'), 'utf8');
  const cli = fs.readFileSync(path.join(root, 'src', 'remote-connector', 'cli.ts'), 'utf8');
  assert.match(transport, /if \(code === 4003\) \{\s*this\.repairRequired = true;/);
  assert.doesNotMatch(transport, /if \(code === 4003\) \{\s*this\.protocolCompatible = false;/);
  assert.match(worker, /bridgeState !== 'repair_required' && bridgeState !== 'connector_incompatible'/);
  assert.match(worker, /candidate && activeOperations === 0 && socket\?\.readyState === WebSocket\.OPEN/);
  assert.match(worker, /candidateFailureCount >= 3/);
  assert.match(worker, /envelope\.kind === 'binding_committed'/);
  assert.doesNotMatch(worker, /ws\.once\('open'[\s\S]{0,300}promoteCandidateBridgeCredential/);
  assert.match(worker, /候选绑定协议不兼容，已保留并恢复旧绑定/);
  assert.match(cli, /候选绑定已接收/);
  assert.doesNotMatch(cli, /配对成功/);
});

test('Remote Worker retains old credential until an identity-matched commit signal', async () => {
  const dataRoot = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'omnia-v5-worker-credential-'));
  let next = { pairId: 'pair-old', generation: 1, token: 'token-old' };
  const fetchImpl = async () => new Response(JSON.stringify({
    schemaVersion: 'omnia.v5.bridge/v1', ...next, expiresAt: new Date(Date.now() + 60_000).toISOString()
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    await pairRemoteConnector({ dataRoot, bridgeUrl: 'https://bridge.example.invalid/', pairingCode: '1001', name: 'Worker', fetchImpl: fetchImpl as typeof fetch });
    assert.equal(acceptCommittedCandidateBridgeCredential(dataRoot, 'pair-old', 1), true);
    assert.equal(readStoredBridgeCredential(dataRoot)?.pairId, 'pair-old');

    next = { pairId: 'pair-cancelled', generation: 2, token: 'token-cancelled' };
    await pairRemoteConnector({ dataRoot, bridgeUrl: 'https://bridge.example.invalid/', pairingCode: '1002', name: 'Worker', fetchImpl: fetchImpl as typeof fetch });
    assert.equal(readStoredBridgeCredential(dataRoot)?.pairId, 'pair-old');
    clearCandidateBridgeCredential(dataRoot);
    assert.equal(readStoredBridgeCredential(dataRoot)?.pairId, 'pair-old');

    next = { pairId: 'pair-new', generation: 2, token: 'token-new' };
    await pairRemoteConnector({ dataRoot, bridgeUrl: 'https://bridge.example.invalid/', pairingCode: '1003', name: 'Worker', fetchImpl: fetchImpl as typeof fetch });
    assert.equal(acceptCommittedCandidateBridgeCredential(dataRoot, 'pair-new', 99), false);
    assert.equal(readStoredBridgeCredential(dataRoot)?.pairId, 'pair-old');
    // This models a lost HTTP commit response followed by candidate WSS
    // reconnect receiving Bridge's authenticated binding_committed envelope.
    assert.equal(acceptCommittedCandidateBridgeCredential(dataRoot, 'pair-new', 2), true);
    assert.equal(readCandidateBridgeCredential(dataRoot), null);
    assert.equal(readStoredBridgeCredential(dataRoot)?.pairId, 'pair-new');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('POST/PATCH mutation loss is uncertain while read-only POST remains retryable', () => {
  const transport = fs.readFileSync(path.join(root, 'src', 'main', 'connector', 'remote-connector-transport.ts'), 'utf8');
  const workstation = fs.readFileSync(path.join(root, 'src', 'connector', 'workstation-omnia-session.ts'), 'utf8');
  const packageManager = fs.readFileSync(path.join(root, 'src', 'main', 'features', 'package-manager.ts'), 'utf8');
  assert.match(transport, /operation === 'operation_invoke' && payload\.mutationAuthorized === true/);
  assert.match(transport, /mutationUncertain \? 'REMOTE\.MUTATION_UNCERTAIN' : 'REMOTE\.TIMEOUT'/);
  assert.match(workstation, /execution\.commitStep/);
  assert.doesNotMatch(workstation, /route\.method !== 'PATCH'/);
  assert.match(packageManager, /'REMOTE\.MUTATION_UNCERTAIN'[\s\S]{0,240}'CONNECTOR\.RESPONSE_LOST'/);
});
