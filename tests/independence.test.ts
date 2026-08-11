import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const forbiddenRepositoryName = ['omnia', 'agent', 'v4'].join('-');
const sourceRoots = ['src', 'scripts', 'tests', 'dist', 'releases']
  .map((directory) => path.join(root, directory))
  .filter((directory) => fs.existsSync(directory));

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(target);
    if (entry.isFile() && /\.(?:js|cjs|mjs|json|html|css|ts|tsx|md)$/i.test(entry.name)) return [target];
    return [];
  });
}

test('source and build output are independent from the predecessor workspace', () => {
  const violations: string[] = [];
  for (const directory of sourceRoots) {
    for (const filename of files(directory)) {
      if (filename.endsWith('.map')) continue;
      const body = fs.readFileSync(filename, 'utf8');
      if (body.includes(forbiddenRepositoryName)) violations.push(path.relative(root, filename));
      const imports = body.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g);
      for (const match of imports) {
        const resolved = path.resolve(path.dirname(filename), match[1]!);
        if (!resolved.startsWith(`${root}${path.sep}`)) {
          violations.push(`${path.relative(root, filename)}:cross-workspace-reference`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
