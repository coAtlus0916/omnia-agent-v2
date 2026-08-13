import { crc32, deflateRawSync } from 'node:zlib';

export interface ArchiveEntry {
  /** Path stored inside the archive, using '/' separators (may include folders). */
  name: string;
  bytes: Buffer;
}

const DOS_EPOCH_DATE = 0x21; // 1980-01-01
const UTF8_FLAG = 0x0800; // EFS flag: names are UTF-8

/**
 * Deterministic minimal ZIP writer (store + deflate, UTF-8 names). Produces a
 * well-formed archive readable by JSZip / Python zipfile without any third-party
 * dependency. Used to normalize a multi-file or folder selection into a single
 * archive artifact that the Feature worker already knows how to consume.
 */
export function packArchive(entries: ArchiveEntry[]): Buffer {
  if (!entries.length) throw new Error('Archive requires at least one entry.');
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length === 0 || name.length > 0xffff) throw new Error('Archive entry name is invalid.');
    const uncompressed = entry.bytes;
    const compressed = deflateRawSync(uncompressed);
    const method = compressed.length < uncompressed.length ? 8 : 0;
    const stored = method === 0 ? uncompressed : compressed;
    const checksum = crc32(uncompressed) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // modification time (0)
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // central directory start disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, ...centralParts, end]);
}
