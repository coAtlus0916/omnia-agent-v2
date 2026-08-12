import { setTimeout as delay } from 'node:timers/promises';
import { assertConnectorNextPathIsolation, connectorNextPaths } from '../paths.js';
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
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readCurrentPointer, verifyCurrentSlot } from '../updater/package.js';

function exactUpdaterParentPid(paths: ReturnType<typeof connectorNextPaths>): number | null {
  if (process.platform !== 'win32' || !Number.isSafeInteger(process.ppid) || process.ppid < 1) return null;
  try {
    const current = readCurrentPointer(paths.currentPointer);
    const verified = verifyCurrentSlot(paths, current);
    const expectedRuntime = path.resolve(verified.root, ...verified.identity.runtimeEntrypoint.split('/')).toLowerCase();
    const expectedUpdater = path.resolve(verified.root, ...verified.identity.updaterEntrypoint.split('/')).toLowerCase();
    const script = `$item=Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}" -ErrorAction Stop; if(-not $item){exit 3}; [pscustomobject]@{processId=[int]$item.ProcessId;executablePath=[string]$item.ExecutablePath;commandLine=[string]$item.CommandLine}|ConvertTo-Json -Compress`;
    const observed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5_000 })) as {
      processId?: unknown; executablePath?: unknown; commandLine?: unknown;
    };
    const executablePath = path.resolve(String(observed.executablePath || '')).toLowerCase();
    const commandLine = String(observed.commandLine || '').toLowerCase();
    return observed.processId === process.ppid && executablePath === expectedRuntime && commandLine.includes(expectedUpdater)
      ? process.ppid : null;
  } catch {
    return null;
  }
}

function candidateRuntimeGateFiles(paths: ReturnType<typeof connectorNextPaths>): Array<{ source: string; filename: string; existed: boolean }> {
  const files = new Map<string, { source: string; filename: string; existed: boolean }>();
  const add = (source: string, filename: string) => {
    const resolved = path.resolve(filename);
    const key = resolved.toLowerCase();
    const existed = fs.existsSync(resolved);
    const previous = files.get(key);
    files.set(key, { source: previous ? `${previous.source}_${source}`.slice(0, 32) : source, filename: resolved, existed: previous?.existed || existed });
  };
  add('explicit', paths.runtimeDatabase);
  const defaultGate = connectorNextPaths().runtimeDatabase;
  if (fs.existsSync(defaultGate)) add('default', defaultGate);
  try {
    const launcher = fs.readFileSync(path.join(paths.installRoot, 'start-connector-next-v3.cmd'), 'utf8');
    const match = launcher.match(/^set "OMNIA_CONNECTOR_NEXT_DATA_ROOT=([^"\r\n]+)"\s*$/imu);
    if (match?.[1]) {
      const installed = connectorNextPaths({ installRoot: paths.installRoot, dataRoot: match[1] });
      assertConnectorNextPathIsolation(installed);
      add('launcher', installed.runtimeDatabase);
    }
  } catch { /* the exact explicit gate remains authoritative */ }
  return [...files.values()];
}

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
  const candidateGates = candidateRuntimeGateFiles(paths).map((entry) => ({ ...entry, gate: new ConnectorNextRuntimeGate(entry.filename) }));
  let forwardedUncertainJobIds: string[] = [];
  if (process.env.OMNIA_CONNECTOR_NEXT_CANDIDATE_UNCERTAIN_JOB_IDS) {
    const parsed = JSON.parse(process.env.OMNIA_CONNECTOR_NEXT_CANDIDATE_UNCERTAIN_JOB_IDS) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 128
      || parsed.some((jobId) => typeof jobId !== 'string' || !/^ocn3\.job\.[0-9a-f-]{36}$/u.test(jobId))) {
      throw new Error('CONNECTOR_NEXT.CANDIDATE_UNCERTAIN_JOB_IDS_INVALID');
    }
    forwardedUncertainJobIds = parsed as string[];
  }
  // The server never admits a read-only job with a deadline above ten minutes.
  // Candidate health may therefore close only leases older than that hard
  // protocol ceiling. Mutation leases remain untouched and fail closed.
  const expiredReadOnlyLeases = candidateGates.reduce(
    (count, entry) => count + entry.gate.completeExpiredReadOnlyLeases(10 * 60 * 1_000),
    0
  );
  const gateDiagnostics = candidateGates.map((entry) => ({
    source: entry.source,
    pathHash: `sha256:${createHash('sha256').update(entry.filename.toLowerCase()).digest('hex')}`,
    existed: entry.existed,
    uncertainJobIds: entry.gate.uncertainMutationJobIds()
  }));
  const uncertainJobIds = [...new Set([...gateDiagnostics.flatMap((entry) => entry.uncertainJobIds), ...forwardedUncertainJobIds])];
  const confirmed = await candidateClient.candidateHeartbeat(offerId, phase, uncertainJobIds, gateDiagnostics);
  const resolvedJobIds = confirmed.resolvedUncertainJobIds || confirmed.notStartedJobIds;
  const reconciledUncertain = resolvedJobIds.reduce((count, jobId) => count
    + candidateGates.reduce((gateCount, entry) => gateCount + entry.gate.resolveMutationAuthoritatively(jobId), 0), 0);
  const updaterParentPid = phase === 'candidate' && resolvedJobIds.length > 0 ? exactUpdaterParentPid(paths) : null;
  for (const entry of candidateGates) entry.gate.close();
  stateStore.close();
  fs.writeSync(process.stdout.fd, `${JSON.stringify({ healthy: confirmed.accepted, admission: 'health_only', productId: CONNECTOR_NEXT_PRODUCT_ID, protocolId: CONNECTOR_NEXT_PROTOCOL_ID, version, sequence, generation, offerId, phase, expiredReadOnlyLeases, reconciledUncertain, resolvedUncertainJobIds: resolvedJobIds, updaterRefreshRequested: updaterParentPid !== null })}\n`);
  if (updaterParentPid !== null) process.kill(updaterParentPid, 'SIGTERM');
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
