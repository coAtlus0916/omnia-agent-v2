import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import type { InteractionContext } from '../../shared/interaction-log-contracts.js';

export interface FeatureWorkerPortContext {
  featureId: string;
  featureVersion: string;
  allowMutation: boolean;
  interactionContext?: InteractionContext;
}

export interface FeatureWorkerPorts {
  connectorInvoke(input: unknown, context: FeatureWorkerPortContext): Promise<unknown>;
  storeCall(method: string, input: unknown, context: FeatureWorkerPortContext): Promise<unknown>;
  emitEvent(input: unknown, context: FeatureWorkerPortContext): Promise<unknown>;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class FeatureWorkerSupervisor {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private readonly invocationMutation = new Map<string, boolean>();
  private readonly invocationContexts = new Map<string, InteractionContext | undefined>();

  constructor(
    private readonly hostEntrypoint: string,
    private readonly workerPath: string,
    private readonly featureId: string,
    private readonly featureVersion: string,
    private readonly ports: FeatureWorkerPorts
  ) {}

  async start(): Promise<void> {
    if (this.child?.connected && this.ready) return this.ready;
    const child = spawn(process.execPath, [this.hostEntrypoint, this.workerPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
    this.child = child;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError('FEATURE.WORKER_START_TIMEOUT', 'Feature worker 启动超时。', true)), 10_000);
      const onMessage = (message: any) => {
        if (message?.schemaVersion === 'omnia.feature-worker-ipc/v1' && message.type === 'ready') {
          clearTimeout(timer);
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
    });
    child.on('message', (message) => { void this.handleMessage(message as any); });
    child.on('exit', () => this.handleExit());
    child.on('error', () => this.handleExit());
    return this.ready;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child && !child.killed) child.kill();
    this.handleExit();
  }

  async invoke(method: string, input: unknown, options: { allowMutation?: boolean; timeoutMs?: number; interactionContext?: InteractionContext } = {}): Promise<any> {
    await this.start();
    if (!this.child?.connected) throw new AppError('FEATURE.WORKER_UNAVAILABLE', 'Feature worker 不可用。', true);
    const id = randomUUID();
    this.invocationMutation.set(id, options.allowMutation === true);
    this.invocationContexts.set(id, options.interactionContext);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const mutation = this.invocationMutation.get(id) === true;
        this.pending.delete(id);
        this.invocationMutation.delete(id);
        this.invocationContexts.delete(id);
        if (mutation) {
          const timedOutChild=this.child;this.child=null;this.ready=null;
          if(timedOutChild&&!timedOutChild.killed) timedOutChild.kill();
          this.handleExit();
          reject(new AppError('FEATURE.WORKER_TIMEOUT', 'Mutation Feature worker timed out and was terminated; retry is forbidden until durable recovery classifies the Run.', false));
        } else reject(new AppError('FEATURE.WORKER_TIMEOUT', 'Feature worker 响应超时。', true));
      }, options.timeoutMs || 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.send({
        schemaVersion: 'omnia.feature-worker-ipc/v1',
        type: 'invoke',
        id,
        method,
        input
      });
    });
  }

  private async handleMessage(message: any): Promise<void> {
    if (!message || message.schemaVersion !== 'omnia.feature-worker-ipc/v1') return;
    if (message.type === 'port_call') {
      const context: FeatureWorkerPortContext = {
        featureId: this.featureId,
        featureVersion: this.featureVersion,
        allowMutation: this.invocationMutation.get(String(message.invocationId)) === true,
        ...(this.invocationContexts.get(String(message.invocationId))
          ? { interactionContext: this.invocationContexts.get(String(message.invocationId))! }
          : {})
      };
      try {
        let value: unknown;
        if (message.port === 'connector.invoke') value = await this.ports.connectorInvoke(message.payload, context);
        else if (message.port === 'store.call') value = await this.ports.storeCall(String(message.payload?.method || ''), message.payload?.input, context);
        else if (message.port === 'events.emit') value = await this.ports.emitEvent(message.payload, context);
        else throw new AppError('FEATURE.PORT_DENIED', 'Feature 请求了未注册的端口。');
        this.child?.send({ schemaVersion: 'omnia.feature-worker-ipc/v1', type: 'port_result', id: message.id, ok: true, value });
      } catch (error) {
        const typed = error as Error & { code?: string; retryable?: boolean };
        this.child?.send({
          schemaVersion: 'omnia.feature-worker-ipc/v1', type: 'port_result', id: message.id, ok: false,
          error: { code: typed.code || 'FEATURE.PORT_FAILED', message: typed.message, retryable: typed.retryable === true }
        });
      }
      return;
    }
    if (message.type !== 'result') return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    this.invocationMutation.delete(String(message.id));
    this.invocationContexts.delete(String(message.id));
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new AppError(
      message.error?.code || 'FEATURE.WORKER_FAILED',
      message.error?.message || 'Feature worker 执行失败。',
      message.error?.retryable === true
    ));
  }

  private handleExit(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new AppError('FEATURE.WORKER_EXITED', 'Feature worker 进程已退出。', true));
      this.pending.delete(id);
      this.invocationMutation.delete(id);
      this.invocationContexts.delete(id);
    }
  }
}
