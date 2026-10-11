import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (!existsSync('.env')) spawnSync('pnpm', ['run', 'setup'], { stdio: 'inherit' });
for (const args of [
  [
    'compose',
    '-f',
    'infra/compose/dependencies.yaml',
    '-f',
    'infra/compose/latex.dev.yaml',
    'up',
    '-d',
    '--build',
  ],
]) {
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.status) process.exit(r.status ?? 1);
}
for (const script of ['db:generate', 'db:migrate']) {
  const r = spawnSync('pnpm', [script], { stdio: 'inherit' });
  if (r.status) process.exit(r.status ?? 1);
}
const children = [
  spawn('pnpm', ['--filter', '@contest-center/server', 'dev'], { stdio: 'inherit' }),
  spawn('pnpm', ['--filter', '@contest-center/server', 'worker'], { stdio: 'inherit' }),
  spawn('pnpm', ['--filter', '@contest-center/web', 'dev'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const p of children) p.kill('SIGTERM');
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of children)
  p.on('exit', (code) => {
    if (code) stop();
  });
