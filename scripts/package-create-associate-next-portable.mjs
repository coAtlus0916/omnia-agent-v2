import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The Connector Next loopback portable is Windows-only.');

const root = path.resolve(import.meta.dirname, '..');
const companyCurrent = process.argv.includes('--company-current');
const profile = companyCurrent ? 'company-loopback-current' : 'create-associate-only';
const shellVersion = String(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
const expectedFeatures = companyCurrent ? [
  ['omnia.create-associate', '0.2.150'],
  ['omnia.recording', '0.4.21'],
  ['omnia.delete-elements', '0.3.32'],
  ['omnia.workpaper-preparation', '0.1.83']
] : [['omnia.create-associate', '0.2.123']];
const artifactName = companyCurrent
  ? `Omnia-Agent-v5-${shellVersion}-Company-Loopback-Portable`
  : `Omnia-Agent-v5-${shellVersion}-Create-Associate-0.2.123-Connector-Next-Portable`;
const artifactsRoot = path.join(root, 'artifacts');
const target = path.join(artifactsRoot, artifactName);
const zipTarget = path.join(artifactsRoot, `${artifactName}.zip`);
const runId = `${process.pid}-${Date.now()}`;
const staging = path.join(artifactsRoot, `.staging-${artifactName}-${runId}`);
const releaseRoot = path.join(staging, shellVersion);
const appRoot = path.join(releaseRoot, 'resources', 'app');
const pythonDirectory = 'cpython-3.13.14-embed-amd64';
const pythonSource = path.join(root, '.codex-tmp', 'python-runtime', pythonDirectory);

if (existsSync(target) || existsSync(zipTarget)) throw new Error(`Immutable portable artifact already exists: ${artifactName}`);
for (const required of [
  path.join(pythonSource, 'python.exe'),
  path.join(pythonSource, 'runtime-manifest.json'),
  ...expectedFeatures.map(([featureId, version]) => {
    const directory = featureId === 'omnia.create-associate' ? 'create-associate'
      : featureId === 'omnia.recording' ? 'recording'
        : featureId === 'omnia.delete-elements' ? 'delete-elements'
          : 'workpaper-preparation';
    return path.join(root, 'feature-packages', directory, 'candidates', `${directory}-${version}.ofp`);
  }),
  path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  path.join(root, 'node_modules', 'playwright-core', 'package.json')
]) if (!existsSync(required)) throw new Error(`Portable input is missing: ${required}`);

const built = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
  cwd: root,
  env: { ...process.env, OMNIA_AGENT_BUILTIN_PROFILE: profile },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 180_000
});
if (built.status !== 0) throw new Error(`Portable profile build failed:\n${built.stderr || built.stdout}`);

process.env.OMNIA_AGENT_BUILTIN_PROFILE = profile;
const inventoryModule = await import('../src/main/features/builtin-release-inventory.ts');
const inventory = inventoryModule.ACTIVE_BUILTIN_FEATURE_RELEASE_INVENTORY;
const projection = inventoryModule.BUILTIN_FEATURE_RELEASE_PROJECTION;
inventoryModule.assertBuiltinFeatureReleaseProjection(projection, inventory);
const verifiedBuiltins = inventoryModule.validateBuiltinFeatureReleaseInventory(root, inventory);
const verifiedIdentity = verifiedBuiltins.map(({ entry }) => [entry.featureId, entry.version]);
if (JSON.stringify(verifiedIdentity) !== JSON.stringify(expectedFeatures)) {
  throw new Error(`The portable Feature inventory is not the requested exact set: ${JSON.stringify(expectedFeatures)}.`);
}

async function digest(filename) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return `sha256:${hash.digest('hex')}`;
}

