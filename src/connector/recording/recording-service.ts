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
const EXPORT_CHUNK_BYTES = 512 * 1024;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
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

  status(recordingId = '') {
    const active = this.active;
    if (active && (!recordingId || active.recordingId === recordingId)) return this.publicStatus(active);
    const requestedId = recordingId || this.lastRecordingId || this.latestRecordingId();
    if (!requestedId) return this.idleStatus();
    try { return this.readManifest(requestedId); } catch { return this.idleStatus(); }
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
      elapsedMs: 0, runningSince: Date.now(), pauseCount: 0, exportedAt: '',
      requests: new Map(), pendingBodies: new Set(), bodyQueue: [], bodyRunning: 0, criticalPending: new Set(),
      integrity: { complete: true, bodyCapture: { scheduled: 0, captured: 0, omitted: 0 }, critical: { expected: 0, captured: 0, missing: [], endpoints: {} } },
      catalogs: [], catalogFailures: [], lastCriticalAt: Date.now(), spool: path.join(directory, 'events.jsonl'), sessions: new Map(), contextListeners: new Map()
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
    this.event(active, { type: 'recording.started', recordingId, engagementId });
    this.persistManifest(active);
    return this.publicStatus(active);
  }

  async attachPage(page) {
    const active = this.active;
    if (!active || active.state !== 'recording' || page.isClosed() || active.sessions.has(page)) return;
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

  async drain(active, reason) {
    if (active.state !== 'recording') return;
    const started = Date.now();
    while (Date.now() - started < STOP_TIMEOUT_MS) {
      if (!active.criticalPending.size && !active.bodyQueue.length && !active.pendingBodies.size && Date.now() - active.lastCriticalAt >= STOP_IDLE_MS) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (active.criticalPending.size || active.bodyQueue.length || active.pendingBodies.size) {
      active.integrity.complete = false;
      for (const key of active.criticalPending) this.missing(active, active.requests.get(key), `${reason}-drain-timeout`);
    }
    this.event(active, { type: 'recording.drain-completed', reason, waitMs: Date.now() - started });
  }

  async detach(active, removeContextListeners) {
    if (removeContextListeners) {
      for (const [context, listener] of active.contextListeners) context.off('page', listener);
      active.contextListeners.clear();
    }
    await Promise.allSettled([...active.sessions.values()].map((item) => item.cdp.detach()));
    active.sessions.clear();
  }

  async pause(recordingId = '') {
    const active = this.requireActive(recordingId, ['recording']);
    await this.drain(active, 'pause');
    this.event(active, { type: 'recording.paused' });
    active.elapsedMs += Math.max(0, Date.now() - active.runningSince);
    active.runningSince = 0;
    active.pauseCount += 1;
    active.state = 'paused';
    active.updatedAt = now();
    await this.detach(active, false);
    this.persistManifest(active);
    return this.publicStatus(active);
  }

  async resume({ page, engagementId, sessionGeneration }, recordingId = '') {
    let active = this.active;
    if (!active) active = this.restorePaused(recordingId, engagementId, sessionGeneration);
    if (active.recordingId !== recordingId || active.state !== 'paused') throw codeError('RECORDING.NOT_PAUSED', '该录制当前不处于暂停状态。');
    if (!page || page.isClosed() || engagementId !== active.engagementId || sessionGeneration !== active.sessionGeneration || parseEngagementId(page.url()) !== engagementId) {
      throw codeError('RECORDING.BINDING_CHANGED', '当前页面、会话世代或 Pack 与暂停录制不一致。');
    }
    active.state = 'recording';
    active.runningSince = Date.now();
    active.lastCriticalAt = Date.now();
    const context = page.context();
    if (!active.contextListeners.has(context)) {
      const onPage = (candidate) => { void this.attachPage(candidate); };
      context.on('page', onPage);
      active.contextListeners.set(context, onPage);
    }
    for (const candidate of context.pages()) if (parseEngagementId(candidate.url()) === engagementId) await this.attachPage(candidate);
    if (!active.sessions.size) {
      active.state = 'paused'; active.runningSince = 0;
      throw codeError('RECORDING.CDP_ATTACH_FAILED', '无法恢复当前 Omnia 页面的 CDP 录制会话。');
    }
    this.event(active, { type: 'recording.resumed', pauseCount: active.pauseCount });
    this.persistManifest(active);
    return this.publicStatus(active);
  }

  async stop(recordingId = '') {
    let active = this.active;
    if (!active) {
      const manifest = this.readManifest(recordingId);
      if (!['recording', 'paused'].includes(manifest.state)) return { ...manifest, alreadyStopped: true };
      manifest.state = 'stopped';
      manifest.active = false;
      manifest.integrity = manifest.integrity || {};
      manifest.integrity.complete = false;
      manifest.integrity.critical ||= { expected: 0, captured: 0, missing: [], endpoints: {} };
      manifest.integrity.critical.missing ||= [];
      manifest.integrity.critical.missing.push({ endpoint: 'recording-session', request: '', reason: 'connector-restart-interrupted' });
      manifest.updatedAt = now();
      manifest.exportAvailable = true;
      manifest.message = 'Connector 重启中断了原录制；已按不完整录制停止，可导出诊断记录。';
      atomicJson(path.join(this.recordingDirectory(recordingId), 'manifest.json'), manifest);
      return manifest;
    }
    active = this.requireActive(recordingId, ['recording', 'paused']);
    if (active.state === 'recording') {
      await this.drain(active, 'stop');
      this.event(active, { type: 'recording.stopped' });
      active.elapsedMs += Math.max(0, Date.now() - active.runningSince);
      active.runningSince = 0;
    }
    active.state = 'stopped';
    active.updatedAt = now();
    await this.detach(active, true);
    this.persistManifest(active);
    this.active = null;
    return this.publicStatus(active);
  }

  async stopExport(recordingId = '') {
    const stopped = await this.stop(recordingId);
    const exported = await this.exportRecording(stopped.recordingId);
    return { ...stopped, ...exported, exportPath: path.join(this.recordingDirectory(stopped.recordingId), 'recording.json') };
  }

  async cancel(recordingId = '') {
    const active = this.requireActive(recordingId, ['recording', 'paused']);
    if (active.state === 'recording') {
      active.elapsedMs += Math.max(0, Date.now() - active.runningSince);
      active.runningSince = 0;
    }
    active.state = 'cancelled';
    active.updatedAt = now();
    await this.detach(active, true);
    this.persistManifest(active);
    this.active = null;
    return this.publicStatus(active);
  }

  requireActive(recordingId, states = ['recording']) {
    const active = this.active;
    if (!active) throw codeError('RECORDING.NOT_ACTIVE', '当前没有正在进行的录制。');
    if (recordingId && recordingId !== active.recordingId) throw codeError('RECORDING.IDENTITY_CHANGED', '录制 ID 已变化，已拒绝旧操作。');
    if (!states.includes(active.state)) throw codeError('RECORDING.STATE_CHANGED', `录制当前状态为 ${active.state}，已拒绝该操作。`);
    return active;
  }

  async exportRecording(recordingId = '') {
    if (this.active?.recordingId === recordingId) throw codeError('RECORDING.STOP_REQUIRED', '请先停止录制，再导出录制记录。');
    const manifest = this.readManifest(recordingId);
    if (manifest.state !== 'stopped') throw codeError('RECORDING.STOP_REQUIRED', '只有已经停止的录制可以导出。');
    const directory = this.recordingDirectory(recordingId);
    const spool = path.join(directory, 'events.jsonl');
    const events = (await fsp.readFile(spool, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const catalogs = (manifest.catalogs || []).map((catalog) => {
      const filename = path.basename(String(catalog.file || ''));
      if (!filename || filename !== catalog.file) return { metadata: catalog, catalog: null };
      try { return { metadata: catalog, catalog: JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')) }; }
      catch { return { metadata: catalog, catalog: null }; }
    });
    const exportPath = path.join(directory, 'recording.json');
    const preparedAt = now();
    atomicJson(exportPath, {
      format: FORMAT, source: 'edge-cdp', recordingId: manifest.recordingId, engagementId: manifest.engagementId,
      createdAt: manifest.startedAt, exportedAt: preparedAt, state: manifest.integrity?.complete ? 'complete' : 'incomplete',
      elapsedMs: manifest.elapsedMs, pauseCount: manifest.pauseCount, integrity: manifest.integrity, catalogs,
      security: { credentialsRecorded: false, requestHeadersRecorded: false, responseHeadersRecorded: false, responseBodiesRecorded: true, inputValuesRecorded: true, excluded: ['Cookie', 'Authorization', 'credential input values'] },
      totalEvents: manifest.eventCount, droppedEvents: manifest.droppedEventCount, events
    });
    const stat = fs.statSync(exportPath);
    if (stat.size < 1 || stat.size > MAX_EXPORT_BYTES) {
      fs.rmSync(exportPath, { force: true });
      throw codeError('RECORDING.EXPORT_SIZE_UNSUPPORTED', `录制记录为 ${stat.size} bytes，超过当前 Artifact Store 的 64 MiB 单文件上限；未截断、未伪装为成功。`);
    }
    const nextManifest = { ...manifest, exportPreparedAt: preparedAt, updatedAt: preparedAt, exportAvailable: true };
    atomicJson(path.join(directory, 'manifest.json'), nextManifest);
    const chunkCount = Math.ceil(stat.size / EXPORT_CHUNK_BYTES);
    return {
      ...nextManifest,
      transfer: {
        schemaVersion: 'omnia.v5.recording-export-transfer/v1', recordingId, fileName: `omnia-recording-${recordingId}.json`,
        mediaType: 'application/json', sizeBytes: stat.size, chunkSizeBytes: EXPORT_CHUNK_BYTES, chunkCount
      }
    };
  }

  async exportChunk(recordingId = '', chunkIndex = -1) {
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw codeError('RECORDING.EXPORT_CHUNK_INVALID', '录制导出分块序号无效。');
    const directory = this.recordingDirectory(recordingId);
    const exportPath = path.join(directory, 'recording.json');
    const stat = await fsp.stat(exportPath).catch(() => null);
    if (!stat?.isFile() || stat.size < 1 || stat.size > MAX_EXPORT_BYTES) throw codeError('RECORDING.EXPORT_NOT_READY', '录制导出文件尚未生成或大小无效。');
    const chunkCount = Math.ceil(stat.size / EXPORT_CHUNK_BYTES);
    if (chunkIndex >= chunkCount) throw codeError('RECORDING.EXPORT_CHUNK_INVALID', '录制导出分块超出真实文件范围。');
    const length = Math.min(EXPORT_CHUNK_BYTES, stat.size - chunkIndex * EXPORT_CHUNK_BYTES);
    const handle = await fsp.open(exportPath, 'r');
    try {
      const bytes = Buffer.allocUnsafe(length);
      const result = await handle.read(bytes, 0, length, chunkIndex * EXPORT_CHUNK_BYTES);
      if (result.bytesRead !== length) throw codeError('RECORDING.EXPORT_READ_INCOMPLETE', '录制导出分块读取不完整。');
      return { schemaVersion: 'omnia.v5.recording-export-chunk/v1', recordingId, chunkIndex, chunkCount, sizeBytes: length, contentBase64: bytes.toString('base64') };
    } finally { await handle.close(); }
  }

  attachCatalog(recordingId, result) {
    const active = this.requireActive(recordingId, ['recording', 'paused']);
    const catalog = result?.catalog;
    const riskAssessmentId = id(catalog?.identity?.gra?.id);
    if (!isGuid(riskAssessmentId)) throw codeError('RECORDING.CATALOG_IDENTITY_INVALID', '自动采集结果缺少稳定 GRA 身份。');
    const filename = `risk-control-${riskAssessmentId}.json`;
    atomicJson(path.join(active.directory, filename), catalog);
    const completeness = catalog?.completeness || {};
    const metadata = {
      riskAssessmentId, file: filename, status: result.status === 'complete' ? 'complete' : 'incomplete',
      riskCount: Number(completeness.riskCount || 0), controlCount: Number(completeness.controlCount || 0),
      missingReasons: Array.isArray(completeness.missingReasons) ? completeness.missingReasons.map((value) => clean(value, 300)).slice(0, 100) : [],
      capturedAt: clean(catalog?.capturedAt || now(), 100)
    };
    active.catalogs = active.catalogs.filter((item) => item.riskAssessmentId !== riskAssessmentId);
    active.catalogs.push(metadata);
    active.updatedAt = now();
    this.persistManifest(active);
    return metadata;
  }

  noteAutomaticCatalogFailure(recordingId, message) {
    const active = this.active;
    if (!active || active.recordingId !== recordingId || !['recording', 'paused'].includes(active.state)) return;
    const failure = clean(message, 300);
    if (failure && !active.catalogFailures.includes(failure)) active.catalogFailures.push(failure);
    active.catalogFailures = active.catalogFailures.slice(-20);
    active.updatedAt = now();
    this.persistManifest(active);
  }

  persistManifest(active) {
    atomicJson(path.join(active.directory, 'manifest.json'), this.publicStatus(active));
  }

  publicStatus(active) {
    const elapsedMs = Number(active.elapsedMs || 0) + (active.state === 'recording' && active.runningSince ? Math.max(0, Date.now() - active.runningSince) : 0);
    const catalogs = Array.isArray(active.catalogs) ? active.catalogs : [];
    const riskCount = catalogs.reduce((sum, item) => sum + Number(item.riskCount || 0), 0);
    const controlCount = catalogs.reduce((sum, item) => sum + Number(item.controlCount || 0), 0);
    const completeCatalogs = catalogs.filter((item) => item.status === 'complete').length;
    const captureState = completeCatalogs > 0 && completeCatalogs === catalogs.length
      ? 'complete'
      : catalogs.length > 0 ? 'incomplete'
        : active.state === 'recording' ? 'pending' : 'incomplete';
    const captureMessage = captureState === 'complete'
      ? `已自动采集 ${catalogs.length} 个当前页 GRA：Risk ${riskCount}，Control ${controlCount}。`
      : catalogs.length
        ? `当前页自动采集不完整：${catalogs.flatMap((item) => item.missingReasons || []).slice(0, 3).join('；') || '存在必需读取缺失。'}`
        : active.catalogFailures?.length
          ? `正在等待当前页可重试的 GRA 数据：${active.catalogFailures.at(-1)}`
          : active.state === 'recording' ? '正在自动识别当前页 GRA，并采集 Risk 与 Control。' : '本次录制未获得可验证的当前页 GRA Risk/Control 目录。';
    return {
      schemaVersion: 'omnia.v5.recording-status/v1', state: active.state, active: ['recording', 'paused'].includes(active.state),
      recordingId: active.recordingId, engagementId: active.engagementId, sessionGeneration: active.sessionGeneration,
      startedAt: active.startedAt, updatedAt: active.updatedAt, eventCount: active.events, interactionCount: active.interactionCount,
      networkRequestCount: active.networkRequestCount, mutationRequestCount: active.mutationRequestCount,
      droppedEventCount: active.droppedEvents, elapsedMs, pauseCount: Number(active.pauseCount || 0), integrity: active.integrity,
      catalogs, capture: { state: captureState, message: captureMessage, riskCount, controlCount, graCount: catalogs.length },
      exportedAt: active.exportedAt || '', exportAvailable: active.state === 'stopped',
      message: active.state === 'recording' ? '正在录制当前 Pack；Risk 与 Control 会在当前页面自动采集。' : active.state === 'paused' ? '录制已暂停；继续后仍使用同一 recordingId。' : active.state === 'cancelled' ? '录制已取消，未生成导出文件。' : '录制已停止，可导出真实录制记录。'
    };
  }

  idleStatus() {
    return { schemaVersion: 'omnia.v5.recording-status/v1', state: 'idle', active: false, recordingId: '', elapsedMs: 0, eventCount: 0, interactionCount: 0, networkRequestCount: 0, capture: { state: 'idle', message: '开始录制后将自动采集当前页 Risk 与 Control。', riskCount: 0, controlCount: 0, graCount: 0 }, exportAvailable: false, message: '当前没有录制。' };
  }

  recordingDirectory(recordingId) {
    if (!isGuid(recordingId)) throw codeError('RECORDING.IDENTITY_INVALID', '录制 ID 无效。');
    return path.join(this.rootDir, recordingId.toLowerCase());
  }

  latestRecordingId() {
    return fs.readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isGuid(entry.name) && fs.existsSync(path.join(this.rootDir, entry.name, 'manifest.json')))
      .map((entry) => ({ id: entry.name.toLowerCase(), mtime: fs.statSync(path.join(this.rootDir, entry.name, 'manifest.json')).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime)[0]?.id || '';
  }

  readManifest(recordingId) {
    const normalized = clean(recordingId, 100).toLowerCase();
    const manifest = JSON.parse(fs.readFileSync(path.join(this.recordingDirectory(normalized), 'manifest.json'), 'utf8'));
    if (manifest?.schemaVersion !== 'omnia.v5.recording-status/v1' || manifest.recordingId !== normalized) throw codeError('RECORDING.MANIFEST_INVALID', '录制状态文件无效。');
    this.lastRecordingId = normalized;
    return { ...manifest, active: ['recording', 'paused'].includes(manifest.state), exportAvailable: manifest.state === 'stopped' };
  }

  restorePaused(recordingId, engagementId, sessionGeneration) {
    const manifest = this.readManifest(recordingId);
    if (manifest.state !== 'paused' || manifest.engagementId !== engagementId || Number(manifest.sessionGeneration) !== Number(sessionGeneration)) {
      throw codeError('RECORDING.BINDING_CHANGED', '暂停录制与当前 Connector 绑定不一致。');
    }
    const directory = this.recordingDirectory(recordingId);
    const active = {
      recordingId, engagementId, sessionGeneration, directory, startedAt: manifest.startedAt, updatedAt: manifest.updatedAt, state: 'paused',
      events: Number(manifest.eventCount || 0), droppedEvents: Number(manifest.droppedEventCount || 0), interactionCount: Number(manifest.interactionCount || 0),
      networkRequestCount: Number(manifest.networkRequestCount || 0), mutationRequestCount: Number(manifest.mutationRequestCount || 0),
      elapsedMs: Number(manifest.elapsedMs || 0), runningSince: 0, pauseCount: Number(manifest.pauseCount || 0), exportedAt: '',
      requests: new Map(), pendingBodies: new Set(), bodyQueue: [], bodyRunning: 0, criticalPending: new Set(),
      integrity: manifest.integrity, catalogs: manifest.catalogs || [], catalogFailures: [], lastCriticalAt: Date.now(),
      spool: path.join(directory, 'events.jsonl'), sessions: new Map(), contextListeners: new Map()
    };
    this.active = active;
    this.lastRecordingId = recordingId;
    return active;
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
