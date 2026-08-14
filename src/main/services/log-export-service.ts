import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LogExportSnapshot } from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectorTransport } from '../connector/connector-transport.js';
import type { CoreDatabase } from '../database.js';
import { packArchive, type ArchiveEntry } from '../feature-artifact-archive.js';
import type { ProductPaths } from '../paths.js';
import type { InteractionLogService } from './interaction-log-service.js';

const MAX_LOCAL_LOG_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LOCAL_LOG_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_LOCAL_LOG_FILES = 500;
const LOG_EXTENSIONS = new Set(['.log', '.jsonl', '.txt', '.json']);
const IDENTITY_KEYS = new Set([
  'schemaversion', 'planid', 'storeRevision'.toLowerCase(), 'stage', 'state', 'status',
  'featureid', 'featureversion', 'runid', 'connectorid', 'sessiongeneration', 'engagementid',
  'authorityinstanceid', 'tenantororgid', 'packid', 'stateversion', 'safetystateversion',
  'workspaceid', 'workspaceids', 'artifactid', 'sourceartifactid', 'createdat', 'updatedat'
]);

const emptySnapshot = (): LogExportSnapshot => ({
  state: 'empty', available: false, exportId: '', fileName: '', generatedAt: '', localDate: '',
  size: 0, sha256: '', entryCount: 0, warnings: []
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const jsonLines = (rows: unknown[]): Buffer => Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
const safeText = (value: unknown, maximum = 1_000): string => String(value ?? '')
  .replace(/\b(Bearer|Basic|Pairing)\s+[^\s,;]+/giu, '$1 [redacted]')
  .replace(/\b(?:authorization|cookie|api[-_ ]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
  .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/gu, '[redacted-path]')
  .slice(0, maximum);

function localDay(now: Date): { localDate: string; since: string; until: string } {
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const start = new Date(year, month, date);
  const end = new Date(year, month, date + 1);
  const localDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
  return { localDate, since: start.toISOString(), until: end.toISOString() };
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function timestampFromLine(line: string): number | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['occurredAt', 'occurred_at', 'timestamp', 'createdAt', 'receivedAt', 'received_at']) {
        const parsed = Date.parse(String(value[key] || ''));
        if (Number.isFinite(parsed)) return parsed;
      }
    } catch { /* fall through to the ISO timestamp probe */ }
  }
  const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/u);
  if (!match) return null;
  const parsed = Date.parse(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function todayLines(bytes: Buffer, sinceMs: number, untilMs: number): Buffer | null {
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/u);
  const selected: string[] = [];
  let foundTimestamp = false;
  let includeContinuation = false;
  for (const line of lines) {
    const timestamp = timestampFromLine(line);
    if (timestamp !== null) {
      foundTimestamp = true;
      includeContinuation = timestamp >= sinceMs && timestamp < untilMs;
    }
    if (includeContinuation) selected.push(line);
  }
  if (!foundTimestamp) return bytes;
  if (!selected.length) return null;
  return Buffer.from(`${selected.join('\n').replace(/\n+$/u, '')}\n`, 'utf8');
}

function identityProjection(input: unknown, depth = 0): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 7) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    if (IDENTITY_KEYS.has(normalized)) {
      if (typeof value === 'string') output[key] = safeText(value, 512);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
      else if (Array.isArray(value) && value.length <= 200 && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
        output[key] = value.map((item) => typeof item === 'string' ? safeText(item, 512) : item);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = identityProjection(value, depth + 1);
        if (Object.keys(nested).length) output[key] = nested;
      }
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = identityProjection(value, depth + 1);
      if (Object.keys(nested).length) output[key] = nested;
    }
  }
  return output;
}

interface StoredPointer extends LogExportSnapshot {
  schemaVersion: 'omnia.log-export-pointer/v1';
  relativePath: string;
}

export interface LogExportContext {
  shellVersion: string;
  connection: Record<string, unknown>;
  connector: Record<string, unknown> | null;
  features: Array<Record<string, unknown>>;
}

export class LogExportService {
  private readonly exportRoot: string;
  private readonly pointerPath: string;
  private current: StoredPointer | null = null;

