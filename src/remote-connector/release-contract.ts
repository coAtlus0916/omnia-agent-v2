import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  REMOTE_CONNECTOR_CHANNEL,
  REMOTE_CONNECTOR_KEY_ID,
  REMOTE_CONNECTOR_PLATFORM,
  REMOTE_CONNECTOR_PRODUCT,
  REMOTE_CONNECTOR_PUBLIC_KEY,
  REMOTE_CONNECTOR_UPDATE_PREFIX
} from './constants.js';

export interface SignedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface PortableManifest {
  schemaVersion: 'omnia.v5.remote-connector-portable/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  version: string;
  sequence: number;
  platform: typeof REMOTE_CONNECTOR_PLATFORM;
  keyId: typeof REMOTE_CONNECTOR_KEY_ID;
  files: SignedFile[];
  signature: string;
}

export interface UpdateManifest {
  schemaVersion: 'omnia.v5.remote-connector-update/v1';
  product: typeof REMOTE_CONNECTOR_PRODUCT;
  channel: typeof REMOTE_CONNECTOR_CHANNEL;
  platform: typeof REMOTE_CONNECTOR_PLATFORM;
  version: string;
  sequence: number;
  publishedAt: string;
  url: string;
  sha256: string;
  size: number;
  minimumSupervisorVersion: string;
  rolloutPolicy?: 'automatic_safe_window';
  securitySeverity?: 'normal' | 'high' | 'critical';
  newRunStopAt?: string;
  maxDrainUntil?: string;
  offerExpiresAt?: string;
  keyId: typeof REMOTE_CONNECTOR_KEY_ID;
  signature: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON rejects non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value !== 'object') throw new Error('Canonical JSON received an unsupported value.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}

export function signable<T extends { signature: string }>(value: T): Omit<T, 'signature'> {
  const { signature: _signature, ...payload } = value;
  return payload;
}

export function verifySignature(value: { signature: string }): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalJson(signable(value))),
      REMOTE_CONNECTOR_PUBLIC_KEY,
      Buffer.from(value.signature, 'base64')
    );
  } catch {
    return false;
  }
}

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isSafeRelativeFile(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) return false;
  if (path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && !normalized.startsWith('../') && normalized !== '..';
}

export function validateUpdateManifest(value: unknown): UpdateManifest {
  if (!value || typeof value !== 'object') throw new Error('Remote Connector update manifest is not an object.');
  const manifest = value as UpdateManifest;
  const legacyKeys = [
    'channel', 'keyId', 'minimumSupervisorVersion', 'platform', 'product', 'publishedAt',
    'schemaVersion', 'sequence', 'sha256', 'signature', 'size', 'url', 'version'
  ];
  const rolloutKeys = [...legacyKeys,
    'rolloutPolicy', 'securitySeverity', 'newRunStopAt', 'maxDrainUntil', 'offerExpiresAt'
  ];
  const actualKeys = Object.keys(manifest).sort().join('|');
  const legacy = actualKeys === legacyKeys.sort().join('|');
  if (!legacy && actualKeys !== rolloutKeys.sort().join('|')) {
    throw new Error('Remote Connector update manifest fields are incompatible.');
  }
  if (
    manifest.schemaVersion !== 'omnia.v5.remote-connector-update/v1'
    || manifest.product !== REMOTE_CONNECTOR_PRODUCT
    || manifest.channel !== REMOTE_CONNECTOR_CHANNEL
    || manifest.platform !== REMOTE_CONNECTOR_PLATFORM
    || manifest.keyId !== REMOTE_CONNECTOR_KEY_ID
  ) throw new Error('Remote Connector update manifest identity does not match v5 stable.');
  if (!isVersion(manifest.version) || !isVersion(manifest.minimumSupervisorVersion)) {
    throw new Error('Remote Connector update manifest version is invalid.');
  }
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence <= 0) {
    throw new Error('Remote Connector update sequence is invalid.');
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0) {
    throw new Error('Remote Connector update size is invalid.');
  }
  if (!isSha256(manifest.sha256) || Number.isNaN(Date.parse(manifest.publishedAt))) {
    throw new Error('Remote Connector update digest or publication time is invalid.');
  }
  if (!legacy) {
    const publishedAt = Date.parse(manifest.publishedAt);
    const newRunStopAt = Date.parse(String(manifest.newRunStopAt));
    const maxDrainUntil = Date.parse(String(manifest.maxDrainUntil));
    const offerExpiresAt = Date.parse(String(manifest.offerExpiresAt));
    if (
      manifest.rolloutPolicy !== 'automatic_safe_window'
      || !['normal', 'high', 'critical'].includes(String(manifest.securitySeverity))
      || !Number.isFinite(newRunStopAt)
      || !Number.isFinite(maxDrainUntil)
      || !Number.isFinite(offerExpiresAt)
      || newRunStopAt < publishedAt
      || maxDrainUntil < newRunStopAt
      || offerExpiresAt < maxDrainUntil
      || offerExpiresAt <= Date.now()
    ) throw new Error('Remote Connector automatic safe-window offer is invalid or expired.');
  }
  const updateUrl = new URL(manifest.url);
  if (
    updateUrl.href !== manifest.url
    || updateUrl.protocol !== 'https:'
    || !updateUrl.href.startsWith(REMOTE_CONNECTOR_UPDATE_PREFIX)
    || updateUrl.username
    || updateUrl.password
    || updateUrl.hash
  ) throw new Error('Remote Connector update URL is outside the isolated v5 release path.');
  if (!verifySignature(manifest)) throw new Error('Remote Connector update signature is invalid.');
  return manifest;
}

