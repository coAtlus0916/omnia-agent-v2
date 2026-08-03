import fs from 'node:fs';
import path from 'node:path';
import {
  REMOTE_CONNECTOR_DATA_DIRECTORY,
  REMOTE_CONNECTOR_INSTALL_DIRECTORY
} from './constants.js';

export interface PendingUpdate {
  version: string;
  sequence: number;
  stagedAt: string;
}

export interface ManagedState {
  schemaVersion: 'omnia.v5.remote-connector-managed/v1';
  current: string;
  previous: string;
  highestSequence: number;
  pending: PendingUpdate | null;
  blocked: Record<string, { sequence: number; reason: string; blockedAt: string }>;
  updatedAt: string;
}

export interface RemoteConnectorPaths {
  installRoot: string;
  versions: string;
  bootstrap: string;
  updates: string;
  dataRoot: string;
  state: string;
  status: string;
  supervisorLock: string;
  stopRequest: string;
  updateRequest: string;
  logs: string;
}

function requiredEnvironmentPath(name: 'LOCALAPPDATA' | 'APPDATA'): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is unavailable; cannot resolve the isolated v5 Remote Connector root.`);
  return value;
}

export function resolveRemoteConnectorPaths(overrides: {
  installRoot?: string;
  dataRoot?: string;
} = {}): RemoteConnectorPaths {
  const installRoot = path.resolve(
    overrides.installRoot
      || process.env.OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT
      || path.join(requiredEnvironmentPath('LOCALAPPDATA'), REMOTE_CONNECTOR_INSTALL_DIRECTORY)
  );
  const dataRoot = path.resolve(
    overrides.dataRoot
      || process.env.OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT
      || path.join(requiredEnvironmentPath('APPDATA'), REMOTE_CONNECTOR_DATA_DIRECTORY)
  );
  const legacyRoot = path.resolve(requiredEnvironmentPath('LOCALAPPDATA'), 'OmniaAgentConnector');
  const legacyData = path.resolve(requiredEnvironmentPath('APPDATA'), 'OmniaAgentConnector');
  if (installRoot === legacyRoot || dataRoot === legacyData) {
    throw new Error('v5 Remote Connector refuses to use the v4 Connector install or data root.');
  }
  return {
    installRoot,
    versions: path.join(installRoot, 'versions'),
    bootstrap: path.join(installRoot, 'bootstrap'),
    updates: path.join(installRoot, 'updates'),
    dataRoot,
    state: path.join(dataRoot, 'managed-state.json'),
    status: path.join(dataRoot, 'status.json'),
    supervisorLock: path.join(dataRoot, 'supervisor.lock'),
    stopRequest: path.join(dataRoot, 'stop.request'),
    updateRequest: path.join(dataRoot, 'update.request'),
    logs: path.join(dataRoot, 'logs')
  };
}

export function ensureRemoteConnectorDirectories(paths: RemoteConnectorPaths): void {
  for (const directory of [
    paths.installRoot,
    paths.versions,
    paths.bootstrap,
    paths.updates,
    paths.dataRoot,
    paths.logs
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function defaultManagedState(): ManagedState {
  return {
    schemaVersion: 'omnia.v5.remote-connector-managed/v1',
    current: '',
    previous: '',
    highestSequence: 0,
    pending: null,
    blocked: {},
    updatedAt: new Date().toISOString()
  };
}

export function readManagedState(paths: RemoteConnectorPaths): ManagedState {
  try {
    const value = JSON.parse(fs.readFileSync(paths.state, 'utf8')) as ManagedState;
    if (
      value.schemaVersion !== 'omnia.v5.remote-connector-managed/v1'
      || typeof value.current !== 'string'
      || typeof value.previous !== 'string'
      || !Number.isSafeInteger(value.highestSequence)
      || !value.blocked
      || typeof value.blocked !== 'object'
    ) throw new Error('invalid state');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultManagedState();
    throw new Error('v5 Remote Connector managed state is invalid.');
  }
}

export function writeJsonAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

export function writeManagedState(paths: RemoteConnectorPaths, input: ManagedState): ManagedState {
  const next = { ...input, updatedAt: new Date().toISOString() };
  writeJsonAtomic(paths.state, next);
  return next;
}

export function versionRoot(paths: RemoteConnectorPaths, version: string): string {
  return path.join(paths.versions, `v${version}`);
}

