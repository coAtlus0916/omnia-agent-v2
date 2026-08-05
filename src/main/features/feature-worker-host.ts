import { createRequire } from 'node:module';

type IpcRequest = {
  schemaVersion: 'omnia.feature-worker-ipc/v1';
  type: 'invoke';
  id: string;
  method: string;
  input: unknown;
};

type PortName = 'connector.invoke' | 'store.call' | 'events.emit';

let activeInvocationId = '';
let portSequence = 0;
const pendingPorts = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();

function send(message: object): void {
  if (!process.send) throw new Error('Feature worker IPC channel is unavailable.');
  process.send(message);
}

function portCall(port: PortName, payload: unknown): Promise<any> {
  const id = `${process.pid}:${++portSequence}`;
  return new Promise((resolve, reject) => {
    pendingPorts.set(id, { resolve, reject });
    send({
      schemaVersion: 'omnia.feature-worker-ipc/v1',
      type: 'port_call',
      id,
      invocationId: activeInvocationId,
      port,
      payload
    });
  });
}

const workerPath = process.argv[2];
if (!workerPath) throw new Error('Feature worker module path is required.');
const required = createRequire(__filename)(workerPath) as {
  createFeatureWorker?: (ports: object) => Record<string, (input: any) => unknown>;
};
if (typeof required.createFeatureWorker !== 'function') {
  throw new Error('Feature worker must export createFeatureWorker(ports).');
}

const worker = required.createFeatureWorker({
  connector: {
    invoke: (invocation: unknown) => portCall('connector.invoke', invocation)
  },
  store: {
    call: (method: string, input: unknown) => portCall('store.call', { method, input }),
    append: (input: unknown) => portCall('store.call', { method: 'appendEvidence', input }),
    appendEvidence: (input: unknown) => portCall('store.call', { method: 'appendEvidence', input }),
    upsertManagedContent: (input: unknown) => portCall('store.call', { method: 'upsertManagedContent', input }),
    savePlan: (input: unknown) => portCall('store.call', { method: 'savePlan', input }),
    loadPlan: (input: unknown) => portCall('store.call', { method: 'loadPlan', input })
  },
  events: {
    emit: (input: unknown) => portCall('events.emit', input)
  }
});

let queue = Promise.resolve();
process.on('message', (message: any) => {
  if (!message || message.schemaVersion !== 'omnia.feature-worker-ipc/v1') return;
  if (message.type === 'port_result') {
    const pending = pendingPorts.get(String(message.id));
    if (!pending) return;
    pendingPorts.delete(String(message.id));
    if (message.ok) pending.resolve(message.value);
    else pending.reject(Object.assign(new Error(message.error?.message || 'Feature port call failed.'), {
      code: message.error?.code || 'FEATURE.PORT_FAILED',
      retryable: message.error?.retryable === true
    }));
    return;
  }
  if (message.type !== 'invoke') return;
  const request = message as IpcRequest;
  queue = queue.then(async () => {
    activeInvocationId = request.id;
    try {
      const method = worker[request.method];
      if (typeof method !== 'function') throw new Error(`Feature worker method is not exposed: ${request.method}`);
      const value = await method.call(worker, request.input);
      send({ schemaVersion: 'omnia.feature-worker-ipc/v1', type: 'result', id: request.id, ok: true, value });
    } catch (error) {
      const typed = error as Error & { code?: string; retryable?: boolean };
      send({
        schemaVersion: 'omnia.feature-worker-ipc/v1',
        type: 'result',
        id: request.id,
        ok: false,
        error: {
          code: typed.code || 'FEATURE.WORKER_FAILED',
          message: typed.message || 'Feature worker call failed.',
          retryable: typed.retryable === true
        }
      });
    } finally {
      activeInvocationId = '';
    }
  });
});

process.on('disconnect', () => {
  const deadline = setTimeout(() => process.exit(0), 5_000);
  deadline.unref();
  const shutdown = worker.shutdown;
  void Promise.resolve(typeof shutdown === 'function' ? shutdown.call(worker, null) : undefined)
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
});
send({ schemaVersion: 'omnia.feature-worker-ipc/v1', type: 'ready' });
