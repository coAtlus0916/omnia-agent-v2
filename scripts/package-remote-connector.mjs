import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('v5 Remote Connector portable packaging requires Windows.');

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = '0.3.17';
const sequence = Number(process.env.OMNIA_V5_REMOTE_CONNECTOR_RELEASE_SEQUENCE || 20);
const product = 'omnia-agent-v5-remote-connector';
const platform = 'win32-x64';
const keyId = 'v5-remote-connector-release-2026-01';
const packageName = `Omnia-Agent-v5-Remote-Connector-v${version}-Portable`;
const runId = `${process.pid}-${Date.now()}`;
const releasesRoot = path.join(root, 'remote-connector', 'releases');
const releaseTarget = path.join(releasesRoot, version);
const releaseRoot = path.join(releasesRoot, `.staging-${version}-${runId}`);
const portableRoot = path.join(releaseRoot, packageName);
const zipPath = path.join(releaseRoot, `${packageName}.zip`);
const publicRoot = path.join(root, 'remote-connector', 'public');
const publicReleasesRoot = path.join(publicRoot, 'releases');
const publicReleaseTarget = path.join(publicReleasesRoot, version);
const publicReleaseRoot = path.join(publicReleasesRoot, `.staging-${version}-${runId}`);
const publicZipPath = path.join(publicReleaseRoot, path.basename(zipPath));
const stableManifestPath = path.join(publicRoot, 'stable.json');
const stableManifestStage = path.join(publicRoot, `.stable-${runId}.json`);
const stableManifestBackup = path.join(publicRoot, `.stable-${runId}.previous.json`);
const defaultPrivateKey = path.join(
  os.homedir(),
  '.omnia-agent-v5',
  'signing',
  'remote-connector-ed25519-private.pem'
);
const privateKeyPath = path.resolve(
  process.env.OMNIA_V5_REMOTE_CONNECTOR_SIGNING_KEY_PATH || defaultPrivateKey
);
const pinnedPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATbYvnzzsXe+iB16L64HedlrqoPCcVWZ4VC9P/GGJeSE=
-----END PUBLIC KEY-----`;

if (!Number.isSafeInteger(sequence) || sequence <= 0) {
  throw new Error('OMNIA_V5_REMOTE_CONNECTOR_RELEASE_SEQUENCE must be a positive integer.');
}
if (!fs.existsSync(privateKeyPath)) {
  throw new Error('The offline v5 Remote Connector signing key is unavailable.');
}

const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
const derivedPublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const expectedPublicKey = crypto.createPublicKey(pinnedPublicKey).export({ type: 'spki', format: 'der' });
if (
  derivedPublicKey.length !== expectedPublicKey.length
  || !crypto.timingSafeEqual(derivedPublicKey, expectedPublicKey)
) throw new Error('The v5 Remote Connector signing key does not match the pinned public key.');

for (const immutableTarget of [releaseTarget, publicReleaseTarget]) {
  if (fs.existsSync(immutableTarget)) throw new Error(`Immutable Remote Connector release already exists: ${immutableTarget}`);
}
fs.rmSync(releaseRoot, { recursive: true, force: true });
fs.rmSync(publicReleaseRoot, { recursive: true, force: true });
fs.rmSync(stableManifestStage, { force: true });
fs.rmSync(stableManifestBackup, { force: true });
let releasePublished = false;
let publicReleasePublished = false;
let stablePreviousMoved = false;
let stablePublished = false;
try {
fs.mkdirSync(path.join(portableRoot, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(portableRoot, 'app'), { recursive: true });
fs.mkdirSync(path.join(portableRoot, 'app', 'node_modules'), { recursive: true });
fs.mkdirSync(publicReleaseRoot, { recursive: true });

for (const name of ['cli.cjs', 'supervisor.cjs', 'worker.cjs']) {
  fs.copyFileSync(
    path.join(root, 'dist', 'remote-connector', name),
    path.join(portableRoot, 'app', name)
  );
}
fs.cpSync(
  path.join(root, 'node_modules', 'playwright-core'),
  path.join(portableRoot, 'app', 'node_modules', 'playwright-core'),
  { recursive: true }
);
fs.copyFileSync(process.execPath, path.join(portableRoot, 'runtime', 'node.exe'));

writeText('StartRemoteConnector.cmd', [
  '@echo off',
  'setlocal',
  '"%~dp0runtime\\node.exe" "%~dp0app\\cli.cjs" start',
  'if errorlevel 1 pause'
].join('\r\n') + '\r\n');
writeText('PairRemoteConnector.cmd', [
  '@echo off',
  'setlocal',
  '"%~dp0runtime\\node.exe" "%~dp0app\\cli.cjs" pair',
  'pause'
].join('\r\n') + '\r\n');
writeText('InstallRemoteConnector.cmd', [
  '@echo off',
  'setlocal',
  '"%~dp0runtime\\node.exe" "%~dp0app\\cli.cjs" install',
  'pause'
].join('\r\n') + '\r\n');
writeText('StatusRemoteConnector.cmd', [
  '@echo off',
  'setlocal',
  '"%~dp0runtime\\node.exe" "%~dp0app\\cli.cjs" status',
  'pause'
].join('\r\n') + '\r\n');
writeText('CheckForUpdates.cmd', [
  '@echo off',
  'setlocal',
  '"%~dp0runtime\\node.exe" "%~dp0app\\cli.cjs" check-update',
  'pause'
].join('\r\n') + '\r\n');
writeText('StopRemoteConnector.cmd', [
  '@echo off',
  'setlocal',
  '"%~dp0runtime\\node.exe" "%~dp0app\\cli.cjs" stop',
  'pause'
].join('\r\n') + '\r\n');
writeText('README.txt', [
  'Omnia Agent v5 Remote Connector',
  `版本：${version}（sequence ${sequence}）`,
  '',
  '首次配对：',
  '1. 在 Omnia Agent 顶部点击 Connect，读取 Shell 显示的一次性链接码。',
  '2. 在能够访问 Omnia 的公司电脑上双击 PairRemoteConnector.cmd，并输入该链接码。',
  '3. 双击 StartRemoteConnector.cmd；设备凭据由 Windows DPAPI CurrentUser 保护，正常重启无需再次输入链接码。',
  '4. 登录受控 Edge 并打开唯一目标 Pack；Shell 会自动识别真实 Pack，无需第二次点击 Connect。',
  '',
  '安全与升级：',
  '- v5 与 v4 完全共存，不停止、不读取、不覆盖、不配对或升级 v4 Connector。',
  '- v5 安装目录：%LOCALAPPDATA%\\OmniaAgentV5RemoteConnector。',
  '- v5 数据目录：%APPDATA%\\OmniaAgentV5RemoteConnector。',
  '- 正常升级完全自动：Bridge 连接时及在线期间下发检查信号，Supervisor 也会独立轮询 stable；用户不搬包、不运行安装器。',
  '- 安装后使用版本无关的托管启动器并注册当前用户登录自启动；旧解压目录不参与后续启动或升级。',
  '- Supervisor 自动检查官方 stable 清单；只有命令排空且无 active/uncertain operation 时才激活。',
  '- candidate 健康/probation 失败会恢复 previous，并阻止重复坏 sequence。',
  '- 独立更新清单：',
  '   https://download.labcaspian.com/files/v5-remote-connector/stable.json',
  '',
  '诊断/恢复：',
  '- StatusRemoteConnector.cmd：查看真实等待、连接、命令与更新状态。',
  '- PairRemoteConnector.cmd：首次配对或用户明确重新配对时，消费 Shell 生成的一次性链接码。',
  '- StopRemoteConnector.cmd：只停止 v5。'
].join('\r\n') + '\r\n');
writeText('package-identity.json', `${JSON.stringify({
  schemaVersion: 'omnia.v5.remote-connector-identity/v1',
  product,
  version,
  sequence,
  platform,
  installDirectory: 'OmniaAgentV5RemoteConnector',
  dataDirectory: 'OmniaAgentV5RemoteConnector',
  updateManifestUrl: 'https://download.labcaspian.com/files/v5-remote-connector/stable.json',
  v4Coexistence: 'isolated'
}, null, 2)}\n`);

const files = listFiles(portableRoot).map((filename) => ({
  path: path.relative(portableRoot, filename).split(path.sep).join('/'),
  size: fs.statSync(filename).size,
  sha256: sha256File(filename)
})).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const portableManifest = {
  schemaVersion: 'omnia.v5.remote-connector-portable/v1',
  product,
  version,
  sequence,
  platform,
  keyId,
  files,
  signature: ''
};
portableManifest.signature = sign(portableManifest);
fs.writeFileSync(
  path.join(portableRoot, 'portable-manifest.json'),
  `${JSON.stringify(portableManifest, null, 2)}\n`,
  'utf8'
);

smokeTest();
createZip();
fs.copyFileSync(zipPath, publicZipPath);

const archiveSize = fs.statSync(zipPath).size;
const archiveSha256 = sha256File(zipPath);
const updateManifest = {
  schemaVersion: 'omnia.v5.remote-connector-update/v1',
  product,
  channel: 'stable',
  platform,
  version,
  sequence,
  publishedAt: new Date().toISOString(),
  url: `https://download.labcaspian.com/files/v5-remote-connector/releases/${version}/${path.basename(zipPath)}`,
  sha256: archiveSha256,
  size: archiveSize,
  minimumSupervisorVersion: '0.1.0',
  rolloutPolicy: 'automatic_safe_window',
  securitySeverity: 'normal',
  newRunStopAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  maxDrainUntil: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  offerExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  keyId,
  signature: ''
};
updateManifest.signature = sign(updateManifest);
fs.writeFileSync(stableManifestStage, `${JSON.stringify(updateManifest, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(releaseRoot, 'sbom.json'), `${JSON.stringify({
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: product,
      version
    }
  },
  components: [
    {
      type: 'application',
      name: 'node',
      version: process.versions.node,
      hashes: [{ alg: 'SHA-256', content: sha256File(process.execPath) }]
    }
  ]
}, null, 2)}\n`, 'utf8');

fs.renameSync(releaseRoot, releaseTarget);
releasePublished = true;
fs.renameSync(publicReleaseRoot, publicReleaseTarget);
publicReleasePublished = true;
if (fs.existsSync(stableManifestPath)) {
  fs.renameSync(stableManifestPath, stableManifestBackup);
  stablePreviousMoved = true;
}
fs.renameSync(stableManifestStage, stableManifestPath);
stablePublished = true;
if (stablePreviousMoved) {
  try { fs.rmSync(stableManifestBackup, { force: true }); } catch { /* new stable is already atomically published */ }
  stablePreviousMoved = false;
}

console.log(`Built ${path.join(releaseTarget, packageName)}`);
console.log(`Archive ${path.join(releaseTarget, path.basename(zipPath))}`);
console.log(`Stable manifest ${stableManifestPath}`);
console.log(`SHA-256 ${archiveSha256}`);
console.log(`Size ${archiveSize}`);
} catch (error) {
  if (stablePublished && fs.existsSync(stableManifestPath)) fs.renameSync(stableManifestPath, stableManifestStage);
  if (stablePreviousMoved && fs.existsSync(stableManifestBackup)) fs.renameSync(stableManifestBackup, stableManifestPath);
  if (publicReleasePublished && fs.existsSync(publicReleaseTarget)) fs.renameSync(publicReleaseTarget, publicReleaseRoot);
  if (releasePublished && fs.existsSync(releaseTarget)) fs.renameSync(releaseTarget, releaseRoot);
  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.rmSync(publicReleaseRoot, { recursive: true, force: true });
  fs.rmSync(stableManifestStage, { force: true });
  fs.rmSync(stableManifestBackup, { force: true });
  throw error;
}

function writeText(relative, value) {
  fs.writeFileSync(path.join(portableRoot, relative), value, 'utf8');
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(target);
    if (!entry.isFile()) throw new Error(`Unsupported portable entry: ${target}`);
    return [target];
  });
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function canonicalJson(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sign(value) {
  const payload = { ...value };
  delete payload.signature;
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64');
}

function smokeTest() {
  const probe = spawnSync(
    path.join(portableRoot, 'runtime', 'node.exe'),
    [path.join(portableRoot, 'app', 'worker.cjs'), '--health-probe'],
    { cwd: portableRoot, encoding: 'utf8', windowsHide: true }
  );
  if (probe.status !== 0) throw new Error(`Remote Connector health probe failed: ${probe.stderr || probe.stdout}`);
  const status = JSON.parse(probe.stdout);
  if (status.ok !== true || status.product !== product || status.version !== version) {
    throw new Error('Remote Connector health probe returned the wrong product identity.');
  }
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-remote-connector-smoke-'));
  try {
    const installRoot = path.join(smokeRoot, 'install');
    const dataRoot = path.join(smokeRoot, 'data');
    const install = spawnSync(
      path.join(portableRoot, 'runtime', 'node.exe'),
      [path.join(portableRoot, 'app', 'cli.cjs'), 'install'],
      {
        cwd: portableRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: installRoot,
          OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: dataRoot
        }
      }
    );
    if (install.status !== 0) throw new Error(`Remote Connector install smoke failed: ${install.stderr || install.stdout}`);
    const state = JSON.parse(fs.readFileSync(path.join(dataRoot, 'managed-state.json'), 'utf8'));
    if (state.current !== version || state.highestSequence !== sequence) {
      throw new Error('Remote Connector managed installation state is invalid.');
    }
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function createZip() {
  const python = process.env.OMNIA_V5_REMOTE_CONNECTOR_PYTHON || 'python.exe';
  const result = spawnSync(
    python,
    [path.join(root, 'scripts', 'create-remote-connector-zip.py'), portableRoot, zipPath],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Remote Connector ZIP creation failed with exit code ${result.status}.`);
}
