'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const PROTOCOL = 'omnia.python-sidecar-rpc/v1';
const DISTRIBUTION = 'cpython-3.13.14-embed-amd64';
const CAPABILITIES = Object.freeze(['build_hidden_tab_plan']);
const MAX_FRAME_BYTES = 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 15000;

function bridgeError(code, message) { return Object.assign(new Error(message), { code, retryable: false }); }
function inside(root, target) { const base = path.resolve(root); return path.resolve(target).startsWith(`${base}${path.sep}`); }
function absoluteFile(value, code, message) {
  if (!path.isAbsolute(value) || !fs.existsSync(value) || !fs.statSync(value).isFile()) throw bridgeError(code, message);
  return path.resolve(value);
}
function extended(value) {
  const result = path.resolve(value);
  if (process.platform !== 'win32' || result.startsWith('\\\\?\\')) return result;
  return result.startsWith('\\\\') ? `\\\\?\\UNC\\${result.slice(2)}` : `\\\\?\\${result}`;
}
function jsonOnly(value, seen = new Set()) {
  if (value == null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw bridgeError('PYTHON.RPC_JSON_INVALID', 'Planner RPC accepts finite JSON only.');
    return;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value) || seen.has(value)) {
    throw bridgeError('PYTHON.RPC_JSON_INVALID', 'Planner RPC accepts acyclic JSON only.');
  }
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) jsonOnly(item, seen);
  seen.delete(value);
}

