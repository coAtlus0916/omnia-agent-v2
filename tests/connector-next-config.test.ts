import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestContentCipher } from '../src/main/content-cipher.js';
import { CoreDatabase } from '../src/main/database.js';

test('Connector Next Core configuration round-trips exact target with encrypted control token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-next-core-config-'));
  const filename = path.join(root, 'core.sqlite');
  const cipher = createTestContentCipher();
  const token = 'connector-next-control-token-at-least-24-characters';
  const target = {
    agentId: 'omnia-agent-v5.agent.config-test',
    deviceId: 'omnia-agent-v5.device.config-test',
    connectorInstanceId: 'omnia.connector-next.instance.config-test'
  };
  try {
    let database = new CoreDatabase(filename, cipher);
    const saved = database.saveConnectorNextSettings({
      enabled: true,
      serverUrl: 'https://connector-next.example.test/connector-next/v3/',
      target,
      controlToken: token,
      validatedAt: '2026-08-11T00:00:00.000Z'
    });
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.target, target);
    const raw = database.db.prepare(`SELECT control_token_ciphertext FROM connector_next_settings WHERE singleton=1`).get() as { control_token_ciphertext: string };
    assert.notEqual(raw.control_token_ciphertext, token);
    assert.equal(JSON.stringify(raw).includes(token), false);
    const legacy = database.db.prepare(`SELECT token_ciphertext FROM remote_binding_settings WHERE singleton=1`).get() as { token_ciphertext: string };
    assert.equal(legacy.token_ciphertext, '', 'Next configuration never writes the legacy Remote binding token');
    database.close();

    database = new CoreDatabase(filename, cipher);
    assert.deepEqual(database.getConnectorNextSettings(), saved);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

