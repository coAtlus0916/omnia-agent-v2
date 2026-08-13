import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type Page, type Request } from 'playwright-core';
import type { ConnectorConnection, ConnectorWorkspaceAuthorityRead } from './contracts.js';
import type { OperationInvocationRequest, OperationRegistrationCommand } from '../shared/operation-contracts.js';
import { isAllowedOmniaUrl, isGuid, normalizeOmniaUrl, parseEngagementId } from './omnia-origin.js';
import { OperationHost } from './operation-host.js';

const DEFAULT_HOME = 'https://deloitteomnia.deloitte.com.cn/';
const CONNECTOR_VERSION = '0.3.36';
const AUTHORIZATION_WAIT_MS = 1_500;
const EXPLICIT_CONNECT_AUTHORIZATION_WAIT_MS = 10_000;
const STATUS_IDENTITY_TIMEOUT_MS = 10_000;
const WORKSPACE_AUTHORITY_DIRECTORY_ROUTE = '/engagements/v1/facets/byEngagementIds';
const WORKSPACE_AUTHORITY_MAX_ENGAGEMENT_ENTRIES = 1;
const WORKSPACE_AUTHORITY_MAX_FACET_ENTRIES = 2_000;
const WORKSPACE_AUTHORITY_MAX_ENVELOPE_BYTES = 1024 * 1024;
const ENTERPRISE_LOGIN_LABEL = /(?:企业|enterprise|deloitte|single\s+sign|sso|sign\s*in|log\s*in|登录)/iu;
const ENTERPRISE_ONLY_LOGIN_LABEL = /(?:企业|enterprise|deloitte|single\s+sign|sso)/iu;

type FetchLike = typeof fetch;

export class ConnectorOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'ConnectorOperationError';
  }
}

interface Session {
  page: Page;
  targetUrl: URL;
  apiOrigin: string;
  engagementId: string;
  headers: Record<string, string>;
}

function clean(value: unknown, max = 300): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function boundedOperationErrorDetail(value: unknown): string {
  const allowedKey = /^(?:code|detail|details|error|errors|message|messages|title|validationError|validationErrors)$/iu;
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 3 || current == null) return undefined;
    if (typeof current === 'string') {
      const normalized = current.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
      return normalized ? normalized.slice(0, 500) : undefined;
    }
    if (typeof current === 'number' || typeof current === 'boolean') return current;
    if (Array.isArray(current)) {
      return current.slice(0, 8).map((item) => visit(item, depth + 1)).filter((item) => item !== undefined);
    }
    if (typeof current !== 'object') return undefined;
    const entries = Object.entries(current as Record<string, unknown>)
      .filter(([key]) => allowedKey.test(key)).slice(0, 16)
      .map(([key, item]) => [key, visit(item, depth + 1)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  const selected = visit(value, 0);
  if (selected === undefined) return '';
  const serialized = typeof selected === 'string' ? selected : JSON.stringify(selected);
  return serialized.slice(0, 1_500);
}

function list(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray((value as any)?.items)) return (value as any).items;
  if (Array.isArray((value as any)?.data)) return (value as any).data;
  return [];
}

