import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ConnectionSnapshot, WorkspaceObservation } from '../src/shared/contracts.ts';
import { CoreDatabase } from '../src/main/database.ts';
import { ChatService } from '../src/main/services/chat-service.ts';
import { ShellService } from '../src/main/services/shell-service.ts';
import type { ShellServiceTiming } from '../src/main/services/shell-service.ts';
import { createTestContentCipher } from '../src/main/content-cipher.ts';

const engagementId = '11111111-1111-4111-8111-111111111111';
const sectionId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '33333333-3333-4333-8333-333333333333';

const supportedBridgeInspection = () => ({
  status: 'supported' as const,
  canCreateSession: true,
  reasonCode: '',
  reason: 'Remote Bridge 支持当前一次性链接会话合同。',
  bridgeVersion: '0.4.3',
  bridgeProtocol: 'omnia.v5.remote-connector/v2',
  buildIdentity: 'bridge-contract-fixture',
  checkedAt: new Date().toISOString()
});
const lifecycleWithBridge = <T extends Record<string, unknown>>(overrides = {} as T) => ({
  inspectBridge: async () => supportedBridgeInspection(),
  ...overrides
});

class FakeAdapter {
  connectCalls = 0;
  cancelCalls = 0;
  loadCalls = 0;
  refreshCalls = 0;
  pageNavigationCalls = 0;
  lightReadCalls = 0;
  loadSequence: ConnectionSnapshot[] = [];
  connectResult: ConnectionSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  connection: ConnectionSnapshot = {
    transport: 'remote',
    adapter: 'v5_remote_connector',
    adapterAvailable: true,
    adapterReason: '',
    remoteAvailable: true,
    remoteReason: '',
    bridgeOnline: true,
    connectorOnline: true,
    protocolCompatible: true,
    bindingState: 'bound',
    status: 'connected',
    connected: true,
    connecting: false,
    connectorId: 'fixture-connector',
    connectorName: '合同测试 Connector',
    connectorVersion: '0.1.0-test',
    sessionGeneration: 1,
    authorityInstanceId: 'fixture-authority',
    tenantOrOrgId: 'fixture-tenant',
    packId: 'fixture-pack',
    engagementId,
    engagementName: '合同测试 Pack',
    clientName: '测试客户',
    checkedAt: new Date().toISOString(),
    message: '测试连接已建立'
  };
  async start() {}
  async stop() {}
  async cancelConnect() { this.cancelCalls += 1; }
  observation: WorkspaceObservation = {
    observationId: 'fixture-observation',
    profile: 'workspace_light_read',
    authorityId: 'fixture-authority',
    connectorId: 'fixture-connector',
    sessionGeneration: 1,
    authorityInstanceId: 'fixture-authority',
    tenantOrOrgId: 'fixture-tenant',
    packId: 'fixture-pack',
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
  onStateChanged(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emitState() { for (const listener of this.listeners) listener(); }
  async load() { this.loadCalls += 1; return this.loadSequence.shift() || this.connection; }
  async connect() { this.connectCalls += 1; return this.connectResult || this.connection; }
  async refresh() {
    this.refreshCalls += 1;
    this.pageNavigationCalls += 1;
    return this.connection;
  }
  async lightRead() {
    this.lightReadCalls += 1;
    return { ...this.observation, observationId: `${this.observation.observationId}-${this.lightReadCalls}` };
  }
}

async function fixture(run: (
  shell: ShellService,
  database: CoreDatabase,
  adapter: FakeAdapter
) => Promise<void>, timing: Partial<ShellServiceTiming> = {}): Promise<void> {
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
  const shell = new ShellService(database, adapter as any, chat, undefined, undefined, timing, lifecycleWithBridge());
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

const connectionState = (base: ConnectionSnapshot, status: ConnectionSnapshot['status'], connected = false): ConnectionSnapshot => ({
  ...base,
  status,
  connected,
  connecting: !connected,
  engagementId: connected ? engagementId : '',
  engagementName: connected ? '合同测试 Pack' : '',
  message: status
});

const bindRemoteFixture = (database: CoreDatabase) => {
  const current = database.getRemoteBinding();
  database.saveRemoteBinding({
    bridgeUrl: 'https://bridge.fixture.invalid/', pairId: 'pair-fixture', token: 'fixture-token',
    connectorId: 'fixture-connector', connectorName: '合同测试 Connector', connectorVersion: '0.3.5',
    protocolVersion: 'omnia.v5.remote-connector/v1', generation: 1, expectedStateVersion: current.stateVersion
  });
};

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
    const saved = await shell.saveSafety({
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

test('keepalive persists a read-only status result without refresh or page navigation', async () => {
  await fixture(async (shell, database, adapter) => {
    const loadCallsBeforeKeepalive = adapter.loadCalls;
    const snapshot = await shell.setKeepalive(true);
    assert.equal(snapshot.keepalive.enabled, true);
    assert.ok(database.getKeepalive().lastAttemptAt);
    assert.ok(database.getKeepalive().lastSuccessAt);
    assert.equal(adapter.loadCalls, loadCallsBeforeKeepalive + 1);
    assert.equal(adapter.refreshCalls, 0);
    assert.equal(adapter.pageNavigationCalls, 0);
    assert.equal(database.getConnectionPayload<ConnectionSnapshot>()?.packId, 'fixture-pack');
    const disabled = await shell.setKeepalive(false);
    assert.equal(disabled.keepalive.enabled, false);
  });
});

test('keepalive persists a failed read-only status and keeps safety fail-closed', async () => {
  await fixture(async (shell, _database, adapter) => {
    await shell.refreshWorkspaceDirectory();
    const beforeSafety = shell.snapshot().safety;
    await shell.saveSafety({ enabled:true, workspaceIds:[workspaceId], expectedStateVersion:beforeSafety.stateVersion });
    adapter.loadSequence = [{
      ...adapter.connection,
      connected: false,
      connecting: false,
      status: 'connector_offline',
      message: 'fixture status read reports Connector offline'
    }];
    const snapshot = await shell.setKeepalive(true);
    assert.equal(snapshot.connection.connected, false);
    assert.equal(snapshot.keepalive.lastSuccessAt, '');
    assert.match(snapshot.keepalive.lastError, /fixture status read reports Connector offline/u);
    assert.equal(snapshot.safety.enabled, true);
    assert.equal(snapshot.safety.validForCurrentConnection, false);
    assert.equal(adapter.refreshCalls, 0);
    assert.equal(adapter.pageNavigationCalls, 0);
  });
});

test('keepalive preserves the last failure until a live connected read succeeds', async () => {
  await fixture(async (shell, database, adapter) => {
    database.updateKeepalive({ lastError: 'previous authoritative failure' });
    const projectedErrors: string[] = [];
    const unsubscribe = shell.onChanged((snapshot) => projectedErrors.push(snapshot.keepalive.lastError));
    adapter.loadSequence = [connectionState(adapter.connection, 'waiting_authorization')];

    await shell.setKeepalive(true);
    unsubscribe();

    assert.equal(projectedErrors[0], 'previous authoritative failure');
    assert.equal(shell.snapshot().connection.connecting, false);
    assert.match(shell.snapshot().keepalive.lastError, /waiting_authorization/u);

    adapter.loadSequence = [connectionState(adapter.connection, 'connected', true)];
    await (shell as any).runKeepalive();
    assert.equal(shell.snapshot().connection.connected, true);
    assert.equal(shell.snapshot().keepalive.lastError, '');
  });
});

test('keepalive probes past a cached disconnected state and automatically records recovery', async () => {
  await fixture(async (shell, database, adapter) => {
    adapter.loadSequence = [{
      ...adapter.connection,
      connected: false,
      connecting: false,
      status: 'waiting_authorization',
      message: 'fixture Authorization is unavailable'
    }];
    const failed = await shell.setKeepalive(true);
    assert.equal(failed.connection.connected, false);
    assert.match(failed.keepalive.lastError, /fixture Authorization is unavailable/u);
    assert.equal(failed.keepalive.lastSuccessAt, '');

    const callsBeforeRecovery = adapter.loadCalls;
    adapter.loadSequence = [{
      ...adapter.connection,
      checkedAt: new Date().toISOString(),
      message: 'fixture Pack connection recovered'
    }];
    database.updateKeepalive({ nextAttemptAt: '' });
    await (shell as any).backgroundTick();

    const recovered = shell.snapshot();
    assert.equal(adapter.loadCalls, callsBeforeRecovery + 1);
    assert.equal(recovered.connection.connected, true);
    assert.equal(recovered.keepalive.lastError, '');
    assert.ok(recovered.keepalive.lastSuccessAt);
    assert.equal(adapter.refreshCalls, 0);
    assert.equal(adapter.pageNavigationCalls, 0);
  });
});

test('keepalive keeps probing a cached disconnected state without claiming false recovery', async () => {
  await fixture(async (shell, database, adapter) => {
    adapter.loadSequence = [{
      ...adapter.connection,
      connected: false,
      connecting: false,
      status: 'connector_offline',
      message: 'fixture Connector remains offline'
    }];
    await shell.setKeepalive(true);

    const callsBeforeRetry = adapter.loadCalls;
    adapter.loadSequence = [{
      ...adapter.connection,
      connected: false,
      connecting: false,
      status: 'waiting_authorization',
      message: 'fixture Authorization is still unavailable'
    }];
    database.updateKeepalive({ nextAttemptAt: '' });
    await (shell as any).backgroundTick();

    const stillFailed = shell.snapshot();
    assert.equal(adapter.loadCalls, callsBeforeRetry + 1);
    assert.equal(stillFailed.connection.connected, false);
    assert.equal(stillFailed.connection.status, 'waiting_authorization');
    assert.equal(stillFailed.keepalive.lastSuccessAt, '');
    assert.match(stillFailed.keepalive.lastError, /fixture Authorization is still unavailable/u);
    assert.equal(adapter.refreshCalls, 0);
    assert.equal(adapter.pageNavigationCalls, 0);
  });
});

test('legacy Remote pairing and revoke entry points fail closed under Connector Next enrollment', async () => {
  await fixture(async (shell, database) => {
    bindRemoteFixture(database);
    const connection = shell.snapshot().settings.connection;
    await assert.rejects(
      () => shell.beginRemotePairing({ repair: true, expectedStateVersion: connection.stateVersion }),
      (error: any) => error.code === 'CONNECTOR_NEXT.ENROLLMENT_MANAGED_EXTERNALLY'
    );
    await assert.rejects(
      () => shell.cancelRemotePairing(),
      (error: any) => error.code === 'CONNECTOR_NEXT.ENROLLMENT_MANAGED_EXTERNALLY'
    );
    await assert.rejects(
      () => shell.revokeRemoteBinding({ confirmed: true, expectedStateVersion: connection.stateVersion }),
      (error: any) => error.code === 'CONNECTOR_NEXT.ENROLLMENT_MANAGED_EXTERNALLY'
    );
    assert.equal(database.getPendingRemotePairing(), null);
  });
});


test('one Connect action automatically advances delayed login, Pack, authorization and hierarchy states', async () => {
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    const observed: string[] = [];
    const unsubscribe = shell.onChanged((snapshot) => observed.push(snapshot.connection.status));
    adapter.connectResult = connectionState(adapter.connection, 'waiting_login');
    adapter.loadSequence = [
      connectionState(adapter.connection, 'waiting_pack'),
      connectionState(adapter.connection, 'waiting_authorization'),
      connectionState(adapter.connection, 'identifying_pack'),
      connectionState(adapter.connection, 'connected', true)
    ];
    await shell.connect();
    await (shell as any).connectRunning;
    const result = shell.snapshot();
    unsubscribe();
    assert.equal(adapter.connectCalls, 1);
    assert.equal(result.connection.connected, true);
    for (const state of ['waiting_login', 'waiting_pack', 'waiting_authorization', 'identifying_pack']) {
      assert.ok(observed.includes(state), `missing projected state ${state}`);
    }
  }, { sleep: async () => undefined });
});

test('explicit Connect dispatches a real Connector rebind from waiting_authorization', async () => {
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    adapter.loadSequence = [connectionState(adapter.connection, 'waiting_authorization')];
    adapter.connectResult = connectionState(adapter.connection, 'connected', true);

    await shell.connect();
    await (shell as any).connectRunning;
    const result = shell.snapshot();

    assert.equal(adapter.connectCalls, 1);
    assert.equal(result.connection.connected, true);
    assert.equal(result.connection.status, 'connected');
  }, { sleep: async () => undefined });
});

test('manual Connect is idempotent when live status already proves Connected', async () => {
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    const loadCalls = adapter.loadCalls;

    await shell.connect();
    await (shell as any).connectRunning;
    await shell.connect();
    await (shell as any).connectRunning;

    assert.equal(adapter.loadCalls, loadCalls + 2);
    assert.equal(adapter.connectCalls, 0);
    assert.equal(shell.snapshot().connection.status, 'connected');
    assert.equal(shell.snapshot().connection.connected, true);
  });
});

