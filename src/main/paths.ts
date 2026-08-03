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
