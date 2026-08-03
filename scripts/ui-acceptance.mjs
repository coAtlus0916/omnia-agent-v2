import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const executablePath = path.join(root, 'releases', '0.2.0', 'Omnia Agent v5.exe');
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-ui-acceptance-'));
const assetRoot = path.join(root, 'docs', 'reviews', 'assets');
fs.mkdirSync(assetRoot, { recursive: true });

const app = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    OMNIA_AGENT_PRODUCT_ROOT: productRoot
  }
});

try {
  const window = await app.firstWindow();
  const rendererErrors = [];
  window.on('pageerror', (error) => rendererErrors.push(error.stack || error.message));
  await window.waitForLoadState('domcontentloaded');
  await window.getByText('连接与保活').waitFor();
  await window.getByText('安全锁').waitFor();
  await window.getByText('开始新的对话').waitFor();
  await window.screenshot({
    path: path.join(assetRoot, 'shell-0.2.0-home.png'),
    fullPage: true
  });

  const textarea = window.locator('textarea');
  const beforeComposer = await textarea.boundingBox();
  const resizer = window.locator('.composer-resizer');
  const resizerBox = await resizer.boundingBox();
  if (!beforeComposer || !resizerBox) throw new Error('Composer controls are unavailable.');
  await window.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 2);
  await window.mouse.down();
  await window.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y - 70);
  await window.mouse.up();
  await window.waitForTimeout(500);
  if (await textarea.count() !== 1) {
    await window.screenshot({
      path: path.join(assetRoot, 'shell-0.2.0-composer-failure.png'),
      fullPage: true
    });
    throw new Error(`Composer disappeared after resize: ${rendererErrors.join(' | ') || 'no renderer error'}`);
  }
  const afterComposer = await textarea.boundingBox();
  if (!afterComposer || afterComposer.height <= beforeComposer.height + 40) {
    throw new Error('Composer did not resize vertically.');
  }

  await window.getByRole('button', { name: '+' }).click();
  await window.getByRole('button', { name: '105%' }).waitFor();
  await window.getByRole('button', { name: '105%' }).click();
  await window.getByRole('button', { name: '100%' }).waitFor();

  await window.getByRole('button', { name: '设置' }).click();
  await window.getByRole('dialog', { name: '设置' }).waitFor();
  await window.getByLabel('Provider').selectOption('custom');
  await window.getByText('可填写 Nova API 地址').waitFor();
  await window.getByLabel('Base URL').fill('https://api.example.invalid/v1/');
  await window.getByLabel('Model').fill('acceptance-model');
  await window.screenshot({
    path: path.join(assetRoot, 'shell-0.2.0-settings.png'),
    fullPage: true
  });
  await window.getByRole('button', { name: '关闭' }).click();

  const splitters = window.locator('.splitter');
  const middleBefore = await window.locator('.home-column').boundingBox();
  const secondSplitter = splitters.nth(1);
  const secondBox = await secondSplitter.boundingBox();
  if (!middleBefore || !secondBox) throw new Error('Layout splitter is unavailable.');
  await window.mouse.move(secondBox.x + 2, secondBox.y + secondBox.height / 2);
  await window.mouse.down();
  await window.mouse.move(secondBox.x + 52, secondBox.y + secondBox.height / 2);
  await window.mouse.up();
  const middleAfter = await window.locator('.home-column').boundingBox();
  if (!middleAfter || middleAfter.width <= middleBefore.width + 25) {
    throw new Error('Column boundary did not resize.');
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    packagedShell: true,
    settingsInteractive: true,
    composerResizable: true,
    scaleInteractive: true,
    columnSplitterInteractive: true,
    screenshots: [
      'docs/reviews/assets/shell-0.2.0-home.png',
      'docs/reviews/assets/shell-0.2.0-settings.png'
    ]
  })}\n`);
} finally {
  await app.close();
  fs.rmSync(productRoot, { recursive: true, force: true });
}
