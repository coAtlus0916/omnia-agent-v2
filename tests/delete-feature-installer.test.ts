import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const templateRoot = path.join(root, 'scripts', 'installers', 'delete-elements');
const installerTemplate = path.join(templateRoot, 'InstallFeature.ps1');

function runInstaller(scriptRoot: string, portableRoot?: string, featureVersion?: string) {
  const script = path.join(scriptRoot, 'InstallFeature.ps1');
  const body = fs.readFileSync(installerTemplate, 'utf8');
  fs.writeFileSync(script, `\uFEFF${body.replaceAll('__FEATURE_VERSION__', featureVersion || '__FEATURE_VERSION__')}`, 'utf8');
  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (portableRoot !== undefined) args.push(portableRoot);
  return spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
}

function writePortableRoot(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'portable-root.json'), JSON.stringify({
    schemaVersion: 'omnia.portable-product-root/v1',
    product: 'omnia-agent-v5',
    formatVersion: 1
  }));
}

test('installer UX does not require Node, npm, manual SHA, or certificate utilities', () => {
  const cmd = fs.readFileSync(path.join(templateRoot, 'InstallFeature.cmd'), 'utf8');
  const ps1 = fs.readFileSync(installerTemplate, 'utf8');
  const combined = `${cmd}\n${ps1}`;
  assert.doesNotMatch(combined, /\bnode(?:\.exe)?\b/i);
  assert.doesNotMatch(combined, /\bnpm(?:\.cmd)?\b/i);
  assert.doesNotMatch(combined, /Get-FileHash|certutil|sha(?:1|256|512)/i);
  assert.match(ps1, /ELECTRON_RUN_AS_NODE/);
  assert.match(ps1, /feature-installer\.cjs/);
  assert.match(ps1, /process\.ExitCode/);
  assert.doesNotMatch(ps1, /\$installerExitCode\s*=\s*\$LASTEXITCODE/);
});

test('packager normalizes the Windows command wrapper to CRLF', () => {
  const packager = fs.readFileSync(path.join(root, 'scripts', 'package-delete-feature-installer.mjs'), 'utf8');
  assert.match(packager, /templateName\.endsWith\('\.cmd'\)/);
  assert.match(packager, /replace\(\/\\r\?\\n\/gu, '\\r\\n'\)/);
});

test('an explicit non-portable directory fails without claiming success', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-installer-invalid-'));
  try {
    const scriptRoot = path.join(temporary, 'installer');
    const invalidRoot = path.join(temporary, 'not-portable');
    fs.mkdirSync(scriptRoot);
    fs.mkdirSync(invalidRoot);
    const result = runInstaller(scriptRoot, invalidRoot);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /安装失败/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\[安装成功\]/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('automatic discovery rejects multiple sibling portable roots', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-installer-multiple-'));
  try {
    const scriptRoot = path.join(temporary, 'delete-elements-feature-0.1.2-installer');
    fs.mkdirSync(scriptRoot);
    writePortableRoot(path.join(temporary, 'omnia-agent-v5-portable-0.3.1'));
    writePortableRoot(path.join(temporary, 'omnia-agent-v5-portable-0.3.2'));
    const result = runInstaller(scriptRoot);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /找到多个 Omnia Agent v5 便携包/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\[安装成功\]/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('automatic discovery selects a unique sibling before validating active release', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-installer-unique-'));
  try {
    const scriptRoot = path.join(temporary, 'delete-elements-feature-0.1.2-installer');
    fs.mkdirSync(scriptRoot);
    const portableRoot = path.join(temporary, 'omnia-agent-v5-portable-0.3.1');
    writePortableRoot(portableRoot);
    const result = runInstaller(scriptRoot);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /缺少当前版本指针/);
    assert.doesNotMatch(output, /没有在安装包旁找到/);
    assert.doesNotMatch(output, /\[安装成功\]/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('automatic discovery supports the double directory created by Extract All', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-installer-extract-all-'));
  try {
    const installerOuter = path.join(temporary, 'delete-elements-feature-0.1.2-installer');
    const scriptRoot = path.join(installerOuter, 'delete-elements-feature-0.1.2-installer');
    fs.mkdirSync(scriptRoot, { recursive: true });
    const portableOuter = path.join(temporary, 'omnia-agent-v5-portable-0.3.1');
    const portableRoot = path.join(portableOuter, 'omnia-agent-v5-portable-0.3.1');
    writePortableRoot(portableRoot);
    const result = runInstaller(scriptRoot);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /缺少当前版本指针/);
    assert.doesNotMatch(output, /没有在安装包旁找到/);
    assert.doesNotMatch(output, /\[安装成功\]/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

const oldRelease = path.join(root, 'artifacts', 'omnia-agent-v5-portable-0.3.0', 'releases', '0.3.0');
const signedFeature = path.join(root, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.2.ofp');
test('the wrapper preserves a real embedded installer rejection and exits nonzero', {
  skip: !fs.existsSync(oldRelease) || !fs.existsSync(signedFeature)
}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-installer-real-rejection-'));
  try {
    const scriptRoot = path.join(temporary, 'delete-elements-feature-0.1.2-installer');
    const portableRoot = path.join(temporary, 'omnia-agent-v5-portable-0.3.0');
    fs.mkdirSync(scriptRoot, { recursive: true });
    writePortableRoot(portableRoot);
    fs.mkdirSync(path.join(portableRoot, 'data'));
    fs.mkdirSync(path.join(portableRoot, 'releases'));
    fs.symlinkSync(oldRelease, path.join(portableRoot, 'releases', '0.3.0'), 'junction');
    fs.writeFileSync(path.join(portableRoot, 'current'), JSON.stringify({
      schemaVersion: 'omnia.active-release/v1',
      version: '0.3.0',
      relativePath: 'releases/0.3.0'
    }));
    fs.copyFileSync(signedFeature, path.join(scriptRoot, 'delete-elements-0.1.2.ofp'));

    const result = runInstaller(scriptRoot, portableRoot, '0.1.2');
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Feature 安装器返回错误码|minimum|required|manifest/i);
    assert.doesNotMatch(output, /\[安装成功\]/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
