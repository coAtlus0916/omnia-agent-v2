import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = '0.4.8';
const releasesRoot = path.join(root, 'bridge', 'releases');
const releaseTarget = path.join(releasesRoot, version);
const release = path.join(releasesRoot, `.staging-${version}-${process.pid}-${Date.now()}`);
const windowsRoot = path.join(release, 'windows-portable');
const linuxRoot = path.join(release, 'linux-docker');

// Version directories are immutable. This only rebuilds the explicit current
// target and never reads, removes, or rewrites bridge/releases/0.1.0.
if (fs.existsSync(releaseTarget)) throw new Error(`Immutable Bridge release already exists: ${releaseTarget}`);
fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(release, { recursive: true });

try {

if (process.platform === 'win32') {
  fs.mkdirSync(path.join(windowsRoot, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(windowsRoot, 'app'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(windowsRoot, 'runtime', 'node.exe'));
  fs.copyFileSync(path.join(root, 'dist', 'bridge', 'server.cjs'), path.join(windowsRoot, 'app', 'server.cjs'));
  fs.writeFileSync(path.join(windowsRoot, 'StartBridge.cmd'), [
    '@echo off',
    'setlocal',
    'if "%OMNIA_V5_BRIDGE_TOKEN_SECRET%"=="" echo Missing OMNIA_V5_BRIDGE_TOKEN_SECRET & exit /b 1',
    '"%~dp0runtime\\node.exe" "%~dp0app\\server.cjs"'
  ].join('\r\n') + '\r\n');
  fs.writeFileSync(path.join(windowsRoot, 'README.txt'), [
    `Omnia Agent v5 Bridge ${version} - Windows portable`,
    'Required: OMNIA_V5_BRIDGE_TOKEN_SECRET (32+). Pairing sessions are created only by the Shell top Connect flow.',
    'Default bind: 127.0.0.1:18785.',
    'This package is independent from every v4 process, port, secret, and release path.'
  ].join('\r\n') + '\r\n');
}

fs.mkdirSync(linuxRoot, { recursive: true });
fs.copyFileSync(path.join(root, 'dist', 'bridge', 'server.cjs'), path.join(linuxRoot, 'server.cjs'));
for (const name of [
  'Dockerfile',
  'docker-compose.yml',
  'bridge.env.example',
  'install.sh',
  'caddy-route.py',
  'install-caddy-route.sh',
  'rollback-caddy-route.sh'
]) fs.copyFileSync(path.join(root, 'ops', 'bridge', name), path.join(linuxRoot, name));
fs.writeFileSync(path.join(linuxRoot, 'README.md'), [
  `# Omnia Agent v5 Bridge ${version} — Ubuntu/Docker`,
  '',
  'This artifact needs Docker Engine with the Compose plugin, Caddy, curl, and Python 3.',
  '',
  '```sh',
  'sudo sh install.sh',
  'sudo sh install-caddy-route.sh labcaspian.com /etc/caddy/Caddyfile',
  '```',
  '',
  '- Container: `omnia-agent-v5-bridge` (`node:24-alpine`, `restart: unless-stopped`).',
  '- Host bind: `127.0.0.1:18785` only.',
  '- Install root: `/opt/omnia-agent-v5-bridge` only.',
  '- Public route: `/v5-bridge/*`, with the prefix stripped before proxying.',
  '- One-time pairing sessions are created by the authenticated product flow at the Shell top Connect surface.',
  '- Caddy patch is marker-bound, validated before reload, and has an explicit rollback.',
  '- The scripts never stop, inspect, replace, or reuse a v4 service/container.',
  ''
].join('\n'));

const files = listFiles(release)
  .filter((filename) => path.basename(filename) !== 'release-manifest.json')
  .map((filename) => ({
    path: path.relative(release, filename).split(path.sep).join('/'),
    size: fs.statSync(filename).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
  }))
  .sort((left, right) => left.path.localeCompare(right.path));
fs.writeFileSync(path.join(release, 'release-manifest.json'), `${JSON.stringify({
  schemaVersion: 'omnia.v5.bridge-release/v1',
  product: 'omnia-agent-v5-bridge',
  version,
  targets: process.platform === 'win32' ? ['windows-portable', 'linux-docker'] : ['linux-docker'],
  signed: false,
  signingStatus: 'organization_code_signing_required_before_distribution',
  files
}, null, 2)}\n`);

fs.renameSync(release, releaseTarget);
console.log(`Packaged v5 Bridge ${version} at ${releaseTarget}`);
} catch (error) {
  fs.rmSync(release, { recursive: true, force: true });
  throw error;
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}
