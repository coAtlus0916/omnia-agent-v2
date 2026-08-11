import crypto from 'node:crypto';

export interface ConnectorDeliveryContext {
  schemaVersion: 'omnia.connector-delivery-context/v1';
  requestId: string;
  featureId: string;
  featureVersion: string;
  operationId: string;
  operationPackageDigest: string;
  runId: string;
  commandId: string;
  connectorId: string;
  sessionGeneration: number;
  purpose: 'mutation' | 'readback' | 'reconcile' | 'recovery';
}

export interface ConnectorDeliveryWitness {
  schemaVersion: 'omnia.connector-delivery-witness/v1';
  requestId: string;
  resultDigest: string;
  sessionGeneration: number;
  executionGeneration: string;
}

export interface ConnectorDeliveryAck {
  schemaVersion: 'omnia.connector-delivery-ack/v1';
  ackId: string;
  deliveredRequestId: string;
  resultDigest: string;
  connectorId: string;
  sessionGeneration: number;
  executionGeneration: string;
  featureId: string;
  featureVersion: string;
  operationId: string;
  operationPackageDigest: string;
  runId: string;
  commandId: string;
  receiptId: string;
  receiptResponseDigest: string;
  resolution: 'receipt_committed' | 'readback_verified' | 'closed_not_applied';
  effectOutcome: 'applied' | 'not_applied' | null;
  reconciles: {
    requestId: string;
    featureId: string;
    featureVersion: string;
    operationId: string;
    operationPackageDigest: string;
    connectorId: string;
    sessionGeneration: number;
    executionGeneration: string;
  } | null;
}

export interface ConnectorDeliveryStatusRequest {
  schemaVersion: 'omnia.connector-delivery-status-request/v1';
  requestId: string;
  featureId: string;
  featureVersion: string;
  operationId: string;
  operationPackageDigest: string;
  runId: string;
  commandId: string;
  connectorId: string;
  sessionGeneration: number;
}

export interface ConnectorDeliveryStatusResult extends Omit<ConnectorDeliveryStatusRequest, 'schemaVersion'> {
  schemaVersion: 'omnia.connector-delivery-status-result/v1';
  state: 'not_found' | 'running' | 'delivery_pending' | 'receipt_committed' | 'effect_uncertain';
  executionGeneration: string;
  resultDigest: string;
  /** Canonical full ConnectorResponse (without the delivery witness), retained for exact recovery. */
  responseJson: string;
}

export function assertConnectorDeliveryStatusRequest(value: unknown): asserts value is ConnectorDeliveryStatusRequest {
  if (!record(value)
    || Object.keys(value).sort().join('|') !== [
      'schemaVersion', 'requestId', 'featureId', 'featureVersion', 'operationId', 'operationPackageDigest',
      'runId', 'commandId', 'connectorId', 'sessionGeneration'
    ].sort().join('|')
    || value.schemaVersion !== 'omnia.connector-delivery-status-request/v1'
    || typeof value.requestId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.requestId)
    || typeof value.featureId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value.featureId)
    || typeof value.featureVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.featureVersion)
    || typeof value.operationId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,191}$/u.test(value.operationId)
    || typeof value.operationPackageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.operationPackageDigest)
    || typeof value.runId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.runId)
    || typeof value.commandId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.commandId)
    || typeof value.connectorId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.connectorId)
    || !Number.isSafeInteger(value.sessionGeneration) || Number(value.sessionGeneration) <= 0) {
    throw new Error('Connector delivery status request is invalid.');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertStrictJson(value: unknown, location = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`Non-canonical JSON number at ${location}.`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`Sparse JSON array at ${location}.`);
      assertStrictJson(value[index], `${location}[${index}]`);
    }
    return;
  }
  if (!record(value)) throw new Error(`Non-JSON value at ${location}.`);
  const prototype = Object.getPrototypeOf(value);
  // Signed Operation handlers execute in an isolated VM realm. Their object
  // literals have that realm's Object.prototype, so reference equality with
  // this realm is not a valid JSON-domain test. Keep class instances rejected
  // while accepting ordinary object literals from any realm.
  if (prototype !== null && prototype !== Object.prototype
    && prototype?.constructor?.name !== 'Object') throw new Error(`Non-plain JSON object at ${location}.`);
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) throw new Error(`Undefined JSON property at ${location}.${key}.`);
    assertStrictJson(item, `${location}.${key}`);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

export function connectorResultDigest(value: unknown): string {
  assertStrictJson(value);
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  if (record(normalized) && Object.prototype.hasOwnProperty.call(normalized, 'delivery')) delete normalized.delivery;
  return crypto.createHash('sha256').update(canonical(normalized)).digest('hex');
}

