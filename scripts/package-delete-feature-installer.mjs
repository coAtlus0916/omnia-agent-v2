import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The Windows Feature installer ZIP must be packaged on Windows.');

const root = path.resolve(import.meta.dirname, '..');
const featureVersion = '0.1.2';
const packageFilename = `delete-elements-${featureVersion}.ofp`;
const sourcePackage = path.join(root, 'feature-packages', 'delete-elements', 'candidates', packageFilename);
const templateRoot = path.join(root, 'scripts', 'installers', 'delete-elements');
const artifactsRoot = path.join(root, 'artifacts');
const bundleName = `delete-elements-feature-${featureVersion}-installer`;
const outputZip = path.join(artifactsRoot, `${bundleName}.zip`);
const runId = `${process.pid}-${Date.now()}`;
const stageRoot = path.join(artifactsRoot, `.staging-${bundleName}-${runId}`);
const bundleRoot = path.join(stageRoot, bundleName);
const stagedZip = path.join(stageRoot, `${bundleName}.zip`);

async function removeWithRetry(target, recursive = true) {
  await rm(target, { recursive, force: true, maxRetries: 8, retryDelay: 250 });
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

function assertSignedDeleteFeature(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new Error('The Feature package is not a JSON object.');
  if (envelope.schemaVersion !== 'omnia.official-package-envelope/v1') throw new Error('Unsupported Feature envelope.');
  if (envelope.product !== 'omnia-feature') throw new Error('The candidate is not a Feature package.');
  if (envelope.packageId !== 'omnia.delete-elements') throw new Error('The candidate is not the delete-elements Feature.');
  if (envelope.version !== featureVersion) throw new Error(`Expected delete-elements ${featureVersion}.`);
  if (envelope.publisher?.algorithm !== 'Ed25519' || typeof envelope.publisher?.keyId !== 'string') {
    throw new Error('The Feature package does not declare an Ed25519 publisher.');
  }
  if (typeof envelope.signature !== 'string' || envelope.signature.length < 40) {
    throw new Error('The Feature package is unsigned.');
  }
  if (!Array.isArray(envelope.files) || envelope.files.length === 0) throw new Error('The Feature package inventory is empty.');
}

function finished(stream) {
  return new Promise((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
    stream.resume();
  });
}

await removeWithRetry(stageRoot);
try {
  const envelope = JSON.parse(await readFile(sourcePackage, 'utf8'));
  assertSignedDeleteFeature(envelope);
  // Force an actual read before copying so a disappearing/locked input fails the build.
  await finished(createReadStream(sourcePackage));

  await mkdir(bundleRoot, { recursive: true });
  await cp(sourcePackage, path.join(bundleRoot, packageFilename));
  for (const templateName of ['InstallFeature.cmd', 'InstallFeature.ps1', 'README.txt']) {
    const template = await readFile(path.join(templateRoot, templateName), 'utf8');
    let rendered = template.replaceAll('__FEATURE_VERSION__', featureVersion);
    if (templateName.endsWith('.cmd')) rendered = rendered.replace(/\r?\n/gu, '\r\n');
    await writeFile(
      path.join(bundleRoot, templateName),
      templateName.endsWith('.ps1') ? `\uFEFF${rendered}` : rendered,
      'utf8'
    );
  }

  const archive = spawnSync('python', [
    path.join(root, 'scripts', 'create-portable-zip.py'),
    bundleRoot,
    stagedZip
  ], { encoding: 'utf8', windowsHide: true });
  if (archive.status !== 0) throw new Error(`Feature installer ZIP creation failed: ${archive.stderr || archive.stdout}`);
  await mkdir(artifactsRoot, { recursive: true });
  await publishFile(stagedZip, outputZip);
  console.log(`Packaged ${path.relative(root, outputZip)} with the signed ${packageFilename}.`);
} finally {
  await removeWithRetry(stageRoot);
}
