import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const packagePath = path.join(root, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.2.ofp');
const screenshotPath = path.join(root, 'acceptance', 'shell-v5-surface.png');
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-agent-v5-surface-'));
const executablePath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron');
const marker = { schemaVersion: 'omnia.portable-product-root/v1', product: 'omnia-agent-v5', formatVersion: 1 };
fs.writeFileSync(path.join(productRoot, 'portable-root.json'), JSON.stringify(marker));
const install = spawnSync(process.execPath, [path.join(root, 'dist', 'tools', 'feature-installer.cjs'), '--root', productRoot, 'install', packagePath], { encoding: 'utf8' });
if (install.status !== 0) throw new Error(`Official Feature install failed: ${install.stderr || install.stdout}`);

const app = await electron.launch({ executablePath, args: [root], env: { ...process.env, OMNIA_AGENT_PRODUCT_ROOT: productRoot } });
const waitForNativeWindow = async () => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (app.windows().length >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Native Feature BrowserWindow did not appear.');
};
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  const feature = page.getByRole('button', { name: '删除元素' });
  await feature.waitFor();
  await feature.click();
  await page.waitForFunction(async () => Boolean((await window.omnia.getSnapshot()).features.surface));
  await page.locator('.surface-actions').waitFor();

  const surfaceBeforeClose = await page.evaluate(async () => (await window.omnia.getSnapshot()).features.surface?.surfaceId || '');
  await page.locator('button[title="关闭（保留 Run）"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.feature-tab').length === 0);
  const afterClose = await page.evaluate(async () => (await window.omnia.getSnapshot()).features.surface?.surfaceId || '');
  if (!surfaceBeforeClose || afterClose !== surfaceBeforeClose) throw new Error('Closing a surface dropped the Core-owned Feature Run.');

  await feature.click();
  await page.locator('.surface-actions').waitFor();
  await page.locator('button[title="最小化"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.feature-tab').length === 0);
  await waitForNativeWindow();

  await feature.click();
  await page.locator('.feature-tab').click();
  await page.locator('.surface-actions').waitFor();
  await page.locator('button[title="弹出"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.feature-tab').length === 0);
  await waitForNativeWindow();
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const nativeFeatureWindow = app.windows().find((candidate) => candidate !== page);
  await nativeFeatureWindow?.close();
  await page.waitForTimeout(250);
  if (app.windows().length !== 1) throw new Error('Detached Feature BrowserWindow did not close cleanly.');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: 'omnia.delete-elements@0.1.2',
    closeKeepsRun: true,
    minimizedUsesNativeWindow: true,
    detachedUsesNativeWindow: true,
    detachedWindowClosed: true,
    screenshot: 'acceptance/shell-v5-surface.png'
  }, null, 2)}\n`);
} finally {
  await app.close();
  fs.rmSync(productRoot, { recursive: true, force: true });
}
