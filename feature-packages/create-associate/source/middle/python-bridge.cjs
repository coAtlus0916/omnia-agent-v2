'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const PROTOCOL = 'omnia.python-sidecar-rpc/v1';
const HANDLE_SCHEMA = 'omnia.python-artifact-handle/v1';
const MANAGED_DISTRIBUTION = 'cpython-3.13.14-embed-amd64';
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const MAX_PENDING_REQUESTS = 64;
const MAX_STDERR_BYTES = 8 * 1024;

function sidecarError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function inside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function assertFile(filename, code, message) {
  if (!path.isAbsolute(filename) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    throw sidecarError(code, message);
  }
  return path.resolve(filename);
}

function extendedWindowsPath(filename) {
  const resolved = path.resolve(filename);
  if (process.platform !== 'win32' || resolved.startsWith('\\\\?\\')) return resolved;
  if (resolved.startsWith('\\\\')) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  return `\\\\?\\${resolved}`;
}

function rejectEmbeddedBinary(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw sidecarError('PYTHON.RPC_CYCLE', 'Python sidecar RPC payload contains a cycle.');
  seen.add(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw sidecarError('PYTHON.RPC_BINARY_EMBEDDED', 'Binary bytes must use a managed Artifact handle; JSON/base64 transfer is forbidden.');
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectEmbeddedBinary(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'contentBase64' || key === 'base64') {
        throw sidecarError('PYTHON.RPC_BASE64_FORBIDDEN', 'Large binary content must use a managed Artifact handle, not base64.');
      }
      rejectEmbeddedBinary(item, seen);
    }
  }
  seen.delete(value);
}

function collectHandles(value, output = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (value.schemaVersion === HANDLE_SCHEMA && typeof value.handleId === 'string') output.add(value.handleId);
  if (Array.isArray(value)) for (const item of value) collectHandles(item, output, seen);
  else for (const item of Object.values(value)) collectHandles(item, output, seen);
  return output;
}

function sanitizeDiagnostic(text, roots) {
  let value = String(text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '').slice(-MAX_STDERR_BYTES);
  for (const root of roots) if (root) value = value.replaceAll(path.resolve(root), '[managed-root]');
  return value;
}

