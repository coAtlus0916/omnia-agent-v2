import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findPortableProductRoot } from '../src/main/paths.js';

const root = path.resolve(import.meta.dirname, '..');

test('Shell release identity is consistently derived from version 0.5.0', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  const packageManager = fs.readFileSync(path.join(root, 'src', 'main', 'features', 'package-manager.ts'), 'utf8');
  const portable = fs.readFileSync(path.join(root, 'scripts', 'package-create-associate-next-portable.mjs'), 'utf8');
  assert.equal(packageJson.version, '0.5.0');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages['']?.version, packageJson.version);
  assert.match(packageManager, /const PRODUCT_VERSION = '0\.5\.0'/u);
  assert.match(main, /Omnia Agent v5 · \$\{app\.getVersion\(\)\}/u);
  assert.match(portable, /Omnia-Agent-v5-\$\{shellVersion\}-Company-Loopback-Portable/u);
  assert.doesNotMatch(portable, /Company-Loopback-Portable-\d{8}-r\d+/u);
});

test('the main window subscribes before load and retains a post-load visibility fallback', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  const subscribe = source.indexOf("windowToShow.once('ready-to-show'");
  const load = source.indexOf("await mainWindow.loadFile(rendererPath('index.html'))");
  const fallback = source.indexOf('!windowToShow.isVisible()', load);
  assert.ok(subscribe >= 0, 'ready-to-show subscription is missing');
  assert.ok(subscribe < load, 'ready-to-show must be subscribed before loadFile');
  assert.ok(fallback > load, 'a post-load visibility fallback must remain');
});

test('releases root discovery resolves a versioned release and rejects an isolated release', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-shell-startup-paths-'));
  try {
    const productRoot = path.join(temporary, 'releases');
    const nestedRelease = path.join(productRoot, '0.4.4');
    fs.mkdirSync(nestedRelease, { recursive: true });
    fs.writeFileSync(path.join(productRoot, 'portable-root.json'), JSON.stringify({
      schemaVersion: 'omnia.portable-product-root/v1', product: 'omnia-agent-v5', formatVersion: 1
    }));
    assert.equal(findPortableProductRoot(nestedRelease), productRoot);

    const isolatedRelease = path.join(temporary, 'isolated', '0.4.4');
    fs.mkdirSync(isolatedRelease, { recursive: true });
    assert.throws(() => findPortableProductRoot(isolatedRelease), /not inside a valid Omnia Agent v5 portable root/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('releases launcher resolves current with identity and containment checks', { skip: process.platform !== 'win32' }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-shell-launcher-'));
  try {
    const productRoot = path.join(temporary, 'releases');
    const release = path.join(productRoot, '0.4.4');
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(path.join(productRoot, 'portable-root.json'), JSON.stringify({
      schemaVersion: 'omnia.portable-product-root/v1', product: 'omnia-agent-v5', formatVersion: 1
    }));
    fs.writeFileSync(path.join(productRoot, 'current'), JSON.stringify({
      schemaVersion: 'omnia.active-release/v1', version: '0.4.4', relativePath: '0.4.4'
    }));
    fs.writeFileSync(path.join(release, 'release-manifest.json'), JSON.stringify({
      schemaVersion: 'omnia.shell-release/v1', product: 'omnia-agent-v5-shell', version: '0.4.4'
    }));
    const executable = path.join(release, 'Omnia Agent v5.exe');
    fs.writeFileSync(executable, 'contract fixture');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'launch-portable-shell.ps1'),
      '-ProductRoot', productRoot, '-ResolveOnly'
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), executable);

    fs.writeFileSync(path.join(productRoot, 'current'), JSON.stringify({
      schemaVersion: 'omnia.active-release/v1', version: '0.4.4', relativePath: '../outside'
    }));
    const escaped = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'launch-portable-shell.ps1'),
      '-ProductRoot', productRoot, '-ResolveOnly'
    ], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr.replace(/\r?\n/g, ''), /escapes the portable root/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('the double-click launcher does not pass a quoted trailing backslash', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'launch-portable-shell.cmd'), 'utf8');
  assert.match(source, /-ProductRoot "%~dp0\."/u);
  assert.doesNotMatch(source, /-ProductRoot "%~dp0"/u);
});
