import fs from 'node:fs';
import path from 'node:path';

export interface ConnectorNextProcessLock { filename: string; descriptor: number }

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function connectorNextProcessLockIsLive(filename: string, processName: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as { pid?: number; processName?: string };
    return value.processName === processName && Number.isInteger(value.pid) && value.pid! > 0 && processAlive(value.pid!);
  } catch {
    return false;
  }
}

export function acquireConnectorNextProcessLock(filename: string, processName: string): ConnectorNextProcessLock {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  try {
    const stale = JSON.parse(fs.readFileSync(filename, 'utf8')) as { pid?: number; processName?: string };
    if (stale.processName === processName && Number.isInteger(stale.pid) && processAlive(stale.pid!)) throw new Error('CONNECTOR_NEXT.PROCESS_ALREADY_RUNNING');
    fs.rmSync(filename, { force: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'CONNECTOR_NEXT.PROCESS_ALREADY_RUNNING') throw error;
  }
  let descriptor: number;
  try { descriptor = fs.openSync(filename, 'wx', 0o600); } catch { throw new Error('CONNECTOR_NEXT.PROCESS_ALREADY_RUNNING'); }
  fs.writeFileSync(descriptor, JSON.stringify({ processName, pid: process.pid, startedAt: new Date().toISOString() }));
  return { filename, descriptor };
}

export function releaseConnectorNextProcessLock(lock: ConnectorNextProcessLock): void {
  fs.closeSync(lock.descriptor);
  fs.rmSync(lock.filename, { force: true });
}
