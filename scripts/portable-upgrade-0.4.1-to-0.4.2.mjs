import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-agent-v5-upgrade-042-'));
const evidenceRoot = path.join(root, 'acceptance', 'shell-0.4.2-upgrade');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digest = (filename) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}`;
const treeDigest = (directory) => {
  const hash = crypto.createHash('sha256');
  const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => {
    const filename = path.join(current, entry.name);
    if (entry.isDirectory()) walk(filename); else { hash.update(path.relative(directory, filename).replaceAll('\\', '/')); hash.update(fs.readFileSync(filename)); }
  });
  walk(directory); return `sha256:${hash.digest('hex')}`;
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
        value = await window.omnia.sendMessage({ content: '0.4.1 升级保留验证消息', attachmentIds: [] });
        value = await window.omnia.saveScale({ percent: 115, expectedStateVersion: value.preference.stateVersion });
        value = await window.omnia.saveLayout({
          featureNavigationBasisPoints: 3125,
          featureNavigationCollapsed: true,
          expectedStateVersion: value.layout.stateVersion
        });
        await window.omnia.saveSettingsLayout({
          settingsNavigationBasisPoints: 2875,
          expectedStateVersion: value.settingsLayout.stateVersion
        });
      });
    }
    return await page.evaluate(() => window.omnia.getSnapshot());
  } finally { await app.close(); }
};

fs.mkdirSync(path.join(productRoot, 'releases'), { recursive: true });
for (const version of ['0.4.1', '0.4.2']) fs.cpSync(path.join(root, 'releases', version), path.join(productRoot, 'releases', version), { recursive: true });
fs.writeFileSync(path.join(productRoot, 'portable-root.json'), JSON.stringify({ schemaVersion: 'omnia.portable-product-root/v1', product: 'omnia-agent-v5', formatVersion: 1 }));
fs.writeFileSync(path.join(productRoot, 'current'), JSON.stringify({ schemaVersion: 'omnia.active-release/v1', version: '0.4.1', relativePath: 'releases/0.4.1' }));
install('0.4.1', path.join(root, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.2.ofp'));
const beforeSnapshot = await snapshot('0.4.1', true);
const probe = path.join(productRoot, 'data', 'user-preservation-probe.txt');
fs.writeFileSync(probe, 'do-not-replace\n');
const sentinels = [
  ['attachments', 'user-attachment.bin', 'attachment-bytes\n'],
  ['evidence', 'upgrade-evidence.json', '{"evidence":"preserve"}\n'],
  ['documents', 'user-document.md', '# 用户文档\n不得被 release 替换。\n'],
  ['documentation-registry', 'registry-projection.json', '{"registry":"preserve"}\n']
].map(([directory, name, content]) => {
  const filename = path.join(productRoot, 'data', directory, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return filename;
});
const before = {
  probe: digest(probe),
  package: treeDigest(path.join(productRoot, 'data', 'packages', 'installed', 'omnia.delete-elements', '0.1.2')),
  sentinels: Object.fromEntries(sentinels.map((filename) => [path.relative(path.join(productRoot, 'data'), filename).replaceAll('\\', '/'), digest(filename)]))
};
fs.writeFileSync(path.join(productRoot, 'current'), JSON.stringify({ schemaVersion: 'omnia.active-release/v1', version: '0.4.2', relativePath: 'releases/0.4.2' }));
const afterSnapshot = await snapshot('0.4.2');
const after = {
  probe: digest(probe),
  package: treeDigest(path.join(productRoot, 'data', 'packages', 'installed', 'omnia.delete-elements', '0.1.2')),
  sentinels: Object.fromEntries(sentinels.map((filename) => [path.relative(path.join(productRoot, 'data'), filename).replaceAll('\\', '/'), digest(filename)]))
};
assert(beforeSnapshot.productVersion === '0.4.1' && afterSnapshot.productVersion === '0.4.2', 'upgrade version mismatch');
assert(afterSnapshot.connection.transport === 'remote', '0.4.2 did not migrate to Remote-only');
assert(afterSnapshot.connection.mode === undefined, 'legacy Local/Remote mode leaked into 0.4.2 snapshot');
assert(afterSnapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.delete-elements' && leaf.featureVersion === '0.1.2'), 'delete-elements activation missing');
assert(afterSnapshot.chat.messages.some((message) => message.content === '0.4.1 升级保留验证消息'), 'chat message was not preserved');
assert(afterSnapshot.preference.uiScalePercent === 115, 'global scale preference was not preserved');
assert(afterSnapshot.layout.featureNavigationBasisPoints === 3125 && afterSnapshot.layout.collapsedPanels['feature-menu'] === true, 'Shell layout was not preserved');
assert(afterSnapshot.settingsLayout.settingsNavigationBasisPoints === 2875, 'Settings splitter was not preserved');
assert(before.probe === after.probe && before.package === after.package && JSON.stringify(before.sentinels) === JSON.stringify(after.sentinels), 'upgrade replaced user data or Feature package');
const report = {
  ok: true,
  beforeVersion: beforeSnapshot.productVersion,
  afterVersion: afterSnapshot.productVersion,
  dataPreserved: before.probe === after.probe,
  preservedDomains: ['chat', 'attachments', 'evidence', 'documents', 'documentation-registry', 'layout', 'settings-layout', 'global-scale'],
  deletePackagePreserved: before.package === after.package,
  legacyModeAbsent: afterSnapshot.connection.mode === undefined,
  oldReleasePreserved: fs.existsSync(path.join(productRoot, 'releases', '0.4.1')),
  digests: after
};
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.writeFileSync(path.join(evidenceRoot, 'upgrade-preservation-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
fs.rmSync(productRoot, { recursive: true, force: true });