class WorkpaperPythonBridge {
  constructor(options = {}) {
    this.timeoutMs = Number(options.timeoutMs || 120000);
    const executable = String(process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE || '');
    const entry = String(process.env.OMNIA_MANAGED_PYTHON_ENTRY || '');
    const packageRoot = String(process.env.OMNIA_FEATURE_PACKAGE_ROOT || '');
    const tempRoot = String(process.env.OMNIA_FEATURE_TEMP_ROOT || '');
    if (![executable, entry, packageRoot, tempRoot].every(path.isAbsolute)) {
      throw bridgeError('PYTHON.RUNTIME_SCOPE_INVALID', 'Managed Python scope is unavailable; PATH/system/Anaconda fallback is forbidden.');
    }
    this.executable = absoluteFile(executable, 'PYTHON.RUNTIME_MISSING', 'Release-managed CPython 3.13.14 is unavailable.');
    this.entry = absoluteFile(entry, 'PYTHON.ENTRY_MISSING', 'Signed workpaper planner entry is unavailable.');
    this.packageRoot = path.resolve(packageRoot);
    this.tempRoot = path.resolve(tempRoot);
    if (!this.executable.toLowerCase().endsWith(path.join('runtime', 'python', DISTRIBUTION, 'python.exe').toLowerCase())
      || !inside(this.packageRoot, this.entry) || !inside(this.packageRoot, __filename) || inside(this.packageRoot, this.tempRoot)) {
      throw bridgeError('PYTHON.RUNTIME_SCOPE_INVALID', 'Managed Python executable, entry, package, or temp identity is invalid.');
    }
    fs.mkdirSync(this.tempRoot, { recursive: true });
    this.child = null; this.buffer = Buffer.alloc(0); this.pending = new Map(); this.writeChain = Promise.resolve();
    this.ready = null; this.helloId = ''; this.heartbeatTimer = null; this.heartbeatInFlight = null; this.closing = false;
  }
  async start() {
    if (this.child && this.ready) return this.ready;
    const runtimeRoot = path.dirname(this.executable);
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const env = {
      SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe'),
      PATH: `${runtimeRoot};${path.join(systemRoot, 'System32')}`, TEMP: this.tempRoot, TMP: this.tempRoot,
      PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
      NO_PROXY: '*', no_proxy: '*', OMNIA_PYTHON_PROTOCOL: PROTOCOL
    };
    const child = spawn(this.executable, ['-I', '-S', '-E', '-u', extended(this.entry), '--stdio-rpc'],
      { cwd: extended(this.tempRoot), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child; this.buffer = Buffer.alloc(0); this.closing = false;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.ready.catch(() => undefined);
    const timer = setTimeout(() => this.fail(bridgeError('PYTHON.START_TIMEOUT', 'Workpaper planner handshake timed out.')), 10000);
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', () => {});
    child.once('error', (error) => this.fail(bridgeError('PYTHON.PROCESS_ERROR', String(error.message || error))));
    child.once('exit', () => { if (this.child === child && !this.closing) this.fail(bridgeError('PYTHON.PROCESS_EXITED', 'Workpaper planner exited unexpectedly.')); });
    this.helloId = randomUUID();
    try {
      await this.send({ schemaVersion: PROTOCOL, type: 'hello', requestId: this.helloId, protocol: PROTOCOL,
        pythonVersion: '3.13.14', maxFrameBytes: MAX_FRAME_BYTES, networkPolicy: 'deny', userSite: false, binaryTransfer: 'json_only' });
      await this.ready; this.startHeartbeat();
    } catch (error) { this.fail(error); throw error; } finally { clearTimeout(timer); }
  }
  async invoke(method, payload, options = {}) {
    await this.start(); jsonOnly(payload);
    if (!CAPABILITIES.includes(String(method)) || !String(options.runId || '')) {
      throw bridgeError('PYTHON.INVOCATION_INVALID', 'Workpaper planner invocation is invalid.');
    }
    const requestId = randomUUID();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(bridgeError('PYTHON.REQUEST_TIMEOUT', 'Workpaper planner timed out; no JS fallback is permitted.'));
        void this.terminate();
      }, this.timeoutMs);
      this.pending.set(requestId, { kind: 'invoke', resolve, reject, timer });
    });
    result.catch(() => undefined);
    try { await this.send({ schemaVersion: PROTOCOL, type: 'invoke', requestId, method, runId: String(options.runId), payload }); }
    catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(requestId); pending.reject(error); }
      throw error;
    }
    return result;
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (length < 2 || length > MAX_FRAME_BYTES) throw bridgeError('PYTHON.FRAME_INVALID', 'Workpaper planner frame length is invalid.');
        if (this.buffer.length < length + 4) return;
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(4, length + 4)));
        this.buffer = this.buffer.subarray(length + 4); this.onMessage(message);
      }
    } catch (error) { this.fail(error); }
  }
  onMessage(message) {
    if (!message || message.schemaVersion !== PROTOCOL || typeof message.requestId !== 'string') {
      return this.fail(bridgeError('PYTHON.MESSAGE_INVALID', 'Workpaper planner emitted an invalid message.'));
    }
    if (message.type === 'ready') {
      const actual = Array.isArray(message.capabilities) ? [...message.capabilities].sort() : [];
      const expected = [...CAPABILITIES].sort();
      if (message.requestId !== this.helloId || message.pythonVersion !== '3.13.14' || message.protocol !== PROTOCOL
        || message.maxFrameBytes !== MAX_FRAME_BYTES || message.networkPolicy !== 'deny' || message.userSite !== false
        || message.binaryTransfer !== 'json_only' || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        return this.fail(bridgeError('PYTHON.HANDSHAKE_MISMATCH', 'Workpaper planner does not satisfy its signed CPython policy.'));
      }
      this.readyResolve(); this.readyResolve = null; this.readyReject = null; return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return this.fail(bridgeError('PYTHON.RESPONSE_UNKNOWN', 'Workpaper planner response has no request.'));
    if (message.type === 'heartbeat_ack' && pending.kind === 'heartbeat') {
      clearTimeout(pending.timer); this.pending.delete(message.requestId); pending.resolve(); return;
    }
    if (message.type !== 'result' || pending.kind !== 'invoke') {
      return this.fail(bridgeError('PYTHON.MESSAGE_DENIED', 'Workpaper planner emitted a denied message type.'));
    }
    clearTimeout(pending.timer); this.pending.delete(message.requestId);
    if (message.ok === true) {
      try { jsonOnly(message.value); pending.resolve(message.value); } catch (error) { pending.reject(error); }
    } else {
      pending.reject(bridgeError(String(message.error && message.error.code || 'PYTHON.PLANNER_FAILED'),
        String(message.error && message.error.message || 'Workpaper planner failed.')));
    }
  }
  async send(message) {
    jsonOnly(message);
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > MAX_FRAME_BYTES) throw bridgeError('PYTHON.FRAME_TOO_LARGE', 'Workpaper planner request is too large.');
    const frame = Buffer.allocUnsafe(body.length + 4); frame.writeUInt32BE(body.length, 0); body.copy(frame, 4);
    this.writeChain = this.writeChain.then(() => new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) return reject(bridgeError('PYTHON.STDIN_CLOSED', 'Workpaper planner input is closed.'));
      this.child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    }));
    return this.writeChain;
  }
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatInFlight) this.heartbeatInFlight = this.heartbeat().catch((error) => this.fail(error)).finally(() => { this.heartbeatInFlight = null; });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }
  async heartbeat() {
    if (!this.child || !this.ready) return;
    const requestId = randomUUID();
    const acknowledged = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(bridgeError('PYTHON.HEARTBEAT_TIMEOUT', 'Workpaper planner heartbeat timed out.')); }, HEARTBEAT_TIMEOUT_MS);
      timer.unref(); this.pending.set(requestId, { kind: 'heartbeat', resolve, reject, timer });
    });
    acknowledged.catch(() => undefined);
    await this.send({ schemaVersion: PROTOCOL, type: 'heartbeat', requestId });
    await acknowledged;
  }
  fail(error) {
    this.readyReject && this.readyReject(error); this.readyResolve = null; this.readyReject = null;
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
    this.pending.clear(); void this.terminate(); return error;
  }
  async close() {
    const child = this.child;
    if (!child || child.exitCode !== null) return this.terminate();
    this.closing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try { await this.send({ schemaVersion: PROTOCOL, type: 'shutdown', requestId: randomUUID() }); } catch {}
    child.stdin.end();
    await new Promise((resolve) => { const timer = setTimeout(resolve, 1000); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    await this.terminate();
  }
  async terminate() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null; this.heartbeatInFlight = null;
    const child = this.child; this.child = null; this.ready = null; this.closing = false;
    if (!child || child.exitCode !== null) return;
    child.kill();
  }
}

function createPythonSidecarBridge(options) { return new WorkpaperPythonBridge(options); }
module.exports = Object.freeze({ PROTOCOL, CAPABILITIES, WorkpaperPythonBridge, createPythonSidecarBridge });
