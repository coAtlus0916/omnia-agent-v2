import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REMOTE_CONNECTOR_RELEASE = Object.freeze({
  product: 'omnia-agent-v5-remote-connector',
  platform: 'win32-x64',
  channel: 'stable',
  version: '0.3.35',
  sequence: 38,
  supervisorVersion: '0.1.6',
  keyId: 'v5-remote-connector-release-2026-01'
});

const pinnedPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATbYvnzzsXe+iB16L64HedlrqoPCcVWZ4VC9P/GGJeSE=
-----END PUBLIC KEY-----`;
const packageName = `Omnia-Agent-v5-Remote-Connector-v${REMOTE_CONNECTOR_RELEASE.version}-Portable`;
const archiveName = `${packageName}.zip`;
const candidateManifestName = 'candidate-update-manifest.json';
const journalSchema = 'omnia.v5.remote-connector-promotion-journal/v1';
const phaseOrder = Object.freeze({
  prepared: 0,
  release_published: 1,
  public_archive_published: 2,
  stable_published: 3,
  complete: 4
});

/**
 * Promote the one frozen 0.3.35 candidate into the local release tree.
 * This function never builds, signs, downloads, uploads, installs, or starts code.
 * Re-running it resumes from its integrity-checked journal.
 */
export function promoteRemoteConnectorCandidate(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot || path.resolve(import.meta.dirname, '..'));
  const publicKeyPem = options.publicKeyPem || pinnedPublicKey;
  const failAt = String(options.failAt || '');
  const paths = releasePaths(workspaceRoot);
  const candidate = inspectCandidate(paths, publicKeyPem);

  fs.mkdirSync(paths.journalRoot, { recursive: true });
  let journal = fs.existsSync(paths.journalPath)
    ? readJournal(paths.journalPath)
    : createJournal(paths, candidate);
  assertJournalMatchesCandidate(journal, paths, candidate);
  if (fs.existsSync(paths.releaseTarget)) validateReleaseTarget(paths.releaseTarget, candidate, publicKeyPem);
  if (fs.existsSync(paths.publicReleaseTarget)) validatePublicReleaseTarget(paths.publicReleaseTarget, candidate);
  if (phaseOrder[journal.phase] >= phaseOrder.stable_published
    && !fileEqualsBuffer(paths.stableManifestPath, candidate.manifestBytes)) {
    throw new Error('The stable pointer no longer matches the journaled promoted candidate.');
  }

  if (journal.phase === 'complete') {
    validatePublishedRelease(paths, candidate, publicKeyPem);
    assertCandidateUnchanged(paths, candidate);
    return promotionResult(paths, candidate, journal, true);
  }

  if (phaseOrder[journal.phase] < phaseOrder.release_published) {
    assertCandidateUnchanged(paths, candidate);
    if (fs.existsSync(paths.releaseTarget)) {
      validateReleaseTarget(paths.releaseTarget, candidate, publicKeyPem);
    } else {
      prepareReleaseStage(paths, candidate, publicKeyPem);
      injectFailure(failAt, 'after_release_stage');
      fs.renameSync(paths.releaseStage, paths.releaseTarget);
      fsyncDirectoryBestEffort(path.dirname(paths.releaseTarget));
      injectFailure(failAt, 'after_release_publish_before_journal');
      validateReleaseTarget(paths.releaseTarget, candidate, publicKeyPem);
    }
    journal = advanceJournal(paths.journalPath, journal, 'release_published');
    injectFailure(failAt, 'after_release_published');
  } else {
    validateReleaseTarget(paths.releaseTarget, candidate, publicKeyPem);
  }

  if (phaseOrder[journal.phase] < phaseOrder.public_archive_published) {
    assertCandidateUnchanged(paths, candidate);
    if (fs.existsSync(paths.publicReleaseTarget)) {
      validatePublicReleaseTarget(paths.publicReleaseTarget, candidate);
    } else {
      preparePublicReleaseStage(paths, candidate);
      injectFailure(failAt, 'after_public_stage');
      fs.renameSync(paths.publicReleaseStage, paths.publicReleaseTarget);
      fsyncDirectoryBestEffort(path.dirname(paths.publicReleaseTarget));
      injectFailure(failAt, 'after_public_publish_before_journal');
      validatePublicReleaseTarget(paths.publicReleaseTarget, candidate);
    }
    journal = advanceJournal(paths.journalPath, journal, 'public_archive_published');
    injectFailure(failAt, 'after_public_archive_published');
  } else {
    validatePublicReleaseTarget(paths.publicReleaseTarget, candidate);
  }

  if (phaseOrder[journal.phase] < phaseOrder.stable_published) {
    assertCandidateUnchanged(paths, candidate);
    if (!fileEqualsBuffer(paths.stableManifestPath, candidate.manifestBytes)) {
      assertStableStillMatchesPrevious(paths.stableManifestPath, journal.previousStable);
      atomicWriteFile(paths.stableManifestPath, candidate.manifestBytes);
      injectFailure(failAt, 'after_stable_replace_before_journal');
    }
    journal = advanceJournal(paths.journalPath, journal, 'stable_published');
    injectFailure(failAt, 'after_stable_published');
  } else if (!fileEqualsBuffer(paths.stableManifestPath, candidate.manifestBytes)) {
    throw new Error('The stable pointer no longer matches the journaled promoted candidate.');
  }

  validatePublishedRelease(paths, candidate, publicKeyPem);
  assertCandidateUnchanged(paths, candidate);
  journal = advanceJournal(paths.journalPath, journal, 'complete');
  injectFailure(failAt, 'after_complete');
  return promotionResult(paths, candidate, journal, false);
}

function releasePaths(workspaceRoot) {
  const connectorRoot = path.join(workspaceRoot, 'remote-connector');
  const candidatesRoot = path.join(connectorRoot, 'candidates');
  const candidateRoot = path.join(candidatesRoot, REMOTE_CONNECTOR_RELEASE.version);
  const releasesRoot = path.join(connectorRoot, 'releases');
  const publicRoot = path.join(connectorRoot, 'public');
  const publicReleasesRoot = path.join(publicRoot, 'releases');
  const journalRoot = path.join(connectorRoot, 'promotion-journals');
  const promotionId = `${REMOTE_CONNECTOR_RELEASE.version}-${REMOTE_CONNECTOR_RELEASE.sequence}`;
  const result = {
    workspaceRoot,
    connectorRoot,
    candidateRoot,
    candidateArchivePath: path.join(candidateRoot, archiveName),
    candidateManifestPath: path.join(candidateRoot, candidateManifestName),
    candidateSbomPath: path.join(candidateRoot, 'sbom.json'),
    candidatePortableRoot: path.join(candidateRoot, packageName),
    releaseTarget: path.join(releasesRoot, REMOTE_CONNECTOR_RELEASE.version),
    releaseStage: path.join(releasesRoot, `.promotion-${promotionId}`),
    publicReleaseTarget: path.join(publicReleasesRoot, REMOTE_CONNECTOR_RELEASE.version),
    publicReleaseStage: path.join(publicReleasesRoot, `.promotion-${promotionId}`),
    stableManifestPath: path.join(publicRoot, 'stable.json'),
    journalRoot,
    journalPath: path.join(journalRoot, `remote-connector-${promotionId}.json`)
  };
  for (const [target, parent] of [
    [result.candidateRoot, candidatesRoot],
    [result.releaseTarget, releasesRoot],
    [result.releaseStage, releasesRoot],
    [result.publicReleaseTarget, publicReleasesRoot],
    [result.publicReleaseStage, publicReleasesRoot],
    [result.journalPath, journalRoot]
  ]) assertDirectChild(target, parent);
  return result;
}

function inspectCandidate(paths, publicKeyPem) {
  if (!fs.existsSync(paths.candidateRoot) || !fs.statSync(paths.candidateRoot).isDirectory()) {
    throw new Error(`Frozen Remote Connector candidate is unavailable: ${paths.candidateRoot}`);
  }
  for (const required of [
    paths.candidateArchivePath,
    paths.candidateManifestPath,
    paths.candidateSbomPath,
    paths.candidatePortableRoot
  ]) {
    if (!fs.existsSync(required)) throw new Error(`Frozen candidate input is unavailable: ${required}`);
  }
  const topLevel = fs.readdirSync(paths.candidateRoot).sort();
  const expectedTopLevel = [archiveName, candidateManifestName, packageName, 'sbom.json'].sort();
  if (canonicalJson(topLevel) !== canonicalJson(expectedTopLevel)) {
    throw new Error('Frozen candidate contains an unexpected top-level entry.');
  }

  const manifestBytes = fs.readFileSync(paths.candidateManifestPath);
  const manifest = parseJsonBytes(manifestBytes, 'candidate update manifest');
  validateUpdateManifest(manifest, publicKeyPem);
  const archiveStat = fs.statSync(paths.candidateArchivePath);
  const archiveSha256 = sha256File(paths.candidateArchivePath);
  if (archiveStat.size !== manifest.size || archiveSha256 !== manifest.sha256) {
    throw new Error('Frozen candidate archive does not match its signed update manifest.');
  }
  const archiveEntries = validateArchiveListing(paths.candidateArchivePath);
  if (!archiveEntries.length) throw new Error('Frozen candidate archive is empty.');
  validatePortableRoot(paths.candidatePortableRoot, publicKeyPem);
  validateCandidateArchive(paths.candidateArchivePath, paths.candidatePortableRoot, publicKeyPem);

  const sbomBytes = fs.readFileSync(paths.candidateSbomPath);
  const sbom = parseJsonBytes(sbomBytes, 'candidate SBOM');
  if (sbom?.metadata?.component?.name !== REMOTE_CONNECTOR_RELEASE.product
    || sbom?.metadata?.component?.version !== REMOTE_CONNECTOR_RELEASE.version) {
    throw new Error('Frozen candidate SBOM has the wrong product identity.');
  }
  const snapshot = snapshotTree(paths.candidateRoot);
  return {
    manifest,
    manifestBytes,
    manifestSha256: sha256Buffer(manifestBytes),
    archiveSha256,
    archiveSize: archiveStat.size,
    sbomBytes,
    sbomSha256: sha256Buffer(sbomBytes),
    treeDigest: snapshot.digest,
    treeEntries: snapshot.entries
  };
}

function validateUpdateManifest(manifest, publicKeyPem) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Candidate update manifest must be an object.');
  }
  const expected = REMOTE_CONNECTOR_RELEASE;
  assertExactKeys(manifest, [
    'schemaVersion',
    'product',
    'channel',
    'platform',
    'version',
    'sequence',
    'publishedAt',
    'url',
    'sha256',
    'size',
    'minimumSupervisorVersion',
    'rolloutPolicy',
    'securitySeverity',
    'newRunStopAt',
    'maxDrainUntil',
    'offerExpiresAt',
    'keyId',
    'signature'
  ], 'candidate update manifest');
  const exact = {
    schemaVersion: 'omnia.v5.remote-connector-update/v1',
    product: expected.product,
    channel: expected.channel,
    platform: expected.platform,
    version: expected.version,
    sequence: expected.sequence,
    minimumSupervisorVersion: expected.supervisorVersion,
    rolloutPolicy: 'automatic_safe_window',
    securitySeverity: 'normal',
    keyId: expected.keyId,
    url: `https://download.example.invalid/files/v5-remote-connector/releases/${expected.version}/${archiveName}`
  };
  for (const [key, value] of Object.entries(exact)) {
    if (manifest[key] !== value) throw new Error(`Candidate update manifest has invalid ${key}.`);
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error('Candidate update manifest archive identity is invalid.');
  }
  const dates = ['publishedAt', 'newRunStopAt', 'maxDrainUntil', 'offerExpiresAt']
    .map((key) => [key, Date.parse(manifest[key])]);
  if (dates.some(([, value]) => !Number.isFinite(value))) {
    throw new Error('Candidate update manifest contains an invalid release timestamp.');
  }
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index][1] <= dates[index - 1][1]) {
      throw new Error('Candidate update manifest release timestamps are not strictly increasing.');
    }
  }
  verifySignedObject(manifest, publicKeyPem, 'candidate update manifest');
}

