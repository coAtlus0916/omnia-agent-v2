import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The portable artifact is built only for Windows.');

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version);
const runtimeDirectory = 'cpython-3.13.14-embed-amd64';
const releasesRoot = path.join(root, 'releases');
const artifactsRoot = path.join(root, 'artifacts');
const artifactName = `Omnia-Agent-v5-${version}-Portable`;
const artifactDirectory = path.join(artifactsRoot, artifactName);
const artifactZip = path.join(artifactsRoot, `${artifactName}.zip`);
const runId = `${process.pid}-${Date.now()}`;
const staging = path.join(artifactsRoot, `.staging-${artifactName}-${runId}`);
const managedPython = path.join(releasesRoot, 'runtime', 'python', runtimeDirectory, 'python.exe');

for (const required of [
  path.join(releasesRoot, version, 'Omnia Agent v5.exe'),
  path.join(releasesRoot, 'runtime', 'python', runtimeDirectory, 'runtime-manifest.json'),
  path.join(releasesRoot, 'current'),
  path.join(releasesRoot, 'portable-root.json'),
  path.join(releasesRoot, 'Start Omnia Agent v5.cmd'),
  path.join(releasesRoot, 'Start Omnia Agent v5.ps1'),
  managedPython
]) {
  if (!existsSync(required)) throw new Error(`Portable artifact input is missing: ${required}`);
}
if (existsSync(artifactDirectory) || existsSync(artifactZip)) {
  throw new Error(`Immutable portable artifact already exists for ${version}.`);
}

await rm(staging, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
await mkdir(staging, { recursive: true });
try {
  await cp(path.join(releasesRoot, version), path.join(staging, version), { recursive: true });
  await cp(path.join(releasesRoot, 'runtime'), path.join(staging, 'runtime'), { recursive: true });
  await mkdir(path.join(staging, 'data'), { recursive: true });
  for (const entry of ['current', 'portable-root.json', 'Start Omnia Agent v5.cmd', 'Start Omnia Agent v5.ps1']) {
    await cp(path.join(releasesRoot, entry), path.join(staging, entry));
  }
  await writeFile(path.join(staging, '使用启动器.txt'), [
    'Omnia Agent v5 portable',
    '',
    '双击 “Start Omnia Agent v5.cmd” 启动。',
    '不要直接运行版本目录内的 Electron 可执行文件。',
    'Python 3.13.14 已内置在 runtime/python，运行时不会调用系统 Python、pip 或网络安装。',
    ''
  ].join('\r\n'), 'utf8');
  await rename(staging, artifactDirectory);
  const zipped = spawnSync(managedPython, [
    '-I', '-S', '-E', path.join(root, 'scripts', 'create-portable-zip.py'), artifactDirectory, artifactZip
  ], { windowsHide: true, encoding: 'utf8' });
  if (zipped.status !== 0 || !existsSync(artifactZip)) {
    throw new Error(`Portable ZIP creation failed: ${zipped.stderr || zipped.stdout}`);
  }
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  await rm(artifactDirectory, { recursive: true, force: true });
  await rm(artifactZip, { force: true });
  throw error;
}

console.log(artifactDirectory);
console.log(artifactZip);
