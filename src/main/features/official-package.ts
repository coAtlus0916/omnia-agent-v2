import crypto from 'node:crypto';
import path from 'node:path';

export const OFFICIAL_FEATURE_KEY_ID = 'omnia-v5-official-feature-2026-01';
export const OFFICIAL_OPERATION_KEY_ID = 'omnia-v5-official-operation-2026-01';
export const OFFICIAL_FEATURE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAcQGEE3EPSJ1BR/CV2rJzVyQ3IDGp/gULpegW1k2sn7U=
-----END PUBLIC KEY-----`;
export const OFFICIAL_OPERATION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0fdHdc78HOCk6mimmUihPquilB86q4MdI+9XcS0SQ18=
-----END PUBLIC KEY-----`;

export type OfficialPackageProduct = 'omnia-feature' | 'omnia-connector-operation';

export interface OfficialPackageFile {
  path: string;
  size: number;
  sha256: string;
  contentBase64: string;
}

export interface OfficialPackageEnvelope {
  schemaVersion: 'omnia.official-package-envelope/v1';
  product: OfficialPackageProduct;
  packageId: string;
  version: string;
  sequence: number;
  publisher: {
    keyId: string;
    algorithm: 'Ed25519';
  };
  files: OfficialPackageFile[];
  signature: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Official package contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Official package contains a non-JSON value.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function packageSigningPayload(envelope: OfficialPackageEnvelope): Buffer {
  const payload = { ...envelope, signature: undefined } as Record<string, unknown>;
  delete payload.signature;
  return Buffer.from(canonicalJson(payload));
}

export function packageDigest(envelope: OfficialPackageEnvelope): string {
  return `sha256:${crypto.createHash('sha256').update(packageSigningPayload(envelope)).digest('hex')}`;
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function safeRelativePath(value: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\\')
    || value.normalize('NFC') !== value
    || /[\u0000-\u001f\u007f:]/u.test(value)
    || path.posix.isAbsolute(value)
    || value.split('/').some((part) =>
      !part
      || part === '.'
      || part === '..'
      || /[ .]$/u.test(part)
      || WINDOWS_DEVICE_NAME.test(part)
    )
    || value.length > 240
  ) throw new Error(`Official package member path is unsafe: ${value}`);
  return value;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unknown or missing fields.`);
  }
}

function strictBase64(value: unknown, label: string): Buffer {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) throw new Error(`${label} is not canonical base64.`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(`${label} is not canonical base64.`);
  return decoded;
}

function officialPublisher(product: OfficialPackageProduct): { keyId: string; publicKey: string } {
  return product === 'omnia-feature'
    ? { keyId: OFFICIAL_FEATURE_KEY_ID, publicKey: OFFICIAL_FEATURE_PUBLIC_KEY }
    : { keyId: OFFICIAL_OPERATION_KEY_ID, publicKey: OFFICIAL_OPERATION_PUBLIC_KEY };
}

export function verifyOfficialPackage(
  input: unknown,
  expectedProduct: OfficialPackageProduct,
  publicKeyOverride?: string
): OfficialPackageEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Official package envelope is invalid.');
  exactKeys(input, ['schemaVersion', 'product', 'packageId', 'version', 'sequence', 'publisher', 'files', 'signature'], 'Official package envelope');
  const envelope = input as OfficialPackageEnvelope;
  const publisher = officialPublisher(expectedProduct);
  if (
    envelope.schemaVersion !== 'omnia.official-package-envelope/v1'
    || envelope.product !== expectedProduct
    || typeof envelope.packageId !== 'string'
    || envelope.packageId.normalize('NFC') !== envelope.packageId
    || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(envelope.packageId)
    || typeof envelope.version !== 'string'
    || !/^\d+\.\d+\.\d+$/.test(envelope.version)
    || !Number.isSafeInteger(envelope.sequence)
    || envelope.sequence <= 0
    || !envelope.publisher
    || typeof envelope.publisher !== 'object'
    || Array.isArray(envelope.publisher)
    || !Array.isArray(envelope.files)
    || envelope.files.length === 0
    || envelope.files.length > 256
    || typeof envelope.signature !== 'string'
  ) throw new Error('Official package identity or publisher contract is invalid.');
  exactKeys(envelope.publisher, ['keyId', 'algorithm'], 'Official package publisher');
  if (envelope.publisher.keyId !== publisher.keyId || envelope.publisher.algorithm !== 'Ed25519') {
    throw new Error('Official package publisher is not trusted for this product scope.');
  }
  const signature = strictBase64(envelope.signature, 'Official package signature');
  if (!crypto.verify(null, packageSigningPayload(envelope), publicKeyOverride ?? publisher.publicKey, signature)) {
    throw new Error('Official package signature is invalid.');
  }
  const seen = new Set<string>();
  let total = 0;
  for (const member of envelope.files) {
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      throw new Error('Official package member is invalid.');
    }
    exactKeys(member, ['path', 'size', 'sha256', 'contentBase64'], 'Official package member');
    safeRelativePath(member.path);
    const collisionKey = member.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(collisionKey)) throw new Error(`Duplicate official package member: ${member.path}`);
    seen.add(collisionKey);
    if (!Number.isSafeInteger(member.size) || member.size < 0 || member.size > 16 * 1024 * 1024) {
      throw new Error(`Official package member size is invalid: ${member.path}`);
    }
    if (typeof member.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(member.sha256)) {
      throw new Error(`Official package member digest is malformed: ${member.path}`);
    }
    const bytes = strictBase64(member.contentBase64, `Official package member content: ${member.path}`);
    if (bytes.byteLength !== member.size) throw new Error(`Official package member size mismatch: ${member.path}`);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (member.sha256 !== digest) throw new Error(`Official package member digest mismatch: ${member.path}`);
    total += bytes.byteLength;
  }
  if (total > 64 * 1024 * 1024) throw new Error('Official package exceeds the total size limit.');
  return envelope;
}

export function packageFile(envelope: OfficialPackageEnvelope, memberPath: string): Buffer {
  const member = envelope.files.find((item) => item.path === memberPath);
  if (!member) throw new Error(`Official package member is missing: ${memberPath}`);
  return Buffer.from(member.contentBase64, 'base64');
}
