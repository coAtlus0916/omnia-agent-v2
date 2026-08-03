import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BRIDGE_PRODUCT,
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA,
  type BridgeConnectorLeaseResult,
  type BridgeConnectorRegistrationResponse
} from '../shared/bridge-contracts.js';
import { writeJsonAtomic } from './managed-state.js';
import { protectRemoteSecret, unprotectRemoteSecret } from './windows-secret.js';

interface StoredBridgeCredential {
  schemaVersion: 'omnia.v5.remote-connector-credential/v1';
  bridgeUrl: string;
  pairId: string;
  tokenCiphertext: string;
  pairedAt: string;
}

export interface BridgeCredential {
  bridgeUrl: string;
  pairId: string;
  token: string;
}

export interface ConnectorDeviceIdentity {
  schemaVersion: 'omnia.v5.remote-connector-device/v1';
  connectorId: string;
  createdAt: string;
}

export interface WaitingLease {
  bridgeUrl: string;
  leaseId: string;
  leaseSecret: string;
  expiresAt: string;
  connectorId: string;
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

export function readStoredBridgeCredential(dataRoot: string): BridgeCredential | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(dataRoot, 'bridge-credential.json'), 'utf8')
    ) as StoredBridgeCredential;
    if (
      value.schemaVersion !== 'omnia.v5.remote-connector-credential/v1'
      || !value.bridgeUrl
      || !value.pairId
      || !value.tokenCiphertext
    ) return null;
    const base = validateRemoteBridgeUrl(value.bridgeUrl);
    return {
      bridgeUrl: base.href,
      pairId: value.pairId,
      token: unprotectRemoteSecret(value.tokenCiphertext)
    };
  } catch {
    return null;
  }
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

function storeBridgeCredential(dataRoot: string, input: BridgeCredential): void {
  writeJsonAtomic(path.join(dataRoot, 'bridge-credential.json'), {
    schemaVersion: 'omnia.v5.remote-connector-credential/v1',
    bridgeUrl: input.bridgeUrl,
    pairId: input.pairId,
    tokenCiphertext: protectRemoteSecret(input.token),
    pairedAt: new Date().toISOString()
  } satisfies StoredBridgeCredential);
}

export async function registerWaitingConnector(input: {
  dataRoot: string;
  bridgeUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<WaitingLease> {
  const base = validateRemoteBridgeUrl(input.bridgeUrl);
  const identity = readOrCreateConnectorDeviceIdentity(input.dataRoot);
  const response = await (input.fetchImpl || fetch)(
    new URL('v1/discovery/connectors', base.href.endsWith('/') ? base.href : `${base.href}/`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        schemaVersion: BRIDGE_SCHEMA,
        product: BRIDGE_PRODUCT,
        protocol: BRIDGE_PROTOCOL,
        connectorId: identity.connectorId,
        name: `${os.hostname()} Omnia Agent v5 Remote Connector`,
        platform: `${process.platform}-${process.arch}`
      }),
      signal: AbortSignal.timeout(20_000)
    }
  );
  const payload = await response.json().catch(() => ({})) as BridgeConnectorRegistrationResponse & { message?: string };
  if (
    !response.ok
    || payload.schemaVersion !== BRIDGE_SCHEMA
    || typeof payload.leaseId !== 'string'
    || typeof payload.leaseSecret !== 'string'
    || !Number.isFinite(Date.parse(payload.expiresAt))
  ) throw new Error(payload.message || `Bridge waiting registration failed with HTTP ${response.status}.`);
  return {
    bridgeUrl: base.href,
    leaseId: payload.leaseId,
    leaseSecret: payload.leaseSecret,
    expiresAt: payload.expiresAt,
    connectorId: identity.connectorId
  };
}

export async function pollWaitingConnector(input: {
  dataRoot: string;
  lease: WaitingLease;
  fetchImpl?: typeof fetch;
}): Promise<'waiting' | 'matched' | 'expired'> {
  const base = validateRemoteBridgeUrl(input.lease.bridgeUrl);
  const response = await (input.fetchImpl || fetch)(
    new URL(`v1/discovery/connectors/${encodeURIComponent(input.lease.leaseId)}`, base.href.endsWith('/') ? base.href : `${base.href}/`),
    {
      headers: { Authorization: `Pairing ${input.lease.leaseSecret}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    }
  );
  const payload = await response.json().catch(() => ({})) as BridgeConnectorLeaseResult & { message?: string };
  if (response.status === 410 || payload.state === 'expired') return 'expired';
  if (!response.ok || payload.schemaVersion !== BRIDGE_SCHEMA) {
    throw new Error(payload.message || `Bridge waiting poll failed with HTTP ${response.status}.`);
  }
  if (payload.state === 'waiting') return 'waiting';
  if (payload.state !== 'matched' || !payload.pairId || !payload.token) {
    throw new Error('Bridge returned an invalid Connector match result.');
  }
  storeBridgeCredential(input.dataRoot, {
    bridgeUrl: base.href,
    pairId: payload.pairId,
    token: payload.token
  });
  return 'matched';
}

export async function pairRemoteConnector(input: {
  dataRoot: string;
  bridgeUrl: string;
  pairingCode: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<{ bridgeUrl: string; pairId: string }> {
  const base = validateRemoteBridgeUrl(input.bridgeUrl);
  const pairingCode = input.pairingCode.trim();
  if (!pairingCode || pairingCode.length > 500) throw new Error('Connector 一次性配对码无效。');
  const response = await (input.fetchImpl || fetch)(
    new URL('v1/pair', base.href.endsWith('/') ? base.href : `${base.href}/`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        schemaVersion: BRIDGE_SCHEMA,
        role: 'connector',
        pairingCode,
        name: input.name.trim().slice(0, 160) || 'Omnia Agent v5 Remote Connector'
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
    || !payload.pairId
    || !payload.token
  ) throw new Error(payload.message || `Bridge pairing failed with HTTP ${response.status}.`);
  storeBridgeCredential(input.dataRoot, { bridgeUrl: base.href, pairId: payload.pairId, token: payload.token });
  return { bridgeUrl: base.href, pairId: payload.pairId };
}
