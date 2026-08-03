import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type {
  AiAttachmentCapability,
  AiProviderKind,
  ChatAttachment,
  ChatSnapshot
} from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type { CoreDatabase } from '../database.js';

const TEXT_MEDIA = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/xml', 'text/xml', 'application/yaml', 'text/yaml'
]);

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
      || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 198 && [18, 19].includes(octets[1]!))
      || octets[0]! >= 224;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1'
      || /^(fe[89ab]|f[cd])/.test(normalized)
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.');
  }
  return false;
}

function validateProviderUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError('AI.INVALID_BASE_URL', 'AI Base URL 无效。'); }
  const localTest = process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localTest) {
    throw new AppError('AI.HTTPS_REQUIRED', 'AI Provider 必须使用 HTTPS。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError('AI.INVALID_BASE_URL', 'AI Base URL 不能包含凭据、查询参数或片段。');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!localTest && (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || privateAddress(hostname)
  )) throw new AppError('AI.PRIVATE_NETWORK_BLOCKED', 'AI Provider 不能指向本机、私网或链路本地地址。');
  return url;
}

async function assertPublicProviderHost(url: URL): Promise<void> {
  if (process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return;
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => privateAddress(record.address))) {
    throw new AppError('AI.PRIVATE_NETWORK_BLOCKED', 'AI Provider DNS 解析到了本机、私网或链路本地地址。');
  }
}

const endpoint = (base: URL, route: string) =>
  new URL(route, base.href.endsWith('/') ? base.href : `${base.href}/`);

function supported(attachment: ChatAttachment, capability: AiAttachmentCapability): boolean {
  if (capability === 'text_only') return false;
  if (attachment.mediaType.startsWith('image/')) return true;
  return capability === 'images_and_text' && TEXT_MEDIA.has(attachment.mediaType);
}