function validateArchiveListing(archivePath) {
  const listing = spawnSync('tar.exe', ['-tf', archivePath], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (listing.status !== 0) {
    throw new Error(`Could not inspect frozen candidate archive: ${listing.stderr || listing.stdout}`);
  }
  const entries = String(listing.stdout || '').split(/\r?\n/u).filter(Boolean);
  for (const entry of entries) {
    if (entry.includes('\\') || entry.includes(':') || entry.startsWith('/') || entry.includes('\0')) {
      throw new Error(`Candidate archive contains an unsafe path: ${entry}`);
    }
    const segments = entry.replace(/\/$/u, '').split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')
      || segments[0] !== packageName) {
      throw new Error(`Candidate archive escaped its exact portable root: ${entry}`);
    }
  }
  return entries;
}

function validatePortableRoot(portableRoot, publicKeyPem) {
  const expectedRoot = path.basename(portableRoot);
  if (expectedRoot !== packageName || !fs.statSync(portableRoot).isDirectory()) {
    throw new Error('Portable archive root has the wrong identity.');
  }
  const manifestPath = path.join(portableRoot, 'portable-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Portable manifest is unavailable.');
  const manifest = parseJsonBytes(fs.readFileSync(manifestPath), 'portable manifest');
  assertExactKeys(manifest, [
    'schemaVersion', 'product', 'version', 'sequence', 'platform', 'keyId', 'files', 'signature'
  ], 'portable manifest');
  for (const [key, value] of Object.entries({
    schemaVersion: 'omnia.v5.remote-connector-portable/v1',
    product: REMOTE_CONNECTOR_RELEASE.product,
    version: REMOTE_CONNECTOR_RELEASE.version,
    sequence: REMOTE_CONNECTOR_RELEASE.sequence,
    platform: REMOTE_CONNECTOR_RELEASE.platform,
    keyId: REMOTE_CONNECTOR_RELEASE.keyId
  })) {
    if (manifest[key] !== value) throw new Error(`Portable manifest has invalid ${key}.`);
  }
  verifySignedObject(manifest, publicKeyPem, 'portable manifest');
  if (!Array.isArray(manifest.files)) throw new Error('Portable manifest inventory is invalid.');
  const expectedFiles = listRegularFiles(portableRoot)
    .filter((filename) => path.resolve(filename) !== path.resolve(manifestPath))
    .map((filename) => ({
      path: path.relative(portableRoot, filename).split(path.sep).join('/'),
      size: fs.statSync(filename).size,
      sha256: sha256File(filename)
    }))
    .sort(compareInventory);
  const declaredFiles = manifest.files.map((entry) => ({
    path: String(entry?.path || ''),
    size: entry?.size,
    sha256: String(entry?.sha256 || '')
  }));
  for (let index = 0; index < declaredFiles.length; index += 1) {
    const sourceEntry = manifest.files[index];
    assertExactKeys(sourceEntry, ['path', 'size', 'sha256'], 'portable manifest inventory entry');
    const entry = declaredFiles[index];
    if (!isSafeRelativePath(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error('Portable manifest contains an invalid inventory entry.');
    }
  }
  if (canonicalJson(declaredFiles) !== canonicalJson([...declaredFiles].sort(compareInventory))) {
    throw new Error('Portable manifest inventory is not in canonical path order.');
  }
  if (new Set(declaredFiles.map((entry) => entry.path)).size !== declaredFiles.length
    || canonicalJson(declaredFiles) !== canonicalJson(expectedFiles)) {
    throw new Error('Portable bytes do not match the signed inventory.');
  }
  const identity = parseJsonBytes(
    fs.readFileSync(path.join(portableRoot, 'package-identity.json')),
    'portable package identity'
  );
  assertExactKeys(identity, [
    'schemaVersion',
    'product',
    'version',
    'sequence',
    'supervisorVersion',
    'sourceCommit',
    'platform',
    'installDirectory',
    'dataDirectory',
    'updateManifestUrl',
    'v4Coexistence'
  ], 'portable package identity');
  for (const [key, value] of Object.entries({
    schemaVersion: 'omnia.v5.remote-connector-identity/v1',
    product: REMOTE_CONNECTOR_RELEASE.product,
    version: REMOTE_CONNECTOR_RELEASE.version,
    sequence: REMOTE_CONNECTOR_RELEASE.sequence,
    supervisorVersion: REMOTE_CONNECTOR_RELEASE.supervisorVersion,
    platform: REMOTE_CONNECTOR_RELEASE.platform
  })) {
    if (identity[key] !== value) throw new Error(`Portable package identity has invalid ${key}.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(String(identity.sourceCommit || ''))) {
    throw new Error('Portable package identity is not bound to an exact source commit.');
  }
}

function validateCandidateArchive(archivePath, candidatePortableRoot, publicKeyPem) {
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-connector-candidate-verify-'));
  try {
    extractArchive(archivePath, extractionRoot);
    const extractedPortableRoot = path.join(extractionRoot, packageName);
    validatePortableRoot(extractedPortableRoot, publicKeyPem);
    const candidateSnapshot = snapshotTree(candidatePortableRoot);
    const extractedSnapshot = snapshotTree(extractedPortableRoot);
    if (candidateSnapshot.digest !== extractedSnapshot.digest
      || candidateSnapshot.entries !== extractedSnapshot.entries) {
      throw new Error('Frozen candidate portable tree is not byte-identical to its archive.');
    }
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function createJournal(paths, candidate) {
  const previousStableBytes = fs.existsSync(paths.stableManifestPath)
    ? fs.readFileSync(paths.stableManifestPath)
    : null;
  const journal = {
    schemaVersion: journalSchema,
    product: REMOTE_CONNECTOR_RELEASE.product,
    version: REMOTE_CONNECTOR_RELEASE.version,
    sequence: REMOTE_CONNECTOR_RELEASE.sequence,
    supervisorVersion: REMOTE_CONNECTOR_RELEASE.supervisorVersion,
    promotionId: `${REMOTE_CONNECTOR_RELEASE.version}-${REMOTE_CONNECTOR_RELEASE.sequence}-${candidate.manifestSha256.slice(0, 12)}`,
    candidate: {
      root: relativePortablePath(paths.workspaceRoot, paths.candidateRoot),
      archive: archiveName,
      archiveSha256: candidate.archiveSha256,
      archiveSize: candidate.archiveSize,
      manifest: candidateManifestName,
      manifestSha256: candidate.manifestSha256,
      sbomSha256: candidate.sbomSha256,
      treeDigest: candidate.treeDigest,
      treeEntries: candidate.treeEntries
    },
    previousStable: previousStableBytes === null
      ? { exists: false, sha256: null, bytesBase64: null }
      : {
          exists: true,
          sha256: sha256Buffer(previousStableBytes),
          bytesBase64: previousStableBytes.toString('base64')
        },
    phase: 'prepared',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeJournal(paths.journalPath, journal);
  return readJournal(paths.journalPath);
}

function readJournal(journalPath) {
  const journal = parseJsonBytes(fs.readFileSync(journalPath), 'promotion journal');
  const digest = journal.journalDigest;
  const unsigned = { ...journal };
  delete unsigned.journalDigest;
  if (!/^[0-9a-f]{64}$/.test(String(digest || ''))
    || digest !== sha256Buffer(Buffer.from(canonicalJson(unsigned)))) {
    throw new Error('Promotion journal integrity check failed.');
  }
  if (journal.schemaVersion !== journalSchema || !(journal.phase in phaseOrder)) {
    throw new Error('Promotion journal schema or phase is invalid.');
  }
  return journal;
}

function writeJournal(journalPath, journal) {
  const value = { ...journal };
  delete value.journalDigest;
  value.journalDigest = sha256Buffer(Buffer.from(canonicalJson(value)));
  atomicWriteFile(journalPath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

function advanceJournal(journalPath, journal, phase) {
  if (phaseOrder[phase] < phaseOrder[journal.phase]) return journal;
  const next = { ...journal, phase, updatedAt: new Date().toISOString() };
  writeJournal(journalPath, next);
  return readJournal(journalPath);
}

function assertJournalMatchesCandidate(journal, paths, candidate) {
  const expected = REMOTE_CONNECTOR_RELEASE;
  if (journal.product !== expected.product || journal.version !== expected.version
    || journal.sequence !== expected.sequence || journal.supervisorVersion !== expected.supervisorVersion) {
    throw new Error('Promotion journal belongs to a different release identity.');
  }
  const identity = journal.candidate || {};
  if (identity.root !== relativePortablePath(paths.workspaceRoot, paths.candidateRoot)
    || identity.archive !== archiveName || identity.archiveSha256 !== candidate.archiveSha256
    || identity.archiveSize !== candidate.archiveSize || identity.manifest !== candidateManifestName
    || identity.manifestSha256 !== candidate.manifestSha256 || identity.sbomSha256 !== candidate.sbomSha256
    || identity.treeDigest !== candidate.treeDigest || identity.treeEntries !== candidate.treeEntries) {
    throw new Error('Frozen candidate no longer matches the durable promotion journal.');
  }
  assertPreviousStableRecord(journal.previousStable);
}

function assertPreviousStableRecord(record) {
  if (!record || typeof record.exists !== 'boolean') throw new Error('Promotion journal previous-stable record is invalid.');
  if (!record.exists) {
    if (record.sha256 !== null || record.bytesBase64 !== null) {
      throw new Error('Promotion journal has invalid absent-stable evidence.');
    }
    return;
  }
  const bytes = decodeBase64Exact(record.bytesBase64, 'previous stable bytes');
  if (record.sha256 !== sha256Buffer(bytes)) throw new Error('Promotion journal previous-stable digest is invalid.');
}

function prepareReleaseStage(paths, candidate, publicKeyPem) {
  removeExactStage(paths.releaseStage, path.dirname(paths.releaseStage));
  fs.mkdirSync(paths.releaseStage, { recursive: true });
  extractArchive(paths.candidateArchivePath, paths.releaseStage);
  atomicCopyFile(paths.candidateArchivePath, path.join(paths.releaseStage, archiveName));
  atomicWriteFile(path.join(paths.releaseStage, candidateManifestName), candidate.manifestBytes);
  atomicWriteFile(path.join(paths.releaseStage, 'sbom.json'), candidate.sbomBytes);
  validateReleaseTarget(paths.releaseStage, candidate, publicKeyPem);
  fsyncTreeBestEffort(paths.releaseStage);
}

function preparePublicReleaseStage(paths, candidate) {
  removeExactStage(paths.publicReleaseStage, path.dirname(paths.publicReleaseStage));
  fs.mkdirSync(paths.publicReleaseStage, { recursive: true });
  atomicCopyFile(paths.candidateArchivePath, path.join(paths.publicReleaseStage, archiveName));
  validatePublicReleaseTarget(paths.publicReleaseStage, candidate);
}

function validateReleaseTarget(target, candidate, publicKeyPem) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Promoted local release is unavailable: ${target}`);
  }
  const expected = [archiveName, candidateManifestName, packageName, 'sbom.json'].sort();
  if (canonicalJson(fs.readdirSync(target).sort()) !== canonicalJson(expected)) {
    throw new Error('Promoted local release contains unexpected bytes.');
  }
  assertFileIdentity(path.join(target, archiveName), candidate.archiveSize, candidate.archiveSha256, 'local release archive');
  assertExactFile(path.join(target, candidateManifestName), candidate.manifestBytes, 'local release manifest');
  assertExactFile(path.join(target, 'sbom.json'), candidate.sbomBytes, 'local release SBOM');
  validatePortableRoot(path.join(target, packageName), publicKeyPem);
}

function validatePublicReleaseTarget(target, candidate) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Promoted public archive directory is unavailable: ${target}`);
  }
  if (canonicalJson(fs.readdirSync(target)) !== canonicalJson([archiveName])) {
    throw new Error('Promoted public archive directory contains unexpected bytes.');
  }
  assertFileIdentity(path.join(target, archiveName), candidate.archiveSize, candidate.archiveSha256, 'public release archive');
}

function validatePublishedRelease(paths, candidate, publicKeyPem) {
  validateReleaseTarget(paths.releaseTarget, candidate, publicKeyPem);
  validatePublicReleaseTarget(paths.publicReleaseTarget, candidate);
  assertExactFile(paths.stableManifestPath, candidate.manifestBytes, 'stable manifest');
}

function extractArchive(archivePath, destination) {
  validateArchiveListing(archivePath);
  const extraction = spawnSync('tar.exe', ['-xf', archivePath, '-C', destination], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (extraction.status !== 0) {
    throw new Error(`Candidate archive extraction failed: ${extraction.stderr || extraction.stdout}`);
  }
}

function assertStableStillMatchesPrevious(stablePath, previous) {
  assertPreviousStableRecord(previous);
  if (!previous.exists) {
    if (fs.existsSync(stablePath)) throw new Error('Stable pointer appeared after the promotion journal was prepared.');
    return;
  }
  const expected = decodeBase64Exact(previous.bytesBase64, 'previous stable bytes');
  assertExactFile(stablePath, expected, 'previous stable manifest');
}

function assertCandidateUnchanged(paths, candidate) {
  const current = snapshotTree(paths.candidateRoot);
  if (current.digest !== candidate.treeDigest || current.entries !== candidate.treeEntries
    || !fileEqualsBuffer(paths.candidateManifestPath, candidate.manifestBytes)) {
    throw new Error('Frozen candidate changed during promotion.');
  }
}

function snapshotTree(root) {
  const files = listRegularFiles(root).map((filename) => ({
    path: relativePortablePath(root, filename),
    size: fs.statSync(filename).size,
    sha256: sha256File(filename)
  })).sort(compareInventory);
  return { entries: files.length, digest: sha256Buffer(Buffer.from(canonicalJson(files))) };
}

function listRegularFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in a release tree: ${target}`);
    if (stat.isDirectory()) return listRegularFiles(target);
    if (!stat.isFile()) throw new Error(`Non-regular release entry is forbidden: ${target}`);
    return [target];
  });
}

