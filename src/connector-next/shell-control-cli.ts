import { ConnectorNextControlClient } from '../main/connector/connector-next-control-client.js';
import { assertTarget, type ConnectorNextTarget } from './protocol.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectorNextUpdateManifest } from './protocol.js';
import { ConnectorNextShellBindingStore } from '../main/connector/connector-next-binding-store.js';

async function main(): Promise<void> {
const [command, argument] = process.argv.slice(2);
const serverUrl = process.env.OMNIA_CONNECTOR_NEXT_SERVER_URL || 'http://127.0.0.1:43173/connector-next/v3/';
const controlToken = process.env.OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN || '';
const client = new ConnectorNextControlClient({ serverUrl, controlToken });
const bindingFile = path.resolve(process.env.OMNIA_CONNECTOR_NEXT_SHELL_BINDING_FILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Omnia Agent v5', 'connector-next-shell-bindings-v3.sqlite'));

if (command === 'binding-enroll') {
  if (!argument) throw new Error('{"agentId":"...","deviceId":"..."} is required');
  const input = JSON.parse(argument) as { agentId?: string; deviceId?: string };
  const bindings = new ConnectorNextShellBindingStore(bindingFile);
  try { process.stdout.write(`${JSON.stringify(await bindings.beginEnrollment(client, input.agentId || '', input.deviceId || ''))}\n`); }
  finally { bindings.close(); }
} else if (command === 'binding-status') {
  if (!argument) throw new Error('{"agentId":"...","deviceId":"..."} is required');
  const input = JSON.parse(argument) as { agentId?: string; deviceId?: string };
  const bindings = new ConnectorNextShellBindingStore(bindingFile);
  try { process.stdout.write(`${JSON.stringify(await bindings.refreshEnrollment(client, input.agentId || '', input.deviceId || ''))}\n`); }
  finally { bindings.close(); }
} else if (command === 'binding-get') {
  if (!argument) throw new Error('{"agentId":"...","deviceId":"..."} is required');
  const input = JSON.parse(argument) as { agentId?: string; deviceId?: string };
  const bindings = new ConnectorNextShellBindingStore(bindingFile);
  try { process.stdout.write(`${JSON.stringify(bindings.binding(input.agentId || '', input.deviceId || ''))}\n`); }
  finally { bindings.close(); }
} else if (command === 'enroll') {
  if (!argument) throw new Error('exact persisted target JSON is required');
  const target = JSON.parse(argument) as ConnectorNextTarget;
  assertTarget(target);
  process.stdout.write(`${JSON.stringify(await client.createEnrollment(target))}\n`);
} else if (command === 'job-health') {
  if (!argument) throw new Error('target JSON is required');
  const target = JSON.parse(argument) as ConnectorNextTarget;
  assertTarget(target);
  process.stdout.write(`${JSON.stringify(await client.enqueueSystemHealthRead(target))}\n`);
} else if (command === 'job-get') {
  if (!argument) throw new Error('jobId is required');
  process.stdout.write(`${JSON.stringify(await client.getJob(argument))}\n`);
} else if (command === 'logs') {
  if (!argument) throw new Error('target JSON is required');
  const target = JSON.parse(argument) as ConnectorNextTarget;
  assertTarget(target);
  process.stdout.write(`${JSON.stringify(await client.queryLogs(target))}\n`);
} else if (command === 'identity') {
  if (!argument) throw new Error('target JSON is required');
  const target = JSON.parse(argument) as ConnectorNextTarget;
  assertTarget(target);
  process.stdout.write(`${JSON.stringify(await client.getConnectorIdentity(target))}\n`);
} else if (command === 'update-register') {
  if (!argument) throw new Error('{"manifestFile":"...","packageFile":"..."} is required');
  const files = JSON.parse(argument) as { manifestFile: string; packageFile: string };
  const manifest = JSON.parse(fs.readFileSync(files.manifestFile, 'utf8')) as ConnectorNextUpdateManifest;
  process.stdout.write(`${JSON.stringify(await client.registerUpdateArtifact(manifest, fs.readFileSync(files.packageFile)))}\n`);
} else if (command === 'update-offer') {
  if (!argument) throw new Error('{"target":{...},"artifactId":"..."} is required');
  const input = JSON.parse(argument) as { target: ConnectorNextTarget; artifactId: string };
  assertTarget(input.target);
  process.stdout.write(`${JSON.stringify(await client.offerUpdate(input.target, input.artifactId))}\n`);
} else if (command === 'update-get') {
  if (!argument) throw new Error('offerId is required');
  process.stdout.write(`${JSON.stringify(await client.getUpdateOffer(argument))}\n`);
} else {
  throw new Error('usage: connector-next-control <binding-enroll|binding-status|binding-get|enroll|job-health|job-get|logs|identity|update-register|update-offer|update-get> [argument]');
}
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
