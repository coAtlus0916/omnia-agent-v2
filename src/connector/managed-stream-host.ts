import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ManagedStreamChunk, ManagedStreamReadRequest } from '../shared/page-observation-contracts.js';

export const MANAGED_STREAM_CHUNK_BYTES = 128 * 1024;
const STREAM_ID = /^stream_[0-9a-f]{32}$/u;

type StreamRecord = {
  streamId: string;
  ownerId: string;
  mediaType: string;
  filename: string;
  size: number;
  finalized: boolean;
  digest: crypto.Hash | null;
  finalDigest: string | null;
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

export class ManagedStreamHost {
  private readonly streams = new Map<string, StreamRecord>();
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.removeOrphanedFiles();
  }

  create(ownerId: string, mediaType: string): string {
    if (!ownerId || ownerId.length > 512) throw new Error('Managed stream owner is invalid.');
    if (!/^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/iu.test(mediaType)) {
      throw new Error('Managed stream media type is invalid.');
    }
    let streamId = opaqueStreamId();
    while (this.streams.has(streamId)) streamId = opaqueStreamId();
    const filename = path.join(this.root, `${streamId}.bin`);
    const handle = fs.openSync(filename, 'wx', 0o600);
    fs.closeSync(handle);
    this.streams.set(streamId, {
      streamId,
      ownerId,
      mediaType,
      filename,
      size: 0,
      finalized: false,
      digest: crypto.createHash('sha256'),
      finalDigest: null
    });
    return streamId;
  }

  append(ownerId: string, streamId: string, bytes: Uint8Array): { offset: number; nextOffset: number } {
    const stream = this.owned(ownerId, streamId);
    if (stream.finalized || !stream.digest) throw new Error('Managed stream is already finalized.');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) throw new Error('Managed stream append is empty.');
    const payload = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = stream.size;
    fs.appendFileSync(stream.filename, payload);
    stream.digest.update(payload);
    stream.size += payload.byteLength;
    return { offset, nextOffset: stream.size };
  }

  finalize(ownerId: string, streamId: string): void {
    const stream = this.owned(ownerId, streamId);
    if (stream.finalized) return;
    stream.finalized = true;
    stream.finalDigest = stream.digest!.digest('hex');
    stream.digest = null;
  }

  async read(ownerId: string, input: ManagedStreamReadRequest): Promise<ManagedStreamChunk> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Managed stream read is invalid.');
    exactKeys(input, ['schemaVersion', 'streamId', 'offset', ...(input.maxBytes === undefined ? [] : ['maxBytes'])], 'Managed stream read');
    if (input.schemaVersion !== 'omnia.managed-stream-read/v1') throw new Error('Managed stream read schema is invalid.');
    const stream = this.owned(ownerId, input.streamId);
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
    const committedBytes = stream.finalized
      ? stream.size
      : stream.size - (stream.size % MANAGED_STREAM_CHUNK_BYTES);
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

  releaseOwner(ownerId: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.ownerId !== ownerId) continue;
      this.streams.delete(stream.streamId);
      try { fs.rmSync(stream.filename, { force: true }); } catch { /* best-effort local lifecycle cleanup */ }
    }
  }

  close(): void {
    for (const ownerId of new Set([...this.streams.values()].map((stream) => stream.ownerId))) {
      this.releaseOwner(ownerId);
    }
  }

  private owned(ownerId: string, streamId: string): StreamRecord {
    if (!STREAM_ID.test(streamId)) throw new Error('Managed stream identity is invalid.');
    const stream = this.streams.get(streamId);
    if (!stream || stream.ownerId !== ownerId) throw new Error('Managed stream is unavailable for this Operation package.');
    return stream;
  }

  private removeOrphanedFiles(): void {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^stream_[0-9a-f]{32}\.bin$/u.test(entry.name)) continue;
      try { fs.rmSync(path.join(this.root, entry.name), { force: true }); } catch { /* retry on the next process start */ }
    }
  }
}
