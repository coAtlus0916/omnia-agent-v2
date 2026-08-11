import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import { ManagedStreamHost, type ManagedStreamOwner } from './managed-stream-host.js';

const MAX_ACTIVE_OBSERVATIONS = 4;
const MAX_EVENTS = 100_000;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 96 * 1024;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const RESPONSE_SEGMENT_BYTES = 48 * 1024;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_STOP_DRAIN_MS = 5_000;
const OBSERVATION_ID = /^observation_[0-9a-f]{32}$/u;
const OBSERVATION_METADATA_SCHEMA = 'omnia.page-observation-metadata/v1' as const;
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
  owner: ManagedStreamOwner;
  idempotencyKey: string;
  streamId: string;
  policyId: typeof CURRENT_PACK_PAGE_OBSERVATION_POLICY;
  page: Page | null;
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
  timer: NodeJS.Timeout | null;
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

  private readonly metadataRoot: string;
  private inventoryUnknownCount = 0;

  constructor(private readonly streams: ManagedStreamHost) {
    this.metadataRoot = path.join(streams.root, 'observations');
    fs.mkdirSync(this.metadataRoot, { recursive: true });
    this.loadPersistedObservations();
  }

  maintenanceSnapshot(): { activeObservations: number; finishingObservations: number; inventoryUnknownCount: number } {
    return {
      activeObservations: [...this.observations.values()].filter((observation) => (
        !['stopped', 'failed'].includes(observation.state)
      )).length,
      finishingObservations: [...this.observations.values()].filter((observation) => observation.finishing).length,
      inventoryUnknownCount: this.inventoryUnknownCount
    };
  }

  ownedResourceSnapshot(packageDigest: string, binding: ConnectorBinding): {
    state: 'known' | 'unknown';
    count: number;
  } {
    if (this.inventoryUnknownCount > 0) return { state: 'unknown', count: 0 };
    return {
      state: 'known',
      count: [...this.observations.values()].filter((observation) => (
        observation.owner.packageDigest === packageDigest
        && this.sameStableBinding(observation.binding, binding)
      )).length
    };
  }

  async open(owner: ManagedStreamOwner, input: PageObservationOpenRequest, context: PageObservationContext): Promise<PageObservationStatus> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Page observation open request is invalid.');
    exactKeys(input, ['schemaVersion', 'policyId', 'idempotencyKey'], 'Page observation open request');
    if (input.schemaVersion !== 'omnia.page-observation-open/v1'
      || input.policyId !== CURRENT_PACK_PAGE_OBSERVATION_POLICY
      || !/^[A-Za-z0-9._:-]{16,200}$/u.test(input.idempotencyKey)) {
      throw new Error('Page observation open request is invalid.');
    }
    this.assertContext(context);
    const idempotencyKey = `${owner.ownerKey}:${input.idempotencyKey}`;
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId) return this.status(owner, { schemaVersion: 'omnia.page-observation-control/v1', observationId: existingId });
    const activeForOwner = [...this.observations.values()].find((item) => item.owner.ownerKey === owner.ownerKey && !['stopped', 'failed'].includes(item.state));
    if (activeForOwner) throw new Error('This Operation package already owns an active page observation.');
    const activeCount = [...this.observations.values()].filter((item) => !['stopped', 'failed'].includes(item.state)).length;
    if (activeCount >= MAX_ACTIVE_OBSERVATIONS) throw new Error('Connector page observation concurrency limit has been reached.');

    const observationId = opaqueId('observation');
    const streamId = this.streams.create(owner, 'application/x-ndjson');
    const timestamp = now();
    const observation = {} as Observation;
    Object.assign(observation, {
      observationId,
      owner: structuredClone(owner),
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
    this.persist(observation);
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

  status(owner: ManagedStreamOwner, input: PageObservationControlRequest): PageObservationStatus {
    const observation = this.controlled(owner, input);
    return this.publicStatus(observation);
  }

  async pause(owner: ManagedStreamOwner, input: PageObservationControlRequest): Promise<PageObservationStatus> {
    const observation = this.controlled(owner, input);
    if (observation.state === 'paused') return this.publicStatus(observation);
    if (observation.state !== 'observing' || observation.finishing) throw new Error('Page observation cannot be paused from its current state.');
    this.append(observation, 'observation.paused', {}, this.pageOf(observation).mainFrame());
    observation.state = 'paused';
    observation.updatedAt = now();
    this.persist(observation);
    return this.publicStatus(observation);
  }

  async resume(owner: ManagedStreamOwner, input: PageObservationControlRequest, context: PageObservationContext): Promise<PageObservationStatus> {
    const observation = this.controlled(owner, input);
    if (observation.state === 'observing') return this.publicStatus(observation);
    if (observation.state !== 'paused' || observation.finishing) throw new Error('Page observation cannot be resumed from its current state.');
    this.assertSameContext(observation, context);
    observation.state = 'observing';
    observation.updatedAt = now();
    this.append(observation, 'observation.resumed', {}, this.pageOf(observation).mainFrame());
    this.schedule(observation, this.snapshot(observation, this.pageOf(observation).mainFrame()));
    this.persist(observation);
    return this.publicStatus(observation);
  }

  async stop(owner: ManagedStreamOwner, input: PageObservationControlRequest): Promise<PageObservationStatus> {
    const observation = this.controlled(owner, input);
    await this.finish(observation, observation.complete, observation.terminalReason || 'requested');
    return this.publicStatus(observation);
  }

  readChunk(owner: ManagedStreamOwner, input: ManagedStreamReadRequest) {
    return this.streams.read(owner, input);
  }

  async releaseOwner(owner: ManagedStreamOwner): Promise<void> {
    const owned = [...this.observations.values()].filter((observation) => (
      observation.owner.ownerKey === owner.ownerKey && observation.owner.packageDigest === owner.packageDigest
    ));
    await Promise.allSettled(owned.map((observation) => this.finish(observation, false, 'operation_owner_released')));
    this.streams.releaseOwner(owner);
  }

  retireOwner(packageDigest: string): void {
    const timestamp = now();
    for (const observation of this.observations.values()) {
      if (observation.owner.packageDigest !== packageDigest || ['stopped', 'failed'].includes(observation.state)) continue;
      if (observation.timer) clearTimeout(observation.timer);
      this.detach(observation);
      observation.finishing = true;
      observation.complete = false;
      observation.terminalReason = 'operation_owner_released';
      observation.state = 'failed';
      observation.stoppedAt = timestamp;
      observation.updatedAt = timestamp;
      observation.finishing = false;
      this.streams.finalize(observation.owner, observation.streamId, false);
      this.persist(observation);
    }
  }

  preflightOwnerReplacement(
    packageDigest: string,
    registrationBinding: ConnectorBinding,
    successor: (binding: ConnectorBinding) => ManagedStreamOwner
  ): void {
    const owned = [...this.observations.values()].filter((observation) => (
      observation.owner.packageDigest === packageDigest
      && this.sameStableBinding(observation.binding, registrationBinding)
    ));
    const active = owned.find((observation) => !['stopped', 'failed'].includes(observation.state));
    if (active) {
      throw new Error('Operation package replacement is blocked by an active page observation; stop it before retrying registration.');
    }
    for (const observation of owned) {
      if (observation.state !== 'stopped' || !observation.complete || observation.omissionCount !== 0) continue;
      this.controlled(successor(observation.binding), {
        schemaVersion: 'omnia.page-observation-control/v1',
        observationId: observation.observationId
      });
    }
  }

  commitOwnerReplacement(
    packageDigest: string,
    registrationBinding: ConnectorBinding,
    successor: (binding: ConnectorBinding) => ManagedStreamOwner
  ): void {
    const owned = [...this.observations.values()].filter((observation) => (
      observation.owner.packageDigest === packageDigest
      && this.sameStableBinding(observation.binding, registrationBinding)
    ));
    for (const observation of owned) {
      if (observation.state !== 'stopped' || !observation.complete || observation.omissionCount !== 0) continue;
      const nextOwner = successor(observation.binding);
      this.controlled(nextOwner, {
        schemaVersion: 'omnia.page-observation-control/v1',
        observationId: observation.observationId
      });
      this.streams.adoptOwner(observation.owner, nextOwner, observation.streamId);
    }
  }

  finalizeOwnerReplacement(
    packageDigest: string,
    registrationBinding: ConnectorBinding,
    successor: (binding: ConnectorBinding) => ManagedStreamOwner
  ): void {
    const candidates = [...this.observations.values()].filter((observation) => {
      if (!this.sameStableBinding(observation.binding, registrationBinding)) return false;
      const nextOwner = successor(observation.binding);
      return observation.owner.packageDigest === packageDigest
        || this.streams.ownerAdoptionPending(observation.streamId, nextOwner);
    });
    for (const observation of candidates) {
      if (observation.state !== 'stopped' || !observation.complete || observation.omissionCount !== 0) continue;
      const nextOwner = successor(observation.binding);
      if (!this.streams.ownerAdoptionAllows(observation.streamId, nextOwner)) {
        throw new Error('Page observation owner finalization lacks a durable managed-stream adoption.');
      }
      if (observation.owner.packageDigest === packageDigest) {
        const previousOwner = observation.owner;
        observation.owner = structuredClone(nextOwner);
        try {
          this.persist(observation);
        } catch (error) {
          observation.owner = previousOwner;
          throw error;
        }
      }
      if (this.streams.ownerAdoptionPending(observation.streamId, nextOwner)) {
        this.streams.finalizeOwnerAdoption(nextOwner, observation.streamId);
      }
    }
  }

  abortOwnerReplacement(packageDigest: string, binding: ConnectorBinding): void {
    for (const observation of this.observations.values()) {
      if (observation.state !== 'stopped' || !observation.complete || observation.omissionCount !== 0) continue;
      if (!this.sameStableBinding(observation.binding, binding)) continue;
      this.streams.abortOwnerAdoption(packageDigest, observation.streamId);
    }
  }

  async close(): Promise<void> {
    for (const observation of [...this.observations.values()]) {
      if (!['stopped', 'failed'].includes(observation.state)) {
        await this.finish(observation, false, 'connector_host_closed');
      }
    }
  }

  private assertContext(context: PageObservationContext): void {
    if (!context.page || context.page.isClosed() || !isAllowedOmniaUrl(context.page.url())) {
      throw new Error('Page observation requires the current controlled Omnia page.');
    }
    if (!context.binding.connectorId || !context.binding.authorityInstanceId || !context.binding.packId
      || !Number.isSafeInteger(context.binding.sessionGeneration) || context.binding.sessionGeneration < 0
      || parseEngagementId(context.page.url()) !== context.binding.engagementId
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
      || context.binding.authorityInstanceId !== observation.binding.authorityInstanceId
      || context.binding.tenantOrOrgId !== observation.binding.tenantOrOrgId
      || context.binding.packId !== observation.binding.packId) {
      throw new Error('Page observation binding changed while it was paused.');
    }
  }

  private controlled(owner: ManagedStreamOwner, input: PageObservationControlRequest): Observation {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Page observation control request is invalid.');
    exactKeys(input, ['schemaVersion', 'observationId'], 'Page observation control request');
    if (input.schemaVersion !== 'omnia.page-observation-control/v1' || !OBSERVATION_ID.test(input.observationId)) {
      throw new Error('Page observation control request is invalid.');
    }
    const observation = this.observations.get(input.observationId);
    const stableBinding = observation && this.sameStableBinding(observation.owner.binding, owner.binding);
    const sameStableOwner = observation?.owner.ownerKey === owner.ownerKey;
    const compatibleLegacyOwner = observation && owner.compatibleSourceOwners?.some((source) => (
      source.ownerKey === observation.owner.ownerKey && source.packageDigest === observation.owner.packageDigest
    )) === true;
    const durableAdoption = observation ? this.streams.ownerAdoptionAllows(observation.streamId, owner) : false;
    const transferable = observation?.state === 'stopped' && observation.complete && observation.omissionCount === 0;
    const sameDigest = observation?.owner.packageDigest === owner.packageDigest;
    const sameSession = observation?.owner.binding.sessionGeneration === owner.binding.sessionGeneration;
    const compatibleCrossDigest = observation && !sameDigest && transferable
      && observation.owner.capabilityFingerprint === owner.capabilityFingerprint
      && owner.packageSequence > observation.owner.packageSequence;
    const exactNonTransferable = sameStableOwner && sameDigest && sameSession;
    const transferableOwner = transferable && (
      (sameStableOwner && sameDigest)
      || (compatibleCrossDigest && (sameStableOwner || compatibleLegacyOwner || durableAdoption))
    );
    if (!observation || !stableBinding
      || (!exactNonTransferable && !transferableOwner)) {
      throw new Error('Page observation is unavailable for this signed Operation resource owner and Connector binding.');
    }
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
        if (frame === this.pageOf(observation).mainFrame()) {
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
    const page = this.pageOf(observation);
    page.on('request', observation.listeners.request);
    page.on('response', observation.listeners.response);
    page.on('framenavigated', observation.listeners.navigation);
    page.on('close', observation.listeners.close);
  }

  private detach(observation: Observation): void {
    if (!observation.page) return;
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
        mainFrame: frame === this.pageOf(observation).mainFrame()
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
    const appended = this.streams.append(observation.owner, observation.streamId, bytes);
    observation.writtenBytes = appended.nextOffset;
    observation.lastSequence = envelope.sequence;
    observation.eventCount += 1;
    observation.updatedAt = envelope.occurredAt;
    this.persist(observation);
  }

  private omission(observation: Observation, reason: string, frame = this.pageOf(observation).mainFrame(), details: Record<string, unknown> = {}): void {
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
    if (observation.timer) clearTimeout(observation.timer);
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
    }, this.pageOf(observation).mainFrame());
    observation.state = observation.complete ? 'stopped' : 'failed';
    observation.stoppedAt = now();
    observation.updatedAt = observation.stoppedAt;
    observation.finishing = false;
    this.persist(observation);
    this.streams.finalize(observation.owner, observation.streamId, observation.state === 'stopped' && observation.complete && observation.omissionCount === 0);
    this.persist(observation);
  }

  private frameId(observation: Observation, frame: Frame): string {
    const existing = observation.frameIds.get(frame);
    if (existing) return existing;
    const frameId = opaqueId('frame');
    observation.frameIds.set(frame, frameId);
    return frameId;
  }

  private requestFrame(observation: Observation, request: Request): Frame {
    try { return request.frame(); } catch { return this.pageOf(observation).mainFrame(); }
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

  private pageOf(observation: Observation): Page {
    if (!observation.page || observation.page.isClosed()) {
      throw new Error('Active page observation no longer has a controlled Omnia page.');
    }
    return observation.page;
  }

  private sameStableBinding(left: ConnectorBinding, right: ConnectorBinding): boolean {
    return left.connectorId === right.connectorId
      && left.engagementId === right.engagementId
      && String(left.authorityInstanceId || '') === String(right.authorityInstanceId || '')
      && String(left.tenantOrOrgId || '') === String(right.tenantOrOrgId || '')
      && String(left.packId || '') === String(right.packId || '');
  }

  private persist(observation: Observation): void {
    const expiresAt = this.streams.streamExpiresAt(observation.streamId);
    if (!expiresAt) throw new Error('Page observation stream retention metadata is unavailable.');
    const value = {
      schemaVersion: OBSERVATION_METADATA_SCHEMA,
      observationId: observation.observationId,
      owner: observation.owner,
      idempotencyKey: observation.idempotencyKey,
      streamId: observation.streamId,
      policyId: observation.policyId,
      binding: observation.binding,
      state: observation.state,
      startedAt: observation.startedAt,
      updatedAt: observation.updatedAt,
      stoppedAt: observation.stoppedAt,
      lastSequence: observation.lastSequence,
      eventCount: observation.eventCount,
      omissionCount: observation.omissionCount,
      complete: observation.complete,
      terminalReason: observation.terminalReason,
      writtenBytes: observation.writtenBytes,
      expiresAt
    };
    const filename = path.join(this.metadataRoot, `${observation.observationId}.json`);
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(value));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, filename);
  }

  private loadPersistedObservations(): void {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.metadataRoot, { withFileTypes: true }); }
    catch { this.inventoryUnknownCount += 1; return; }
    const timestamp = now();
    for (const entry of entries) {
      if (!entry.isFile() || !/^observation_[0-9a-f]{32}\.json$/u.test(entry.name)) continue;
      const filename = path.join(this.metadataRoot, entry.name);
      try {
        const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, any>;
        exactKeys(value, [
          'schemaVersion', 'observationId', 'owner', 'idempotencyKey', 'streamId', 'policyId', 'binding',
          'state', 'startedAt', 'updatedAt', 'stoppedAt', 'lastSequence', 'eventCount', 'omissionCount',
          'complete', 'terminalReason', 'writtenBytes', 'expiresAt'
        ], 'Page observation metadata');
        if (value.schemaVersion !== OBSERVATION_METADATA_SCHEMA || !OBSERVATION_ID.test(value.observationId)
          || !/^stream_[0-9a-f]{32}$/u.test(value.streamId)
          || value.policyId !== CURRENT_PACK_PAGE_OBSERVATION_POLICY
          || !['observing', 'paused', 'stopped', 'failed'].includes(value.state)
          || !Number.isSafeInteger(value.lastSequence) || value.lastSequence < 0
          || !Number.isSafeInteger(value.eventCount) || value.eventCount < 0
          || !Number.isSafeInteger(value.omissionCount) || value.omissionCount < 0
          || value.eventCount !== value.lastSequence
          || typeof value.complete !== 'boolean'
          || !Number.isSafeInteger(value.writtenBytes) || value.writtenBytes < 0
          || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.updatedAt))
          || !Number.isFinite(Date.parse(value.expiresAt))) {
          throw new Error('Page observation metadata fields are invalid.');
        }
        if (Date.parse(value.expiresAt) <= Date.now()) {
          this.streams.audit('page_observation', value.observationId, 'ttl_expired', { expiresAt: value.expiresAt });
          fs.rmSync(filename, { force: true });
          continue;
        }
        if (!this.streams.hasReadableStream(value.streamId)) {
          this.inventoryUnknownCount += 1;
          this.streams.audit('page_observation', value.observationId, 'stream_integrity_unavailable', { streamId: value.streamId });
          continue;
        }
        const owner = value.owner as ManagedStreamOwner;
        if (!owner || typeof owner !== 'object' || !this.sameStableBinding(owner.binding, value.binding)) {
          throw new Error('Page observation owner binding is invalid.');
        }
        const recoveredActive = !['stopped', 'failed'].includes(value.state);
        const observation = {
          observationId: value.observationId,
          owner,
          idempotencyKey: value.idempotencyKey,
          streamId: value.streamId,
          policyId: value.policyId,
          page: null,
          binding: value.binding,
          allowedOrigins: new Set<string>(),
          state: recoveredActive ? 'failed' : value.state,
          startedAt: value.startedAt,
          updatedAt: recoveredActive ? timestamp : value.updatedAt,
          stoppedAt: recoveredActive ? timestamp : value.stoppedAt,
          lastSequence: value.lastSequence,
          eventCount: value.eventCount,
          omissionCount: recoveredActive ? value.omissionCount + 1 : value.omissionCount,
          complete: recoveredActive ? false : value.complete,
          terminalReason: recoveredActive ? 'connector_restarted' : value.terminalReason,
          writtenBytes: value.writtenBytes,
          finishing: false,
          frameIds: new WeakMap<Frame, string>(),
          requestIds: new WeakMap<Request, string>(),
          nextRequestId: 0,
          pending: new Set<Promise<void>>(),
          timer: null,
          listeners: {} as Observation['listeners']
        } satisfies Observation;
        observation.listeners = this.listeners(observation);
        this.observations.set(observation.observationId, observation);
        this.idempotency.set(`${observation.owner.ownerKey}:${observation.idempotencyKey}`, observation.observationId);
        if (recoveredActive) {
          this.persist(observation);
          this.streams.audit('page_observation', observation.observationId, 'cold_restart_failed_active_observation', {
            streamId: observation.streamId
          });
        }
      } catch (error) {
        this.inventoryUnknownCount += 1;
        this.streams.audit('page_observation_metadata', entry.name, 'metadata_fail_closed', {
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        });
      }
    }
  }
}
