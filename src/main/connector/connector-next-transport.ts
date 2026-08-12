import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ConnectorConnection } from '../../connector/contracts.js';
import {
  CONNECTOR_NEXT_OPERATION_ENVELOPE_SCHEMA,
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_PROTOCOL_ID,
  type ConnectorNextOperationCommand,
  type ConnectorNextOperationEnvelope,
  type ConnectorNextPackBinding,
  type ConnectorNextTarget,
  samePackBinding,
  sameTarget
} from '../../connector-next/protocol.js';
import type { ConnectionSnapshot, WorkspaceObservation } from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type { OperationInvocationRequest, OperationRegistrationCommand, OperationRegistrationResult } from '../../shared/operation-contracts.js';
import {
  assertConnectorDeliveryContext,
  assertConnectorDeliveryStatusRequest,
  connectorResultDigest,
  type ConnectorDeliveryAck,
  type ConnectorDeliveryStatusRequest,
  type ConnectorDeliveryStatusResult
} from '../../shared/connector-delivery.js';
import { normalizeWorkspaceAuthorityRead } from '../services/workspace-authority.js';
import type { ConnectorInvocationDelivery, ConnectorTransport, WorkspaceAuthorityExpectation } from './connector-transport.js';
import { ConnectorNextControlClient } from './connector-next-control-client.js';

export interface ConnectorNextTransportConfig {
  serverUrl: string;
  controlToken: string;
  target: ConnectorNextTarget;
}

interface DurableJob {
  status?: string;
  result?: unknown;
  error?: { code?: string; details?: { message?: string }; effectState?: 'not_started' | 'unknown' };
}

interface OperationResult {
  schemaVersion: 'omnia.connector-next-operation-result/v1';
  requestId: string;
  command: ConnectorNextOperationCommand;
  target: ConnectorNextTarget;
  descriptor: { productId: string; protocolId: string; version: string; sequence: number; generation: number };
  value: unknown;
}

function connectionBinding(value: ConnectorConnection): ConnectorNextPackBinding | null {
  if (!value.connected || value.status !== 'connected' || !value.connectorId || !value.engagementId
    || !value.authorityInstanceId || !value.packId || !Number.isSafeInteger(value.sessionGeneration) || value.sessionGeneration < 1) return null;
  return {
    connectorId: value.connectorId,
    sessionGeneration: value.sessionGeneration,
    engagementId: value.engagementId,
    authorityInstanceId: value.authorityInstanceId,
    tenantOrOrgId: value.tenantOrOrgId || '',
    packId: value.packId
  };
}

export class ConnectorNextTransport implements ConnectorTransport {
  readonly mode = 'remote' as const;
  readonly bindingMode = 'connector_next_enrollment' as const;
  private readonly events = new EventEmitter();
  private stopped = false;
  private client: ConnectorNextControlClient | null = null;
  private configIdentity = '';
  private packBinding: ConnectorNextPackBinding | null = null;
  private connectorVersion = '';

  constructor(private readonly config: () => ConnectorNextTransportConfig) {}

  onStateChanged(listener: () => void): () => void {
    this.events.on('state', listener);
    return () => this.events.off('state', listener);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.ensureClient();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.client = null;
    this.packBinding = null;
  }

  private ensureClient(): ConnectorNextControlClient {
    if (this.stopped) throw new AppError('CONNECTOR_NEXT.TRANSPORT_STOPPED', 'Connector Next transport is stopped.', true);
    const config = this.config();
    if (!config.serverUrl || !config.controlToken) throw new AppError('CONNECTOR_NEXT.NOT_CONFIGURED', 'Connector Next control endpoint is not configured.', true);
    const identity = `${config.serverUrl}|${config.target.agentId}|${config.target.deviceId}|${config.target.connectorInstanceId}`;
    if (!this.client || identity !== this.configIdentity) {
      this.client = new ConnectorNextControlClient({ serverUrl: config.serverUrl, controlToken: config.controlToken });
      this.configIdentity = identity;
      this.packBinding = null;
    }
    return this.client;
  }

