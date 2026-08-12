import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  CONNECTOR_NEXT_AGENT_PROCESS,
  CONNECTOR_NEXT_BOOTSTRAP_PROCESS,
  CONNECTOR_NEXT_HEALTH_OPERATION,
  CONNECTOR_NEXT_INSTALLER_PROCESS,
  CONNECTOR_NEXT_OPERATION_EXECUTE,
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_PROTOCOL_ID,
  CONNECTOR_NEXT_UPDATER_PROCESS,
  type ConnectorNextDescriptor,
  type ConnectorNextTarget
} from '../protocol.js';

export function connectorNextExecutionSubject(): string {
  return createHash('sha256').update(`${os.userInfo().username}\0${os.hostname()}\0connector-next/v3`).digest('hex');
}

export function connectorNextDescriptor(target: ConnectorNextTarget, version: string, sequence: number, generation: number): ConnectorNextDescriptor {
  return {
    ...target,
    productId: CONNECTOR_NEXT_PRODUCT_ID,
    protocolId: CONNECTOR_NEXT_PROTOCOL_ID,
    version,
    sequence,
    generation,
    capabilities: [CONNECTOR_NEXT_HEALTH_OPERATION, CONNECTOR_NEXT_OPERATION_EXECUTE],
    executionPrincipal: { kind: 'os_user', subjectHash: connectorNextExecutionSubject(), processName: CONNECTOR_NEXT_AGENT_PROCESS }
  };
}

export function connectorNextUpdaterDescriptor(target: ConnectorNextTarget, version: string, sequence: number, generation: number): ConnectorNextDescriptor {
  return {
    ...connectorNextDescriptor(target, version, sequence, generation),
    executionPrincipal: { kind: 'os_user', subjectHash: connectorNextExecutionSubject(), processName: CONNECTOR_NEXT_UPDATER_PROCESS }
  };
}

export function connectorNextBootstrapDescriptor(target: ConnectorNextTarget, version: string, sequence: number, generation: number): ConnectorNextDescriptor {
  return {
    ...connectorNextDescriptor(target, version, sequence, generation),
    executionPrincipal: { kind: 'os_user', subjectHash: connectorNextExecutionSubject(), processName: CONNECTOR_NEXT_BOOTSTRAP_PROCESS }
  };
}

export function connectorNextInstallerDescriptor(target: ConnectorNextTarget, version: string, sequence: number, generation: number): ConnectorNextDescriptor {
  return {
    ...connectorNextDescriptor(target, version, sequence, generation),
    executionPrincipal: { kind: 'os_user', subjectHash: connectorNextExecutionSubject(), processName: CONNECTOR_NEXT_INSTALLER_PROCESS }
  };
}
