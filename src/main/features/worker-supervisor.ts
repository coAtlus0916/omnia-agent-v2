import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  recoverInterruption?(input: FeatureWorkerInterruption, context: FeatureWorkerPortContext): Promise<FeatureWorkerInterruptionResult>;
}

export interface FeatureWorkerInterruption {
  schemaVersion: 'omnia.feature-worker-interruption/v1';
  invocationId: string;
  reason: 'exit' | 'error' | 'timeout' | 'stopped';
  effect: 'omnia_mutation';
  actionId: string;
  runId: string;
  commandId: string;
}

export interface FeatureWorkerInterruptionResult {
  schemaVersion: 'omnia.feature-worker-interruption-result/v1';
  classification: 'uncertain' | 'not_started' | 'completed' | 'unresolved';
  retryable: false;
  effectState: 'possibly_started' | 'not_started' | 'completed';
  runId: string;
  commandIds: string[];
}

export interface FeatureWorkerManagedRuntime {
  pythonExecutable: string;
  pythonEntry: string;
  packageRoot: string;
  tempRoot: string;
}

interface InvocationRecoveryContext {
  actionId: string;
  runId: string;
  commandId: string;
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
  private readonly invocationRecovery = new Map<string, InvocationRecoveryContext>();
  private startReject: ((error: Error) => void) | null = null;
  private exitHandling: Promise<void> | null = null;

  constructor(
    private readonly hostEntrypoint: string,
    private readonly workerPath: string,
    private readonly featureId: string,
    private readonly featureVersion: string,
    private readonly ports: FeatureWorkerPorts,
    private readonly managedRuntime?: FeatureWorkerManagedRuntime
  ) {}

