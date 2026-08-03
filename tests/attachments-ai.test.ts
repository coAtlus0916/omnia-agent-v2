import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.ts';
import { createTestContentCipher } from '../src/main/content-cipher.ts';
import { AttachmentService } from '../src/main/services/attachment-service.ts';
import { ChatService, _test as chatTest } from '../src/main/services/chat-service.ts';

test('unsupported attachments are saved into chat before model delivery is honestly blocked', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-attachment-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source.png');
  fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const artifactsRoot = path.join(root, 'data', 'artifacts');
  const attachments = new AttachmentService(database, artifactsRoot);
  await attachments.importFiles([source]);
  const staged = database.listStagedAttachments(database.getChatSessionId());
  assert.equal(staged.length, 1);
  const internal = database.getAttachment(staged[0]!.id)!;
  assert.notEqual(internal.storedPath, source);
  assert.ok(internal.storedPath.startsWith(artifactsRoot));
  const ai = database.getAiSettings();
  database.saveAiSettings({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1/',
    model: 'deepseek-chat',
    attachmentCapability: 'text_only',
    apiKey: 'secret-that-must-not-be-plain',
    expectedStateVersion: ai.stateVersion
  });
  const raw = database.db.prepare('SELECT api_key_ciphertext FROM ai_provider_settings').get() as any;
  assert.match(raw.api_key_ciphertext, /^enc:v1:/);
  assert.equal(raw.api_key_ciphertext.includes('secret-that-must-not-be-plain'), false);
  const chat = new ChatService(database, async () => {
    throw new Error('fetch must not run for a blocked attachment');
  });
  await chat.send({ content: '请看图片', attachmentIds: [staged[0]!.id] });
  const blocked = database.getAttachment(staged[0]!.id)!;
  assert.equal(blocked.status, 'attached');
  assert.equal(blocked.modelDelivery, 'blocked');
  assert.match(blocked.error, /text_only/);
  const messages = database.listMessages(database.getChatSessionId());
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.status, 'failed');
  assert.equal(messages[0]?.attachments[0]?.id, blocked.id);
  assert.match(messages[0]?.error || '', /附件未送入模型/);
});

test('Provider SSRF guards reject literal private and link-local targets', () => {
  for (const url of [
    'https://127.0.0.1/v1/',
    'https://10.0.0.5/v1/',
    'https://169.254.169.254/latest/',
    'https://192.168.1.20/v1/',
    'https://localhost/v1/'
  ]) assert.throws(() => chatTest.validateProviderUrl(url), /本机、私网或链路本地/);
});

test('Main IPC preview target rejects an unknown binary even when called directly by ID', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-binary-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'payload.bin');
  fs.writeFileSync(source, Buffer.from([1, 2, 3]));
  const service = new AttachmentService(database, path.join(root, 'artifacts'));
  await service.importFiles([source]);
  const attachment = database.listStagedAttachments(database.getChatSessionId())[0]!;
  assert.equal(attachment.previewable, false);
  assert.throws(
    () => service.previewPath(attachment.id),
    (error: any) => error.code === 'CHAT.ATTACHMENT_PREVIEW_BLOCKED'
  );
});

test('Custom image capability sends a real image payload and records model delivery', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-image-send-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const source = path.join(root, 'tiny.png');
  fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const service = new AttachmentService(database, path.join(root, 'artifacts'));
  await service.importFiles([source]);
  const attachment = database.listStagedAttachments(database.getChatSessionId())[0]!;
  const settings = database.getAiSettings();
  database.saveAiSettings({
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:54321/v1/',
    model: 'vision-test',
    attachmentCapability: 'images',
    apiKey: 'test-key',
    expectedStateVersion: settings.stateVersion
  });
  let requestBody = '';
  const chat = new ChatService(database, async (_url, init) => {
    requestBody = String(init?.body || '');
    return new Response(JSON.stringify({
      choices: [{ message: { content: '已收到图片。' } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await chat.send({ content: '查看', attachmentIds: [attachment.id] });
  assert.match(requestBody, /data:image\/png;base64/);
  const messages = database.listMessages(database.getChatSessionId());
  assert.equal(messages[0]?.attachments[0]?.modelDelivery, 'sent');
  assert.equal(messages[1]?.content, '已收到图片。');
});
