import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const stable = path.join(root, 'remote-connector', 'public', 'stable.json');
if (!fs.existsSync(stable)) throw new Error(`Required release manifest is unavailable: ${stable}`);
const manifest = JSON.parse(fs.readFileSync(stable, 'utf8'));
const version = String(manifest.version || '');
const packageName = `Omnia-Agent-v5-Remote-Connector-v${version}-Portable.zip`;
const archive = path.join(root, 'remote-connector', 'public', 'releases', version, packageName);
const installer = path.join(root, 'ops', 'install_v5_remote_connector_release.py');
const caddyUpdater = path.join(root, 'ops', 'update_download_caddy_v5.py');
const sshKey = path.resolve(
  process.env.OMNIA_V5_REMOTE_CONNECTOR_SSH_KEY
    || path.join(os.homedir(), '.ssh', 'LightsailDefaultKey-ap-northeast-1.pem')
);
const remote = process.env.OMNIA_V5_REMOTE_CONNECTOR_SSH_TARGET || 'ubuntu@agent.labcaspian.com';
const nonce = `${Date.now()}-${process.pid}`;
const staging = `/tmp/omnia-v5-remote-connector-${nonce}`;

for (const filename of [archive, stable, installer, caddyUpdater, sshKey]) {
  if (!fs.existsSync(filename)) throw new Error(`Required release or deployment file is unavailable: ${filename}`);
}

if (manifest.version !== version || manifest.sequence <= 0) throw new Error('Local v5 stable manifest is invalid.');
const localArchive = fs.readFileSync(archive);
const localSha = crypto.createHash('sha256').update(localArchive).digest('hex');
if (manifest.sha256 !== localSha || manifest.size !== localArchive.length) {
  throw new Error('Local v5 stable manifest does not match the release archive.');
}

const sshBase = [
  '-i', sshKey,
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=yes'
];

const v4Before = remoteCapture(
  "sudo sha256sum /opt/omnia-agent/current/public/downloads/connector-stable.json | awk '{print $1}'"
).trim();
if (!/^[0-9a-f]{64}$/.test(v4Before)) throw new Error('Could not capture the v4 stable manifest digest before deployment.');

remoteRun(`mkdir -p '${staging}'`);
try {
  scp(archive, `${remote}:${staging}/${packageName}`);
  scp(stable, `${remote}:${staging}/stable.json`);
  scp(installer, `${remote}:${staging}/install-release.py`);
  scp(caddyUpdater, `${remote}:${staging}/update-caddy.py`);
  remoteRun(
    `sudo python3 '${staging}/install-release.py' '${staging}/${packageName}' '${staging}/stable.json'`
  );

  const backup = `/etc/caddy/Caddyfile.before-v5-remote-connector-${nonce}`;
  remoteRun(
    `sudo cp -p /etc/caddy/Caddyfile '${backup}'`
    + ` && sudo python3 '${staging}/update-caddy.py' /etc/caddy/Caddyfile`
    + ` && (sudo caddy validate --config /etc/caddy/Caddyfile`
    + ` && sudo systemctl reload caddy`
    + ` || (sudo cp -p '${backup}' /etc/caddy/Caddyfile`
    + ` && sudo caddy validate --config /etc/caddy/Caddyfile`
    + ` && sudo systemctl reload caddy && exit 1))`
  );
} finally {
  remoteRun(`rm -rf -- '${staging}'`, { allowFailure: true });
}

const v4After = remoteCapture(
  "sudo sha256sum /opt/omnia-agent/current/public/downloads/connector-stable.json | awk '{print $1}'"
).trim();
if (v4After !== v4Before) throw new Error('v4 Connector stable manifest changed during the isolated v5 deployment.');

const publishedStable = curlJson('https://download.labcaspian.com/files/v5-remote-connector/stable.json');
if (
  publishedStable.product !== manifest.product
  || publishedStable.version !== manifest.version
  || publishedStable.sequence !== manifest.sequence
  || publishedStable.sha256 !== manifest.sha256
) throw new Error('Published v5 Remote Connector stable manifest does not match the local signed manifest.');

const header = curlHead(manifest.url);
if (
  !/HTTP\/[0-9.]+ 200(?:\s|$)/m.test(header)
  || !header.toLowerCase().includes('content-type: application/zip')
  || !header.toLowerCase().includes(`content-length: ${manifest.size}`)
) {
  throw new Error('Published v5 Remote Connector archive is unavailable or has the wrong size/type.');
}
const stableHeader = curlHead('https://download.labcaspian.com/files/v5-remote-connector/stable.json');
if (!stableHeader.toLowerCase().includes('cache-control: no-store')) {
  throw new Error('Published v5 Remote Connector stable manifest is not served with no-store.');
}

console.log(JSON.stringify({
  ok: true,
  product: manifest.product,
  version: manifest.version,
  sequence: manifest.sequence,
  sha256: manifest.sha256,
  size: manifest.size,
  stableUrl: 'https://download.labcaspian.com/files/v5-remote-connector/stable.json',
  archiveUrl: manifest.url,
  v4ManifestUnchanged: true
}, null, 2));

function remoteRun(command, options = {}) {
  const result = spawnSync('ssh', [...sshBase, remote, command], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Remote command failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function remoteCapture(command) {
  const result = remoteRun(command);
  return String(result.stdout || '');
}

function scp(source, destination) {
  let lastResult;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = spawnSync('scp', [
      '-O',
      ...sshBase,
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=12',
      source,
      destination
    ], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (lastResult.status === 0) return;
  }
  throw new Error(`SCP failed after three attempts: ${lastResult?.stderr || lastResult?.stdout}`);
}

function curlJson(url) {
  const result = spawnSync('curl.exe', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '30', url
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Public manifest fetch failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function curlHead(url) {
  const result = spawnSync('curl.exe', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '30', '--head', url
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Public release HEAD failed: ${result.stderr}`);
  return String(result.stdout || '');
}
