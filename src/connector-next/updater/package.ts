import fs from 'node:fs';
import path from 'node:path';
import { sign, verify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  CONNECTOR_NEXT_PACKAGE_SCHEMA,
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_PROTOCOL_ID,
  type ConnectorNextPackage,
  type ConnectorNextUpdateManifest,
  type ConnectorNextUpdateManifestUnsigned,
  assertDigest,
  assertIdentifier,
  assertSemver,
  canonicalJson,
  sha256,
  unsignedManifest
} from '../protocol.js';

export interface CurrentPointer {
  schemaVersion: 'omnia.connector-next-current/v1';
  slot: 'a' | 'b';
  relativeRoot: string;
  version: string;
  sequence: number;
  generation: number;
  manifestDigest: string;
  updatedAt: string;
}

export interface ConnectorNextSlotIdentity {
  schemaVersion: 'omnia.connector-next-slot/v2';
  productId: typeof CONNECTOR_NEXT_PRODUCT_ID;
  protocolId: typeof CONNECTOR_NEXT_PROTOCOL_ID;
  version: string;
  sequence: number;
  manifestDigest: string;
  entrypoint: string;
  updaterEntrypoint: string;
  runtimeEntrypoint: string;
  files: Array<{ path: string; size: number; digest: string }>;
}

function safePackagePath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative)) throw new Error('CONNECTOR_NEXT.INVALID_PACKAGE_PATH');
  const normalized = path.posix.normalize(relative);
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) throw new Error('CONNECTOR_NEXT.INVALID_PACKAGE_PATH');
  const destination = path.resolve(root, ...normalized.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(prefix)) throw new Error('CONNECTOR_NEXT.PACKAGE_PATH_ESCAPE');
  return destination;
}

export function signConnectorNextManifest(unsigned: ConnectorNextUpdateManifestUnsigned, privateKeyPem: string): ConnectorNextUpdateManifest {
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKeyPem).toString('base64') };
}

export function verifyConnectorNextManifest(manifest: ConnectorNextUpdateManifest, publicKeyPem: string): void {
  if (manifest.schemaVersion !== 'omnia.connector-next-update-manifest/v1'
    || manifest.productId !== CONNECTOR_NEXT_PRODUCT_ID
    || manifest.protocolId !== CONNECTOR_NEXT_PROTOCOL_ID) throw new Error('CONNECTOR_NEXT.UPDATE_MANIFEST_IDENTITY_MISMATCH');
  assertIdentifier(manifest.artifactId, 'artifact_id');
  assertSemver(manifest.version);
  assertSemver(manifest.minimumUpdaterVersion, 'minimum_updater_version');
  assertDigest(manifest.packageDigest, 'package_digest');
  if (!Number.isInteger(manifest.sequence) || manifest.sequence < 1 || !Number.isInteger(manifest.packageSize) || manifest.packageSize < 1) {
    throw new Error('CONNECTOR_NEXT.INVALID_UPDATE_MANIFEST');
  }
  const valid = verify(null, Buffer.from(canonicalJson(unsignedManifest(manifest))), publicKeyPem, Buffer.from(manifest.signature, 'base64'));
  if (!valid) throw new Error('CONNECTOR_NEXT.UPDATE_SIGNATURE_INVALID');
}

export function parseAndVerifyPackage(packageBytes: Buffer, manifest: ConnectorNextUpdateManifest): ConnectorNextPackage {
  if (packageBytes.length !== manifest.packageSize || sha256(packageBytes) !== manifest.packageDigest) throw new Error('CONNECTOR_NEXT.UPDATE_PACKAGE_DIGEST_MISMATCH');
  const expanded = gunzipSync(packageBytes, { maxOutputLength: 384 * 1024 * 1024 });
  const value = JSON.parse(expanded.toString('utf8')) as ConnectorNextPackage;
  if (value.schemaVersion !== CONNECTOR_NEXT_PACKAGE_SCHEMA || value.productId !== CONNECTOR_NEXT_PRODUCT_ID || value.protocolId !== CONNECTOR_NEXT_PROTOCOL_ID) {
    throw new Error('CONNECTOR_NEXT.PACKAGE_IDENTITY_MISMATCH');
  }
  if (value.version !== manifest.version || value.sequence !== manifest.sequence || !Array.isArray(value.files) || value.files.length < 3 || value.files.length > 1000) {
    throw new Error('CONNECTOR_NEXT.PACKAGE_MANIFEST_MISMATCH');
  }
  const seen = new Set<string>();
  for (const file of value.files) {
    if (seen.has(file.path)) throw new Error('CONNECTOR_NEXT.PACKAGE_DUPLICATE_PATH');
    seen.add(file.path);
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.length !== file.size || sha256(bytes) !== file.digest) throw new Error('CONNECTOR_NEXT.PACKAGE_MEMBER_DIGEST_MISMATCH');
  }
  if (!seen.has(value.entrypoint) || !seen.has(value.updaterEntrypoint) || !seen.has(value.runtimeEntrypoint)
    || new Set([value.entrypoint, value.updaterEntrypoint, value.runtimeEntrypoint]).size !== 3) {
    throw new Error('CONNECTOR_NEXT.PACKAGE_ENTRYPOINT_MISSING');
  }
  return value;
}

