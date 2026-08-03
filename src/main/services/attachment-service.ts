import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../shared/errors.js';
import type { CoreDatabase } from '../database.js';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const mediaTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function cleanFilename(value: string): string {
  const cleaned = path.basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return (cleaned || 'attachment').slice(0, 180);
}

function previewableMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/')
    || mediaType.startsWith('text/')
    || mediaType === 'application/pdf';
}

export class AttachmentService {
  constructor(
    private readonly database: CoreDatabase,
    private readonly artifactsRoot: string
  ) {}

  async importFiles(filenames: string[]): Promise<void> {
    await mkdir(this.artifactsRoot, { recursive: true });
    const sessionId = this.database.getChatSessionId();
    for (const source of filenames.slice(0, 20)) {
      const name = cleanFilename(source);
      const mediaType = mediaTypes[path.extname(name).toLowerCase()] || 'application/octet-stream';
      try {
        const sourceStat = await stat(source);
        if (!sourceStat.isFile()) throw new Error('所选项目不是文件。');
        if (sourceStat.size > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 50 MB 限制。');
        const directory = path.join(this.artifactsRoot, randomUUID());
        await mkdir(directory, { recursive: false });
        const target = path.join(directory, name);
        await copyFile(source, target);
        const bytes = await readFile(target);
        if (bytes.byteLength !== sourceStat.size) throw new Error('附件复制后的大小校验失败。');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        this.database.createAttachment({
          sessionId,
          name,
          mediaType,
          size: bytes.byteLength,
          sha256,
          storedPath: target
        });
      } catch (error) {
        this.database.createAttachment({
          sessionId,
          name,
          mediaType,
          size: 0,
          sha256: '',
          storedPath: '',
          status: 'failed',
          error: error instanceof Error ? error.message : '附件导入失败。'
        });
      }
    }
  }

  async remove(id: string): Promise<void> {
    const attachment = this.database.getAttachment(id);
    if (!attachment || attachment.messageId || !['staged', 'failed'].includes(attachment.status)) {
      throw new AppError('CHAT.ATTACHMENT_NOT_REMOVABLE', '只能移除尚未发送的附件。');
    }
    if (attachment.storedPath) {
      const relative = path.relative(this.artifactsRoot, attachment.storedPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new AppError('CHAT.INVALID_ARTIFACT_PATH', '附件路径不属于 v5 artifacts 目录。');
      }
      await rm(path.dirname(attachment.storedPath), { recursive: true, force: true });
    }
    this.database.updateAttachment(id, 'removed', '');
  }

  previewPath(id: string): string {
    const attachment = this.database.getAttachment(id);
    if (!attachment || attachment.status === 'removed' || !attachment.storedPath) {
      throw new AppError('CHAT.ATTACHMENT_UNAVAILABLE', '附件不可用。');
    }
    if (!previewableMediaType(attachment.mediaType)) {
      throw new AppError(
        'CHAT.ATTACHMENT_PREVIEW_BLOCKED',
        '该附件类型不允许由主进程直接打开预览。'
      );
    }
    const relative = path.relative(this.artifactsRoot, attachment.storedPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AppError('CHAT.INVALID_ARTIFACT_PATH', '附件路径不属于 v5 artifacts 目录。');
    }
    return attachment.storedPath;
  }
}

export const _test = { cleanFilename, previewableMediaType, MAX_ATTACHMENT_BYTES };
