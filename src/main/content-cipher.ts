import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../shared/errors.js';

export interface ContentCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export class AesGcmContentCipher implements ContentCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Content encryption key must contain 32 bytes.');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${Buffer.concat([iv, tag, body]).toString('base64')}`;
  }

  decrypt(ciphertext: string): string {
    if (!ciphertext.startsWith('enc:v1:')) {
      throw new AppError('DATA.UNENCRYPTED_CONTENT', '检测到未加密的正文记录，已拒绝读取。');
    }
    const payload = Buffer.from(ciphertext.slice('enc:v1:'.length), 'base64');
    if (payload.length < 29) throw new AppError('DATA.CIPHERTEXT_INVALID', '正文密文格式无效。');
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const body = payload.subarray(28);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      throw new AppError('DATA.DECRYPT_FAILED', '正文无法使用当前 Windows 实例密钥解密。');
    }
  }
}

export function createTestContentCipher(): ContentCipher {
  return new AesGcmContentCipher(Buffer.alloc(32, 0x5a));
}
