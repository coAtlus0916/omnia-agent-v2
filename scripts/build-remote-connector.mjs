import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

export async function buildRemoteConnector(outputRoot) {
  const targetRoot = path.resolve(outputRoot);
  const sharedDist = path.join(root, 'dist');
  const temporaryRoot = path.resolve(os.tmpdir());
  if (targetRoot === temporaryRoot || !targetRoot.startsWith(`${temporaryRoot}${path.sep}`)
    || targetRoot === sharedDist || targetRoot.startsWith(`${sharedDist}${path.sep}`)) {
    throw new Error('Connector-only build requires a unique child of the operating-system temporary directory.');
  }
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  const entries = [
    ['cli', path.join(root, 'src', 'remote-connector', 'cli.ts')],
    ['guardian', path.join(root, 'src', 'remote-connector', 'guardian.ts')],
    ['supervisor', path.join(root, 'src', 'remote-connector', 'supervisor.ts')],
    ['worker', path.join(root, 'src', 'remote-connector', 'worker.ts')]
  ];
  const results = await Promise.all(entries.map(async ([name, entryPoint]) => build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outfile: path.join(targetRoot, `${name}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false,
    metafile: true,
    ...(name === 'worker' ? { external: ['playwright-core'] } : {})
  })));
  const inputs = [...new Set(results.flatMap((result) => Object.keys(result.metafile.inputs)).map((input) => (
    path.relative(root, path.resolve(root, input)).split(path.sep).join('/')
  )))].sort();
  if (inputs.some((input) => input.startsWith('../') || path.isAbsolute(input))) {
    throw new Error('Connector-only build resolved a source input outside the repository.');
  }
  return { outputRoot: targetRoot, inputs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputRoot = String(process.env.OMNIA_V5_REMOTE_CONNECTOR_BUILD_ROOT || '').trim();
  if (!outputRoot) throw new Error('OMNIA_V5_REMOTE_CONNECTOR_BUILD_ROOT is required for a Connector-only build.');
  const result = await buildRemoteConnector(outputRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
