import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectBridgePairingCapability } from '../src/main/connector/remote-connector-transport.js';
import {
  type UpdateManifest,
  validateUpdateManifest
} from '../src/remote-connector/release-contract.js';

export async function verifyBridgePairingTarget(
  bridgeUrl: string,
  fetchImpl: typeof fetch = fetch
) {
  const inspection = await inspectBridgePairingCapability({ bridgeUrl }, fetchImpl);
  if (!inspection.canCreateSession) {
    throw new Error(`${inspection.reasonCode || 'REMOTE.BRIDGE_UPGRADE_REQUIRED'}: ${inspection.reason}`);
  }
  return inspection;
}

export async function verifyRemoteConnectorArchiveTarget(
  manifestInput: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<UpdateManifest> {
  const manifest = validateUpdateManifest(manifestInput);
  const response = await fetchImpl(manifest.url, {
    headers: { Accept: 'application/zip' },
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) {
    throw new Error(`Remote Connector target ZIP is unavailable (HTTP ${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== manifest.size || digest !== manifest.sha256) {
    throw new Error('Remote Connector target ZIP size or digest does not match the signed stable manifest.');
  }
  return manifest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? String(args[index + 1] || '') : '';
  };
  const bridgeUrl = value('--bridge-url');
  const connectorManifest = value('--connector-manifest');
  if (!bridgeUrl && !connectorManifest) {
    throw new Error('usage: verify-remote-release-target [--bridge-url URL] [--connector-manifest FILE]');
  }
  const result: Record<string, unknown> = { ok: true };
  if (bridgeUrl) result.bridge = await verifyBridgePairingTarget(bridgeUrl);
  if (connectorManifest) {
    const filename = path.resolve(connectorManifest);
    const manifest = await verifyRemoteConnectorArchiveTarget(JSON.parse(fs.readFileSync(filename, 'utf8')));
    result.connector = {
      version: manifest.version,
      sequence: manifest.sequence,
      sha256: manifest.sha256,
      size: manifest.size,
      url: manifest.url
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
