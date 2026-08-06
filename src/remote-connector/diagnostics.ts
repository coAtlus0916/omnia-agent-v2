import fs from 'node:fs';
import path from 'node:path';
import type {
  RemoteConnectorSupervisorEvent,
  RemoteConnectorSupervisorEventName
} from '../shared/bridge-contracts.js';
import type { RemoteConnectorPaths } from './managed-state.js';

const MAX_LOG_TAIL_BYTES = 64 * 1024;
const MAX_EVENTS = 20;
const EVENT_NAMES = new Map<string, RemoteConnectorSupervisorEventName>([
  ['Versioned Remote Connector worker exited; Supervisor will restart it.', 'worker_exited'],
  ['Versioned Remote Connector worker failed to start.', 'worker_start_failed'],
  ['Remote Connector Worker heartbeat remained stale; Supervisor is recovering the owned Worker.', 'worker_heartbeat_recovery'],
  ['Promoted a signed v5 Remote Connector candidate.', 'candidate_promoted'],
  ['Rolled back a failed v5 Remote Connector candidate.', 'candidate_rolled_back'],
  ['v5 Remote Connector automatic update check failed safely.', 'update_check_failed'],
  ['v5 Remote Connector Supervisor stopped after an unrecoverable error.', 'supervisor_failed']
]);

const limitedString = (value: unknown, maximum = 120): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum) : '';

export function redactDiagnosticText(value: unknown): string {
  return limitedString(value, 2_000)
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(authorization|cookie|token|secret|password|credential)\b\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/(?:https?|wss?):\/\/[^\s]+/giu, '[url]')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"']+/gu, '[path]')
    .replace(/\/(?:[^\s/]+\/){2,}[^\s"']*/gu, '[path]')
    .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/gu, '[redacted]')
    .slice(0, 300);
}

function tailFixedSupervisorLog(paths: RemoteConnectorPaths): string {
  const filename = path.join(paths.logs, 'supervisor.jsonl');
  let handle: number | null = null;
  try {
    handle = fs.openSync(filename, 'r');
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, MAX_LOG_TAIL_BYTES);
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    return '';
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

const validTimestamp = (value: unknown): string => {
  const text = limitedString(value, 40);
  return Number.isFinite(Date.parse(text)) ? text : '';
};

const integerOrNull = (value: unknown): number | null =>
  Number.isSafeInteger(value) ? Number(value) : null;

export function readSupervisorDiagnostics(paths: RemoteConnectorPaths): RemoteConnectorSupervisorEvent[] {
  const result: RemoteConnectorSupervisorEvent[] = [];
  for (const line of tailFixedSupervisorLog(paths).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const event = EVENT_NAMES.get(String(value.message || ''));
    const at = validTimestamp(value.at);
    if (!event || !at || !['info', 'warn', 'error'].includes(String(value.level || ''))) continue;
    result.push({
      at,
      level: value.level as 'info' | 'warn' | 'error',
      event,
      version: limitedString(value.version, 40),
      current: limitedString(value.current, 40),
      previous: limitedString(value.previous, 40),
      failedVersion: limitedString(value.failedVersion, 40),
      restoredVersion: limitedString(value.restoredVersion, 40),
      sequence: integerOrNull(value.sequence),
      exitCode: integerOrNull(value.code),
      signal: limitedString(value.signal, 32),
      error: redactDiagnosticText(value.error)
    });
  }
  return result.slice(-MAX_EVENTS);
}
