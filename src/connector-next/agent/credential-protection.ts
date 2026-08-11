import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const protectScript = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($value);$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))`;
const unprotectScript = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($value);$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))`;

export function protectConnectorNextCredential(value: string, dataRoot: string): string {
  if (process.platform === 'win32') {
    const encrypted = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', protectScript], { input: value, encoding: 'utf8', windowsHide: true }).trim();
    return `dpapi-current-user:${encrypted}`;
  }
  const keyFile = path.join(dataRoot, 'connector-next-development-secret-key-v3.bin');
  const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : randomBytes(32);
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, key, { flag: 'wx', mode: 0o600 });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `development-aes-gcm:${Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64')}`;
}

export function unprotectConnectorNextCredential(value: string, dataRoot: string): string {
  if (value.startsWith('dpapi-current-user:')) {
    if (process.platform !== 'win32') throw new Error('CONNECTOR_NEXT.DPAPI_UNAVAILABLE');
    return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', unprotectScript], { input: value.slice('dpapi-current-user:'.length), encoding: 'utf8', windowsHide: true });
  }
  if (value.startsWith('development-aes-gcm:')) {
    const key = fs.readFileSync(path.join(dataRoot, 'connector-next-development-secret-key-v3.bin'));
    const envelope = Buffer.from(value.slice('development-aes-gcm:'.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(0, 12));
    decipher.setAuthTag(envelope.subarray(12, 28));
    return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString('utf8');
  }
  throw new Error('CONNECTOR_NEXT.CREDENTIAL_SCHEME_INVALID');
}