export function validatePortableManifest(value: unknown): PortableManifest {
  if (!value || typeof value !== 'object') throw new Error('Portable manifest is not an object.');
  const manifest = value as PortableManifest;
  const exactKeys = ['files', 'keyId', 'platform', 'product', 'schemaVersion', 'sequence', 'signature', 'version'];
  if (Object.keys(manifest).sort().join('|') !== exactKeys.sort().join('|')) {
    throw new Error('Portable manifest fields are incompatible.');
  }
  if (
    manifest.schemaVersion !== 'omnia.v5.remote-connector-portable/v1'
    || manifest.product !== REMOTE_CONNECTOR_PRODUCT
    || manifest.platform !== REMOTE_CONNECTOR_PLATFORM
    || manifest.keyId !== REMOTE_CONNECTOR_KEY_ID
    || !isVersion(manifest.version)
    || !Number.isSafeInteger(manifest.sequence)
    || manifest.sequence <= 0
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0
  ) throw new Error('Portable manifest identity is invalid.');
  let previous = '';
  for (const file of manifest.files) {
    if (
      !file || typeof file !== 'object'
      || !isSafeRelativeFile(file.path)
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || !isSha256(file.sha256)
      || file.path <= previous
    ) throw new Error('Portable manifest file inventory is invalid.');
    previous = file.path;
  }
  if (!verifySignature(manifest)) throw new Error('Portable manifest signature is invalid.');
  return manifest;
}

export function sha256File(filename: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function listTree(root: string, relative = ''): string[] {
  const directory = path.join(root, ...relative.split('/').filter(Boolean));
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const target = path.join(root, ...child.split('/'));
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Portable package contains a symbolic link: ${child}`);
    if (entry.isDirectory()) result.push(...listTree(root, child));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`Portable package contains an unsupported filesystem entry: ${child}`);
  }
  return result;
}

export function verifyPortableRoot(root: string): PortableManifest {
  const resolved = path.resolve(root);
  const manifestPath = path.join(resolved, 'portable-manifest.json');
  const manifest = validatePortableManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const actualFiles = listTree(resolved).filter((entry) => entry !== 'portable-manifest.json');
  const expectedFiles = manifest.files.map((entry) => entry.path);
  if (actualFiles.join('|') !== expectedFiles.join('|')) {
    const actual = new Set(actualFiles);
    const expected = new Set(expectedFiles);
    const missing = expectedFiles.filter((entry) => !actual.has(entry)).slice(0, 12);
    const extra = actualFiles.filter((entry) => !expected.has(entry)).slice(0, 12);
    throw new Error(
      `Portable package file inventory does not match its signed manifest. `
      + `Missing: ${missing.join(', ') || 'none'}. Extra: ${extra.join(', ') || 'none'}.`
    );
  }
  for (const file of manifest.files) {
    const target = path.join(resolved, ...file.path.split('/'));
    const stat = fs.statSync(target);
    if (stat.size !== file.size || sha256File(target) !== file.sha256) {
      throw new Error(`Portable package file verification failed: ${file.path}`);
    }
  }
  return manifest;
}
