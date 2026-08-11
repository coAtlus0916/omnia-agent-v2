import type { ConnectorConnection } from '../../connector/contracts.js';
import { ConnectorOperationError, WorkstationOmniaSession } from '../../connector/workstation-omnia-session.js';
import type { OperationInvocationRequest, OperationRegistrationCommand } from '../../shared/operation-contracts.js';
import {
  type ConnectorNextDescriptor,
  type ConnectorNextOperationEnvelope,
  type ConnectorNextPackBinding,
  assertPackBinding,
  assertOperationEnvelope,
  samePackBinding,
  sameTarget
} from '../protocol.js';
import { ConnectorNextShellFeatureHost } from './shell-feature-host.js';

export interface ConnectorNextPackOperationExecutor {
  execute(envelope: ConnectorNextOperationEnvelope, descriptor: ConnectorNextDescriptor): Promise<unknown>;
  close(): Promise<void>;
}

export type ConnectorNextPackSession = Pick<WorkstationOmniaSession,
  'close' | 'status' | 'connect' | 'refresh' | 'workspaceAuthorityRead' | 'registerOperation' | 'invokeOperation'>;

function bindingFrom(connection: ConnectorConnection): ConnectorNextPackBinding {
  if (!connection.connected || connection.status !== 'connected'
    || !Number.isSafeInteger(connection.sessionGeneration) || connection.sessionGeneration < 1
    || !connection.connectorId || !connection.engagementId || !connection.authorityInstanceId || !connection.packId) {
    throw new Error('CONNECTOR_NEXT.PACK_NOT_CONNECTED');
  }
  return {
    connectorId: connection.connectorId,
    sessionGeneration: connection.sessionGeneration,
    engagementId: connection.engagementId,
    authorityInstanceId: connection.authorityInstanceId,
    tenantOrOrgId: connection.tenantOrOrgId || '',
    packId: connection.packId
  };
}

export class ConnectorNextPackOperationHost implements ConnectorNextPackOperationExecutor {
  private readonly session: ConnectorNextPackSession;
  private readonly shell = new ConnectorNextShellFeatureHost();
  private reconnecting: Promise<ConnectorNextPackBinding> | null = null;

  constructor(
    dataRoot: string,
    descriptor: ConnectorNextDescriptor,
    fetchImpl: typeof fetch = fetch,
    private readonly audit: (event: string, details: Record<string, unknown>) => void = () => undefined,
    sessionOverride?: ConnectorNextPackSession
  ) {
    this.session = sessionOverride || new WorkstationOmniaSession(dataRoot, fetchImpl, {
      id: descriptor.connectorInstanceId,
      name: 'Omnia Agent Connector Next',
      version: descriptor.version
    });
  }

  async close(): Promise<void> {
    await this.shell.close();
    await this.session.close();
  }

  private async reconnectExact(expected: ConnectorNextPackBinding): Promise<ConnectorNextPackBinding> {
    if (!this.reconnecting) {
      this.reconnecting = this.session.connect(expected.engagementId)
        .then(bindingFrom)
        .finally(() => { this.reconnecting = null; });
    }
    const observed = await this.reconnecting;
    if (!samePackBinding(observed, expected)) throw new Error('CONNECTOR_NEXT.PACK_BINDING_CHANGED');
    return observed;
  }

  private recoverableBeforeEffect(error: unknown, readOnly: boolean): boolean {
    if (!(error instanceof ConnectorOperationError)) return false;
    if (readOnly && error.retryable) return true;
    return new Set([
      'CONNECTOR.AUTH_REQUIRED',
      'CONNECTOR.TARGET_UNAVAILABLE',
      'CONNECTOR.PACK_NOT_OPEN',
      'WORKSPACE.READ_TIMEOUT'
    ]).has(error.code);
  }

  private async withReconnect<T>(expected: ConnectorNextPackBinding, readOnly: boolean, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (!this.recoverableBeforeEffect(error, readOnly)) throw error;
      const code = error instanceof ConnectorOperationError ? error.code : 'CONNECTOR_NEXT.PACK_CONNECTION_LOST';
      this.audit('pack.reconnect.started', { code, engagementId: expected.engagementId, readOnly });
      try {
        await this.reconnectExact(expected);
        const result = await operation();
        this.audit('pack.reconnect.succeeded', { code, engagementId: expected.engagementId, readOnly });
        return result;
      } catch (reconnectError) {
        this.audit('pack.reconnect.failed', {
          code,
          engagementId: expected.engagementId,
          readOnly,
          reconnectCode: reconnectError instanceof ConnectorOperationError ? reconnectError.code : 'CONNECTOR_NEXT.PACK_RECONNECT_FAILED'
        });
        throw reconnectError;
      }
    }
  }

  private async assertCurrentBinding(expected: ConnectorNextPackBinding): Promise<void> {
    const observed = bindingFrom(await this.session.status());
    if (!samePackBinding(observed, expected)) throw new Error('CONNECTOR_NEXT.PACK_BINDING_CHANGED');
  }

  async execute(envelope: ConnectorNextOperationEnvelope, descriptor: ConnectorNextDescriptor): Promise<unknown> {
    assertOperationEnvelope(envelope);
    if (!sameTarget(envelope.target, descriptor)) throw new Error('CONNECTOR_NEXT.OPERATION_TARGET_MISMATCH');
    if (envelope.command === 'pack.session.status') return this.session.status();
    if (envelope.command === 'pack.session.connect') {
      return this.session.connect(String(envelope.input.expectedEngagementId || ''));
    }
    if (envelope.command === 'pack.session.refresh') return this.session.refresh();
    if (envelope.command === 'shell.runtime.restart-with-control') return this.shell.restartWithControl(envelope.input);

    const expected = envelope.packBinding;
    if (!expected) throw new Error('CONNECTOR_NEXT.PACK_BINDING_REQUIRED');
    let result: unknown;
    if (envelope.command === 'pack.workspace-authority.read') {
      if (String(envelope.input.expectedEngagementId || '') !== expected.engagementId) throw new Error('CONNECTOR_NEXT.WORKSPACE_AUTHORITY_TARGET_MISMATCH');
      result = await this.withReconnect(expected, true, () => this.session.workspaceAuthorityRead(expected.engagementId));
    } else if (envelope.command === 'operation.register') {
      await this.assertCurrentBinding(expected);
      result = await this.session.registerOperation(envelope.input as unknown as OperationRegistrationCommand);
    } else if (envelope.command === 'operation.invoke') {
      if ((envelope.input.mutationAuthorized === true) !== (envelope.effect === 'mutation')) {
        throw new Error('CONNECTOR_NEXT.OPERATION_EFFECT_MISMATCH');
      }
      const invocation = envelope.input as unknown as OperationInvocationRequest;
      const requestedBinding = invocation.request?.connectorBinding;
      assertPackBinding(requestedBinding);
      if (!samePackBinding(requestedBinding, expected)) throw new Error('CONNECTOR_NEXT.PACK_BINDING_CHANGED');
      result = await this.withReconnect(expected, envelope.effect === 'read_only', () => this.session.invokeOperation(invocation));
    } else if (envelope.command === 'shell.feature.snapshot.read') {
      await this.assertCurrentBinding(expected);
      result = await this.shell.read(envelope.input, expected);
    } else if (envelope.command === 'shell.feature.action.invoke') {
      await this.assertCurrentBinding(expected);
      result = await this.shell.invoke(envelope.input, expected, envelope.effect);
    } else {
      throw new Error('CONNECTOR_NEXT.OPERATION_COMMAND_NOT_ALLOWED');
    }

    return result;
  }
}
