import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  REMOTE_CONNECTOR_DIAGNOSTICS_SCHEMA,
  type RemoteConnectorBridgeState,
  type RemoteConnectorDiagnostics,
  type RemoteConnectorDiagnosticsReport,
  type RemoteConnectorSupervisorEvent,
  type RemoteConnectorSupervisorEventName
} from '../shared/bridge-contracts.js';

export type BindingLifecycle = 'candidate' | 'active' | 'revoked';

export interface BridgeBinding {
  pairId: string;
  generation: number;
  connectorId: string;
  connectorName: string;
  connectorVersion: string;
  platform: string;
  protocol: string;
  lifecycle: BindingLifecycle;
  replacesPairId: string;
  createdAt: string;
  activatedAt: string;
  revokedAt: string;
  lastSeenAt: string;
  activationExpiresAt: string;
  readyAt: string;
  recoveryExpiresAt: string;
}

interface PairingSession {
  sessionId: string;
  codeHash: string;
  pollSecretHash: string;
  expiresAt: string;
  consumedAt: string;
  cancelledAt?: string;
  pairId: string;
  replacementPairId: string;
}

interface StoreDocument {
  schemaVersion: 'omnia.v5.bridge-binding-store/v1';
  bindings: BridgeBinding[];
  sessions: PairingSession[];
  diagnostics: RemoteConnectorDiagnostics[];
}

const emptyDocument = (): StoreDocument => ({
  schemaVersion: 'omnia.v5.bridge-binding-store/v1',
  bindings: [],
  sessions: [],
  diagnostics: []
});

const BRIDGE_STATES = new Set<RemoteConnectorBridgeState>([
  'unpaired', 'repair_required', 'connector_incompatible', 'connecting', 'connected', 'disconnected'
]);
const SUPERVISOR_EVENTS = new Set<RemoteConnectorSupervisorEventName>([
  'worker_exited', 'worker_start_failed', 'candidate_promoted', 'candidate_rolled_back',
  'update_check_failed', 'supervisor_failed'
]);
const timestamp = (value: unknown): string => {
  const text = typeof value === 'string' ? value.slice(0, 40) : '';
  return Number.isFinite(Date.parse(text)) ? text : '';
};
const identifier = (value: unknown, maximum = 127): string => {
  const text = typeof value === 'string' ? value.trim().slice(0, maximum) : '';
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(text) ? text : '';
};
const version = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim().slice(0, 40) : '';
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(text) ? text : '';
};
const nonnegative = (value: unknown, maximum = 1_000_000): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
const safeText = (value: unknown, maximum = 300): string => (typeof value === 'string' ? value : '')
  .replace(/[\u0000-\u001f\u007f]/gu, ' ')
  .replace(/\b(authorization|cookie|token|secret|password|credential)\b\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
  .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
  .replace(/(?:https?|wss?):\/\/[^\s]+/giu, '[url]')
  .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"']+/gu, '[path]')
  .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/gu, '[redacted]')
  .trim()
  .slice(0, maximum);

function normalizeSupervisorEvent(input: unknown): RemoteConnectorSupervisorEvent | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const at = timestamp(value.at);
  const event = String(value.event || '') as RemoteConnectorSupervisorEventName;
  const level = String(value.level || '');
  if (!at || !SUPERVISOR_EVENTS.has(event) || !['info', 'warn', 'error'].includes(level)) return null;
  return {
    at,
    level: level as RemoteConnectorSupervisorEvent['level'],
    event,
    version: version(value.version),
    current: version(value.current),
    previous: version(value.previous),
    failedVersion: version(value.failedVersion),
    restoredVersion: version(value.restoredVersion),
    sequence: nonnegative(value.sequence, Number.MAX_SAFE_INTEGER),
    exitCode: Number.isSafeInteger(value.exitCode) ? Number(value.exitCode) : null,
    signal: safeText(value.signal, 32),
    error: safeText(value.error)
  };
}

