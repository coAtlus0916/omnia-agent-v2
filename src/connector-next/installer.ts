import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorNextPaths } from './paths.js';
import {
  CONNECTOR_NEXT_AGENT_PROCESS,
  CONNECTOR_NEXT_BOOTSTRAP_PROCESS,
  CONNECTOR_NEXT_UPDATER_PROCESS,
  type ConnectorNextUpdateManifest
} from './protocol.js';
import { connectorNextProcessLockIsLive } from './process-lock.js';
import {
  manifestDigest,
  parseAndVerifyPackage,
  readCurrentPointer,
  stagePackageImmutable,
  verifyCurrentSlot,
  verifyConnectorNextManifest,
  writeCurrentPointerAtomic,
  type CurrentPointer
} from './updater/package.js';

export interface ConnectorNextInstallOptions {
  paths: ConnectorNextPaths;
  manifest: ConnectorNextUpdateManifest;
  packageBytes: Buffer;
  publisherPublicKey: string;
  bootstrapExecutable: string;
  registerStartup: boolean;
}

function writeFileIfMissing(filename: string, bytes: string | Buffer, mode?: number): void {
  if (fs.existsSync(filename)) {
    if (!fs.statSync(filename).isFile()) throw new Error('CONNECTOR_NEXT.EXISTING_INSTALL_CONFLICT');
    return;
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes, { flag: 'wx', ...(mode ? { mode } : {}) });
}

function repairConnectorNextBootstrap(options: ConnectorNextInstallOptions, pointer: CurrentPointer): void {
  const verified = verifyCurrentSlot(options.paths, pointer);
  const runtimeSource = path.join(verified.root, ...verified.identity.runtimeEntrypoint.split('/'));
  const bootstrapRoot = path.join(options.paths.installRoot, 'bootstrap-v3');
  fs.mkdirSync(bootstrapRoot, { recursive: true });
  const runtimeDestination = path.join(bootstrapRoot, 'node.exe');
  if (!fs.existsSync(runtimeDestination)) fs.copyFileSync(runtimeSource, runtimeDestination, fs.constants.COPYFILE_EXCL);
  writeFileIfMissing(path.join(bootstrapRoot, 'connector-next-bootstrap.cjs'), fs.readFileSync(options.bootstrapExecutable));
  writeFileIfMissing(path.join(bootstrapRoot, 'trust-v3.json'), `${JSON.stringify({
    schemaVersion: 'omnia.connector-next-updater-trust/v1',
    productId: options.manifest.productId,
    protocolId: options.manifest.protocolId,
    signingKeyId: options.manifest.signingKeyId,
    publisherPublicKey: options.publisherPublicKey
  }, null, 2)}\n`, 0o444);
  writeFileIfMissing(path.join(options.paths.installRoot, 'start-connector-next-v3.cmd'), [
    '@echo off',
    `set "OMNIA_CONNECTOR_NEXT_INSTALL_ROOT=${options.paths.installRoot}"`,
    `set "OMNIA_CONNECTOR_NEXT_DATA_ROOT=${options.paths.dataRoot}"`,
    `"${path.join(bootstrapRoot, 'node.exe')}" "${path.join(bootstrapRoot, 'connector-next-bootstrap.cjs')}"`
  ].join('\r\n') + '\r\n');
}

export function registerConnectorNextStartup(paths: ConnectorNextPaths): void {
  fs.mkdirSync(path.dirname(paths.startupEntryPath), { recursive: true });
  const content = `@echo off\r\ncall "${path.join(paths.installRoot, 'start-connector-next-v3.cmd')}"\r\n`;
  if (fs.existsSync(paths.startupEntryPath)) {
    if (fs.readFileSync(paths.startupEntryPath, 'utf8') !== content) throw new Error('CONNECTOR_NEXT.STARTUP_ENTRY_CONFLICT');
    return;
  }
  fs.writeFileSync(paths.startupEntryPath, content, { flag: 'wx' });
}