  constructor(
    private readonly database: CoreDatabase,
    private readonly paths: ProductPaths,
    private readonly interactionLogs: InteractionLogService,
    private readonly connector: ConnectorTransport,
    private readonly now: () => Date = () => new Date()
  ) {
    this.exportRoot = path.join(paths.data, 'log-exports');
    this.pointerPath = path.join(this.exportRoot, 'latest.json');
    fs.mkdirSync(this.exportRoot, { recursive: true });
    this.current = this.loadPointer();
  }

  snapshot(): LogExportSnapshot {
    if (!this.current) return emptySnapshot();
    const { schemaVersion: _schema, relativePath: _relativePath, ...snapshot } = this.current;
    return { ...snapshot, warnings: [...snapshot.warnings] };
  }

  private loadPointer(): StoredPointer | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.pointerPath, 'utf8')) as StoredPointer;
      if (value.schemaVersion !== 'omnia.log-export-pointer/v1' || !value.available || !value.exportId
        || path.basename(value.relativePath) !== value.relativePath) return null;
      const filename = path.join(this.exportRoot, value.relativePath);
      if (!within(this.exportRoot, filename)) return null;
      const bytes = fs.readFileSync(filename);
      if (bytes.length !== value.size || sha256(bytes) !== value.sha256) return null;
      return value;
    } catch { return null; }
  }

  private coreEntries(since: string, until: string, warnings: string[]): ArchiveEntry[] {
    const entries: ArchiveEntry[] = [];
    try {
      const runs = this.database.db.prepare(`
        SELECT run_id,trace_id,feature_id,feature_version,state,state_revision,plan_digest,last_error,created_at,updated_at
        FROM feature_runs WHERE updated_at>=? AND updated_at<? ORDER BY updated_at,run_id
      `).all(since, until) as Array<Record<string, unknown>>;
      entries.push({ name: 'shell/feature-runs.jsonl', bytes: jsonLines(runs.map((row) => ({
        ...row, last_error: safeText(row.last_error)
      }))) });
      const events = this.database.db.prepare(`
        SELECT event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at
        FROM feature_run_events WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at,event_id
      `).all(since, until) as Array<Record<string, unknown>>;
      entries.push({ name: 'shell/feature-run-events.jsonl', bytes: jsonLines(events.map((row) => {
        let details: Record<string, unknown> = {};
        try { details = identityProjection(JSON.parse(String(row.details_json || '{}'))); } catch { details = {}; }
        const { details_json: _details, ...safe } = row;
        return { ...safe, details };
      })) });
      const commands = this.database.db.prepare(`
        SELECT command_id,run_id,intent_id,operation_id,state,commit_point_at,submitted_at,completed_at,last_error,created_at
        FROM feature_commands
        WHERE created_at>=? AND created_at<? OR submitted_at>=? AND submitted_at<? OR completed_at>=? AND completed_at<?
        ORDER BY created_at,command_id
      `).all(since, until, since, until, since, until) as Array<Record<string, unknown>>;
      entries.push({ name: 'shell/feature-commands.jsonl', bytes: jsonLines(commands.map((row) => ({
        ...row, last_error: safeText(row.last_error)
      }))) });
    } catch (error) {
      warnings.push(`Shell Feature 运行日志读取失败：${safeText(error instanceof Error ? error.message : error)}`);
    }
    return entries;
  }

  private featurePlanEntries(warnings: string[]): ArchiveEntry[] {
    const featureRoot = path.join(this.paths.data, 'features');
    if (!fs.existsSync(featureRoot)) return [];
    const plans: Record<string, unknown>[] = [];
    try {
      for (const entry of fs.readdirSync(featureRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const storePath = path.join(featureRoot, entry.name, 'store.sqlite');
        if (!within(featureRoot, storePath) || !fs.existsSync(storePath)) continue;
        let store: DatabaseSync | null = null;
        try {
          store = new DatabaseSync(storePath, { readOnly: true });
          store.exec('PRAGMA busy_timeout=1000;');
          const table = store.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='__runtime_plans'`).get();
          if (!table) continue;
          const rows = store.prepare(`SELECT plan_id,payload_json,updated_at FROM "__runtime_plans" ORDER BY updated_at,plan_id LIMIT 5000`)
            .all() as Array<{ plan_id: string; payload_json: string; updated_at: string }>;
          for (const row of rows) {
            let identity: Record<string, unknown> = {};
            try { identity = identityProjection(JSON.parse(row.payload_json)); } catch { identity = { parseError: true }; }
            plans.push({ featureId: entry.name, planId: row.plan_id, updatedAt: row.updated_at, identity });
          }
          if (rows.length === 5000) warnings.push(`Feature ${entry.name} 的计划身份超过 5000 条，导出已停止。`);
        } catch (error) {
          warnings.push(`Feature ${entry.name} 的计划身份读取失败：${safeText(error instanceof Error ? error.message : error)}`);
        } finally { try { store?.close(); } catch { /* read-only diagnostic close */ } }
      }
    } catch (error) {
      warnings.push(`Feature 计划目录读取失败：${safeText(error instanceof Error ? error.message : error)}`);
    }
    return [{ name: 'shell/feature-plan-identities.jsonl', bytes: jsonLines(plans) }];
  }

  private localLogEntries(sinceMs: number, untilMs: number, warnings: string[]): ArchiveEntry[] {
    const roots = [
      { root: this.paths.logs, archive: 'local/shell-process-logs' },
      { root: path.join(this.paths.root, 'connector-next-data-v3', 'logs'), archive: 'local/connector-next-process-logs' }
    ];
    const entries: ArchiveEntry[] = [];
    let totalBytes = 0;
    for (const source of roots) {
      if (!fs.existsSync(source.root)) continue;
      const walk = (directory: string): void => {
        if (entries.length >= MAX_LOCAL_LOG_FILES) return;
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entries.length >= MAX_LOCAL_LOG_FILES) return;
          const absolute = path.join(directory, item.name);
          if (!within(source.root, absolute)) continue;
          if (item.isDirectory() && !item.isSymbolicLink()) { walk(absolute); continue; }
          if (!item.isFile() || item.isSymbolicLink() || !LOG_EXTENSIONS.has(path.extname(item.name).toLowerCase())) continue;
          try {
            const stat = fs.statSync(absolute);
            if (stat.mtimeMs < sinceMs || stat.mtimeMs >= untilMs) continue;
            if (stat.size > MAX_LOCAL_LOG_FILE_BYTES) {
              warnings.push(`本地日志 ${path.basename(absolute)} 超过 32 MB，未加入导出。`);
              continue;
            }
            if (totalBytes + stat.size > MAX_LOCAL_LOG_TOTAL_BYTES) {
              warnings.push('本地日志合计超过 128 MB，剩余文件未加入导出。');
              return;
            }
            const selected = todayLines(fs.readFileSync(absolute), sinceMs, untilMs);
            if (!selected) continue;
            totalBytes += selected.length;
            const relative = path.relative(source.root, absolute).split(path.sep).join('/');
            entries.push({ name: `${source.archive}/${relative}`, bytes: selected });
          } catch (error) {
            warnings.push(`本地日志 ${path.basename(absolute)} 读取失败：${safeText(error instanceof Error ? error.message : error)}`);
          }
        }
      };
      try { walk(source.root); }
      catch (error) { warnings.push(`本地日志目录读取失败：${safeText(error instanceof Error ? error.message : error)}`); }
    }
    if (entries.length >= MAX_LOCAL_LOG_FILES) warnings.push('本地日志文件超过 500 个，导出已停止。');
    return entries;
  }

  async generateToday(context: LogExportContext): Promise<LogExportSnapshot> {
    const now = this.now();
    const generatedAt = now.toISOString();
    const range = localDay(now);
    const sinceMs = Date.parse(range.since);
    const untilMs = Date.parse(range.until);
    const warnings: string[] = [];
    const entries: ArchiveEntry[] = [];

    const interactions = this.interactionLogs.exportRange(range.since, range.until);
    entries.push({ name: 'shell/interaction-logs.jsonl', bytes: jsonLines(interactions) });
    entries.push(...this.coreEntries(range.since, range.until, warnings));
    entries.push(...this.featurePlanEntries(warnings));

    if (this.connector.readDiagnosticLogs) {
      try {
        const result = await this.connector.readDiagnosticLogs({ since: range.since, until: range.until });
        entries.push({ name: 'connector-next/operational-logs.jsonl', bytes: jsonLines(result.records) });
        if (result.truncated) warnings.push(`Connector 日志扫描超过 ${result.scannedRecords} 条，结果不完整。`);
      } catch (error) {
        warnings.push(`Connector 日志读取失败：${safeText(error instanceof Error ? error.message : error)}`);
      }
    } else warnings.push('当前 Connector 未提供日志导出接口。');

    entries.push(...this.localLogEntries(sinceMs, untilMs, warnings));
    entries.push({ name: 'diagnostics/runtime-context.json', bytes: Buffer.from(`${JSON.stringify({
      schemaVersion: 'omnia.log-export-context/v1', generatedAt, localDate: range.localDate,
      range: { since: range.since, until: range.until }, ...context
    }, null, 2)}\n`, 'utf8') });

    const manifest = {
      schemaVersion: 'omnia.log-export/v1', generatedAt, localDate: range.localDate,
      range: { since: range.since, until: range.until }, complete: warnings.length === 0,
      warnings, entries: entries.map((entry) => ({ name: entry.name, size: entry.bytes.length, sha256: sha256(entry.bytes) }))
    };
    entries.unshift({ name: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') });
    const archive = packArchive(entries);
    const digest = sha256(archive);
    const exportId = randomUUID();
    const timeToken = generatedAt.replace(/\D/gu, '').slice(8, 17);
    const fileName = `omnia-agent-v5-logs-${range.localDate}-${timeToken}-${exportId.slice(0, 8)}.zip`;
    const target = path.join(this.exportRoot, fileName);
    if (!within(this.exportRoot, target)) throw new AppError('LOG_EXPORT.PATH_INVALID', '日志导出路径无效。');
    fs.writeFileSync(target, archive, { flag: 'wx', mode: 0o600 });

    const pointer: StoredPointer = {
      schemaVersion: 'omnia.log-export-pointer/v1',
      state: warnings.length ? 'partial' : 'ready', available: true, exportId, fileName,
      generatedAt, localDate: range.localDate, size: archive.length, sha256: digest,
      entryCount: entries.length, warnings, relativePath: fileName
    };
    const temporaryPointer = path.join(this.exportRoot, `latest.${exportId}.tmp`);
    fs.writeFileSync(temporaryPointer, `${JSON.stringify(pointer, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (fs.existsSync(this.pointerPath)) fs.rmSync(this.pointerPath, { force: true });
    fs.renameSync(temporaryPointer, this.pointerPath);
    const previous = this.current;
    this.current = pointer;
    if (previous?.relativePath && previous.relativePath !== pointer.relativePath) {
      const obsolete = path.join(this.exportRoot, previous.relativePath);
      if (within(this.exportRoot, obsolete)) {
        try { fs.rmSync(obsolete, { force: true }); } catch { /* latest pointer is already committed; orphan cleanup is best effort */ }
      }
    }
    return this.snapshot();
  }

  download(exportId: string): { source: string; suggestedName: string } {
    const pointer = this.current;
    if (!pointer || !pointer.available || pointer.exportId !== exportId) {
      throw new AppError('LOG_EXPORT.STALE', '日志导出已重新生成，请刷新后下载最新文件。', true);
    }
    const source = path.join(this.exportRoot, pointer.relativePath);
    if (!within(this.exportRoot, source) || !fs.existsSync(source)) {
      throw new AppError('LOG_EXPORT.UNAVAILABLE', '日志导出文件不可用，请重新生成。', true);
    }
    const bytes = fs.readFileSync(source);
    if (bytes.length !== pointer.size || sha256(bytes) !== pointer.sha256) {
      throw new AppError('LOG_EXPORT.INTEGRITY', '日志导出文件完整性校验失败，请重新生成。');
    }
    return { source, suggestedName: pointer.fileName };
  }
}

export const _test = { localDay, todayLines, identityProjection, safeText, emptySnapshot };
