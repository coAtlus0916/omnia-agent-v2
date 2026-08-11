import fs from 'node:fs';
import { connectorNextPaths, assertConnectorNextPathIsolation } from './paths.js';
import { assertTarget, type ConnectorNextTarget, type ConnectorNextUpdateManifest } from './protocol.js';
import { installConnectorNext, registerConnectorNextStartup, startConnectorNext } from './installer.js';
import { ConnectorNextAgentClient } from './agent/client.js';
import { connectorNextDescriptor, connectorNextInstallerDescriptor } from './agent/identity.js';
import { ConnectorNextLogSpool } from './agent/log-spool.js';
import { ConnectorNextAgentStateStore } from './agent/state-store.js';
import { readCurrentPointer } from './updater/package.js';

async function main(): Promise<void> {
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index] || '', process.argv[index + 1] || '');
const installRoot = args.get('--install-root');
const dataRoot = args.get('--data-root');
const paths = connectorNextPaths({ ...(installRoot ? { installRoot } : {}), ...(dataRoot ? { dataRoot } : {}) });
assertConnectorNextPathIsolation(paths);
const registerStartup = args.get('--register-startup') === 'true';
const start = args.get('--start') === 'true';
const enrollOnly = args.get('--enroll-only') === 'true';
const serverUrl = args.get('--server-url') || '';
const enrollmentCode = args.get('--enrollment-code') || '';
const targetJson = args.get('--target-json') || '';
const hasEnrollment = Boolean(serverUrl && enrollmentCode && targetJson);
if ((serverUrl || enrollmentCode || targetJson) && !hasEnrollment) throw new Error('CONNECTOR_NEXT.ENROLLMENT_ARGUMENTS_INCOMPLETE');
if ((registerStartup || start || enrollOnly) && !hasEnrollment) throw new Error('CONNECTOR_NEXT.ENROLLMENT_REQUIRED_BEFORE_START');

let pointer;
if (enrollOnly) {
  pointer = readCurrentPointer(paths.currentPointer);
} else {
  const manifestFile = args.get('--manifest');
  const packageFile = args.get('--package');
  const publicKeyFile = args.get('--publisher-public-key');
  const bootstrapExecutable = args.get('--bootstrap');
  if (!manifestFile || !packageFile || !publicKeyFile || !bootstrapExecutable) throw new Error('required: --manifest --package --publisher-public-key --bootstrap');
  pointer = installConnectorNext({
    paths,
    manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as ConnectorNextUpdateManifest,
    packageBytes: fs.readFileSync(packageFile),
    publisherPublicKey: fs.readFileSync(publicKeyFile, 'utf8'),
    bootstrapExecutable,
    registerStartup: false
  });
}

let enrolled = false;
if (hasEnrollment) {
  const target = JSON.parse(targetJson) as ConnectorNextTarget;
  assertTarget(target);
  const enrollmentDescriptor = connectorNextDescriptor(target, pointer.version, pointer.sequence, pointer.generation);
  const enrollmentClient = new ConnectorNextAgentClient({ serverUrl, descriptor: enrollmentDescriptor });
  const enrollment = await enrollmentClient.enroll(enrollmentCode);
  if (enrollment.version !== pointer.version || enrollment.generation !== pointer.generation) throw new Error('CONNECTOR_NEXT.ENROLLMENT_VERSION_MISMATCH');
  const stateStore = new ConnectorNextAgentStateStore(paths.stateDatabase);
  stateStore.save({ ...target, serverUrl, token: enrollment.token, version: pointer.version, sequence: pointer.sequence, generation: pointer.generation });
  stateStore.close();
  const logs = new ConnectorNextLogSpool(paths.logDatabase);
  logs.append('installer', 'info', 'installer.enrolled', { version: pointer.version, sequence: pointer.sequence, generation: pointer.generation });
  try {
    enrollmentClient.setToken(enrollment.token);
    enrollmentClient.updateDescriptor(connectorNextInstallerDescriptor(target, pointer.version, pointer.sequence, pointer.generation));
    await logs.flush(enrollmentClient);
  } catch { /* durable retry by bootstrap/updater */ }
  logs.close();
  enrolled = true;
}
if (registerStartup) registerConnectorNextStartup(paths);
const startup = start ? await startConnectorNext(paths) : null;
process.stdout.write(`${JSON.stringify({ installed: true, enrolled, started: start, bootstrapPid: startup?.bootstrapPid || 0, pointer, installRoot: paths.installRoot, dataRoot: paths.dataRoot, startupRegistered: registerStartup })}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
