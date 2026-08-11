import os from 'node:os';
import process from 'node:process';
import {
  CONNECTOR_NEXT_HEALTH_OPERATION,
  CONNECTOR_NEXT_OPERATION_EXECUTE,
  assertOperationEnvelope,
  sameTarget,
  type ConnectorNextDescriptor,
  type ConnectorNextJob
} from '../protocol.js';
import type { ConnectorNextPackOperationExecutor } from './pack-operation-host.js';
import { connectorResultDigest, canonicalConnectorResponse, assertConnectorDeliveryContext } from '../../shared/connector-delivery.js';

export async function executeConnectorNextReadOnlyJob(
  job: ConnectorNextJob,
  descriptor: ConnectorNextDescriptor,
  packOperations?: ConnectorNextPackOperationExecutor,
  executionGeneration = ''
): Promise<Record<string, unknown>> {
  if (!['read_only', 'mutation'].includes(job.effect)) throw new Error('CONNECTOR_NEXT.OPERATION_NOT_ALLOWED');
  if (Date.parse(job.deadlineAt) <= Date.now()) throw new Error('CONNECTOR_NEXT.JOB_DEADLINE_EXPIRED');
  if (!sameTarget(job.target, descriptor)) throw new Error('CONNECTOR_NEXT.JOB_TARGET_MISMATCH');
  if (job.operation === CONNECTOR_NEXT_OPERATION_EXECUTE) {
    assertOperationEnvelope(job.payload);
    if (!packOperations) throw new Error('CONNECTOR_NEXT.PACK_OPERATION_HOST_UNAVAILABLE');
    const value = await packOperations.execute(job.payload, descriptor);
    const invocation = job.payload.command === 'operation.invoke'
      ? job.payload.input as Record<string, unknown>
      : null;
    let deliveredValue: unknown = value;
    if (invocation?.deliveryContext !== undefined) {
      assertConnectorDeliveryContext(invocation.deliveryContext);
      if (!/^[a-f0-9]{48}$/u.test(executionGeneration)) throw new Error('CONNECTOR_NEXT.EXECUTION_GENERATION_INVALID');
      const wireResponse = {
        schemaVersion: 'omnia.connector-ipc/v1',
        id: invocation.deliveryContext.requestId,
        ok: true,
        value
      };
      deliveredValue = {
        schemaVersion: 'omnia.connector-next-durable-delivery/v1',
        ok: true,
        value,
        wireResponse: JSON.parse(canonicalConnectorResponse(wireResponse)),
        witness: {
          schemaVersion: 'omnia.connector-delivery-witness/v1',
          requestId: invocation.deliveryContext.requestId,
          resultDigest: connectorResultDigest(wireResponse),
          sessionGeneration: invocation.deliveryContext.sessionGeneration,
          executionGeneration
        }
      };
    }
    return {
      schemaVersion: 'omnia.connector-next-operation-result/v1',
      requestId: job.payload.requestId,
      command: job.payload.command,
      target: job.payload.target,
      descriptor: {
        productId: descriptor.productId,
        protocolId: descriptor.protocolId,
        version: descriptor.version,
        sequence: descriptor.sequence,
        generation: descriptor.generation,
        executionPrincipal: descriptor.executionPrincipal
      },
      completedAt: new Date().toISOString(),
      value: deliveredValue
    };
  }
  if (job.operation !== CONNECTOR_NEXT_HEALTH_OPERATION) throw new Error('CONNECTOR_NEXT.OPERATION_NOT_ALLOWED');
  return {
    schemaVersion: 'omnia.connector-next-system-health/v1',
    productId: descriptor.productId,
    protocolId: descriptor.protocolId,
    agentId: descriptor.agentId,
    deviceId: descriptor.deviceId,
    connectorInstanceId: descriptor.connectorInstanceId,
    version: descriptor.version,
    sequence: descriptor.sequence,
    generation: descriptor.generation,
    capabilities: descriptor.capabilities,
    executionPrincipal: descriptor.executionPrincipal,
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      uptimeSeconds: Math.floor(os.uptime()),
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem()
    },
    observedAt: new Date().toISOString()
  };
}
