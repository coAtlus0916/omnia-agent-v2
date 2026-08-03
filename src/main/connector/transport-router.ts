import type { ConnectionSnapshot, WorkspaceObservation } from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
import type { CoreDatabase } from '../database.js';
import type { ConnectorTransport } from './connector-transport.js';
import type {
  OperationInvocationRequest,
  OperationRegistrationRequest,
  OperationRegistrationResult
} from '../../shared/operation-contracts.js';
import type { RecordingCommandRequest } from '../../connector/contracts.js';

export class ConnectorTransportRouter implements ConnectorTransport {
  constructor(
    private readonly database: CoreDatabase,
    private readonly local: ConnectorTransport,
    private readonly remote: ConnectorTransport
  ) {}

  get mode(): 'local' | 'remote' {
    return this.database.getConnectionSettings().mode;
  }

  private active(): ConnectorTransport {
    return this.mode === 'remote' ? this.remote : this.local;
  }

  async start(): Promise<void> {
    if (this.mode === 'local') {
      await this.local.start();
      return;
    }
    try {
      await this.remote.start();
    } catch {
      // The selected Remote mode remains authoritative. load() exposes the real
      // offline/configuration state; Local is deliberately not started as fallback.
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.local.stop(), this.remote.stop()]);
  }

  unavailableSnapshot(reason: string): ConnectionSnapshot {
    return this.active().unavailableSnapshot(reason);
  }

  load(): Promise<ConnectionSnapshot> { return this.active().load(); }
  connect(): Promise<ConnectionSnapshot> { return this.active().connect(); }
  cancelConnect(): Promise<void> { return this.active().cancelConnect(); }
  refresh(): Promise<ConnectionSnapshot> { return this.active().refresh(); }
  lightRead(expectedEngagementId: string): Promise<WorkspaceObservation> {
    return this.active().lightRead(expectedEngagementId);
  }
  recordingCommand(input: RecordingCommandRequest): Promise<unknown> {
    return this.active().recordingCommand(input);
  }
  registerOperation(input: OperationRegistrationRequest): Promise<OperationRegistrationResult> {
    return this.active().registerOperation(input);
  }
  invokeOperation(input: OperationInvocationRequest): Promise<unknown> {
    return this.active().invokeOperation(input);
  }

  async switchMode(mode: 'local' | 'remote', expectedStateVersion: number): Promise<void> {
    const target = mode === 'remote' ? this.remote : this.local;
    if (mode === 'remote' && !this.database.getConnectionSettings().remoteToken) {
      throw new AppError('REMOTE.NOT_PAIRED', '请先完成 Remote Bridge 配对。');
    }
    try {
      await target.start();
      let snapshot = await target.load();
      if (mode === 'remote') {
        const deadline = Date.now() + 20_000;
        while (
          !snapshot.adapterAvailable
          && /offline|离线|matching|匹配/i.test(`${snapshot.adapterReason} ${snapshot.message}`)
          && Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          snapshot = await target.load();
        }
      }
      if (!snapshot.adapterAvailable) {
        throw new AppError('CONNECTOR.MODE_UNAVAILABLE', snapshot.adapterReason || `${mode} Connector 不可用。`, true);
      }
    } catch (error) {
      // A failed candidate must not remain alive beside the still-authoritative
      // transport. stop() is best-effort here; the original validation error wins.
      await target.stop().catch(() => undefined);
      throw error;
    }
    this.database.saveConnectionMode(mode, expectedStateVersion);
    const inactive = mode === 'remote' ? this.local : this.remote;
    await inactive.stop();
  }
}
