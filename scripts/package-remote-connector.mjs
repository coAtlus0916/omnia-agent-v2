import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('v5 Remote Connector portable packaging requires Windows.');

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = '0.3.4';
const sequence = Number(process.env.OMNIA_V5_REMOTE_CONNECTOR_RELEASE_SEQUENCE || 7);
const product = 'omnia-agent-v5-remote-connector';
const platform = 'win32-x64';
const keyId = 'v5-remote-connector-release-2026-01';
const packageName = `Omnia-Agent-v5-Remote-Connector-v${version}-Portable`;
const releaseRoot = path.join(root, 'remote-connector', 'releases', version);
const portableRoot = path.join(releaseRoot, packageName);
const zipPath = path.join(releaseRoot, `${packageName}.zip`);
const publicRoot = path.join(root, 'remote-connector', 'public');
const publicReleaseRoot = path.join(publicRoot, 'releases', version);
const publicZipPath = path.join(publicReleaseRoot, path.basename(zipPath));
const stableManifestPath = path.join(publicRoot, 'stable.json');
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

fs.rmSync(releaseRoot, { recursive: true, force: true });
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
  '正常使用（无需运行单独配对脚本）：',
  '1. 在能够访问 Omnia 的公司电脑上双击 StartRemoteConnector.cmd。',
  '2. Connector 会进入“等待 Omnia Agent 匹配”状态；不要关闭受控 Edge。',
  '3. 在 Omnia Agent 设置中选择 Remote，点击“查找并匹配 Remote Connector”。',
  '4. 如果出现多个候选，请核对公司电脑名称；匹配完成后点击首页 Connect。',
  '5. 登录受控 Edge 并打开唯一的目标 Pack；连接、刷新、保活、Workspace 和 Feature Operation 均走同一 Remote 会话。',
  '',
  '安全与升级：',
  '- v5 与 v4 完全共存，不停止、不读取、不覆盖、不配对或升级 v4 Connector。',
  '- v5 安装目录：%LOCALAPPDATA%\\OmniaAgentV5RemoteConnector。',
  '- v5 数据目录：%APPDATA%\\OmniaAgentV5RemoteConnector。',
  '- Supervisor 自动检查官方签名 stable 清单；只有命令排空且无 active/uncertain operation 时才激活。',
  '- candidate 健康/probation 失败会恢复 previous，并阻止重复坏 sequence。',
  '- 独立更新清单：',
  '   https://download.labcaspian.com/files/v5-remote-connector/stable.json',
  '',
  '诊断/恢复：',
  '- StatusRemoteConnector.cmd：查看真实等待、连接、命令与更新状态。',
  '- PairRemoteConnector.cmd：仅供管理员诊断旧式一次性 code；不是正常首次路径。',
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
fs.writeFileSync(stableManifestPath, `${JSON.stringify(updateManifest, null, 2)}\n`, 'utf8');
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

console.log(`Built ${portableRoot}`);
console.log(`Archive ${zipPath}`);
console.log(`Stable manifest ${stableManifestPath}`);
console.log(`SHA-256 ${archiveSha256}`);
console.log(`Size ${archiveSize}`);

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
