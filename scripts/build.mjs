import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILTIN_FEATURE_RELEASE_PROJECTION,
  assertBuiltinFeatureReleaseProjection,
  validateBuiltinFeatureReleaseInventory
} from '../src/main/features/builtin-release-inventory.ts';

const root = path.resolve(import.meta.dirname, '..');
assertBuiltinFeatureReleaseProjection(BUILTIN_FEATURE_RELEASE_PROJECTION);
validateBuiltinFeatureReleaseInventory(root);
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'renderer'), { recursive: true });
await mkdir(path.join(dist, 'main'), { recursive: true });
await mkdir(path.join(dist, 'remote-connector'), { recursive: true });
await mkdir(path.join(dist, 'bridge'), { recursive: true });
await mkdir(path.join(dist, 'tools'), { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(dist, 'main/main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron', 'node:sqlite'],
    sourcemap: true
  }),
  build({
    entryPoints: [path.join(root, 'src/tools/feature-installer.ts')],
    outfile: path.join(dist, 'tools/feature-installer.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['node:sqlite'],
    sourcemap: false
  }),
  build({
    entryPoints: [path.join(root, 'src/main/features/feature-worker-host.ts')],
    outfile: path.join(dist, 'main/feature-worker-host.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false
  }),
  build({
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(dist, 'main/preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    sourcemap: true
  }),
  build({
    entryPoints: [path.join(root, 'src/preload/feature.ts')],
    outfile: path.join(dist, 'main/feature-preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    sourcemap: true
  }),
  build({
    entryPoints: [path.join(root, 'src/renderer/index.tsx')],
    outfile: path.join(dist, 'renderer/app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome136'],
    sourcemap: true,
    minify: true
  }),
  build({
    entryPoints: [path.join(root, 'src/renderer/feature-window.ts')],
    outfile: path.join(dist, 'renderer/feature-window.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome136'],
    sourcemap: true,
    minify: true
  }),
  build({
    entryPoints: [path.join(root, 'src/remote-connector/cli.ts')],
    outfile: path.join(dist, 'remote-connector/cli.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false
  }),
  build({
    entryPoints: [path.join(root, 'src/remote-connector/supervisor.ts')],
    outfile: path.join(dist, 'remote-connector/supervisor.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false
  }),
  build({
    entryPoints: [path.join(root, 'src/remote-connector/worker.ts')],
    outfile: path.join(dist, 'remote-connector/worker.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false,
    external: ['playwright-core']
  }),
  build({
    entryPoints: [path.join(root, 'src/bridge/cli.ts')],
    outfile: path.join(dist, 'bridge/server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false
  })
]);

await Promise.all([
  cp(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html')),
  cp(path.join(root, 'src/renderer/feature-window.html'), path.join(dist, 'renderer/feature-window.html')),
  cp(path.join(root, 'src/renderer/styles.css'), path.join(dist, 'renderer/styles.css'))
]);

console.log('Built Omnia Agent v5 Shell into dist/.');
