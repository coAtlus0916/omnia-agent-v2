import { chromium, type Browser, type Page } from 'playwright-core';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type { ConnectorNextEffect, ConnectorNextPackBinding } from '../protocol.js';

type ShellActionEffect = 'read_only' | 'local_state_write' | 'omnia_mutation';
const execFileAsync = promisify(execFile);

interface ShellProcessIdentity {
  processId: number;
  processStartedAt: string;
  executablePath: string;
}

interface ShellFeatureActionInput {
  featureId: string;
  featureVersion: string;
  surfaceId: string;
  actionId: string;
  expectedStateVersion: number;
  expectedActionEffect: ShellActionEffect;
  payload: Record<string, unknown>;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, maximum = 160): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) throw new Error(`CONNECTOR_NEXT.SHELL_${name}_INVALID`);
  return value;
}

function assertLoopbackEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('CONNECTOR_NEXT.SHELL_CDP_ENDPOINT_INVALID');
  return url.href.replace(/\/$/u, '');
}

function actionInput(value: Record<string, unknown>): ShellFeatureActionInput {
  const allowed = ['featureId', 'featureVersion', 'surfaceId', 'actionId', 'expectedStateVersion', 'expectedActionEffect', 'payload'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('CONNECTOR_NEXT.SHELL_ACTION_INPUT_INVALID');
  const expectedActionEffect = String(value.expectedActionEffect || '') as ShellActionEffect;
  if (!['read_only', 'local_state_write', 'omnia_mutation'].includes(expectedActionEffect)) throw new Error('CONNECTOR_NEXT.SHELL_ACTION_EFFECT_INVALID');
  if (!Number.isSafeInteger(value.expectedStateVersion) || Number(value.expectedStateVersion) < 0) throw new Error('CONNECTOR_NEXT.SHELL_STATE_VERSION_INVALID');
  if (!plainObject(value.payload)) throw new Error('CONNECTOR_NEXT.SHELL_ACTION_PAYLOAD_INVALID');
  return {
    featureId: boundedString(value.featureId, 'FEATURE_ID'),
    featureVersion: boundedString(value.featureVersion, 'FEATURE_VERSION'),
    surfaceId: boundedString(value.surfaceId, 'SURFACE_ID'),
    actionId: boundedString(value.actionId, 'ACTION_ID'),
    expectedStateVersion: Number(value.expectedStateVersion),
    expectedActionEffect,
    payload: value.payload
  };
}

function project(snapshot: any): Record<string, unknown> {
  if (!plainObject(snapshot) || snapshot.schemaVersion !== 'omnia.shell-home/v1') throw new Error('CONNECTOR_NEXT.SHELL_SNAPSHOT_INVALID');
  if (!plainObject(snapshot.features)) throw new Error('CONNECTOR_NEXT.SHELL_FEATURE_SNAPSHOT_INVALID');
  const features = snapshot.features;
  return {
    schemaVersion: 'omnia.connector-next-shell-feature-state/v1',
    generatedAt: snapshot.generatedAt,
    productVersion: snapshot.productVersion,
    connection: snapshot.connection,
    safety: snapshot.safety,
    features: {
      schemaVersion: features.schemaVersion,
      snapshotId: features.snapshotId,
      stateVersion: features.stateVersion,
      selectedFeatureId: features.selectedFeatureId,
      surface: features.surface
    }
  };
}

function assertBinding(snapshot: any, expected: ConnectorNextPackBinding): void {
  const connection = snapshot?.connection;
  if (!connection || connection.adapter !== 'connector_next_v3' || connection.connected !== true
    || connection.connectorId !== expected.connectorId
    || connection.sessionGeneration !== expected.sessionGeneration
    || connection.engagementId !== expected.engagementId
    || connection.authorityInstanceId !== expected.authorityInstanceId
    || String(connection.tenantOrOrgId || '') !== expected.tenantOrOrgId
    || connection.packId !== expected.packId) {
    throw new Error('CONNECTOR_NEXT.SHELL_PACK_BINDING_MISMATCH');
  }
}

export class ConnectorNextShellFeatureHost {
  private browser: Browser | null = null;
  private readonly endpoint: string;

  constructor(endpoint = process.env.OMNIA_CONNECTOR_NEXT_SHELL_CDP_URL || 'http://127.0.0.1:9333') {
    this.endpoint = assertLoopbackEndpoint(endpoint);
  }

  async close(): Promise<void> {
    // The CDP endpoint belongs to the user's Shell; dropping this reference
    // disconnects our websocket on process exit without closing Electron.
    this.browser = null;
  }

  private async shellProcesses(): Promise<ShellProcessIdentity[]> {
    const script = `$items=@(); Get-CimInstance Win32_Process -Filter "Name = 'Omnia Agent v5.exe'" | Where-Object { $_.ExecutablePath -and ($_.CommandLine -notmatch '(?:^|\\s)--type=') } | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){ $items += [pscustomobject]@{processId=[int]$_.ProcessId;processStartedAt=$p.StartTime.ToUniversalTime().ToString('o');executablePath=[string]$_.ExecutablePath} } }; ConvertTo-Json -Compress -InputObject @($items)`;
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 });
    const parsed = JSON.parse(String(result.stdout || '[]')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('CONNECTOR_NEXT.SHELL_PROCESS_INVENTORY_INVALID');
    return parsed.map((item) => {
      if (!plainObject(item) || !Number.isSafeInteger(item.processId) || Number(item.processId) < 1
        || typeof item.processStartedAt !== 'string' || !Number.isFinite(Date.parse(item.processStartedAt))
        || typeof item.executablePath !== 'string' || path.basename(item.executablePath).toLowerCase() !== 'omnia agent v5.exe'
        || !path.isAbsolute(item.executablePath)) throw new Error('CONNECTOR_NEXT.SHELL_PROCESS_IDENTITY_INVALID');
      return { processId: Number(item.processId), processStartedAt: new Date(item.processStartedAt).toISOString(), executablePath: path.resolve(item.executablePath) };
    });
  }

  private async exactProcessAlive(identity: ShellProcessIdentity): Promise<boolean> {
    const rows = await this.shellProcesses();
    const current = rows.find((item) => item.processId === identity.processId);
    return Boolean(current && current.processStartedAt === identity.processStartedAt && current.executablePath.toLowerCase() === identity.executablePath.toLowerCase());
  }

  private async closeMainWindow(identity: ShellProcessIdentity): Promise<void> {
    const script = `$p=Get-Process -Id ${identity.processId} -ErrorAction Stop; if($p.StartTime.ToUniversalTime().ToString('o') -ne '${identity.processStartedAt}'){throw 'birth mismatch'}; if(-not $p.CloseMainWindow()){throw 'main window close rejected'}`;
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (!await this.exactProcessAlive(identity)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('CONNECTOR_NEXT.SHELL_GRACEFUL_EXIT_TIMEOUT');
  }

  async restartWithControl(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (Object.keys(input).some((key) => !['confirmed', 'debugPort'].includes(key))
      || input.confirmed !== true || input.debugPort !== 9333) throw new Error('CONNECTOR_NEXT.SHELL_RESTART_CONFIRMATION_INVALID');
    const rows = await this.shellProcesses();
    if (rows.length !== 1) throw new Error(rows.length ? 'CONNECTOR_NEXT.SHELL_PROCESS_AMBIGUOUS' : 'CONNECTOR_NEXT.SHELL_PROCESS_NOT_FOUND');
    const prior = rows[0]!;
    await this.closeMainWindow(prior);
    this.browser = null;
    const child = spawn(prior.executablePath, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9333'], {
      cwd: path.dirname(prior.executablePath),
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
      env: { ...process.env, OMNIA_AGENT_PRODUCT_ROOT: path.dirname(prior.executablePath) }
    });
    child.unref();
    if (!Number.isSafeInteger(child.pid) || Number(child.pid) < 1) throw new Error('CONNECTOR_NEXT.SHELL_RESTART_SPAWN_FAILED');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(1_500) });
        if (response.ok) return { schemaVersion: 'omnia.connector-next-shell-restart/v1', restarted: true, priorProcessId: prior.processId, processId: child.pid, debugPort: 9333 };
      } catch { /* wait for exact loopback CDP readiness */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('CONNECTOR_NEXT.SHELL_CONTROL_ENDPOINT_TIMEOUT');
  }

  private async mainPage(): Promise<Page> {
    if (!this.browser?.isConnected()) this.browser = await chromium.connectOverCDP(this.endpoint, { timeout: 10_000 });
    const candidates: Page[] = [];
    for (const context of this.browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        const ready = await page.evaluate(() => typeof (window as any).omnia?.getSnapshot === 'function'
          && typeof (window as any).omnia?.featureAction === 'function').catch(() => false);
        if (ready) candidates.push(page);
      }
    }
    if (candidates.length !== 1) throw new Error(candidates.length ? 'CONNECTOR_NEXT.SHELL_PAGE_AMBIGUOUS' : 'CONNECTOR_NEXT.SHELL_PAGE_NOT_FOUND');
    return candidates[0]!;
  }

  private async snapshot(page: Page): Promise<any> {
    return page.evaluate(async () => (window as any).omnia.getSnapshot());
  }

  async read(input: Record<string, unknown>, expectedBinding: ConnectorNextPackBinding): Promise<Record<string, unknown>> {
    const allowed = ['expectedFeatureId'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('CONNECTOR_NEXT.SHELL_SNAPSHOT_INPUT_INVALID');
    const expectedFeatureId = boundedString(input.expectedFeatureId, 'FEATURE_ID');
    const page = await this.mainPage();
    const snapshot = await this.snapshot(page);
    assertBinding(snapshot, expectedBinding);
    if (snapshot.features?.surface?.featureId !== expectedFeatureId) throw new Error('CONNECTOR_NEXT.SHELL_FEATURE_NOT_SELECTED');
    return project(snapshot);
  }

  async invoke(inputValue: Record<string, unknown>, expectedBinding: ConnectorNextPackBinding, envelopeEffect: ConnectorNextEffect): Promise<Record<string, unknown>> {
    const input = actionInput(inputValue);
    const page = await this.mainPage();
    const before = await this.snapshot(page);
    assertBinding(before, expectedBinding);
    const surface = before.features?.surface;
    if (!surface || surface.featureId !== input.featureId || surface.featureVersion !== input.featureVersion || surface.surfaceId !== input.surfaceId) {
      throw new Error('CONNECTOR_NEXT.SHELL_SURFACE_IDENTITY_MISMATCH');
    }
    if (surface.stateVersion !== input.expectedStateVersion) throw new Error('CONNECTOR_NEXT.SHELL_SURFACE_STALE');
    const action = Array.isArray(surface.actions) ? surface.actions.find((item: any) => item?.actionId === input.actionId) : null;
    if (!action || action.effect !== input.expectedActionEffect) throw new Error('CONNECTOR_NEXT.SHELL_ACTION_IDENTITY_MISMATCH');
    if (action.enabled !== true) throw new Error(`CONNECTOR_NEXT.SHELL_ACTION_DISABLED:${String(action.reason || '')}`);
    const expectedEnvelopeEffect: ConnectorNextEffect = action.effect === 'read_only' ? 'read_only' : 'mutation';
    if (envelopeEffect !== expectedEnvelopeEffect) throw new Error('CONNECTOR_NEXT.SHELL_ACTION_EFFECT_MISMATCH');
    const request = {
      featureId: input.featureId,
      featureVersion: input.featureVersion,
      surfaceId: input.surfaceId,
      actionId: input.actionId,
      expectedStateVersion: input.expectedStateVersion,
      payload: input.payload
    };
    const after = await page.evaluate(async (value) => (window as any).omnia.featureAction(value), request);
    assertBinding(after, expectedBinding);
    return project(after);
  }
}
