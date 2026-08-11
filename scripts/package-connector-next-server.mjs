import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, sign } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const version = process.env.OMNIA_CONNECTOR_NEXT_SERVER_VERSION;
const signingKeyId = process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_KEY_ID;
const privateKeyFile = process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_PRIVATE_KEY_FILE;
if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Connector Next server release requires Windows Node.js 24+');
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('OMNIA_CONNECTOR_NEXT_SERVER_VERSION is required');
if (!signingKeyId || !privateKeyFile) throw new Error('publisher key id and private key file are required');

const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sources = [
  ['server.cjs', path.join(root, 'dist', 'connector-next', 'server.cjs')],
  ['shell-control.cjs', path.join(root, 'dist', 'connector-next', 'shell-control.cjs')],
  ['runtime/node.exe', process.execPath]
];
const files = sources.map(([relative, filename]) => {
  const bytes = fs.readFileSync(filename);
  return { path: relative, size: bytes.length, digest: digest(bytes) };
});
const unsigned = {
  schemaVersion: 'omnia.connector-next-server-release/v1',
  productId: 'com.deloitte.omnia-agent.connector-next-server',
  protocolId: 'omnia.connector-next/v3',
  version,
  signingKeyId,
  createdAt: new Date().toISOString(),
  files
};
const privateKey = fs.readFileSync(privateKeyFile, 'utf8');
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
const manifest = { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') };
const target = path.join(root, 'connector-next', 'server-candidates', version);
if (fs.existsSync(target)) throw new Error(`immutable server candidate already exists: ${target}`);
for (const [relative, filename] of sources) {
  const destination = path.join(target, ...relative.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(filename, destination, fs.constants.COPYFILE_EXCL);
}
fs.writeFileSync(path.join(target, 'server-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(target, 'publisher-public-key.pem'), publicKey, { flag: 'wx' });
fs.writeFileSync(path.join(target, 'StartConnectorNextServer.ps1'), `param(
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [Parameter(Mandatory=$true)][string]$ControlToken,
  [string]$HostName = '127.0.0.1',
  [int]$Port = 43173,
  [string]$TlsKeyFile = '',
  [string]$TlsCertFile = ''
)
$ErrorActionPreference = 'Stop'
$env:OMNIA_CONNECTOR_NEXT_SERVER_DATA_ROOT = $DataRoot
$env:OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN = $ControlToken
$env:OMNIA_CONNECTOR_NEXT_PUBLISHER_KEY_ID = '${signingKeyId.replaceAll("'", "''")}'
$env:OMNIA_CONNECTOR_NEXT_PUBLISHER_PUBLIC_KEY = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'publisher-public-key.pem'))
$env:OMNIA_CONNECTOR_NEXT_SERVER_HOST = $HostName
$env:OMNIA_CONNECTOR_NEXT_SERVER_PORT = [string]$Port
$env:OMNIA_CONNECTOR_NEXT_SERVER_TLS_KEY_FILE = $TlsKeyFile
$env:OMNIA_CONNECTOR_NEXT_SERVER_TLS_CERT_FILE = $TlsCertFile
& (Join-Path $PSScriptRoot 'runtime\\node.exe') (Join-Path $PSScriptRoot 'server.cjs')
exit $LASTEXITCODE
`, { flag: 'wx' });
fs.writeFileSync(path.join(target, 'RunConnectorNextControl.ps1'), `param(
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [Parameter(Mandatory=$true)][string]$ControlToken,
  [Parameter(Mandatory=$true)][string]$Command,
  [string]$Argument = ''
)
$ErrorActionPreference = 'Stop'
$env:OMNIA_CONNECTOR_NEXT_SERVER_URL = $ServerUrl
$env:OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN = $ControlToken
$arguments = @((Join-Path $PSScriptRoot 'shell-control.cjs'), $Command)
if ($Argument) { $arguments += $Argument }
& (Join-Path $PSScriptRoot 'runtime\\node.exe') @arguments
exit $LASTEXITCODE
`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ candidateRoot: target, version, manifestDigest: digest(Buffer.from(canonical(manifest))), files })}\n`);