test('background restart recovery passively advances an existing waiting target', async () => {
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    (shell as any).connection = connectionState(adapter.connection, 'waiting_authorization');
    adapter.loadSequence = [connectionState(adapter.connection, 'connected', true)];
    const loadCalls = adapter.loadCalls;

    await (shell as any).backgroundTick();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(adapter.loadCalls, loadCalls + 1);
    assert.equal(shell.snapshot().connection.status, 'connected');
    assert.equal(adapter.connectCalls, 0);
    assert.equal(adapter.refreshCalls, 0);
    assert.equal(adapter.pageNavigationCalls, 0);
  });
});

test('background recovery passively observes an independently restarted Connector Next Agent', async () => {
  await fixture(async (shell, _database, adapter) => {
    (shell as any).connection = connectionState(adapter.connection, 'connector_offline');
    adapter.loadSequence = [connectionState(adapter.connection, 'waiting_pack')];
    const loadCalls = adapter.loadCalls;

    await (shell as any).backgroundTick();
    for (let index = 0; index < 20 && adapter.loadCalls === loadCalls; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(adapter.loadCalls, loadCalls + 1);
    assert.equal(shell.snapshot().connection.status, 'waiting_pack');
    assert.equal(shell.snapshot().connection.connecting, false);
    assert.equal(adapter.connectCalls, 0, 'passive recovery must not start or replay a Pack connect action');
  });
});

test('passive waiting_authorization never projects an active Connect attempt', async () => {
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    const loadCalls = adapter.loadCalls;
    adapter.loadSequence = [connectionState(adapter.connection, 'waiting_authorization')];

    adapter.emitState();
    for (let index = 0; index < 20 && adapter.loadCalls === loadCalls; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));

    const waiting = shell.snapshot().connection;
    assert.equal(waiting.status, 'waiting_authorization');
    assert.equal(waiting.connected, false);
    assert.equal(waiting.connecting, false);
    assert.equal(adapter.connectCalls, 0);
  });
});

