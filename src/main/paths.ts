import fs from 'node:fs';
import path from 'node:path';

export interface ProductPaths {
  root: string;
  data: string;
  stores: string;
  logs: string;
  temp: string;
  database: string;
}

export interface ProtectedDataRecovery {
  schemaVersion: 'omnia.protected-data-recovery/v1';
  reasonCode: 'SECRET.INSTANCE_KEY_UNREADABLE';
  occurredAt: string;
  previousDataRelativePath: string;
}

export function assertPortableProductRoot(root: string): string {
  const resolved = path.resolve(root);
  const marker = path.join(resolved, 'portable-root.json');
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(marker, 'utf8')) as unknown;
  } catch {
    throw new Error(`Portable product root sentinel is missing or invalid: ${marker}`);
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (value as Record<string, unknown>).schemaVersion !== 'omnia.portable-product-root/v1'
    || (value as Record<string, unknown>).product !== 'omnia-agent-v5'
    || (value as Record<string, unknown>).formatVersion !== 1
  ) throw new Error(`Portable product root sentinel has the wrong identity: ${marker}`);
  return resolved;
}

export function findPortableProductRoot(start: string): string {
  let cursor = path.resolve(start);
  for (let depth = 0; depth <= 4; depth += 1) {
    if (fs.existsSync(path.join(cursor, 'portable-root.json'))) return assertPortableProductRoot(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error('The packaged executable is not inside a valid Omnia Agent v5 portable root.');
}

export function resolveProductPaths(rootOverride = process.env.OMNIA_AGENT_PRODUCT_ROOT): ProductPaths {
  const root = path.resolve(rootOverride || process.cwd());
  const data = path.join(root, 'data');
  const paths: ProductPaths = {
    root,
    data,
    stores: path.join(data, 'stores'),
    logs: path.join(data, 'logs'),
    temp: path.join(data, 'temp'),
    database: path.join(data, 'stores', 'core.sqlite')
  };
  for (const directory of [
    paths.data,
    paths.stores,
    path.join(data, 'artifacts'),
    path.join(data, 'templates'),
    path.join(data, 'evidence'),
    path.join(data, 'documentation'),
    path.join(data, 'packages'),
    path.join(data, 'updates'),
    paths.logs,
    paths.temp
  ]) fs.mkdirSync(directory, { recursive: true });
  return paths;
}

export function quarantineUnreadableDataRoot(paths: ProductPaths): ProtectedDataRecovery {
  const root = assertPortableProductRoot(paths.root);
  const expectedData = path.resolve(root, 'data');
  if (path.resolve(paths.data) !== expectedData || !fs.existsSync(expectedData)) {
    throw new Error('Protected data recovery target is outside the portable product data root.');
  }
  const recoveryRoot = path.resolve(root, 'recovery');
  if (path.dirname(recoveryRoot) !== root) throw new Error('Protected data recovery root is invalid.');
  fs.mkdirSync(recoveryRoot, { recursive: true });
  const suffix = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`;
  const recoveredData = path.join(recoveryRoot, `unreadable-data-${suffix}`);
  fs.renameSync(expectedData, recoveredData);
  const replacement = resolveProductPaths(root);
  const record: ProtectedDataRecovery = {
    schemaVersion: 'omnia.protected-data-recovery/v1',
    reasonCode: 'SECRET.INSTANCE_KEY_UNREADABLE',
    occurredAt: new Date().toISOString(),
    previousDataRelativePath: path.relative(root, recoveredData).split(path.sep).join('/')
  };
  fs.writeFileSync(
    path.join(replacement.logs, 'protected-data-recovery.json'),
    `${JSON.stringify(record, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
  return record;
}
