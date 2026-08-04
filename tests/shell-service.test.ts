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
import { AppError } from '../src/shared/errors.ts';

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
  async load() { return this.loadSequence.shift() || this.connection; }
  async connect() { this.connectCalls += 1; return this.connectResult || this.connection; }
  async refresh() { return this.connection; }
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

test('repair and unbind require an explicit confirmation and no Local snapshot is projected', async () => {
  await fixture(async (shell, database) => {
    database.saveConnectionPayload({ ...shell.snapshot().connection, transport: 'remote' });
    const connection = shell.snapshot().settings.connection;
    await assert.rejects(
      () => shell.beginRemotePairing({ repair: true, expectedStateVersion: connection.stateVersion }),
      (error: any) => error.code === 'REMOTE.CONFIRMATION_REQUIRED'
    );
    await assert.rejects(
      () => shell.revokeRemoteBinding({ confirmed: false, expectedStateVersion: connection.stateVersion }),
      (error: any) => error.code === 'REMOTE.CONFIRMATION_REQUIRED'
    );
    assert.equal(shell.snapshot().connection.transport, 'remote');
    assert.equal(shell.snapshot().connection.adapter, 'v5_remote_connector');
  });
});

test('legacy Bridge health blocks pairing before durable reservation or pairing POST', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-bridge-gate-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  let beginCalls = 0;
  const legacy = {
    status: 'upgrade_required' as const,
    canCreateSession: false,
    reasonCode: 'REMOTE.BRIDGE_UPGRADE_REQUIRED',
    reason: 'Remote Bridge 版本过旧，未声明一次性链接会话能力；请先升级 Bridge。',
    bridgeVersion: '', bridgeProtocol: '', buildIdentity: '', checkedAt: new Date().toISOString()
  };
  const lifecycle = {
    inspectBridge: async () => legacy,
    beginPairing: async () => {
      beginCalls += 1;
      throw new Error('pairing POST must not be reached');
    }
  };
  const shell = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycle as any);
  try {
    await shell.initialize();
    const initial = database.getRemoteBinding();
    assert.equal(shell.snapshot().bridgePairing.canCreateSession, false);
    await assert.rejects(
      () => shell.beginRemotePairing({ repair: false, expectedStateVersion: initial.stateVersion }),
      (error: any) => error.code === 'REMOTE.BRIDGE_UPGRADE_REQUIRED'
    );
    assert.equal(beginCalls, 0);
    assert.equal(database.getPendingRemotePairing(), null);
  } finally {
    shell.dispose(); database.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('diagnose refreshes Bridge pairing compatibility from unreachable to supported', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-bridge-diagnose-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  let reachable = false;
  let inspections = 0;
  const lifecycle = {
    inspectBridge: async () => {
      inspections += 1;
      return reachable ? supportedBridgeInspection() : {
        status: 'unreachable' as const,
        canCreateSession: false,
        reasonCode: 'REMOTE.BRIDGE_UNREACHABLE',
        reason: '无法访问 Remote Bridge 健康检查；请检查网络。',
        bridgeVersion: '', bridgeProtocol: '', buildIdentity: '', checkedAt: new Date().toISOString()
      };
    }
  };
  const shell = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycle as any);
  try {
    await shell.initialize();
    assert.equal(shell.snapshot().bridgePairing.status, 'unreachable');
    reachable = true;
    const diagnosed = await shell.diagnoseRemoteConnection();
    assert.equal(diagnosed.bridgePairing.status, 'supported');
    assert.equal(diagnosed.bridgePairing.canCreateSession, true);
    assert.equal(inspections, 2);
  } finally {
    shell.dispose(); database.close(); rmSync(root, { recursive: true, force: true });
  }
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
    const result = await shell.connect();
    unsubscribe();
    assert.equal(adapter.connectCalls, 1);
    assert.equal(result.connection.connected, true);
    for (const state of ['waiting_login', 'waiting_pack', 'waiting_authorization', 'identifying_pack']) {
      assert.ok(observed.includes(state), `missing projected state ${state}`);
    }
  }, { sleep: async () => undefined });
});