test('Connect timeout is deterministic and does not claim Pack connected', async () => {
  let now = 0;
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    adapter.connectResult = connectionState(adapter.connection, 'waiting_pack');
    adapter.connection = connectionState(adapter.connection, 'waiting_pack');
    await shell.connect();
    await (shell as any).connectRunning;
    const result = shell.snapshot();
    assert.equal(result.connection.status, 'timed_out');
    assert.equal(result.connection.connected, false);
    assert.equal(adapter.connectCalls, 1);
  }, {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    connectTimeoutMs: 5_000,
    connectPollMs: 2_500
  });
});

test('concurrent cancel preserves explicit cancelled state and cancels the in-flight request', async () => {
  let releaseSleep!: () => void;
  const sleeping = new Promise<void>((resolve) => { releaseSleep = resolve; });
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    adapter.connectResult = connectionState(adapter.connection, 'waiting_login');
    adapter.connection = connectionState(adapter.connection, 'waiting_login');
    const connecting = shell.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shell.snapshot().connection.connecting, true);
    const cancelled = await shell.cancelConnect();
    assert.equal(cancelled.connection.status, 'cancelled');
    releaseSleep();
    await connecting;
    await (shell as any).connectRunning;
    const result = shell.snapshot();
    assert.equal(result.connection.status, 'cancelled');
    assert.equal(adapter.cancelCalls, 1);
  }, { sleep: async () => sleeping });
});

