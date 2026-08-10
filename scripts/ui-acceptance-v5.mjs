import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const screenshotRoot = path.join(root, 'acceptance');
fs.mkdirSync(screenshotRoot, { recursive: true });
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-agent-v5-ui-'));
const executablePath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron');
const app = await electron.launch({
  executablePath,
  args: [root],
  env: { ...process.env, OMNIA_AGENT_PRODUCT_ROOT: productRoot }
});

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  await page.getByTestId('global-session-bar').waitFor();

  const rail = page.locator('.rail');
  const railBox = await rail.boundingBox();
  if (!railBox || Math.abs(railBox.width - 56) > 2) throw new Error(`Fixed Rail width mismatch: ${railBox?.width}`);
  if (await page.locator('.chat-header,.column-header').count() !== 0) throw new Error('Legacy conversation/column header is present.');
  if (await page.getByRole('button', { name: '刷新会话' }).isEnabled()) throw new Error('Refresh must be disabled while disconnected.');
  await page.screenshot({ path: path.join(screenshotRoot, 'shell-v5-live.png'), fullPage: true });

  await page.locator('.rail-settings').click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await dialog.waitFor();
  if (await dialog.locator('.settings-nav').count() !== 1 || await dialog.locator('.settings-main').count() !== 1) {
    throw new Error('Settings dialog did not render independent navigation and content columns.');
  }
  const overflow = await dialog.locator('.settings-nav,.settings-main').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).overflowY));
  if (!overflow.every((value) => value === 'auto' || value === 'scroll')) throw new Error(`Settings columns are not independently scrollable: ${overflow.join(',')}`);
  await page.screenshot({ path: path.join(screenshotRoot, 'shell-v5-settings.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭' }).click();

  const collapse = page.locator('.collapse-button');
  const before = await page.evaluate(() => window.omnia.getSnapshot());
  await collapse.click();
  await page.waitForFunction(async (expected) => (await window.omnia.getSnapshot()).layout.collapsedPanels['feature-menu'] === expected, !before.layout.collapsedPanels['feature-menu']);
  const after = await page.evaluate(() => window.omnia.getSnapshot());
  if (after.layout.collapsedPanels['feature-menu'] === before.layout.collapsedPanels['feature-menu']) throw new Error('FeatureNavigation collapse did not persist a changed state.');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  const reloaded = await page.evaluate(() => window.omnia.getSnapshot());
  if (reloaded.layout.collapsedPanels['feature-menu'] !== after.layout.collapsedPanels['feature-menu']) throw new Error('FeatureNavigation collapse was not restored after reload.');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixedRailWidth: railBox.width,
    refreshDisabledWhileDisconnected: true,
    noLegacyConversationHeader: true,
    settingsIndependentColumns: true,
    collapsePersistedAfterReload: true,
    screenshots: ['acceptance/shell-v5-live.png', 'acceptance/shell-v5-settings.png'],
    rendererErrors: errors
  }, null, 2)}\n`);
} finally {
  await app.close();
  fs.rmSync(productRoot, { recursive: true, force: true });
}
