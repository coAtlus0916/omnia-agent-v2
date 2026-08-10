import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRemoteConnector } from './build-remote-connector.mjs';

if (process.platform !== 'win32') throw new Error('v5 Remote Connector portable packaging requires Windows.');

const root = path.resolve(import.meta.dirname, '..');
const version = '0.3.36';
const sequence = 39;
const supervisorVersion = '0.1.7';
const product = 'omnia-agent-v5-remote-connector';
const platform = 'win32-x64';
const keyId = 'v5-remote-connector-release-2026-01';
const managedPythonRoot = path.join(
  root,
  'releases',
  'runtime',
  'python',
  'cpython-3.13.14-embed-amd64'
);
const managedPython = path.join(managedPythonRoot, 'python.exe');
const managedPythonManifestPath = path.join(managedPythonRoot, 'runtime-manifest.json');
if (!fs.existsSync(managedPython) || !fs.existsSync(managedPythonManifestPath)) {
  throw new Error('Release-managed CPython 3.13.14 is required for Connector archive creation.');
}
const managedPythonManifest = JSON.parse(fs.readFileSync(managedPythonManifestPath, 'utf8'));
if (managedPythonManifest.schemaVersion !== 'omnia.managed-python-runtime/v1'
  || managedPythonManifest.implementation !== 'CPython'
  || managedPythonManifest.version !== '3.13.14'
  || managedPythonManifest.architecture !== 'win32-x64'
  || managedPythonManifest.distribution !== 'embeddable'
  || managedPythonManifest.sitePackagesEnabled !== false
  || managedPythonManifest.runtimePipEnabled !== false) {
  throw new Error('Release-managed Python runtime identity is invalid.');
}
const managedPythonProbe = spawnSync(managedPython, ['-I', '-S', '-c', 'import sys; print(sys.version.split()[0])'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true
});
if (managedPythonProbe.status !== 0 || String(managedPythonProbe.stdout || '').trim() !== '3.13.14') {
  throw new Error('Connector archive creation requires the release-managed CPython 3.13.14 executable.');
}
const connectorBuildRoot = fs.mkdtempSync(path.join(os.tmpdir(), `omnia-v5-connector-build-${version}-`));
const cleanupConnectorBuild = () => fs.rmSync(connectorBuildRoot, { recursive: true, force: true });
process.once('exit', cleanupConnectorBuild);
const connectorBuild = await buildRemoteConnector(connectorBuildRoot);
const dependencyInputRoots = [...new Set(connectorBuild.inputs
  .filter((input) => input.startsWith('node_modules/'))
  .map((input) => {
    const parts = input.split('/');
    return parts[1]?.startsWith('@') ? `node_modules/${parts[1]}/${parts[2]}` : `node_modules/${parts[1]}`;
  }))].sort();
dependencyInputRoots.push('node_modules/playwright-core');
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const dependencyRoot of [...new Set(dependencyInputRoots)]) {
  const locked = packageLock.packages?.[dependencyRoot];
  const installedManifestPath = path.join(root, dependencyRoot, 'package.json');
  if (!locked?.version || !fs.existsSync(installedManifestPath)) {
    throw new Error(`Connector dependency ${dependencyRoot} is absent from the exact lockfile or installed tree.`);
  }
  const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, 'utf8'));
  if (installedManifest.version !== locked.version) {
    throw new Error(`Connector dependency ${dependencyRoot} does not match package-lock.json.`);
  }
}
const packageInputs = [...new Set([
  ...connectorBuild.inputs.filter((input) => !input.startsWith('node_modules/')),
  'scripts/build-remote-connector.mjs',
  'scripts/package-remote-connector.mjs',
  'scripts/create-remote-connector-zip.py',
  'package.json',
  'package-lock.json'
])].sort();
const trackedInputs = spawnSync('git', ['ls-files', '--error-unmatch', '--', ...packageInputs], {
  cwd: root, encoding: 'utf8', windowsHide: true
});
if (trackedInputs.status !== 0) {
  fs.rmSync(connectorBuildRoot, { recursive: true, force: true });
  throw new Error('Every transitive Connector build and packaging input must be tracked by Git.');
}
const dirtyInputs = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', ...packageInputs], {
  cwd: root, encoding: 'utf8', windowsHide: true
});
if (dirtyInputs.status !== 0) {
  fs.rmSync(connectorBuildRoot, { recursive: true, force: true });
  throw new Error('Refusing to package from Connector inputs that differ from the exact source commit.');
}
const sourceCommitResult = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true
});
const sourceCommit = String(sourceCommitResult.stdout || '').trim();
if (sourceCommitResult.status !== 0 || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
  throw new Error('Unable to bind the Connector package to an exact Git source commit.');
}
const packageName = `Omnia-Agent-v5-Remote-Connector-v${version}-Portable`;
const runId = `${process.pid}-${Date.now()}`;
const candidateOutputRoot = path.join(root, 'remote-connector', 'candidates');
const releaseTarget = path.join(candidateOutputRoot, version);
const releaseRoot = path.join(candidateOutputRoot, `.staging-${version}-${runId}`);
const portableRoot = path.join(releaseRoot, packageName);
const zipPath = path.join(releaseRoot, `${packageName}.zip`);
const publicRoot = path.join(root, 'remote-connector', 'public');
const publicReleasesRoot = path.join(publicRoot, 'releases');
const stableManifestPath = path.join(publicRoot, 'stable.json');
const candidateProtectedPublicSnapshot = publicPointerSnapshot();
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

