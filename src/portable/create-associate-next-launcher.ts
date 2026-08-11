import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorNextControlClient } from '../main/connector/connector-next-control-client.js';
import {
  CONNECTOR_NEXT_AGENT_PROCESS,
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_PROTOCOL_ID,
  type ConnectorNextTarget
} from '../connector-next/protocol.js';
import { connectorNextPaths } from '../connector-next/paths.js';
import { connectorNextProcessLockIsLive } from '../connector-next/process-lock.js';
import { protectConnectorNextCredential, unprotectConnectorNextCredential } from '../connector-next/agent/credential-protection.js';

const PORTABLE_CONFIG_SCHEMA = 'omnia.connector-next-portable-config/v1' as const;
const PORTABLE_PROFILE = 'create-associate-only';
const CONNECTOR_VERSION = '0.1.23';
const CONNECTOR_SEQUENCE = 24;

interface PortableConfig {
  schemaVersion: typeof PORTABLE_CONFIG_SCHEMA;
  port: number;
  controlTokenCiphertext: string;
  target: ConnectorNextTarget;
  createdAt: string;
}

function assertPortableRoot(root: string): void {
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'portable-root.json'), 'utf8')) as Record<string, unknown>;
  if (marker.schemaVersion !== 'omnia.portable-product-root/v1'
    || marker.product !== 'omnia-agent-v5'
    || marker.formatVersion !== 1
    || marker.builtinProfile !== PORTABLE_PROFILE
    || marker.connectorTransport !== 'connector-next-loopback') {
    throw new Error('CONNECTOR_NEXT.PORTABLE_ROOT_IDENTITY_INVALID');
  }
}

