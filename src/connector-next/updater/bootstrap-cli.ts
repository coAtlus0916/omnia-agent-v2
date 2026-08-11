import { runConnectorNextBootstrap } from './bootstrap.js';

void runConnectorNextBootstrap().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
