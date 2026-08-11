import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(root, 'src');
const violations = [];

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(target);
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

const forbidden = [
  { pattern: /\beval\s*\(/, reason: 'eval is forbidden' },
  { pattern: /\bnew\s+Function\s*\(/, reason: 'dynamic Function is forbidden' },
  { pattern: /nodeIntegration\s*:\s*true/, reason: 'Renderer Node integration is forbidden' },
  { pattern: /contextIsolation\s*:\s*false/, reason: 'context isolation cannot be disabled' },
  { pattern: /webSecurity\s*:\s*false/, reason: 'web security cannot be disabled' }
];

for (const filename of files(sourceRoot)) {
  const body = fs.readFileSync(filename, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(body)) violations.push(`${path.relative(root, filename)}: ${rule.reason}`);
  }
}

if (violations.length) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exit(1);
}
console.log(`Static security lint passed for ${files(sourceRoot).length} source files.`);

const isolationTest = path.join(root, 'tests', 'feature-business-isolation.test.ts');
const isolation = spawnSync(process.execPath, ['--import', 'tsx', '--test', isolationTest], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true
});
if (isolation.stdout) process.stdout.write(isolation.stdout);
if (isolation.stderr) process.stderr.write(isolation.stderr);
if (isolation.error) throw isolation.error;
if (isolation.status !== 0) process.exit(isolation.status ?? 1);
