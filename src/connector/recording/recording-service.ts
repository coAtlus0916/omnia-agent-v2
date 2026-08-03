// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { isAllowedOmniaUrl, isGuid, parseEngagementId } from '../omnia-origin.js';

const FORMAT = 'omnia-v5-recorder/v1';
const CATALOG_FORMAT = 'omnia-v5-risk-control-catalog/v1';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENTS = 100_000;
const BODY_CONCURRENCY = 4;
const STOP_TIMEOUT_MS = 120_000;
const STOP_IDLE_MS = 1_500;
const SENSITIVE = /(?:token|authorization|cookie|secret|password|credential|api[_-]?key|session)/i;
const INTERACTION_SOURCE = `(() => {
  const marker = Symbol.for('omnia.agent.v5.recording.interactions');
  if (globalThis[marker]) return true;
  globalThis[marker] = true;
  const clean = (v, n = 256) => String(v == null ? '' : v).replace(/[\\u0000-\\u001f\\u007f]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, n);
  const selector = (node) => {
    const parts = [];
    let current = node instanceof Element ? node : null;
    for (let depth = 0; current && depth < 5; depth += 1) {
      let index = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === current.tagName) index += 1;
      parts.unshift(clean(current.tagName, 20).toLowerCase() + ':nth-of-type(' + index + ')');
      current = current.parentElement;
    }
    return clean(parts.join('>'), 320);
  };
  const emit = (action, event) => {
    try {
      const raw = event.target instanceof Element ? event.target : null;
      const element = raw && (raw.closest('button,a,input,select,textarea,[role="button"],[role="checkbox"],[role="radio"],[role="combobox"]') || raw);
      if (!element) return;
      const type = clean(element.getAttribute('type'), 30).toLowerCase();
      const name = clean(element.getAttribute('name') || element.id, 120);
      const sensitive = type === 'password' || /(?:token|auth|cookie|secret|password|session|credential|api[_-]?key)/i.test(name);
      globalThis.__omniaV5RecordingEvent(JSON.stringify({
        action, selector: selector(element), tag: clean(element.tagName, 20), type,
        role: clean(element.getAttribute('role'), 30), ariaLabel: sensitive ? '' : clean(element.getAttribute('aria-label'), 120),
        buttonLabel: sensitive ? '' : clean(element.innerText || element.textContent, 120),
        inputValue: sensitive || !['input','change'].includes(action) ? '' : clean(element.value, 512),
        sensitiveInput: sensitive, pageUrl: String(location.href || '')
      }));
    } catch { }
  };
  for (const name of ['click','change','input','submit']) document.addEventListener(name, (event) => emit(name, event), true);
  return true;
})()`;

