import type {
  ConnectorOperation,
  ConnectorRequest,
  ConnectorResponse
} from '../connector/contracts.js';

const schemaVersion = 'omnia.connector-ipc/v1' as const;
const operations = new Set<ConnectorOperation>([
  'health',
  'connect',
  'refresh',
  'status',
  'workspace_authority_read',
  'recording_command',
  'operation_register',
  'operation_invoke'
]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function responseId(value: unknown): string {
  if (!record(value)) return 'invalid-request';
  const id = value.id;
  return typeof id === 'string' && id.length <= 128 ? id : 'invalid-request';
}

export class ConnectorWireError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly requestId: string
  ) {
    super(message);
    this.name = 'ConnectorWireError';
  }
}

export function validateConnectorWireRequest(value: unknown): ConnectorRequest {
  const id = responseId(value);
  if (!record(value)) throw new ConnectorWireError('CONNECTOR.INVALID_REQUEST', 'Connector 请求必须是对象。', id);
  if (value.schemaVersion !== schemaVersion) {
    throw new ConnectorWireError('CONNECTOR.INVALID_SCHEMA', 'Connector 请求 schemaVersion 不受支持。', id);
  }
  if (
    typeof value.id !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id)
  ) throw new ConnectorWireError('CONNECTOR.INVALID_ID', 'Connector 请求 ID 无效。', id);
  if (typeof value.operation !== 'string' || !operations.has(value.operation as ConnectorOperation)) {
    throw new ConnectorWireError('CONNECTOR.UNKNOWN_OPERATION', 'Connector operation 不在只读白名单中。', id);
  }
  if (!record(value.payload)) {
    throw new ConnectorWireError('CONNECTOR.INVALID_PAYLOAD', 'Connector payload 必须是对象。', id);
  }
  const operation = value.operation as ConnectorOperation;
  const keys = Object.keys(value.payload);
  if (operation === 'workspace_authority_read') {
    if (
      keys.length !== 1
      || keys[0] !== 'expectedEngagementId'
      || typeof value.payload.expectedEngagementId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.payload.expectedEngagementId)
      || value.payload.expectedEngagementId.toLowerCase() === '00000000-0000-0000-0000-000000000000'
    ) {
      throw new ConnectorWireError(
        'CONNECTOR.INVALID_PAYLOAD',
        'workspace_authority_read requires the sole exact expectedEngagementId UUID.',
        id
      );
    }
  } else if (operation === 'recording_command') {
    const payload = value.payload;
    const binding = record(payload.connectorBinding) ? payload.connectorBinding : null;
    if (
      payload.schemaVersion !== 'omnia.v5.recording-command/v1'
      || payload.featureId !== 'omnia.recording'
      || typeof payload.featureVersion !== 'string'
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(payload.featureVersion)
      || !['status', 'start', 'pause', 'resume', 'stop', 'export', 'export_chunk', 'stop_export', 'cancel', 'capture_current_gra_catalog'].includes(String(payload.kind || ''))
      || !binding
      || typeof binding.connectorId !== 'string'
      || !binding.connectorId
      || !Number.isSafeInteger(binding.sessionGeneration)
      || Number(binding.sessionGeneration) <= 0
      || typeof binding.engagementId !== 'string'
      || !binding.engagementId
      || (payload.recordingId !== undefined && (typeof payload.recordingId !== 'string' || !payload.recordingId))
      || (payload.chunkIndex !== undefined && (!Number.isSafeInteger(payload.chunkIndex) || Number(payload.chunkIndex) < 0))
      || (payload.kind === 'export_chunk' && payload.chunkIndex === undefined)
      || keys.some((key) => !['schemaVersion', 'featureId', 'featureVersion', 'kind', 'connectorBinding', 'recordingId', 'chunkIndex'].includes(key))
    ) throw new ConnectorWireError('CONNECTOR.INVALID_PAYLOAD', 'recording_command payload 不符合签名 Feature 合同。', id);
  } else if (operation === 'operation_register') {
    if (value.payload.schemaVersion !== 'omnia.operation-registration/v1') {
      throw new ConnectorWireError('CONNECTOR.INVALID_PAYLOAD', 'operation_register payload schemaVersion 不受支持。', id);
    }
  } else if (operation === 'operation_invoke') {
    if (value.payload.schemaVersion !== 'omnia.operation-invocation/v1') {
      throw new ConnectorWireError('CONNECTOR.INVALID_PAYLOAD', 'operation_invoke payload schemaVersion 不受支持。', id);
    }
  } else if (keys.length !== 0) {
    throw new ConnectorWireError('CONNECTOR.INVALID_PAYLOAD', `${operation} 不接受 payload 字段。`, id);
  }
  return value as unknown as ConnectorRequest;
}

function failed(id: string, code: string, message: string, retryable = false): ConnectorResponse {
  return {
    schemaVersion,
    id,
    ok: false,
    error: { code, message, retryable }
  };
}

export class RemoteCommandGate {
  private readonly running = new Map<string, ConnectorOperation>();
  private readonly maximumConcurrency = 4;
  private readonly exclusiveOperations = new Set<ConnectorOperation>([
    'connect',
    'refresh',
    'workspace_authority_read',
    'recording_command',
    'operation_register',
    'operation_invoke'
  ]);

  get active(): boolean { return this.running.size > 0; }
  get activeCount(): number { return this.running.size; }
  isActive(requestId: string): boolean { return this.running.has(requestId); }

  async handle(
    raw: unknown,
    dispatch: (request: ConnectorRequest) => Promise<unknown>
  ): Promise<ConnectorResponse> {
    let request: ConnectorRequest;
    try {
      request = validateConnectorWireRequest(raw);
    } catch (error) {
      const wire = error instanceof ConnectorWireError ? error : null;
      return failed(
        wire?.requestId || responseId(raw),
        wire?.code || 'CONNECTOR.INVALID_REQUEST',
        wire?.message || 'Connector 请求无效。'
      );
    }
    if (this.running.has(request.id)) {
      return failed(
        request.id,
        'CONNECTOR.DUPLICATE_IN_FLIGHT',
        '相同 Connector request ID 已在执行，未重复分发。',
        true
      );
    }
    const exclusive = this.exclusiveOperations.has(request.operation);
    const exclusiveAlreadyRunning = [...this.running.values()].some((operation) => this.exclusiveOperations.has(operation));
    if (this.running.size >= this.maximumConcurrency || (exclusive && this.running.size > 0) || exclusiveAlreadyRunning) {
      return failed(request.id, 'CONNECTOR.BUSY', 'Remote Connector 已达到受控并发上限。', true);
    }
    this.running.set(request.id, request.operation);
    try {
      return {
        schemaVersion,
        id: request.id,
        ok: true,
        value: await dispatch(request)
      };
    } catch (error) {
      const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
      return failed(
        request.id,
        typeof candidate?.code === 'string' ? candidate.code : 'CONNECTOR.OPERATION_FAILED',
        typeof candidate?.message === 'string' && candidate.message.trim()
          ? candidate.message
          : 'Remote Connector 操作失败。',
        candidate?.retryable === true
      );
    } finally {
      this.running.delete(request.id);
    }
  }
}
