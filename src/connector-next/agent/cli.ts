import { setTimeout as delay } from 'node:timers/promises';
import { connectorNextPaths } from '../paths.js';
import { CONNECTOR_NEXT_AGENT_PROCESS, CONNECTOR_NEXT_PRODUCT_ID, CONNECTOR_NEXT_PROTOCOL_ID, assertTarget } from '../protocol.js';
import { ConnectorNextAgentClient } from './client.js';
import { connectorNextDescriptor } from './identity.js';
import { ConnectorNextLogSpool } from './log-spool.js';
import { ConnectorNextAgentRuntime } from './runtime.js';
import { ConnectorNextRuntimeGate } from './runtime-gate.js';
import { ConnectorNextAgentStateStore } from './state-store.js';
import { ConnectorNextPackOperationHost } from './pack-operation-host.js';
import fs from 'node:fs';
import path from 'node:path';
import { acquireConnectorNextProcessLock, releaseConnectorNextProcessLock } from '../process-lock.js';
import { randomBytes } from 'node:crypto';

async function main(): Promise<void> {
process.title = CONNECTOR_NEXT_AGENT_PROCESS;
const args = process.argv.slice(2);
const version = process.env.OMNIA_CONNECTOR_NEXT_VERSION || '0.1.0';
const sequence = Number(process.env.OMNIA_CONNECTOR_NEXT_SEQUENCE || 1);

const installRoot = process.env.OMNIA_CONNECTOR_NEXT_INSTALL_ROOT;
const dataRoot = process.env.OMNIA_CONNECTOR_NEXT_DATA_ROOT;
const paths = connectorNextPaths({ ...(installRoot ? { installRoot } : {}), ...(dataRoot ? { dataRoot } : {}) });
const stateStore = new ConnectorNextAgentStateStore(paths.stateDatabase);

if (args.includes('--connector-next-candidate-health') || args.includes('--connector-next-probation-health')) {
  const state = stateStore.load();
  const generation = Number(process.env.OMNIA_CONNECTOR_NEXT_CANDIDATE_GENERATION || 0);
  const offerId = process.env.OMNIA_CONNECTOR_NEXT_CANDIDATE_OFFER_ID || '';
  const descriptor = connectorNextDescriptor(state, version, sequence, generation);
  const candidateClient = new ConnectorNextAgentClient({ serverUrl: state.serverUrl, token: state.token, descriptor });
  const phase = args.includes('--connector-next-probation-health') ? 'probation' : 'candidate';
  const candidateGate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
  const uncertainJobIds = candidateGate.uncertainMutationJobIds();
  const confirmed = await candidateClient.candidateHeartbeat(offerId, phase, uncertainJobIds);
  const reconciledNotStarted = confirmed.notStartedJobIds.reduce((count, jobId) => count + candidateGate.resolveMutationNotStarted(jobId), 0);
  candidateGate.close();
  process.stdout.write(`${JSON.stringify({ healthy: confirmed.accepted, admission: 'health_only', productId: CONNECTOR_NEXT_PRODUCT_ID, protocolId: CONNECTOR_NEXT_PROTOCOL_ID, version, sequence, generation, offerId, phase, reconciledNotStarted })}\n`);
  stateStore.close();
  process.exit(0);
}

if (args[0] === 'enroll') {
  const serverUrl = args[1] || '';
  const enrollmentCode = args[2] || '';
  const target = JSON.parse(args[3] || '{}') as { agentId: string; deviceId: string; connectorInstanceId: string };
  assertTarget(target);
  const descriptor = connectorNextDescriptor(target, version, sequence, 1);
  const client = new ConnectorNextAgentClient({ serverUrl, descriptor });
  const enrolled = await client.enroll(enrollmentCode);
  stateStore.save({ ...target, serverUrl, token: enrolled.token, version, sequence, generation: enrolled.generation });
  process.stdout.write(`${JSON.stringify({ enrolled: true, target, version, generation: enrolled.generation })}\n`);
  stateStore.close();
  process.exit(0);
}

const processLock = acquireConnectorNextProcessLock(paths.agentLock, CONNECTOR_NEXT_AGENT_PROCESS);
try {
const state = stateStore.load();
const activeVersion = process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_VERSION || state.version;
const activeSequence = Number(process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_SEQUENCE || state.sequence);
const activeGeneration = Number(process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_GENERATION || state.generation);
const descriptor = connectorNextDescriptor(state, activeVersion, activeSequence, activeGeneration);
const client = new ConnectorNextAgentClient({ serverUrl: state.serverUrl, token: state.token, descriptor });
const logs = new ConnectorNextLogSpool(paths.logDatabase);
const gate = new ConnectorNextRuntimeGate(paths.runtimeDatabase);
gate.recoverInterrupted();
const packOperations = new ConnectorNextPackOperationHost(paths.packRoot, descriptor, fetch, (event, details) => {
  logs.append('protocol', event.endsWith('.failed') ? 'warn' : 'info', event, details);
});
const executionGeneration = randomBytes(24).toString('hex');
const runtime = new ConnectorNextAgentRuntime({ client, descriptor, logs, gate, packOperations, executionGeneration });
const requestedJobConcurrency = Number(process.env.OMNIA_CONNECTOR_NEXT_JOB_CONCURRENCY || 8);
const jobConcurrency = Number.isInteger(requestedJobConcurrency) ? Math.max(1, Math.min(8, requestedJobConcurrency)) : 8;
const activeOfferId = process.env.OMNIA_CONNECTOR_NEXT_ACTIVE_OFFER_ID || '';
if (activeOfferId) {
  await client.candidateHeartbeat(activeOfferId, 'probation');
} else {
  const confirmedIdentity = await client.confirmIdentity();
  if (confirmedIdentity.version !== activeVersion || confirmedIdentity.sequence !== activeSequence || confirmedIdentity.generation !== activeGeneration) {
    throw new Error('CONNECTOR_NEXT.ACTIVE_SERVER_IDENTITY_MISMATCH');
  }
}
const readinessFile = process.env.OMNIA_CONNECTOR_NEXT_READINESS_FILE;
if (readinessFile) {
  const temporary = `${readinessFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(readinessFile), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ ready: true, pid: process.pid, version: activeVersion, sequence: activeSequence, generation: activeGeneration }));
  fs.renameSync(temporary, readinessFile);
}
logs.append('agent', 'info', 'agent.started', { version: activeVersion, sequence: activeSequence, generation: activeGeneration, jobConcurrency });

if (args.includes('--once')) {
  process.stdout.write(`${JSON.stringify(await runtime.runOnce())}\n`);
} else {
  let running = true;
  process.once('SIGTERM', () => { running = false; });
  process.once('SIGINT', () => { running = false; });
  const updaterPid = Number(process.env.OMNIA_CONNECTOR_NEXT_UPDATER_PID || 0);
  while (running) {
    if (Number.isInteger(updaterPid) && updaterPid > 0) {
      try { process.kill(updaterPid, 0); } catch { running = false; break; }
    }
    let executed = 0;
    try { executed = (await runtime.runBatch(jobConcurrency)).executedJobIds.length; }
    catch (error) { logs.append('protocol', 'warn', 'agent.poll_failed', { message: error instanceof Error ? error.message : String(error) }); }
    // pollJobs already performs a bounded server-side wait. Successful work
    // drains the next batch immediately; an empty queue has no second sleep.
    if (executed === 0) await delay(0);
  }
  logs.append('agent', 'info', 'agent.stopped', { version: activeVersion, generation: activeGeneration });
  try { await logs.flush(client); } catch { /* durable retry on next start */ }
}
gate.close();
logs.close();
await packOperations.close();
stateStore.close();
} finally {
  releaseConnectorNextProcessLock(processLock);
}
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
