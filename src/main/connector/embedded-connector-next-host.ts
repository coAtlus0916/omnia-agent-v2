import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorNextControlClient } from './connector-next-control-client.js';
import {
  CONNECTOR_NEXT_AGENT_PROCESS,
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_PROTOCOL_ID,
  type ConnectorNextTarget
} from '../../connector-next/protocol.js';
import { connectorNextPaths } from '../../connector-next/paths.js';
import { connectorNextProcessLockIsLive } from '../../connector-next/process-lock.js';
import {
  protectConnectorNextCredential,
  unprotectConnectorNextCredential
} from '../../connector-next/agent/credential-protection.js';

const CONFIG_SCHEMA = 'omnia.connector-next-portable-config/v1' as const;
const CONNECTOR_VERSION = '0.1.23';
const CONNECTOR_SEQUENCE = 24;
const SUPPORTED_PROFILES = new Set(['create-associate-only', 'company-loopback-current']);

interface PortableConfig {
  schemaVersion: typeof CONFIG_SCHEMA;
  port: number;
  controlTokenCiphertext: string;
  target: ConnectorNextTarget;
  createdAt: string;
}

export interface EmbeddedConnectorNextConfiguration {
  serverUrl: string;
  controlToken: string;
  target: ConnectorNextTarget;
}

export interface EmbeddedConnectorNextHostOptions {
  productRoot: string;
  applicationRoot: string;
  executable: string;
  onFatalError?: (error: Error) => void;
}

