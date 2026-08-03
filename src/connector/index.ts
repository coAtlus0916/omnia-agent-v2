import type { ConnectorRequest, ConnectorResponse } from './contracts.js';
import { ConnectorOperationError, LocalConnector } from './local-connector.js';

const dataRoot = String(process.env.OMNIA_AGENT_DATA_ROOT || '').trim();
if (!dataRoot) throw new Error('OMNIA_AGENT_DATA_ROOT is required.');
const connector = new LocalConnector(dataRoot);

async function dispatch(request: ConnectorRequest): Promise<unknown> {
  switch (request.operation) {
    case 'health': return connector.health();
    case 'connect': return connector.connect();
    case 'refresh': return connector.refresh();
    case 'status': return connector.status();
    case 'workspace_light_read':
      return connector.workspaceLightRead(String(request.payload.expectedEngagementId || ''));
    case 'recording_command':
      return connector.recordingCommand(request.payload as any);
    case 'operation_register':
      return connector.registerOperation(request.payload as any);
    case 'operation_invoke':
      return connector.invokeOperation(request.payload as any);
    default:
      throw new ConnectorOperationError('CONNECTOR.UNKNOWN_OPERATION', 'Connector rejected an unknown operation.');
  }
}

process.on('message', (value: ConnectorRequest) => {
  if (!value || value.schemaVersion !== 'omnia.connector-ipc/v1' || !value.id) return;
  void dispatch(value).then((result) => {
    const response: ConnectorResponse = {
      schemaVersion: 'omnia.connector-ipc/v1',
      id: value.id,
      ok: true,
      value: result
    };
    process.send?.(response);
  }).catch((error) => {
    const operationError = error instanceof ConnectorOperationError ? error : null;
    const response: ConnectorResponse = {
      schemaVersion: 'omnia.connector-ipc/v1',
      id: value.id,
      ok: false,
      error: {
        code: operationError?.code || 'CONNECTOR.OPERATION_FAILED',
        message: error instanceof Error ? error.message : 'Connector 操作失败。',
        retryable: operationError?.retryable === true
      }
    };
    process.send?.(response);
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void connector.close().finally(() => process.exit(0)); });
}
process.on('disconnect', () => { void connector.close().finally(() => process.exit(0)); });
