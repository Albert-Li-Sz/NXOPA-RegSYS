import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (!existsSync('.env')) {
  const setup = spawnSync('pnpm', ['run', 'setup'], { stdio: 'inherit' });
  if (setup.status !== 0) process.exit(setup.status ?? 1);
}
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
  if (r.status !== 0) process.exit(r.status ?? 1);
}
for (const script of ['db:generate', 'db:migrate']) {
  const r = spawnSync('pnpm', [script], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const children = [
  spawn('pnpm', ['--filter', '@contest-center/server', 'dev'], { stdio: 'inherit' }),
  spawn('pnpm', ['--filter', '@contest-center/server', 'worker'], { stdio: 'inherit' }),
  spawn('pnpm', ['--filter', '@contest-center/web', 'dev'], { stdio: 'inherit' }),
];
let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const p of children) p.kill('SIGTERM');
  process.exit(code);
};
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
for (const p of children) {
  p.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  p.on('exit', (code, signal) => {
    stop(code && code > 0 ? code : signal ? 1 : 0);
  });
}
