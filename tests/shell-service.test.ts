import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ConnectionSnapshot, WorkspaceObservation } from '../src/shared/contracts.ts';
import { CoreDatabase } from '../src/main/database.ts';
import { ChatService } from '../src/main/services/chat-service.ts';
import { ShellService } from '../src/main/services/shell-service.ts';
import { createTestContentCipher } from '../src/main/content-cipher.ts';

const engagementId = '11111111-1111-4111-8111-111111111111';
const sectionId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '33333333-3333-4333-8333-333333333333';

class FakeAdapter {
  connection: ConnectionSnapshot = {
    transport: 'local',
    adapter: 'v5_local_connector',
    adapterAvailable: true,
    adapterReason: '',
    remoteAvailable: false,
    remoteReason: '测试中未配置',
    status: 'connected',
    connected: true,
    connecting: false,
    connectorId: 'fixture-connector',
    connectorName: '合同测试 Connector',
    connectorVersion: '0.1.0-test',
    engagementId,
    engagementName: '合同测试 Pack',
    clientName: '测试客户',
    checkedAt: new Date().toISOString(),
    message: '测试连接已建立'
  };
  observation: WorkspaceObservation = {
    observationId: 'fixture-observation',
    profile: 'workspace_light_read',
    authorityId: 'fixture-authority',
    engagementId,
    capturedAt: new Date().toISOString(),
    source: 'contract_fixture',
    coverage: 'full',
    sections: [{ id: sectionId, name: '测试 Section', order: 0 }],
    workspaces: [{ id: workspaceId, parentSectionId: sectionId, name: '测试 Workspace', status: 'active' }]
  };
  unavailableSnapshot(reason: string): ConnectionSnapshot {
    return { ...this.connection, status: 'not_configured', connected: false, adapterAvailable: false, adapterReason: reason };
  }
  async load() { return this.connection; }
  async connect() { return this.connection; }
  async refresh() { return this.connection; }
  async lightRead() { return this.observation; }
}

async function fixture(run: (
  shell: ShellService,
  database: CoreDatabase,
  adapter: FakeAdapter
) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-shell-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  const adapter = new FakeAdapter();
  const previous = {
    base: process.env.OMNIA_AI_BASE_URL,
    model: process.env.OMNIA_AI_MODEL,
    key: process.env.OMNIA_AI_API_KEY
  };
  delete process.env.OMNIA_AI_BASE_URL;
  delete process.env.OMNIA_AI_MODEL;
  delete process.env.OMNIA_AI_API_KEY;
  const chat = new ChatService(database);
  const shell = new ShellService(database, adapter as any, chat);
  try {
    await shell.initialize();
    await run(shell, database, adapter);
  } finally {
    shell.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
    if (previous.base === undefined) delete process.env.OMNIA_AI_BASE_URL;
    else process.env.OMNIA_AI_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.OMNIA_AI_MODEL;
    else process.env.OMNIA_AI_MODEL = previous.model;
    if (previous.key === undefined) delete process.env.OMNIA_AI_API_KEY;
    else process.env.OMNIA_AI_API_KEY = previous.key;
  }
}

test('refresh performs a real connector refresh and authoritative light read', async () => {
  await fixture(async (shell) => {
    const snapshot = await shell.refresh();
    assert.equal(snapshot.connection.connected, true);
    assert.equal(snapshot.workspaceDirectory.available, true);
    assert.equal(snapshot.workspaceDirectory.observation?.workspaces[0]?.parentSectionId, sectionId);
  });
});

test('safety lock saves, restores, and validates only authoritative workspace IDs', async () => {
  await fixture(async (shell) => {
    await shell.refreshWorkspaceDirectory();
    const before = shell.snapshot();
    const saved = shell.saveSafety({
      enabled: true,
      workspaceIds: [workspaceId],
      expectedStateVersion: before.safety.stateVersion
    });
    assert.equal(saved.safety.validForCurrentConnection, true);
    assert.doesNotThrow(() => shell.assertWorkspaceTargetsAllowed(engagementId, [workspaceId]));
    assert.throws(
      () => shell.assertWorkspaceTargetsAllowed(engagementId, ['44444444-4444-4444-8444-444444444444']),
      (error: any) => error.code === 'SAFETY.WORKSPACE_BLOCKED'
    );
  });
});

test('chat persists the user message and reports unconfigured Provider without a fake reply', async () => {
  await fixture(async (shell) => {
    const snapshot = await shell.sendMessage('需要保存的消息');
    assert.equal(snapshot.chat.messages.length, 1);
    assert.equal(snapshot.chat.messages[0]?.role, 'user');
    assert.equal(snapshot.chat.messages[0]?.status, 'provider_unavailable');
    assert.equal(snapshot.chat.messages.some((message) => message.role === 'assistant'), false);
  });
});

test('keepalive has durable scheduler state and a real connector refresh result', async () => {
  await fixture(async (shell, database) => {
    const snapshot = await shell.setKeepalive(true);
    assert.equal(snapshot.keepalive.enabled, true);
    assert.ok(database.getKeepalive().lastAttemptAt);
    assert.ok(database.getKeepalive().lastSuccessAt);
    const disabled = await shell.setKeepalive(false);
    assert.equal(disabled.keepalive.enabled, false);
  });
});

test('repeated Remote pairing is idempotent after the one-time discovery succeeded', async () => {
  await fixture(async (shell, database) => {
    const initial = database.getConnectionSettings();
    const paired = database.saveRemotePairing({
      bridgeUrl: 'https://agent.labcaspian.com/v5-bridge/',
      pairId: 'v5-pair-existing',
      token: 'persisted-secret-token',
      expectedStateVersion: initial.stateVersion
    });
    const remote = database.saveConnectionMode('remote', paired.stateVersion);

    const snapshot = await shell.pairRemote({
      bridgeUrl: 'https://agent.labcaspian.com/v5-bridge/',
      pairingCode: '',
      connectorId: 'stale-candidate-from-the-old-settings-page',
      expectedStateVersion: remote.stateVersion
    });

    assert.equal(snapshot.settings.connection.remotePaired, true);
    assert.equal(snapshot.settings.connection.remotePairId, 'v5-pair-existing');
    assert.equal(snapshot.settings.connection.mode, 'remote');
  });
});
