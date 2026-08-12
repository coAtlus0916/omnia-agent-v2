import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectorBinding } from '../shared/operation-contracts.js';
import type { ManagedStreamChunk, ManagedStreamReadRequest } from '../shared/page-observation-contracts.js';

export const MANAGED_STREAM_CHUNK_BYTES = 128 * 1024;
export const MANAGED_STREAM_FROZEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MANAGED_STREAM_MAX_COUNT = 128;
export const MANAGED_STREAM_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const MANAGED_STREAM_QUARANTINE_MAX_COUNT = 64;
export const MANAGED_STREAM_QUARANTINE_MAX_BYTES = 256 * 1024 * 1024;
const STREAM_ID = /^stream_[0-9a-f]{32}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const OWNER_KEY = /^[0-9a-f]{64}$/u;
const STREAM_METADATA_SCHEMA = 'omnia.managed-stream-metadata/v1' as const;
const MAX_RECOVERY_STREAM_BYTES = 64 * 1024 * 1024;

export interface ManagedStreamOwner {
  ownerKey: string;
  packageDigest: string;
  packageSequence: number;
  capabilityFingerprint: string;
  binding: ConnectorBinding;
  compatibleSourceOwners?: Array<{ ownerKey: string; packageDigest: string }>;
}

type PersistedStreamRecord = {
  schemaVersion: typeof STREAM_METADATA_SCHEMA;
  streamId: string;
  ownerKey: string;
  packageDigest: string;
  packageSequence: number;
  capabilityFingerprint: string;
  binding: ConnectorBinding;
  mediaType: string;
  size: number;
  finalized: boolean;
  transferable: boolean;
  finalDigest: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

type StreamRecord = PersistedStreamRecord & {
  filename: string;
  metadataFilename: string;
  digest: crypto.Hash | null;
  integrityError: string | null;
};
type OwnerAdoption = {
  schemaVersion: 'omnia.managed-stream-owner-adoption/v2';
  streamId: string;
  physicalOwnerKey: string;
  physicalPackageDigest: string;
  physicalPackageSequence: number;
  capabilityFingerprint: string;
  currentOwnerKey: string;
  currentPackageDigest: string;
  currentPackageSequence: number;
  pendingOwnerKey: string | null;
  pendingPackageDigest: string | null;
  pendingPackageSequence: number | null;
  updatedAt: string;
};

type ManagedStreamHostOptions = {
  now?: () => number;
  frozenTtlMs?: number;
  maxStreamCount?: number;
  maxTotalBytes?: number;
  maxQuarantineCount?: number;
  maxQuarantineBytes?: number;
};

function opaqueStreamId(): string {
  return `stream_${crypto.randomBytes(16).toString('hex')}`;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unknown or missing fields.`);
  }
}

function bindingScope(binding: ConnectorBinding): string {
  return JSON.stringify([
    binding.connectorId,
    binding.engagementId,
    String(binding.authorityInstanceId || ''),
    String(binding.tenantOrOrgId || ''),
    String(binding.packId || '')
  ]);
}

function assertOwner(owner: ManagedStreamOwner): void {
  if (!owner || typeof owner !== 'object' || !OWNER_KEY.test(owner.ownerKey) || !DIGEST.test(owner.packageDigest)
    || !Number.isSafeInteger(owner.packageSequence) || owner.packageSequence < 1
    || !/^[0-9a-f]{64}$/u.test(owner.capabilityFingerprint)) {
    throw new Error('Managed stream resource owner is invalid.');
  }
  if (!owner.binding || typeof owner.binding !== 'object'
    || !owner.binding.connectorId || owner.binding.connectorId.length > 256
    || !Number.isSafeInteger(owner.binding.sessionGeneration) || owner.binding.sessionGeneration < 0
    || !owner.binding.engagementId) {
    throw new Error('Managed stream Connector binding is invalid.');
  }
  const sources = owner.compatibleSourceOwners ?? [];
  if (!Array.isArray(sources) || sources.length > 16 || sources.some((source, index) => (
    !source || typeof source !== 'object' || !OWNER_KEY.test(source.ownerKey) || !DIGEST.test(source.packageDigest)
    || source.packageDigest === owner.packageDigest
    || (index > 0 && sources[index - 1]!.packageDigest >= source.packageDigest)
  ))) throw new Error('Managed stream compatible source owners are invalid.');
}

function sha256File(filename: string): string {
  const digest = crypto.createHash('sha256');
  const handle = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(handle);
  }
  return digest.digest('hex');
}

export type LegacyManagedStreamQuarantineResult = {
  root: string;
  quarantined: number;
  repaired: number;
  alreadyQuarantined: number;
  failed: number;
  remainingOrphans: string[];
};

/**
 * Offline-safe preservation pass used before a new Connector worker is started.
 * It intentionally does not instantiate ManagedStreamHost, parse authenticated stream
 * metadata, or freeze an active stream. Only regular legacy stream_*.bin files with no
 * same-root metadata are moved into the forensic quarantine.
 */
export function quarantineLegacyManagedStreamOrphans(
  root: string,
  options: {
    now?: () => number;
    maxQuarantineCount?: number;
    maxQuarantineBytes?: number;
  } = {}
): LegacyManagedStreamQuarantineResult {
  const resolvedRoot = path.resolve(root);
  const quarantineRoot = path.join(resolvedRoot, 'legacy-orphans');
  const auditFilename = path.join(resolvedRoot, 'cleanup-audit.ndjson');
  const nowMs = options.now ?? Date.now;
  const maxCount = options.maxQuarantineCount ?? MANAGED_STREAM_QUARANTINE_MAX_COUNT;
  const maxBytes = options.maxQuarantineBytes ?? MANAGED_STREAM_QUARANTINE_MAX_BYTES;
  if (!Number.isSafeInteger(maxCount) || maxCount < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Legacy managed-stream quarantine quota is invalid.');
  }
  fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  const result: LegacyManagedStreamQuarantineResult = {
    root: resolvedRoot, quarantined: 0, repaired: 0, alreadyQuarantined: 0, failed: 0, remainingOrphans: []
  };
  let rootScanFailed = false;
  const audit = (identity: string, reason: string, details: Record<string, unknown> = {}) => {
    fs.appendFileSync(auditFilename, `${JSON.stringify({
      schemaVersion: 'omnia.connector-retention-audit/v1',
      occurredAt: new Date(nowMs()).toISOString(),
      kind: 'legacy_managed_stream', identity, reason, details
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  };
  const usage = (): { count: number; bytes: number } => {
    let count = 0;
    let bytes = 0;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(quarantineRoot, { withFileTypes: true }); } catch { return { count, bytes }; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^stream_[0-9a-f]{32}\.bin$/u.test(entry.name)) continue;
      try {
        const stat = fs.lstatSync(path.join(quarantineRoot, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        count += 1;
        bytes += stat.size;
      } catch { /* the subsequent exact operation remains fail-closed */ }
    }
    return { count, bytes };
  };
  const persistEvidence = (streamId: string, filename: string, size: number, digest: string, repaired: boolean) => {
    const evidenceFilename = path.join(quarantineRoot, `${streamId}.json`);
    const temporary = `${evidenceFilename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify({
        schemaVersion: 'omnia.legacy-managed-stream-quarantine/v1',
        streamId,
        filename,
        size,
        digest,
        quarantinedAt: new Date(nowMs()).toISOString(),
        reason: 'legacy_stream_missing_authenticated_metadata'
      }));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, evidenceFilename);
    audit(streamId, repaired ? 'quarantine_evidence_repaired' : 'orphan_quarantined', { size, digest });
  };

  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(resolvedRoot, { withFileTypes: true }); } catch (error) {
    rootScanFailed = true;
    audit('offline_scan', 'orphan_quarantine_scan_failed', {
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    });
    entries = [];
  }
  for (const entry of entries) {
    if (!/^stream_[0-9a-f]{32}\.bin$/u.test(entry.name)) continue;
    const streamId = entry.name.slice(0, -4);
    if (fs.existsSync(path.join(resolvedRoot, `${streamId}.json`))) continue;
    const source = path.join(resolvedRoot, entry.name);
    try {
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('orphan is not a regular file');
      const currentUsage = usage();
      if (currentUsage.count >= maxCount || currentUsage.bytes + stat.size > maxBytes) {
        throw new Error('orphan quarantine quota exceeded');
      }
      fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
      const digest = sha256File(source);
      const target = path.join(quarantineRoot, entry.name);
      if (fs.existsSync(target)) {
        const existing = fs.lstatSync(target);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== stat.size || sha256File(target) !== digest) {
          throw new Error('orphan quarantine collision');
        }
        result.alreadyQuarantined += 1;
        audit(streamId, 'orphan_already_quarantined', { size: stat.size, digest });
        throw new Error('identical quarantine target already exists while source remains');
      }
      if (fs.existsSync(path.join(resolvedRoot, `${streamId}.json`))) {
        throw new Error('managed stream metadata appeared during offline orphan quarantine');
      }
      fs.renameSync(source, target);
      persistEvidence(streamId, entry.name, stat.size, digest, false);
      result.quarantined += 1;
    } catch (error) {
      result.failed += 1;
      audit(streamId, 'orphan_quarantine_failed', {
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      });
    }
  }

  let quarantinedEntries: fs.Dirent[] = [];
  try { quarantinedEntries = fs.readdirSync(quarantineRoot, { withFileTypes: true }); } catch { quarantinedEntries = []; }
  for (const entry of quarantinedEntries) {
    if (!entry.isFile() || !/^stream_[0-9a-f]{32}\.bin$/u.test(entry.name)) continue;
    const streamId = entry.name.slice(0, -4);
    const evidenceFilename = path.join(quarantineRoot, `${streamId}.json`);
    if (fs.existsSync(evidenceFilename)) continue;
    try {
      const filename = path.join(quarantineRoot, entry.name);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
        throw new Error('quarantine evidence repair was refused');
      }
      persistEvidence(streamId, entry.name, stat.size, sha256File(filename), true);
      result.repaired += 1;
    } catch (error) {
      result.failed += 1;
      audit(streamId, 'quarantine_evidence_repair_failed', {
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      });
    }
  }
  try {
    result.remainingOrphans = fs.readdirSync(resolvedRoot, { withFileTypes: true })
      .filter((entry) => /^stream_[0-9a-f]{32}\.bin$/u.test(entry.name))
      .filter((entry) => !fs.existsSync(path.join(resolvedRoot, `${entry.name.slice(0, -4)}.json`)))
      .map((entry) => entry.name.slice(0, -4))
      .sort();
  } catch { rootScanFailed = true; result.remainingOrphans = []; }
  let missingEvidence = 0;
  try {
    missingEvidence = fs.readdirSync(quarantineRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^stream_[0-9a-f]{32}\.bin$/u.test(entry.name))
      .filter((entry) => !fs.existsSync(path.join(quarantineRoot, `${entry.name.slice(0, -4)}.json`)))
      .length;
  } catch { missingEvidence = 0; }
  result.failed = result.remainingOrphans.length + missingEvidence + (rootScanFailed ? 1 : 0);
  return result;
}

export class ManagedStreamHost {
  private readonly streams = new Map<string, StreamRecord>();
  private readonly ownerAdoptions = new Map<string, OwnerAdoption>();
  readonly root: string;
  private readonly nowMs: () => number;
  private readonly frozenTtlMs: number;
  private readonly maxStreamCount: number;
  private readonly maxTotalBytes: number;
  private readonly maxQuarantineCount: number;
  private readonly maxQuarantineBytes: number;
  private readonly auditFilename: string;
  private inventoryUnknownCount = 0;

  maintenanceSnapshot(): {
    activeStreams: number;
    integrityErrors: number;
    pendingOwnerAdoptions: number;
    inventoryUnknownCount: number;
  } {
    return {
      activeStreams: [...this.streams.values()].filter((stream) => !stream.finalized).length,
      integrityErrors: [...this.streams.values()].filter((stream) => Boolean(stream.integrityError)).length,
      pendingOwnerAdoptions: [...this.ownerAdoptions.values()].filter((adoption) => adoption.pendingOwnerKey !== null).length,
      inventoryUnknownCount: this.inventoryUnknownCount
    };
  }

  ownedResourceSnapshot(packageDigest: string, binding: ConnectorBinding): {
    state: 'known' | 'unknown';
    count: number;
  } {
    if (this.inventoryUnknownCount > 0) return { state: 'unknown', count: 0 };
    const sameStableBinding = (candidate: ConnectorBinding) => (
      candidate.connectorId === binding.connectorId
      && candidate.engagementId === binding.engagementId
      && String(candidate.authorityInstanceId || '') === String(binding.authorityInstanceId || '')
      && String(candidate.tenantOrOrgId || '') === String(binding.tenantOrOrgId || '')
      && String(candidate.packId || '') === String(binding.packId || '')
    );
    return {
      state: 'known',
      count: [...this.streams.values()].filter((stream) => (
        stream.packageDigest === packageDigest && sameStableBinding(stream.binding)
      )).length
    };
  }

  constructor(root: string, options: ManagedStreamHostOptions = {}) {
    this.root = path.resolve(root);
    this.nowMs = options.now ?? Date.now;
    this.frozenTtlMs = options.frozenTtlMs ?? MANAGED_STREAM_FROZEN_TTL_MS;
    this.maxStreamCount = options.maxStreamCount ?? MANAGED_STREAM_MAX_COUNT;
    this.maxTotalBytes = options.maxTotalBytes ?? MANAGED_STREAM_MAX_TOTAL_BYTES;
    this.maxQuarantineCount = options.maxQuarantineCount ?? MANAGED_STREAM_QUARANTINE_MAX_COUNT;
    this.maxQuarantineBytes = options.maxQuarantineBytes ?? MANAGED_STREAM_QUARANTINE_MAX_BYTES;
    if (!Number.isSafeInteger(this.frozenTtlMs) || this.frozenTtlMs < 60_000) {
      throw new Error('Managed stream frozen TTL is invalid.');
    }
    if (!Number.isSafeInteger(this.maxStreamCount) || this.maxStreamCount < 1
      || !Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 1
      || !Number.isSafeInteger(this.maxQuarantineCount) || this.maxQuarantineCount < 1
      || !Number.isSafeInteger(this.maxQuarantineBytes) || this.maxQuarantineBytes < 1) {
      throw new Error('Managed stream storage quota is invalid.');
    }
    this.auditFilename = path.join(this.root, 'cleanup-audit.ndjson');
    fs.mkdirSync(this.root, { recursive: true });
    const quarantine = quarantineLegacyManagedStreamOrphans(this.root, {
      now: this.nowMs,
      maxQuarantineCount: this.maxQuarantineCount,
      maxQuarantineBytes: this.maxQuarantineBytes
    });
    if (quarantine.failed > 0 || quarantine.remainingOrphans.length > 0) {
      throw new Error(
        `Legacy managed-stream preservation failed closed (${quarantine.failed} failures, `
        + `${quarantine.remainingOrphans.length} remaining orphan files).`
      );
    }
    this.loadPersistedStreams();
    this.loadOwnerAdoptions();
  }

  create(owner: ManagedStreamOwner, mediaType: string): string {
    assertOwner(owner);
    if (!/^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/iu.test(mediaType)) {
      throw new Error('Managed stream media type is invalid.');
    }
    this.pruneExpired();
    if (this.streams.size >= this.maxStreamCount || this.managedBytes() >= this.maxTotalBytes) {
      this.audit('managed_stream_storage', owner.ownerKey, 'quota_rejected_create', this.managedUsage());
      throw new Error('Managed stream storage quota is full; retained frozen evidence was not evicted.');
    }
    let streamId = opaqueStreamId();
    while (this.streams.has(streamId) || fs.existsSync(this.dataFilename(streamId))) streamId = opaqueStreamId();
    const filename = this.dataFilename(streamId);
    const metadataFilename = this.metadataFilename(streamId);
    const handle = fs.openSync(filename, 'wx', 0o600);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    const timestamp = new Date(this.nowMs()).toISOString();
    const record: StreamRecord = {
      schemaVersion: STREAM_METADATA_SCHEMA,
      streamId,
      ownerKey: owner.ownerKey,
      packageDigest: owner.packageDigest,
      packageSequence: owner.packageSequence,
      capabilityFingerprint: owner.capabilityFingerprint,
      binding: { ...owner.binding },
      mediaType,
      size: 0,
      finalized: false,
      transferable: false,
      finalDigest: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(this.nowMs() + this.frozenTtlMs).toISOString(),
      filename,
      metadataFilename,
      digest: crypto.createHash('sha256'),
      integrityError: null
    };
    this.persist(record);
    this.streams.set(streamId, record);
    return streamId;
  }

  append(owner: ManagedStreamOwner, streamId: string, bytes: Uint8Array): { offset: number; nextOffset: number } {
    const stream = this.owned(owner, streamId);
    if (stream.finalized || !stream.digest) throw new Error('Managed stream is already finalized.');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) throw new Error('Managed stream append is empty.');
    const payload = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (stream.size + payload.byteLength > MAX_RECOVERY_STREAM_BYTES
      || this.managedBytes() + payload.byteLength > this.maxTotalBytes) {
      this.audit('managed_stream_storage', streamId, 'quota_rejected_append', {
        ...this.managedUsage(), requestedBytes: payload.byteLength
      });
      throw new Error('Managed stream storage quota is full; retained frozen evidence was not evicted.');
    }
    const offset = stream.size;
    const handle = fs.openSync(stream.filename, 'a');
    try {
      fs.writeSync(handle, payload);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    stream.digest.update(payload);
    stream.size += payload.byteLength;
    stream.updatedAt = new Date(this.nowMs()).toISOString();
    this.persist(stream);
    return { offset, nextOffset: stream.size };
  }

  finalize(owner: ManagedStreamOwner, streamId: string, transferable = false): void {
    const stream = this.owned(owner, streamId);
    if (stream.finalized) return;
    const handle = fs.openSync(stream.filename, 'r+');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    stream.finalized = true;
    stream.transferable = transferable;
    stream.finalDigest = stream.digest!.digest('hex');
    stream.digest = null;
    stream.updatedAt = new Date(this.nowMs()).toISOString();
    stream.expiresAt = new Date(this.nowMs() + this.frozenTtlMs).toISOString();
    this.persist(stream);
  }

  async read(owner: ManagedStreamOwner, input: ManagedStreamReadRequest): Promise<ManagedStreamChunk> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Managed stream read is invalid.');
    exactKeys(input, ['schemaVersion', 'streamId', 'offset', ...(input.maxBytes === undefined ? [] : ['maxBytes'])], 'Managed stream read');
    if (input.schemaVersion !== 'omnia.managed-stream-read/v1') throw new Error('Managed stream read schema is invalid.');
    this.pruneExpired();
    const stream = this.owned(owner, input.streamId);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > stream.size) {
      throw new Error('Managed stream offset is outside the available stream.');
    }
    const requested = input.maxBytes === undefined ? MANAGED_STREAM_CHUNK_BYTES : input.maxBytes;
    if (requested !== MANAGED_STREAM_CHUNK_BYTES) {
      throw new Error(`Managed stream chunks use the fixed ${MANAGED_STREAM_CHUNK_BYTES}-byte size.`);
    }
    if (input.offset % MANAGED_STREAM_CHUNK_BYTES !== 0) {
      throw new Error(`Managed stream offset must align to ${MANAGED_STREAM_CHUNK_BYTES}-byte chunks.`);
    }
    const committedBytes = stream.finalized ? stream.size : stream.size - (stream.size % MANAGED_STREAM_CHUNK_BYTES);
    if (input.offset > committedBytes) throw new Error('Managed stream offset is ahead of committed bytes.');
    const ready = input.offset < committedBytes || (stream.finalized && input.offset === stream.size);
    const byteLength = ready ? Math.min(requested, committedBytes - input.offset) : 0;
    const bytes = Buffer.allocUnsafe(byteLength);
    if (byteLength) {
      const handle = await fs.promises.open(stream.filename, 'r');
      try {
        const result = await handle.read(bytes, 0, byteLength, input.offset);
        if (result.bytesRead !== byteLength) throw new Error('Managed stream changed during a bounded read.');
      } finally {
        await handle.close();
      }
    }
    const nextOffset = input.offset + byteLength;
    return {
      schemaVersion: 'omnia.managed-stream-chunk/v1',
      streamId: stream.streamId,
      mediaType: stream.mediaType,
      offset: input.offset,
      nextOffset,
      availableBytes: stream.size,
      ready,
      bytesBase64: bytes.toString('base64'),
      chunkDigest: ready ? crypto.createHash('sha256').update(bytes).digest('hex') : null,
      streamDigest: stream.finalDigest,
      eof: ready && stream.finalized && nextOffset === stream.size
    };
  }

  releaseOwner(owner: ManagedStreamOwner): void {
    assertOwner(owner);
    for (const stream of this.streams.values()) {
      if (stream.packageDigest !== owner.packageDigest || stream.ownerKey !== owner.ownerKey || stream.finalized) continue;
      this.finalize(owner, stream.streamId, false);
    }
  }

  close(): void {
    // Durable frozen evidence belongs to the signed resource owner and its TTL, not to this process.
    this.pruneExpired();
  }

  streamExpiresAt(streamId: string): string | null {
    return this.streams.get(streamId)?.expiresAt ?? null;
  }

  hasReadableStream(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    return Boolean(stream && !stream.integrityError);
  }

  preflightOwnerRegistration(owner: ManagedStreamOwner): void {
    assertOwner(owner);
    for (const [streamId, adoption] of this.ownerAdoptions) {
      const stream = this.streams.get(streamId);
      if (!stream || bindingScope(stream.binding) !== bindingScope(owner.binding)) continue;
      const related = adoption.physicalOwnerKey === owner.ownerKey
        || adoption.currentOwnerKey === owner.ownerKey
        || adoption.pendingOwnerKey === owner.ownerKey
        || owner.compatibleSourceOwners?.some((source) => source.ownerKey === adoption.physicalOwnerKey) === true;
      if (!related) continue;
      if (!this.ownerAdoptionAllows(streamId, owner)) {
        throw new Error('Operation resource owner is below or outside the durable managed-stream owner high-water mark.');
      }
    }
  }

  adoptOwner(source: ManagedStreamOwner, successor: ManagedStreamOwner, streamId: string): void {
    assertOwner(source);
    assertOwner(successor);
    if (bindingScope(source.binding) !== bindingScope(successor.binding)
      || successor.packageSequence <= source.packageSequence
      || successor.capabilityFingerprint !== source.capabilityFingerprint) {
      throw new Error('Managed stream owner adoption is not a monotonic compatible handoff.');
    }
    const existing = this.ownerAdoptions.get(streamId);
    if (existing) {
      this.owned(source, streamId);
      if (existing.currentOwnerKey !== source.ownerKey
        || existing.currentPackageDigest !== source.packageDigest
        || existing.currentPackageSequence !== source.packageSequence
        || existing.capabilityFingerprint !== successor.capabilityFingerprint) {
        throw new Error('Managed stream owner adoption source is not the durable current owner.');
      }
      const exactPending = existing.pendingOwnerKey === successor.ownerKey
        && existing.pendingPackageDigest === successor.packageDigest
        && existing.pendingPackageSequence === successor.packageSequence;
      if (existing.pendingPackageDigest !== null && !exactPending) {
        throw new Error('Managed stream already has another pending owner handoff.');
      }
      if (!exactPending) {
        const updated: OwnerAdoption = {
          ...existing,
          pendingOwnerKey: successor.ownerKey,
          pendingPackageDigest: successor.packageDigest,
          pendingPackageSequence: successor.packageSequence,
          updatedAt: new Date(this.nowMs()).toISOString()
        };
        this.persistOwnerAdoption(updated);
        this.ownerAdoptions.set(streamId, updated);
      }
      return;
    }
    const stream = this.owned(successor, streamId);
    if (!stream.finalized || !stream.transferable || stream.ownerKey !== source.ownerKey
      || stream.packageDigest !== source.packageDigest || stream.packageSequence !== source.packageSequence
      || successor.packageSequence <= source.packageSequence
      || successor.capabilityFingerprint !== stream.capabilityFingerprint) {
      throw new Error('Managed stream owner adoption is not an exact compatible frozen handoff.');
    }
    const adoption: OwnerAdoption = {
      schemaVersion: 'omnia.managed-stream-owner-adoption/v2',
      streamId,
      physicalOwnerKey: source.ownerKey,
      physicalPackageDigest: source.packageDigest,
      physicalPackageSequence: source.packageSequence,
      capabilityFingerprint: successor.capabilityFingerprint,
      currentOwnerKey: source.ownerKey,
      currentPackageDigest: source.packageDigest,
      currentPackageSequence: source.packageSequence,
      pendingOwnerKey: successor.ownerKey,
      pendingPackageDigest: successor.packageDigest,
      pendingPackageSequence: successor.packageSequence,
      updatedAt: new Date(this.nowMs()).toISOString()
    };
    this.persistOwnerAdoption(adoption);
    this.ownerAdoptions.set(streamId, adoption);
    this.audit('managed_stream', streamId, 'owner_adopted', {
      sourcePackageDigest: source.packageDigest,
      pendingPackageDigest: successor.packageDigest,
      pendingOwnerKey: successor.ownerKey
    });
  }

  ownerAdoptionAllows(streamId: string, owner: ManagedStreamOwner): boolean {
    const adoption = this.ownerAdoptions.get(streamId);
    return Boolean(adoption
      && adoption.capabilityFingerprint === owner.capabilityFingerprint
      && ((adoption.currentOwnerKey === owner.ownerKey
        && adoption.currentPackageDigest === owner.packageDigest
        && adoption.currentPackageSequence === owner.packageSequence)
        || (adoption.pendingOwnerKey === owner.ownerKey
          && adoption.pendingPackageDigest === owner.packageDigest
          && adoption.pendingPackageSequence === owner.packageSequence)));
  }

  ownerAdoptionPending(streamId: string, owner: ManagedStreamOwner): boolean {
    const adoption = this.ownerAdoptions.get(streamId);
    return Boolean(adoption
      && adoption.pendingOwnerKey === owner.ownerKey
      && adoption.pendingPackageDigest === owner.packageDigest
      && adoption.pendingPackageSequence === owner.packageSequence
      && adoption.capabilityFingerprint === owner.capabilityFingerprint);
  }

  finalizeOwnerAdoption(owner: ManagedStreamOwner, streamId: string): void {
    assertOwner(owner);
    const adoption = this.ownerAdoptions.get(streamId);
    if (!adoption || adoption.pendingOwnerKey !== owner.ownerKey
      || adoption.pendingPackageDigest !== owner.packageDigest
      || adoption.pendingPackageSequence !== owner.packageSequence
      || adoption.capabilityFingerprint !== owner.capabilityFingerprint) {
      throw new Error('Managed stream owner finalization does not match the durable pending owner.');
    }
    const finalized: OwnerAdoption = {
      ...adoption,
      currentOwnerKey: owner.ownerKey,
      currentPackageDigest: owner.packageDigest,
      currentPackageSequence: owner.packageSequence,
      pendingOwnerKey: null,
      pendingPackageDigest: null,
      pendingPackageSequence: null,
      updatedAt: new Date(this.nowMs()).toISOString()
    };
    this.persistOwnerAdoption(finalized);
    this.ownerAdoptions.set(streamId, finalized);
    this.audit('managed_stream', streamId, 'owner_adoption_finalized', {
      currentPackageDigest: owner.packageDigest,
      currentPackageSequence: owner.packageSequence,
      currentOwnerKey: owner.ownerKey
    });
  }

  abortOwnerAdoption(packageDigest: string, streamId: string): void {
    if (!DIGEST.test(packageDigest) || !STREAM_ID.test(streamId)) {
      throw new Error('Managed stream owner abort identity is invalid.');
    }
    const adoption = this.ownerAdoptions.get(streamId);
    if (!adoption || adoption.pendingPackageDigest !== packageDigest) return;
    const aborted: OwnerAdoption = {
      ...adoption,
      pendingOwnerKey: null,
      pendingPackageDigest: null,
      pendingPackageSequence: null,
      updatedAt: new Date(this.nowMs()).toISOString()
    };
    this.persistOwnerAdoption(aborted);
    this.ownerAdoptions.set(streamId, aborted);
    this.audit('managed_stream', streamId, 'owner_adoption_aborted', {
      abortedPackageDigest: packageDigest,
      currentPackageDigest: aborted.currentPackageDigest
    });
  }

  audit(kind: string, identity: string, reason: string, details: Record<string, unknown> = {}): void {
    const entry = {
      schemaVersion: 'omnia.connector-retention-audit/v1',
      occurredAt: new Date(this.nowMs()).toISOString(),
      kind,
      identity,
      reason,
      details
    };
    fs.appendFileSync(this.auditFilename, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private owned(owner: ManagedStreamOwner, streamId: string): StreamRecord {
    assertOwner(owner);
    if (!STREAM_ID.test(streamId)) throw new Error('Managed stream identity is invalid.');
    const stream = this.streams.get(streamId);
    const legacyMatch = owner.compatibleSourceOwners?.some((source) => (
      source.ownerKey === stream?.ownerKey && source.packageDigest === stream?.packageDigest
    )) === true;
    const adoption = stream ? this.ownerAdoptions.get(stream.streamId) : undefined;
    const adoptedMatch = stream ? this.ownerAdoptionAllows(stream.streamId, owner) : false;
    const crossDigest = stream?.packageDigest !== owner.packageDigest;
    if (!stream || stream.integrityError
      || (adoption
        ? !adoptedMatch
        : (stream.ownerKey !== owner.ownerKey && !(stream.finalized && stream.transferable && legacyMatch)))
      || (!adoption && crossDigest && (!stream.finalized || !stream.transferable
        || stream.capabilityFingerprint !== owner.capabilityFingerprint
        || owner.packageSequence <= stream.packageSequence))
      || bindingScope(stream.binding) !== bindingScope(owner.binding)
      || (!stream.finalized && (
        stream.packageDigest !== owner.packageDigest
        || stream.binding.sessionGeneration !== owner.binding.sessionGeneration
      ))) {
      throw new Error('Managed stream is unavailable for this signed Operation resource owner and Connector binding.');
    }
    return stream;
  }

  private loadPersistedStreams(): void {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); }
    catch { this.inventoryUnknownCount += 1; return; }
    const nowMs = this.nowMs();
    for (const entry of entries) {
      if (!entry.isFile() || !/^stream_[0-9a-f]{32}\.json$/u.test(entry.name)) continue;
      const metadataFilename = path.join(this.root, entry.name);
      try {
        const value = JSON.parse(fs.readFileSync(metadataFilename, 'utf8')) as PersistedStreamRecord;
        this.validateMetadata(value);
        const filename = this.dataFilename(value.streamId);
        const stat = fs.statSync(filename);
        if (Date.parse(value.expiresAt) <= nowMs) {
          this.deleteExpired(value, filename, metadataFilename);
          continue;
        }
        let integrityError: string | null = null;
        if (!stat.isFile() || stat.size !== value.size) integrityError = 'stream_size_drift';
        let finalDigest = value.finalDigest;
        let finalized = value.finalized;
        if (!integrityError && value.finalized) {
          if (sha256File(filename) !== value.finalDigest) integrityError = 'stream_digest_drift';
        } else if (!integrityError) {
          // A cold restart cannot resume an active writer. Preserve and freeze its exact bytes as incomplete evidence.
          finalDigest = sha256File(filename);
          finalized = true;
        }
        const stream: StreamRecord = {
          ...value,
          finalized,
          transferable: finalized !== value.finalized ? false : value.transferable,
          finalDigest,
          updatedAt: finalized !== value.finalized ? new Date(nowMs).toISOString() : value.updatedAt,
          expiresAt: finalized !== value.finalized ? new Date(nowMs + this.frozenTtlMs).toISOString() : value.expiresAt,
          filename,
          metadataFilename,
          digest: null,
          integrityError
        };
        this.streams.set(stream.streamId, stream);
        if (integrityError) {
          this.audit('managed_stream', stream.streamId, 'integrity_fail_closed', { integrityError });
        } else if (finalized !== value.finalized) {
          this.persist(stream);
          this.audit('managed_stream', stream.streamId, 'cold_restart_froze_active_stream', { size: stream.size, digest: stream.finalDigest });
        }
      } catch (error) {
        this.inventoryUnknownCount += 1;
        this.audit('managed_stream_metadata', entry.name, 'metadata_fail_closed', {
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        });
      }
    }
  }

  private loadOwnerAdoptions(): void {
    const root = path.join(this.root, 'owner-adoptions');
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.inventoryUnknownCount += 1;
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^stream_[0-9a-f]{32}\.json$/u.test(entry.name)) continue;
      try {
        const value = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf8')) as OwnerAdoption;
        exactKeys(value, [
          'schemaVersion', 'streamId', 'physicalOwnerKey', 'physicalPackageDigest', 'physicalPackageSequence',
          'capabilityFingerprint', 'currentOwnerKey', 'currentPackageDigest', 'currentPackageSequence',
          'pendingOwnerKey', 'pendingPackageDigest', 'pendingPackageSequence', 'updatedAt'
        ], 'Managed stream owner adoption');
        const pendingEmpty = value.pendingOwnerKey === null
          && value.pendingPackageDigest === null && value.pendingPackageSequence === null;
        const pendingComplete = OWNER_KEY.test(value.pendingOwnerKey || '')
          && DIGEST.test(value.pendingPackageDigest || '')
          && Number.isSafeInteger(value.pendingPackageSequence)
          && Number(value.pendingPackageSequence) > value.currentPackageSequence;
        if (value.schemaVersion !== 'omnia.managed-stream-owner-adoption/v2'
          || !STREAM_ID.test(value.streamId) || !OWNER_KEY.test(value.physicalOwnerKey) || !OWNER_KEY.test(value.currentOwnerKey)
          || !DIGEST.test(value.physicalPackageDigest) || !DIGEST.test(value.currentPackageDigest)
          || !Number.isSafeInteger(value.physicalPackageSequence) || value.physicalPackageSequence < 1
          || !Number.isSafeInteger(value.currentPackageSequence) || value.currentPackageSequence < value.physicalPackageSequence
          || (!pendingEmpty && !pendingComplete)
          || !/^[0-9a-f]{64}$/u.test(value.capabilityFingerprint)
          || !Number.isFinite(Date.parse(value.updatedAt))) {
          throw new Error('Managed stream owner adoption fields are invalid.');
        }
        const stream = this.streams.get(value.streamId);
        if (!stream || !stream.finalized || !stream.transferable || stream.ownerKey !== value.physicalOwnerKey
          || stream.packageDigest !== value.physicalPackageDigest || stream.packageSequence !== value.physicalPackageSequence
          || stream.capabilityFingerprint !== value.capabilityFingerprint) {
          throw new Error('Managed stream owner adoption does not match its frozen source evidence.');
        }
        this.ownerAdoptions.set(value.streamId, value);
      } catch (error) {
        this.inventoryUnknownCount += 1;
        const streamId = entry.name.slice(0, -5);
        const stream = this.streams.get(streamId);
        if (stream) stream.integrityError = 'owner_adoption_metadata_invalid';
        this.audit('managed_stream_owner_adoption', entry.name, 'adoption_fail_closed', {
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        });
      }
    }
  }

  private persistOwnerAdoption(adoption: OwnerAdoption): void {
    const root = path.join(this.root, 'owner-adoptions');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const filename = path.join(root, `${adoption.streamId}.json`);
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(adoption));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, filename);
  }

  private validateMetadata(value: PersistedStreamRecord): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Managed stream metadata is invalid.');
    exactKeys(value, [
      'schemaVersion', 'streamId', 'ownerKey', 'packageDigest', 'packageSequence', 'capabilityFingerprint', 'binding', 'mediaType', 'size', 'finalized',
      'transferable', 'finalDigest', 'createdAt', 'updatedAt', 'expiresAt'
    ], 'Managed stream metadata');
    if (value.schemaVersion !== STREAM_METADATA_SCHEMA || !STREAM_ID.test(value.streamId)
      || !OWNER_KEY.test(value.ownerKey) || !DIGEST.test(value.packageDigest)
      || !Number.isSafeInteger(value.size) || value.size < 0
      || typeof value.finalized !== 'boolean'
      || typeof value.transferable !== 'boolean'
      || (value.finalized ? !/^[0-9a-f]{64}$/u.test(value.finalDigest || '') : value.finalDigest !== null)
      || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))
      || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw new Error('Managed stream metadata fields are invalid.');
    }
    assertOwner({
      ownerKey: value.ownerKey,
      packageDigest: value.packageDigest,
      packageSequence: value.packageSequence,
      capabilityFingerprint: value.capabilityFingerprint,
      binding: value.binding
    });
  }

  private persist(stream: StreamRecord): void {
    const persisted: PersistedStreamRecord = {
      schemaVersion: stream.schemaVersion,
      streamId: stream.streamId,
      ownerKey: stream.ownerKey,
      packageDigest: stream.packageDigest,
      packageSequence: stream.packageSequence,
      capabilityFingerprint: stream.capabilityFingerprint,
      binding: { ...stream.binding },
      mediaType: stream.mediaType,
      size: stream.size,
      finalized: stream.finalized,
      transferable: stream.transferable,
      finalDigest: stream.finalDigest,
      createdAt: stream.createdAt,
      updatedAt: stream.updatedAt,
      expiresAt: stream.expiresAt
    };
    const temporary = `${stream.metadataFilename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(persisted));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, stream.metadataFilename);
  }

  private pruneExpired(): void {
    const nowMs = this.nowMs();
    for (const stream of [...this.streams.values()]) {
      if (Date.parse(stream.expiresAt) > nowMs) continue;
      this.deleteExpired(stream, stream.filename, stream.metadataFilename);
      this.streams.delete(stream.streamId);
    }
  }

  private managedBytes(): number {
    let bytes = 0;
    for (const stream of this.streams.values()) bytes += stream.size;
    return bytes;
  }

  private managedUsage(): { count: number; bytes: number; maxCount: number; maxBytes: number } {
    return {
      count: this.streams.size,
      bytes: this.managedBytes(),
      maxCount: this.maxStreamCount,
      maxBytes: this.maxTotalBytes
    };
  }

  private deleteExpired(stream: PersistedStreamRecord, filename: string, metadataFilename: string): void {
    this.audit('managed_stream', stream.streamId, 'ttl_expired', {
      expiresAt: stream.expiresAt,
      size: stream.size,
      digest: stream.finalDigest
    });
    try { fs.rmSync(filename, { force: true }); } catch (error) {
      this.audit('managed_stream', stream.streamId, 'ttl_data_delete_failed', { error: String(error).slice(0, 300) });
      return;
    }
    try { fs.rmSync(metadataFilename, { force: true }); } catch (error) {
      this.audit('managed_stream', stream.streamId, 'ttl_metadata_delete_failed', { error: String(error).slice(0, 300) });
    }
    try { fs.rmSync(path.join(this.root, 'owner-adoptions', `${stream.streamId}.json`), { force: true }); } catch (error) {
      this.audit('managed_stream', stream.streamId, 'ttl_owner_adoption_delete_failed', { error: String(error).slice(0, 300) });
    }
    this.ownerAdoptions.delete(stream.streamId);
  }

  private dataFilename(streamId: string): string {
    return path.join(this.root, `${streamId}.bin`);
  }

  private metadataFilename(streamId: string): string {
    return path.join(this.root, `${streamId}.json`);
  }
}
