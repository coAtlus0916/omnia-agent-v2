import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import { CoreDatabase } from '../main/database.js';
import { FeaturePackageManager } from '../main/features/package-manager.js';
import { assertPortableProductRoot, resolveProductPaths } from '../main/paths.js';

function parseArguments(args: string[]): { root: string; command: string; values: string[] } {
  const values = [...args];
  let root = process.env.OMNIA_AGENT_PRODUCT_ROOT || process.cwd();
  const rootIndex = values.indexOf('--root');
  if (rootIndex >= 0) {
    const selected = values[rootIndex + 1];
    if (!selected) throw new Error('--root requires an explicit portable product root.');
    root = selected;
    values.splice(rootIndex, 2);
  }
  const command = values.shift() || '';
  return { root: path.resolve(root), command, values };
}

const parsed = parseArguments(process.argv.slice(2));
if (!['install', 'list', 'rollback'].includes(parsed.command)) {
  throw new Error('Usage: feature-installer [--root PRODUCT_ROOT] install PACKAGE | list | rollback FEATURE_ID VERSION');
}
const paths = resolveProductPaths(assertPortableProductRoot(parsed.root));
const database = new CoreDatabase(paths.database, {
  encrypt: (plaintext) => plaintext,
  decrypt: (ciphertext) => ciphertext
});
let lockHandle: number | null = null;
const lockPath = path.join(paths.data, 'packages', 'feature-installer.lock');
function acquireMutationLock(): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const create = () => {
    lockHandle = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockHandle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  };
  try {
    create();
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    let pid = 0;
    try { pid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid); } catch { /* invalid lock is stale */ }
    let live = false;
    if (pid > 0) {
      try { process.kill(pid, 0); live = true; } catch { /* stale process */ }
    }
    if (live) throw new Error('Another Feature install or rollback process is active.');
    fs.rmSync(lockPath, { force: true });
    create();
  }
}
try {
  const manager = new FeaturePackageManager(database.db, paths);
  let result: unknown;
  if (parsed.command === 'install') {
    if (parsed.values.length !== 1) throw new Error('install requires exactly one official package filename.');
    acquireMutationLock();
    result = manager.install(path.resolve(parsed.values[0]!));
  } else if (parsed.command === 'rollback') {
    if (parsed.values.length !== 2) throw new Error('rollback requires FEATURE_ID and VERSION.');
    acquireMutationLock();
    result = manager.rollback(parsed.values[0]!, parsed.values[1]!);
  } else {
    if (parsed.values.length !== 0) throw new Error('list does not accept extra arguments.');
    result = manager.list();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
} finally {
  if (lockHandle !== null) {
    try { fs.closeSync(lockHandle); } catch { /* best-effort close */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* stale lock is recovered on next invocation */ }
  }
  database.close();
}
