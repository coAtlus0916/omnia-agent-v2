'use strict';

const { app, safeStorage } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { createDecipheriv } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { request: httpsRequest } = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

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
  if (forwarded[0] === 'update-register-files') {
    if (!forwarded[1] || !forwarded[2]) throw new Error('manifest and package paths are required');
    const result = await uploadArtifact(String(row.server_url), controlToken, path.resolve(forwarded[1]), path.resolve(forwarded[2]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
