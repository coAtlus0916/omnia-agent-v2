import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The managed CPython runtime is provisioned only for the Windows portable release.');

const root = path.resolve(import.meta.dirname, '..');
const version = '3.13.14';
const distribution = `cpython-${version}-embed-amd64`;
const sourceUrl = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
const officialSha256 = '90b4e5b9898b72d744650524bff92377c367f44bd5fbd09e3148656c080ad907';
const runtimeRoot = path.join(root, '.codex-tmp', 'python-runtime');
const target = path.join(runtimeRoot, distribution);
const manifestPath = path.join(target, 'runtime-manifest.json');

async function alreadyProvisioned() {
  if (!existsSync(path.join(target, 'python.exe')) || !existsSync(manifestPath)) return false;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return manifest.schemaVersion === 'omnia.managed-python-runtime/v1'
    && manifest.version === version
    && manifest.architecture === 'win32-x64'
    && manifest.sourceSha256 === officialSha256;
}

if (await alreadyProvisioned()) {
  console.log(target);
  process.exit(0);
}

await mkdir(runtimeRoot, { recursive: true });
const runId = `${process.pid}-${Date.now()}`;
const archive = path.join(runtimeRoot, `.python-${version}-${runId}.zip`);
const staging = path.join(runtimeRoot, `.staging-${distribution}-${runId}`);
await rm(staging, { recursive: true, force: true });

try {
  const response = await fetch(sourceUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`CPython download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const observed = createHash('sha256').update(bytes).digest('hex');
  if (observed !== officialSha256) throw new Error('The downloaded CPython embeddable archive differs from the Python.org release record.');
  await writeFile(archive, bytes, { flag: 'wx' });
  await mkdir(staging, { recursive: false });
  const expanded = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "Expand-Archive -LiteralPath $env:OMNIA_PYTHON_ARCHIVE -DestinationPath $env:OMNIA_PYTHON_DESTINATION -Force"
  ], {
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, OMNIA_PYTHON_ARCHIVE: archive, OMNIA_PYTHON_DESTINATION: staging }
  });
  if (expanded.status !== 0) throw new Error(`CPython archive extraction failed: ${expanded.stderr || expanded.stdout}`);
  if (!existsSync(path.join(staging, 'python.exe')) || !existsSync(path.join(staging, 'python313.zip'))) {
    throw new Error('The CPython embeddable archive is missing its runtime entrypoints.');
  }
  await writeFile(path.join(staging, 'python313._pth'), 'python313.zip\n.\n', 'utf8');
  await writeFile(path.join(staging, 'runtime-manifest.json'), `${JSON.stringify({
    schemaVersion: 'omnia.managed-python-runtime/v1',
    product: 'omnia-agent-v5',
    implementation: 'CPython',
    version,
    architecture: 'win32-x64',
    distribution: 'embeddable',
    sourceUrl,
    sourceSha256: officialSha256,
    sitePackagesEnabled: false,
    runtimePipEnabled: false
  }, null, 2)}\n`, 'utf8');
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  console.log(target);
} finally {
  await rm(archive, { force: true });
  await rm(staging, { recursive: true, force: true });
}