test('Connect timeout is deterministic and does not claim Pack connected', async () => {
  let now = 0;
  await fixture(async (shell, database, adapter) => {
    bindRemoteFixture(database);
    adapter.connectResult = connectionState(adapter.connection, 'waiting_pack');
    adapter.connection = connectionState(adapter.connection, 'waiting_pack');
    const result = await shell.connect();
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
    const cancelled = await shell.cancelConnect();
    assert.equal(cancelled.connection.status, 'cancelled');
    releaseSleep();
    const result = await connecting;
    assert.equal(result.connection.status, 'cancelled');
    assert.equal(adapter.cancelCalls, 1);
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

test('persisted pairing session survives Shell crash after Bridge activation and completes without the link code', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-pairing-recovery-'));
  const filename = path.join(root, 'core.sqlite');
  const cipher = createTestContentCipher();
  let database = new CoreDatabase(filename, cipher);
  const session = {
    sessionId: 'pairing-recoverable', pairingCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
    pollSecret: 'private-poll-secret', expiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  const matched: any = {
    schemaVersion: 'omnia.v5.remote-connector/v2', state: 'matched', expiresAt: session.expiresAt,
    pairId: 'pair-recovered', token: 'recovered-shell-token', generation: 1,
    connector: { connectorId: 'v5-connector-recovered', name: 'Recovered workstation', version: '0.3.5', platform: 'win32-x64' }
  };
  const lifecycle = {
    beginPairing: async () => session,
    pollPairing: async () => matched,
    commitPairing: async () => undefined,
    revoke: async () => undefined
  };
  const first = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(lifecycle) as any);
  try {
    await first.initialize();
    const initial = database.getRemoteBinding();
    await first.beginRemotePairing({ repair: false, expectedStateVersion: initial.stateVersion });
    const raw = database.db.prepare('SELECT * FROM remote_pairing_pending WHERE singleton=1').get() as any;
    assert.equal(raw.session_id, session.sessionId);
    assert.equal(String(raw.poll_secret_ciphertext).includes(session.pollSecret), false);
    assert.equal(JSON.stringify(raw).includes(session.pairingCode), false);
  } finally {
    first.dispose();
    database.close();
  }

  database = new CoreDatabase(filename, cipher);
  const second = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(lifecycle) as any);
  try {
    await second.initialize();
    const recovered = database.getRemoteBinding();
    assert.equal(recovered.pairId, 'pair-recovered');
    assert.equal(recovered.remoteToken, 'recovered-shell-token');
    assert.equal(recovered.bindingState, 'bound');
    assert.equal(database.getPendingRemotePairing(), null);
    assert.equal(second.snapshot().remotePairing.pairingCode, '');
  } finally {
    second.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart after durable stage but before Bridge commit completes the two-phase handoff', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-staged-before-commit-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  const current = database.getRemoteBinding();
  database.savePendingRemotePairing({
    sessionId: 'staged-session', pollSecret: 'staged-proof', bridgeUrl: current.bridgeUrl,
    expiresAt: new Date(Date.now() - 1_000).toISOString(), expectedPairId: '', expectedGeneration: 0,
    expectedBindingState: 'unpaired', expectedStateVersion: current.stateVersion
  });
  database.stagePendingPairingCommit({
    sessionId: 'staged-session', pairId: 'pair-staged', token: 'token-staged', generation: 1,
    connectorId: 'connector-staged', connectorName: 'Staged workstation', connectorVersion: '0.3.5'
  });
  let commits = 0;
  const lifecycle = {
    pollPairing: async () => ({
      schemaVersion: 'omnia.v5.bridge/v1', state: 'candidate', pairId: 'pair-staged', token: 'token-staged', generation: 1,
      connector: { connectorId: 'connector-staged', name: 'Staged workstation', version: '0.3.5', platform: 'win32-x64' }
    }),
    commitPairing: async () => { commits += 1; }
  };
  const shell = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(lifecycle) as any);
  try {
    await shell.initialize();
    assert.equal(commits, 1);
    assert.equal(database.getRemoteBinding().pairId, 'pair-staged');
    assert.equal(database.getPendingRemotePairing(), null);
  } finally {
    shell.dispose(); database.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('lost commit response recovers by polling matched and promotes without a second commit', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-lost-commit-response-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  const current = database.getRemoteBinding();
  database.savePendingRemotePairing({
    sessionId: 'lost-response-session', pollSecret: 'lost-response-proof', bridgeUrl: current.bridgeUrl,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), expectedPairId: '', expectedGeneration: 0,
    expectedBindingState: 'unpaired', expectedStateVersion: current.stateVersion
  });
  database.stagePendingPairingCommit({
    sessionId: 'lost-response-session', pairId: 'pair-lost-response', token: 'token-lost-response', generation: 1,
    connectorId: 'connector-lost-response', connectorName: 'Recovered workstation', connectorVersion: '0.3.5'
  });
  let committed = false;
  let commits = 0;
  const response = (state: 'candidate' | 'matched') => ({
    schemaVersion: 'omnia.v5.bridge/v1', state, pairId: 'pair-lost-response', token: 'token-lost-response', generation: 1,
    connector: { connectorId: 'connector-lost-response', name: 'Recovered workstation', version: '0.3.5', platform: 'win32-x64' }
  });
  const lifecycle = {
    pollPairing: async () => response(committed ? 'matched' : 'candidate'),
    commitPairing: async () => {
      commits += 1;
      committed = true;
      throw new AppError('REMOTE.PAIRING_COMMIT_FAILED', 'response lost', true);
    }
  };
  const shell = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(lifecycle) as any);
  try {
    await shell.initialize();
    assert.equal(commits, 1);
    assert.equal(database.getRemoteBinding().pairId, 'pair-lost-response');
    assert.equal(database.getPendingRemotePairing(), null);
  } finally {
    shell.dispose(); database.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('offline explicit unbind stays repair_required, then restart retry or invalid credential completes revoked', async () => {
  const runScenario = async (completion: 'success' | 'credential_invalid') => {
    const root = mkdtempSync(path.join(os.tmpdir(), `omnia-v5-revoke-${completion}-`));
    const filename = path.join(root, 'core.sqlite');
    const cipher = createTestContentCipher();
    let database = new CoreDatabase(filename, cipher);
    bindRemoteFixture(database);
    const offlineLifecycle = {
      revoke: async () => { throw new AppError('REMOTE.REVOKE_FAILED', 'Bridge offline', true); }
    };
    const first = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(offlineLifecycle) as any);
    try {
      await first.initialize();
      const current = database.getRemoteBinding();
      await assert.rejects(
        () => first.revokeRemoteBinding({ confirmed: true, expectedStateVersion: current.stateVersion }),
        (error: any) => error.code === 'REMOTE.REVOKE_FAILED'
      );
      const pending = database.getRemoteBinding();
      assert.equal(pending.bindingState, 'repair_required');
      assert.equal(pending.remoteToken, 'fixture-token');
      assert.ok(database.getPendingRemoteRevocation());
      assert.equal(first.snapshot().connection.connected, false);
    } finally {
      first.dispose();
      database.close();
    }

    database = new CoreDatabase(filename, cipher);
    const recoveryLifecycle = {
      revoke: async () => {
        if (completion === 'credential_invalid') throw new AppError('REMOTE.REVOKE_CREDENTIAL_INVALID', 'already invalid');
      }
    };
    const second = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(recoveryLifecycle) as any);
    try {
      await second.initialize();
      const revoked = database.getRemoteBinding();
      assert.equal(revoked.bindingState, 'revoked');
      assert.equal(revoked.remotePaired, false);
      assert.equal(revoked.pairId, '');
      assert.equal(database.getPendingRemoteRevocation(), null);
    } finally {
      second.dispose();
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
  await runScenario('success');
  await runScenario('credential_invalid');
});

test('revoked transport state persists repair_required and subsequent repair uses a fresh pairing session', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-4003-repair-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  bindRemoteFixture(database);
  const adapter = new FakeAdapter();
  adapter.connection = {
    ...connectionState(adapter.connection, 'repair_required'),
    bindingState: 'repair_required', connectorOnline: false, bridgeOnline: false, connecting: false
  };
  let beginInput: any = null;
  const lifecycle = {
    beginPairing: async (input: any) => {
      beginInput = input;
      return {
        sessionId: 'fresh-repair-session', pairingCode: '1111-2222-3333-4444-5555-6666',
        pollSecret: 'fresh-secret', expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    }
  };
  const shell = new ShellService(database, adapter as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(lifecycle) as any);
  try {
    await shell.initialize();
    const repaired = database.getRemoteBinding();
    assert.equal(repaired.bindingState, 'repair_required');
    assert.equal(repaired.remoteToken, 'fixture-token');
    await shell.beginRemotePairing({ repair: true, confirmed: true, expectedStateVersion: repaired.stateVersion });
    assert.equal(beginInput.replacementPairId, undefined);
    assert.equal(beginInput.currentToken, undefined);
  } finally {
    shell.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending pairing serializes repair/unbind and proof-bound cancel clears it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-pairing-serialization-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  const lifecycle = {
    beginPairing: async () => ({
      sessionId: 'serial-session', pairingCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', pollSecret: 'serial-secret',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }),
    cancelPairing: async () => 'cancelled' as const
  };
  const shell = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(lifecycle) as any);
  try {
    await shell.initialize();
    const initial = database.getRemoteBinding();
    await shell.beginRemotePairing({ repair: false, expectedStateVersion: initial.stateVersion });
    await assert.rejects(
      () => shell.beginRemotePairing({ repair: false, expectedStateVersion: initial.stateVersion }),
      (error: any) => error.code === 'REMOTE.LIFECYCLE_PENDING'
    );
    await assert.rejects(
      () => shell.revokeRemoteBinding({ confirmed: true, expectedStateVersion: initial.stateVersion }),
      (error: any) => error.code === 'REMOTE.LIFECYCLE_PENDING'
    );
    await shell.cancelRemotePairing();
    assert.equal(database.getPendingRemotePairing(), null);
    assert.equal(shell.snapshot().remotePairing.state, 'idle');
  } finally {
    shell.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pairing lifecycle is single-flight across double begin, begin-vs-revoke and begin-vs-cancel', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-pairing-singleflight-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  bindRemoteFixture(database);
  let resolveBegin!: (value: any) => void;
  let beginCalls = 0;
  const beginGate = new Promise<any>((resolve) => { resolveBegin = resolve; });
  const lifecycle = {
    beginPairing: async () => { beginCalls += 1; return beginGate; },
    cancelPairing: async () => 'cancelled' as const
  };
  const shell = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(lifecycle) as any);
  try {
    await shell.initialize();
    const current = database.getRemoteBinding();
    const first = shell.beginRemotePairing({ repair: true, confirmed: true, expectedStateVersion: current.stateVersion });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(database.getPendingRemotePairing()?.status, 'creating');
    await assert.rejects(
      () => shell.beginRemotePairing({ repair: true, confirmed: true, expectedStateVersion: current.stateVersion }),
      (error: any) => error.code === 'REMOTE.LIFECYCLE_PENDING'
    );
    await assert.rejects(
      () => shell.revokeRemoteBinding({ confirmed: true, expectedStateVersion: current.stateVersion }),
      (error: any) => error.code === 'REMOTE.LIFECYCLE_PENDING'
    );
    await assert.rejects(
      () => shell.cancelRemotePairing(),
      (error: any) => error.code === 'REMOTE.LIFECYCLE_PENDING'
    );
    assert.equal(database.getPendingRemotePairing()?.status, 'creating');
    assert.equal(beginCalls, 1);
    resolveBegin({
      sessionId: 'singleflight-session', pairingCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
      pollSecret: 'singleflight-secret', expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await first;
    assert.equal(database.getPendingRemotePairing()?.status, 'active');
    await shell.cancelRemotePairing();
    assert.equal(database.getPendingRemotePairing(), null);
  } finally {
    shell.dispose(); database.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('pairing poll and cancel are mutually exclusive and cancel cannot clear an in-flight poll', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-pairing-poll-cancel-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  let resolvePoll!: (value: any) => void;
  const pollGate = new Promise<any>((resolve) => { resolvePoll = resolve; });
  const lifecycle = {
    beginPairing: async () => ({
      sessionId: 'poll-cancel-session', pairingCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
      pollSecret: 'poll-cancel-secret', expiresAt: new Date(Date.now() + 60_000).toISOString()
    }),
    pollPairing: async () => pollGate,
    cancelPairing: async () => 'cancelled' as const
  };
  const shell = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(lifecycle) as any);
  try {
    await shell.initialize();
    const current = database.getRemoteBinding();
    await shell.beginRemotePairing({ repair: false, expectedStateVersion: current.stateVersion });
    const poll = shell.pollRemotePairing();
    await assert.rejects(() => shell.cancelRemotePairing(), (error: any) => error.code === 'REMOTE.LIFECYCLE_PENDING');
    assert.equal(database.getPendingRemotePairing()?.sessionId, 'poll-cancel-session');
    resolvePoll({ schemaVersion: 'omnia.v5.bridge/v1', state: 'waiting', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await poll;
    await shell.cancelRemotePairing();
    assert.equal(database.getPendingRemotePairing(), null);
  } finally {
    shell.dispose(); database.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('identity-mismatch matched candidate is durably cleaned after offline restart without overwriting current binding', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-pairing-cleanup-'));
  const filename = path.join(root, 'core.sqlite');
  const cipher = createTestContentCipher();
  let database = new CoreDatabase(filename, cipher);
  bindRemoteFixture(database);
  const original = database.getRemoteBinding();
  database.savePendingRemotePairing({
    sessionId: 'cleanup-session', pollSecret: 'cleanup-secret', bridgeUrl: original.bridgeUrl,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), expectedPairId: original.pairId,
    expectedGeneration: original.generation, expectedBindingState: 'bound', expectedStateVersion: original.stateVersion
  });
  database.saveRemoteBinding({
    bridgeUrl: original.bridgeUrl, pairId: 'pair-current-wins', token: 'current-token',
    connectorId: 'connector-current', connectorName: 'Current workstation', connectorVersion: '0.3.5',
    protocolVersion: 'omnia.v5.remote-connector/v2', generation: 9, expectedStateVersion: original.stateVersion
  });
  const matched: any = {
    schemaVersion: 'omnia.v5.remote-connector/v2', state: 'matched', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    pairId: 'pair-orphan-candidate', token: 'orphan-token', generation: 2,
    connector: { connectorId: 'connector-orphan', name: 'Orphan', version: '0.3.5', platform: 'win32-x64' }
  };
  const offline = {
    pollPairing: async () => matched,
    revoke: async () => { throw new AppError('REMOTE.REVOKE_FAILED', 'offline', true); }
  };
  const first = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(offline) as any);
  try {
    await first.initialize();
    assert.equal(database.getRemoteBinding().pairId, 'pair-current-wins');
    assert.equal(database.getPendingRemotePairing()?.cleanupRequired, true);
  } finally {
    first.dispose();
    database.close();
  }

  database = new CoreDatabase(filename, cipher);
  const online = { revoke: async () => undefined };
  const second = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge(online) as any);
  try {
    await second.initialize();
    assert.equal(database.getRemoteBinding().pairId, 'pair-current-wins');
    assert.equal(database.getPendingRemotePairing(), null);
  } finally {
    second.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('expired local code cannot clear an unstaged corrupt-proof tombstone or lifecycle gate', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-manual-pairing-reconcile-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  bindRemoteFixture(database);
  const bound = database.getRemoteBinding();
  database.savePendingRemotePairing({
    sessionId: 'manual-reconcile-session', pollSecret: 'proof-that-will-corrupt', bridgeUrl: bound.bridgeUrl,
    expiresAt: new Date(Date.now() - 60_000).toISOString(), expectedPairId: bound.pairId,
    expectedGeneration: bound.generation, expectedBindingState: 'bound', expectedStateVersion: bound.stateVersion
  });
  database.db.prepare(`UPDATE remote_pairing_pending SET poll_secret_ciphertext='enc:v1:not-valid' WHERE singleton=1`).run();
  const shell = new ShellService(database, new FakeAdapter() as any, new ChatService(database), undefined, undefined, {}, lifecycleWithBridge());
  try {
    await shell.initialize();
    const pending = database.getPendingRemotePairing();
    assert.equal(pending?.status, 'manual_reconcile_required');
    assert.equal(database.hasPendingRemoteLifecycleWork(), true);
    assert.match(shell.snapshot().remotePairing.message, /session hash/);
    assert.match(shell.snapshot().remotePairing.message, /recovery TTL/);
    await assert.rejects(
      () => shell.beginRemotePairing({ repair: true, confirmed: true, expectedStateVersion: database.getRemoteBinding().stateVersion }),
      (error: any) => error.code === 'REMOTE.LIFECYCLE_PENDING'
    );
    await assert.rejects(() => shell.cancelRemotePairing(), (error: any) => error.code === 'REMOTE.PAIRING_RECOVERY_REQUIRED');
    assert.equal(database.getPendingRemotePairing()?.status, 'manual_reconcile_required');
  } finally {
    shell.dispose(); database.close(); rmSync(root, { recursive: true, force: true });
  }
});
