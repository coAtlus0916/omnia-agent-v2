import os from 'node:os';
import path from 'node:path';
import { CONNECTOR_NEXT_STARTUP_ENTRY } from './protocol.js';

export interface ConnectorNextPaths {
  installRoot: string;
  dataRoot: string;
  logRoot: string;
  updateRoot: string;
  slotsRoot: string;
  currentPointer: string;
  previousPointer: string;
  stateDatabase: string;
  logDatabase: string;
  runtimeDatabase: string;
  packRoot: string;
  agentLock: string;
  updaterLock: string;
  bootstrapLock: string;
  startupEntryName: typeof CONNECTOR_NEXT_STARTUP_ENTRY;
  startupEntryPath: string;
}

export function connectorNextPaths(overrides: Partial<Pick<ConnectorNextPaths, 'installRoot' | 'dataRoot'>> = {}): ConnectorNextPaths {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const installRoot = path.resolve(overrides.installRoot || path.join(localAppData, 'Programs', 'Omnia Agent Connector Next v3'));
  const dataRoot = path.resolve(overrides.dataRoot || path.join(localAppData, 'Omnia Agent Connector Next v3', 'data-v3'));
  const updateRoot = path.join(installRoot, 'updates-v3');
  return {
    installRoot,
    dataRoot,
    logRoot: path.join(dataRoot, 'logs-v3'),
    updateRoot,
    slotsRoot: path.join(updateRoot, 'slots'),
    currentPointer: path.join(updateRoot, 'current-v3.json'),
    previousPointer: path.join(updateRoot, 'previous-v3.json'),
    stateDatabase: path.join(dataRoot, 'connector-next-state-v3.sqlite'),
    logDatabase: path.join(dataRoot, 'connector-next-log-spool-v3.sqlite'),
    runtimeDatabase: path.join(dataRoot, 'connector-next-runtime-gate-v3.sqlite'),
    packRoot: path.join(dataRoot, 'pack-session-v3'),
    agentLock: path.join(dataRoot, 'omnia-connector-next-agent-v3.lock'),
    updaterLock: path.join(updateRoot, 'omnia-connector-next-updater-v3.lock'),
    bootstrapLock: path.join(updateRoot, 'omnia-connector-next-bootstrap-v3.lock'),
    startupEntryName: CONNECTOR_NEXT_STARTUP_ENTRY,
    startupEntryPath: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${CONNECTOR_NEXT_STARTUP_ENTRY}.cmd`)
  };
}

export function assertConnectorNextPathIsolation(paths: ConnectorNextPaths): void {
  const combined = [paths.installRoot, paths.dataRoot, paths.logRoot, paths.updateRoot].join('\n').toLowerCase();
  if (!combined.includes('connector next') || combined.includes('remote-connector') || combined.includes('v5-remote-connector')) {
    throw new Error('CONNECTOR_NEXT.PATH_ISOLATION_REQUIRED');
  }
  if (path.resolve(paths.installRoot) === path.resolve(paths.dataRoot)) throw new Error('CONNECTOR_NEXT.DATA_RELEASE_ROOT_COLLISION');
}
