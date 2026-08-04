import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { AppError } from '../shared/errors.js';
import { AesGcmContentCipher, type ContentCipher } from './content-cipher.js';

export function createWindowsProtectedContentCipher(storesDirectory: string): ContentCipher {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new AppError(
      'SECRET.WINDOWS_PROTECTION_UNAVAILABLE',
      'Windows 安全存储当前不可用；为避免明文保存客户数据，应用已停止启动。'
    );
  }
  const keyPath = path.join(storesDirectory, 'instance-dek.protected');
  let key: Buffer;
  if (fs.existsSync(keyPath)) {
    try {
      const wrapped = fs.readFileSync(keyPath);
      key = Buffer.from(safeStorage.decryptString(wrapped), 'base64');
      if (key.length !== 32) throw new Error('Invalid protected instance key length.');
    } catch {
      throw new AppError(
        'SECRET.INSTANCE_KEY_UNREADABLE',
        '当前 Windows 用户无法解包本实例的数据保护密钥。'
      );
    }
  } else {
    key = randomBytes(32);
    const wrapped = safeStorage.encryptString(key.toString('base64'));
    const temporary = `${keyPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, wrapped, { mode: 0o600 });
    fs.renameSync(temporary, keyPath);
  }
  return new AesGcmContentCipher(key);
}
