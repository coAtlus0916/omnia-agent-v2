import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.ts';
import { createTestContentCipher } from '../src/main/content-cipher.ts';

function withDatabase(run: (database: CoreDatabase) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-db-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  try {
    run(database);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('Core migration creates a real empty feature registry and persistent defaults', () => {
  withDatabase((database) => {
    assert.equal(database.activeFeatureCount(), 0);
    assert.equal(database.getPreference().uiScalePercent, 100);
    assert.equal(database.getLayout().surfaceId, 'shell.main');
    assert.equal(database.getSafety().enabled, false);
    assert.ok(database.getChatSessionId());
  });
});

test('preference and layout writes use stateVersion conflict protection', () => {
  withDatabase((database) => {
    const preference = database.getPreference();
    const savedPreference = database.savePreference(90, preference.stateVersion);
    assert.equal(savedPreference.uiScalePercent, 90);
    assert.throws(
      () => database.savePreference(95, preference.stateVersion),
      (error: any) => error.code === 'PREFERENCE.CONFLICT'
    );

    const layout = database.getLayout();
    const savedLayout = database.saveLayout(700, 3000, layout.stateVersion);
    assert.equal(savedLayout.railBasisPoints, 700);
    assert.throws(
      () => database.saveLayout(750, 3100, layout.stateVersion),
      (error: any) => error.code === 'LAYOUT.CONFLICT'
    );
  });
});

test('chat message body and provider failure state are durable', () => {
  withDatabase((database) => {
    const sessionId = database.getChatSessionId();
    const message = database.createMessage({
      sessionId,
      role: 'user',
      content: '真实用户消息',
      status: 'sending'
    });
    database.updateMessage(message.id, 'provider_unavailable', 'Provider 未配置');
    const raw = database.db.prepare('SELECT content FROM chat_messages WHERE message_id=?').get(message.id) as { content: string };
    assert.equal(raw.content.includes('真实用户消息'), false);
    assert.match(raw.content, /^enc:v1:/);
    const stored = database.listMessages(sessionId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.content, '真实用户消息');
    assert.equal(stored[0]?.status, 'provider_unavailable');
    assert.equal(stored[0]?.error, 'Provider 未配置');
  });
});

test('migration 9 retires Local mode without projecting its cached connection and preserves audit evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-db-migration9-'));
  const filename = path.join(root, 'core.sqlite');
  const cipher = createTestContentCipher();
  let database = new CoreDatabase(filename, cipher);
  const cachedLocal = cipher.encrypt(JSON.stringify({ transport: 'local', connected: true, engagementName: 'stale local pack' }));
  database.db.exec(`CREATE TABLE connection_settings(singleton INTEGER PRIMARY KEY, mode TEXT NOT NULL, remote_bridge_url TEXT NOT NULL, remote_pair_id TEXT NOT NULL, remote_token_ciphertext TEXT NOT NULL, state_version INTEGER NOT NULL, updated_at TEXT NOT NULL); INSERT INTO connection_settings VALUES(1,'local','https://agent.labcaspian.com/v5-bridge/','','',1,'legacy');`);
  database.db.prepare(`UPDATE connection_settings SET mode='local', remote_pair_id='', remote_token_ciphertext='', state_version=7 WHERE singleton=1`).run();
  database.db.prepare(`INSERT OR REPLACE INTO connection_state(singleton,payload_json,updated_at) VALUES(1,?,'legacy')`).run(cachedLocal);
  database.db.exec('DROP TABLE remote_binding_settings; DROP TABLE connector_migration_audit; DELETE FROM schema_migrations WHERE version IN (9,10);');
  database.close();
  database = new CoreDatabase(filename, cipher);
  try {
    const binding = database.getRemoteBinding();
    assert.equal(binding.bindingState, 'unpaired');
    assert.equal(binding.remotePaired, false);
    assert.equal(binding.pairId, '');
    const audit = database.db.prepare('SELECT * FROM connector_migration_audit').get() as any;
    assert.equal(audit.legacy_mode, 'local');
    assert.equal(audit.decision, 'local_retired_remote_unpaired');
    assert.equal(audit.legacy_connection_snapshot_ciphertext, cachedLocal);
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='connection_settings'`).get() as any).count, 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh Remote-only database records a fresh unpaired decision, not a retired Local decision', () => {
  withDatabase((database) => {
    const audit = database.db.prepare('SELECT legacy_mode, decision FROM connector_migration_audit WHERE migration_version=9').get() as any;
    assert.equal(audit.legacy_mode, 'fresh_install');
    assert.equal(audit.decision, 'fresh_remote_unpaired');
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='connection_settings'`).get() as any).count, 0);
  });
});

test('undecryptable migrated Remote credential fails closed as repair_required', () => {
  withDatabase((database) => {
    database.db.prepare(`UPDATE remote_binding_settings SET lifecycle='bound', pair_id='pair-corrupt', token_ciphertext='enc:v1:not-valid', state_version=4 WHERE singleton=1`).run();
    const binding = database.getRemoteBinding();
    assert.equal(binding.bindingState, 'repair_required');
    assert.equal(binding.remotePaired, false);
    assert.equal(binding.remoteToken, '');
    assert.equal(binding.stateVersion, 5);
  });
});

