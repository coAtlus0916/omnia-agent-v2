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
  private readonly queued: Array<QueuedCommand> = [];
  private readonly queuedById = new Map<string, QueuedCommand>();
  private readonly maximumConcurrency = 4;
  private readonly maximumQueueDepth = 64;
  private readonly maximumQueueWaitMs = 30_000;
  private readonly exclusiveOperations = new Set<ConnectorOperation>([
    'connect',
    'refresh',
    'workspace_authority_read',
    'recording_command',
    'operation_register',
    'operation_invoke'
  ]);

  get active(): boolean { return this.activeCount > 0; }
  get activeCount(): number { return this.running.size + this.queued.length; }
  isActive(requestId: string): boolean {
    return this.running.has(requestId) || this.queuedById.has(requestId);
  }

  cancel(requestId: string): boolean {
    const command = this.queuedById.get(requestId);
    if (!command) return false;
    this.removeQueued(command);
    command.resolve(failed(
      requestId,
      'REMOTE.CANCELLED',
      'Remote Connector 命令在分发前已取消。',
      false
    ));
    this.pump();
    return true;
  }

  async handle(
    raw: unknown,
    dispatch: (request: ConnectorRequest) => Promise<unknown>,
    deadlineAt?: string
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
    if (this.isActive(request.id)) {
      return failed(
        request.id,
        'CONNECTOR.DUPLICATE_IN_FLIGHT',
        '相同 Connector request ID 已在执行，未重复分发。',
        true
      );
    }
    if (this.queued.length >= this.maximumQueueDepth) {
      return failed(request.id, 'CONNECTOR.BUSY', 'Remote Connector 有界等待队列已满。', true);
    }
    const remoteDeadline = Date.parse(deadlineAt || '');
    const waitUntil = Math.min(
      Date.now() + this.maximumQueueWaitMs,
      Number.isFinite(remoteDeadline) ? remoteDeadline : Number.POSITIVE_INFINITY
    );
    if (waitUntil <= Date.now()) {
      return failed(request.id, 'REMOTE.DEADLINE_EXCEEDED', '命令在 Connector 分发前已超时。', true);
    }
    return new Promise<ConnectorResponse>((resolve) => {
      const command: QueuedCommand = {
        request,
        dispatch,
        exclusive: this.exclusiveOperations.has(request.operation),
        resolve,
        timer: undefined
      };
      const timer = setTimeout(() => {
        if (!this.queuedById.has(request.id)) return;
        this.removeQueued(command);
        resolve(failed(request.id, 'REMOTE.DEADLINE_EXCEEDED', '命令等待 Connector 分发时已超时。', true));
        this.pump();
      }, Math.max(1, waitUntil - Date.now()));
      command.timer = timer;
      timer.unref();
      this.queued.push(command);
      this.queuedById.set(request.id, command);
      this.pump();
    });
  }

  private pump(): void {
    if (this.hasRunningExclusive()) return;
    while (this.queued.length > 0 && this.running.size < this.maximumConcurrency) {
      const next = this.queued[0];
      if (!next) return;
      if (next.exclusive && this.running.size > 0) return;
      this.removeQueued(next);
      this.start(next);
      if (next.exclusive) return;
    }
  }

  private start(command: QueuedCommand): void {
    const { request } = command;
    this.running.set(request.id, request.operation);
    void Promise.resolve().then(() => command.dispatch(request)).then(
      (value) => command.resolve({ schemaVersion, id: request.id, ok: true, value }),
      (error) => {
        const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
        command.resolve(failed(
          request.id,
          typeof candidate?.code === 'string' ? candidate.code : 'CONNECTOR.OPERATION_FAILED',
          typeof candidate?.message === 'string' && candidate.message.trim()
            ? candidate.message
            : 'Remote Connector 操作失败。',
          candidate?.retryable === true
        ));
      }
    ).finally(() => {
      this.running.delete(request.id);
      this.pump();
    });
  }

  private hasRunningExclusive(): boolean {
    return [...this.running.values()].some((operation) => this.exclusiveOperations.has(operation));
  }

  private removeQueued(command: QueuedCommand): void {
    const index = this.queued.indexOf(command);
    if (index >= 0) this.queued.splice(index, 1);
    this.queuedById.delete(command.request.id);
    clearTimeout(command.timer);
  }
}

interface QueuedCommand {
  request: ConnectorRequest;
  dispatch: (request: ConnectorRequest) => Promise<unknown>;
  exclusive: boolean;
  resolve: (response: ConnectorResponse) => void;
  timer: NodeJS.Timeout | undefined;
}
