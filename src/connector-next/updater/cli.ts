import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorNextAgentClient } from '../agent/client.js';
import { connectorNextUpdaterDescriptor } from '../agent/identity.js';
import { ConnectorNextLogSpool } from '../agent/log-spool.js';
import { ConnectorNextRuntimeGate } from '../agent/runtime-gate.js';
import { ConnectorNextAgentStateStore } from '../agent/state-store.js';
import { connectorNextPaths } from '../paths.js';
import { CONNECTOR_NEXT_UPDATER_PROCESS } from '../protocol.js';
import { ConnectorNextGuardian } from './guardian.js';
import { readCurrentPointer } from './package.js';
import { ConnectorNextAgentProcessHost } from './process-host.js';
import { acquireConnectorNextProcessLock, connectorNextProcessLockIsLive, releaseConnectorNextProcessLock } from '../process-lock.js';

async function main(): Promise<void> {
process.title = CONNECTOR_NEXT_UPDATER_PROCESS;
const paths = connectorNextPaths({
  ...(process.env.OMNIA_CONNECTOR_NEXT_INSTALL_ROOT ? { installRoot: process.env.OMNIA_CONNECTOR_NEXT_INSTALL_ROOT } : {}),
  ...(process.env.OMNIA_CONNECTOR_NEXT_DATA_ROOT ? { dataRoot: process.env.OMNIA_CONNECTOR_NEXT_DATA_ROOT } : {})
});
let keyId = process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_KEY_ID || '';
let publicKey = (process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_PUBLIC_KEY || '').replaceAll('\\n', '\n');
if (!keyId || !publicKey) {
  const fsModule = await import('node:fs');
  const trust = JSON.parse(fsModule.readFileSync(`${paths.installRoot}/bootstrap-v3/trust-v3.json`, 'utf8')) as { schemaVersion?: string; productId?: string; protocolId?: string; signingKeyId?: string; publisherPublicKey?: string };
  if (trust.schemaVersion !== 'omnia.connector-next-updater-trust/v1' || trust.productId !== 'com.deloitte.omnia-agent.connector-next' || trust.protocolId !== 'omnia.connector-next/v3') throw new Error('CONNECTOR_NEXT.UPDATER_TRUST_INVALID');
  keyId = trust.signingKeyId || '';
  publicKey = trust.publisherPublicKey || '';
}
if (!keyId || !publicKey) throw new Error('CONNECTOR_NEXT.PUBLISHER_KEY_REQUIRED');
const lock = acquireConnectorNextProcessLock(paths.updaterLock, CONNECTOR_NEXT_UPDATER_PROCESS);

const stateStore = new ConnectorNextAgentStateStore(paths.stateDatabase);
const state = stateStore.load();
const startupPointer = readCurrentPointer(paths.currentPointer);
if (startupPointer.generation !== state.generation || startupPointer.version !== state.version || startupPointer.sequence !== state.sequence) {
  const pointerDescriptor = connectorNextUpdaterDescriptor(state, startupPointer.version, startupPointer.sequence, startupPointer.generation);
  const pointerClient = new ConnectorNextAgentClient({ serverUrl: state.serverUrl, token: state.token, descriptor: pointerDescriptor });
  try {
    const confirmed = await pointerClient.confirmIdentity();
    if (confirmed.version !== startupPointer.version || confirmed.sequence !== startupPointer.sequence || confirmed.generation !== startupPointer.generation) {
      throw new Error('CONNECTOR_NEXT.STARTUP_IDENTITY_RECONCILE_MISMATCH');
    }
    Object.assign(state, { version: startupPointer.version, sequence: startupPointer.sequence, generation: startupPointer.generation });
    stateStore.save(state);
  } catch (error) {
    if (!(error instanceof Error) || !['CONNECTOR_NEXT.IDENTITY_FENCE_REJECTED', 'CONNECTOR_NEXT.AUTHENTICATION_FAILED'].includes(error.message)) throw error;
  }
}
const descriptor = connectorNextUpdaterDescriptor(state, state.version, state.sequence, state.generation);
const client = new ConnectorNextAgentClient({ serverUrl: state.serverUrl, token: state.token, descriptor });
const logs = new ConnectorNextLogSpool(paths.logDatabase);
const gate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
gate.recoverInterrupted();
const initialGate = gate.snapshot();
const initialPointer = readCurrentPointer(paths.currentPointer);
const pointerRequiresRecovery = initialPointer.generation !== state.generation || initialPointer.version !== state.version || initialPointer.sequence !== state.sequence;
if (pointerRequiresRecovery || initialGate.activeMutation > 0) gate.setAdmission(false);
else if (initialGate.uncertainMutation > 0) gate.setAdmissionMode('read_only_only');
else gate.setAdmission(true);
const processHost = new ConnectorNextAgentProcessHost(paths);
const staleAgentDeadline = Date.now() + 5_000;
while (connectorNextProcessLockIsLive(paths.agentLock, 'OmniaConnectorNextAgent') && Date.now() < staleAgentDeadline) await delay(100);
if (connectorNextProcessLockIsLive(paths.agentLock, 'OmniaConnectorNextAgent')) throw new Error('CONNECTOR_NEXT.PREVIOUS_AGENT_DID_NOT_EXIT');
if (!pointerRequiresRecovery) await processHost.start(initialPointer);

const guardian = new ConnectorNextGuardian({
  version: process.env.OMNIA_CONNECTOR_NEXT_UPDATER_VERSION || '0.1.0',
  client,
  descriptor,
  paths,
  gate,
  logs,
  publisherKeys: { [keyId]: publicKey },
  processHost,
  persistActivatedState(next) {
    Object.assign(state, next);
    stateStore.save(state);
  }
});

let running = true;
process.once('SIGTERM', () => { running = false; });
process.once('SIGINT', () => { running = false; });
logs.append('updater', 'info', 'updater.started', { version: process.env.OMNIA_CONNECTOR_NEXT_UPDATER_VERSION || '0.1.0' });
try {
  while (running) {
    const result = await guardian.checkOnce();
    if (result.status === 'failed') logs.append('updater', 'error', 'updater.cycle_failed', { reason: result.reason || 'unknown' });
    try { await logs.flush(client); } catch { /* durable retry */ }
    if (result.status === 'updated' && process.env.OMNIA_CONNECTOR_NEXT_BOOTSTRAPPED === '1') break;
    const observedPointer = readCurrentPointer(paths.currentPointer);
    if (result.status === 'failed' && process.env.OMNIA_CONNECTOR_NEXT_BOOTSTRAPPED === '1'
      && (observedPointer.generation !== state.generation || observedPointer.version !== state.version || observedPointer.sequence !== state.sequence)) break;
    if (process.argv.includes('--once')) break;
    await delay(15_000);
  }
} finally {
  gate.setAdmission(false);
  await processHost.stop();
  logs.append('updater', 'info', 'updater.stopped');
  try { await logs.flush(client); } catch { /* durable retry */ }
  gate.close();
  logs.close();
  stateStore.close();
  releaseConnectorNextProcessLock(lock);
}
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