test('migration 9 preserves a valid legacy Remote binding without asking for a new link code', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-db-remote-migration9-'));
  const filename = path.join(root, 'core.sqlite');
  const cipher = createTestContentCipher();
  let database = new CoreDatabase(filename, cipher);
  const tokenCiphertext = cipher.encrypt('legacy-remote-device-token');
  database.db.exec(`CREATE TABLE connection_settings(singleton INTEGER PRIMARY KEY, mode TEXT NOT NULL, remote_bridge_url TEXT NOT NULL, remote_pair_id TEXT NOT NULL, remote_token_ciphertext TEXT NOT NULL, state_version INTEGER NOT NULL, updated_at TEXT NOT NULL); INSERT INTO connection_settings VALUES(1,'local','https://agent.labcaspian.com/v5-bridge/','','',1,'legacy');`);
  database.db.prepare(`UPDATE connection_settings SET mode='remote', remote_bridge_url='https://bridge.example/v5/', remote_pair_id='pair-existing', remote_token_ciphertext=?, state_version=8 WHERE singleton=1`).run(tokenCiphertext);
  database.db.exec('DROP TABLE remote_binding_settings; DROP TABLE connector_migration_audit; DELETE FROM schema_migrations WHERE version IN (9,10);');
  database.close();
  database = new CoreDatabase(filename, cipher);
  try {
    const binding = database.getRemoteBinding();
    assert.equal(binding.bindingState, 'bound');
    assert.equal(binding.remotePaired, true);
    assert.equal(binding.pairId, 'pair-existing');
    assert.equal(binding.remoteToken, 'legacy-remote-device-token');
    assert.equal(binding.generation, 1);
    assert.equal(binding.protocolVersion, 'omnia.v5.remote-connector/v1');
    const audit = database.db.prepare('SELECT decision FROM connector_migration_audit').get() as any;
    assert.equal(audit.decision, 'migrated_remote_binding_pending_live_validation');
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration 11 records append-only non-secret binding lifecycle events in order', () => {
  withDatabase((database) => {
    const initial = database.getRemoteBinding();
    database.savePendingRemotePairing({
      sessionId: 'session-private-value', pollSecret: 'poll-private-value', bridgeUrl: initial.bridgeUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), expectedPairId: '', expectedGeneration: 0,
      expectedBindingState: 'unpaired', expectedStateVersion: initial.stateVersion
    });
    database.saveRemoteBinding({
      bridgeUrl: initial.bridgeUrl, pairId: 'pair-audit', token: 'token-private-value',
      connectorId: 'connector-audit', connectorName: 'Audit workstation', connectorVersion: '0.3.5',
      protocolVersion: 'omnia.v5.remote-connector/v2', generation: 1, expectedStateVersion: initial.stateVersion
    });
    const bound = database.getRemoteBinding();
    database.saveRemoteBinding({
      bridgeUrl: bound.bridgeUrl, pairId: 'pair-audit-replacement', token: 'replacement-token-private-value',
      connectorId: 'connector-audit-2', connectorName: 'Audit workstation 2', connectorVersion: '0.3.5',
      protocolVersion: 'omnia.v5.remote-connector/v2', generation: 2, expectedStateVersion: bound.stateVersion
    });
    const replacement = database.getRemoteBinding();
    database.markRemoteBindingRepairRequired(replacement.stateVersion);
    const repair = database.getRemoteBinding();
    database.beginRemoteRevocation(repair.stateVersion);
    database.completeRemoteRevocation();
    const events = database.db.prepare('SELECT event_type, details_json FROM remote_binding_events ORDER BY occurred_at, rowid').all() as any[];
    assert.deepEqual(events.map((event) => event.event_type), [
      'pairing_started', 'binding_activated', 'binding_replaced', 'repair_required', 'revocation_pending', 'revoked'
    ]);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('poll-private-value'), false);
    assert.equal(serialized.includes('token-private-value'), false);
    assert.equal(serialized.includes('replacement-token-private-value'), false);
    assert.equal(serialized.includes('session-private-value'), false);
  });
});

