import { spawnSync } from 'node:child_process';

export type ProcessProbe = (pid: number, signal: 0) => void;

/** Permission-denied means the PID exists but cannot be inspected. Safety
 * gates must treat that state as live/unknown, never as evidence of exit. */
export function processIsAlive(pid: number, probe: ProcessProbe = process.kill): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return ['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code || ''));
  }
}

export function processStartTimeUtc(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'win32') return null;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
  ], { windowsHide: true, encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export type ProcessBirthMatch = 'match' | 'mismatch' | 'unknown';
export type ProcessIdentityState = 'absent' | 'alive_match' | 'alive_mismatch' | 'alive_unknown';

export function processBirthMatch(
  pid: number,
  recordedAt: string,
  toleranceMs = 0,
  dependencies: {
    isAlive?: (pid: number) => boolean;
    readStartTime?: (pid: number) => string | null;
  } = {}
): ProcessBirthMatch {
  if (!(dependencies.isAlive || processIsAlive)(pid)) return 'mismatch';
  if (process.platform !== 'win32') return 'unknown';
  const startedText = (dependencies.readStartTime || processStartTimeUtc)(pid);
  const startedAt = Date.parse(startedText || '');
  const authorityAt = Date.parse(recordedAt);
  if (!startedText || !Number.isFinite(startedAt) || !Number.isFinite(authorityAt)) return 'unknown';
  return startedAt <= authorityAt + toleranceMs ? 'match' : 'mismatch';
}

export function processIdentityState(pid: number, recordedAt: string): ProcessIdentityState {
  if (!processIsAlive(pid)) return 'absent';
  const birth = processBirthMatch(pid, recordedAt);
  if (birth === 'match') return 'alive_match';
  if (birth === 'mismatch') return 'alive_mismatch';
  return 'alive_unknown';
}

/** A token/status file can outlive its process and Windows can reuse its PID.
 * Signal ownership therefore requires both the durable logical proof and a
 * process birth no later than that proof (within spawn publication skew). */
export function pidMatchesRecordedBirth(pid: number, recordedAt: string, toleranceMs = 0): boolean {
  return processBirthMatch(pid, recordedAt, toleranceMs) === 'match';
}

export function pidMatchesExactStartTime(pid: number, processStartedAt: string): boolean {
  return processIsAlive(pid) && processStartTimeUtc(pid) === processStartedAt;
}
