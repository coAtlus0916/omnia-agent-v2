import { spawn } from 'node:child_process';

const build = spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit', shell: false });
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const electron = spawn(
    process.platform === 'win32' ? 'node_modules\\.bin\\electron.cmd' : 'node_modules/.bin/electron',
    ['.'],
    { stdio: 'inherit', shell: false }
  );
  electron.on('exit', (electronCode) => process.exit(electronCode ?? 0));
});