async function remove(targetPath) {
  await rm(targetPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

await remove(staging);
await mkdir(appRoot, { recursive: true });
try {
  await cp(path.join(root, 'node_modules', 'electron', 'dist'), releaseRoot, { recursive: true });
  await rename(path.join(releaseRoot, 'electron.exe'), path.join(releaseRoot, 'Omnia Agent v5.exe'));
  await mkdir(path.join(appRoot, 'dist'), { recursive: true });
  for (const member of ['main', 'renderer', 'tools']) {
    await cp(path.join(root, 'dist', member), path.join(appRoot, 'dist', member), { recursive: true });
  }
  await cp(path.join(root, 'scripts', 'hot-shell-bootstrap.cjs'), path.join(appRoot, 'hot-shell-bootstrap.cjs'));
  await writeFile(path.join(appRoot, 'package.json'), `${JSON.stringify({
    name: companyCurrent ? 'omnia-agent-v5-company-loopback-portable' : 'omnia-agent-v5-create-associate-next-portable',
    version: shellVersion,
    private: true,
    main: 'hot-shell-bootstrap.cjs'
  }, null, 2)}\n`);

  await mkdir(path.join(appRoot, 'builtins'), { recursive: true });
  for (const builtin of verifiedBuiltins) {
    const builtinTarget = path.join(appRoot, 'builtins', builtin.entry.filename);
    await cp(builtin.absoluteFilename, builtinTarget);
    inventoryModule.verifyBuiltinFeatureReleaseFile(builtinTarget, builtin.entry);
  }

  const connectorRoot = path.join(appRoot, 'connector-next');
  await mkdir(connectorRoot, { recursive: true });
  for (const member of ['server.cjs', 'agent.cjs']) {
    await cp(path.join(root, 'dist', 'connector-next', member), path.join(connectorRoot, member));
  }
  await mkdir(path.join(connectorRoot, 'node_modules'), { recursive: true });
  await cp(path.join(root, 'node_modules', 'playwright-core'), path.join(connectorRoot, 'node_modules', 'playwright-core'), { recursive: true });

  await mkdir(path.join(staging, 'runtime', 'python'), { recursive: true });
  await cp(pythonSource, path.join(staging, 'runtime', 'python', pythonDirectory), { recursive: true });
  await mkdir(path.join(staging, 'data'), { recursive: true });

  const criticalFiles = [
    'Omnia Agent v5.exe',
    'resources/app/hot-shell-bootstrap.cjs',
    'resources/app/dist/main/main.cjs',
    'resources/app/dist/main/preload.cjs',
    'resources/app/dist/main/feature-preload.cjs',
    'resources/app/dist/main/feature-worker-host.cjs',
    'resources/app/connector-next/server.cjs',
    'resources/app/connector-next/agent.cjs',
    'resources/app/connector-next/node_modules/playwright-core/package.json',
    ...verifiedBuiltins.map(({ entry }) => `resources/app/builtins/${entry.filename}`),
    'resources/app/dist/renderer/app.js',
    'resources/app/dist/renderer/index.html',
    'resources/app/dist/renderer/feature-window.js',
    'resources/app/dist/renderer/feature-window.html'
  ];
  const files = {};
  for (const relative of criticalFiles) files[relative] = await digest(path.join(releaseRoot, ...relative.split('/')));
  await writeFile(path.join(releaseRoot, 'release-manifest.json'), `${JSON.stringify({
    schemaVersion: 'omnia.shell-release/v1',
    product: 'omnia-agent-v5-shell',
    edition: companyCurrent ? 'company-connector-next-loopback-portable' : 'create-associate-connector-next-loopback-portable',
    version: shellVersion,
    platform: 'win32-x64',
    signed: false,
    signingStatus: 'organization_code_signing_required_before_external_distribution',
    connectorTransport: {
      productId: 'com.deloitte.omnia-agent.connector-next',
      protocolId: 'omnia.connector-next/v3',
      topology: 'embedded-exe-host',
      remoteServerRequired: false
    },
    featureReleaseInventory: {
      schemaVersion: inventory.schemaVersion,
      baselinePolicy: inventory.baselinePolicy,
      builtinBaseline: projection.releaseManifest,
      postInstallFeatures: projection.postInstallFeatures
    },
    files
  }, null, 2)}\n`);

  await writeFile(path.join(staging, 'portable-root.json'), `${JSON.stringify({
    schemaVersion: 'omnia.portable-product-root/v1',
    product: 'omnia-agent-v5',
    formatVersion: 1,
    candidateVersion: shellVersion,
    builtinProfile: profile,
    connectorTransport: 'connector-next-loopback',
    launchMode: 'single-exe-host',
    createdAt: new Date().toISOString()
  }, null, 2)}\n`);
  await writeFile(path.join(staging, 'current'), `${JSON.stringify({
    schemaVersion: 'omnia.active-release/v1',
    version: shellVersion,
    relativePath: shellVersion,
    activatedAt: new Date().toISOString()
  }, null, 2)}\n`);

  await writeFile(path.join(staging, 'Start Omnia Agent v5.ps1'), [
    "$ErrorActionPreference = 'Stop'",
    '$root = [System.IO.Path]::GetFullPath($PSScriptRoot)',
    `$exe = Join-Path $root '${shellVersion}\\Omnia Agent v5.exe'`,
    "if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Omnia Agent executable is missing.' }",
    "Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) | Out-Null",
    ''
  ].join('\r\n'), 'utf8');
  await writeFile(path.join(staging, 'Start Omnia Agent v5.cmd'), [
    '@echo off',
    'setlocal',
    `start "" /D "%~dp0${shellVersion}" "%~dp0${shellVersion}\\Omnia Agent v5.exe"`,
    'if errorlevel 1 (',
    '  echo Omnia Agent v5 could not be started.',
    '  pause',
    ')',
    'endlocal',
    ''
  ].join('\r\n'), 'utf8');
  const featureSummary = companyCurrent
    ? '内置 Feature：新建与关联 0.2.150、底稿编制 0.1.83、录制 0.4.21、删除元素 0.3.32。'
    : '内置 Feature：新建与关联 0.2.123。';
  const instructions = [
    'Omnia Agent v5 + Connector Next 本地便携版',
    '',
    '1. 将整个 ZIP 解压到公司电脑本地磁盘；不要直接在 ZIP 内运行。',
    `2. 直接双击“${shellVersion}\\Omnia Agent v5.exe”；根目录“Start Omnia Agent v5.cmd”只是该 EXE 的快捷入口。`,
    '3. Shell EXE 主进程会自动持有并启动包内 Connector Next Server 与 Agent，然后完成本地绑定；CMD 不再运行监听器或外置 Node 脚本。',
    '4. 本包不连接远程 Connector 服务器，不使用旧 Connector，也不需要配对码。',
    `5. ${featureSummary}`,
    '6. 不要移动包内单个文件；关闭 Shell 时，由同一 EXE 收敛其本次启动的 Connector Next 子进程。',
    '',
    '边界：Connector Next 只承载通用 Pack 会话和签名 Operation；Feature 业务逻辑仍只存在于各自签名 Feature 包。',
    '日志：connector-next-data-v3\\logs；业务数据：data。',
    ''
  ].join('\r\n');
  await writeFile(path.join(staging, '使用说明.txt'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(instructions, 'utf8')
  ]));

  await rename(staging, target);
  const zipped = spawnSync(path.join(pythonSource, 'python.exe'), [
    '-I', '-S', '-E', path.join(root, 'scripts', 'create-portable-zip.py'), target, zipTarget
  ], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 300_000 });
  if (zipped.status !== 0 || !existsSync(zipTarget)) throw new Error(`Portable ZIP creation failed: ${zipped.stderr || zipped.stdout}`);
} catch (error) {
  await remove(staging);
  await remove(target);
  await rm(zipTarget, { force: true });
  throw error;
}

console.log(target);
console.log(zipTarget);
