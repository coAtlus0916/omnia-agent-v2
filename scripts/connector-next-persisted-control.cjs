'use strict';

const { app, safeStorage } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { createDecipheriv, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { request: httpsRequest } = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

// This is a headless diagnostic helper. Its stdout consumer may intentionally
// stop after reading a compact result (for example when a UI/tool truncates a
// large log page). Treat that closed pipe as successful early consumption,
// never as an Electron main-process error dialog.
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') app.exit(0);
  else throw error;
});

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

// safeStorage must use the same Chromium profile identity as the Shell that
// created the protected instance key. This helper never opens a window.
app.setName('omnia-agent-v5-shell');
if (process.env.APPDATA) app.setPath('userData', path.join(process.env.APPDATA, 'omnia-agent-v5-shell'));

function decryptContent(key, ciphertext) {
  if (!String(ciphertext).startsWith('enc:v1:')) throw new Error('CONNECTOR_NEXT.PERSISTED_CONTROL_TOKEN_INVALID');
  const payload = Buffer.from(String(ciphertext).slice('enc:v1:'.length), 'base64');
  if (payload.length < 29) throw new Error('CONNECTOR_NEXT.PERSISTED_CONTROL_TOKEN_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
}

function uploadArtifact(serverUrl, controlToken, manifestFile, packageFile) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const packageBytes = fs.readFileSync(packageFile);
  const encodedManifest = Buffer.from(JSON.stringify(manifest)).toString('base64url');
  return new Promise((resolve, reject) => {
    const request = httpsRequest(new URL('updates/artifacts', serverUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controlToken}`,
        'content-type': 'application/octet-stream',
        'content-length': String(packageBytes.length),
        'x-connector-next-manifest': encodedManifest
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if ((response.statusCode || 500) >= 300) throw new Error(payload.error?.code || `CONNECTOR_NEXT.HTTP_${response.statusCode}`);
          resolve(payload);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(120_000, () => request.destroy(new Error('CONNECTOR_NEXT.UPDATE_UPLOAD_TIMEOUT')));
    request.once('error', reject);
    request.end(packageBytes);
  });
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] !== '--root' || !argumentsList[1] || !argumentsList[2]) {
    throw new Error('usage: electron connector-next-persisted-control.cjs --root PRODUCT_ROOT CONTROL_COMMAND [ARGUMENT]');
  }
  const productRoot = path.resolve(argumentsList[1]);
  const stores = path.join(productRoot, 'data', 'stores');
  const keyFile = path.join(stores, 'instance-dek.protected');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('CONNECTOR_NEXT.WINDOWS_PROTECTION_UNAVAILABLE');
  const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(keyFile)), 'base64');
  if (key.length !== 32) throw new Error('CONNECTOR_NEXT.PERSISTED_KEY_INVALID');
  const database = new DatabaseSync(path.join(stores, 'core.sqlite'), { readOnly: true });
  const row = database.prepare(`
    SELECT enabled,server_url,agent_id,device_id,connector_instance_id,control_token_ciphertext
    FROM connector_next_settings WHERE singleton=1
  `).get();
  database.close();
  if (!row || Number(row.enabled) !== 1) throw new Error('CONNECTOR_NEXT.PERSISTED_CONFIGURATION_REQUIRED');
  const controlToken = decryptContent(key, row.control_token_ciphertext);
  const target = {
    agentId: String(row.agent_id),
    deviceId: String(row.device_id),
    connectorInstanceId: String(row.connector_instance_id)
  };
  const forwarded = argumentsList.slice(2);
  if (forwarded[0] === 'operation-base64') {
    if (!forwarded[1]) throw new Error('base64url operation envelope is required');
    const envelope = JSON.parse(Buffer.from(forwarded[1], 'base64url').toString('utf8'));
    const enqueueResponse = await fetch(new URL('operations', String(row.server_url)), {
      method: 'POST',
      headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ envelope, deadlineSeconds: 180 })
    });
    const enqueued = await enqueueResponse.json();
    if (!enqueueResponse.ok || typeof enqueued.jobId !== 'string') {
      throw new Error(enqueued.error?.code || `CONNECTOR_NEXT.HTTP_${enqueueResponse.status}`);
    }
    const deadline = Date.now() + 180_000;
    let result = null;
    while (Date.now() < deadline) {
      const response = await fetch(new URL(`jobs/${encodeURIComponent(enqueued.jobId)}?waitMs=100`, String(row.server_url)), {
        headers: { authorization: `Bearer ${controlToken}` }
      });
      result = await response.json();
      if (!response.ok) throw new Error(result.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
      if (result.status === 'succeeded' || result.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!result || (result.status !== 'succeeded' && result.status !== 'failed')) throw new Error('CONNECTOR_NEXT.OPERATION_TIMEOUT');
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  } else if (forwarded[0] === 'update-register-files') {
    if (!forwarded[1] || !forwarded[2]) throw new Error('manifest and package paths are required');
    const result = await uploadArtifact(String(row.server_url), controlToken, path.resolve(forwarded[1]), path.resolve(forwarded[2]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  } else if (forwarded[0] === 'delivery-status' || forwarded[0] === 'delivery-status-base64') {
    if (!forwarded[1]) throw new Error('delivery status request JSON is required');
    const requestBody = forwarded[0] === 'delivery-status-base64'
      ? Buffer.from(forwarded[1], 'base64url').toString('utf8')
      : forwarded[1];
    const response = await fetch(new URL('deliveries/status', String(row.server_url)), {
      method: 'POST',
      headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
      body: requestBody
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  } else if (forwarded[0] === 'delivery-ack-replay') {
    const ackDatabase = new DatabaseSync(path.join(stores, 'core.sqlite'), { readOnly: true });
    const acknowledgements = ackDatabase.prepare(`
      SELECT ack_id,payload_json
      FROM connector_delivery_ack_outbox
      WHERE transaction_kind='effect_resolved' AND state='delivered'
      ORDER BY created_at,ack_id
    `).all();
    ackDatabase.close();
    let accepted = 0;
    for (const acknowledgement of acknowledgements) {
      const response = await fetch(new URL('deliveries/ack', String(row.server_url)), {
        method: 'POST',
        headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
        body: String(acknowledgement.payload_json)
      });
      const result = await response.json();
      if (!response.ok || result.acknowledged !== true || result.clearedMutationCount !== 1) {
        throw new Error(result.error?.code || `CONNECTOR_NEXT.DELIVERY_ACK_REPLAY_FAILED:${acknowledgement.ack_id}`);
      }
      accepted += 1;
    }
    process.stdout.write(`${JSON.stringify({ attempted: acknowledgements.length, accepted })}\n`);
    return;
  } else if (forwarded[0] === 'authoritative-closure-replay') {
    const requested = String(forwarded[1] || '').split(',').filter(Boolean);
    if (requested.length < 1 || requested.length > 128 || requested.some((id) => !/^[0-9a-f-]{36}$/u.test(id))) {
      throw new Error('one or more exact delivery request ids are required');
    }
    const closureDatabase = new DatabaseSync(path.join(stores, 'core.sqlite'), { readOnly: true });
    const statement = closureDatabase.prepare(`
      SELECT d.request_id,d.feature_id,d.feature_version,d.operation_id,d.operation_package_digest,
             d.run_id,d.command_id,d.connector_id,d.session_generation,c.state,c.completed_at,
             r.receipt_id,r.request_digest receipt_request_digest,r.response_digest receipt_response_digest
      FROM connector_delivery_requests d
      JOIN feature_commands c ON c.connector_request_id=d.request_id AND c.command_id=d.command_id AND c.run_id=d.run_id
      JOIN feature_operation_receipts r ON r.run_id=c.run_id AND r.command_id=c.command_id
        AND r.request_digest=c.evidence_request_digest AND r.target_identity_key=c.evidence_target_identity_key
      WHERE d.request_id=? AND d.purpose='mutation' AND d.state='effect_resolved'
        AND d.wire_result_digest='' AND d.execution_generation=''
        AND c.state IN ('closed_not_applied','readback_verified') AND c.completed_at<>''
      ORDER BY r.created_at DESC LIMIT 1
    `);
    const rows = requested.map((requestId) => statement.get(requestId));
    closureDatabase.close();
    if (rows.some((row) => !row)) throw new Error('CONNECTOR_NEXT.AUTHORITATIVE_CLOSURE_LOCAL_PROOF_MISSING');
    const results = [];
    for (const rowValue of rows) {
      const unsigned = {
        schemaVersion: 'omnia.connector-next-authoritative-closure/v1',
        target,
        requestId: String(rowValue.request_id),
        featureId: String(rowValue.feature_id),
        featureVersion: String(rowValue.feature_version),
        operationId: String(rowValue.operation_id),
        operationPackageDigest: String(rowValue.operation_package_digest),
        runId: String(rowValue.run_id),
        commandId: String(rowValue.command_id),
        connectorId: String(rowValue.connector_id),
        sessionGeneration: Number(rowValue.session_generation),
        outcome: String(rowValue.state),
        receiptId: String(rowValue.receipt_id),
        receiptRequestDigest: String(rowValue.receipt_request_digest),
        receiptResponseDigest: String(rowValue.receipt_response_digest),
        completedAt: String(rowValue.completed_at)
      };
      const proof = { ...unsigned, proofDigest: `sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}` };
      const response = await fetch(new URL('deliveries/authoritative-closure', String(row.server_url)), {
        method: 'POST',
        headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(proof)
      });
      const result = await response.json();
      if (!response.ok || result.accepted !== true) throw new Error(result.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
      results.push(result);
    }
    process.stdout.write(`${JSON.stringify({ attempted: requested.length, accepted: results.length, results })}\n`);
    return;
  } else if (forwarded[0] === 'update-offer-id') {
    if (!forwarded[1]) throw new Error('artifactId is required');
    const response = await fetch(new URL('updates/offers', String(row.server_url)), {
      method: 'POST',
      headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target, artifactId: forwarded[1] })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  } else if (forwarded[0] === 'logs-after') {
    const after = Number(forwarded[1] || 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative integer');
    const query = new URLSearchParams({
      agentId: target.agentId,
      deviceId: target.deviceId,
      connectorInstanceId: target.connectorInstanceId,
      after: String(after),
      limit: '500'
    });
    const response = await fetch(new URL(`logs?${query.toString()}`, String(row.server_url)), {
      headers: { authorization: `Bearer ${controlToken}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  } else if (forwarded[0] === 'logs-summary') {
    let after = Number(forwarded[1] || 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative integer');
    let total = 0;
    const selected = [];
    const recent = [];
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({
        agentId: target.agentId,
        deviceId: target.deviceId,
        connectorInstanceId: target.connectorInstanceId,
        after: String(after),
        limit: '500'
      });
      const response = await fetch(new URL(`logs?${query.toString()}`, String(row.server_url)), {
        headers: { authorization: `Bearer ${controlToken}` }
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
      const records = Array.isArray(result.records) ? result.records : [];
      if (records.length === 0) break;
      total += records.length;
      for (const record of records) {
        if (/^(?:update\.|updater\.|agent\.(?:started|stopped)|job\.failed|agent\.poll_failed)/u.test(String(record.event || ''))) selected.push(record);
        recent.push(record);
        if (recent.length > 80) recent.shift();
      }
      after = Number(records.at(-1).server_log_id);
      if (records.length < 500) break;
    }
    const records = [...new Map([...selected, ...recent].map((record) => [record.server_log_id, record])).values()]
      .sort((left, right) => Number(left.server_log_id) - Number(right.server_log_id));
    fs.writeSync(process.stdout.fd, `${JSON.stringify({ total, lastServerLogId: after, records })}\n`);
    return;
  }
  if (forwarded.length === 1 && ['logs', 'job-health', 'identity'].includes(forwarded[0])) forwarded.push(JSON.stringify(target));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'dist', 'connector-next', 'shell-control.cjs'),
    ...forwarded
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OMNIA_CONNECTOR_NEXT_SERVER_URL: String(row.server_url),
      OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN: controlToken
    }
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`CONNECTOR_NEXT.CONTROL_COMMAND_FAILED:${result.status}`);
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
