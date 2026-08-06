import crypto from 'node:crypto';
import type { Frame, Page, Request, Response } from 'playwright-core';
import type { ConnectorBinding } from '../shared/operation-contracts.js';
import {
  CURRENT_PACK_PAGE_OBSERVATION_POLICY,
  type ManagedStreamReadRequest,
  type PageObservationControlRequest,
  type PageObservationEventEnvelope,
  type PageObservationOpenRequest,
  type PageObservationStatus
} from '../shared/page-observation-contracts.js';
import { isAllowedOmniaUrl, parseEngagementId } from './omnia-origin.js';
import { ManagedStreamHost } from './managed-stream-host.js';

const MAX_ACTIVE_OBSERVATIONS = 4;
const MAX_EVENTS = 100_000;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 96 * 1024;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const RESPONSE_SEGMENT_BYTES = 48 * 1024;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_STOP_DRAIN_MS = 5_000;
const OBSERVATION_ID = /^observation_[0-9a-f]{32}$/u;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|session(?:id)?|private[_-]?key)/iu;
const CREDENTIAL_VALUE = /(?:\bbearer\s+[a-z0-9._~+/=-]+|\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})/iu;

const INTERACTION_BRIDGE_NAME = '__omniaV5PageObservationInteraction';
const INTERACTION_SOURCE = `(() => {
  const marker = Symbol.for('omnia.agent.v5.page-observation.interactions');
  if (globalThis[marker]) return true;
  globalThis[marker] = true;
  const clean = (value, max = 512) => String(value == null ? '' : value)
    .replace(/[\\u0000-\\u001f\\u007f]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, max);
  const sensitive = (element) => {
    const type = clean(element.getAttribute('type'), 40).toLowerCase();
    const identity = clean([element.id, element.getAttribute('name'), element.getAttribute('autocomplete')].join(' '), 300);
    return type === 'password' || /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|session)/i.test(identity);
  };
  const emit = (action, event) => {
    try {
      const raw = event.target instanceof Element ? event.target : null;
      const element = raw && (raw.closest('button,a,input,select,textarea,[role="button"],[role="checkbox"],[role="radio"],[role="combobox"]') || raw);
      if (!element || typeof globalThis.${INTERACTION_BRIDGE_NAME} !== 'function') return;
      const isSensitive = sensitive(element);
      const type = clean(element.getAttribute('type'), 40).toLowerCase();
      const value = element instanceof HTMLSelectElement
        ? clean(element.selectedOptions[0]?.textContent, 512)
        : (type === 'checkbox' || type === 'radio') ? Boolean(element.checked)
          : isSensitive ? '[redacted]' : clean(element.value, 1024);
      void globalThis.${INTERACTION_BRIDGE_NAME}({
        action, tag: clean(element.tagName, 30).toLowerCase(), type,
        role: clean(element.getAttribute('role'), 60), id: clean(element.id, 160),
        name: clean(element.getAttribute('name'), 160),
        ariaLabel: isSensitive ? '[redacted]' : clean(element.getAttribute('aria-label'), 300),
        text: isSensitive ? '[redacted]' : clean(element.innerText || element.textContent, 500),
        value, sensitive: isSensitive
      });
    } catch { }
  };
  for (const name of ['click', 'change', 'input', 'submit']) {
    document.addEventListener(name, (event) => emit(name, event), true);
  }
  return true;
})()`;

export interface PageObservationContext {
  page: Page;
  binding: ConnectorBinding;
  targetUrl: URL;
  apiOrigin: string;
}

type Observation = {
  observationId: string;
  ownerId: string;
  idempotencyKey: string;
  streamId: string;
  policyId: typeof CURRENT_PACK_PAGE_OBSERVATION_POLICY;
  page: Page;
  binding: ConnectorBinding;
  allowedOrigins: Set<string>;
  state: PageObservationStatus['state'];
  startedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  lastSequence: number;
  eventCount: number;
  omissionCount: number;
  complete: boolean;
  terminalReason: string | null;
  writtenBytes: number;
  finishing: boolean;
  frameIds: WeakMap<Frame, string>;
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  pending: Set<Promise<void>>;
  timer: NodeJS.Timeout;
  listeners: {
    request: (request: Request) => void;
    response: (response: Response) => void;
    navigation: (frame: Frame) => void;
    close: () => void;
  };
};

function now(): string {
  return new Date().toISOString();
}

