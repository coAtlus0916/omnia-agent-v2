import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorNextPaths } from './paths.js';
import type { ConnectorNextUpdateManifest } from './protocol.js';
import {
  manifestDigest,
  parseAndVerifyPackage,
  stagePackageImmutable,
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
  if (fs.existsSync(options.paths.currentPointer)) throw new Error('CONNECTOR_NEXT.ALREADY_INSTALLED');
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

export async function startConnectorNext(paths: ConnectorNextPaths): Promise<{ bootstrapPid: number }> {
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
    if (fs.existsSync(paths.bootstrapLock) && fs.existsSync(paths.updaterLock) && fs.existsSync(paths.agentLock)) {
      const bootstrapPid = child.pid || 0;
      child.unref();
      return { bootstrapPid };
    }
    await delay(100);
  }
  child.kill('SIGTERM');
  throw new Error('CONNECTOR_NEXT.STARTUP_TIMEOUT');
}
