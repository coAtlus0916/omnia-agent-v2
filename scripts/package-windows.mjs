import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Windows portable packaging must run on Windows.');

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version);
const releasesRoot = path.join(root, 'releases');
const runId = `${process.pid}-${Date.now()}`;
const releaseTarget = path.join(releasesRoot, version);
const release = path.join(releasesRoot, `.staging-${version}-${runId}`);
const appRoot = path.join(release, 'resources', 'app');
const artifactsRoot = path.join(root, 'artifacts');
const portableName = `omnia-agent-v5-portable-${version}`;
const portableTarget = path.join(artifactsRoot, portableName);
const zip = path.join(artifactsRoot, `${portableName}.zip`);
for (const target of [releaseTarget, portableTarget, zip]) if (existsSync(target)) {
  throw new Error(`Immutable Shell artifact already exists: ${target}`);
}

async function removeWithRetry(target, recursive = true) {
  await rm(target, { recursive, force: true, maxRetries: 8, retryDelay: 250 });
}

async function publishDirectory(stage, target) {
  const backup = `${target}.previous-${runId}`;
  let movedPrevious = false;
  try {
    await removeWithRetry(backup);
    try {
      await rename(target, backup);
      movedPrevious = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(stage, target);
    if (movedPrevious) await removeWithRetry(backup);
  } catch (error) {
    if (movedPrevious) {
      try { await rename(backup, target); } catch { /* preserve both paths for manual recovery */ }
    }
    throw error;
  }
}

async function publishFile(stage, target) {
  const backup = `${target}.previous-${runId}`;
  let movedPrevious = false;
  try {
    await removeWithRetry(backup, false);
    try {
      await rename(target, backup);
      movedPrevious = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(stage, target);
    if (movedPrevious) await removeWithRetry(backup, false);
  } catch (error) {
    if (movedPrevious) {
      try { await rename(backup, target); } catch { /* preserve both paths for manual recovery */ }
    }
    throw error;
  }
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

await removeWithRetry(release);
await mkdir(appRoot, { recursive: true });
await cp(path.join(root, 'node_modules', 'electron', 'dist'), release, { recursive: true });
await rename(path.join(release, 'electron.exe'), path.join(release, 'Omnia Agent v5.exe'));
await mkdir(path.join(appRoot, 'dist'), { recursive: true });
await cp(path.join(root, 'dist', 'main'), path.join(appRoot, 'dist', 'main'), { recursive: true });
await cp(path.join(root, 'dist', 'renderer'), path.join(appRoot, 'dist', 'renderer'), { recursive: true });
await cp(path.join(root, 'dist', 'tools'), path.join(appRoot, 'dist', 'tools'), { recursive: true });
await mkdir(path.join(appRoot, 'builtins'), { recursive: true });
await cp(
  path.join(root, 'feature-packages', 'recording', 'candidates', 'recording-0.1.1.ofp'),
  path.join(appRoot, 'builtins', 'recording-0.1.1.ofp')
);
await mkdir(path.join(appRoot, 'node_modules'), { recursive: true });
await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({
  name: 'omnia-agent-v5-shell-release',
  version,
  private: true,
  main: 'dist/main/main.cjs'
}, null, 2));
const releaseFiles = [
  'Omnia Agent v5.exe',
  'resources/app/dist/main/main.cjs',
  'resources/app/dist/main/preload.cjs',
  'resources/app/dist/main/feature-worker-host.cjs',
  'resources/app/dist/tools/feature-installer.cjs',
  'resources/app/builtins/recording-0.1.1.ofp',
  'resources/app/dist/renderer/app.js',
  'resources/app/dist/renderer/index.html',
  'resources/app/dist/renderer/styles.css'
];
const digests = {};
for (const relative of releaseFiles) digests[relative] = await digest(path.join(release, relative));
await writeFile(path.join(release, 'release-manifest.json'), JSON.stringify({
  schemaVersion: 'omnia.shell-release/v1',
  product: 'omnia-agent-v5-shell',
  version,
  platform: 'win32-x64',
  signed: false,
  signingStatus: 'organization_code_signing_required_before_distribution',
  files: digests
}, null, 2));
const electronPackage = JSON.parse(await readFile(
  path.join(root, 'node_modules', 'electron', 'package.json'),
  'utf8'
));
const reactPackage = JSON.parse(await readFile(
  path.join(root, 'node_modules', 'react', 'package.json'),
  'utf8'
));
const reactDomPackage = JSON.parse(await readFile(
  path.join(root, 'node_modules', 'react-dom', 'package.json'),
  'utf8'
));
await writeFile(path.join(release, 'sbom.json'), JSON.stringify({
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: { component: { type: 'application', name: 'omnia-agent-v5-shell', version } },
  components: [
    { type: 'framework', name: 'electron', version: String(electronPackage.version) },
    { type: 'library', name: 'react', version: String(reactPackage.version) },
    { type: 'library', name: 'react-dom', version: String(reactDomPackage.version) }
  ]
}, null, 2));
await publishDirectory(release, releaseTarget);
const artifactsStageRoot = path.join(artifactsRoot, `.staging-${runId}`);
const portableRoot = path.join(artifactsStageRoot, portableName);
const portableRelease = path.join(portableRoot, 'releases', version);
await removeWithRetry(artifactsStageRoot);
await mkdir(path.dirname(portableRelease), { recursive: true });
await cp(releaseTarget, portableRelease, { recursive: true });
await mkdir(path.join(portableRoot, 'data'), { recursive: true });
await writeFile(path.join(portableRoot, 'portable-root.json'), JSON.stringify({
  schemaVersion: 'omnia.portable-product-root/v1',
  product: 'omnia-agent-v5',
  formatVersion: 1,
  candidateVersion: version,
  createdAt: new Date().toISOString()
}, null, 2));
await writeFile(path.join(portableRoot, 'current'), JSON.stringify({
  schemaVersion: 'omnia.active-release/v1',
  version,
  relativePath: `releases/${version}`,
  activatedAt: new Date().toISOString()
}, null, 2));
const stagedZip = path.join(artifactsStageRoot, `${portableName}.zip`);
const archive = spawnSync('python', [
  path.join(root, 'scripts', 'create-portable-zip.py'),
  portableRoot,
  stagedZip
], {
  encoding: 'utf8',
  windowsHide: true
});
if (archive.status !== 0) throw new Error(`Portable ZIP creation failed: ${archive.stderr || archive.stdout}`);
await publishDirectory(portableRoot, portableTarget);
await publishFile(stagedZip, zip);
await removeWithRetry(artifactsStageRoot);

console.log(`Packaged candidate release at releases/${version}/ and complete portable artifact at artifacts/${portableName}.zip`);
