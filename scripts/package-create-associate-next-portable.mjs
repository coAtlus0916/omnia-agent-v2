import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The Create-and-Associate Connector Next portable is Windows-only.');

const root = path.resolve(import.meta.dirname, '..');
const profile = 'create-associate-only';
const shellVersion = String(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
const featureVersion = '0.2.123';
const artifactName = `Omnia-Agent-v5-${shellVersion}-Create-Associate-${featureVersion}-Connector-Next-Portable`;
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
  path.join(root, 'feature-packages', 'create-associate', 'candidates', `create-associate-${featureVersion}.ofp`),
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
if (verifiedBuiltins.length !== 1 || verifiedBuiltins[0].entry.featureId !== 'omnia.create-associate' || verifiedBuiltins[0].entry.version !== featureVersion) {
  throw new Error('The portable Feature inventory is not exactly Create-and-Associate 0.2.123.');
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
    name: 'omnia-agent-v5-create-associate-next-portable',
    version: shellVersion,
    private: true,
    main: 'hot-shell-bootstrap.cjs'
  }, null, 2)}\n`);

  await mkdir(path.join(appRoot, 'builtins'), { recursive: true });
  const builtin = verifiedBuiltins[0];
  const builtinTarget = path.join(appRoot, 'builtins', builtin.entry.filename);
  await cp(builtin.absoluteFilename, builtinTarget);
  inventoryModule.verifyBuiltinFeatureReleaseFile(builtinTarget, builtin.entry);

  const connectorRoot = path.join(staging, 'connector-next');
  await mkdir(connectorRoot, { recursive: true });
  for (const member of ['server.cjs', 'agent.cjs', 'portable-launcher.cjs']) {
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
    `resources/app/builtins/${builtin.entry.filename}`,
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
    edition: 'create-associate-connector-next-loopback-portable',
    version: shellVersion,
    platform: 'win32-x64',
    signed: false,
    signingStatus: 'organization_code_signing_required_before_external_distribution',
    connectorTransport: {
      productId: 'com.deloitte.omnia-agent.connector-next',
      protocolId: 'omnia.connector-next/v3',
      topology: 'embedded-loopback',
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
    "$launcher = Join-Path $root 'connector-next\\portable-launcher.cjs'",
    "if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Omnia Agent executable is missing.' }",
    "if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Connector Next portable launcher is missing.' }",
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    "Start-Process -FilePath $exe -ArgumentList @($launcher) -WorkingDirectory $root -WindowStyle Hidden | Out-Null",
    ''
  ].join('\r\n'), 'utf8');
  await writeFile(path.join(staging, 'Start Omnia Agent v5.cmd'), [
    '@echo off',
    'setlocal',
    'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Start Omnia Agent v5.ps1"',
    'if errorlevel 1 (',
    '  echo Omnia Agent v5 could not be started.',
    '  pause',
    ')',
    'endlocal',
    ''
  ].join('\r\n'), 'utf8');
  await writeFile(path.join(staging, '使用说明.txt'), [
    'Omnia Agent v5 — 新建与关联 + Connector Next 本地便携版',
    '',
    '1. 将整个目录解压到公司电脑的本地磁盘。',
    '2. 双击“Start Omnia Agent v5.cmd”。首次启动会在本目录生成受当前 Windows 用户保护的本地身份。',
    '3. Shell 会自动启动 Connector Next 本地控制面和 Agent，并通过 127.0.0.1 自动绑定。无需旧 Connector、配对码或远端 Connector 服务器。',
    '4. 本包只内置“新建与关联”0.2.123；不会安装录制、删除或底稿编制。',
    '5. 不要单独运行版本目录中的 Omnia Agent v5.exe，也不要移动单个文件。',
    '',
    '边界：Connector Next 只承载通用 Pack 连接和 Operation；新建与关联业务逻辑仍在签名 Feature 包中。',
    '日志：connector-next-data-v3\\logs；业务数据：data。',
    '本地模式不连接远端 Connector 控制服务器，因此更新本便携包需要替换为后续发布的新 ZIP。',
    ''
  ].join('\r\n'), 'utf8');

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
