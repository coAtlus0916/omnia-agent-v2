import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type Page, type Request } from 'playwright-core';
import type { ConnectorConnection, ConnectorWorkspaceAuthorityRead } from './contracts.js';
import type { OperationInvocationRequest, OperationRegistrationRequest } from '../shared/operation-contracts.js';
import { isAllowedOmniaUrl, isGuid, normalizeOmniaUrl, parseEngagementId } from './omnia-origin.js';
import { OperationHost } from './operation-host.js';

const DEFAULT_HOME = 'https://deloitteomnia.deloitte.com.cn/';
const CONNECTOR_VERSION = '0.3.31';
const AUTHORIZATION_WAIT_MS = 1_500;
const AUTHORIZATION_REFRESH_WAIT_MS = 10_000;
const WORKSPACE_AUTHORITY_DIRECTORY_ROUTE = '/engagements/v1/facets/byEngagementIds';
const WORKSPACE_AUTHORITY_MAX_ENGAGEMENT_ENTRIES = 1;
const WORKSPACE_AUTHORITY_MAX_FACET_ENTRIES = 2_000;
const WORKSPACE_AUTHORITY_MAX_ENVELOPE_BYTES = 1024 * 1024;

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

function list(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray((value as any)?.items)) return (value as any).items;
  if (Array.isArray((value as any)?.data)) return (value as any).data;
  return [];
}

