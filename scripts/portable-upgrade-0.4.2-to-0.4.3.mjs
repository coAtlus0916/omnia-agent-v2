import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-agent-v5-upgrade-043-'));
const evidenceRoot = path.join(root, 'acceptance', 'shell-0.4.3-upgrade');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digest = (filename) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}`;
const treeDigest = (directory) => {
  const hash = crypto.createHash('sha256');
  const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => {
    const filename = path.join(current, entry.name);
    if (entry.isDirectory()) walk(filename);
    else { hash.update(path.relative(directory, filename).replaceAll('\\', '/')); hash.update(fs.readFileSync(filename)); }
  });
  walk(directory);
  return `sha256:${hash.digest('hex')}`;
};
const exe = (version) => path.join(productRoot, 'releases', version, 'Omnia Agent v5.exe');
const install = (version, packagePath) => {
  const result = spawnSync(exe(version), [path.join(productRoot, 'releases', version, 'resources', 'app', 'dist', 'tools', 'feature-installer.cjs'), '--root', productRoot, 'install', packagePath], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};
const snapshot = async (version, seed = false) => {
  const app = await electron.launch({ executablePath: exe(version), env: { ...process.env, OMNIA_AGENT_PRODUCT_ROOT: productRoot } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
    if (seed) {
      await page.evaluate(async () => {
        let value = await window.omnia.getSnapshot();
        value = await window.omnia.sendMessage({ content: '0.4.2 升级保留验证消息', attachmentIds: [] });
        value = await window.omnia.saveScale({ percent: 110, expectedStateVersion: value.preference.stateVersion });
        value = await window.omnia.saveLayout({
          featureNavigationBasisPoints: 3050,
          featureNavigationCollapsed: false,
          expectedStateVersion: value.layout.stateVersion
        });
      });
    }
    return await page.evaluate(() => window.omnia.getSnapshot());
  } finally {
    await app.close();
  }
};

try {
  fs.mkdirSync(path.join(productRoot, 'releases'), { recursive: true });
  for (const version of ['0.4.2', '0.4.3']) fs.cpSync(path.join(root, 'releases', version), path.join(productRoot, 'releases', version), { recursive: true });
  fs.writeFileSync(path.join(productRoot, 'portable-root.json'), JSON.stringify({ schemaVersion: 'omnia.portable-product-root/v1', product: 'omnia-agent-v5', formatVersion: 1 }));
  fs.writeFileSync(path.join(productRoot, 'current'), JSON.stringify({ schemaVersion: 'omnia.active-release/v1', version: '0.4.2', relativePath: 'releases/0.4.2' }));
  install('0.4.2', path.join(root, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.2.ofp'));
  const beforeSnapshot = await snapshot('0.4.2', true);

  const probe = path.join(productRoot, 'data', 'user-preservation-probe.txt');
  fs.writeFileSync(probe, 'do-not-replace\n');
  const deletePath = path.join(productRoot, 'data', 'packages', 'installed', 'omnia.delete-elements', '0.1.2');
  const before = { probe: digest(probe), deletePackage: treeDigest(deletePath) };

  fs.writeFileSync(path.join(productRoot, 'current'), JSON.stringify({ schemaVersion: 'omnia.active-release/v1', version: '0.4.3', relativePath: 'releases/0.4.3' }));
  const afterSnapshot = await snapshot('0.4.3');
  const after = { probe: digest(probe), deletePackage: treeDigest(deletePath) };

  assert(beforeSnapshot.productVersion === '0.4.2' && afterSnapshot.productVersion === '0.4.3', 'upgrade version mismatch');
  assert(afterSnapshot.connection.transport === 'remote' && afterSnapshot.connection.mode === undefined, '0.4.3 is not Remote-only');
  assert(afterSnapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.delete-elements' && leaf.featureVersion === '0.1.2'), 'post-installed delete-elements activation missing');
  assert(afterSnapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.create-associate' && leaf.featureVersion === '0.1.0'), '0.4.3 create-associate builtin was not installed');
  assert(afterSnapshot.chat.messages.some((message) => message.content === '0.4.2 升级保留验证消息'), 'chat message was not preserved');
  assert(afterSnapshot.preference.uiScalePercent === 110, 'global scale preference was not preserved');
  assert(afterSnapshot.layout.featureNavigationBasisPoints === 3050, 'Shell layout was not preserved');
  assert(before.probe === after.probe && before.deletePackage === after.deletePackage, 'upgrade replaced user data or installed Feature package');

  const report = {
    ok: true,
    beforeVersion: beforeSnapshot.productVersion,
    afterVersion: afterSnapshot.productVersion,
    dataPreserved: before.probe === after.probe,
    createAssociateInstalledByUpgrade: true,
    deletePackagePreserved: before.deletePackage === after.deletePackage,
    legacyModeAbsent: afterSnapshot.connection.mode === undefined,
    oldReleasePreserved: fs.existsSync(path.join(productRoot, 'releases', '0.4.2')),
    digests: after
  };
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, 'upgrade-preservation-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  fs.rmSync(productRoot, { recursive: true, force: true });
}
