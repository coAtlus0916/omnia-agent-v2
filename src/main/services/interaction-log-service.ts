import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  InteractionContext,
  InteractionLogEntry,
  InteractionLogPage,
  InteractionLogQuery,
  InteractionLogTrace,
  InteractionPlane
} from '../../shared/interaction-log-contracts.js';

const MAX_ROWS = 20_000;
const RETENTION_DAYS = 1;
const MAX_DETAILS_BYTES = 2_048;
const SECRET_KEY = /(api.?key|token|cookie|authorization|secret|password|credential|ciphertext|poll.?secret|pairing.?code|body|content|bytes|payload|request|response|path|filename)/iu;
const SAFE_DETAIL_KEYS = new Set([
  'featureId', 'featureVersion', 'surfaceId', 'actionId', 'operationId', 'effect', 'runId', 'commandId',
  'requestId', 'artifactId', 'confirmationId', 'connectorId', 'engagementId', 'workspaceId', 'workspaceIds',
  'sessionGeneration', 'stateVersion', 'expectedStateVersion', 'basename', 'extension', 'mediaType', 'sizeBytes',
  'sha256', 'count', 'status', 'httpStatus', 'retryable', 'sourceKind', 'repair', 'enabled', 'hasApiKeyChange'
]);

const utcNow = () => new Date().toISOString();
const cleanText = (value: unknown, maximum = 1000): string => {
  let text = String(value ?? '');
  text = text.replace(/\b(?:Bearer|Basic|Pairing)\s+[^\s,;]+/giu, '$1 [redacted]');
  text = text.replace(/\b(?:authorization|cookie|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]');
  text = text.replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/gu, '[redacted-path]');
  text = text.replace(/(?:^|[\s("'])(\/(?:[^\s"')]+\/)+[^\s"')]+)/gu, (match, absolute: string) => match.replace(absolute, '[redacted-path]'));
  return text.slice(0, maximum);
};

function safeDetails(input: unknown): Record<string, string | number | boolean | string[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.isBuffer(input) || input instanceof Uint8Array) return {};
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!SAFE_DETAIL_KEYS.has(key) || SECRET_KEY.test(key) || raw === null || raw === undefined) continue;
    if (key === 'basename') {
      const base = path.basename(String(raw)).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 180);
      if (base) result[key] = base;
    } else if (typeof raw === 'string') result[key] = cleanText(raw, 256);
    else if (typeof raw === 'number' && Number.isFinite(raw)) result[key] = raw;
    else if (typeof raw === 'boolean') result[key] = raw;
    else if (Array.isArray(raw) && raw.length <= 50 && raw.every((value) => typeof value === 'string')) {
      result[key] = raw.map((value) => cleanText(value, 128));
    }
  }
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_DETAILS_BYTES) {
    const key = Object.keys(result).at(-1);
    if (!key) break;
    delete result[key];
  }
  return result;
}

export interface InteractionDescriptor {
  plane: InteractionPlane;
  component: string;
  surface: string;
  action: string;
  failurePoint: string;
  details?: unknown;
  runId?: string;
  commandId?: string;
  requestId?: string;
  operationId?: string;
}

export class InteractionLogService {
  private readonly context = new AsyncLocalStorage<InteractionContext>();
  private completions = 0;

  constructor(private readonly database: DatabaseSync) {
    const recoveredAt = utcNow();
    this.database.prepare(`
      UPDATE interaction_logs SET phase='failure', severity='error', error_code='APP.PROCESS_INTERRUPTED',
        failure_point='core.startup_recovery', message='The previous Shell process ended before this interaction completed.',
        completed_at=?, duration_ms=MAX(0, CAST((julianday(?) - julianday(timestamp)) * 86400000 AS INTEGER))
      WHERE phase='start'
    `).run(recoveredAt, recoveredAt);
    this.prune();
  }

  current(): InteractionContext | undefined { return this.context.getStore(); }