function findEdgeExecutable(): string {
  const candidates = [
    process.env.OMNIA_EDGE_PATH,
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
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

export class WorkstationOmniaSession {
  private browser: Browser | null = null;
  private authByPage = new WeakMap<Page, PageAuthorization>();
  private authorizationCaptureEpoch = 0;
  private authorizationWaitByPage = new WeakMap<Page, {
    engagementId: string;
    afterEpoch: number;
    promise: Promise<boolean>;
  }>();
  private authorizationRefreshByPage = new WeakMap<Page, Promise<ConnectorConnection>>();
  private port = 0;
  private readonly profileDir: string;
  private readonly statePath: string;
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
    }
  ) {
    this.connectorIdentity = connectorIdentity;
    this.dataRootPath = path.resolve(dataRoot);
    this.profileDir = path.join(dataRoot, 'connector', 'edge-profile');
    this.statePath = path.join(dataRoot, 'connector', 'browser-instance.json');
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
      ], { windowsHide: false, detached: false, stdio: 'ignore' });
      edgeProcess.once('error', () => { /* readiness check returns the user-visible failure */ });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !await this.cdpReady()) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!await this.cdpReady()) throw new Error('Edge 已启动，但 Connector 无法建立受控 CDP 会话。');
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
      await this.verifyBrowserIdentity(this.browser);
    }
    for (const context of this.browser.contexts()) {
      context.on('page', (page) => this.observePage(page));
      for (const page of context.pages()) this.observePage(page);
    }
    return this.browser;
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

  private async api(session: Session, route: string): Promise<unknown> {
    const url = new URL(route, session.apiOrigin);
    if (url.origin !== session.apiOrigin || !isAllowedOmniaUrl(url.href)) {
      throw new Error('Connector 拒绝了不在当前 Omnia origin 内的读取请求。');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { ...session.headers, Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000)
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

  private async identify(session: Session): Promise<{ name: string; clientName: string; authorityInstanceId: string; tenantOrOrgId: string; packId: string }> {
    const hierarchy = list(await this.api(session, `/engagements/v1/${session.engagementId}/headers/hierarchy`));
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
      const session: Session = { page, targetUrl, apiOrigin: auth.apiOrigin, engagementId, headers: auth.headers };
      if (!auth.headers.authorization) {
        return this.snapshot('waiting_authorization', '已打开目标 Pack，正在等待同一 target 的 Authorization。', session);
      }
      if (auth.identityMismatch || auth.engagementId !== engagementId) {
        return this.snapshot('identity_changed', 'Authorization 与当前 target 的 Pack 身份不一致，已拒绝连接。', session);
      }
      try {
        const pack = await this.identify(session);
        return this.snapshot('connected', `当前 Pack 已连接：${pack.name}`, session, pack);
      } catch (error) {
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

  async connect(): Promise<ConnectorConnection> {
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
    return this.status();
  }

  async refresh(): Promise<ConnectorConnection> {
    await this.ensureBrowser();
    const page = await this.currentPage(true);
    if (!page) return this.connect();
    const existing = this.authorizationRefreshByPage.get(page);
    if (existing) return existing;
    const refresh = (async () => {
      const targetUrl = normalizeOmniaUrl(page.url());
      const engagementId = parseEngagementId(targetUrl.href);
      if (!isGuid(engagementId)) return this.status();
      const previousAuth = this.authByPage.get(page);
      const reusableAuth = previousAuth?.headers.authorization
        && !previousAuth.identityMismatch
        && previousAuth.engagementId === engagementId
        && isAllowedOmniaUrl(previousAuth.apiOrigin)
        ? { ...previousAuth, headers: { ...previousAuth.headers } }
        : null;
      const beforeEpoch = Number(previousAuth?.captureEpoch || 0);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
      await this.waitForAuthorization(
        page,
        engagementId,
        beforeEpoch,
        AUTHORIZATION_REFRESH_WAIT_MS
      );
      const observedAfterWait = this.authByPage.get(page);
      const refreshed = Boolean(
        observedAfterWait?.headers.authorization
        && observedAfterWait.captureEpoch > beforeEpoch
        && !observedAfterWait.identityMismatch
        && observedAfterWait.engagementId === engagementId
      );
      if (!refreshed) {
        const current = this.authByPage.get(page);
        if (current && current.captureEpoch > beforeEpoch) return this.status();
        let currentTargetUrl: URL;
        try {
          if (!isAllowedOmniaUrl(page.url())) throw new Error('target origin changed');
          currentTargetUrl = normalizeOmniaUrl(page.url());
        } catch {
          return this.snapshot('identity_changed', '刷新后 Omnia target origin 已变化，已拒绝复用旧 Authorization。');
        }
        const currentEngagementId = parseEngagementId(currentTargetUrl.href);
        if (currentEngagementId !== engagementId) {
          return this.snapshot(
            'identity_changed',
            '刷新后 Omnia target 的 Pack 身份已变化，已拒绝复用旧 Authorization。',
            { page, targetUrl: currentTargetUrl, apiOrigin: currentTargetUrl.origin, engagementId: currentEngagementId, headers: {} }
          );
        }
        if (!reusableAuth) {
          return this.snapshot(
            'waiting_authorization',
            '目标 Pack 已刷新，但未在限定时间内捕获刷新后的 Omnia API Authorization。',
            { page, targetUrl: currentTargetUrl, apiOrigin: currentTargetUrl.origin, engagementId, headers: {} }
          );
        }
        const probeSession: Session = {
          page,
          targetUrl: currentTargetUrl,
          apiOrigin: reusableAuth.apiOrigin,
          engagementId,
          headers: reusableAuth.headers
        };
        let pack: { name: string; clientName: string; authorityInstanceId: string; tenantOrOrgId: string; packId: string };
        try {
          pack = await this.identify(probeSession);
        } catch (error) {
          const message = error instanceof Error ? error.message : '刷新后的旧授权只读校验失败。';
          if (error instanceof ConnectorOperationError && error.code === 'CONNECTOR.AUTH_REQUIRED') {
            return this.snapshot(
              'waiting_authorization',
              '刷新前 Authorization 已被 Omnia 拒绝，正在等待同一 target 的新 Authorization。',
              { ...probeSession, headers: {} }
            );
          }
          if (error instanceof ConnectorOperationError && error.code === 'CONNECTOR.PACK_IDENTITY_CHANGED') {
            return this.snapshot('identity_changed', message, probeSession);
          }
          return this.snapshot('identifying_pack', `刷新后的旧 Authorization 只读校验未成功：${message}`, probeSession);
        }
        const expectedAuthority = new URL(reusableAuth.apiOrigin).origin.toLowerCase();
        if (pack.packId !== engagementId || pack.authorityInstanceId !== expectedAuthority) {
          return this.snapshot(
            'identity_changed',
            '刷新后的 hierarchy authority 与原 target/Pack 不一致，已拒绝复用旧 Authorization。',
            probeSession
          );
        }
        if (!isAllowedOmniaUrl(page.url()) || parseEngagementId(page.url()) !== engagementId) {
          return this.snapshot('identity_changed', '只读校验期间 Omnia target 的 Pack 身份已变化，已拒绝复用旧 Authorization。');
        }
        const capturedDuringProbe = this.authByPage.get(page);
        if (capturedDuringProbe && capturedDuringProbe.captureEpoch > beforeEpoch) {
          return this.status();
        }
        this.authByPage.set(page, {
          ...reusableAuth,
          identityMismatch: false,
          capturedAt: Date.now(),
          captureEpoch: ++this.authorizationCaptureEpoch
        });
        return this.snapshot('connected', `当前 Pack 已连接：${pack.name}`, probeSession, pack);
      }
      return this.status();
    })();
    this.authorizationRefreshByPage.set(page, refresh);
    try {
      return await refresh;
    } finally {
      if (this.authorizationRefreshByPage.get(page) === refresh) {
        this.authorizationRefreshByPage.delete(page);
      }
    }
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

  registerOperation(input: OperationRegistrationRequest): unknown {
    return this.operationHost.register(input);
  }

  async invokeOperation(input: OperationInvocationRequest): Promise<unknown> {
    const session = await this.session(true);
    const pack = await this.identify(session);
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
        throw new ConnectorOperationError(
          response.status === 401 || response.status === 403 ? 'CONNECTOR.AUTH_REQUIRED' : 'CONNECTOR.OPERATION_FAILED',
          `Omnia Operation step returned HTTP ${response.status}.`,
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