function sanitizeHost(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_.:-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return safe.length >= 3 ? safe.slice(0, 64) : 'portable-host';
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
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

function readProfile(productRoot: string): string {
  const marker = JSON.parse(fs.readFileSync(path.join(productRoot, 'portable-root.json'), 'utf8')) as Record<string, unknown>;
  const profile = String(marker.builtinProfile || '');
  if (marker.schemaVersion !== 'omnia.portable-product-root/v1'
    || marker.product !== 'omnia-agent-v5'
    || marker.formatVersion !== 1
    || marker.connectorTransport !== 'connector-next-loopback'
    || !SUPPORTED_PROFILES.has(profile)) {
    throw new Error('CONNECTOR_NEXT.EMBEDDED_PORTABLE_ROOT_INVALID');
  }
  return profile;
}

async function readOrCreateConfig(dataRoot: string): Promise<{ config: PortableConfig; controlToken: string }> {
  const filename = path.join(dataRoot, 'portable-config-v1.json');
  if (fs.existsSync(filename)) {
    const config = JSON.parse(fs.readFileSync(filename, 'utf8')) as PortableConfig;
    if (config.schemaVersion !== CONFIG_SCHEMA
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
      || !config.target?.agentId || !config.target.deviceId || !config.target.connectorInstanceId
      || !config.controlTokenCiphertext) throw new Error('CONNECTOR_NEXT.PORTABLE_CONFIG_INVALID');
    return { config, controlToken: unprotectConnectorNextCredential(config.controlTokenCiphertext, dataRoot) };
  }
  const port = await allocateLoopbackPort();
  const host = sanitizeHost(os.hostname());
  const controlToken = `ocn3_control_${randomBytes(32).toString('base64url')}`;
  const config: PortableConfig = {
    schemaVersion: CONFIG_SCHEMA,
    port,
    controlTokenCiphertext: protectConnectorNextCredential(controlToken, dataRoot),
    target: {
      agentId: `omnia-agent-v5.agent.${host}`,
      deviceId: `omnia-agent-v5.device.${host}`,
      connectorInstanceId: `omnia.connector-next.instance.${randomUUID()}`
    },
    createdAt: new Date().toISOString()
  };
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { config, controlToken };
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
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${errorCode}${detail}`);
}

async function serverIsHealthy(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('health', serverUrl));
    if (!response.ok) return false;
    const value = await response.json() as Record<string, unknown>;
    return value.productId === CONNECTOR_NEXT_PRODUCT_ID && value.protocolId === CONNECTOR_NEXT_PROTOCOL_ID;
  } catch { return false; }
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => { if (!finished) { finished = true; resolve(); } };
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch { done(); return; }
    const force = setTimeout(() => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* already gone */ }
      setTimeout(done, 1_000).unref();
    }, 4_000);
    force.unref();
  });
}

export class EmbeddedConnectorNextHost {
  private readonly productRoot: string;
  private readonly applicationRoot: string;
  private readonly executable: string;
  private readonly connectorRoot: string;
  private readonly dataRoot: string;
  private readonly logRoot: string;
  private readonly profile: string;
  private readonly onFatalError: (error: Error) => void;
  private serverChild: ChildProcess | null = null;
  private agentChild: ChildProcess | null = null;
  private configuration: EmbeddedConnectorNextConfiguration | null = null;
  private ensurePromise: Promise<EmbeddedConnectorNextConfiguration> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(options: EmbeddedConnectorNextHostOptions) {
    this.productRoot = path.resolve(options.productRoot);
    this.applicationRoot = path.resolve(options.applicationRoot);
    this.executable = path.resolve(options.executable);
    this.connectorRoot = path.join(this.applicationRoot, 'connector-next');
    this.dataRoot = path.join(this.productRoot, 'connector-next-data-v3');
    this.logRoot = path.join(this.dataRoot, 'logs');
    this.profile = readProfile(this.productRoot);
    this.onFatalError = options.onFatalError || (() => {});
  }

  async start(): Promise<EmbeddedConnectorNextConfiguration> {
    this.stopping = false;
    const { config, controlToken } = await readOrCreateConfig(this.dataRoot);
    this.configuration = {
      serverUrl: `http://127.0.0.1:${config.port}/connector-next/v3/`,
      controlToken,
      target: config.target
    };
    return await this.ensureRuntime();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([stopChild(this.agentChild), stopChild(this.serverChild)]);
    this.agentChild = null;
    this.serverChild = null;
  }

  private serviceEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OMNIA_AGENT_HOT_ROOT: '',
      OMNIA_AGENT_PRODUCT_ROOT: this.productRoot,
      OMNIA_AGENT_BUILTIN_PROFILE: this.profile
    };
  }

  private append(event: string, details: Record<string, unknown> = {}): void {
    fs.mkdirSync(this.logRoot, { recursive: true });
    fs.appendFileSync(path.join(this.logRoot, 'embedded-host.log'), `${JSON.stringify({
      occurredAt: new Date().toISOString(), event, ...details
    })}\n`);
  }

  private spawnManaged(role: 'server' | 'agent', entrypoint: string, env: NodeJS.ProcessEnv): ChildProcess {
    fs.mkdirSync(this.logRoot, { recursive: true });
    const descriptor = fs.openSync(path.join(this.logRoot, `${role}.log`), 'a');
    let child: ChildProcess;
    try {
      child = spawn(this.executable, [entrypoint], {
        cwd: this.productRoot,
        windowsHide: true,
        env,
        stdio: ['ignore', descriptor, descriptor]
      });
    } finally {
      fs.closeSync(descriptor);
    }
    if (role === 'server') this.serverChild = child;
    else this.agentChild = child;
    this.append(`${role}.spawned`, { pid: child.pid || 0, entrypoint: path.relative(this.applicationRoot, entrypoint) });
    child.once('error', (error) => this.handleUnexpectedExit(role, child, error));
    child.once('exit', (code, signal) => this.handleUnexpectedExit(
      role, child, new Error(`CONNECTOR_NEXT.EMBEDDED_${role.toUpperCase()}_EXITED:${code ?? signal ?? 'unknown'}`)
    ));
    return child;
  }

  private async spawnAndWait(entrypoint: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable, [entrypoint, ...args], {
        cwd: this.productRoot,
        windowsHide: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(new Error('CONNECTOR_NEXT.EMBEDDED_COMMAND_TIMEOUT'));
      }, timeoutMs);
      timer.unref();
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`CONNECTOR_NEXT.EMBEDDED_ENROLL_FAILED: ${Buffer.concat(stderr).toString('utf8') || Buffer.concat(stdout).toString('utf8')}`));
      });
    });
  }

  private async ensureRuntime(): Promise<EmbeddedConnectorNextConfiguration> {
    if (this.ensurePromise) return await this.ensurePromise;
    this.ensurePromise = this.ensureRuntimeOnce().finally(() => { this.ensurePromise = null; });
    return await this.ensurePromise;
  }

  private async ensureRuntimeOnce(): Promise<EmbeddedConnectorNextConfiguration> {
    if (!this.configuration) throw new Error('CONNECTOR_NEXT.EMBEDDED_CONFIGURATION_MISSING');
    const serverEntry = path.join(this.connectorRoot, 'server.cjs');
    const agentEntry = path.join(this.connectorRoot, 'agent.cjs');
    for (const required of [this.executable, serverEntry, agentEntry, path.join(this.connectorRoot, 'node_modules', 'playwright-core', 'package.json')]) {
      if (!fs.existsSync(required)) throw new Error(`CONNECTOR_NEXT.EMBEDDED_MEMBER_MISSING: ${required}`);
    }
    const common = this.serviceEnvironment();
    if (!await serverIsHealthy(this.configuration.serverUrl)) {
      this.spawnManaged('server', serverEntry, {
        ...common,
        OMNIA_CONNECTOR_NEXT_SERVER_DATA_ROOT: path.join(this.dataRoot, 'server'),
        OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN: this.configuration.controlToken,
        OMNIA_CONNECTOR_NEXT_SERVER_HOST: '127.0.0.1',
        OMNIA_CONNECTOR_NEXT_SERVER_PORT: String(new URL(this.configuration.serverUrl).port)
      });
    }
    await waitUntil(async () => await serverIsHealthy(this.configuration!.serverUrl) ? true : null, 20_000, 'CONNECTOR_NEXT.EMBEDDED_SERVER_NOT_READY');

    const control = new ConnectorNextControlClient({
      serverUrl: this.configuration.serverUrl,
      controlToken: this.configuration.controlToken
    });
    let enrolled = false;
    try {
      const identity = await control.getConnectorIdentity(this.configuration.target);
      enrolled = identity.productId === CONNECTOR_NEXT_PRODUCT_ID && identity.protocolId === CONNECTOR_NEXT_PROTOCOL_ID;
    } catch (error) {
      if (!(error instanceof Error) || !/TARGET_NOT_ENROLLED|HTTP_404/u.test(error.message)) throw error;
    }
    const agentDataRoot = path.join(this.dataRoot, 'agent');
    const agentPaths = connectorNextPaths({ installRoot: this.connectorRoot, dataRoot: agentDataRoot });
    const agentEnv = {
      ...common,
      OMNIA_CONNECTOR_NEXT_INSTALL_ROOT: this.connectorRoot,
      OMNIA_CONNECTOR_NEXT_DATA_ROOT: agentDataRoot,
      OMNIA_CONNECTOR_NEXT_VERSION: CONNECTOR_VERSION,
      OMNIA_CONNECTOR_NEXT_SEQUENCE: String(CONNECTOR_SEQUENCE),
      OMNIA_CONNECTOR_NEXT_JOB_CONCURRENCY: '8'
    };
    if (!enrolled) {
      if (connectorNextProcessLockIsLive(agentPaths.agentLock, CONNECTOR_NEXT_AGENT_PROCESS)) {
        throw new Error('CONNECTOR_NEXT.EMBEDDED_REENROLL_BLOCKED_BY_LIVE_AGENT');
      }
      const enrollment = await control.createEnrollment(this.configuration.target);
      await this.spawnAndWait(agentEntry, [
        'enroll', this.configuration.serverUrl, enrollment.enrollmentCode, JSON.stringify(this.configuration.target)
      ], agentEnv, 30_000);
      this.append('agent.enrolled', { target: this.configuration.target, version: CONNECTOR_VERSION, sequence: CONNECTOR_SEQUENCE });
    }
    if (!connectorNextProcessLockIsLive(agentPaths.agentLock, CONNECTOR_NEXT_AGENT_PROCESS)) {
      this.spawnManaged('agent', agentEntry, agentEnv);
    }
    const health = await control.enqueueSystemHealthRead(this.configuration.target, { embeddedExeStartup: true });
    const completed = await control.waitForJob(health.jobId, 30_000);
    if (completed.status !== 'succeeded') throw new Error('CONNECTOR_NEXT.EMBEDDED_AGENT_NOT_READY');
    this.append('runtime.ready', { target: this.configuration.target });
    return this.configuration;
  }

  private handleUnexpectedExit(role: 'server' | 'agent', child: ChildProcess, error: Error): void {
    const owned = role === 'server' ? this.serverChild === child : this.agentChild === child;
    if (!owned) return;
    if (role === 'server') this.serverChild = null;
    else this.agentChild = null;
    if (this.stopping) return;
    this.append(`${role}.unexpected_exit`, { message: error.message });
    if (this.recoveryPromise) return;
    this.recoveryPromise = (async () => {
      let lastError: Error = error;
      for (const delayMs of [250, 1_000, 3_000]) {
        await delay(delayMs);
        if (this.stopping) return;
        try { await this.ensureRuntime(); return; }
        catch (recoveryError) { lastError = recoveryError instanceof Error ? recoveryError : new Error(String(recoveryError)); }
      }
      this.onFatalError(lastError);
    })().finally(() => { this.recoveryPromise = null; });
  }
}