for (const forbiddenOverride of [
  'OMNIA_V5_REMOTE_CONNECTOR_CANDIDATE_ONLY',
  'OMNIA_V5_REMOTE_CONNECTOR_CANDIDATE_OUTPUT_ROOT',
  'OMNIA_V5_REMOTE_CONNECTOR_RELEASE_SEQUENCE',
  'OMNIA_V5_REMOTE_CONNECTOR_PYTHON'
]) {
  if (process.env[forbiddenOverride]) {
    throw new Error(`${forbiddenOverride} is not accepted: Connector packaging is always candidate-only at ${candidateOutputRoot}.`);
  }
}

if (!Number.isSafeInteger(sequence) || sequence <= 0) {
  throw new Error('The immutable Remote Connector release sequence must be a positive integer.');
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

if (fs.existsSync(releaseTarget)) throw new Error(`Immutable Remote Connector candidate already exists: ${releaseTarget}`);
fs.rmSync(releaseRoot, { recursive: true, force: true });
let releasePublished = false;
try {
fs.mkdirSync(path.join(portableRoot, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(portableRoot, 'app'), { recursive: true });
fs.mkdirSync(path.join(portableRoot, 'app', 'node_modules'), { recursive: true });

for (const name of ['cli.cjs', 'guardian.cjs', 'supervisor.cjs', 'worker.cjs']) {
  fs.copyFileSync(
    path.join(connectorBuild.outputRoot, name),
    path.join(portableRoot, 'app', name)
  );
}
assertPassiveRefreshRuntime(path.join(portableRoot, 'app', 'worker.cjs'));
fs.cpSync(
  path.join(root, 'node_modules', 'playwright-core'),
  path.join(portableRoot, 'app', 'node_modules', 'playwright-core'),
  { recursive: true }
);
// Playwright CLI skill markdown is development-only and contains paths that
// Windows tar.exe cannot round-trip under the portable root. Runtime code does
// not load it; excluding it keeps the signed inventory extractable on the
// managed company-machine path.
fs.rmSync(
  path.join(portableRoot, 'app', 'node_modules', 'playwright-core', 'lib', 'tools', 'skills'),
  { recursive: true, force: true }
);
// The Connector never installs browsers or runs Playwright's CLI. Excluding
// the cross-platform installer scripts prevents corporate endpoint controls
// from removing .ps1/.sh files between extraction and signed inventory
// verification. The browser connection runtime remains unchanged.
fs.rmSync(
  path.join(portableRoot, 'app', 'node_modules', 'playwright-core', 'bin'),
  { recursive: true, force: true }
);
// The Connector uses Playwright only as a CDP client. Trace Viewer, Recorder,
// Dashboard and Inspector are development UIs and are never loaded by the
// worker. Their Vite assets include generated filenames that corporate Windows
// endpoint controls may remove during extraction, which would correctly fail
// the signed inventory gate. Exclude the unused UI tree before manifesting so
// the portable runtime stays both minimal and round-trip stable.
fs.rmSync(
  path.join(portableRoot, 'app', 'node_modules', 'playwright-core', 'lib', 'vite'),
  { recursive: true, force: true }
);
// The managed Connector attaches to an already running Edge instance through
// connectOverCDP. It never launches Chromium/Electron, downloads browsers, or
// exposes Playwright's standalone CLI/dashboard tooling. Corporate Windows extraction
// policy removes these dormant helper files, so carrying them would make the
// signed inventory non-round-trippable even though no Connector path loads
// them. Keep the CDP runtime and the package LICENSE; exclude only the exact
// launch/download/CLI assets outside that runtime boundary.
for (const relative of [
  ['lib', 'entry', 'oopBrowserDownload.js'],
  ['lib', 'server', 'chromium', 'appIcon.png'],
  ['lib', 'server', 'electron'],
  ['lib', 'serverRegistry.js.LICENSE'],
  ['lib', 'tools']
]) {
  fs.rmSync(
    path.join(portableRoot, 'app', 'node_modules', 'playwright-core', ...relative),
    { recursive: true, force: true }
  );
}
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
  '- 0.3.36 是最后一次需要本机 portable/cold-start 的升级基线；运行中的 0.3.35/Supervisor 0.1.6 只能暂存，不能安全地在线激活本版。',
  '- 本机运行本包 StartRemoteConnector.cmd 后会安装 Guardian 0.1.0 与双槽 Supervisor 0.1.7；从 0.3.37 起，兼容更新才可走完整的在线维护事务。',
  '- 安装后使用版本无关的托管启动器并注册当前用户登录自启动；旧解压目录不参与后续启动或升级。',
  '- Supervisor 自动检查官方 stable 清单；只有命令排空且无 active/uncertain operation 时才激活。',
  '- candidate 健康/probation 失败会恢复 previous，并阻止重复坏 sequence。',
  '- 独立更新清单：',
  '   https://download.example.invalid/files/v5-remote-connector/stable.json',
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
  supervisorVersion,
  sourceCommit,
  platform,
  installDirectory: 'OmniaAgentV5RemoteConnector',
  dataDirectory: 'OmniaAgentV5RemoteConnector',
  updateManifestUrl: 'https://download.example.invalid/files/v5-remote-connector/stable.json',
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
verifyArchiveRoundTrip();

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
  url: `https://download.example.invalid/files/v5-remote-connector/releases/${version}/${path.basename(zipPath)}`,
  sha256: archiveSha256,
  size: archiveSize,
  // 0.3.36 intentionally requires the locally bootstrapped 0.1.7 guardian
  // baseline. A running 0.1.6 may stage but cannot safely activate it online.
  minimumSupervisorVersion: supervisorVersion,
  rolloutPolicy: 'automatic_safe_window',
  securitySeverity: 'normal',
  newRunStopAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  maxDrainUntil: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  offerExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  keyId,
  signature: ''
};
updateManifest.signature = sign(updateManifest);
fs.writeFileSync(
  path.join(releaseRoot, 'candidate-update-manifest.json'),
  `${JSON.stringify(updateManifest, null, 2)}\n`,
  'utf8'
);
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

console.log(`Built candidate ${path.join(releaseTarget, packageName)}`);
console.log(`Candidate archive ${path.join(releaseTarget, path.basename(zipPath))}`);
console.log(`Candidate manifest ${path.join(releaseTarget, 'candidate-update-manifest.json')}`);
console.log(`SHA-256 ${archiveSha256}`);
console.log(`Size ${archiveSize}`);
} catch (error) {
  if (releasePublished && fs.existsSync(releaseTarget)) fs.renameSync(releaseTarget, releaseRoot);
  fs.rmSync(releaseRoot, { recursive: true, force: true });
  throw error;
} finally {
  cleanupConnectorBuild();
  process.removeListener('exit', cleanupConnectorBuild);
  if (publicPointerSnapshot() !== candidateProtectedPublicSnapshot) {
    throw new Error('Candidate-only packaging changed the protected public/stable release tree.');
  }
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

function publicPointerSnapshot() {
  const stable = fs.existsSync(stableManifestPath)
    ? { exists: true, size: fs.statSync(stableManifestPath).size, digest: sha256File(stableManifestPath) }
    : { exists: false };
  const releases = fs.existsSync(publicReleasesRoot)
    ? listFiles(publicReleasesRoot).map((filename) => ({
        path: path.relative(publicReleasesRoot, filename).split(path.sep).join('/'),
        size: fs.statSync(filename).size,
        digest: sha256File(filename)
      })).sort((left, right) => left.path.localeCompare(right.path))
    : [];
  return canonicalJson({ stable, releases });
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

function smokeTest(targetRoot = portableRoot) {
  const probe = spawnSync(
    path.join(targetRoot, 'runtime', 'node.exe'),
    [path.join(targetRoot, 'app', 'worker.cjs'), '--health-probe'],
    { cwd: targetRoot, encoding: 'utf8', windowsHide: true }
  );
  if (probe.status !== 0) throw new Error(`Remote Connector health probe failed: ${probe.stderr || probe.stdout}`);
  const status = JSON.parse(probe.stdout);
  if (status.ok !== true || status.product !== product || status.version !== version
    || Number(status.sequence) !== sequence || status.supervisorVersion !== supervisorVersion) {
    throw new Error('Remote Connector health probe returned the wrong product identity.');
  }
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-remote-connector-smoke-'));
  try {
    const installRoot = path.join(smokeRoot, 'install');
    const dataRoot = path.join(smokeRoot, 'data');
    const startupEntry = path.join(smokeRoot, 'startup', 'Omnia Agent v5 Remote Connector.cmd');
    const install = spawnSync(
      path.join(targetRoot, 'runtime', 'node.exe'),
      [path.join(targetRoot, 'app', 'cli.cjs'), 'install'],
      {
        cwd: targetRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT: installRoot,
          OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT: dataRoot,
          OMNIA_V5_REMOTE_CONNECTOR_STARTUP_ENTRY: startupEntry
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
  const result = spawnSync(
    managedPython,
    [path.join(root, 'scripts', 'create-remote-connector-zip.py'), portableRoot, zipPath],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Remote Connector ZIP creation failed with exit code ${result.status}.`);
}

function assertPassiveRefreshRuntime(workerPath) {
  const packagedWorkerSource = fs.readFileSync(workerPath, 'utf8');
  const refreshStart = packagedWorkerSource.indexOf('async refresh()');
  const refreshEnd = packagedWorkerSource.indexOf('async workspaceAuthorityRead(', refreshStart);
  if (refreshStart < 0 || refreshEnd <= refreshStart) {
    throw new Error('Packaged Remote Connector does not expose the expected refresh lifecycle method.');
  }
  const packagedRefresh = packagedWorkerSource.slice(refreshStart, refreshEnd);
  if (!/return\s+this\.status\(\)/.test(packagedRefresh)) {
    throw new Error('Packaged Remote Connector refresh is not a passive status probe.');
  }
  for (const forbidden of [
    /\.reload\s*\(/,
    /\.goto\s*\(/,
    /\.bringToFront\s*\(/,
    /\.newPage\s*\(/,
    /this\.connect\s*\(/,
    /this\.ensureBrowser\s*\(/,
    /this\.currentPage\s*\(/
  ]) {
    if (forbidden.test(packagedRefresh)) {
      throw new Error(`Packaged Remote Connector refresh contains a forbidden browser action: ${forbidden}`);
    }
  }
}

function verifyArchiveRoundTrip() {
  const extraction = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-remote-connector-archive-'));
  try {
    const result = spawnSync('tar.exe', ['-xf', zipPath, '-C', extraction], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.status !== 0) {
      throw new Error(`Remote Connector archive round-trip extraction failed: ${result.stderr || result.stdout}`);
    }
    const roots = fs.readdirSync(extraction, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (roots.length !== 1) throw new Error('Remote Connector archive round-trip did not contain exactly one portable root.');
    smokeTest(path.join(extraction, roots[0].name));
  } finally {
    fs.rmSync(extraction, { recursive: true, force: true });
  }
}
