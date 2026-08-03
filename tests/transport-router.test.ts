import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ConnectionSnapshot } from '../src/shared/contracts.ts';
import { CoreDatabase } from '../src/main/database.ts';
import { createTestContentCipher } from '../src/main/content-cipher.ts';
import { ConnectorTransportRouter } from '../src/main/connector/transport-router.ts';

const available = (transport: 'local' | 'remote'): ConnectionSnapshot => ({
  transport,
  adapter: transport === 'local' ? 'v5_local_connector' : 'v5_remote_connector',
  adapterAvailable: true,
  adapterReason: '',
  remoteAvailable: transport === 'remote',
  remoteReason: '',
  status: 'not_connected',
  connected: false,
  connecting: false,
  connectorId: '',
  connectorName: '',
  connectorVersion: '',
  engagementId: '',
  engagementName: '',
  clientName: '',
  checkedAt: new Date().toISOString(),
  message: ''
});

class FakeTransport {
  starts = 0;
  stops = 0;
  constructor(
    readonly mode: 'local' | 'remote',
    private readonly startFailure = false,
    private readonly loadFailure = false
  ) {}
  async start() {
    this.starts += 1;
    if (this.startFailure) throw new Error('candidate start failed');
  }
  async stop() { this.stops += 1; }
  unavailableSnapshot(reason: string) { return { ...available(this.mode), adapterAvailable: false, adapterReason: reason }; }
  async load() {
    if (this.loadFailure) throw new Error('candidate load failed');
    return available(this.mode);
  }
  async connect() { return this.load(); }
  async refresh() { return this.load(); }
  async lightRead() { throw new Error('not used'); }
}

async function fixture(run: (
  database: CoreDatabase,
  local: FakeTransport,
  remote: FakeTransport
) => Promise<void>, remote: FakeTransport): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-router-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  const local = new FakeTransport('local');
  try {
    const settings = database.getConnectionSettings();
    database.saveRemotePairing({
      bridgeUrl: 'https://bridge.example/v5/',
      pairId: 'pair-test',
      token: 'test-token',
      expectedStateVersion: settings.stateVersion
    });
    await run(database, local, remote);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('failed target start is stopped and does not change the authoritative mode', async () => {
  const remote = new FakeTransport('remote', true, false);
  await fixture(async (database, local) => {
    const router = new ConnectorTransportRouter(database, local as any, remote as any);
    const stateVersion = database.getConnectionSettings().stateVersion;
    await assert.rejects(() => router.switchMode('remote', stateVersion), /candidate start failed/);
    assert.equal(remote.starts, 1);
    assert.equal(remote.stops, 1);
    assert.equal(database.getConnectionSettings().mode, 'local');
  }, remote);
});

test('failed target load is stopped and does not leave two transports running', async () => {
  const remote = new FakeTransport('remote', false, true);
  await fixture(async (database, local) => {
    const router = new ConnectorTransportRouter(database, local as any, remote as any);
    const stateVersion = database.getConnectionSettings().stateVersion;
    await assert.rejects(() => router.switchMode('remote', stateVersion), /candidate load failed/);
    assert.equal(remote.starts, 1);
    assert.equal(remote.stops, 1);
    assert.equal(local.stops, 0);
    assert.equal(database.getConnectionSettings().mode, 'local');
  }, remote);
});