  private async call(command: ConnectorNextOperationCommand, input: Record<string, unknown>, timeoutMs: number, packBinding = this.packBinding, effect: 'read_only' | 'mutation' = 'read_only'): Promise<unknown> {
    const config = this.config();
    const envelope: ConnectorNextOperationEnvelope = {
      schemaVersion: CONNECTOR_NEXT_OPERATION_ENVELOPE_SCHEMA,
      requestId: `ocn3.request.${randomUUID()}`,
      target: config.target,
      command,
      effect,
      ...(packBinding ? { packBinding } : {}),
      input
    };
    const client = this.ensureClient();
    let jobId = '';
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !jobId; attempt += 1) {
      try { jobId = (await client.enqueueOperation(envelope, Math.max(1, Math.ceil(timeoutMs / 1000)))).jobId; }
      catch (error) { lastError = error; }
    }
    if (!jobId) throw lastError;
    const job = await client.waitForJob(jobId, timeoutMs) as DurableJob;
    if (job.status === 'succeeded') {
      const result = job.result as OperationResult;
      if (result?.schemaVersion !== 'omnia.connector-next-operation-result/v1'
        || result.requestId !== envelope.requestId || result.command !== command
        || !sameTarget(result.target, config.target)
        || result.descriptor?.productId !== CONNECTOR_NEXT_PRODUCT_ID || result.descriptor?.protocolId !== CONNECTOR_NEXT_PROTOCOL_ID) {
        throw new AppError('CONNECTOR_NEXT.RESULT_IDENTITY_MISMATCH', 'Connector Next returned a mismatched durable result.', false);
      }
      this.connectorVersion = result.descriptor.version;
      return result.value;
    }
    if (job.status === 'failed') {
      if (effect === 'mutation' && job.error?.effectState === 'not_started') {
        throw new AppError(
          'CONNECTOR_NEXT.MUTATION_NOT_STARTED',
          job.error?.details?.message || 'Connector Next proved that the mutation did not start.',
          false
        );
      }
      throw new AppError(job.error?.code || 'CONNECTOR_NEXT.OPERATION_FAILED', job.error?.details?.message || 'Connector Next operation failed.', false);
    }
    throw new AppError('CONNECTOR_NEXT.OPERATION_TIMEOUT', 'Connector Next operation did not reach a durable terminal result before its deadline.', true);
  }

  private map(raw: ConnectorConnection): ConnectionSnapshot {
    const binding = connectionBinding(raw);
    this.packBinding = binding;
    this.connectorVersion = raw.connectorVersion || this.connectorVersion;
    return {
      transport: 'remote', adapter: 'connector_next_v3', adapterAvailable: true, adapterReason: '',
      remoteAvailable: true, remoteReason: '', bridgeOnline: true, connectorOnline: true,
      protocolCompatible: true, bindingState: 'bound', ...raw
    };
  }

  unavailableSnapshot(reason: string): ConnectionSnapshot {
    const configured = (() => {
      try { const value = this.config(); return Boolean(value.serverUrl && value.controlToken); } catch { return false; }
    })();
    return {
      transport: 'remote', adapter: 'connector_next_v3', adapterAvailable: configured,
      adapterReason: configured ? '' : reason, remoteAvailable: configured, remoteReason: configured ? '' : reason,
      bridgeOnline: false, connectorOnline: false, protocolCompatible: true,
      bindingState: configured ? 'bound' : 'unpaired', status: 'connector_offline', connected: false, connecting: false,
      connectorId: configured ? this.config().target.connectorInstanceId : '', connectorName: 'Omnia Agent Connector Next',
      connectorVersion: this.connectorVersion, engagementId: '', engagementName: '', clientName: '',
      checkedAt: new Date().toISOString(), message: reason
    };
  }

  async load(): Promise<ConnectionSnapshot> {
    try { return this.map(await this.call('pack.session.status', {}, 30_000, null) as ConnectorConnection); }
    catch (error) { return this.unavailableSnapshot(error instanceof Error ? error.message : 'Connector Next is unavailable.'); }
  }

  async connect(): Promise<ConnectionSnapshot> {
    return this.map(await this.call('pack.session.connect', {}, 90_000, null) as ConnectorConnection);
  }

  async cancelConnect(): Promise<void> {
    // The durable read-only connect request is allowed to finish; cancelling
    // only affects the Shell wait and never kills the controlled browser.
  }

  async refresh(): Promise<ConnectionSnapshot> {
    return this.map(await this.call('pack.session.refresh', {}, 30_000, null) as ConnectorConnection);
  }

  async lightRead(expected: WorkspaceAuthorityExpectation): Promise<WorkspaceObservation> {
    if (!this.packBinding || !samePackBinding(this.packBinding, expected)) throw new AppError('CONNECTOR_NEXT.PACK_BINDING_CHANGED', 'Connector Next Pack binding no longer matches Core authority.', false);
    const raw = await this.call('pack.workspace-authority.read', { expectedEngagementId: expected.engagementId }, 90_000);
    return normalizeWorkspaceAuthorityRead(raw, expected);
  }

  async registerOperation(input: OperationRegistrationCommand): Promise<OperationRegistrationResult> {
    if (!this.packBinding) throw new AppError('CONNECTOR_NEXT.PACK_NOT_CONNECTED', 'Connector Next Pack is not connected.', true);
    return this.call('operation.register', input as unknown as Record<string, unknown>, 30_000) as Promise<OperationRegistrationResult>;
  }

  async invokeOperation(input: OperationInvocationRequest): Promise<unknown> {
    if (!this.packBinding) throw new AppError('CONNECTOR_NEXT.PACK_NOT_CONNECTED', 'Connector Next Pack is not connected.', true);
    if (input.mutationAuthorized !== false) throw new AppError('CONNECTOR_NEXT.DURABLE_MUTATION_REQUIRED', 'Connector Next mutations require a durable delivery witness.', false);
    return this.call('operation.invoke', input as unknown as Record<string, unknown>, 120_000);
  }

  supportsDurableDelivery(): boolean {
    const [major = -1, minor = -1, patch = -1] = this.connectorVersion.split('.').map(Number);
    return major > 0 || minor > 1 || (minor === 1 && patch >= 6);
  }

  async invokeOperationWithWitness(input: OperationInvocationRequest): Promise<ConnectorInvocationDelivery> {
    if (!this.packBinding) throw new AppError('CONNECTOR_NEXT.PACK_NOT_CONNECTED', 'Connector Next Pack is not connected.', true);
    if (!this.supportsDurableDelivery()) throw new AppError('CONNECTOR_NEXT.DURABLE_DELIVERY_UNAVAILABLE', 'Current Connector Next generation does not support durable delivery.', true);
    assertConnectorDeliveryContext(input.deliveryContext);
    const raw = await this.call(
      'operation.invoke', input as unknown as Record<string, unknown>, 120_000, this.packBinding,
      input.mutationAuthorized === true ? 'mutation' : 'read_only'
    ) as Record<string, unknown>;
    const witness = raw?.witness as ConnectorInvocationDelivery['witness'] | undefined;
    const wireResponse = raw?.wireResponse as Record<string, unknown> | undefined;
    const deliveryError = raw?.error as ConnectorInvocationDelivery['error'] | undefined;
    if (raw?.schemaVersion !== 'omnia.connector-next-durable-delivery/v1' || typeof raw.ok !== 'boolean' || !witness || !wireResponse
      || witness.schemaVersion !== 'omnia.connector-delivery-witness/v1'
      || witness.requestId !== input.deliveryContext.requestId
      || witness.sessionGeneration !== input.deliveryContext.sessionGeneration
      || connectorResultDigest(wireResponse) !== witness.resultDigest
      || wireResponse.ok !== raw.ok
      || (raw.ok === false && (!deliveryError || typeof deliveryError.code !== 'string'
        || typeof deliveryError.message !== 'string' || typeof deliveryError.retryable !== 'boolean'))) {
      throw new AppError('CONNECTOR_NEXT.DELIVERY_WITNESS_INVALID', 'Connector Next returned an invalid durable delivery witness.', false);
    }
    return raw.ok === true
      ? { ok: true, value: raw.value, wireResponse, witness }
      : { ok: false, value: undefined, error: deliveryError!, wireResponse, witness };
  }

  async deliveryStatus(input: ConnectorDeliveryStatusRequest): Promise<ConnectorDeliveryStatusResult> {
    assertConnectorDeliveryStatusRequest(input);
    return this.ensureClient().deliveryStatus(input);
  }

  async acknowledgeDelivery(input: ConnectorDeliveryAck): Promise<{ acknowledged: true; clearedMutationCount: number }> {
    return this.ensureClient().acknowledgeDelivery(input);
  }
}
