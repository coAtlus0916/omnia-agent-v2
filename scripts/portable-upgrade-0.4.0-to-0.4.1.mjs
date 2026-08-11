import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-agent-v5-upgrade-'));
const evidenceRoot = path.join(root, 'acceptance', 'shell-0.4.1-upgrade');
const oldRelease = path.join(root, 'releases', '0.4.0');
const newRelease = path.join(root, 'releases', '0.4.1');
const oldExe = path.join(productRoot, 'releases', '0.4.0', 'Omnia Agent v5.exe');
const newExe = path.join(productRoot, 'releases', '0.4.1', 'Omnia Agent v5.exe');
const marker = { schemaVersion: 'omnia.portable-product-root/v1', product: 'omnia-agent-v5', formatVersion: 1 };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digestFile = (filename) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}`;
const treeDigest = (directory) => {
  if (!fs.existsSync(directory)) return '';
  const hash = crypto.createHash('sha256');
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(current, entry.name);
      const relative = path.relative(directory, filename).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(filename);
      else { hash.update(relative); hash.update(fs.readFileSync(filename)); }
    }
  };
  walk(directory);
  return `sha256:${hash.digest('hex')}`;
};
const runInstaller = (exe, releaseVersion, command, packagePath) => {
  const tool = path.join(productRoot, 'releases', releaseVersion, 'resources', 'app', 'dist', 'tools', 'feature-installer.cjs');
  const args = [tool, '--root', productRoot, command, ...(packagePath ? [packagePath] : [])];
  const result = spawnSync(exe, args, { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
  if (result.status !== 0) throw new Error(`installer ${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const launchSnapshot = async (exe) => {
  const app = await electron.launch({ executablePath: exe, env: { ...process.env, OMNIA_AGENT_PRODUCT_ROOT: productRoot } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
    await page.getByLabel('FeatureNavigation', { exact: true }).waitFor();
    await page.getByLabel('FeatureNavigation', { exact: true }).getByRole('button', { name: '删除元素' }).click();
    await page.waitForFunction(async () => (await window.omnia.getSnapshot()).features.surface?.featureId === 'omnia.delete-elements');
    return await page.evaluate(async () => {
      const snapshot = await window.omnia.getSnapshot();
      return {
        productVersion: snapshot.productVersion,
        leaves: snapshot.features.navigation.map((leaf) => `${leaf.featureId}@${leaf.featureVersion}`),
        groups: snapshot.features.groups.map((group) => `${group.id}:${group.label}`),
        deleteAvailability: snapshot.features.navigation.find((leaf) => leaf.featureId === 'omnia.delete-elements')?.availability,
        deleteSurfaceStatus: snapshot.features.surface?.status,
        deleteSurfaceMessage: snapshot.features.surface?.statusMessage
      };
    });
  } finally { await app.close(); }
};

fs.mkdirSync(path.join(productRoot, 'releases'), { recursive: true });
fs.cpSync(oldRelease, path.join(productRoot, 'releases', '0.4.0'), { recursive: true });
fs.writeFileSync(path.join(productRoot, 'portable-root.json'), JSON.stringify(marker, null, 2));
fs.writeFileSync(path.join(productRoot, 'current'), JSON.stringify({ schemaVersion: 'omnia.active-release/v1', version: '0.4.0', relativePath: 'releases/0.4.0' }, null, 2));
runInstaller(oldExe, '0.4.0', 'install', path.join(root, 'feature-packages', 'recording', 'candidates', 'recording-0.1.0.ofp'));
runInstaller(oldExe, '0.4.0', 'install', path.join(root, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.2.ofp'));
const beforeSnapshot = await launchSnapshot(oldExe);
assert(beforeSnapshot.productVersion === '0.4.0', 'pre-upgrade shell is not 0.4.0');
assert(beforeSnapshot.leaves.includes('omnia.recording@0.1.0') && beforeSnapshot.leaves.includes('omnia.delete-elements@0.1.2'), 'pre-upgrade active heads are incomplete');
assert(beforeSnapshot.deleteAvailability === 'available' && beforeSnapshot.deleteSurfaceStatus === 'blocked' && /连接 Omnia Pack/.test(beforeSnapshot.deleteSurfaceMessage || ''), 'pre-upgrade delete runtime is not the real available/connection-blocked implementation');

const preservationProbe = path.join(productRoot, 'data', 'user-preservation-probe.txt');
fs.writeFileSync(preservationProbe, 'stable-user-data-do-not-replace\n');
const before = {
  probe: digestFile(preservationProbe),
  deletePackage: treeDigest(path.join(productRoot, 'data', 'packages', 'installed', 'omnia.delete-elements', '0.1.2')),
  deleteStore: treeDigest(path.join(productRoot, 'data', 'features', 'omnia.delete-elements'))
};

fs.cpSync(newRelease, path.join(productRoot, 'releases', '0.4.1'), { recursive: true });
fs.writeFileSync(path.join(productRoot, 'current'), JSON.stringify({ schemaVersion: 'omnia.active-release/v1', version: '0.4.1', relativePath: 'releases/0.4.1' }, null, 2));
const afterSnapshot = await launchSnapshot(newExe);
const after = {
  probe: digestFile(preservationProbe),
  deletePackage: treeDigest(path.join(productRoot, 'data', 'packages', 'installed', 'omnia.delete-elements', '0.1.2')),
  deleteStore: treeDigest(path.join(productRoot, 'data', 'features', 'omnia.delete-elements'))
};
assert(afterSnapshot.productVersion === '0.4.1', 'post-upgrade shell is not 0.4.1');
assert(afterSnapshot.leaves.includes('omnia.recording@0.1.1') && afterSnapshot.leaves.includes('omnia.delete-elements@0.1.2'), 'post-upgrade active heads are incomplete');
assert(afterSnapshot.deleteAvailability === 'available' && afterSnapshot.deleteSurfaceStatus === 'blocked' && /连接 Omnia Pack/.test(afterSnapshot.deleteSurfaceMessage || ''), 'post-upgrade delete runtime is not preserved as the real available/connection-blocked implementation');
assert(afterSnapshot.groups.filter((group) => group === 'other:其他').length === 1, 'post-upgrade other group was not merged');
assert(before.probe === after.probe && before.deletePackage === after.deletePackage && before.deleteStore === after.deleteStore, '0.4.1 upgrade changed preserved user/delete Feature data');

const report = { ok: true, productRoot, beforeSnapshot, afterSnapshot, before, after, oldReleasePreserved: fs.existsSync(path.join(productRoot, 'releases', '0.4.0')), newRelease: path.join(productRoot, 'releases', '0.4.1') };
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.writeFileSync(path.join(evidenceRoot, 'upgrade-preservation-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
fs.rmSync(productRoot, { recursive: true, force: true });
