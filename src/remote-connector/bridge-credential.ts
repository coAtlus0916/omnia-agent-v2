import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BRIDGE_PRODUCT,
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA
} from '../shared/bridge-contracts.js';
import { writeJsonAtomic } from './managed-state.js';
import { protectRemoteSecret, unprotectRemoteSecret } from './windows-secret.js';

interface StoredBridgeCredential {
  schemaVersion: 'omnia.v5.remote-connector-credential/v1';
  bridgeUrl: string;
  pairId: string;
  generation: number;
  tokenCiphertext: string;
  pairedAt: string;
}

export interface BridgeCredential {
  bridgeUrl: string;
  pairId: string;
  generation: number;
  token: string;
}

export interface ConnectorDeviceIdentity {
  schemaVersion: 'omnia.v5.remote-connector-device/v1';
  connectorId: string;
  createdAt: string;
}

export function validateRemoteBridgeUrl(value: string): URL {
  const url = new URL(value.trim());
  const localTest = process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localTest) throw new Error('Remote Bridge must use HTTPS/WSS.');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Remote Bridge URL must not contain credentials, query, or fragment.');
  }
  return url;
}

function decodeCredential(filename: string): BridgeCredential {
  const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as StoredBridgeCredential;
  if (value.schemaVersion !== 'omnia.v5.remote-connector-credential/v1' || !value.bridgeUrl || !value.pairId || !value.tokenCiphertext) {
    throw new Error('Stored Remote credential is invalid.');
  }
  const base = validateRemoteBridgeUrl(value.bridgeUrl);
  return {
    bridgeUrl: base.href,
    pairId: value.pairId,
    generation: Number.isSafeInteger(value.generation) && value.generation > 0 ? value.generation : 1,
    token: unprotectRemoteSecret(value.tokenCiphertext)
  };
}

export function readStoredBridgeCredentialState(dataRoot: string):
  | { state: 'unpaired'; credential: null }
  | { state: 'ready'; credential: BridgeCredential }
  | { state: 'repair_required'; credential: null } {
  const filename = path.join(dataRoot, 'bridge-credential.json');
  if (!fs.existsSync(filename)) return { state: 'unpaired', credential: null };
  try {
    return { state: 'ready', credential: decodeCredential(filename) };
  } catch {
    return { state: 'repair_required', credential: null };
  }
}

export function readStoredBridgeCredential(dataRoot: string): BridgeCredential | null {
  return readStoredBridgeCredentialState(dataRoot).credential;
}

export function readOrCreateConnectorDeviceIdentity(dataRoot: string): ConnectorDeviceIdentity {
  const filename = path.join(dataRoot, 'device-identity.json');
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as ConnectorDeviceIdentity;
    if (
      value.schemaVersion === 'omnia.v5.remote-connector-device/v1'
      && /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(value.connectorId)
      && Number.isFinite(Date.parse(value.createdAt))
    ) return value;
  } catch { /* create a new v5-only device identity */ }
  const value: ConnectorDeviceIdentity = {
    schemaVersion: 'omnia.v5.remote-connector-device/v1',
    connectorId: `v5-connector-${randomUUID()}`,
    createdAt: new Date().toISOString()
  };
  writeJsonAtomic(filename, value);
  return value;
}

function storeBridgeCredential(dataRoot: string, input: BridgeCredential, filename = 'bridge-credential.json'): void {
  writeJsonAtomic(path.join(dataRoot, filename), {
    schemaVersion: 'omnia.v5.remote-connector-credential/v1',
    bridgeUrl: input.bridgeUrl,
    pairId: input.pairId,
    generation: input.generation,
    tokenCiphertext: protectRemoteSecret(input.token),
    pairedAt: new Date().toISOString()
  } satisfies StoredBridgeCredential);
}

function readCredentialFile(dataRoot: string, filename: string): BridgeCredential | null {
  const target = path.join(dataRoot, filename);
  if (!fs.existsSync(target)) return null;
  try { return decodeCredential(target); } catch { return null; }
}

export function readCandidateBridgeCredential(dataRoot: string): BridgeCredential | null {
  return readCredentialFile(dataRoot, 'bridge-credential-candidate.json');
}

export function promoteCandidateBridgeCredential(dataRoot: string, pairId: string): void {
  const candidate = readCandidateBridgeCredential(dataRoot);
  if (!candidate || candidate.pairId !== pairId) throw new Error('Candidate credential identity changed.');
  const active = path.join(dataRoot, 'bridge-credential.json');
  const pending = path.join(dataRoot, 'bridge-credential-candidate.json');
  const previous = path.join(dataRoot, 'bridge-credential.previous.json');
  fs.rmSync(previous, { force: true });
  if (fs.existsSync(active)) fs.renameSync(active, previous);
  try {
    fs.renameSync(pending, active);
    fs.rmSync(previous, { force: true });
  } catch (error) {
    if (!fs.existsSync(active) && fs.existsSync(previous)) fs.renameSync(previous, active);
    throw error;
  }
}

export function acceptCommittedCandidateBridgeCredential(
  dataRoot: string,
  pairId: string,
  generation: number
): boolean {
  const candidate = readCandidateBridgeCredential(dataRoot);
  if (!candidate || candidate.pairId !== pairId || candidate.generation !== generation) return false;
  promoteCandidateBridgeCredential(dataRoot, pairId);
  return true;
}

export function clearCandidateBridgeCredential(dataRoot: string): void {
  fs.rmSync(path.join(dataRoot, 'bridge-credential-candidate.json'), { force: true });
}

export async function pairRemoteConnector(input: {
  dataRoot: string;
  bridgeUrl: string;
  pairingCode: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<{ bridgeUrl: string; pairId: string }> {
  const base = validateRemoteBridgeUrl(input.bridgeUrl);
  const identity = readOrCreateConnectorDeviceIdentity(input.dataRoot);
  const pairingCode = input.pairingCode.trim();
  if (!/^\d{4}$/u.test(pairingCode)) throw new Error('Connector 一次性配对码必须是 4 位数字。');
  const response = await (input.fetchImpl || fetch)(
    new URL('v1/pair', base.href.endsWith('/') ? base.href : `${base.href}/`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        schemaVersion: BRIDGE_SCHEMA,
        role: 'connector',
        pairingCode,
        name: input.name.trim().slice(0, 160) || 'Omnia Agent v5 Remote Connector',
        connectorId: identity.connectorId,
        connectorVersion: process.env.OMNIA_V5_REMOTE_CONNECTOR_VERSION || '0.3.12',
        platform: `${process.platform}-${process.arch}`,
        product: BRIDGE_PRODUCT,
        protocol: BRIDGE_PROTOCOL
      }),
      signal: AbortSignal.timeout(20_000)
    }
  );
  const payload = await response.json() as any;
  if (
    !response.ok
    || payload.schemaVersion !== BRIDGE_SCHEMA
    || typeof payload.pairId !== 'string'
    || typeof payload.token !== 'string'
    || !Number.isSafeInteger(payload.generation)
    || !payload.pairId
    || !payload.token
  ) throw new Error(payload.message || `Bridge pairing failed with HTTP ${response.status}.`);
  storeBridgeCredential(input.dataRoot, {
    bridgeUrl: base.href,
    pairId: payload.pairId,
    generation: payload.generation,
    token: payload.token
  }, 'bridge-credential-candidate.json');
  return { bridgeUrl: base.href, pairId: payload.pairId };
}

export function clearStoredBridgeCredential(dataRoot: string): void {
  fs.rmSync(path.join(dataRoot, 'bridge-credential.json'), { force: true });
}
