'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const PROTOCOL = 'omnia.python-sidecar-rpc/v1';
const MANAGED_DISTRIBUTION = 'cpython-3.13.14-embed-amd64';
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const CAPABILITIES = ['adopt_successor_run', 'ingest_and_export', 'maintenance', 'mark_finalized', 'mark_state'];

function bridgeError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function inside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function extendedWindowsPath(filename) {
  const resolved = path.resolve(filename);
  if (process.platform !== 'win32' || resolved.startsWith('\\\\?\\')) return resolved;
  if (resolved.startsWith('\\\\')) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  return `\\\\?\\${resolved}`;
}

function requiredFile(filename, code, message) {
  if (!path.isAbsolute(filename) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw bridgeError(code, message);
  return path.resolve(filename);
}

function rejectBinary(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw bridgeError('PYTHON.RPC_CYCLE', 'Python RPC payload contains a cycle.');
  seen.add(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) throw bridgeError('PYTHON.RPC_BINARY_FORBIDDEN', 'Python RPC binary content must use managed handles.');
  if (Array.isArray(value)) for (const item of value) rejectBinary(item, seen);
  else for (const [key, item] of Object.entries(value)) {
    if (key === 'contentBase64' || key === 'base64') throw bridgeError('PYTHON.RPC_BASE64_FORBIDDEN', 'Python RPC does not accept embedded base64 payloads.');
    rejectBinary(item, seen);
  }
  seen.delete(value);
}

function sanitizeDiagnostic(value, roots) {
  let text = String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '').slice(-MAX_STDERR_BYTES);
  for (const root of roots) if (root) text = text.replaceAll(path.resolve(root), '[managed-root]');
  return text;
}

class PythonSidecarBridge {
  constructor(options) {
    if (!options?.ports?.events?.emit) throw bridgeError('PYTHON.BRIDGE_PORTS_INVALID', 'Recording Python bridge requires the Feature event port.');
    this.ports = options.ports;
    const executableEnv = String(process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE || '');
    const entryEnv = String(process.env.OMNIA_MANAGED_PYTHON_ENTRY || '');
    const packageRootEnv = String(process.env.OMNIA_FEATURE_PACKAGE_ROOT || '');
    const tempRootEnv = String(process.env.OMNIA_FEATURE_TEMP_ROOT || '');
    const storePathEnv = String(process.env.OMNIA_FEATURE_STORE_PATH || '');
    if (![executableEnv, entryEnv, packageRootEnv, tempRootEnv, storePathEnv].every((value) => path.isAbsolute(value))) {
      throw bridgeError('PYTHON.RUNTIME_SCOPE_INVALID', 'Managed Python executable, entry, package, temp, and Feature Store paths must be absolute.');
    }
    this.pythonExecutable = requiredFile(executableEnv, 'PYTHON.RUNTIME_MISSING', 'Release-owned CPython 3.13.14 is unavailable; PATH/system Python fallback is forbidden.');
    this.pythonEntry = requiredFile(entryEnv, 'PYTHON.ENTRY_MISSING', 'Signed recording Python entry is unavailable.');
    this.packageRoot = path.resolve(packageRootEnv);
    this.tempRoot = path.resolve(tempRootEnv);
    this.storePath = path.resolve(storePathEnv);
    const featureRoot = path.dirname(this.storePath);
    if (!this.pythonExecutable.toLowerCase().endsWith(path.join('runtime', 'python', MANAGED_DISTRIBUTION, 'python.exe').toLowerCase())
      || !inside(this.packageRoot, this.pythonEntry) || !inside(this.packageRoot, __filename)
      || this.tempRoot === this.packageRoot || inside(this.packageRoot, this.tempRoot)
      || path.basename(this.storePath).toLowerCase() !== 'store.sqlite'
      || path.basename(featureRoot).toLowerCase() !== 'omnia.recording'
      || path.basename(path.dirname(featureRoot)).toLowerCase() !== 'features') {
      throw bridgeError('PYTHON.RUNTIME_SCOPE_INVALID', 'Recording Python runtime or Feature-private Store scope is invalid.');
    }
    fs.mkdirSync(this.tempRoot, { recursive: true });
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.writeChain = Promise.resolve();
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.helloRequestId = '';
    this.heartbeatTimer = null;
    this.lastHeartbeatAckAt = 0;
    this.stderrTail = '';
    this.closing = false;
  }