function findEdgeExecutable(): string {
  const systemDrive = path.parse(process.env.SystemRoot || 'C:\\Windows').root;
  const candidates = [
    process.env.OMNIA_EDGE_PATH,
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(systemDrive, 'Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(systemDrive, 'Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean) as string[];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('未找到 Microsoft Edge。请安装 Edge，或通过 OMNIA_EDGE_PATH 指定官方程序路径。');
  return found;
}

function explicitId(value: unknown): string {
  const id = clean(value, 200).toLowerCase();
  return id && id !== '00000000-0000-0000-0000-000000000000' ? id : '';
}

function canonicalAuthorityIdentity(
  apiOrigin: string,
  hierarchyItem: Record<string, unknown>
): {
  authorityInstanceId: string; tenantOrOrgId: string; packId: string;
} {
  let authorityInstanceId = '';
  try { authorityInstanceId = new URL(apiOrigin).origin.toLowerCase(); } catch { /* fail closed below */ }
  const tenantOrOrgId = explicitId(hierarchyItem.tenantId || hierarchyItem.organizationId || hierarchyItem.orgId);
  const packId = explicitId(hierarchyItem.packId || hierarchyItem.engagementId || hierarchyItem.id);
  if (!authorityInstanceId || !packId) {
    throw new ConnectorOperationError(
      'CONNECTOR.PACK_IDENTITY_CHANGED',
      'Omnia hierarchy did not return the exact current Pack identity.'
    );
  }
  return { authorityInstanceId, tenantOrOrgId, packId };
}

function assertAuthorityDirectoryPayload(payload: unknown, engagementId: string): void {
  if (!Array.isArray(payload) || payload.length !== WORKSPACE_AUTHORITY_MAX_ENGAGEMENT_ENTRIES) {
    throw new ConnectorOperationError(
      'WORKSPACE.AUTHORITY_INVALID_DIRECTORY',
      'Omnia facet directory did not return exactly one Engagement entry.'
    );
  }
  const directory = payload[0];
  if (!directory || typeof directory !== 'object' || Array.isArray(directory)
    || explicitId((directory as any).engagementId) !== engagementId
    || !Array.isArray((directory as any).facets)) {
    throw new ConnectorOperationError(
      'WORKSPACE.AUTHORITY_IDENTITY_CHANGED',
      'Omnia facet directory did not match the current Engagement identity.'
    );
  }
  const facets = (directory as any).facets as unknown[];
  if (facets.length > WORKSPACE_AUTHORITY_MAX_FACET_ENTRIES) {
    throw new ConnectorOperationError(
      'WORKSPACE.AUTHORITY_ENTRY_LIMIT_EXCEEDED',
      'Omnia facet directory exceeded the Connector facet-entry limit.'
    );
  }
  for (const facet of facets) {
    if (!facet || typeof facet !== 'object' || Array.isArray(facet)
      || explicitId((facet as any).engagementId) !== engagementId) {
      throw new ConnectorOperationError(
        'WORKSPACE.AUTHORITY_IDENTITY_CHANGED',
        'Omnia facet directory contained a facet outside the current Engagement.'
      );
    }
  }
}

function assertAuthorityEnvelopeBudget(value: ConnectorWorkspaceAuthorityRead): void {
  let bytes = Number.POSITIVE_INFINITY;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { /* reject below */ }
  if (bytes > WORKSPACE_AUTHORITY_MAX_ENVELOPE_BYTES) {
    throw new ConnectorOperationError(
      'WORKSPACE.AUTHORITY_RESPONSE_TOO_LARGE',
      'Omnia workspace authority response exceeded the Connector byte limit.'
    );
  }
}

function selectUniqueTargetIndex(urls: string[]): number {
  const engagementIndexes = urls
    .map((url, index) => ({ index, engagementId: parseEngagementId(url) }))
    .filter((item) => item.engagementId);
  if (engagementIndexes.length > 1) {
    throw new ConnectorOperationError(
      'CONNECTOR.MULTIPLE_PACK_TARGETS',
      '受控 Edge 中同时打开了多个 Omnia Pack。请只保留一个目标 Pack 后重试连接。'
    );
  }
  if (engagementIndexes.length === 1) return engagementIndexes[0]!.index;
  if (urls.length > 1) {
    throw new ConnectorOperationError(
      'CONNECTOR.MULTIPLE_OMNIA_TARGETS',
      '受控 Edge 中有多个未绑定的 Omnia 页面。请只保留一个目标页面后重试连接。'
    );
  }
  return urls.length === 1 ? 0 : -1;
}

function authorizationEngagementId(requestUrl: string, targetUrl: string): { engagementId: string; identityMismatch: boolean } {
  const request = new URL(requestUrl);
  const targetEngagementId = parseEngagementId(targetUrl);
  const requestEngagementId = request.pathname.match(
    /(?:^|\/)engagements?(?:\/v1)?\/([0-9a-f-]{36})(?:\/|$)/i
  )?.[1]?.toLowerCase() || '';
  return {
    engagementId: requestEngagementId || targetEngagementId,
    identityMismatch: Boolean(targetEngagementId && requestEngagementId && targetEngagementId !== requestEngagementId)
  };
}

function selectSafeTargetIndex(
  targets: Array<{ url: string; contextId: number }>,
  boundIndex: number
): number {
  const selectedIndex = selectUniqueTargetIndex(targets.map((item) => item.url));
  if (boundIndex < 0 || boundIndex >= targets.length) return selectedIndex;
  if (selectedIndex < 0) return boundIndex;
  if (selectedIndex === boundIndex) return selectedIndex;
  const bound = targets[boundIndex]!;
  const selected = targets[selectedIndex]!;
  const safeHandoff = !parseEngagementId(bound.url)
    && Boolean(parseEngagementId(selected.url))
    && bound.contextId === selected.contextId;
  if (!safeHandoff) {
    throw new ConnectorOperationError('CONNECTOR.MULTIPLE_PACK_TARGETS', 'Omnia target 身份发生歧义，已拒绝切换。');
  }
  return selectedIndex;
}

function browserIdentityMatches(argumentsList: string[], profileDir: string, port: number): boolean {
  const expectedProfile = path.resolve(profileDir).toLowerCase();
  const profileArgument = argumentsList.find((value) => value.startsWith('--user-data-dir='));
  const portArgument = argumentsList.find((value) => value.startsWith('--remote-debugging-port='));
  const actualProfile = profileArgument
    ? path.resolve(profileArgument.slice('--user-data-dir='.length)).toLowerCase()
    : '';
  const actualPort = Number(portArgument?.slice('--remote-debugging-port='.length));
  return actualProfile === expectedProfile && actualPort === port;
}

type PageAuthorization = {
  headers: Record<string, string>;
  apiOrigin: string;
  engagementId: string;
  identityMismatch: boolean;
  capturedAt: number;
  captureEpoch: number;
};

type VerifiedPackIdentity = {
  engagementId: string;
  apiOrigin: string;
  authorization: string;
  pack: {
    name: string;
    clientName: string;
    authorityInstanceId: string;
    tenantOrOrgId: string;
    packId: string;
  };
};

export class WorkstationOmniaSession {
  private browser: Browser | null = null;
  private authByPage = new WeakMap<Page, PageAuthorization>();
  private verifiedPackByPage = new WeakMap<Page, VerifiedPackIdentity>();
  private authorizationCaptureEpoch = 0;
  private authorizationWaitByPage = new WeakMap<Page, {
    engagementId: string;
    afterEpoch: number;
    promise: Promise<boolean>;
  }>();
  private port = 0;
  private readonly profileDir: string;
  private readonly statePath: string;
  private readonly targetStatePath: string;
  private readonly lockPath: string;
  private boundPage: Page | null = null;
  private ownsLock = false;
  private readonly sessionGeneration = randomInt(1, 281_474_976_710_655);
  private readonly operationHost: OperationHost;
  private readonly dataRootPath: string;
  private readonly connectorIdentity: { id: string; name: string; version: string };

  constructor(
    dataRoot: string,
    private readonly fetchImpl: FetchLike = fetch,
    connectorIdentity: { id: string; name: string; version: string } = {
      id: 'v5-workstation-omnia-session',
      name: 'Omnia Agent v5 Workstation Omnia Session',
      version: CONNECTOR_VERSION
    },
    private readonly lifecycleAudit: (event: string, details: Record<string, unknown>) => void = () => undefined
  ) {
    this.connectorIdentity = connectorIdentity;
    this.dataRootPath = path.resolve(dataRoot);
    this.profileDir = path.join(dataRoot, 'connector', 'edge-profile');
    this.statePath = path.join(dataRoot, 'connector', 'browser-instance.json');
    this.targetStatePath = path.join(dataRoot, 'connector', 'last-pack-target.json');
    this.lockPath = path.join(dataRoot, 'connector', 'connector.lock');
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.acquireInstanceLock();
    this.operationHost = new OperationHost(path.join(this.dataRootPath, 'connector', 'operation-streams'));
  }

  async close(): Promise<void> {
    // Never close or terminate the user's controlled Edge session here.
    // Connector process exit releases its own CDP websocket.
    this.browser = null;
    await this.operationHost.close();
    if (this.ownsLock) {
      try { fs.rmSync(this.lockPath, { force: true }); } catch { /* best-effort lock cleanup */ }
      this.ownsLock = false;
    }
  }

  health(): { ready: true; connectorVersion: string } {
    return { ready: true, connectorVersion: this.connectorIdentity.version };
  }

  private acquireInstanceLock(): void {
    const writeLock = () => {
      const handle = fs.openSync(this.lockPath, 'wx');
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fs.closeSync(handle);
      this.ownsLock = true;
    };
    try {
      writeLock();
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let pid = 0;
    try { pid = Number(JSON.parse(fs.readFileSync(this.lockPath, 'utf8')).pid); } catch { /* invalid lock stays stale */ }
    let live = false;
    if (pid > 0) {
      try { process.kill(pid, 0); live = true; } catch { /* stale process id */ }
    }
    if (live) {
      throw new ConnectorOperationError(
        'CONNECTOR.INSTANCE_LOCKED',
        '已有 v5 Remote Connector Session Core 正在使用该数据实例。'
      );
    }
    fs.rmSync(this.lockPath, { force: true });
    writeLock();
  }

  private readSavedPort(): number {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      const port = Number(parsed?.port);
      return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
    } catch {
      return 0;
    }
  }

  private savePort(port: number): void {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({
      schemaVersion: 'omnia.connector-browser-instance/v1',
      port,
      profileDir: this.profileDir,
      updatedAt: new Date().toISOString()
    }));
    fs.renameSync(temporary, this.statePath);
  }

  private savedPackTarget(): string {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.targetStatePath, 'utf8'));
      if (parsed?.schemaVersion !== 'omnia.connector-pack-target/v1') return '';
      const engagementId = explicitId(parsed.engagementId);
      return isGuid(engagementId) ? engagementId : '';
    } catch {
      return '';
    }
  }

  private rememberPackTarget(engagementId: string): void {
    const exact = explicitId(engagementId);
    if (!isGuid(exact) || this.savedPackTarget() === exact) return;
    const temporary = `${this.targetStatePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({
        schemaVersion: 'omnia.connector-pack-target/v1',
        engagementId: exact,
        updatedAt: new Date().toISOString()
      }));
      fs.renameSync(temporary, this.targetStatePath);
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort temp cleanup */ }
    }
  }

  private async chooseFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(port));
      });
    });
  }

  private async cdpReady(port = this.port): Promise<boolean> {
    if (!port) return false;
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_500)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const savedPort = this.readSavedPort();
    if (savedPort && await this.cdpReady(savedPort)) {
      this.port = savedPort;
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
      await this.verifyBrowserIdentity(this.browser);
      this.observeBrowserDisconnect(this.browser);
      this.lifecycleAudit('pack.browser.reattached', { port: this.port });
    } else {
      this.port = await this.chooseFreePort();
      this.savePort(this.port);
      const edge = findEdgeExecutable();
      const edgeProcess = spawn(edge, [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profileDir}`,
        '--enable-automation',
        '--no-first-run',
        '--no-default-browser-check',
        DEFAULT_HOME
      ], { windowsHide: false, detached: true, stdio: 'ignore' });
      edgeProcess.once('error', () => { /* readiness check returns the user-visible failure */ });
      edgeProcess.once('exit', (code, signal) => {
        this.lifecycleAudit('pack.browser.process_exited', { pid: edgeProcess.pid || 0, code: code ?? -1, signal: signal || '' });
      });
      edgeProcess.unref();
      this.lifecycleAudit('pack.browser.process_started', { pid: edgeProcess.pid || 0, port: this.port });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !await this.cdpReady()) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!await this.cdpReady()) throw new Error('Edge 已启动，但 Connector 无法建立受控 CDP 会话。');
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
      await this.verifyBrowserIdentity(this.browser);
      this.observeBrowserDisconnect(this.browser);
    }
    for (const context of this.browser.contexts()) {
      context.on('page', (page) => this.observePage(page));
      for (const page of context.pages()) this.observePage(page);
    }
    return this.browser;
  }

  private observeBrowserDisconnect(browser: Browser): void {
    browser.once('disconnected', () => {
      if (this.browser === browser) {
        this.browser = null;
        this.boundPage = null;
      }
      this.lifecycleAudit('pack.browser.cdp_disconnected', { port: this.port });
    });
  }

  private async verifyBrowserIdentity(browser: Browser): Promise<void> {
    const session = await browser.newBrowserCDPSession();
    try {
      const result = await session.send('Browser.getBrowserCommandLine') as { arguments?: string[] };
      const argumentsList = Array.isArray(result.arguments) ? result.arguments : [];
      if (!browserIdentityMatches(argumentsList, this.profileDir, this.port)) {
        throw new ConnectorOperationError(
          'CONNECTOR.CDP_IDENTITY_MISMATCH',
          '本机 CDP 端口不属于当前 v5 Connector 受控浏览器，已拒绝接入。'
        );
      }
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  private observePage(page: Page): void {
    if ((page as any).__omniaV5Observed) return;
    (page as any).__omniaV5Observed = true;
    page.on('request', (request) => { void this.captureHeaders(page, request); });
  }

  private async continueEnterpriseLogin(page: Page): Promise<boolean> {
    if (page.isClosed() || isAllowedOmniaUrl(page.url())) return false;
    let target: URL;
    try { target = new URL(page.url()); } catch { return false; }
    if (target.protocol !== 'https:') return false;

    // This recovery path never supplies credentials or chooses an account. It
    // only presses one unambiguous enterprise-SSO entry button. If the identity
    // provider asks for a password, MFA, email, or any other user input, leave
    // the page untouched and report waiting_login.
    const frames = page.frames();
    for (const frame of frames) {
      for (const selector of ['input[type="password"]']) {
        const inputs = frame.locator(selector);
        for (let index = 0; index < await inputs.count(); index += 1) {
          if (await inputs.nth(index).isVisible().catch(() => false)) return false;
        }
      }
    }

    let identityInputVisible = false;
    for (const frame of frames) {
      const identityInputs = frame.locator('input[type="email"], input[name="loginfmt"]');
      for (let index = 0; index < await identityInputs.count(); index += 1) {
        if (await identityInputs.nth(index).isVisible().catch(() => false)) identityInputVisible = true;
      }
    }
    const allowedLabel = identityInputVisible ? ENTERPRISE_ONLY_LOGIN_LABEL : ENTERPRISE_LOGIN_LABEL;

    const visible = [];
    for (const frame of frames) {
      for (const role of ['button', 'link'] as const) {
        const matches = frame.getByRole(role, { name: allowedLabel });
        for (let index = 0; index < await matches.count(); index += 1) {
          const match = matches.nth(index);
          if (await match.isVisible().catch(() => false) && await match.isEnabled().catch(() => false)) visible.push(match);
        }
      }
    }
    if (visible.length === 0) {
      for (const frame of frames) {
        const actionable = frame.locator('button, a, [role="button"], input[type="submit"], [tabindex="0"]');
        for (let index = 0; index < await actionable.count(); index += 1) {
          const match = actionable.nth(index);
          if (!await match.isVisible().catch(() => false) || !await match.isEnabled().catch(() => false)) continue;
          const label = clean([
            await match.getAttribute('aria-label').catch(() => ''),
            await match.getAttribute('value').catch(() => ''),
            await match.textContent().catch(() => '')
          ].filter(Boolean).join(' '), 200);
          if (allowedLabel.test(label)) visible.push(match);
        }
      }
    }
    if (visible.length !== 1) return false;
    await visible[0]!.click({ timeout: 5_000 });
    await page.waitForTimeout(2_000);
    return true;
  }

  private async enterpriseLoginDiagnostic(page: Page): Promise<string> {
    let host = '';
    let pathname = '';
    try {
      const target = new URL(page.url());
      host = target.host;
      pathname = target.pathname;
    } catch { host = 'invalid-url'; }
    const title = clean(await page.title().catch(() => ''), 120);
    const body = clean(await page.locator('body').innerText().catch(() => ''), 500);
    const controls: string[] = [];
    const inputs: string[] = [];
    for (const frame of page.frames()) {
      const actionable = frame.locator('button, a, [role="button"], input[type="submit"], [tabindex="0"]');
      for (let index = 0; index < await actionable.count() && controls.length < 12; index += 1) {
        const match = actionable.nth(index);
        if (!await match.isVisible().catch(() => false)) continue;
        const label = clean([
          await match.getAttribute('aria-label').catch(() => ''),
          await match.getAttribute('value').catch(() => ''),
          await match.textContent().catch(() => '')
        ].filter(Boolean).join(' '), 100);
        if (label) controls.push(label);
      }
      const fields = frame.locator('input');
      for (let index = 0; index < await fields.count() && inputs.length < 8; index += 1) {
        const field = fields.nth(index);
        if (!await field.isVisible().catch(() => false)) continue;
        inputs.push(clean(`${await field.getAttribute('type').catch(() => '') || 'text'}:${await field.getAttribute('name').catch(() => '') || ''}`, 80));
      }
    }
    return `login_host=${host}; path=${pathname || '-'}; title=${title || '-'}; controls=${controls.join('|') || '-'}; inputs=${inputs.join('|') || '-'}; body=${body || '-'}`;
  }

  private async waitForAuthorization(
    page: Page,
    engagementId: string,
    afterEpoch = -1,
    waitMs = AUTHORIZATION_WAIT_MS
  ): Promise<boolean> {
    const current = this.authByPage.get(page);
    if (current?.headers.authorization && current.captureEpoch > afterEpoch
      && !current.identityMismatch && current.engagementId === engagementId) return true;
    const existing = this.authorizationWaitByPage.get(page);
    if (existing?.engagementId === engagementId && existing.afterEpoch >= afterEpoch) return existing.promise;
    const promise = (async () => {
      const deadline = Date.now() + waitMs;
      while (!page.isClosed() && Date.now() < deadline) {
        const observed = this.authByPage.get(page);
        if (observed?.headers.authorization && observed.captureEpoch > afterEpoch
          && !observed.identityMismatch && observed.engagementId === engagementId) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })();
    this.authorizationWaitByPage.set(page, { engagementId, afterEpoch, promise });
    try {
      return await promise;
    } finally {
      if (this.authorizationWaitByPage.get(page)?.promise === promise) {
        this.authorizationWaitByPage.delete(page);
      }
    }
  }

  private authorizationForPage(page: Page, apiOrigin: string): PageAuthorization {
    return this.authByPage.get(page) || {
      headers: {},
      apiOrigin,
      engagementId: '',
      identityMismatch: false,
      capturedAt: 0,
      captureEpoch: 0
    };
  }

  private revokeAuthorization(page: Page, authorization = ''): void {
    const current = this.authByPage.get(page);
    if (!current) return;
    if (authorization && current.headers.authorization !== authorization) return;
    this.authByPage.delete(page);
  }

  private async captureHeaders(page: Page, request: Request): Promise<void> {
    if (!isAllowedOmniaUrl(request.url())) return;
    const headers: Record<string, string> = await request.allHeaders().catch(() => ({}));
    const authorization = clean(headers.authorization, 8192);
    if (!authorization) return;
    const allowlisted: Record<string, string> = { authorization };
    for (const key of ['traceparent', 'tracestate', 'x-correlation-id', 'x-client-trace-id', 'x-ms-client-request-id']) {
      if (headers[key]) allowlisted[key] = clean(headers[key], 1024);
    }
    const previous = this.authByPage.get(page);
    const requestUrl = new URL(request.url());
    const authoritativeApiRequest = /^\/(?:rapr|work\/v1|engagements\/v1)\//i.test(requestUrl.pathname);
    const authIdentity = authorizationEngagementId(request.url(), page.url());
    this.authByPage.set(page, {
      headers: allowlisted,
      apiOrigin: authoritativeApiRequest ? requestUrl.origin : (previous?.apiOrigin || requestUrl.origin),
      engagementId: authIdentity.engagementId,
      identityMismatch: authIdentity.identityMismatch,
      capturedAt: Date.now(),
      captureEpoch: ++this.authorizationCaptureEpoch
    });
  }

  private async omniaPages(): Promise<Page[]> {
    const browser = await this.ensureBrowser();
    return browser.contexts().flatMap((context) => context.pages())
      .filter((page) => isAllowedOmniaUrl(page.url()));
  }

  private async currentPage(bindIfUnique = false): Promise<Page | null> {
    const omniaPages = await this.omniaPages();
    const liveBound = this.boundPage && !this.boundPage.isClosed() ? this.boundPage : null;
    // A bound page may temporarily navigate to an external enterprise IdP.
    // Keep it only as an untrusted waiting-login target; it never supplies
    // Authorization or Pack identity. A unique Omnia Pack in the same browser
    // context may later take over through the normal safe-handoff rule.
    const pages = liveBound && !isAllowedOmniaUrl(liveBound.url())
      ? [liveBound, ...omniaPages.filter((page) => page !== liveBound)]
      : omniaPages;
    const bound = liveBound;
    const contexts: object[] = [];
    const targets = pages.map((page) => {
      const context = page.context();
      let contextId = contexts.indexOf(context);
      if (contextId < 0) { contexts.push(context); contextId = contexts.length - 1; }
      return { url: page.url(), contextId };
    });
    const selectedIndex = selectSafeTargetIndex(targets, bound ? pages.indexOf(bound) : -1);
    const selected = selectedIndex >= 0 ? pages[selectedIndex] || null : null;
    if (!bound) this.boundPage = null;
    if (selected && bindIfUnique) this.boundPage = selected;
    return selected;
  }

  private async session(requireAuth = true): Promise<Session> {
    const page = await this.currentPage(true);
    if (!page) throw new ConnectorOperationError('CONNECTOR.TARGET_UNAVAILABLE', '没有找到受控 Omnia 页面。');
    if (!isAllowedOmniaUrl(page.url())) {
      throw new ConnectorOperationError('CONNECTOR.PACK_NOT_OPEN', '受控页面正在完成企业登录；请登录后打开目标 Pack。');
    }
    const targetUrl = normalizeOmniaUrl(page.url());
    const engagementId = parseEngagementId(targetUrl.href);
    if (!isGuid(engagementId)) {
      throw new ConnectorOperationError('CONNECTOR.PACK_NOT_OPEN', '请在 Edge 中登录 Omnia 并打开目标 Pack。');
    }
    this.rememberPackTarget(engagementId);
    let auth = this.authorizationForPage(page, targetUrl.origin);
    if (requireAuth && !auth.headers.authorization) {
      await this.waitForAuthorization(page, engagementId);
      auth = this.authorizationForPage(page, targetUrl.origin);
    }
    const headers = auth.headers;
    if (requireAuth && !headers.authorization) {
      throw new ConnectorOperationError(
        'CONNECTOR.AUTH_REQUIRED',
        '尚未捕获 Omnia API 授权；请保持目标 Pack 打开后重试刷新。'
      );
    }
    if (requireAuth && (auth.identityMismatch || auth.engagementId !== engagementId)) {
      throw new ConnectorOperationError('CONNECTOR.PACK_IDENTITY_CHANGED', 'Authorization 与当前 Omnia target 的 Pack 身份不一致。');
    }
    return { page, targetUrl, apiOrigin: auth.apiOrigin, engagementId, headers };
  }

  private async api(session: Session, route: string, timeoutMs = 60_000): Promise<unknown> {
    const url = new URL(route, session.apiOrigin);
    if (url.origin !== session.apiOrigin || !isAllowedOmniaUrl(url.href)) {
      throw new Error('Connector 拒绝了不在当前 Omnia origin 内的读取请求。');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { ...session.headers, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new ConnectorOperationError('WORKSPACE.READ_TIMEOUT', 'Omnia 只读 API 超时或网络不可用。', true);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.revokeAuthorization(session.page, session.headers.authorization);
      }
      throw new ConnectorOperationError(
        response.status === 401 || response.status === 403 ? 'CONNECTOR.AUTH_REQUIRED' : 'WORKSPACE.READ_FAILED',
        `Omnia 只读 API 返回 HTTP ${response.status}。`,
        response.status >= 500
      );
    }
    return payload;
  }

  private async workspaceAuthorityDirectory(session: Session): Promise<unknown> {
    const url = new URL(WORKSPACE_AUTHORITY_DIRECTORY_ROUTE, session.apiOrigin);
    if (url.origin !== session.apiOrigin
      || url.pathname !== WORKSPACE_AUTHORITY_DIRECTORY_ROUTE
      || url.search
      || !isAllowedOmniaUrl(url.href)) {
      throw new ConnectorOperationError(
        'WORKSPACE.AUTHORITY_ROUTE_DENIED',
        'Connector refused a Workspace authority request outside the fixed Omnia facet-directory route.'
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...session.headers,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([session.engagementId]),
        signal: AbortSignal.timeout(60_000)
      });
    } catch {
      throw new ConnectorOperationError('WORKSPACE.READ_TIMEOUT', 'Omnia facet directory API timed out or was unavailable.', true);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.revokeAuthorization(session.page, session.headers.authorization);
      }
      throw new ConnectorOperationError(
        response.status === 401 || response.status === 403 ? 'CONNECTOR.AUTH_REQUIRED' : 'WORKSPACE.READ_FAILED',
        `Omnia facet directory API returned HTTP ${response.status}.`,
        response.status >= 500
      );
    }
    assertAuthorityDirectoryPayload(payload, session.engagementId);
    return payload;
  }

  private async identify(
    session: Session,
    timeoutMs = 60_000
  ): Promise<{ name: string; clientName: string; authorityInstanceId: string; tenantOrOrgId: string; packId: string }> {
    const hierarchy = list(await this.api(
      session,
      `/engagements/v1/${session.engagementId}/headers/hierarchy`,
      timeoutMs
    ));
    const exact = hierarchy.find((item) =>
      explicitId(item?.engagementId || item?.id) === session.engagementId
    );
    if (!exact) {
      throw new ConnectorOperationError('CONNECTOR.PACK_IDENTITY_CHANGED', 'Omnia hierarchy 与当前 target 的 Pack 身份不一致。');
    }
    const name = clean(exact?.name);
    if (!name) throw new Error('已识别 Pack ID，但 Omnia hierarchy 未返回可核验名称。');
    return {
      name,
      clientName: clean(exact?.clientName),
      ...canonicalAuthorityIdentity(session.apiOrigin, exact)
    };
  }

  /**
   * Core already freezes every signed Operation to the exact Connector
   * binding returned by a live hierarchy read. Re-reading that hierarchy for
   * every individual preflight, mutation and read-back adds a full Omnia API
   * request without strengthening an unchanged binding. This process-local
   * proof is reusable only while the exact Page, API origin, engagement and
   * bearer remain unchanged. A navigation, Pack switch, token refresh,
   * revocation, or Connector restart necessarily misses the cache.
   */
  private async operationPackIdentity(session: Session): Promise<VerifiedPackIdentity['pack']> {
    const authorization = session.headers.authorization || '';
    const verified = this.verifiedPackByPage.get(session.page);
    if (verified
      && verified.engagementId === session.engagementId
      && verified.apiOrigin === session.apiOrigin
      && verified.authorization === authorization) return verified.pack;
    const pack = await this.identify(session);
    this.verifiedPackByPage.set(session.page, {
      engagementId: session.engagementId,
      apiOrigin: session.apiOrigin,
      authorization,
      pack
    });
    return pack;
  }

  async status(): Promise<ConnectorConnection> {
    try {
      const knownPort = this.port || this.readSavedPort();
      if (!await this.cdpReady(knownPort)) return this.snapshot('browser_starting', '尚未启动受控 Omnia 浏览器。');
      this.port = knownPort;
      const page = await this.currentPage(true);
      if (!page) return this.snapshot('target_closed', '受控 Edge 中没有可用的 Omnia target。');
      if (!isAllowedOmniaUrl(page.url())) {
        return this.snapshot('waiting_login', '受控页面正在完成企业登录；登录完成后会继续识别 Omnia Pack。');
      }
      const targetUrl = normalizeOmniaUrl(page.url());
      const engagementId = parseEngagementId(targetUrl.href);
      const auth = this.authorizationForPage(page, targetUrl.origin);
      if (!engagementId) {
        return this.snapshot(
          auth.headers.authorization ? 'waiting_pack' : 'waiting_login',
          auth.headers.authorization ? '已登录 Omnia，请继续打开目标 Pack。' : '请在受控 Edge 中登录 Omnia。'
        );
      }
      this.rememberPackTarget(engagementId);
      const session: Session = { page, targetUrl, apiOrigin: auth.apiOrigin, engagementId, headers: auth.headers };
      if (!auth.headers.authorization) {
        return this.snapshot('waiting_authorization', '已打开目标 Pack，正在等待同一 target 的 Authorization。', session);
      }
      if (auth.identityMismatch) {
        // A captured Authorization belongs to a different Engagement than the
        // page it was captured against. This is a real identity conflict, not
        // a pack switch: refuse until the user resolves the mismatched target.
        this.verifiedPackByPage.delete(page);
        return this.snapshot('identity_changed', 'Authorization 与当前 target 的 Pack 身份不一致，已拒绝连接。', session);
      }
      if (auth.engagementId && auth.engagementId !== engagementId) {
        // The page moved to a new Pack (SPA navigation) but that Pack has not
        // issued an allowlisted Authorization yet. The old bearer is stale, not
        // proof of conflict: discard it and wait for the new target to re-issue
        // Authorization, mirroring the AUTH_REQUIRED recovery path. This keeps
        // an ordinary Pack switch recoverable instead of failing closed forever
        // as identity_changed.
        this.revokeAuthorization(page, session.headers.authorization);
        this.verifiedPackByPage.delete(page);
        return this.snapshot('waiting_authorization', '已切换 Pack；正在等待新 Pack 重新签发 Authorization。', { ...session, headers: {} });
      }
      try {
        // `connected` is a live assertion, not a cache hit. In particular a
        // long-running Connector can outlive multiple Shell processes and its
        // previously captured bearer may expire between those restarts.
        const pack = await this.identify(session, STATUS_IDENTITY_TIMEOUT_MS);
        this.verifiedPackByPage.set(page, {
          engagementId,
          apiOrigin: auth.apiOrigin,
          authorization: auth.headers.authorization || '',
          pack
        });
        return this.snapshot('connected', `当前 Pack 已连接：${pack.name}`, session, pack);
      } catch (error) {
        if (error instanceof ConnectorOperationError && error.code === 'CONNECTOR.AUTH_REQUIRED') {
          this.revokeAuthorization(page, session.headers.authorization);
          this.verifiedPackByPage.delete(page);
          return this.snapshot(
            'waiting_authorization',
            '当前 Page Authorization 已失效；正在等待同一 Pack target 重新签发。',
            { ...session, headers: {} }
          );
        }
        if (error instanceof ConnectorOperationError && error.code === 'CONNECTOR.PACK_IDENTITY_CHANGED') {
          return this.snapshot('identity_changed', error.message, session);
        }
        return this.snapshot('identifying_pack', error instanceof Error ? error.message : '正在读取当前 Pack hierarchy。', session);
      }
    } catch (error) {
      if (error instanceof ConnectorOperationError && /MULTIPLE/.test(error.code)) {
        return this.snapshot('multiple_targets', error.message);
      }
      return this.snapshot('error', error instanceof Error ? error.message : 'Omnia Session 状态读取失败。');
    }
  }

  async connect(expectedEngagementId = ''): Promise<ConnectorConnection> {
    const browser = await this.ensureBrowser();
    let page = await this.currentPage(true);
    if (!page) {
      const context = browser.contexts()[0] || await browser.newContext();
      page = await context.newPage();
      this.boundPage = page;
      this.observePage(page);
      await page.goto(DEFAULT_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    }
    await page.bringToFront();
    let observed = await this.status();
    if (observed.status === 'waiting_login') {
      let continued = await this.continueEnterpriseLogin(page);
      let host = '';
      try { host = new URL(page.url()).hostname.toLowerCase(); } catch { /* diagnostic below */ }
      if (!continued && host === new URL(DEFAULT_HOME).hostname.toLowerCase()) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
        await page.waitForTimeout(2_000);
        continued = await this.continueEnterpriseLogin(page);
      }
      if (continued) observed = await this.status();
      else observed = { ...observed, message: `${observed.message} ${await this.enterpriseLoginDiagnostic(page)}` };
    }
    if (observed.status === 'waiting_pack') {
      const engagementId = explicitId(expectedEngagementId) || this.savedPackTarget();
      if (isGuid(engagementId)) {
        const targetUrl = new URL(`/engagement/${engagementId}/home`, DEFAULT_HOME);
        const beforeNavigationEpoch = this.authorizationCaptureEpoch;
        await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this.waitForAuthorization(page, engagementId, beforeNavigationEpoch, EXPLICIT_CONNECT_AUTHORIZATION_WAIT_MS);
        observed = await this.status();
      }
    }
    if (observed.status === 'waiting_authorization' && isAllowedOmniaUrl(page.url())) {
      const targetUrl = normalizeOmniaUrl(page.url());
      const engagementId = parseEngagementId(targetUrl.href);
      if (isGuid(engagementId)) {
        // Focusing an existing SPA target normally resumes its own authorized
        // traffic. Give that passive path a short chance first. If the Pack was
        // already idle before this Connector attached, an explicit user connect
        // has no request from which to capture Authorization. In that one case,
        // reload the same verified Pack URL and capture its normal API traffic;
        // never navigate to another target or read browser storage.
        const captured = await this.waitForAuthorization(
          page,
          engagementId,
          this.authorizationCaptureEpoch,
          Math.min(2_000, EXPLICIT_CONNECT_AUTHORIZATION_WAIT_MS)
        );
        if (!captured && !page.isClosed() && isAllowedOmniaUrl(page.url())
          && parseEngagementId(normalizeOmniaUrl(page.url()).href) === engagementId) {
          const beforeReloadEpoch = this.authorizationCaptureEpoch;
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
          await this.waitForAuthorization(page, engagementId, beforeReloadEpoch, EXPLICIT_CONNECT_AUTHORIZATION_WAIT_MS);
        }
        observed = await this.status();
      }
    }
    return observed;
  }

  async refresh(): Promise<ConnectorConnection> {
    // Keepalive is an observation, never a browser action. `status()` may
    // attach to an already-running controlled CDP endpoint, but it does not
    // start, navigate, reload, focus, or create a page. If the existing target
    // is gone, it reports the real target_closed state.
    return this.status();
  }

  async workspaceAuthorityRead(expectedEngagementId: string): Promise<ConnectorWorkspaceAuthorityRead> {
    const session = await this.session(true);
    if (session.engagementId !== explicitId(expectedEngagementId)) {
      throw new ConnectorOperationError('CONNECTOR.PACK_IDENTITY_CHANGED', '当前 Pack 已变化，拒绝复用旧连接身份。');
    }
    const [pack, facetDirectoryPayload] = await Promise.all([
      this.identify(session),
      this.workspaceAuthorityDirectory(session)
    ]);
    this.verifiedPackByPage.set(session.page, {
      engagementId: session.engagementId,
      apiOrigin: session.apiOrigin,
      authorization: session.headers.authorization || '',
      pack
    });
    const result: ConnectorWorkspaceAuthorityRead = {
      schemaVersion: 'omnia.workspace-authority-read/v2',
      profile: 'workspace_authority_read',
      engagementId: session.engagementId,
      source: 'omnia_authority_api',
      connectorBinding: {
        connectorId: this.connectorIdentity.id,
        sessionGeneration: this.sessionGeneration,
        engagementId: session.engagementId,
        authorityInstanceId: pack.authorityInstanceId,
        tenantOrOrgId: pack.tenantOrOrgId,
        packId: pack.packId
      },
      facetDirectoryPayload
    };
    assertAuthorityEnvelopeBudget(result);
    return result;
  }

  async registerOperation(input: OperationRegistrationCommand): Promise<unknown> {
    const session = await this.session(true);
    const pack = await this.operationPackIdentity(session);
    return this.operationHost.register(input, {
      connectorId: this.connectorIdentity.id,
      sessionGeneration: this.sessionGeneration,
      engagementId: session.engagementId,
      authorityInstanceId: pack.authorityInstanceId,
      tenantOrOrgId: pack.tenantOrOrgId,
      packId: pack.packId
    });
  }

  async invokeOperation(input: OperationInvocationRequest): Promise<unknown> {
    const session = await this.session(true);
    const pack = await this.operationPackIdentity(session);
    const binding = {
      connectorId: this.connectorIdentity.id,
      sessionGeneration: this.sessionGeneration,
      engagementId: session.engagementId,
      authorityInstanceId: pack.authorityInstanceId,
      tenantOrOrgId: pack.tenantOrOrgId,
      packId: pack.packId
    };
    return this.operationHost.invoke(input, binding, async (route, routePath, body, execution) => {
      const url = new URL(routePath, session.apiOrigin);
      if (url.origin !== session.apiOrigin || !isAllowedOmniaUrl(url.href)) {
        throw new ConnectorOperationError('CONNECTOR.OPERATION_ROUTE_DENIED', 'Operation step escaped the current Omnia origin.');
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: route.method,
          headers: {
            ...session.headers,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000)
        });
      } catch {
        throw new ConnectorOperationError(
          execution.commitStep ? 'CONNECTOR.RESPONSE_LOST' : 'CONNECTOR.OPERATION_TIMEOUT',
          execution.commitStep
            ? 'Omnia mutation connection ended before a response was received; the result is uncertain.'
            : 'Omnia Operation read timed out.',
          !execution.commitStep
        );
      }
      const payload = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.revokeAuthorization(session.page, session.headers.authorization);
        }
        if (execution.commitStep && response.status >= 500) {
          throw new ConnectorOperationError('CONNECTOR.RESPONSE_LOST', `Omnia mutation returned HTTP ${response.status}; the result is uncertain.`, false);
        }
        const detail = boundedOperationErrorDetail(payload);
        throw new ConnectorOperationError(
          response.status === 401 || response.status === 403 ? 'CONNECTOR.AUTH_REQUIRED' : 'CONNECTOR.OPERATION_FAILED',
          `Omnia Operation step returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
          response.status >= 500
        );
      }
      return payload;
    }, {
      page: session.page,
      binding,
      targetUrl: session.targetUrl,
      apiOrigin: session.apiOrigin
    });
  }

  maintenanceSnapshot(): ReturnType<OperationHost['maintenanceSnapshot']> {
    return this.operationHost.maintenanceSnapshot();
  }

  private snapshot(
    status: ConnectorConnection['status'],
    message: string,
    session?: Session,
    pack?: { name: string; clientName: string; authorityInstanceId: string; tenantOrOrgId: string; packId: string }
  ): ConnectorConnection {
    return {
      status,
      connected: status === 'connected',
      connecting: [
        'browser_starting', 'waiting_login', 'waiting_pack',
        'waiting_authorization', 'identifying_pack'
      ].includes(status),
      connectorId: this.connectorIdentity.id,
      connectorName: this.connectorIdentity.name,
      connectorVersion: this.connectorIdentity.version,
      sessionGeneration: this.sessionGeneration,
      authorityInstanceId: pack?.authorityInstanceId || '',
      tenantOrOrgId: pack?.tenantOrOrgId || '',
      packId: pack?.packId || '',
      engagementId: session?.engagementId || '',
      engagementName: pack?.name || '',
      clientName: pack?.clientName || '',
      checkedAt: new Date().toISOString(),
      message
    };
  }
}

export const _test = {
  assertAuthorityDirectoryPayload,
  assertAuthorityEnvelopeBudget,
  findEdgeExecutable,
  selectUniqueTargetIndex,
  authorizationEngagementId,
  selectSafeTargetIndex,
  browserIdentityMatches
  ,canonicalAuthorityIdentity
};
