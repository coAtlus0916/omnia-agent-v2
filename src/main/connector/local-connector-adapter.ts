import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ConnectorConnection,
  ConnectorRequest,
  ConnectorResponse,
  RecordingCommandRequest,
  ConnectorWorkspaceLightRead
} from '../../connector/contracts.js';
import type { ConnectionSnapshot, WorkspaceObservation } from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type {
  OperationInvocationRequest,
  OperationRegistrationRequest,
  OperationRegistrationResult
} from '../../shared/operation-contracts.js';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  operation: ConnectorRequest['operation'];
}

export class LocalConnectorAdapter {
  readonly mode = 'local' as const;
  private process: ChildProcess | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly connectorEntrypoint: string,
    private readonly dataRoot: string
  ) {}

  async start(): Promise<void> {
    if (this.process?.connected) return;
    const child = spawn(process.execPath, [this.connectorEntrypoint], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OMNIA_AGENT_DATA_ROOT: this.dataRoot
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
    this.process = child;
    child.on('message', (message) => this.handleMessage(message as ConnectorResponse));
    child.on('exit', () => this.handleExit());
    child.on('error', () => this.handleExit());
    await this.call('health', {}, 10_000);
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (child && !child.killed) child.kill();
    this.handleExit();
  }

  private handleMessage(response: ConnectorResponse): void {
    if (!response || response.schemaVersion !== 'omnia.connector-ipc/v1') return;
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.ok) request.resolve(response.value);
    else request.reject(new AppError(
      response.error?.code || 'CONNECTOR.ERROR',
      response.error?.message || 'Local Connector 操作失败。',
      response.error?.retryable === true
    ));
  }

  private handleExit(): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new AppError('CONNECTOR.PROCESS_EXITED', 'Local Connector 进程已退出。', true));
      this.pending.delete(id);
    }
  }

  private async call(operation: ConnectorRequest['operation'], payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (!this.process?.connected) {
      await this.start();
      if (!this.process?.connected) throw new AppError('CONNECTOR.UNAVAILABLE', 'Local Connector 进程不可用。', true);
    }
    const id = randomUUID();
    const request: ConnectorRequest = {
      schemaVersion: 'omnia.connector-ipc/v1',
      id,
      operation,
      payload
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('CONNECTOR.TIMEOUT', 'Local Connector 响应超时。', true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, operation });
      this.process!.send(request, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppError('CONNECTOR.SEND_FAILED', '无法向 Local Connector 发送请求。', true));
      });
    });
  }

  private map(raw: ConnectorConnection): ConnectionSnapshot {
    return {
      transport: 'local',
      adapter: 'v5_local_connector',
      adapterAvailable: true,
      adapterReason: '',
      remoteAvailable: false,
      remoteReason: 'Remote Bridge 身份、配对和端到端传输依赖尚未部署，因此未开放。',
      status: raw.status,
      connected: raw.connected,
      connecting: raw.connecting,
      connectorId: raw.connectorId,
      connectorName: raw.connectorName,
      connectorVersion: raw.connectorVersion,
      sessionGeneration: raw.sessionGeneration,
      engagementId: raw.engagementId,
      engagementName: raw.engagementName,
      clientName: raw.clientName,
      checkedAt: raw.checkedAt,
      message: raw.message
    };
  }

  unavailableSnapshot(reason: string): ConnectionSnapshot {
    return {
      transport: 'local',
      adapter: 'v5_local_connector',
      adapterAvailable: false,
      adapterReason: reason,
      remoteAvailable: false,
      remoteReason: 'Remote Bridge 身份、配对和端到端传输依赖尚未部署，因此未开放。',
      status: 'not_configured',
      connected: false,
      connecting: false,
      connectorId: '',
      connectorName: 'Omnia Agent v5 Local Connector',
      connectorVersion: '',
      sessionGeneration: 0,
      engagementId: '',
      engagementName: '',
      clientName: '',
      checkedAt: new Date().toISOString(),
      message: reason
    };
  }

  async load(): Promise<ConnectionSnapshot> {
    try {
      return this.map(await this.call('status', {}, 15_000) as ConnectorConnection);
    } catch (error) {
      return this.unavailableSnapshot(error instanceof Error ? error.message : 'Local Connector 不可用。');
    }
  }

  async connect(): Promise<ConnectionSnapshot> {
    return this.map(await this.call('connect', {}, 90_000) as ConnectorConnection);
  }

  async cancelConnect(): Promise<void> {
    // Local connect may already be opening the user-visible controlled Edge. The
    // Shell ignores its late result; killing the Connector would also destroy
    // unrelated operation state and is intentionally avoided.
  }

  async refresh(): Promise<ConnectionSnapshot> {
    return this.map(await this.call('refresh', {}, 90_000) as ConnectorConnection);
  }

  async lightRead(expectedEngagementId: string): Promise<WorkspaceObservation> {
    const raw = await this.call(
      'workspace_light_read',
      { expectedEngagementId },
      90_000
    ) as ConnectorWorkspaceLightRead;
    if (raw.schemaVersion !== 'omnia.workspace-light-read/v1' || raw.profile !== 'workspace_light_read') {
      throw new AppError('WORKSPACE.INVALID_CONTRACT', 'Local Connector 返回了不兼容的轻抓取合同。');
    }
    return {
      observationId: randomUUID(),
      profile: 'workspace_light_read',
      authorityId: raw.authorityId,
      engagementId: raw.engagementId,
      capturedAt: new Date().toISOString(),
      source: raw.source,
      coverage: 'full',
      sections: raw.sections,
      workspaces: raw.workspaces
    };
  }

  async registerOperation(input: OperationRegistrationRequest): Promise<OperationRegistrationResult> {
    return this.call('operation_register', input as unknown as Record<string, unknown>, 30_000);
  }

  async recordingCommand(input: RecordingCommandRequest): Promise<unknown> {
    return this.call('recording_command', input as unknown as Record<string, unknown>, 180_000);
  }

  async invokeOperation(input: OperationInvocationRequest): Promise<unknown> {
    return this.call('operation_invoke', input as unknown as Record<string, unknown>, 120_000);
  }
}