  async start() {
    if (this.child && this.readyPromise) return this.readyPromise;
    this.closing = false;
    this.writeChain = Promise.resolve();
    this.stderrTail = '';
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const environment = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe'),
      TEMP: this.tempRoot,
      TMP: this.tempRoot,
      PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', NO_PROXY: '*', no_proxy: '*',
      OMNIA_PYTHON_PROTOCOL: PROTOCOL,
      OMNIA_PYTHON_PACKAGE_ROOT: extendedWindowsPath(this.packageRoot),
      OMNIA_PYTHON_TEMP_ROOT: extendedWindowsPath(this.tempRoot),
      OMNIA_FEATURE_STORE_PATH: extendedWindowsPath(this.storePath)
    };
    const child = spawn(this.pythonExecutable, ['-I', '-S', '-E', '-B', '-u', extendedWindowsPath(this.pythonEntry), '--stdio-rpc'], {
      cwd: extendedWindowsPath(this.tempRoot), env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.lastHeartbeatAckAt = Date.now();
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    const startupTimer = setTimeout(() => this.fail(bridgeError('PYTHON.START_TIMEOUT', 'Recording Python sidecar handshake timed out.')), 10_000);
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = sanitizeDiagnostic(`${this.stderrTail}${chunk.toString('utf8')}`, [this.packageRoot, this.tempRoot, this.storePath]);
    });
    child.once('error', (error) => this.fail(bridgeError('PYTHON.PROCESS_ERROR', error.message || 'Recording Python sidecar failed.')));
    child.once('exit', (code, signal) => {
      if (!this.closing) this.fail(bridgeError('PYTHON.PROCESS_EXITED', `Recording Python sidecar exited (code=${String(code)}, signal=${String(signal)}). ${this.stderrTail}`));
    });
    try {
      this.helloRequestId = randomUUID();
      await this.send({
        schemaVersion: PROTOCOL, type: 'hello', requestId: this.helloRequestId, protocol: PROTOCOL,
        pythonVersion: '3.13.14', maxFrameBytes: MAX_FRAME_BYTES, networkPolicy: 'deny',
        storePathPolicy: 'feature_private', binaryTransfer: 'managed_artifact_handle'
      });
      await this.readyPromise;
      clearTimeout(startupTimer);
      this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, 5_000);
      this.heartbeatTimer.unref?.();
    } catch (error) { clearTimeout(startupTimer); throw error; }
  }

  async invoke(method, payload, options = {}) {
    await this.start();
    if (!CAPABILITIES.includes(String(method || ''))) throw bridgeError('PYTHON.METHOD_DENIED', 'Recording Python method is not declared by the signed Feature.');
    const runId = String(options.runId || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) {
      throw bridgeError('PYTHON.RUN_ID_INVALID', 'Recording Python invocation requires a canonical Run identity.');
    }
    rejectBinary(payload);
    const requestId = randomUUID();
    const timeoutMs = Number(options.timeoutMs || 120_000);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(bridgeError('PYTHON.REQUEST_TIMEOUT', 'Recording Python invocation timed out; no automatic mutation replay occurred.'));
        void this.terminateTree();
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    await this.send({ schemaVersion: PROTOCOL, type: 'invoke', requestId, runId, method, payload });
    return result;
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try { if (this.child?.stdin?.writable) await this.send({ schemaVersion: PROTOCOL, type: 'shutdown', requestId: randomUUID() }); }
    catch { /* tree termination below is authoritative */ }
    await this.terminateTree();
    this.rejectAll(bridgeError('PYTHON.SIDECAR_CLOSED', 'Recording Python sidecar closed.'));
    this.readyPromise = null;
  }

  async heartbeat() {
    if (!this.child || this.closing) return;
    if (Date.now() - this.lastHeartbeatAckAt > 15_000) return this.fail(bridgeError('PYTHON.HEARTBEAT_TIMEOUT', 'Recording Python sidecar heartbeat timed out.'));
    await this.send({ schemaVersion: PROTOCOL, type: 'heartbeat', requestId: randomUUID(), sentAt: new Date().toISOString() });
  }

  onStdout(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.from(chunk)]);
    try {
      while (this.stdoutBuffer.length >= 4) {
        const length = this.stdoutBuffer.readUInt32BE(0);
        if (length < 2 || length > MAX_FRAME_BYTES) throw bridgeError('PYTHON.FRAME_SIZE_INVALID', 'Recording Python emitted an invalid frame length.');
        if (this.stdoutBuffer.length < 4 + length) return;
        const bytes = this.stdoutBuffer.subarray(4, 4 + length);
        this.stdoutBuffer = this.stdoutBuffer.subarray(4 + length);
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        this.onMessage(message);
      }
    } catch (error) { this.fail(bridgeError('PYTHON.PROTOCOL_VIOLATION', error?.message || 'Recording Python protocol violation.')); }
  }

  onMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.schemaVersion !== PROTOCOL || typeof message.requestId !== 'string') {
      return this.fail(bridgeError('PYTHON.MESSAGE_INVALID', 'Recording Python emitted an invalid protocol message.'));
    }
    if (message.type === 'ready') {
      const capabilities = Array.isArray(message.capabilities) ? [...message.capabilities].sort() : [];
      if (message.requestId !== this.helloRequestId || message.protocol !== PROTOCOL || message.pythonVersion !== '3.13.14'
        || message.networkPolicy !== 'deny' || message.storePathPolicy !== 'feature_private'
        || JSON.stringify(capabilities) !== JSON.stringify([...CAPABILITIES].sort())) {
        return this.fail(bridgeError('PYTHON.HANDSHAKE_MISMATCH', 'Recording Python handshake does not satisfy the signed runtime policy.'));
      }
      this.readyResolve?.(); this.readyResolve = null; this.readyReject = null; return;
    }
    if (message.type === 'heartbeat_ack') { this.lastHeartbeatAckAt = Date.now(); return; }
    if (message.type !== 'result') return this.fail(bridgeError('PYTHON.MESSAGE_TYPE_DENIED', 'Recording Python emitted a denied message type.'));
    const pending = this.pending.get(message.requestId);
    if (!pending) return this.fail(bridgeError('PYTHON.RESPONSE_UNKNOWN', 'Recording Python response has no matching request.'));
    clearTimeout(pending.timer); this.pending.delete(message.requestId);
    if (message.ok === true) { rejectBinary(message.value); pending.resolve(message.value); }
    else pending.reject(bridgeError(String(message.error?.code || 'PYTHON.INVOCATION_FAILED'), String(message.error?.message || 'Recording Python invocation failed.')));
  }

  async send(message) {
    rejectBinary(message);
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    if (payload.length > MAX_FRAME_BYTES) throw bridgeError('PYTHON.FRAME_TOO_LARGE', 'Recording Python RPC frame exceeds the signed maximum.');
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4);
    this.writeChain = this.writeChain.then(() => new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) return reject(bridgeError('PYTHON.STDIN_CLOSED', 'Recording Python protocol input is closed.'));
      this.child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    }));
    return this.writeChain;
  }

  fail(error) {
    this.readyReject?.(error); this.readyResolve = null; this.readyReject = null;
    this.rejectAll(error); void this.terminateTree(); return error;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  async terminateTree() {
    const child = this.child; this.child = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== 'win32') { child.kill('SIGKILL'); return; }
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.resolve(systemRoot, 'System32', 'taskkill.exe');
    if (!fs.existsSync(taskkill)) { child.kill(); return; }
    await new Promise((resolve) => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 5_000);
      killer.once('exit', () => { clearTimeout(timer); resolve(); });
      killer.once('error', () => { clearTimeout(timer); child.kill(); resolve(); });
    });
  }
}

function createPythonSidecarBridge(options) { return new PythonSidecarBridge(options); }

module.exports = { PROTOCOL, PythonSidecarBridge, createPythonSidecarBridge };