function compareInventory(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function isSafeRelativePath(value) {
  if (!value || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function verifySignedObject(value, publicKeyPem, label) {
  const signature = decodeBase64Exact(value.signature, `${label} signature`);
  const payload = { ...value };
  delete payload.signature;
  if (!crypto.verify(null, Buffer.from(canonicalJson(payload)), publicKeyPem, signature)) {
    throw new Error(`${label} signature verification failed.`);
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeBase64Exact(value, label) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is not canonical base64.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label} is not canonical base64.`);
  return bytes;
}

function canonicalJson(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} contains missing or unexpected fields.`);
  }
}

function sha256Buffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function assertFileIdentity(filename, size, digest, label) {
  if (!fs.existsSync(filename)) throw new Error(`${label} is unavailable.`);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size !== size || sha256File(filename) !== digest) {
    throw new Error(`${label} does not match the frozen candidate.`);
  }
}

function assertExactFile(filename, bytes, label) {
  if (!fileEqualsBuffer(filename, bytes)) throw new Error(`${label} is not byte-for-byte identical to the frozen candidate.`);
}

function fileEqualsBuffer(filename, bytes) {
  if (!fs.existsSync(filename)) return false;
  const actual = fs.readFileSync(filename);
  return actual.length === bytes.length && crypto.timingSafeEqual(actual, bytes);
}

function atomicCopyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.tmp`);
  assertDirectChild(stage, path.dirname(destination));
  fs.rmSync(stage, { force: true });
  fs.copyFileSync(source, stage, fs.constants.COPYFILE_EXCL);
  const handle = fs.openSync(stage, 'r+');
  try {
    assertRegularFileHandle(handle, stage, 'atomic copy staging file');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(stage, destination);
  fsyncDirectoryBestEffort(path.dirname(destination));
}

function atomicWriteFile(destination, bytes) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.tmp`);
  assertDirectChild(stage, path.dirname(destination));
  fs.rmSync(stage, { force: true });
  const handle = fs.openSync(stage, 'wx');
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(stage, destination);
  fsyncDirectoryBestEffort(path.dirname(destination));
}

function fsyncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = fs.openSync(directory, 'r');
    fs.fsyncSync(handle);
  } catch {
    // Windows may reject directory handles; the file itself was fsynced before rename.
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function fsyncTreeBestEffort(root) {
  for (const filename of listRegularFiles(root)) {
    let handle;
    try {
      handle = fs.openSync(filename, 'r+');
      assertRegularFileHandle(handle, filename, 'promotion staging file');
      fs.fsyncSync(handle);
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  }
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  for (const directory of directories.reverse()) fsyncDirectoryBestEffort(directory);
}

function assertRegularFileHandle(handle, filename, label) {
  const pathStat = fs.lstatSync(filename);
  const handleStat = fs.fstatSync(handle);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || !handleStat.isFile()
    || pathStat.size !== handleStat.size) {
    throw new Error(`${label} is not the authorized ordinary file opened for durability sync.`);
  }
}

function removeExactStage(stage, parent) {
  assertDirectChild(stage, parent);
  if (!path.basename(stage).startsWith('.promotion-')) throw new Error(`Refusing to clean non-promotion staging path: ${stage}`);
  fs.rmSync(stage, { recursive: true, force: true });
}

function assertDirectChild(target, parent) {
  const resolvedTarget = path.resolve(target);
  const resolvedParent = path.resolve(parent);
  if (path.dirname(resolvedTarget) !== resolvedParent || resolvedTarget === resolvedParent) {
    throw new Error(`Release path escaped its fixed parent: ${resolvedTarget}`);
  }
}

function relativePortablePath(root, filename) {
  const relative = path.relative(root, filename).split(path.sep).join('/');
  if (!isSafeRelativePath(relative)) throw new Error(`Path escaped its expected root: ${filename}`);
  return relative;
}

function injectFailure(actual, expected) {
  if (actual === expected) {
    const error = new Error(`Injected promotion interruption at ${expected}.`);
    error.code = 'PROMOTION_TEST_INTERRUPTION';
    throw error;
  }
}

function promotionResult(paths, candidate, journal, resumed) {
  return {
    ok: true,
    version: REMOTE_CONNECTOR_RELEASE.version,
    sequence: REMOTE_CONNECTOR_RELEASE.sequence,
    supervisorVersion: REMOTE_CONNECTOR_RELEASE.supervisorVersion,
    archiveSha256: candidate.archiveSha256,
    archiveSize: candidate.archiveSize,
    release: paths.releaseTarget,
    publicArchive: path.join(paths.publicReleaseTarget, archiveName),
    stableManifest: paths.stableManifestPath,
    journal: paths.journalPath,
    phase: journal.phase,
    resumed
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== 'win32') throw new Error('Remote Connector 0.3.35 local promotion requires Windows tar.exe.');
  const unknownArgs = process.argv.slice(2);
  if (unknownArgs.length) throw new Error(`Unknown promotion arguments: ${unknownArgs.join(' ')}`);
  const result = promoteRemoteConnectorCandidate();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
