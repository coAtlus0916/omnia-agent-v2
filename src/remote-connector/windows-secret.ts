import { spawnSync } from 'node:child_process';

const protectScript = [
  '$ErrorActionPreference="Stop"',
  'Add-Type -AssemblyName System.Security',
  '$plain=[Console]::In.ReadToEnd()',
  '$bytes=[Text.Encoding]::UTF8.GetBytes($plain)',
  '$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($cipher))'
].join(';');

const unprotectScript = [
  '$ErrorActionPreference="Stop"',
  'Add-Type -AssemblyName System.Security',
  '$cipher=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))'
].join(';');

function run(script: string, input: string): string {
  if (process.platform !== 'win32') {
    if (process.env.NODE_ENV === 'test') return Buffer.from(input).toString('base64');
    throw new Error('Remote Connector secret protection requires Windows DPAPI.');
  }
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input, encoding: 'utf8', windowsHide: true, timeout: 15_000 }
  );
  if (result.status !== 0) throw new Error('Windows DPAPI secret operation failed.');
  return String(result.stdout).trim();
}

export function protectRemoteSecret(value: string): string {
  return `dpapi:v1:${run(protectScript, value)}`;
}

export function unprotectRemoteSecret(value: string): string {
  if (!value.startsWith('dpapi:v1:')) throw new Error('Remote Connector credential is not DPAPI protected.');
  const payload = value.slice('dpapi:v1:'.length);
  if (process.platform !== 'win32' && process.env.NODE_ENV === 'test') {
    return Buffer.from(payload, 'base64').toString('utf8');
  }
  return run(unprotectScript, payload);
}