function clean(value: unknown, max = 4096): string {
  const result = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
  return CREDENTIAL_VALUE.test(result) ? '[redacted]' : result;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unknown or missing fields.`);
  }
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[omitted-depth]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[omitted-number]';
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => scrub(item, depth + 1));
  if (!value || typeof value !== 'object' || Object.prototype.toString.call(value) !== '[object Object]') {
    return clean(value, 500);
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 1_000).map(([key, item]) => {
    const safeKey = clean(key, 120);
    return [safeKey, SENSITIVE_KEY.test(safeKey) ? '[redacted]' : scrub(item, depth + 1)];
  }));
}

function scrubRecord(value: unknown): Record<string, unknown> {
  const result = scrub(value);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { value: result };
}

function safeUrl(value: string, observation: Observation): string {
  try {
    if (!isAllowedOmniaUrl(value)) return '';
    const url = new URL(value);
    if (!observation.allowedOrigins.has(url.origin)) return '';
    const explicitEngagement = parseEngagementId(url.href);
    if (explicitEngagement && explicitEngagement !== observation.binding.engagementId) return '';
    for (const key of [...url.searchParams.keys()]) {
      const raw = url.searchParams.get(key) || '';
      const preserved = /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(raw) || /^(?:true|false|\d{1,12})$/u.test(raw);
      url.searchParams.set(key, SENSITIVE_KEY.test(key) || !preserved ? '[redacted]' : raw.toLowerCase());
    }
    url.hash = '';
    return url.toString().slice(0, 4096);
  } catch {
    return '';
  }
}

function opaqueId(prefix: 'observation' | 'frame'): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

export class PageObservationHost {
  private readonly observations = new Map<string, Observation>();
  private readonly idempotency = new Map<string, string>();
  private readonly bridgedPages = new WeakSet<Page>();

  constructor(private readonly streams: ManagedStreamHost) {}

  async open(ownerId: string, input: PageObservationOpenRequest, context: PageObservationContext): Promise<PageObservationStatus> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Page observation open request is invalid.');
    exactKeys(input, ['schemaVersion', 'policyId', 'idempotencyKey'], 'Page observation open request');
    if (input.schemaVersion !== 'omnia.page-observation-open/v1'
      || input.policyId !== CURRENT_PACK_PAGE_OBSERVATION_POLICY
      || !/^[A-Za-z0-9._:-]{16,200}$/u.test(input.idempotencyKey)) {
      throw new Error('Page observation open request is invalid.');
    }
    this.assertContext(context);
    const idempotencyKey = `${ownerId}:${input.idempotencyKey}`;
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId) return this.status(ownerId, { schemaVersion: 'omnia.page-observation-control/v1', observationId: existingId });
    const activeForOwner = [...this.observations.values()].find((item) => item.ownerId === ownerId && !['stopped', 'failed'].includes(item.state));
    if (activeForOwner) throw new Error('This Operation package already owns an active page observation.');
    const activeCount = [...this.observations.values()].filter((item) => !['stopped', 'failed'].includes(item.state)).length;
    if (activeCount >= MAX_ACTIVE_OBSERVATIONS) throw new Error('Connector page observation concurrency limit has been reached.');

    const observationId = opaqueId('observation');
    const streamId = this.streams.create(ownerId, 'application/x-ndjson');
    const timestamp = now();
    const observation = {} as Observation;
    Object.assign(observation, {
      observationId,
      ownerId,
      idempotencyKey: input.idempotencyKey,
      streamId,
      policyId: input.policyId,
      page: context.page,
      binding: { ...context.binding },
      allowedOrigins: new Set([context.targetUrl.origin, new URL(context.apiOrigin).origin]),
      state: 'observing',
      startedAt: timestamp,
      updatedAt: timestamp,
      stoppedAt: null,
      lastSequence: 0,
      eventCount: 0,
      omissionCount: 0,
      complete: true,
      terminalReason: null,
      writtenBytes: 0,
      finishing: false,
      frameIds: new WeakMap<Frame, string>(),
      requestIds: new WeakMap<Request, string>(),
      nextRequestId: 0,
      pending: new Set<Promise<void>>(),
      listeners: {} as Observation['listeners']
    });
    observation.listeners = this.listeners(observation);
    observation.timer = setTimeout(() => {
      this.omission(observation, 'duration_budget_reached');
      void this.finish(observation, false, 'duration_budget_reached');
    }, MAX_DURATION_MS);
    observation.timer.unref?.();
    this.observations.set(observationId, observation);
    this.idempotency.set(idempotencyKey, observationId);
    await this.ensureInteractionBridge(context.page);
    this.attach(observation);
    this.append(observation, 'observation.started', {
      policyId: input.policyId,
      streamMediaType: 'application/x-ndjson',
      sourceRedaction: 'connector-fixed-v1'
    }, context.page.mainFrame());
    this.schedule(observation, this.snapshot(observation, context.page.mainFrame()));
    return this.publicStatus(observation);
  }

  status(ownerId: string, input: PageObservationControlRequest): PageObservationStatus {
    const observation = this.controlled(ownerId, input);
    return this.publicStatus(observation);
  }

  async pause(ownerId: string, input: PageObservationControlRequest): Promise<PageObservationStatus> {
    const observation = this.controlled(ownerId, input);
    if (observation.state === 'paused') return this.publicStatus(observation);
    if (observation.state !== 'observing' || observation.finishing) throw new Error('Page observation cannot be paused from its current state.');
    this.append(observation, 'observation.paused', {}, observation.page.mainFrame());
    observation.state = 'paused';
    observation.updatedAt = now();
    return this.publicStatus(observation);
  }

  async resume(ownerId: string, input: PageObservationControlRequest, context: PageObservationContext): Promise<PageObservationStatus> {
    const observation = this.controlled(ownerId, input);
    if (observation.state === 'observing') return this.publicStatus(observation);
    if (observation.state !== 'paused' || observation.finishing) throw new Error('Page observation cannot be resumed from its current state.');
    this.assertSameContext(observation, context);
    observation.state = 'observing';
    observation.updatedAt = now();
    this.append(observation, 'observation.resumed', {}, observation.page.mainFrame());
    this.schedule(observation, this.snapshot(observation, observation.page.mainFrame()));
    return this.publicStatus(observation);
  }

  async stop(ownerId: string, input: PageObservationControlRequest): Promise<PageObservationStatus> {
    const observation = this.controlled(ownerId, input);
    await this.finish(observation, observation.complete, observation.terminalReason || 'requested');
    return this.publicStatus(observation);
  }

  readChunk(ownerId: string, input: ManagedStreamReadRequest) {
    return this.streams.read(ownerId, input);
  }

  async releaseOwner(ownerId: string): Promise<void> {
    const owned = [...this.observations.values()].filter((observation) => observation.ownerId === ownerId);
    await Promise.allSettled(owned.map((observation) => this.finish(observation, false, 'operation_owner_released')));
    for (const observation of owned) {
      this.observations.delete(observation.observationId);
      this.idempotency.delete(`${ownerId}:${observation.idempotencyKey}`);
    }
    this.streams.releaseOwner(ownerId);
  }

  retireOwner(ownerId: string): void {
    const timestamp = now();
    for (const observation of [...this.observations.values()]) {
      if (observation.ownerId !== ownerId) continue;
      clearTimeout(observation.timer);
      this.detach(observation);
      observation.finishing = true;
      observation.complete = false;
      observation.terminalReason = 'operation_owner_released';
      observation.state = 'failed';
      observation.stoppedAt = timestamp;
      observation.updatedAt = timestamp;
      this.observations.delete(observation.observationId);
      this.idempotency.delete(`${ownerId}:${observation.idempotencyKey}`);
    }
    this.streams.releaseOwner(ownerId);
  }

  async close(): Promise<void> {
    for (const ownerId of new Set([...this.observations.values()].map((observation) => observation.ownerId))) {
      await this.releaseOwner(ownerId);
    }
  }

  private assertContext(context: PageObservationContext): void {
    if (!context.page || context.page.isClosed() || !isAllowedOmniaUrl(context.page.url())) {
      throw new Error('Page observation requires the current controlled Omnia page.');
    }
    if (parseEngagementId(context.page.url()) !== context.binding.engagementId
      || context.targetUrl.origin !== new URL(context.page.url()).origin
      || parseEngagementId(context.targetUrl.href) !== context.binding.engagementId
      || !isAllowedOmniaUrl(context.apiOrigin)) {
      throw new Error('Page observation context does not match the current Connector binding.');
    }
  }

  private assertSameContext(observation: Observation, context: PageObservationContext): void {
    this.assertContext(context);
    if (context.page !== observation.page
      || context.binding.connectorId !== observation.binding.connectorId
      || context.binding.sessionGeneration !== observation.binding.sessionGeneration
      || context.binding.engagementId !== observation.binding.engagementId
      || context.binding.packId !== observation.binding.packId) {
      throw new Error('Page observation binding changed while it was paused.');
    }
  }

  private controlled(ownerId: string, input: PageObservationControlRequest): Observation {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Page observation control request is invalid.');
    exactKeys(input, ['schemaVersion', 'observationId'], 'Page observation control request');
    if (input.schemaVersion !== 'omnia.page-observation-control/v1' || !OBSERVATION_ID.test(input.observationId)) {
      throw new Error('Page observation control request is invalid.');
    }
    const observation = this.observations.get(input.observationId);
    if (!observation || observation.ownerId !== ownerId) throw new Error('Page observation is unavailable for this Operation package.');
    return observation;
  }

  private listeners(observation: Observation): Observation['listeners'] {
    return {
      request: (request) => {
        if (observation.state !== 'observing' || observation.finishing) return;
        const url = safeUrl(request.url(), observation);
        if (!url) return;
        const requestId = `request_${++observation.nextRequestId}`;
        observation.requestIds.set(request, requestId);
        this.append(observation, 'network.request', {
          requestId,
          method: clean(request.method(), 16).toUpperCase(),
          resourceType: clean(request.resourceType(), 40),
          url
        }, this.requestFrame(observation, request));
      },
      response: (response) => {
        if (observation.state !== 'observing' || observation.finishing) return;
        const url = safeUrl(response.url(), observation);
        if (!url) return;
        const request = response.request();
        const requestId = observation.requestIds.get(request) || `request_${++observation.nextRequestId}`;
        observation.requestIds.set(request, requestId);
        this.append(observation, 'network.response', {
          requestId,
          method: clean(request.method(), 16).toUpperCase(),
          url,
          status: response.status()
        }, this.requestFrame(observation, request));
        if (request.method().toUpperCase() === 'GET') this.schedule(observation, this.captureResponseBody(observation, response, requestId));
      },
      navigation: (frame) => {
        if (observation.finishing) return;
        if (frame === observation.page.mainFrame()) {
          const engagementId = parseEngagementId(frame.url());
          if (!isAllowedOmniaUrl(frame.url()) || engagementId !== observation.binding.engagementId) {
            this.omission(observation, 'target_identity_changed', frame);
            void this.finish(observation, false, 'target_identity_changed');
            return;
          }
        }
        if (observation.state !== 'observing') return;
        const url = safeUrl(frame.url(), observation);
        if (!url) return;
        this.append(observation, 'page.navigation', { url }, frame);
        this.schedule(observation, this.snapshot(observation, frame));
      },
      close: () => {
        this.omission(observation, 'target_closed');
        void this.finish(observation, false, 'target_closed');
      }
    };
  }

  private attach(observation: Observation): void {
    observation.page.on('request', observation.listeners.request);
    observation.page.on('response', observation.listeners.response);
    observation.page.on('framenavigated', observation.listeners.navigation);
    observation.page.on('close', observation.listeners.close);
  }

  private detach(observation: Observation): void {
    observation.page.off('request', observation.listeners.request);
    observation.page.off('response', observation.listeners.response);
    observation.page.off('framenavigated', observation.listeners.navigation);
    observation.page.off('close', observation.listeners.close);
  }

  private async ensureInteractionBridge(page: Page): Promise<void> {
    if (this.bridgedPages.has(page)) return;
    await page.exposeBinding(INTERACTION_BRIDGE_NAME, (source, payload: unknown) => {
      for (const observation of this.observations.values()) {
        if (observation.page !== source.page || observation.state !== 'observing' || observation.finishing) continue;
        this.append(observation, 'page.interaction', scrubRecord(payload), source.frame);
      }
    });
    await page.addInitScript({ content: INTERACTION_SOURCE });
    await page.evaluate(INTERACTION_SOURCE).catch(() => undefined);
    this.bridgedPages.add(page);
  }

  private async snapshot(observation: Observation, frame: Frame): Promise<void> {
    if (observation.state !== 'observing' || observation.finishing || frame.isDetached()) return;
    try {
      const payload = await frame.evaluate(() => {
        const cleanText = (value: unknown, max = 512) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
        const sensitive = (element: Element) => {
          const type = cleanText(element.getAttribute('type'), 40).toLowerCase();
          const identity = cleanText([element.id, element.getAttribute('name'), element.getAttribute('autocomplete')].join(' '), 300);
          return type === 'password' || /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|session)/iu.test(identity);
        };
        const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].slice(0, 100)
          .map((element) => cleanText(element.textContent, 500)).filter(Boolean);
        const controls = [...document.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="checkbox"],[role="radio"],[role="combobox"]')]
          .slice(0, 1_000).map((element) => {
            const isSensitive = sensitive(element);
            const input = element instanceof HTMLInputElement ? element : null;
            const select = element instanceof HTMLSelectElement ? element : null;
            const type = cleanText(element.getAttribute('type'), 40).toLowerCase();
            const value = select ? cleanText(select.selectedOptions[0]?.textContent, 512)
              : input && (type === 'checkbox' || type === 'radio') ? Boolean(input.checked)
                : isSensitive ? '[redacted]'
                  : 'value' in element ? cleanText((element as HTMLInputElement).value, 1024) : '';
            return {
              tag: cleanText(element.tagName, 30).toLowerCase(), type,
              role: cleanText(element.getAttribute('role'), 60), id: cleanText(element.id, 160),
              name: cleanText(element.getAttribute('name'), 160),
              ariaLabel: isSensitive ? '[redacted]' : cleanText(element.getAttribute('aria-label'), 300),
              text: isSensitive ? '[redacted]' : cleanText(element.textContent, 500),
              value, disabled: (element as HTMLButtonElement).disabled === true
            };
          });
        return { title: cleanText(document.title, 500), headings, controls };
      });
      this.append(observation, 'page.snapshot', scrubRecord({
        url: safeUrl(frame.url(), observation),
        ...payload
      }), frame);
    } catch (error) {
      this.omission(observation, `page_snapshot_unavailable:${clean(error instanceof Error ? error.message : error, 160)}`, frame);
    }
  }

  private async captureResponseBody(observation: Observation, response: Response, requestId: string): Promise<void> {
    if (observation.state !== 'observing' || observation.finishing) return;
    const contentType = clean(await response.headerValue('content-type').catch(() => ''), 200);
    if (!/(?:application|text)\/(?:[^;]+\+)?json\b/iu.test(contentType)) return;
    const declaredLength = Number(await response.headerValue('content-length').catch(() => ''));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BODY_BYTES) {
      this.omission(observation, 'response_body_declared_too_large', this.requestFrame(observation, response.request()), { requestId, declaredLength });
      return;
    }
    try {
      const raw = await response.body();
      if (raw.byteLength > MAX_RESPONSE_BODY_BYTES) {
        this.omission(observation, 'response_body_too_large', this.requestFrame(observation, response.request()), { requestId, bodyBytes: raw.byteLength });
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString('utf8')); }
      catch {
        this.omission(observation, 'response_body_invalid_json', this.requestFrame(observation, response.request()), { requestId });
        return;
      }
      const redacted = Buffer.from(JSON.stringify(scrub(parsed)), 'utf8');
      if (redacted.byteLength > MAX_RESPONSE_BODY_BYTES) {
        this.omission(observation, 'response_body_redacted_too_large', this.requestFrame(observation, response.request()), { requestId, bodyBytes: redacted.byteLength });
        return;
      }
      const bodyDigest = crypto.createHash('sha256').update(redacted).digest('hex');
      const partCount = Math.max(1, Math.ceil(redacted.byteLength / RESPONSE_SEGMENT_BYTES));
      for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
        const start = partIndex * RESPONSE_SEGMENT_BYTES;
        const segment = redacted.subarray(start, Math.min(redacted.byteLength, start + RESPONSE_SEGMENT_BYTES));
        this.append(observation, 'network.response-body.segment', {
          requestId,
          contentType,
          encoding: 'utf8-json-base64',
          partIndex,
          partCount,
          bodyDigest,
          bytesBase64: segment.toString('base64')
        }, this.requestFrame(observation, response.request()));
      }
    } catch (error) {
      this.omission(observation, `response_body_unavailable:${clean(error instanceof Error ? error.message : error, 160)}`, this.requestFrame(observation, response.request()), { requestId });
    }
  }

  private schedule(observation: Observation, task: Promise<void>): void {
    observation.pending.add(task);
    void task.finally(() => observation.pending.delete(task));
  }

  private append(
    observation: Observation,
    kind: PageObservationEventEnvelope['kind'],
    payload: Record<string, unknown>,
    frame: Frame
  ): void {
    if (observation.state === 'stopped' || observation.state === 'failed') return;
    if (observation.finishing && ![
      'network.response-body.segment', 'observation.omission', 'observation.stopped'
    ].includes(kind)) return;
    if (observation.eventCount >= MAX_EVENTS) {
      observation.complete = false;
      observation.terminalReason = 'event_budget_reached';
      void this.finish(observation, false, 'event_budget_reached');
      return;
    }
    const envelope: PageObservationEventEnvelope = {
      schemaVersion: 'omnia.page-observation-event/v1',
      observationId: observation.observationId,
      sequence: observation.lastSequence + 1,
      occurredAt: now(),
      target: {
        engagementId: observation.binding.engagementId,
        frameId: this.frameId(observation, frame),
        mainFrame: frame === observation.page.mainFrame()
      },
      kind,
      payload
    };
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    if (bytes.byteLength > MAX_EVENT_BYTES) {
      if (kind !== 'observation.omission') this.omission(observation, 'event_payload_too_large', frame, { eventKind: kind, eventBytes: bytes.byteLength });
      return;
    }
    if (observation.writtenBytes + bytes.byteLength > MAX_STREAM_BYTES) {
      observation.complete = false;
      observation.terminalReason = 'stream_budget_reached';
      void this.finish(observation, false, 'stream_budget_reached');
      return;
    }
    const appended = this.streams.append(observation.ownerId, observation.streamId, bytes);
    observation.writtenBytes = appended.nextOffset;
    observation.lastSequence = envelope.sequence;
    observation.eventCount += 1;
    observation.updatedAt = envelope.occurredAt;
  }

  private omission(observation: Observation, reason: string, frame = observation.page.mainFrame(), details: Record<string, unknown> = {}): void {
    if (observation.state === 'stopped' || observation.state === 'failed') return;
    observation.complete = false;
    observation.omissionCount += 1;
    this.append(observation, 'observation.omission', {
      reason: clean(reason, 240),
      details: scrub(details) as Record<string, unknown>
    }, frame);
  }

  private async finish(observation: Observation, complete: boolean, reason: string): Promise<void> {
    if (observation.state === 'stopped' || observation.state === 'failed') return;
    if (observation.finishing) {
      while (observation.finishing && !['stopped', 'failed'].includes(observation.state)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return;
    }
    observation.finishing = true;
    clearTimeout(observation.timer);
    this.detach(observation);
    let drained = false;
    let drainTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...observation.pending]).then(() => { drained = true; }),
        new Promise<void>((resolve) => { drainTimer = setTimeout(resolve, MAX_STOP_DRAIN_MS); })
      ]);
    } finally {
      if (drainTimer) clearTimeout(drainTimer);
    }
    if (!drained) {
      this.omission(observation, 'pending_capture_drain_timeout');
      reason = 'pending_capture_drain_timeout';
    }
    observation.complete = observation.complete && complete;
    observation.terminalReason = reason;
    this.append(observation, 'observation.stopped', {
      reason,
      complete: observation.complete,
      omissionCount: observation.omissionCount
    }, observation.page.mainFrame());
    this.streams.finalize(observation.ownerId, observation.streamId);
    observation.state = observation.complete ? 'stopped' : 'failed';
    observation.stoppedAt = now();
    observation.updatedAt = observation.stoppedAt;
    observation.finishing = false;
  }

  private frameId(observation: Observation, frame: Frame): string {
    const existing = observation.frameIds.get(frame);
    if (existing) return existing;
    const frameId = opaqueId('frame');
    observation.frameIds.set(frame, frameId);
    return frameId;
  }

  private requestFrame(observation: Observation, request: Request): Frame {
    try { return request.frame(); } catch { return observation.page.mainFrame(); }
  }

  private publicStatus(observation: Observation): PageObservationStatus {
    return {
      schemaVersion: 'omnia.page-observation-status/v1',
      observationId: observation.observationId,
      streamId: observation.streamId,
      policyId: observation.policyId,
      state: observation.state,
      engagementId: observation.binding.engagementId,
      startedAt: observation.startedAt,
      updatedAt: observation.updatedAt,
      stoppedAt: observation.stoppedAt,
      lastSequence: observation.lastSequence,
      eventCount: observation.eventCount,
      omissionCount: observation.omissionCount,
      complete: observation.complete,
      terminalReason: observation.terminalReason
    };
  }
}