function sanitizeHost(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_.:-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return safe.length >= 3 ? safe.slice(0, 64) : 'portable-host';
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('CONNECTOR_NEXT.LOOPBACK_PORT_ALLOCATION_FAILED'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function readOrCreateConfig(dataRoot: string, filename: string): Promise<{ config: PortableConfig; controlToken: string }> {
  if (fs.existsSync(filename)) {
    const config = JSON.parse(fs.readFileSync(filename, 'utf8')) as PortableConfig;
    if (config.schemaVersion !== PORTABLE_CONFIG_SCHEMA
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
      || !config.target?.agentId || !config.target.deviceId || !config.target.connectorInstanceId
      || !config.controlTokenCiphertext) throw new Error('CONNECTOR_NEXT.PORTABLE_CONFIG_INVALID');
    return Promise.resolve({ config, controlToken: unprotectConnectorNextCredential(config.controlTokenCiphertext, dataRoot) });
  }
  return allocateLoopbackPort().then((port) => {
    const host = sanitizeHost(os.hostname());
    const controlToken = `ocn3_control_${randomBytes(32).toString('base64url')}`;
    const config: PortableConfig = {
      schemaVersion: PORTABLE_CONFIG_SCHEMA,
      port,
      controlTokenCiphertext: protectConnectorNextCredential(controlToken, dataRoot),
      target: {
        agentId: `omnia-agent-v5.agent.${host}`,
        deviceId: `omnia-agent-v5.device.${host}`,
        connectorInstanceId: `omnia.connector-next.instance.${randomUUID()}`
      },
      createdAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { config, controlToken };
  });
}

function serviceEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    OMNIA_AGENT_HOT_ROOT: '',
    OMNIA_AGENT_PRODUCT_ROOT: root,
    OMNIA_AGENT_BUILTIN_PROFILE: PORTABLE_PROFILE
  };
}

function shellEnvironment(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OMNIA_AGENT_HOT_ROOT;
  delete env.OMNIA_AGENT_REPAIR_VERIFIED_REMOTE_BINDING;
  delete env.OMNIA_AGENT_REPAIR_VERIFIED_REMOTE_BINDING_REPORT;
  env.OMNIA_AGENT_PRODUCT_ROOT = root;
  env.OMNIA_AGENT_BUILTIN_PROFILE = PORTABLE_PROFILE;
  return env;
}

function spawnLogged(executable: string, args: string[], logFile: string, options: SpawnOptions): number {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const descriptor = fs.openSync(logFile, 'a');
  try {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', descriptor, descriptor] });
    child.unref();
    return child.pid || 0;
  } finally {
    fs.closeSync(descriptor);
  }
}

async function spawnAndWait(
  executable: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CONNECTOR_NEXT.PORTABLE_CHILD_TIMEOUT'));
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function waitUntil<T>(read: () => Promise<T | null>, timeoutMs: number, errorCode: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  const details = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${errorCode}${details}`);
}

async function serverIsHealthy(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('health', serverUrl));
    if (!response.ok) return false;
    const payload = await response.json() as Record<string, unknown>;
    return payload.productId === CONNECTOR_NEXT_PRODUCT_ID && payload.protocolId === CONNECTOR_NEXT_PROTOCOL_ID;
  } catch { return false; }
}

function shellConfigurationMatches(root: string, serverUrl: string, target: ConnectorNextTarget): boolean {
  const filename = path.join(root, 'data', 'stores', 'core.sqlite');
  if (!fs.existsSync(filename)) return false;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    const row = database.prepare(`SELECT enabled,server_url,agent_id,device_id,connector_instance_id FROM connector_next_settings WHERE singleton=1`).get() as Record<string, unknown> | undefined;
    return Number(row?.enabled) === 1
      && String(row?.server_url) === new URL(serverUrl).href
      && String(row?.agent_id) === target.agentId
      && String(row?.device_id) === target.deviceId
      && String(row?.connector_instance_id) === target.connectorInstanceId;
  } catch { return false; }
  finally { database?.close(); }
}

function showStartupError(message: string): void {
  const script = "Add-Type -AssemblyName PresentationFramework; $m=[Console]::In.ReadToEnd(); [System.Windows.MessageBox]::Show($m,'Omnia Agent v5 启动失败','OK','Error') | Out-Null";
  spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: message,
    encoding: 'utf8',
    windowsHide: true
  });
}

async function withLauncherLock<T>(filename: string, work: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const deadline = Date.now() + 30_000;
  let descriptor = -1;
  while (descriptor < 0 && Date.now() < deadline) {
    try { descriptor = fs.openSync(filename, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stale = JSON.parse(fs.readFileSync(filename, 'utf8')) as { pid?: number };
        if (!Number.isInteger(stale.pid) || Number(stale.pid) <= 0) throw new Error('stale');
        try { process.kill(Number(stale.pid), 0); }
        catch { throw new Error('stale'); }
      } catch {
        fs.rmSync(filename, { force: true });
        continue;
      }
      await delay(100);
    }
  }
  if (descriptor < 0) throw new Error('CONNECTOR_NEXT.PORTABLE_START_ALREADY_RUNNING');
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try { return await work(); }
  finally { fs.closeSync(descriptor); fs.rmSync(filename, { force: true }); }
}

async function main(): Promise<void> {
  const connectorRoot = path.resolve(__dirname);
  const root = path.resolve(connectorRoot, '..');
  assertPortableRoot(root);
  const dataRoot = path.join(root, 'connector-next-data-v3');
  const logRoot = path.join(dataRoot, 'logs');
  fs.mkdirSync(logRoot, { recursive: true });
  const launcherLog = path.join(logRoot, 'portable-launcher.log');
  const append = (event: string, details: Record<string, unknown> = {}) => {
    fs.appendFileSync(launcherLog, `${JSON.stringify({ occurredAt: new Date().toISOString(), event, ...details })}\n`);
  };

  await withLauncherLock(path.join(dataRoot, 'portable-launcher.lock'), async () => {
    const { config, controlToken } = await readOrCreateConfig(dataRoot, path.join(dataRoot, 'portable-config-v1.json'));
    const serverUrl = `http://127.0.0.1:${config.port}/connector-next/v3/`;
    const current = JSON.parse(fs.readFileSync(path.join(root, 'current'), 'utf8')) as { schemaVersion?: string; relativePath?: string; version?: string };
    if (current.schemaVersion !== 'omnia.active-release/v1' || !current.relativePath || !current.version) {
      throw new Error('CONNECTOR_NEXT.PORTABLE_CURRENT_INVALID');
    }
    const releaseRoot = path.resolve(root, current.relativePath);
    if (!releaseRoot.startsWith(`${root}${path.sep}`)) throw new Error('CONNECTOR_NEXT.PORTABLE_RELEASE_ESCAPE');
    const executable = path.join(releaseRoot, 'Omnia Agent v5.exe');
    for (const required of [executable, path.join(connectorRoot, 'server.cjs'), path.join(connectorRoot, 'agent.cjs')]) {
      if (!fs.existsSync(required)) throw new Error(`CONNECTOR_NEXT.PORTABLE_MEMBER_MISSING: ${required}`);
    }

    const common = serviceEnvironment(root);
    const serverDataRoot = path.join(dataRoot, 'server');
    if (!await serverIsHealthy(serverUrl)) {
      const pid = spawnLogged(executable, [path.join(connectorRoot, 'server.cjs')], path.join(logRoot, 'server.log'), {
        cwd: root,
        detached: true,
        windowsHide: true,
        env: {
          ...common,
          OMNIA_CONNECTOR_NEXT_SERVER_DATA_ROOT: serverDataRoot,
          OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN: controlToken,
          OMNIA_CONNECTOR_NEXT_SERVER_HOST: '127.0.0.1',
          OMNIA_CONNECTOR_NEXT_SERVER_PORT: String(config.port)
        }
      });
      append('server.spawned', { pid, port: config.port });
    }
    await waitUntil(async () => await serverIsHealthy(serverUrl) ? true : null, 20_000, 'CONNECTOR_NEXT.PORTABLE_SERVER_NOT_READY');

    const control = new ConnectorNextControlClient({ serverUrl, controlToken });
    let enrolled = false;
    try {
      const identity = await control.getConnectorIdentity(config.target);
      enrolled = identity.productId === CONNECTOR_NEXT_PRODUCT_ID && identity.protocolId === CONNECTOR_NEXT_PROTOCOL_ID;
    } catch (error) {
      if (!(error instanceof Error) || !/TARGET_NOT_ENROLLED|HTTP_404/u.test(error.message)) throw error;
    }

    const agentDataRoot = path.join(dataRoot, 'agent');
    const agentInstallRoot = connectorRoot;
    const agentPaths = connectorNextPaths({ installRoot: agentInstallRoot, dataRoot: agentDataRoot });
    const agentEnv = {
      ...common,
      OMNIA_CONNECTOR_NEXT_INSTALL_ROOT: agentInstallRoot,
      OMNIA_CONNECTOR_NEXT_DATA_ROOT: agentDataRoot,
      OMNIA_CONNECTOR_NEXT_VERSION: CONNECTOR_VERSION,
      OMNIA_CONNECTOR_NEXT_SEQUENCE: String(CONNECTOR_SEQUENCE),
      OMNIA_CONNECTOR_NEXT_JOB_CONCURRENCY: '8'
    };
    if (!enrolled) {
      if (connectorNextProcessLockIsLive(agentPaths.agentLock, CONNECTOR_NEXT_AGENT_PROCESS)) {
        throw new Error('CONNECTOR_NEXT.PORTABLE_REENROLL_BLOCKED_BY_LIVE_AGENT');
      }
      const enrollment = await control.createEnrollment(config.target);
      const result = await spawnAndWait(executable, [
        path.join(connectorRoot, 'agent.cjs'),
        'enroll', serverUrl, enrollment.enrollmentCode, JSON.stringify(config.target)
      ], { cwd: root, windowsHide: true, env: agentEnv }, 30_000);
      if (result.code !== 0) throw new Error(`CONNECTOR_NEXT.PORTABLE_ENROLL_FAILED: ${result.stderr || result.stdout}`);
      append('agent.enrolled', { target: config.target, version: CONNECTOR_VERSION, sequence: CONNECTOR_SEQUENCE });
    }

    if (!connectorNextProcessLockIsLive(agentPaths.agentLock, CONNECTOR_NEXT_AGENT_PROCESS)) {
      const pid = spawnLogged(executable, [path.join(connectorRoot, 'agent.cjs')], path.join(logRoot, 'agent.log'), {
        cwd: root,
        detached: true,
        windowsHide: true,
        env: agentEnv
      });
      append('agent.spawned', { pid });
    }
    await waitUntil(async () => {
      try {
        const queued = await control.enqueueSystemHealthRead(config.target, { portableStartup: true });
        const job = await control.waitForJob(queued.jobId, 5_000);
        return job.status === 'succeeded' ? job : null;
      } catch { return null; }
    }, 30_000, 'CONNECTOR_NEXT.PORTABLE_AGENT_NOT_READY');

    const shellEnv = {
      ...shellEnvironment(root),
      OMNIA_CONNECTOR_NEXT_ENABLED: '1',
      OMNIA_CONNECTOR_NEXT_SERVER_URL: serverUrl,
      OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN: controlToken,
      OMNIA_CONNECTOR_NEXT_AGENT_ID: config.target.agentId,
      OMNIA_CONNECTOR_NEXT_DEVICE_ID: config.target.deviceId,
      OMNIA_CONNECTOR_NEXT_INSTANCE_ID: config.target.connectorInstanceId
    };
    const chromiumData = path.join(dataRoot, 'chromium');
    const shellArgs = [`--user-data-dir=${chromiumData}`];
    if (!shellConfigurationMatches(root, serverUrl, config.target)) {
      const configured = await spawnAndWait(executable, shellArgs, {
        cwd: root,
        windowsHide: true,
        env: { ...shellEnv, OMNIA_CONNECTOR_NEXT_CONFIGURE_ONCE: '1' }
      }, 60_000);
      if (configured.code !== 0 || !/"configured":true/u.test(configured.stdout)) {
        throw new Error(`CONNECTOR_NEXT.PORTABLE_SHELL_CONFIGURATION_FAILED: ${configured.stderr || configured.stdout}`);
      }
      append('shell.configured', { serverUrl, target: config.target });
    }

    const pid = spawnLogged(executable, shellArgs, path.join(logRoot, 'shell.log'), {
      cwd: root,
      detached: true,
      windowsHide: false,
      env: shellEnvironment(root)
    });
    append('shell.spawned', { pid, version: current.version, profile: PORTABLE_PROFILE });
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const root = path.resolve(__dirname, '..');
    const logRoot = path.join(root, 'connector-next-data-v3', 'logs');
    fs.mkdirSync(logRoot, { recursive: true });
    fs.appendFileSync(path.join(logRoot, 'portable-launcher.log'), `${JSON.stringify({ occurredAt: new Date().toISOString(), event: 'startup.failed', message })}\n`);
  } catch { /* best effort */ }
  showStartupError(message);
  process.exitCode = 1;
});
