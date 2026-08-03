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