export function installConnectorNext(options: ConnectorNextInstallOptions): CurrentPointer {
  verifyConnectorNextManifest(options.manifest, options.publisherPublicKey);
  const value = parseAndVerifyPackage(options.packageBytes, options.manifest);
  if (fs.existsSync(options.paths.currentPointer)) {
    const pointer = readCurrentPointer(options.paths.currentPointer);
    repairConnectorNextBootstrap(options, pointer);
    return pointer;
  }
  const digest = manifestDigest(options.manifest);
  const root = stagePackageImmutable(options.paths.slotsRoot, 'a', value, digest);
  fs.mkdirSync(path.join(options.paths.installRoot, 'bootstrap-v3'), { recursive: true });
  fs.copyFileSync(options.bootstrapExecutable, path.join(options.paths.installRoot, 'bootstrap-v3', 'connector-next-bootstrap.cjs'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(root, ...value.runtimeEntrypoint.split('/')), path.join(options.paths.installRoot, 'bootstrap-v3', 'node.exe'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(options.paths.installRoot, 'bootstrap-v3', 'trust-v3.json'), `${JSON.stringify({
    schemaVersion: 'omnia.connector-next-updater-trust/v1',
    productId: options.manifest.productId,
    protocolId: options.manifest.protocolId,
    signingKeyId: options.manifest.signingKeyId,
    publisherPublicKey: options.publisherPublicKey
  }, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  const pointer: CurrentPointer = {
    schemaVersion: 'omnia.connector-next-current/v1', slot: 'a', relativeRoot: path.relative(options.paths.slotsRoot, root).replaceAll('\\', '/'),
    version: value.version, sequence: value.sequence, generation: 1, manifestDigest: digest, updatedAt: new Date().toISOString()
  };
  writeCurrentPointerAtomic(options.paths.currentPointer, pointer);
  fs.writeFileSync(path.join(options.paths.installRoot, 'start-connector-next-v3.cmd'), [
    '@echo off',
    `set "OMNIA_CONNECTOR_NEXT_INSTALL_ROOT=${options.paths.installRoot}"`,
    `set "OMNIA_CONNECTOR_NEXT_DATA_ROOT=${options.paths.dataRoot}"`,
    `"${path.join(options.paths.installRoot, 'bootstrap-v3', 'node.exe')}" "${path.join(options.paths.installRoot, 'bootstrap-v3', 'connector-next-bootstrap.cjs')}"`
  ].join('\r\n') + '\r\n', { flag: 'wx' });
  if (options.registerStartup) {
    registerConnectorNextStartup(options.paths);
  }
  return pointer;
}

function processChainIsLive(paths: ConnectorNextPaths): boolean {
  return connectorNextProcessLockIsLive(paths.bootstrapLock, CONNECTOR_NEXT_BOOTSTRAP_PROCESS)
    && connectorNextProcessLockIsLive(paths.updaterLock, CONNECTOR_NEXT_UPDATER_PROCESS)
    && connectorNextProcessLockIsLive(paths.agentLock, CONNECTOR_NEXT_AGENT_PROCESS);
}

export async function startConnectorNext(paths: ConnectorNextPaths): Promise<{ bootstrapPid: number; alreadyRunning: boolean }> {
  if (processChainIsLive(paths)) return { bootstrapPid: 0, alreadyRunning: true };
  if (connectorNextProcessLockIsLive(paths.bootstrapLock, CONNECTOR_NEXT_BOOTSTRAP_PROCESS)) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (processChainIsLive(paths)) return { bootstrapPid: 0, alreadyRunning: true };
      await delay(100);
    }
    throw new Error('CONNECTOR_NEXT.EXISTING_PROCESS_CHAIN_UNAVAILABLE');
  }
  const child = spawn(path.join(paths.installRoot, 'bootstrap-v3', 'node.exe'), [path.join(paths.installRoot, 'bootstrap-v3', 'connector-next-bootstrap.cjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || '',
      OMNIA_CONNECTOR_NEXT_INSTALL_ROOT: paths.installRoot,
      OMNIA_CONNECTOR_NEXT_DATA_ROOT: paths.dataRoot
    }
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CONNECTOR_NEXT.BOOTSTRAP_EARLY_EXIT:${child.exitCode}`);
    if (processChainIsLive(paths)) {
      const bootstrapPid = child.pid || 0;
      child.unref();
      return { bootstrapPid, alreadyRunning: false };
    }
    await delay(100);
  }
  child.kill('SIGTERM');
  throw new Error('CONNECTOR_NEXT.STARTUP_TIMEOUT');
}