export function normalizeRemoteConnectorDiagnosticsReport(input: unknown): RemoteConnectorDiagnosticsReport | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const reportedAt = timestamp(value.reportedAt);
  const heartbeatAt = timestamp(value.heartbeatAt);
  const pairId = identifier(value.pairId, 80);
  const connectorId = identifier(value.connectorId);
  const connectorVersion = version(value.version);
  const pid = nonnegative(value.pid, 0x7fffffff);
  const activeOperations = nonnegative(value.activeOperations);
  const uncertainOperations = nonnegative(value.uncertainOperations);
  const bridgeState = String(value.bridgeState || '') as RemoteConnectorBridgeState;
  const managed = value.managed && typeof value.managed === 'object'
    ? value.managed as Record<string, unknown> : null;
  const highestSequence = nonnegative(managed?.highestSequence, Number.MAX_SAFE_INTEGER);
  if (
    value.schemaVersion !== REMOTE_CONNECTOR_DIAGNOSTICS_SCHEMA || !reportedAt || !heartbeatAt
    || !pairId || !connectorId || !connectorVersion || pid === null || pid <= 0
    || activeOperations === null || uncertainOperations === null || !BRIDGE_STATES.has(bridgeState)
    || !managed || highestSequence === null || !Array.isArray(value.supervisorEvents)
  ) return null;
  const pendingValue = managed.pending && typeof managed.pending === 'object'
    ? managed.pending as Record<string, unknown> : null;
  const pendingSequence = pendingValue ? nonnegative(pendingValue.sequence, Number.MAX_SAFE_INTEGER) : null;
  const pendingVersion = pendingValue ? version(pendingValue.version) : '';
  const pendingStagedAt = pendingValue ? timestamp(pendingValue.stagedAt) : '';
  if (pendingValue && (!pendingVersion || pendingSequence === null || !pendingStagedAt)) return null;
  return {
    schemaVersion: REMOTE_CONNECTOR_DIAGNOSTICS_SCHEMA,
    reportedAt,
    pairId,
    connectorId,
    version: connectorVersion,
    pid,
    bridgeState,
    bridgeReason: safeText(value.bridgeReason),
    heartbeatAt,
    activeOperations,
    uncertainOperations,
    managed: {
      current: version(managed.current),
      previous: version(managed.previous),
      pending: pendingValue ? { version: pendingVersion, sequence: pendingSequence!, stagedAt: pendingStagedAt } : null,
      highestSequence
    },
    supervisorEvents: value.supervisorEvents.slice(-20)
      .map(normalizeSupervisorEvent)
      .filter((event): event is RemoteConnectorSupervisorEvent => event !== null)
  };
}

