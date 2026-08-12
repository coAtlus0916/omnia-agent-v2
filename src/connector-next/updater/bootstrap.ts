import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorNextAgentClient } from '../agent/client.js';
import { connectorNextBootstrapDescriptor } from '../agent/identity.js';
import { ConnectorNextLogSpool } from '../agent/log-spool.js';
import { ConnectorNextAgentStateStore } from '../agent/state-store.js';
import { connectorNextPaths } from '../paths.js';
import { acquireConnectorNextProcessLock, releaseConnectorNextProcessLock } from '../process-lock.js';
import { CONNECTOR_NEXT_BOOTSTRAP_PROCESS } from '../protocol.js';
import { readCurrentPointer, verifyCurrentSlot } from './package.js';

const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

async function record(event: string, details: Record<string, unknown>): Promise<void> {
  const paths = connectorNextPaths({
    ...(process.env.OMNIA_CONNECTOR_NEXT_INSTALL_ROOT ? { installRoot: process.env.OMNIA_CONNECTOR_NEXT_INSTALL_ROOT } : {}),
    ...(process.env.OMNIA_CONNECTOR_NEXT_DATA_ROOT ? { dataRoot: process.env.OMNIA_CONNECTOR_NEXT_DATA_ROOT } : {})
  });
  const logs = new ConnectorNextLogSpool(paths.logDatabase);
  try {
    logs.append('bootstrap', event.endsWith('failed') ? 'error' : 'info', event, details);
    try {
      const stateStore = new ConnectorNextAgentStateStore(paths.stateDatabase);
      try {
        const state = stateStore.load();
        const descriptor = connectorNextBootstrapDescriptor(state, state.version, state.sequence, state.generation);
        const client = new ConnectorNextAgentClient({ serverUrl: state.serverUrl, token: state.token, descriptor });
        await logs.flush(client);
      } finally {
        stateStore.close();
      }
    } catch { /* enrollment or server may be unavailable; the durable spool remains */ }
  } finally {
    logs.close();
  }
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([waitForExit(child).then(() => true), delay(10_000).then(() => false)]);
  if (exited || child.exitCode !== null) return;
  child.kill('SIGKILL');
  const killed = await Promise.race([waitForExit(child).then(() => true), delay(5_000).then(() => false)]);
  if (!killed && child.exitCode === null) throw new Error('CONNECTOR_NEXT.UPDATER_RUNTIME_EXIT_TIMEOUT');
}

export async function runConnectorNextBootstrap(): Promise<void> {
  process.title = CONNECTOR_NEXT_BOOTSTRAP_PROCESS;
  const paths = connectorNextPaths({
    ...(process.env.OMNIA_CONNECTOR_NEXT_INSTALL_ROOT ? { installRoot: process.env.OMNIA_CONNECTOR_NEXT_INSTALL_ROOT } : {}),
    ...(process.env.OMNIA_CONNECTOR_NEXT_DATA_ROOT ? { dataRoot: process.env.OMNIA_CONNECTOR_NEXT_DATA_ROOT } : {})
  });
  const lock = acquireConnectorNextProcessLock(paths.bootstrapLock, CONNECTOR_NEXT_BOOTSTRAP_PROCESS);
  let stopping = false;
  let child: ChildProcess | null = null;
  let failures = 0;
  const requestStop = () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill('SIGTERM');
  };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);
  try {
    await record('bootstrap.started', { pid: process.pid });
    while (!stopping) {
      try {
        const pointer = readCurrentPointer(paths.currentPointer);
        const verified = verifyCurrentSlot(paths, pointer);
        const updaterEntrypoint = path.join(verified.root, ...verified.identity.updaterEntrypoint.split('/'));
        const runtimeExecutable = path.join(verified.root, ...verified.identity.runtimeEntrypoint.split('/'));
        if (!fs.statSync(updaterEntrypoint).isFile()) throw new Error('CONNECTOR_NEXT.UPDATER_RUNTIME_ENTRYPOINT_MISSING');
        if (!fs.statSync(runtimeExecutable).isFile()) throw new Error('CONNECTOR_NEXT.NODE_RUNTIME_ENTRYPOINT_MISSING');
        child = spawn(runtimeExecutable, [updaterEntrypoint], {
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
          env: {
            PATH: process.env.PATH || '',
            SystemRoot: process.env.SystemRoot || '',
            OMNIA_CONNECTOR_NEXT_INSTALL_ROOT: paths.installRoot,
            OMNIA_CONNECTOR_NEXT_DATA_ROOT: paths.dataRoot,
            OMNIA_CONNECTOR_NEXT_UPDATER_VERSION: pointer.version,
            OMNIA_CONNECTOR_NEXT_BOOTSTRAPPED: '1'
          }
        });
        await record('bootstrap.runtime_started', { pid: child.pid || 0, version: pointer.version, sequence: pointer.sequence, generation: pointer.generation });
        const startedAt = Date.now();
        const result = await waitForExit(child);
        child = null;
        if (stopping) break;
        failures = Date.now() - startedAt >= 60_000 ? 0 : failures + 1;
        await record('bootstrap.runtime_exited', { version: pointer.version, code: result.code, signal: result.signal || '', restartAttempt: failures });
      } catch (error) {
        child = null;
        failures += 1;
        await record('bootstrap.runtime_failed', { reason: error instanceof Error ? error.message : String(error), restartAttempt: failures });
      }
      if (!stopping) await delay(RETRY_DELAYS[Math.min(failures - 1, RETRY_DELAYS.length - 1)]!);
    }
  } finally {
    await stopChild(child);
    await record('bootstrap.stopped', { pid: process.pid });
    releaseConnectorNextProcessLock(lock);
  }
}