  async start(): Promise<void> {
    if (this.child?.connected && this.ready) return this.ready;
    const child = spawn(process.execPath, [this.hostEntrypoint, this.workerPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(this.managedRuntime ? {
          OMNIA_MANAGED_PYTHON_EXECUTABLE: this.managedRuntime.pythonExecutable,
          OMNIA_MANAGED_PYTHON_ENTRY: this.managedRuntime.pythonEntry,
          OMNIA_FEATURE_PACKAGE_ROOT: this.managedRuntime.packageRoot,
          OMNIA_FEATURE_TEMP_ROOT: this.managedRuntime.tempRoot
        } : {})
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
    this.child = child;
    this.ready = new Promise((resolve, reject) => {
      this.startReject = reject;
      const timer = setTimeout(() => {
        this.startReject = null;
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        reject(new AppError('FEATURE.WORKER_START_TIMEOUT', 'Feature worker 启动超时。', true));
        void this.terminateProcessTree(child);
      }, 10_000);
      const onMessage = (message: any) => {
        if (message?.schemaVersion === 'omnia.feature-worker-ipc/v1' && message.type === 'ready') {
          clearTimeout(timer);
          child.off('message', onMessage);
          this.startReject = null;
          resolve();
        }
      };
      child.on('message', onMessage);
    });
    child.on('message', (message) => { void this.handleMessage(message as any); });
    child.on('exit', () => { void this.handleExit('exit'); });
    child.on('error', () => { void this.handleExit('error'); });
    return this.ready;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child) await this.terminateProcessTree(child);
    await this.handleExit('stopped');
  }

  async invoke(method: string, input: unknown, options: {
    allowMutation?: boolean;
    timeoutMs?: number;
    interactionContext?: InteractionContext;
    recovery?: Partial<InvocationRecoveryContext>;
  } = {}): Promise<any> {
    await this.start();
    if (!this.child?.connected) throw new AppError('FEATURE.WORKER_UNAVAILABLE', 'Feature worker 不可用。', true);
    const id = randomUUID();
    this.invocationMutation.set(id, options.allowMutation === true);
    this.invocationContexts.set(id, options.interactionContext);
    this.invocationRecovery.set(id, {
      actionId: String(options.recovery?.actionId || method),
      runId: String(options.recovery?.runId || ''),
      commandId: String(options.recovery?.commandId || '')
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void (async () => {
        const mutation = this.invocationMutation.get(id) === true;
        this.pending.delete(id);
        if (mutation) {
          const timedOutChild = this.child;
          this.child = null;
          this.ready = null;
          if (timedOutChild) await this.terminateProcessTree(timedOutChild);
          const recovery = await this.recoverMutationInterruption(id, 'timeout');
          reject(this.interruptionError('FEATURE.WORKER_TIMEOUT', recovery));
        } else {
          this.clearInvocation(id);
          reject(new AppError('FEATURE.WORKER_TIMEOUT', 'Feature worker 响应超时。', true));
        }
      })();
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
    this.clearInvocation(String(message.id));
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new AppError(
      message.error?.code || 'FEATURE.WORKER_FAILED',
      message.error?.message || 'Feature worker 执行失败。',
      message.error?.retryable === true
    ));
  }

  private clearInvocation(id: string): void {
    this.invocationMutation.delete(id);
    this.invocationContexts.delete(id);
    this.invocationRecovery.delete(id);
  }

  private async recoverMutationInterruption(
    id: string,
    reason: FeatureWorkerInterruption['reason']
  ): Promise<FeatureWorkerInterruptionResult> {
    const recovery = this.invocationRecovery.get(id) || { actionId: '', runId: '', commandId: '' };
    const context: FeatureWorkerPortContext = {
      featureId: this.featureId,
      featureVersion: this.featureVersion,
      allowMutation: true,
      ...(this.invocationContexts.get(id) ? { interactionContext: this.invocationContexts.get(id)! } : {})
    };
    try {
      if (!this.ports.recoverInterruption) {
        return {
          schemaVersion: 'omnia.feature-worker-interruption-result/v1',
          classification: 'unresolved', retryable: false, effectState: 'possibly_started',
          runId: recovery.runId, commandIds: recovery.commandId ? [recovery.commandId] : []
        };
      }
      return await this.ports.recoverInterruption({
        schemaVersion: 'omnia.feature-worker-interruption/v1',
        invocationId: id,
        reason,
        effect: 'omnia_mutation',
        actionId: recovery.actionId,
        runId: recovery.runId,
        commandId: recovery.commandId
      }, context);
    } catch {
      return {
        schemaVersion: 'omnia.feature-worker-interruption-result/v1',
        classification: 'unresolved',
        retryable: false,
        effectState: 'possibly_started',
        runId: recovery.runId,
        commandIds: recovery.commandId ? [recovery.commandId] : []
      };
    } finally {
      this.clearInvocation(id);
    }
  }

  private interruptionError(code: string, recovery: FeatureWorkerInterruptionResult): AppError {
    const message = recovery.classification === 'uncertain'
      ? `Feature worker was interrupted after mutation submission; Run ${recovery.runId || '(unknown)'} is uncertain and only read-only reconcile is allowed.`
      : recovery.classification === 'completed'
        ? `Feature worker was interrupted after durable verified read-back; automatic replay is forbidden for Run ${recovery.runId || '(unknown)'}.`
        : recovery.classification === 'not_started'
          ? `Feature worker was interrupted before a durable mutation submission; explicit continuation is required for Run ${recovery.runId || '(unknown)'}.`
          : 'Feature worker mutation interruption could not be safely classified; automatic replay is forbidden.';
    return new AppError(code, message, false);
  }

  private async handleExit(reason: 'exit' | 'error' | 'stopped'): Promise<void> {
    if (this.exitHandling) return this.exitHandling;
    this.exitHandling = (async () => {
      this.child = null;
      this.ready = null;
      this.startReject?.(new AppError('FEATURE.WORKER_EXITED', 'Feature worker 进程在 ready 之前退出。', true));
      this.startReject = null;
      const entries = [...this.pending.entries()];
      this.pending.clear();
      for (const [id, pending] of entries) {
        clearTimeout(pending.timer);
        if (this.invocationMutation.get(id) === true) {
          const recovery = await this.recoverMutationInterruption(id, reason);
          pending.reject(this.interruptionError('FEATURE.WORKER_EXITED', recovery));
        } else {
          this.clearInvocation(id);
          pending.reject(new AppError('FEATURE.WORKER_EXITED', 'Feature worker 进程已退出。', true));
        }
      }
    })().finally(() => { this.exitHandling = null; });
    return this.exitHandling;
  }

  private async terminateProcessTree(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== 'win32') {
      child.kill('SIGKILL');
      return;
    }
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.resolve(windowsRoot, 'System32', 'taskkill.exe');
    if (!fs.existsSync(taskkill)) {
      child.kill();
      return;
    }
    await new Promise<void>((resolve) => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true
      });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 5_000);
      killer.once('exit', () => { clearTimeout(timer); resolve(); });
      killer.once('error', () => { clearTimeout(timer); child.kill(); resolve(); });
    });
  }
}