test('corrupt pending revocation ciphertext recovers only from the same binding credential', () => {
  withDatabase((database) => {
    const initial = database.getRemoteBinding();
    database.saveRemoteBinding({
      bridgeUrl: initial.bridgeUrl, pairId: 'pair-corrupt-revoke', token: 'valid-before-corruption',
      connectorId: 'connector-corrupt', connectorName: 'Corrupt workstation', connectorVersion: '0.3.5',
      protocolVersion: 'omnia.v5.remote-connector/v2', generation: 1, expectedStateVersion: initial.stateVersion
    });
    database.beginRemoteRevocation(database.getRemoteBinding().stateVersion);
    database.db.prepare(`UPDATE remote_revocation_pending SET token_ciphertext='enc:v1:not-valid' WHERE singleton=1`).run();
    const recovered = database.getPendingRemoteRevocation();
    assert.equal(recovered?.status, 'active');
    assert.equal(recovered?.token, 'valid-before-corruption');
    assert.equal(database.getRemoteBinding().bindingState, 'repair_required');
    assert.equal(database.hasPendingRemoteLifecycleWork(), true);
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM remote_binding_events WHERE event_type='revocation_pending_credential_recovered'`).get() as any).count, 1);
  });
});

test('corrupt revocation and binding credentials leave an indefinite manual-revoke tombstone', () => {
  withDatabase((database) => {
    const initial = database.getRemoteBinding();
    database.saveRemoteBinding({
      bridgeUrl: initial.bridgeUrl, pairId: 'pair-manual-revoke', token: 'will-corrupt-both',
      connectorId: 'connector-manual', connectorName: 'Manual workstation', connectorVersion: '0.3.5',
      protocolVersion: 'omnia.v5.remote-connector/v2', generation: 3, expectedStateVersion: initial.stateVersion
    });
    database.beginRemoteRevocation(database.getRemoteBinding().stateVersion);
    database.db.prepare(`UPDATE remote_revocation_pending SET token_ciphertext='enc:v1:bad' WHERE singleton=1`).run();
    database.db.prepare(`UPDATE remote_binding_settings SET token_ciphertext='enc:v1:also-bad' WHERE singleton=1`).run();
    const pending = database.getPendingRemoteRevocation();
    assert.equal(pending?.status, 'manual_revoke_required');
    assert.equal(pending?.token, '');
    assert.equal(database.hasPendingRemoteLifecycleWork(), true);
    assert.equal(database.getPendingRemoteRevocation()?.status, 'manual_revoke_required');
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM remote_binding_events WHERE event_type='revocation_pending_corrupt'`).get() as any).count, 1);
  });
});

test('corrupt unstaged pairing proof leaves an indefinite manual-reconcile tombstone', () => {
  withDatabase((database) => {
    const initial = database.getRemoteBinding();
    database.saveRemoteBinding({
      bridgeUrl: initial.bridgeUrl, pairId: 'pair-before-corrupt-pairing', token: 'old-token',
      connectorId: 'connector-old', connectorName: 'Old workstation', connectorVersion: '0.3.5',
      protocolVersion: 'omnia.v5.remote-connector/v2', generation: 4, expectedStateVersion: initial.stateVersion
    });
    const bound = database.getRemoteBinding();
    database.savePendingRemotePairing({
      sessionId: 'corrupt-session', pollSecret: 'will-be-corrupt', bridgeUrl: bound.bridgeUrl,
      expiresAt: new Date(Date.now() - 60_000).toISOString(), expectedPairId: bound.pairId,
      expectedGeneration: bound.generation, expectedBindingState: 'bound', expectedStateVersion: bound.stateVersion
    });
    assert.equal(database.hasPendingRemoteLifecycleWork(), true);
    database.db.prepare(`UPDATE remote_pairing_pending SET poll_secret_ciphertext='enc:v1:not-valid' WHERE singleton=1`).run();
    const tombstone = database.getPendingRemotePairing();
    assert.equal(tombstone?.status, 'manual_reconcile_required');
    assert.equal(tombstone?.sessionId, '');
    assert.ok(tombstone?.sessionIdHash);
    assert.equal(database.getRemoteBinding().bindingState, 'repair_required');
    assert.equal(database.hasPendingRemoteLifecycleWork(), true);
    assert.equal(database.getPendingRemotePairing()?.status, 'manual_reconcile_required');
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM remote_binding_events WHERE event_type='pairing_pending_corrupt'`).get() as any).count, 1);
  });
});

test('corrupt staged pairing cleanup token leaves an indefinite manual-cleanup tombstone', () => {
  withDatabase((database) => {
    const current = database.getRemoteBinding();
    database.savePendingRemotePairing({
      sessionId: 'cleanup-corrupt-session', pollSecret: 'valid-poll-proof', bridgeUrl: current.bridgeUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), expectedPairId: '', expectedGeneration: 0,
      expectedBindingState: 'unpaired', expectedStateVersion: current.stateVersion
    });
    database.stagePendingPairingCleanup('cleanup-corrupt-session', 'pair-needs-admin-revoke', 'candidate-token', 1);
    database.db.prepare(`UPDATE remote_pairing_pending SET matched_token_ciphertext='enc:v1:not-valid' WHERE singleton=1`).run();
    const tombstone = database.getPendingRemotePairing();
    assert.equal(tombstone?.status, 'manual_cleanup_required');
    assert.equal(tombstone?.matchedPairId, 'pair-needs-admin-revoke');
    assert.equal(tombstone?.matchedToken, '');
    assert.equal(database.hasPendingRemoteLifecycleWork(), true);
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM remote_binding_events WHERE event_type='pairing_pending_corrupt'`).get() as any).count, 1);
  });
});