class PythonSidecarBridge {
  constructor(options) {
    if (!options || typeof options !== 'object') throw sidecarError('PYTHON.BRIDGE_OPTIONS_INVALID', 'Python sidecar bridge options are required.');
    this.ports = options.ports;
    if (!this.ports?.connector?.invoke || !this.ports?.store?.call || !this.ports?.events?.emit) {
      throw sidecarError('PYTHON.BRIDGE_PORTS_INVALID', 'Python sidecar bridge requires connector.invoke, store.call, and events.emit ports.');
    }
    this.maxFrameBytes = Number(options.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES);
    this.requestTimeoutMs = Number(options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimeoutMs = Number(options.heartbeatTimeoutMs || DEFAULT_HEARTBEAT_TIMEOUT_MS);
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 64 * 1024 || this.maxFrameBytes > DEFAULT_MAX_FRAME_BYTES) {
      throw sidecarError('PYTHON.RPC_FRAME_POLICY_INVALID', 'Python sidecar max frame policy is invalid.');
    }
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1_000 || this.requestTimeoutMs > 15 * 60_000) {
      throw sidecarError('PYTHON.RPC_TIMEOUT_POLICY_INVALID', 'Python sidecar request timeout policy is invalid.');
    }
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || !Number.isSafeInteger(this.heartbeatTimeoutMs)
      || this.heartbeatIntervalMs < 1_000 || this.heartbeatTimeoutMs < this.heartbeatIntervalMs * 2) {
      throw sidecarError('PYTHON.RPC_HEARTBEAT_POLICY_INVALID', 'Python sidecar heartbeat policy is invalid.');
    }
    const executableEnv = String(process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE || '');
    const entryEnv = String(process.env.OMNIA_MANAGED_PYTHON_ENTRY || '');
    const packageRootEnv = String(process.env.OMNIA_FEATURE_PACKAGE_ROOT || '');
    const tempRootEnv = String(process.env.OMNIA_FEATURE_TEMP_ROOT || '');
    if (![executableEnv, entryEnv, packageRootEnv, tempRootEnv].every((value) => path.isAbsolute(value))) {
      throw sidecarError('PYTHON.RUNTIME_SCOPE_INVALID', 'Managed Python executable, entry, package, and temp roots must be explicit absolute paths.');
    }
    this.pythonExecutable = assertFile(
      executableEnv,
      'PYTHON.RUNTIME_MISSING',
      'Managed CPython 3.13.14 is unavailable; system Python and Anaconda fallback are forbidden.'
    );
    this.pythonEntry = assertFile(
      entryEnv,
      'PYTHON.ENTRY_MISSING',
      'Signed Python sidecar entry is unavailable.'
    );
    this.packageRoot = path.resolve(packageRootEnv);
    this.tempRoot = path.resolve(tempRootEnv);
    if (!this.pythonExecutable.toLowerCase().endsWith(path.join('runtime', 'python', MANAGED_DISTRIBUTION, 'python.exe').toLowerCase())
      || !inside(this.packageRoot, this.pythonEntry)
      || !inside(this.packageRoot, __filename)
      || this.tempRoot === this.packageRoot || inside(this.packageRoot, this.tempRoot)) {
      throw sidecarError('PYTHON.RUNTIME_SCOPE_INVALID', 'Python sidecar runtime, package, or temp scope is invalid.');
    }
    fs.mkdirSync(this.tempRoot, { recursive: true });
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.invocationHandles = new Map();
    this.retainedHandles = new Set();
    this.writeChain = Promise.resolve();
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.heartbeatTimer = null;
    this.lastHeartbeatAckAt = 0;
    this.stderrTail = '';
    this.closing = false;
    this.helloRequestId = '';
  }

  async start() {
    if (this.child && this.readyPromise) return this.readyPromise;
    this.closing = false;
    const runtimeRoot = path.dirname(this.pythonExecutable);
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const env = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe'),
      PATH: `${runtimeRoot};${path.join(systemRoot, 'System32')}`,
      TEMP: this.tempRoot,
      TMP: this.tempRoot,
      PYTHONNOUSERSITE: '1',
      PYTHONSAFEPATH: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
      NO_PROXY: '*',
      no_proxy: '*',
      OMNIA_PYTHON_PROTOCOL: PROTOCOL,
      OMNIA_PYTHON_PACKAGE_ROOT: extendedWindowsPath(this.packageRoot),
      OMNIA_PYTHON_TEMP_ROOT: extendedWindowsPath(this.tempRoot)
    };
    const child = spawn(this.pythonExecutable, ['-I', '-S', '-E', '-u', extendedWindowsPath(this.pythonEntry), '--stdio-rpc'], {
      cwd: extendedWindowsPath(this.tempRoot),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.lastHeartbeatAckAt = Date.now();
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const startupTimer = setTimeout(() => {
      this.fail(sidecarError('PYTHON.START_TIMEOUT', 'Managed Python sidecar did not complete its protocol handshake.', false));
    }, 10_000);
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = sanitizeDiagnostic(`${this.stderrTail}${chunk.toString('utf8')}`, [this.packageRoot, this.tempRoot, runtimeRoot]);
    });
    child.once('error', (error) => this.fail(sidecarError('PYTHON.PROCESS_ERROR', error.message || 'Managed Python sidecar failed.', false)));
    child.once('exit', (code, signal) => {
      if (!this.closing) this.fail(sidecarError(
        'PYTHON.PROCESS_EXITED',
        `Managed Python sidecar exited before shutdown (code=${String(code)}, signal=${String(signal)}).`,
        false
      ));
    });
    try {
      this.helloRequestId = randomUUID();
      await this.send({
        schemaVersion: PROTOCOL,
        type: 'hello',
        requestId: this.helloRequestId,
        protocol: PROTOCOL,
        pythonVersion: '3.13.14',
        maxFrameBytes: this.maxFrameBytes,
        ports: ['connector.invoke', 'store.call', 'events.emit'],
        binaryTransfer: 'managed_artifact_handle',
        networkPolicy: 'deny',
        userSite: false
      });
      await this.readyPromise;
      clearTimeout(startupTimer);
      this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    } catch (error) {
      clearTimeout(startupTimer);
      throw error;
    }
  }

  async invoke(method, payload, options = {}) {
    await this.start();
    if (!/^[a-z][a-z0-9_.-]{2,127}$/u.test(String(method || ''))) {
      throw sidecarError('PYTHON.METHOD_INVALID', 'Python sidecar method identity is invalid.');
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw sidecarError('PYTHON.BACKPRESSURE', 'Python sidecar pending request limit was reached.', true);
    }
    rejectEmbeddedBinary(payload);
    const requestId = randomUUID();
    const runId = String(options.runId || '');
    const timeoutMs = Number(options.timeoutMs || this.requestTimeoutMs);
    if (!runId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > this.requestTimeoutMs) {
      throw sidecarError('PYTHON.INVOCATION_CONTEXT_INVALID', 'Python sidecar invocation requires a bounded Run identity and timeout.');
    }
    this.invocationHandles.set(requestId, new Set());
    collectHandles(payload, this.invocationHandles.get(requestId));
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(sidecarError('PYTHON.REQUEST_TIMEOUT', 'Python sidecar request timed out; automatic mutation replay is forbidden.', false));
        void this.terminateTree();
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, runId });
    });
    await this.send({
      schemaVersion: PROTOCOL,
      type: 'invoke',
      requestId,
      method: String(method),
      runId,
      payload
    });
    try {
      return await result;
    } finally {
      await this.releaseInvocationHandles(requestId, this.retainedHandles);
    }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      if (this.child?.stdin?.writable) await this.send({ schemaVersion: PROTOCOL, type: 'shutdown', requestId: randomUUID() });
    } catch { /* process-tree termination below is authoritative */ }
    await this.terminateTree();
    for (const requestId of [...this.invocationHandles.keys()]) await this.releaseInvocationHandles(requestId);
    if (this.retainedHandles.size) {
      try { await this.ports.store.call('releasePythonArtifactHandles', { handleIds: [...this.retainedHandles] }); }
      catch { /* Core owns final bounded cleanup. */ }
      this.retainedHandles.clear();
    }
    this.rejectAll(sidecarError('PYTHON.SIDECAR_CLOSED', 'Managed Python sidecar was closed.', false));
    this.child = null;
    this.readyPromise = null;
  }

  async heartbeat() {
    if (!this.child || this.closing) return;
    if (Date.now() - this.lastHeartbeatAckAt > this.heartbeatTimeoutMs) {
      this.fail(sidecarError('PYTHON.HEARTBEAT_TIMEOUT', 'Managed Python sidecar heartbeat timed out.', false));
      return;
    }
    await this.send({ schemaVersion: PROTOCOL, type: 'heartbeat', requestId: randomUUID(), sentAt: new Date().toISOString() });
  }

  onStdout(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.from(chunk)]);
    try {
      while (this.stdoutBuffer.length >= 4) {
        const length = this.stdoutBuffer.readUInt32BE(0);
        if (length < 2 || length > this.maxFrameBytes) throw sidecarError('PYTHON.FRAME_SIZE_INVALID', 'Python sidecar emitted an invalid frame length.');
        if (this.stdoutBuffer.length < 4 + length) return;
        const bytes = this.stdoutBuffer.subarray(4, 4 + length);
        this.stdoutBuffer = this.stdoutBuffer.subarray(4 + length);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const message = JSON.parse(text);
        void this.onMessage(message).catch((error) => this.fail(
          sidecarError('PYTHON.MESSAGE_PROCESSING_FAILED', error instanceof Error ? error.message : 'Python sidecar message processing failed.', false)
        ));
      }
    } catch (error) {
      this.fail(sidecarError('PYTHON.PROTOCOL_VIOLATION', error instanceof Error ? error.message : 'Python sidecar protocol violation.', false));
    }
  }

  async onMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.schemaVersion !== PROTOCOL || typeof message.requestId !== 'string') {
      throw this.fail(sidecarError('PYTHON.MESSAGE_INVALID', 'Python sidecar emitted an invalid protocol message.', false));
    }
    if (message.type === 'ready') {
      const capabilities = Array.isArray(message.capabilities) ? [...message.capabilities].sort() : [];
      if (message.requestId !== this.helloRequestId
        || message.protocol !== PROTOCOL || message.pythonVersion !== '3.13.14'
        || message.networkPolicy !== 'deny' || message.userSite !== false
        || message.binaryTransfer !== 'managed_artifact_handle'
        || capabilities.length !== 4 || capabilities[0] !== 'build_plan_ir' || capabilities[1] !== 'compile_workbook' || capabilities[2] !== 'parse_workbook' || capabilities[3] !== 'validate_ir') {
        return this.fail(sidecarError('PYTHON.HANDSHAKE_MISMATCH', 'Managed Python sidecar handshake does not satisfy the signed runtime policy.', false));
      }
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (message.type === 'heartbeat_ack') {
      this.lastHeartbeatAckAt = Date.now();
      return;
    }
    if (message.type === 'port_call') {
      await this.handlePortCall(message);
      return;
    }
    if (message.type !== 'result') return this.fail(sidecarError('PYTHON.MESSAGE_TYPE_DENIED', 'Python sidecar emitted a denied protocol message type.', false));
    const pending = this.pending.get(message.requestId);
    if (!pending) return this.fail(sidecarError('PYTHON.RESPONSE_UNKNOWN', 'Python sidecar response has no matching request.', false));
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.ok === true) {
      rejectEmbeddedBinary(message.value);
      const returnedHandles = collectHandles(message.value);
      for (const handleId of returnedHandles) this.retainedHandles.add(handleId);
      collectHandles(message.value, this.invocationHandles.get(message.requestId));
      pending.resolve(message.value);
    } else {
      pending.reject(sidecarError(
        String(message.error?.code || 'PYTHON.INVOCATION_FAILED'),
        String(message.error?.message || 'Python sidecar invocation failed.'),
        message.error?.retryable === true
      ));
    }
  }

  async handlePortCall(message) {
    const port = String(message.port || '');
    const invocationId = String(message.invocationId || '');
    if (!this.pending.has(invocationId) || !['connector.invoke', 'store.call', 'events.emit'].includes(port)) {
      return this.send({
        schemaVersion: PROTOCOL, type: 'port_result', requestId: message.requestId,
        invocationId, ok: false,
        error: { code: 'PYTHON.PORT_DENIED', message: 'Python sidecar port call is outside the active invocation.', retryable: false }
      });
    }
    try {
      let value;
      if (port === 'connector.invoke') value = await this.ports.connector.invoke(message.payload);
      else if (port === 'events.emit') value = await this.ports.events.emit(message.payload);
      else {
        const method = String(message.payload?.method || '');
        value = await this.ports.store.call(method, message.payload?.input);
      }
      rejectEmbeddedBinary(value);
      collectHandles(value, this.invocationHandles.get(invocationId));
      await this.send({ schemaVersion: PROTOCOL, type: 'port_result', requestId: message.requestId, invocationId, ok: true, value });
    } catch (error) {
      await this.send({
        schemaVersion: PROTOCOL, type: 'port_result', requestId: message.requestId, invocationId, ok: false,
        error: {
          code: String(error?.code || 'PYTHON.PORT_FAILED'),
          message: String(error?.message || 'Python sidecar port call failed.'),
          retryable: error?.retryable === true
        }
      });
    }
  }

  async send(message) {
    rejectEmbeddedBinary(message);
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    if (payload.length > this.maxFrameBytes) throw sidecarError('PYTHON.FRAME_TOO_LARGE', 'Python sidecar RPC frame exceeds the signed maximum.');
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    this.writeChain = this.writeChain.then(() => new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) return reject(sidecarError('PYTHON.STDIN_CLOSED', 'Python sidecar protocol input is closed.', false));
      const accepted = this.child.stdin.write(frame, (error) => error ? reject(error) : resolve());
      if (!accepted) this.child.stdin.once('drain', resolve);
    }));
    return this.writeChain;
  }

  async releaseInvocationHandles(requestId, preserve = new Set()) {
    const handles = [...(this.invocationHandles.get(requestId) || [])].filter((handleId) => !preserve.has(handleId));
    this.invocationHandles.delete(requestId);
    if (handles.length === 0) return;
    try {
      await this.ports.store.call('releasePythonArtifactHandles', { handleIds: handles });
    } catch { /* Core also owns bounded startup cleanup; never replace the primary result with cleanup noise. */ }
  }

  fail(error) {
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.rejectAll(error);
    void this.terminateTree();
    return error;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async terminateTree() {
    const child = this.child;
    this.child = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== 'win32') {
      child.kill('SIGKILL');
      return;
    }
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.resolve(systemRoot, 'System32', 'taskkill.exe');
    if (!fs.existsSync(taskkill)) {
      child.kill();
      return;
    }
    await new Promise((resolve) => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 5_000);
      killer.once('exit', () => { clearTimeout(timer); resolve(); });
      killer.once('error', () => { clearTimeout(timer); child.kill(); resolve(); });
    });
  }
}

function createPythonSidecarBridge(options) {
  return new PythonSidecarBridge(options);
}

module.exports = {
  PROTOCOL,
  HANDLE_SCHEMA,
  PythonSidecarBridge,
  createPythonSidecarBridge
};