function now() { return new Date().toISOString(); }
function clean(value, max = 500) { return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function rows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}
function id(value) { const result = clean(value, 200).toLowerCase(); return result === '00000000-0000-0000-0000-000000000000' ? '' : result; }
function atomicJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
function safeUrl(value) {
  try {
    if (!isAllowedOmniaUrl(value)) return '';
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE.test(key)) url.searchParams.set(key, '[redacted]');
    }
    url.hash = '';
    return url.toString().slice(0, 4096);
  } catch { return ''; }
}
function scrub(value, depth = 0) {
  if (depth > 24) return '[truncated-depth]';
  if (Array.isArray(value)) return value.slice(0, 5000).map((item) => scrub(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 2000).map(([key, item]) => [
    clean(key, 120), SENSITIVE.test(key) ? '[redacted]' : scrub(item, depth + 1)
  ]));
  if (typeof value === 'string') return clean(value, 4096);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return clean(value, 500);
}
function endpoint(urlText) {
  try {
    const pathname = new URL(urlText).pathname.toLowerCase();
    if (/\/plannedresponse\/byriskassessmentid$/.test(pathname)) return 'risk-list';
    if (/\/controls\/byriskassessmentid\//.test(pathname)) return 'control-list';
    if (/getplanresponsedetailbyriskriskscopeid$/.test(pathname)) return 'risk-scope-detail';
    if (/\/riskassessments\/[0-9a-f-]{36}$/.test(pathname)) return 'gra-detail';
    if (/\/controls\/[0-9a-f-]{36}$/.test(pathname)) return 'control-detail';
    if (/\/itelement\/[0-9a-f-]{36}$/.test(pathname)) return 'it-element-detail';
    if (/\/itelement\/(?:associate|disassociate|unassociate)$/.test(pathname)) return 'it-element-association';
    if (/\/controls\/[^/]+\/controlrisks\/(?:associate|disassociate|unassociate)$/.test(pathname)) return 'risk-control-association';
    return '';
  } catch { return ''; }
}
function parseBody(text) {
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { omitted: text ? 'body-too-large' : 'body-empty' };
  try { return { json: scrub(JSON.parse(text)) }; } catch { return { omitted: 'body-not-json' }; }
}

export function observedRiskAssessmentId(urlText) {
  try {
    const url = new URL(urlText);
    const pathname = url.pathname.toLowerCase();
    let candidate = '';
    if (pathname.endsWith('/plannedresponse/byriskassessmentid')) candidate = url.searchParams.get('riskAssessmentId') || '';
    else candidate = pathname.match(/\/controls\/byriskassessmentid\/([0-9a-f-]{36})$/)?.[1] || '';
    return isGuid(candidate) ? candidate.toLowerCase() : '';
  } catch { return ''; }
}

export class RecordingService {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir, 'evidence', 'recordings');
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.active = null;
    this.lastRecordingId = '';
    this.sessions = new Map();
  }

  status() {
    const active = this.active;
    if (!active) return { schemaVersion: 'omnia.v5.recording-status/v1', state: 'idle', active: false, recordingId: this.lastRecordingId, message: '当前没有正在进行的录制。' };
    return this.publicStatus(active);
  }

  async start({ page, engagementId, sessionGeneration }) {
    if (this.active) return { ...this.publicStatus(this.active), alreadyActive: true };
    if (!page || page.isClosed()) throw codeError('RECORDING.PAGE_REQUIRED', '请先在受控 Edge 中打开目标 Omnia Pack。');
    if (!isGuid(engagementId) || parseEngagementId(page.url()) !== engagementId) throw codeError('RECORDING.PACK_MISMATCH', '当前页面与 Connector 绑定的 Pack 不一致。');
    const recordingId = crypto.randomUUID();
    const directory = path.join(this.rootDir, recordingId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const active = {
      recordingId, engagementId, sessionGeneration, directory, startedAt: now(), updatedAt: now(), state: 'recording',
      events: 0, droppedEvents: 0, interactionCount: 0, networkRequestCount: 0, mutationRequestCount: 0,
      requests: new Map(), pendingBodies: new Set(), bodyQueue: [], bodyRunning: 0, criticalPending: new Set(),
      integrity: { complete: true, bodyCapture: { scheduled: 0, captured: 0, omitted: 0 }, critical: { expected: 0, captured: 0, missing: [], endpoints: {} } },
      lastCriticalAt: Date.now(), spool: path.join(directory, 'events.jsonl'), sessions: new Map(), contextListeners: new Map()
    };
    fs.writeFileSync(active.spool, '', { flag: 'wx', mode: 0o600 });
    this.active = active;
    this.lastRecordingId = recordingId;
    const context = page.context();
    const onPage = (candidate) => { void this.attachPage(candidate); };
    context.on('page', onPage);
    active.contextListeners.set(context, onPage);
    for (const candidate of context.pages()) if (parseEngagementId(candidate.url()) === engagementId) await this.attachPage(candidate);
    if (!active.sessions.size) { this.active = null; throw codeError('RECORDING.CDP_ATTACH_FAILED', '无法为当前 Omnia 页面建立 CDP 录制会话。'); }
    this.persistManifest(active);
    return this.publicStatus(active);
  }

  async attachPage(page) {
    const active = this.active;
    if (!active || page.isClosed() || active.sessions.has(page)) return;
    if (parseEngagementId(page.url()) !== active.engagementId) return;
    const cdp = await page.context().newCDPSession(page);
    const sessionId = crypto.randomUUID();
    const details = { cdp, sessionId, page, requestIds: new Map() };
    active.sessions.set(page, details);
    const forward = (method) => cdp.on(method, (params) => this.handle(method, params, details));
    for (const method of [
      'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed',
      'Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.domContentEventFired', 'Page.loadEventFired', 'Page.windowOpen',
      'Runtime.exceptionThrown', 'Runtime.bindingCalled'
    ]) forward(method);
    await cdp.send('Network.enable', { maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 32 * 1024 * 1024, maxPostDataSize: 5 * 1024 * 1024 });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: '__omniaV5RecordingEvent' }).catch(() => undefined);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INTERACTION_SOURCE }).catch(() => undefined);
    await cdp.send('Runtime.evaluate', { expression: INTERACTION_SOURCE }).catch(() => undefined);
    this.event(active, { type: 'page.attached', page: sessionId, url: safeUrl(page.url()) });
    page.once('close', () => { active.sessions.delete(page); void cdp.detach().catch(() => undefined); });
  }

  handle(method, params, details) {
    const active = this.active;
    if (!active || active.state !== 'recording') return;
    const pageUrl = safeUrl(details.page.url());
    if (parseEngagementId(pageUrl) !== active.engagementId) return;
    if (method === 'Runtime.bindingCalled') {
      if (params.name !== '__omniaV5RecordingEvent') return;
      let payload; try { payload = JSON.parse(params.payload); } catch { return; }
      active.interactionCount += 1;
      this.event(active, { type: 'interaction', page: details.sessionId, pageUrl, ...scrub(payload) });
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      this.event(active, { type: 'runtime.exception', page: details.sessionId, pageUrl, text: clean(params.exceptionDetails?.text, 300), scriptUrl: safeUrl(params.exceptionDetails?.url || '') });
      return;
    }
    if (method.startsWith('Page.')) {
      const url = safeUrl(params.frame?.url || params.url || pageUrl);
      this.event(active, { type: 'page.event', event: method.slice(5), page: details.sessionId, pageUrl: url, topLevel: !params.frame?.parentId });
      return;
    }
    const requestKey = `${details.sessionId}:${params.requestId || ''}`;
    if (method === 'Network.requestWillBeSent') {
      const url = safeUrl(params.request?.url || '');
      if (!url) return;
      const businessEndpoint = endpoint(url);
      const request = {
        id: `request-${++active.networkRequestCount}`, session: details, cdpRequestId: params.requestId,
        url, method: clean(params.request?.method, 16).toUpperCase(), businessEndpoint,
        responseBodyRequired: Boolean(businessEndpoint && !businessEndpoint.endsWith('association')),
        status: 0, mimeType: ''
      };
      active.requests.set(requestKey, request);
      if (businessEndpoint) { active.criticalPending.add(requestKey); active.lastCriticalAt = Date.now(); }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) active.mutationRequestCount += 1;
      this.event(active, { type: 'network.request', page: details.sessionId, request: request.id, method: request.method, url, businessEndpoint, requestBody: parseBody(params.request?.postData || '') });
      return;
    }
    const request = active.requests.get(requestKey);
    if (!request) return;
    if (method === 'Network.responseReceived') {
      request.status = Number(params.response?.status || 0);
      request.mimeType = clean(params.response?.mimeType, 120);
      this.event(active, { type: 'network.response', page: details.sessionId, request: request.id, url: request.url, status: request.status, mimeType: request.mimeType, businessEndpoint: request.businessEndpoint });
      return;
    }
    active.requests.delete(requestKey);
    active.criticalPending.delete(requestKey);
    if (request.businessEndpoint) active.lastCriticalAt = Date.now();
    if (method === 'Network.loadingFailed') {
      this.missing(active, request, 'network-loading-failed');
      this.event(active, { type: 'network.failed', request: request.id, url: request.url, errorText: clean(params.errorText, 200), businessEndpoint: request.businessEndpoint });
      return;
    }
    this.event(active, { type: 'network.complete', request: request.id, url: request.url, encodedDataLength: Number(params.encodedDataLength || 0), businessEndpoint: request.businessEndpoint });
    if (['HEAD', 'OPTIONS'].includes(request.method) || request.status === 204 || request.status === 205) return;
    if (request.businessEndpoint || /json|\+json/i.test(request.mimeType)) this.queueBody(active, request);
  }

  queueBody(active, request) {
    active.integrity.bodyCapture.scheduled += 1;
    if (request.responseBodyRequired) {
      active.integrity.critical.expected += 1;
      const stats = active.integrity.critical.endpoints[request.businessEndpoint] ||= { expected: 0, captured: 0, missing: 0 };
      stats.expected += 1;
    }
    active.bodyQueue.push(request);
    this.pumpBodies(active);
  }

  pumpBodies(active) {
    while (active.bodyRunning < BODY_CONCURRENCY && active.bodyQueue.length) {
      const request = active.bodyQueue.shift();
      active.bodyRunning += 1;
      const task = request.session.cdp.send('Network.getResponseBody', { requestId: request.cdpRequestId }).then((result) => {
        const body = parseBody(result?.base64Encoded ? Buffer.from(result.body || '', 'base64').toString('utf8') : result?.body || '');
        const captured = body.json !== undefined;
        if (captured) {
          active.integrity.bodyCapture.captured += 1;
          if (request.responseBodyRequired) {
            active.integrity.critical.captured += 1;
            active.integrity.critical.endpoints[request.businessEndpoint].captured += 1;
          }
        } else {
          active.integrity.bodyCapture.omitted += 1;
          this.missing(active, request, body.omitted || 'response-body-unavailable');
        }
        this.event(active, { type: 'network.response-body', request: request.id, url: request.url, businessEndpoint: request.businessEndpoint, ...body });
      }).catch((error) => {
        active.integrity.bodyCapture.omitted += 1;
        this.missing(active, request, 'get-response-body-failed');
        this.event(active, { type: 'network.response-body-omitted', request: request.id, url: request.url, businessEndpoint: request.businessEndpoint, reason: 'get-response-body-failed', diagnostic: clean(error?.message, 200) });
      }).finally(() => {
        active.pendingBodies.delete(task);
        active.bodyRunning -= 1;
        this.pumpBodies(active);
      });
      active.pendingBodies.add(task);
    }
  }

  missing(active, request, reason) {
    if (!request?.responseBodyRequired) return;
    active.integrity.complete = false;
    const stats = active.integrity.critical.endpoints[request.businessEndpoint] ||= { expected: 0, captured: 0, missing: 0 };
    stats.missing += 1;
    active.integrity.critical.missing.push({ endpoint: request.businessEndpoint, request: request.id, reason });
  }

  event(active, value) {
    if (active.state !== 'recording') return;
    if (active.events >= MAX_EVENTS) { active.droppedEvents += 1; active.integrity.complete = false; return; }
    active.events += 1;
    active.updatedAt = now();
    fs.appendFileSync(active.spool, `${JSON.stringify({ sequence: active.events, occurredAt: active.updatedAt, ...value })}\n`, { encoding: 'utf8' });
  }

  async stopExport(recordingId = '') {
    const active = this.requireActive(recordingId);
    const started = Date.now();
    while (Date.now() - started < STOP_TIMEOUT_MS) {
      if (!active.criticalPending.size && !active.bodyQueue.length && !active.pendingBodies.size && Date.now() - active.lastCriticalAt >= STOP_IDLE_MS) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (active.criticalPending.size || active.bodyQueue.length || active.pendingBodies.size) {
      active.integrity.complete = false;
      for (const key of active.criticalPending) this.missing(active, active.requests.get(key), 'stop-drain-timeout');
    }
    return this.finish(active, 'stopped', true);
  }

  async cancel(recordingId = '') {
    const active = this.requireActive(recordingId);
    return this.finish(active, 'cancelled', false);
  }

  requireActive(recordingId) {
    const active = this.active;
    if (!active) throw codeError('RECORDING.NOT_ACTIVE', '当前没有正在进行的录制。');
    if (recordingId && recordingId !== active.recordingId) throw codeError('RECORDING.IDENTITY_CHANGED', '录制 ID 已变化，已拒绝旧操作。');
    return active;
  }

  async finish(active, state, exportRecording) {
    active.state = state;
    active.updatedAt = now();
    for (const [context, listener] of active.contextListeners) context.off('page', listener);
    await Promise.allSettled([...active.sessions.values()].map((item) => item.cdp.detach()));
    active.sessions.clear();
    this.persistManifest(active);
    let exportPath = '';
    if (exportRecording) {
      const events = (await fsp.readFile(active.spool, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      exportPath = path.join(active.directory, 'recording.json');
      atomicJson(exportPath, {
        format: FORMAT, source: 'edge-cdp', recordingId: active.recordingId, engagementId: active.engagementId,
        createdAt: active.startedAt, exportedAt: now(), state: active.integrity.complete ? 'complete' : 'incomplete',
        integrity: active.integrity,
        security: { credentialsRecorded: false, requestHeadersRecorded: false, responseHeadersRecorded: false, responseBodiesRecorded: true, inputValuesRecorded: true, excluded: ['Cookie', 'Authorization', 'credential input values'] },
        totalEvents: active.events, droppedEvents: active.droppedEvents, events
      });
    }
    this.active = null;
    return { ...this.publicStatus(active), exportPath };
  }

  persistManifest(active) {
    atomicJson(path.join(active.directory, 'manifest.json'), this.publicStatus(active));
  }

  publicStatus(active) {
    return {
      schemaVersion: 'omnia.v5.recording-status/v1', state: active.state, active: active.state === 'recording',
      recordingId: active.recordingId, engagementId: active.engagementId, sessionGeneration: active.sessionGeneration,
      startedAt: active.startedAt, updatedAt: active.updatedAt, eventCount: active.events, interactionCount: active.interactionCount,
      networkRequestCount: active.networkRequestCount, mutationRequestCount: active.mutationRequestCount,
      droppedEventCount: active.droppedEvents, integrity: active.integrity,
      message: active.state === 'recording' ? '正在录制当前 Pack 的真实浏览器交互与网络证据。' : active.state === 'cancelled' ? '录制已取消，未生成导出文件。' : '录制已停止。'
    };
  }
}

export async function captureCurrentGraCatalog({ fetchImpl = fetch, apiOrigin, headers, engagementId, riskAssessmentId, pack, outputRoot, observedAt = now() }) {
  if (!isAllowedOmniaUrl(apiOrigin) || !isGuid(engagementId) || !isGuid(riskAssessmentId)) throw codeError('CATALOG.CONTEXT_BLOCKED', '请先打开目标 GRA，并等待其 Risk/Control 请求完成后重试。');
  const evidence = [];
  const get = async (key, route, required = true) => {
    const url = new URL(route, apiOrigin);
    const item = { key, method: 'GET', url: safeUrl(url.href), required, startedAt: now(), completedAt: '', ok: false, status: 0, error: '' };
    evidence.push(item);
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: { ...headers, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      item.status = response.status;
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      item.ok = true; item.completedAt = now(); item.responseCaptured = true; item.response = scrub(payload);
      return payload;
    } catch (error) { item.completedAt = now(); item.error = clean(error?.message || error, 300); throw error; }
  };
  const graRoute = `/rapr/v0/engagements/${engagementId}/riskassessments/${riskAssessmentId}`;
  const risksRoute = `/rapr/v0/engagements/${engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId=${encodeURIComponent(riskAssessmentId)}&reviewMode=false`;
  const controlsRoute = `/rapr/v0/engagements/${engagementId}/controls/byRiskAssessmentId/${riskAssessmentId}?includeContentDeleted=false`;
  let gra = null, riskRows = [], controlRows = [], itElement = null;
  const missingReasons = [];
  try { gra = await get('gra-detail', graRoute); } catch (error) { missingReasons.push(`gra-detail: ${clean(error?.message)}`); }
  try { riskRows = rows(await get('risk-list', risksRoute)); } catch (error) { missingReasons.push(`risk-list: ${clean(error?.message)}`); }
  try { controlRows = rows(await get('control-list', controlsRoute)); } catch (error) { missingReasons.push(`control-list: ${clean(error?.message)}`); }
  const itElementId = findItElementId(gra);
  if (itElementId) {
    try { itElement = await get('it-element-detail', `/rapr/v0/engagements/${engagementId}/itelement/${itElementId}`); }
    catch (error) { missingReasons.push(`it-element-detail: ${clean(error?.message)}`); }
  } else missingReasons.push('it-element-detail: GRA response did not expose a unique IT Element ID');
  const risks = [];
  for (const raw of riskRows) {
    const risk = summarizeRisk(raw, risksRoute);
    if (!risk.id || !risk.riskNumber) missingReasons.push('risk-list: a Risk is missing immutable ID or riskNumber');
    const lookupId = riskRiskScopeLookupId(raw);
    if (!lookupId) { missingReasons.push(`risk-scope-detail: Risk ${risk.riskNumber || risk.id || '(unknown)'} has no riskRiskScopeId`); risks.push(risk); continue; }
    const route = `/rapr/v0/engagements/${engagementId}/plannedresponse/GetPlanResponseDetailByRiskRiskScopeId?riskriskScopeId=${encodeURIComponent(lookupId)}&reviewMode=false&controlExpanded=false&procedureExpanded=false`;
    try {
      const detail = await get(`risk-scope-detail:${risk.id}`, route);
      const detailed = rows(detail?.planResponseRisk).find((item) => id(item?.id) === risk.id) || raw;
      risks.push({ ...summarizeRisk(detailed, route), directorySourceEndpoint: risksRoute, detailSourceEndpoint: route });
    } catch (error) { missingReasons.push(`risk-scope-detail:${risk.id}: ${clean(error?.message)}`); risks.push(risk); }
  }
  const controls = [];
  for (const raw of controlRows) {
    const controlId = id(raw?.id || raw?.controlId);
    if (!isGuid(controlId)) { missingReasons.push('control-list: a Control is missing immutable ID'); controls.push(summarizeControl(raw, controlsRoute)); continue; }
    const route = `/rapr/v0/engagements/${engagementId}/controls/${controlId}?includeContentDeleted=false`;
    try { controls.push({ ...summarizeControl(await get(`control-detail:${controlId}`, route), route), directorySourceEndpoint: controlsRoute, detailSourceEndpoint: route }); }
    catch (error) { missingReasons.push(`control-detail:${controlId}: ${clean(error?.message)}`); controls.push(summarizeControl(raw, controlsRoute)); }
  }
  const capturedRait = normalizeRait(gra, risks);
  if (!capturedRait) missingReasons.push('rait: live GRA/risk responses did not provide Higher or Lower');
  const graContent = clean(gra?.graContentName || gra?.contentName || gra?.riskAssessmentContentName);
  const elementType = clean(itElement?.elementType || itElement?.itElementType || itElement?.type || gra?.type);
  const workspaceId = id(gra?.workspaceId || gra?.workspaceFacetId);
  if (!workspaceId) missingReasons.push('identity: GRA response did not provide a stable Workspace ID');
  if (!clean(gra?.name || gra?.displayName)) missingReasons.push('identity: GRA response did not provide a stable name');
  if (!graContent) missingReasons.push('identity: GRA response did not provide GRA content');
  if (!elementType) missingReasons.push('identity: IT Element/GRA response did not provide element type');
  for (const risk of risks) {
    if (!risk.riskScopes.some((scope) => scope.riskScopeId || scope.riskRiskScopeId)) {
      missingReasons.push(`risk-scope-detail:${risk.id || risk.riskNumber}: no stable riskScope/riskRiskScope identity was returned`);
    }
  }
  const relations = controls.flatMap((control) => control.riskScopes.filter((scope) => scope.enabled).map((scope) => ({
    relationType: 'observed_control_risk_scope', riskAssessmentId, riskId: scope.riskId, controlId: control.id,
    riskScopeId: scope.riskScopeId, assertions: scope.assertions, observed: true, sourceEndpoint: control.detailSourceEndpoint || control.sourceEndpoint,
    catalogPresenceDoesNotImplyTemplateLink: true
  })));
  const complete = missingReasons.length === 0 && evidence.filter((item) => item.required).every((item) => item.ok && item.responseCaptured);
  const catalog = {
    schemaVersion: CATALOG_FORMAT, capturedAt: observedAt, status: complete ? 'complete' : 'incomplete', readOnly: true,
    identity: {
      engagement: { id: engagementId, name: clean(pack?.name), clientName: clean(pack?.clientName) },
      pack: { id: engagementId, name: clean(pack?.name) },
      workspace: { id: workspaceId, name: clean(gra?.workspaceName) },
      gra: { id: riskAssessmentId, workItemId: id(gra?.workItemId), name: clean(gra?.name || gra?.displayName), referenceNumber: clean(gra?.referenceNumber), content: graContent },
      itElement: { id: itElementId, workItemId: id(itElement?.workItemId || itElement?.applicationWorkItemId || itElement?.itToolWorkItemId), number: clean(itElement?.number || itElement?.referenceNumber), name: clean(itElement?.name || itElement?.displayName), elementType, subtype: clean(itElement?.subtype || itElement?.infrastructureType || itElement?.databaseType || itElement?.category) },
      capturedRait
    },
    applicability: { capturedRait, inferredOtherRait: false, linkRequired: null, note: '目录存在与母版关联要求是两个事实；未对未录制的 RAIT 作推断。' },
    risks, controls, observedRelations: relations,
    completeness: {
      status: complete ? 'complete' : 'incomplete', requiredReadsComplete: complete,
      riskCount: risks.length, controlCount: controls.length,
      riskDetailCovered: risks.filter((item) => item.detailSourceEndpoint).length,
      controlDetailCovered: controls.filter((item) => item.detailSourceEndpoint).length,
      missingReasons, endpoints: evidence.map(({ response, ...item }) => item), capturedAt: observedAt
    },
    evidence
  };
  const directory = path.join(outputRoot, 'evidence', 'recordings', `catalog-${riskAssessmentId}-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const catalogPath = path.join(directory, 'risk-control-catalog.json');
  const manifestPath = path.join(directory, 'manifest.json');
  atomicJson(catalogPath, catalog);
  atomicJson(manifestPath, { schemaVersion: 'omnia.v5.recording-catalog-manifest/v1', catalogPath, status: catalog.status, completeness: catalog.completeness, createdAt: now() });
  return { schemaVersion: 'omnia.v5.recording-catalog-result/v1', status: catalog.status, catalogPath, manifestPath, catalog };
}

function findItElementId(gra) {
  return id(gra?.itElementId || gra?.entityId || gra?.applicationId || gra?.infrastructureId || gra?.toolId || rows(gra?.riskScopes).find((scope) => scope?.entityId)?.entityId);
}
function riskRiskScopeLookupId(risk) { return id(risk?.riskRiskScopeId || risk?.riskScopeId || risk?.riskRiskScope?.id || rows(risk?.riskScopes)[0]?.riskRiskScopeId || rows(risk?.riskScopes)[0]?.id); }
function assertions(value) { return [...new Set(rows(value).flatMap((item) => typeof item === 'string' ? [clean(item, 80)] : [clean(item?.assertion || item?.assertionType || item?.code, 80)]).filter(Boolean))].sort(); }
export function summarizeRisk(raw, sourceEndpoint = '') {
  const scopes = rows(raw?.riskScopes || raw?.riskRiskScopes || raw?.scopes).map((scope) => ({
    riskScopeId: id(scope?.riskScopeId || scope?.riskRiskScopeId || scope?.id),
    riskRiskScopeId: id(scope?.riskRiskScopeId || scope?.id), assertionType: clean(scope?.assertionType), assertions: assertions(scope?.assertions || scope?.assertionTypes), enabled: scope?.enabled !== false
  }));
  if (!scopes.length) {
    const scopeId = riskRiskScopeLookupId(raw);
    if (scopeId) scopes.push({ riskScopeId: id(raw?.riskScopeId), riskRiskScopeId: scopeId, assertionType: clean(raw?.assertionType), assertions: assertions(raw?.assertions), enabled: true });
  }
  return { id: id(raw?.id || raw?.riskId), riskNumber: clean(raw?.riskNumber || raw?.inkRiskNumber || raw?.number), description: clean(raw?.description || raw?.riskDescription || raw?.name, 4000), classificationType: clean(raw?.classificationType || raw?.riskClassificationType || raw?.raitConclusionLevel), riskScopes: scopes, sourceEndpoint };
}
export function summarizeControl(raw, sourceEndpoint = '') {
  const scopes = rows(raw?.currentRiskScopes || raw?.riskScopes || raw?.controlRiskScopes).map((scope) => ({
    riskId: id(scope?.riskId || scope?.plannedResponseRiskId), riskScopeId: id(scope?.riskScopeId || scope?.riskRiskScopeId),
    assertions: assertions(scope?.assertions || scope?.assertionTypes), enabled: scope?.enabled !== false && scope?.isDeleted !== true
  }));
  return { id: id(raw?.id || raw?.controlId), controlNumber: clean(raw?.controlNumber || raw?.number), name: clean(raw?.name || raw?.controlName, 2000), description: clean(raw?.description || raw?.controlDescription, 4000), assertionInformation: assertions(raw?.assertions || raw?.assertionTypes), riskScopes: scopes, sourceEndpoint };
}
function normalizeRait(gra, risks) {
  const values = [gra?.itElementRaitConclusionLevelName, gra?.itElementRaitConclusionLevel, gra?.raitConclusionLevel, gra?.classificationType, ...risks.map((risk) => risk.classificationType)].map((value) => clean(value).toLowerCase());
  if (values.some((value) => value === 'higher' || /\bhigher\b/.test(value))) return 'Higher';
  if (values.some((value) => value === 'lower' || /\blower\b/.test(value))) return 'Lower';
  return '';
}
export function mergeRiskControlCatalogs(catalogs) {
  const byNumber = (values, field) => {
    const merged = new Map();
    for (const value of values) {
      const key = clean(value?.[field]).toLocaleLowerCase('en-US');
      if (!key) continue;
      const previous = merged.get(key);
      const capturedRaits = [...new Set([...(previous?.capturedRaits || []), value.capturedRait].filter((rait) => rait === 'Higher' || rait === 'Lower'))].sort();
      merged.set(key, { ...(previous || {}), ...value, capturedRaits, linkRequired: null });
    }
    return [...merged.values()];
  };
  return {
    schemaVersion: 'omnia.v5.risk-control-catalog-merge/v1',
    risks: byNumber(catalogs.flatMap((catalog) => catalog.risks.map((item) => ({ ...item, capturedRait: catalog.identity?.capturedRait }))), 'riskNumber'),
    controls: byNumber(catalogs.flatMap((catalog) => catalog.controls.map((item) => ({ ...item, capturedRait: catalog.identity?.capturedRait }))), 'controlNumber'),
    observedRelations: catalogs.flatMap((catalog) => catalog.observedRelations || []),
    note: 'Higher/Lower 仅按真实 capturedRait 合并；不会推断另一等级适用或 link_required。'
  };
}
function codeError(code, message) { const error = new Error(message); error.code = code; return error; }
