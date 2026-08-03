import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

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
}

const emptyDocument = (): StoreDocument => ({
  schemaVersion: 'omnia.v5.bridge-binding-store/v1',
  bindings: [],
  sessions: []
});

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
    // Hex keeps the displayed and normalized forms identical while retaining
    // 96 bits of entropy; base64url '_' was previously stripped by consumeCode.
    const raw = randomBytes(12).toString('hex').toUpperCase();
    const pairingCode = raw.match(/.{1,4}/g)!.join('-');
    const pollSecret = randomBytes(32).toString('base64url');
    const session: PairingSession = {
      sessionId: `pairing-${randomUUID()}`,
      codeHash: digest(raw),
      pollSecretHash: digest(pollSecret),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
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
    const normalized = input.pairingCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();
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
