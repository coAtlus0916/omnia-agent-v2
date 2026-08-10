'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveHotEntrypoint() {
  const configuredRoot = String(process.env.OMNIA_AGENT_HOT_ROOT || '').trim();
  if (!configuredRoot) return path.join(__dirname, 'dist', 'main', 'main.cjs');

  const root = path.resolve(configuredRoot);
  const packagePath = path.join(root, 'package.json');
  const entrypoint = path.join(root, 'dist', 'main', 'main.cjs');
  if (!fs.existsSync(packagePath) || !fs.existsSync(entrypoint)) {
    throw new Error(`Omnia hot workspace is incomplete: ${root}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (packageJson.name !== 'omnia-agent-v5-shell') {
    throw new Error(`Omnia hot workspace identity is invalid: ${root}`);
  }
  return entrypoint;
}

require(resolveHotEntrypoint());