function cloneDiagnostics(value: RemoteConnectorDiagnostics): RemoteConnectorDiagnostics {
  return {
    ...value,
    managed: { ...value.managed, pending: value.managed.pending ? { ...value.managed.pending } : null },
    supervisorEvents: value.supervisorEvents.map((event) => ({ ...event }))
  };
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class BridgeBindingStore {
  private document: StoreDocument;

  constructor(private readonly filename: string) {
    this.document = this.read();
    this.prune();
  }

  private read(): StoreDocument {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8')) as StoreDocument;
      if (parsed.schemaVersion !== 'omnia.v5.bridge-binding-store/v1') throw new Error('schema');
      if (!Array.isArray(parsed.bindings) || !Array.isArray(parsed.sessions)) throw new Error('shape');
      parsed.diagnostics = Array.isArray(parsed.diagnostics) ? parsed.diagnostics.flatMap((input) => {
        const report = normalizeRemoteConnectorDiagnosticsReport(input);
        if (!report || !input || typeof input !== 'object') return [];
        const value = input as unknown as Record<string, unknown>;
        return [{
          ...report,
          connectorOnline: value.connectorOnline === true,
          lastSeenAt: timestamp(value.lastSeenAt) || report.reportedAt,
          disconnectedAt: timestamp(value.disconnectedAt),
          closeCode: Number.isInteger(value.closeCode) && Number(value.closeCode) >= 0 && Number(value.closeCode) <= 4999
            ? Number(value.closeCode) : null,
          closeReason: safeText(value.closeReason, 120)
        }];
      }) : [];
      return parsed;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('Bridge binding store is unreadable.');
      return emptyDocument();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }

  private prune(): void {
    const now = Date.now();
    const before = this.document.sessions.length;
    this.document.sessions = this.document.sessions.filter((item) => {
      if (Date.parse(item.expiresAt) > now) return true;
      if (!item.pairId) return false;
      const binding = this.document.bindings.find((candidate) => candidate.pairId === item.pairId);
      return Boolean(
        binding
        && ['candidate', 'active'].includes(binding.lifecycle)
        && binding.readyAt
        && Date.parse(binding.recoveryExpiresAt) > now
      );
    });
    if (before !== this.document.sessions.length) this.save();
  }

  createSession(replacementPairId = ''): {
    sessionId: string;
    pairingCode: string;
    pollSecret: string;
    expiresAt: string;
  } {
    this.prune();
    if (replacementPairId) {
      const current = this.binding(replacementPairId);
      if (!current || current.lifecycle !== 'active') throw new Error('replacement binding is not active');
    }
    let pairingCode = '';
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const candidate = String(randomInt(0, 10_000)).padStart(4, '0');
      if (!this.document.sessions.some((session) => !session.consumedAt && !session.cancelledAt
        && Date.parse(session.expiresAt) > Date.now() && session.codeHash === digest(candidate))) {
        pairingCode = candidate; break;
      }
    }
    if (!pairingCode) throw new Error('pairing code space is exhausted');
    const pollSecret = randomBytes(32).toString('base64url');
    const session: PairingSession = {
      sessionId: `pairing-${randomUUID()}`,
      codeHash: digest(pairingCode),
      pollSecretHash: digest(pollSecret),
      expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      consumedAt: '',
      cancelledAt: '',
      pairId: '',
      replacementPairId
    };
    this.document.sessions.push(session);
    this.save();
    return { sessionId: session.sessionId, pairingCode, pollSecret, expiresAt: session.expiresAt };
  }

  consumeCode(input: {
    pairingCode: string;
    connectorId: string;
    connectorName: string;
    connectorVersion: string;
    platform: string;
    protocol: string;
  }): BridgeBinding {
    this.prune();
    const normalized = input.pairingCode.trim();
    if (!/^\d{4}$/u.test(normalized)) throw new Error('pairing code is invalid, expired, or already used');
    const session = this.document.sessions.find((item) => item.codeHash === digest(normalized));
    if (!session || session.consumedAt || session.cancelledAt || Date.parse(session.expiresAt) <= Date.now()) {
      throw new Error('pairing code is invalid, expired, or already used');
    }
    const previous = session.replacementPairId ? this.binding(session.replacementPairId) : null;
    if (session.replacementPairId && previous?.lifecycle !== 'active') {
      throw new Error('replacement binding is no longer active');
    }
    const now = new Date().toISOString();
    const binding: BridgeBinding = {
      pairId: `pair-${randomUUID()}`,
      generation: previous ? previous.generation + 1 : 1,
      connectorId: input.connectorId,
      connectorName: input.connectorName,
      connectorVersion: input.connectorVersion,
      platform: input.platform,
      protocol: input.protocol,
      lifecycle: 'candidate',
      replacesPairId: session.replacementPairId,
      createdAt: now,
      activatedAt: '',
      revokedAt: '',
      lastSeenAt: '',
      activationExpiresAt: session.expiresAt,
      readyAt: '',
      recoveryExpiresAt: ''
    };
    session.consumedAt = now;
    session.pairId = binding.pairId;
    this.document.bindings.push(binding);
    this.save();
    return { ...binding };
  }

  session(sessionId: string, pollSecret: string): {
    state: 'waiting' | 'candidate' | 'matched' | 'expired';
    expiresAt: string;
    binding: BridgeBinding | null;
  } | null {
    const session = this.document.sessions.find((item) => item.sessionId === sessionId);
    if (!session || digest(pollSecret) !== session.pollSecretHash) return null;
    if (session.cancelledAt) return { state: 'expired', expiresAt: session.expiresAt, binding: null };
    if (!session.pairId) {
      if (Date.parse(session.expiresAt) <= Date.now()) return { state: 'expired', expiresAt: session.expiresAt, binding: null };
      return { state: 'waiting', expiresAt: session.expiresAt, binding: null };
    }
    const binding = this.binding(session.pairId);
    if (binding?.lifecycle === 'active') return { state: 'matched', expiresAt: binding.recoveryExpiresAt || session.expiresAt, binding };
    if (binding?.lifecycle === 'candidate' && binding.readyAt && Date.parse(binding.recoveryExpiresAt) > Date.now()) {
      return { state: 'candidate', expiresAt: binding.recoveryExpiresAt, binding };
    }
    if (Date.parse(session.expiresAt) <= Date.now()) return { state: 'expired', expiresAt: session.expiresAt, binding: null };
    return {
      state: 'candidate',
      expiresAt: session.expiresAt,
      binding
    };
  }

  markReady(pairId: string): BridgeBinding | null {
    const binding = this.document.bindings.find((item) => item.pairId === pairId && item.lifecycle === 'candidate');
    if (!binding) return null;
    const deadline = binding.readyAt ? binding.recoveryExpiresAt : binding.activationExpiresAt;
    if (Date.parse(deadline) <= Date.now()) return null;
    if (binding.readyAt) {
      binding.lastSeenAt = new Date().toISOString();
      this.save();
      return { ...binding };
    }
    const now = new Date();
    binding.readyAt = now.toISOString();
    binding.recoveryExpiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    binding.lastSeenAt = binding.readyAt;
    this.save();
    return { ...binding };
  }

  commitSession(sessionId: string, pollSecret: string): BridgeBinding | null {
    const session = this.document.sessions.find((item) => item.sessionId === sessionId);
    if (!session || digest(pollSecret) !== session.pollSecretHash || !session.pairId || session.cancelledAt) return null;
    const binding = this.document.bindings.find((item) => item.pairId === session.pairId);
    if (binding?.lifecycle === 'active') return { ...binding };
    if (!binding?.readyAt) return null;
    return this.activate(binding.pairId);
  }

  cancelSession(sessionId: string, pollSecret: string): 'cancelled' | 'matched' | 'expired' | null {
    const session = this.document.sessions.find((item) => item.sessionId === sessionId);
    if (!session || digest(pollSecret) !== session.pollSecretHash) return null;
    if (session.cancelledAt) return 'expired';
    if (session.pairId) {
      const binding = this.document.bindings.find((item) => item.pairId === session.pairId);
      if (binding?.lifecycle === 'active') return 'matched';
      if (binding?.lifecycle === 'candidate') {
        if (binding.readyAt && Date.parse(binding.recoveryExpiresAt) <= Date.now()) {
          binding.lifecycle = 'revoked';
          binding.revokedAt = new Date().toISOString();
          session.cancelledAt = binding.revokedAt;
          this.save();
          return 'expired';
        }
        if (!binding.readyAt && Date.parse(session.expiresAt) <= Date.now()) {
          binding.lifecycle = 'revoked';
          binding.revokedAt = new Date().toISOString();
          session.cancelledAt = binding.revokedAt;
          this.save();
          return 'expired';
        }
        binding.lifecycle = 'revoked';
        binding.revokedAt = new Date().toISOString();
      }
    } else if (Date.parse(session.expiresAt) <= Date.now()) {
      return 'expired';
    }
    session.cancelledAt = new Date().toISOString();
    this.save();
    return 'cancelled';
  }

  activate(pairId: string): BridgeBinding | null {
    const binding = this.document.bindings.find((item) => item.pairId === pairId);
    if (!binding || !['candidate', 'active'].includes(binding.lifecycle)) return null;
    const activationDeadline = binding.readyAt ? binding.recoveryExpiresAt : binding.activationExpiresAt;
    if (binding.lifecycle === 'candidate' && Date.parse(activationDeadline) <= Date.now()) {
      binding.lifecycle = 'revoked';
      binding.revokedAt = new Date().toISOString();
      this.save();
      return null;
    }
    if (binding.lifecycle === 'candidate') {
      if (binding.replacesPairId) {
        const previous = this.document.bindings.find((item) => item.pairId === binding.replacesPairId);
        if (previous?.lifecycle !== 'active' || binding.generation !== previous.generation + 1) {
          binding.lifecycle = 'revoked';
          binding.revokedAt = new Date().toISOString();
          this.save();
          return null;
        }
      }
      const now = new Date().toISOString();
      binding.lifecycle = 'active';
      binding.activatedAt = now;
      binding.lastSeenAt = now;
      if (binding.replacesPairId) {
        const previous = this.document.bindings.find((item) => item.pairId === binding.replacesPairId);
        if (previous?.lifecycle === 'active') {
          previous.lifecycle = 'revoked';
          previous.revokedAt = now;
        }
      }
      this.save();
    }
    return { ...binding };
  }

  touch(pairId: string): void {
    const binding = this.document.bindings.find((item) => item.pairId === pairId && item.lifecycle === 'active');
    if (!binding) return;
    binding.lastSeenAt = new Date().toISOString();
    this.save();
  }

  updateDiagnostics(pairId: string, input: unknown): RemoteConnectorDiagnostics | null {
    const report = normalizeRemoteConnectorDiagnosticsReport(input);
    const binding = this.document.bindings.find((item) => item.pairId === pairId && item.lifecycle !== 'revoked');
    if (!report || !binding || report.pairId !== pairId || report.connectorId !== binding.connectorId) return null;
    const now = new Date().toISOString();
    const previous = this.document.diagnostics.find((item) => item.pairId === pairId);
    const next: RemoteConnectorDiagnostics = {
      ...report,
      connectorOnline: true,
      lastSeenAt: now,
      disconnectedAt: previous?.disconnectedAt || '',
      closeCode: previous?.closeCode ?? null,
      closeReason: previous?.closeReason || ''
    };
    this.document.diagnostics = this.document.diagnostics.filter((item) => item.pairId !== pairId);
    this.document.diagnostics.push(next);
    binding.connectorVersion = report.version;
    binding.lastSeenAt = now;
    this.save();
    return cloneDiagnostics(next);
  }

  recordDisconnect(pairId: string, code: number, reason: string, disconnectedAt = new Date().toISOString()): void {
    const diagnostics = this.document.diagnostics.find((item) => item.pairId === pairId);
    if (!diagnostics) return;
    diagnostics.connectorOnline = false;
    diagnostics.disconnectedAt = timestamp(disconnectedAt) || new Date().toISOString();
    diagnostics.closeCode = Number.isInteger(code) && code >= 0 && code <= 4999 ? code : null;
    diagnostics.closeReason = safeText(reason, 120);
    this.save();
  }

  diagnostics(pairId: string, connectorOnline: boolean): RemoteConnectorDiagnostics | null {
    const value = this.document.diagnostics.find((item) => item.pairId === pairId);
    return value ? cloneDiagnostics({ ...value, connectorOnline }) : null;
  }

  revoke(pairId: string): boolean {
    const binding = this.document.bindings.find((item) => item.pairId === pairId && item.lifecycle !== 'revoked');
    if (!binding) return false;
    binding.lifecycle = 'revoked';
    binding.revokedAt = new Date().toISOString();
    this.save();
    return true;
  }

  importLegacy(input: {
    pairId: string;
    connectorId: string;
    connectorName: string;
    connectorVersion: string;
    platform: string;
    protocol: string;
  }): BridgeBinding {
    const existing = this.binding(input.pairId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const binding: BridgeBinding = {
      pairId: input.pairId,
      generation: 1,
      connectorId: input.connectorId,
      connectorName: input.connectorName,
      connectorVersion: input.connectorVersion,
      platform: input.platform,
      protocol: input.protocol,
      lifecycle: 'active',
      replacesPairId: '',
      createdAt: now,
      activatedAt: now,
      revokedAt: '',
      lastSeenAt: '',
      activationExpiresAt: '',
      readyAt: now,
      recoveryExpiresAt: ''
    };
    this.document.bindings.push(binding);
    this.save();
    return { ...binding };
  }

  binding(pairId: string): BridgeBinding | null {
    const binding = this.document.bindings.find((item) => item.pairId === pairId);
    return binding ? { ...binding } : null;
  }
}

export const _test = { digest };