test('passive reconciliation after cancel keeps Connect available', async () => {
  let releaseSleep!: () => void;
  const sleeping = new Promise<void>((resolve) => { releaseSleep = resolve; });
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    adapter.connectResult = connectionState(adapter.connection, 'waiting_login');
    adapter.connection = connectionState(adapter.connection, 'waiting_login');

    await shell.connect();
    await new Promise((resolve) => setImmediate(resolve));
    await shell.cancelConnect();
    releaseSleep();
    await (shell as any).connectRunning;

    const loadCalls = adapter.loadCalls;
    adapter.loadSequence = [connectionState(adapter.connection, 'waiting_authorization')];
    adapter.emitState();
    for (let index = 0; index < 20 && adapter.loadCalls === loadCalls; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));

    const waiting = shell.snapshot().connection;
    assert.equal(waiting.status, 'waiting_authorization');
    assert.equal(waiting.connecting, false);
    assert.equal(waiting.connected, false);
  }, { sleep: async () => sleeping });
});

test('Connector restart re-registers Feature runtime and refreshes hierarchy once per live Session', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-shell-recovery-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  const adapter = new FakeAdapter();
  adapter.connection = { ...adapter.connection, sessionGeneration: 1 };
  const chat = new ChatService(database);
  let runtimeInitializations = 0;
  const features = {
    async initializeRuntime() { runtimeInitializations += 1; },
    snapshot() {
      return {
        schemaVersion: 'omnia.feature-runtime-snapshot/v1', snapshotId: 'test', stateVersion: 1,
        groups: [], navigation: [], selectedFeatureId: '', surface: null, messageCards: []
      };
    }
  };
  const shell = new ShellService(database, adapter as any, chat, undefined, features as any, {}, lifecycleWithBridge());
  const settle = async (predicate: () => boolean) => {
    for (let index = 0; index < 50 && !predicate(); index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(predicate(), true);
  };
  try {
    await shell.initialize();
    assert.equal(runtimeInitializations, 1);
    assert.equal(adapter.lightReadCalls, 1);

    adapter.connection = { ...connectionState(adapter.connection, 'connector_offline'), connecting: false };
    adapter.emitState();
    await settle(() => shell.snapshot().workspaceDirectory.available === false);
    assert.equal(shell.snapshot().workspaceDirectory.observation, null);

    adapter.observation = { ...adapter.observation, observationId: 'recovered-live-observation', capturedAt: new Date().toISOString() };
    adapter.connection = { ...connectionState(adapter.connection, 'connected', true), sessionGeneration: 2 };
    adapter.emitState();
    await settle(() => shell.snapshot().workspaceDirectory.observation?.observationId.startsWith('recovered-live-observation') === true);
    assert.equal(runtimeInitializations, 2);
    assert.equal(adapter.lightReadCalls, 2);

    adapter.emitState();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtimeInitializations, 2);
    assert.equal(adapter.lightReadCalls, 2);
  } finally {
    shell.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