async function validateModelAttachment(
  attachment: ChatAttachment & { storedPath: string }
): Promise<void> {
  if (attachment.mediaType.startsWith('image/')) {
    if (attachment.size > 10 * 1024 * 1024) throw new Error('图片超过 10 MB 模型输入限制。');
    return;
  }
  if (attachment.size > 1024 * 1024) throw new Error('文本附件超过 1 MB 模型输入限制。');
  const bytes = await readFile(attachment.storedPath);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export class ChatService {
  constructor(
    private readonly database: CoreDatabase,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  snapshot(): ChatSnapshot {
    const sessionId = this.database.getChatSessionId();
    const settings = this.database.getAiSettings();
    const ready = Boolean(settings.baseUrl && settings.model && settings.apiKey);
    return {
      sessionId,
      providerStatus: ready ? 'ready' : 'unconfigured',
      providerReason: ready ? '' : 'AI Provider 尚未完整配置。消息和附件会真实保存，但不会生成模拟回复。',
      messages: this.database.listMessages(sessionId),
      stagedAttachments: this.database.listStagedAttachments(sessionId),
      composerHeightPx: this.database.getComposerHeight()
    };
  }

  saveSettings(input: {
    provider: AiProviderKind;
    baseUrl: string;
    model: string;
    attachmentCapability: AiAttachmentCapability;
    apiKey?: string;
    clearApiKey?: boolean;
    expectedStateVersion: number;
  }): void {
    const baseUrl = validateProviderUrl(input.baseUrl.trim()).href;
    const model = input.model.trim();
    if (!model || model.length > 160) throw new AppError('AI.INVALID_MODEL', '模型名称不能为空或过长。');
    this.database.saveAiSettings({
      ...input,
      baseUrl,
      model,
      attachmentCapability: input.provider === 'deepseek' ? 'text_only' : input.attachmentCapability
    });
  }

  async testProvider(): Promise<void> {
    const settings = this.database.getAiSettings();
    if (!settings.apiKey) throw new AppError('AI.API_KEY_REQUIRED', '请先保存 API Key。');
    const base = validateProviderUrl(settings.baseUrl);
    this.database.updateAiTest('testing', '正在连接 Provider。');
    try {
      await assertPublicProviderHost(base);
      const response = await this.fetchImpl(endpoint(base, 'models'), {
        headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000)
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let payload: any;
      try { payload = JSON.parse(text); } catch { throw new Error('Provider 未返回 JSON。'); }
      if (!Array.isArray(payload?.data)) throw new Error('Provider 的 /models 返回不符合 OpenAI-compatible 合同。');
      const visible = payload.data.some((item: any) => String(item?.id || '') === settings.model);
      this.database.updateAiTest(
        'success',
        visible ? `连接成功，模型 ${settings.model} 可见。` : `连接成功；/models 未列出 ${settings.model}。`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.database.updateAiTest('failed', `连接测试失败：${message}`.slice(0, 1000));
      throw new AppError('AI.TEST_FAILED', `AI Provider 连接测试失败：${message}`, true);
    }
  }

  async send(input: { content: string; attachmentIds: string[] }): Promise<void> {
    const content = input.content.trim();
    const ids = [...new Set(input.attachmentIds)];
    if (!content && !ids.length) throw new AppError('CHAT.EMPTY_MESSAGE', '消息和附件不能同时为空。');
    if (content.length > 20_000) throw new AppError('CHAT.MESSAGE_TOO_LARGE', '单条消息不能超过 20,000 个字符。');
    const sessionId = this.database.getChatSessionId();
    const attachments = ids.map((id) => {
      const value = this.database.getAttachment(id);
      if (!value || value.status === 'removed' || value.messageId || value.sessionId !== sessionId) {
        throw new AppError('CHAT.INVALID_ATTACHMENT', '附件已被移除或不属于当前会话。');
      }
      if (value.status === 'failed') {
        this.database.updateAttachment(id, 'staged', '');
        this.database.updateAttachmentDelivery(id, 'not_attempted', '');
      }
      return value;
    });
    const settings = this.database.getAiSettings();
    const ready = Boolean(settings.baseUrl && settings.model && settings.apiKey);
    const userMessage = this.database.createMessage({ sessionId, role: 'user', content, status: 'sending' });
    this.database.attachToMessage(sessionId, userMessage.id, ids);
    if (ready) {
      const failures = new Map<string, string>();
      for (const item of attachments) {
        let failure = '';
        if (!supported(item, settings.attachmentCapability)) {
          failure = `当前 Provider 能力 ${settings.attachmentCapability} 不支持 ${item.mediaType}。`;
        } else {
          try { await validateModelAttachment(item); }
          catch (error) {
            failure = error instanceof TypeError
              ? '文本附件不是有效 UTF-8，无法安全送入模型。'
              : error instanceof Error ? error.message : '附件不满足模型输入限制。';
          }
        }
        if (failure) failures.set(item.id, failure);
      }
      if (failures.size) {
        for (const item of attachments) {
          const failure = failures.get(item.id)
            || '同一条消息包含当前 Provider 无法接收的附件，因此本次请求未发送。';
          this.database.updateAttachmentDelivery(item.id, 'blocked', `未送入模型：${failure}`);
        }
        const detail = attachments
          .filter((item) => failures.has(item.id))
          .map((item) => `${item.name}：${failures.get(item.id)}`)
          .join('；');
        this.database.updateMessage(userMessage.id, 'failed', `附件未送入模型：${detail}`.slice(0, 1000));
        return;
      }
    }
    if (!ready) {
      this.database.updateMessage(
        userMessage.id,
        'provider_unavailable',
        'AI Provider 尚未完整配置；消息和附件已安全保存，但未送入任何模型。'
      );
      return;
    }
    try {
      const history = this.database.listMessages(sessionId)
        .filter((message) => message.id !== userMessage.id && message.status !== 'failed')
        .slice(-24)
        .map((message) => ({ role: message.role, content: message.content || '（仅附件消息）' }));
      const currentContent: any[] = content ? [{ type: 'text', text: content }] : [];
      for (const attachment of attachments) {
        const bytes = await readFile(attachment.storedPath);
        if (attachment.mediaType.startsWith('image/')) {
          currentContent.push({
            type: 'image_url',
            image_url: { url: `data:${attachment.mediaType};base64,${bytes.toString('base64')}` }
          });
        } else {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          currentContent.push({
            type: 'text',
            text: `附件 ${attachment.name}（SHA-256 ${attachment.sha256}）\n${decoded}`
          });
        }
      }
      const base = validateProviderUrl(settings.baseUrl);
      await assertPublicProviderHost(base);
      const response = await this.fetchImpl(endpoint(base, 'chat/completions'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [...history, {
            role: 'user',
            content: attachments.length ? currentContent : content
          }],
          stream: false
        }),
        signal: AbortSignal.timeout(90_000)
      });
      const payload = await response.json() as any;
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      const assistantContent = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!assistantContent) throw new Error('Provider 未返回有效消息。');
      for (const item of attachments) this.database.updateAttachmentDelivery(item.id, 'sent', '');
      this.database.updateMessage(userMessage.id, 'delivered');
      this.database.createMessage({
        sessionId,
        role: 'assistant',
        content: assistantContent,
        status: 'delivered'
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      for (const item of attachments) {
        this.database.updateAttachmentDelivery(item.id, 'unconfirmed', '请求失败，无法确认 Provider 是否已接收该附件。');
      }
      this.database.updateMessage(userMessage.id, 'failed', `AI Provider 请求失败：${detail}`.slice(0, 1000));
    }
  }
}

export const _test = {
  validateProviderUrl,
  privateAddress,
  assertPublicProviderHost,
  supported,
  validateModelAttachment
};