export function stagePackageImmutable(slotsRoot: string, slot: 'a' | 'b', value: ConnectorNextPackage, manifestDigest: string): string {
  const generationDirectory = `${value.sequence}-${manifestDigest.replace('sha256:', '').slice(0, 24)}`;
  const slotPath = path.join(slotsRoot, slot, generationDirectory);
  const identityFile = path.join(slotPath, 'slot-identity-v3.json');
  if (fs.existsSync(identityFile)) {
    const existing = JSON.parse(fs.readFileSync(identityFile, 'utf8')) as { manifestDigest?: string };
    if (existing.manifestDigest === manifestDigest) return slotPath;
    throw new Error('CONNECTOR_NEXT.IMMUTABLE_SLOT_OCCUPIED');
  }
  if (fs.existsSync(slotPath)) throw new Error('CONNECTOR_NEXT.IMMUTABLE_SLOT_UNIDENTIFIED');
  fs.mkdirSync(path.join(slotsRoot, slot), { recursive: true });
  const staging = path.join(slotsRoot, slot, `.${generationDirectory}.staging.${process.pid}.${Date.now()}`);
  fs.mkdirSync(staging, { recursive: false });
  try {
    for (const file of value.files) {
      const destination = safePackagePath(staging, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.contentBase64, 'base64'), { flag: 'wx', mode: 0o555 });
    }
    const identity: ConnectorNextSlotIdentity = {
      schemaVersion: 'omnia.connector-next-slot/v2',
      productId: CONNECTOR_NEXT_PRODUCT_ID,
      protocolId: CONNECTOR_NEXT_PROTOCOL_ID,
      version: value.version,
      sequence: value.sequence,
      manifestDigest,
      entrypoint: value.entrypoint,
      updaterEntrypoint: value.updaterEntrypoint,
      runtimeEntrypoint: value.runtimeEntrypoint,
      files: value.files.map((file) => ({ path: file.path, size: file.size, digest: file.digest }))
    };
    fs.writeFileSync(path.join(staging, 'slot-identity-v3.json'), `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
    fs.renameSync(staging, slotPath);
    return slotPath;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function readCurrentPointer(filename: string): CurrentPointer {
  const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as CurrentPointer;
  if (value.schemaVersion !== 'omnia.connector-next-current/v1' || !['a', 'b'].includes(value.slot) || !value.relativeRoot || path.isAbsolute(value.relativeRoot) || value.relativeRoot.includes('..') || !Number.isInteger(value.generation) || value.generation < 1) {
    throw new Error('CONNECTOR_NEXT.CURRENT_POINTER_INVALID');
  }
  return value;
}

export function writeCurrentPointerAtomic(filename: string, value: CurrentPointer): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename);
}

export function verifyCurrentSlot(paths: { slotsRoot: string }, pointer: CurrentPointer): { root: string; identity: ConnectorNextSlotIdentity } {
  const root = path.resolve(paths.slotsRoot, ...pointer.relativeRoot.split('/'));
  const slotsPrefix = `${path.resolve(paths.slotsRoot)}${path.sep}`;
  if (!root.startsWith(slotsPrefix)) throw new Error('CONNECTOR_NEXT.CURRENT_SLOT_PATH_ESCAPE');
  const identity = JSON.parse(fs.readFileSync(path.join(root, 'slot-identity-v3.json'), 'utf8')) as ConnectorNextSlotIdentity;
  if (identity.schemaVersion !== 'omnia.connector-next-slot/v2'
    || identity.productId !== CONNECTOR_NEXT_PRODUCT_ID
    || identity.protocolId !== CONNECTOR_NEXT_PROTOCOL_ID
    || identity.version !== pointer.version
    || identity.sequence !== pointer.sequence
    || identity.manifestDigest !== pointer.manifestDigest
    || !Array.isArray(identity.files)
    || identity.files.length < 3) throw new Error('CONNECTOR_NEXT.CURRENT_SLOT_IDENTITY_MISMATCH');
  const seen = new Set<string>();
  for (const file of identity.files) {
    if (seen.has(file.path)) throw new Error('CONNECTOR_NEXT.CURRENT_SLOT_DUPLICATE_PATH');
    seen.add(file.path);
    assertDigest(file.digest, 'slot_file_digest');
    if (!Number.isInteger(file.size) || file.size < 0) throw new Error('CONNECTOR_NEXT.CURRENT_SLOT_FILE_INVALID');
    const filename = safePackagePath(root, file.path);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size !== file.size || sha256(fs.readFileSync(filename)) !== file.digest) {
      throw new Error('CONNECTOR_NEXT.CURRENT_SLOT_FILE_DIGEST_MISMATCH');
    }
  }
  if (!seen.has(identity.entrypoint) || !seen.has(identity.updaterEntrypoint) || !seen.has(identity.runtimeEntrypoint)
    || new Set([identity.entrypoint, identity.updaterEntrypoint, identity.runtimeEntrypoint]).size !== 3) {
    throw new Error('CONNECTOR_NEXT.CURRENT_SLOT_ENTRYPOINT_INVALID');
  }
  return { root, identity };
}

export function manifestDigest(manifest: ConnectorNextUpdateManifest): string {
  return sha256(canonicalJson(manifest));
}