export function canonicalConnectorResponse(value: unknown): string {
  assertStrictJson(value);
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  if (record(normalized) && Object.prototype.hasOwnProperty.call(normalized, 'delivery')) delete normalized.delivery;
  return canonical(normalized);
}

export function assertConnectorDeliveryContext(value: unknown): asserts value is ConnectorDeliveryContext {
  if (!record(value)
    || Object.keys(value).sort().join('|') !== [
      'schemaVersion', 'requestId', 'featureId', 'featureVersion', 'operationId', 'operationPackageDigest',
      'runId', 'commandId', 'connectorId', 'sessionGeneration', 'purpose'
    ].sort().join('|')
    || value.schemaVersion !== 'omnia.connector-delivery-context/v1'
    || typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,35}$/iu.test(value.requestId)
    || typeof value.featureId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value.featureId)
    || typeof value.featureVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.featureVersion)
    || typeof value.operationId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,191}$/u.test(value.operationId)
    || typeof value.operationPackageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.operationPackageDigest)
    || typeof value.runId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.runId)
    || typeof value.commandId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.commandId)
    || typeof value.connectorId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.connectorId)
    || !Number.isSafeInteger(value.sessionGeneration) || Number(value.sessionGeneration) <= 0
    || !['mutation', 'readback', 'reconcile', 'recovery'].includes(String(value.purpose || ''))) {
    throw new Error('Connector delivery context is invalid.');
  }
}

function validReconciliation(value: unknown): boolean {
  return value === null || (record(value)
    && Object.keys(value).sort().join('|') === [
      'requestId', 'featureId', 'featureVersion', 'operationId', 'operationPackageDigest',
      'connectorId', 'sessionGeneration', 'executionGeneration'
    ].sort().join('|')
    && typeof value.requestId === 'string' && /^[0-9a-f-]{36}$/iu.test(value.requestId)
    && typeof value.featureId === 'string' && /^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value.featureId)
    && typeof value.featureVersion === 'string' && /^\d+\.\d+\.\d+$/u.test(value.featureVersion)
    && typeof value.operationId === 'string' && /^[a-z0-9][a-z0-9._-]{2,191}$/u.test(value.operationId)
    && typeof value.operationPackageDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.operationPackageDigest)
    && typeof value.connectorId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value.connectorId)
    && Number.isSafeInteger(value.sessionGeneration) && Number(value.sessionGeneration) > 0
    && typeof value.executionGeneration === 'string' && /^[a-f0-9]{48}$/u.test(value.executionGeneration));
}

export function assertConnectorDeliveryAck(value: unknown): asserts value is ConnectorDeliveryAck {
  if (!record(value)
    || Object.keys(value).sort().join('|') !== [
      'schemaVersion', 'ackId', 'deliveredRequestId', 'resultDigest', 'connectorId', 'sessionGeneration', 'executionGeneration',
      'featureId', 'featureVersion', 'operationId', 'operationPackageDigest', 'runId', 'commandId',
      'receiptId', 'receiptResponseDigest', 'resolution', 'effectOutcome', 'reconciles'
    ].sort().join('|')
    || value.schemaVersion !== 'omnia.connector-delivery-ack/v1'
    || typeof value.ackId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,35}$/iu.test(value.ackId)
    || typeof value.deliveredRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,35}$/iu.test(value.deliveredRequestId)
    || typeof value.resultDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.resultDigest)
    || typeof value.connectorId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.connectorId)
    || !Number.isSafeInteger(value.sessionGeneration) || Number(value.sessionGeneration) <= 0
    || typeof value.executionGeneration !== 'string' || !/^[a-f0-9]{48}$/u.test(value.executionGeneration)
    || typeof value.featureId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value.featureId)
    || typeof value.featureVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.featureVersion)
    || typeof value.operationId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,191}$/u.test(value.operationId)
    || typeof value.operationPackageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.operationPackageDigest)
    || typeof value.runId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.runId)
    || typeof value.commandId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.commandId)
    || typeof value.receiptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,35}$/iu.test(value.receiptId)
    || typeof value.receiptResponseDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.receiptResponseDigest)
    || !['receipt_committed', 'readback_verified', 'closed_not_applied'].includes(String(value.resolution || ''))
    || ![null, 'applied', 'not_applied'].includes(value.effectOutcome as null | string)
    || (value.resolution === 'receipt_committed' && (value.effectOutcome !== null || value.reconciles !== null))
    || (value.resolution === 'readback_verified' && value.effectOutcome !== 'applied')
    || (value.resolution === 'closed_not_applied' && value.effectOutcome !== 'not_applied')
    || !validReconciliation(value.reconciles)
    || (value.resolution !== 'receipt_committed' && value.reconciles === null)) {
    throw new Error('Connector delivery acknowledgement is invalid.');
  }
}
