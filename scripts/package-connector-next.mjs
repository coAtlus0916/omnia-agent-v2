import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const version = process.env.OMNIA_CONNECTOR_NEXT_PACKAGE_VERSION;
const sequence = Number(process.env.OMNIA_CONNECTOR_NEXT_PACKAGE_SEQUENCE);
const signingKeyId = process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_KEY_ID;
const privateKeyFile = process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_PRIVATE_KEY_FILE;
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('OMNIA_CONNECTOR_NEXT_PACKAGE_VERSION is required');
if (!Number.isInteger(sequence) || sequence < 1) throw new Error('OMNIA_CONNECTOR_NEXT_PACKAGE_SEQUENCE is required');
if (!signingKeyId || !privateKeyFile) throw new Error('publisher key id and private key file are required');

const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const agentBytes = fs.readFileSync(path.join(root, 'dist', 'connector-next', 'agent.cjs'));
const updaterBytes = fs.readFileSync(path.join(root, 'dist', 'connector-next', 'updater.cjs'));
const runtimeBytes = fs.readFileSync(process.execPath);
const packageFile = (relativePath, bytes) => ({
  path: relativePath,
  size: bytes.length,
  digest: digest(bytes),
  contentBase64: bytes.toString('base64')
});
const dependencyRoot = path.join(root, 'node_modules', 'playwright-core');
if (!fs.statSync(dependencyRoot).isDirectory()) throw new Error('playwright-core runtime dependency is unavailable');
const dependencyFiles = [];
const collectDependencyFiles = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectDependencyFiles(filename);
      continue;
    }
    if (!entry.isFile()) throw new Error(`playwright-core contains a non-regular package member: ${filename}`);
    const relative = path.relative(dependencyRoot, filename).split(path.sep).join('/');
    dependencyFiles.push(packageFile(`node_modules/playwright-core/${relative}`, fs.readFileSync(filename)));
  }
};
collectDependencyFiles(dependencyRoot);
const packageValue = {
  schemaVersion: 'omnia.connector-next-package/v1',
  productId: 'com.deloitte.omnia-agent.connector-next',
  protocolId: 'omnia.connector-next/v3',
  version,
  sequence,
  entrypoint: 'agent.cjs',
  updaterEntrypoint: 'updater.cjs',
  runtimeEntrypoint: 'runtime/node.exe',
  files: [
    packageFile('agent.cjs', agentBytes),
    packageFile('updater.cjs', updaterBytes),
    packageFile('runtime/node.exe', runtimeBytes),
    ...dependencyFiles
  ]
};
const packageBytes = gzipSync(Buffer.from(canonical(packageValue)), { level: 9 });
const unsigned = {
  schemaVersion: 'omnia.connector-next-update-manifest/v1',
  productId: packageValue.productId,
  protocolId: packageValue.protocolId,
  artifactId: `omnia.connector-next.artifact.${version}.${sequence}`,
  version,
  sequence,
  minimumUpdaterVersion: '0.1.0',
  packageDigest: digest(packageBytes),
  packageSize: packageBytes.length,
  signingKeyId,
  createdAt: new Date().toISOString()
};
const manifest = { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), fs.readFileSync(privateKeyFile, 'utf8')).toString('base64') };
const target = path.join(root, 'connector-next', 'candidates', `${version}-${sequence}`);
if (fs.existsSync(target)) throw new Error(`immutable candidate already exists: ${target}`);
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'connector-next-package.ocn3'), packageBytes, { flag: 'wx' });
fs.writeFileSync(path.join(target, 'connector-next-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(target, 'publisher-public-key.pem'), createPublicKey(fs.readFileSync(privateKeyFile, 'utf8')).export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
fs.copyFileSync(path.join(root, 'dist', 'connector-next', 'bootstrap.cjs'), path.join(target, 'connector-next-bootstrap.cjs'), fs.constants.COPYFILE_EXCL);
fs.copyFileSync(path.join(root, 'dist', 'connector-next', 'installer.cjs'), path.join(target, 'connector-next-installer.cjs'), fs.constants.COPYFILE_EXCL);
fs.mkdirSync(path.join(target, 'runtime'), { recursive: false });
fs.copyFileSync(process.execPath, path.join(target, 'runtime', 'node.exe'), fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(target, 'InstallConnectorNext.ps1'), `param(
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [Parameter(Mandatory=$true)][string]$EnrollmentCode,
  [Parameter(Mandatory=$true)][string]$TargetJson,
  [switch]$NoStartup,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$arguments = @(
  (Join-Path $PSScriptRoot 'connector-next-installer.cjs'),
  '--manifest', (Join-Path $PSScriptRoot 'connector-next-manifest.json'),
  '--package', (Join-Path $PSScriptRoot 'connector-next-package.ocn3'),
  '--publisher-public-key', (Join-Path $PSScriptRoot 'publisher-public-key.pem'),
  '--bootstrap', (Join-Path $PSScriptRoot 'connector-next-bootstrap.cjs'),
  '--server-url', $ServerUrl,
  '--enrollment-code', $EnrollmentCode,
  '--target-json', $TargetJson,
  '--register-startup', $(if ($NoStartup) { 'false' } else { 'true' }),
  '--start', $(if ($NoStart) { 'false' } else { 'true' })
)
& (Join-Path $PSScriptRoot 'runtime\\node.exe') @arguments
if ($LASTEXITCODE -ne 0) { throw "Connector Next installer exited with code $LASTEXITCODE" }
`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ candidateRoot: target, artifactId: manifest.artifactId, version, sequence, packageDigest: manifest.packageDigest })}\n`);
