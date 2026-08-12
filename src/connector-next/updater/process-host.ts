import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorNextPaths } from '../paths.js';
import { type CurrentPointer, verifyCurrentSlot } from './package.js';

export class ConnectorNextAgentProcessHost {
  private child: ChildProcess | null = null;
  constructor(private readonly paths: ConnectorNextPaths, private readonly runtimeExecutableOverride?: string) {}

  async start(pointer: CurrentPointer, offerId?: string): Promise<void> {
    if (this.child && this.child.exitCode === null) throw new Error('CONNECTOR_NEXT.AGENT_PROCESS_ALREADY_RUNNING');
    const verified = verifyCurrentSlot(this.paths, pointer);
    const entrypoint = path.join(verified.root, ...verified.identity.entrypoint.split('/'));
    const runtimeExecutable = this.runtimeExecutableOverride || path.join(verified.root, ...verified.identity.runtimeEntrypoint.split('/'));
    if (!fs.existsSync(entrypoint)) throw new Error('CONNECTOR_NEXT.ACTIVE_AGENT_ENTRYPOINT_MISSING');
    const readiness = path.join(this.paths.updateRoot, 'readiness-v3', `${pointer.generation}-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(readiness), { recursive: true });
    const child = spawn(runtimeExecutable, [entrypoint, '--service'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || '',
        OMNIA_CONNECTOR_NEXT_INSTALL_ROOT: this.paths.installRoot,
        OMNIA_CONNECTOR_NEXT_DATA_ROOT: this.paths.dataRoot,
        OMNIA_CONNECTOR_NEXT_ACTIVE_VERSION: pointer.version,
        OMNIA_CONNECTOR_NEXT_ACTIVE_SEQUENCE: String(pointer.sequence),
        OMNIA_CONNECTOR_NEXT_ACTIVE_GENERATION: String(pointer.generation),
        OMNIA_CONNECTOR_NEXT_ACTIVE_OFFER_ID: offerId || '',
        OMNIA_CONNECTOR_NEXT_READINESS_FILE: readiness,
        OMNIA_CONNECTOR_NEXT_UPDATER_PID: String(process.pid)
      }
    });
    this.child = child;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`CONNECTOR_NEXT.AGENT_PROCESS_EARLY_EXIT:${child.exitCode}`);
      if (fs.existsSync(readiness)) {
        const report = JSON.parse(fs.readFileSync(readiness, 'utf8')) as { version?: string; generation?: number; ready?: boolean };
        fs.rmSync(readiness, { force: true });
        if (report.ready === true && report.version === pointer.version && report.generation === pointer.generation) return;
        throw new Error('CONNECTOR_NEXT.AGENT_READINESS_IDENTITY_MISMATCH');
      }
      await delay(100);
    }
    child.kill();
    throw new Error('CONNECTOR_NEXT.AGENT_READINESS_TIMEOUT');
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
      const onExit = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
      timer.unref();
      child.once('exit', onExit);
    });
    child.kill('SIGTERM');
    if (await waitForExit(10_000)) return;
    child.kill('SIGKILL');
    if (!await waitForExit(5_000)) throw new Error('CONNECTOR_NEXT.AGENT_DRAIN_EXIT_TIMEOUT');
  }

  isRunning(): boolean { return Boolean(this.child && this.child.exitCode === null); }
}