  async run<T>(descriptor: InteractionDescriptor, action: () => T | Promise<T>, explicitParent?: InteractionContext): Promise<T> {
    const parent = explicitParent || this.current();
    const interactionId = randomUUID();
    const interaction: InteractionContext = {
      interactionId,
      traceId: parent?.traceId || interactionId,
      parentId: parent?.interactionId || ''
    };
    const startedAt = utcNow();
    const startedMs = Date.now();
    const details = safeDetails(descriptor.details);
    this.database.prepare(`
      INSERT INTO interaction_logs(
        event_id, interaction_id, trace_id, parent_id, timestamp, completed_at, duration_ms,
        plane, component, surface, action, phase, severity, error_code, failure_point, message,
        details_json, run_id, command_id, request_id, operation_id
      ) VALUES(?,?,?,?,?,'',0,?,?,?,?, 'start','info','','','',?,?,?,?,?)
    `).run(
      randomUUID(), interaction.interactionId, interaction.traceId, interaction.parentId, startedAt,
      descriptor.plane, cleanText(descriptor.component, 120), cleanText(descriptor.surface, 160),
      cleanText(descriptor.action, 160), JSON.stringify(details), cleanText(descriptor.runId, 128),
      cleanText(descriptor.commandId, 128), cleanText(descriptor.requestId, 128), cleanText(descriptor.operationId, 180)
    );
    return this.context.run(interaction, async () => {
      try {
        const value = await action();
        this.finish(interaction.interactionId, startedMs, 'success');
        return value;
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown; failurePoint?: unknown; location?: unknown };
        this.finish(
          interaction.interactionId, startedMs, 'failure',
          typeof candidate?.code === 'string' ? candidate.code : 'INTERNAL.ERROR',
          cleanText(candidate?.failurePoint || candidate?.location || descriptor.failurePoint, 240),
          error instanceof Error ? cleanText(error.message) : 'Unknown error.'
        );
        if (error && typeof error === 'object') {
          Object.defineProperties(error, {
            interactionId: { value: interaction.interactionId, configurable: true },
            traceId: { value: interaction.traceId, configurable: true },
            failurePoint: { value: cleanText(candidate?.failurePoint || candidate?.location || descriptor.failurePoint, 240), configurable: true }
          });
        }
        throw error;
      }
    });
  }

  private finish(interactionId: string, startedMs: number, phase: 'success' | 'failure', errorCode = '', failurePoint = '', message = ''): void {
    this.database.prepare(`
      UPDATE interaction_logs SET completed_at=?, duration_ms=?, phase=?, severity=?, error_code=?, failure_point=?, message=?
      WHERE interaction_id=? AND phase='start'
    `).run(utcNow(), Math.max(0, Date.now() - startedMs), phase, phase === 'failure' ? 'error' : 'info',
      cleanText(errorCode, 160), cleanText(failurePoint, 240), cleanText(message), interactionId);
    this.completions += 1;
    if (this.completions % 250 === 0) this.prune();
  }

  query(input: InteractionLogQuery): InteractionLogPage {
    const limit = Math.min(200, Math.max(1, Number(input.limit) || 100));
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (input.severity) { clauses.push('severity=?'); values.push(input.severity); }
    if (input.plane) { clauses.push('plane=?'); values.push(input.plane); }
    if (input.component) { clauses.push('component=?'); values.push(cleanText(input.component, 120)); }
    if (input.since && Number.isFinite(Date.parse(input.since))) { clauses.push('timestamp>=?'); values.push(input.since); }
    if (input.interactionId) {
      clauses.push('(interaction_id LIKE ? ESCAPE \'\\\' OR trace_id LIKE ? ESCAPE \'\\\' OR parent_id LIKE ? ESCAPE \'\\\')');
      const escaped = cleanText(input.interactionId, 128).replace(/[\\%_]/gu, '\\$&') + '%';
      values.push(escaped, escaped, escaped);
    }
    const rows = this.database.prepare(`
      SELECT * FROM interaction_logs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY timestamp DESC, event_id DESC LIMIT ?
    `).all(...values, limit + 1) as Record<string, unknown>[];
    return { entries: rows.slice(0, limit).map((row) => this.fromRow(row)), hasMore: rows.length > limit };
  }

  trace(traceId: string): InteractionLogTrace {
    const normalized = cleanText(traceId, 128);
    const rows = this.database.prepare('SELECT * FROM interaction_logs WHERE trace_id=? ORDER BY timestamp,event_id LIMIT 500')
      .all(normalized) as Record<string, unknown>[];
    return { traceId: normalized, entries: rows.map((row) => this.fromRow(row)) };
  }

  exportRange(since: string, until: string): InteractionLogEntry[] {
    if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) || since >= until) {
      throw new Error('INTERACTION_LOG.INVALID_EXPORT_RANGE');
    }
    const rows = this.database.prepare(`
      SELECT * FROM interaction_logs WHERE timestamp>=? AND timestamp<?
      ORDER BY timestamp, event_id
    `).all(since, until) as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }

  prune(): void {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    this.database.prepare("DELETE FROM interaction_logs WHERE timestamp<? AND phase<>'start'").run(cutoff);
    const excess = Number((this.database.prepare('SELECT MAX(0, COUNT(*)-?) AS count FROM interaction_logs').get(MAX_ROWS) as { count: number }).count || 0);
    if (excess > 0) {
      this.database.prepare(`
        DELETE FROM interaction_logs WHERE interaction_id IN (
          SELECT interaction_id FROM interaction_logs WHERE phase<>'start' ORDER BY timestamp, event_id LIMIT ?
        )
      `).run(excess);
    }
  }

  private fromRow(row: Record<string, unknown>): InteractionLogEntry {
    let details: InteractionLogEntry['details'] = {};
    try { details = JSON.parse(String(row.details_json || '{}')) as InteractionLogEntry['details']; } catch { details = {}; }
    return {
      eventId: String(row.event_id), interactionId: String(row.interaction_id), traceId: String(row.trace_id), parentId: String(row.parent_id),
      timestamp: String(row.timestamp), durationMs: Number(row.duration_ms), plane: row.plane as InteractionPlane,
      component: String(row.component), surface: String(row.surface), action: String(row.action),
      phase: row.phase as InteractionLogEntry['phase'], severity: row.severity as InteractionLogEntry['severity'],
      errorCode: String(row.error_code), failurePoint: String(row.failure_point), message: String(row.message), details,
      runId: String(row.run_id), commandId: String(row.command_id), requestId: String(row.request_id), operationId: String(row.operation_id)
    };
  }
}

export const _test = { cleanText, safeDetails, MAX_ROWS, RETENTION_DAYS };
