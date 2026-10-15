import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
await mkdir(path.join(root, '.runtime/reports'), { recursive: true });
const stage = await mkdtemp(path.join(root, '.runtime/full-regression-'));
const project = `nxopa-regression-${process.pid}`;
const children: ChildProcess[] = [];
const results: { suite: string; success: boolean; elapsedMs: number; log: string }[] = [];
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
const [pg, redis, api, web, smtp, mail, feishu] = await Promise.all(
  Array.from({ length: 7 }, freePort),
);
const secret = randomBytes(24).toString('hex');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  SEED_DEMO: '1',
  PORT: String(api),
  PUBLIC_URL: `http://127.0.0.1:${web}`,
  WEB_URL: `http://127.0.0.1:${web}`,
  TEST_URL: `http://127.0.0.1:${api}`,
  API_PROXY_TARGET: `http://127.0.0.1:${api}`,
  DATABASE_URL: `postgresql://contest:${secret}@127.0.0.1:${pg}/contest_center`,
  REDIS_URL: `redis://127.0.0.1:${redis}`,
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  STORAGE_MODE: 'LOCAL',
  STORAGE_DIR: path.join(stage, 'files'),
  LATEX_SPOOL: path.join(stage, 'latex'),
  SMTP_HOST: 'localhost',
  SMTP_PORT: String(smtp),
  SMTP_SECURITY: 'NONE',
  SMTP_FROM: '回归测试 <regression@example.test>',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  MAILPIT_URL: `http://127.0.0.1:${mail}`,
  FEISHU_FIXTURE_PORT: String(feishu),
  FEISHU_ACCOUNTS_BASE_URL: `http://127.0.0.1:${feishu}`,
  FEISHU_API_BASE_URL: `http://127.0.0.1:${feishu}`,
  TEST_LATEX_CONTAINER: `${project}-latex-1`,
  WORKFLOW_UPGRADE_PG_CONTAINER: `${project}-postgres-1`,
  PLAYWRIGHT_OUTPUT_DIR: path.join(root, '.runtime/reports', `full-browser-${process.pid}`),
  PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(
    root,
    '.runtime/reports',
    `full-browser-report-${process.pid}`,
  ),
};
await mkdir(env.STORAGE_DIR, { recursive: true });
await mkdir(env.LATEX_SPOOL, { recursive: true });
const fixture = path.join(stage, 'compose.json');
await writeFile(
  fixture,
  JSON.stringify({
    services: {
      postgres: {
        image: 'postgres:17.6-alpine',
        environment: {
          POSTGRES_USER: 'contest',
          POSTGRES_PASSWORD: secret,
          POSTGRES_DB: 'contest_center',
        },
        ports: [`127.0.0.1:${pg}:5432`],
        healthcheck: {
          test: ['CMD', 'pg_isready', '-U', 'contest'],
          interval: '2s',
          retries: 30,
        },
      },
      redis: {
        image: 'redis:7.4.5-alpine',
        ports: [`127.0.0.1:${redis}:6379`],
        healthcheck: {
          test: ['CMD', 'redis-cli', 'ping'],
          interval: '2s',
          retries: 30,
        },
      },
      mail: {
        image: 'axllent/mailpit:v1.27.8',
        ports: [`127.0.0.1:${smtp}:1025`, `127.0.0.1:${mail}:8025`],
      },
      latex: {
        image:
          process.env.PLATFORM_TEST_LATEX_IMAGE || 'ghcr.io/albert-li-sz/nxopa-regsys-latex:v0.3.5',
        network_mode: 'none',
        read_only: true,
        cap_drop: ['ALL'],
        cap_add: ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
        security_opt: ['no-new-privileges:true'],
        mem_limit: '1200m',
        cpus: 1,
        pids_limit: 64,
        tmpfs: ['/tmp:size=64m'],
        volumes: [`${env.LATEX_SPOOL}:/jobs`],
        environment: { LATEX_SPOOL: '/jobs' },
      },
    },
  }),
  { mode: 0o600 },
);
const compose = (args: string[]) =>
  exec('docker', ['compose', '-p', project, '-f', fixture, ...args], {
    cwd: root,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
function start(args: string[], name: string) {
  const child = spawn('pnpm', args, {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (b) => (output += b));
  child.stderr!.on('data', (b) => (output += b));
  return async () =>
    writeFile(
      path.join(root, `.runtime/reports/full-${name}.log`),
      output.replaceAll(secret, '[REDACTED]').replaceAll(env.ENCRYPTION_KEY, '[REDACTED]'),
      { mode: 0o600 },
    );
}
async function wait(url: string) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (
      await fetch(url)
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Test service did not start: ${url}`);
}
let setup = false;
const saveLogs: (() => Promise<void>)[] = [];
const ojProjects: { project: string; file: string }[] = [];
async function runSuite(suite: string, variables: NodeJS.ProcessEnv = env) {
  const started = Date.now();
  const name = `${suite}${variables.OJ_TYPE ? `-${variables.OJ_TYPE.toLowerCase()}` : ''}`;
  const log = `.runtime/reports/full-${name.replaceAll(':', '-')}.log`;
  let output = '',
    success = false;
  try {
    const result = await exec(
      'pnpm',
      [
        suite,
        ...(suite === 'test:e2e' && process.env.E2E_SPEC ? [process.env.E2E_SPEC] : []),
        ...(suite === 'test:e2e' && process.env.E2E_MAX_FAILURES
          ? [`--max-failures=${process.env.E2E_MAX_FAILURES}`]
          : []),
      ],
      {
        cwd: root,
        env: variables,
        timeout: 900000,
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    output = result.stdout + result.stderr;
    success = true;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    output =
      (failure.stdout ?? '') + (failure.stderr ?? '') + '\n' + failure.message.split('\n')[0];
  }
  await writeFile(
    path.join(root, log),
    output.replaceAll(secret, '[REDACTED]').replaceAll(env.ENCRYPTION_KEY, '[REDACTED]'),
    { mode: 0o600 },
  );
  results.push({ suite: name, success, elapsedMs: Date.now() - started, log });
  console.log(
    `[完整回归] ${name}: ${success ? 'PASS' : 'FAIL'} (${Math.round((Date.now() - started) / 1000)}s)`,
  );
}
try {
  await compose(['up', '-d', '--wait']);
  for (const script of ['db:migrate', 'seed'])
    await exec('pnpm', [script], { cwd: root, env, timeout: 60000, maxBuffer: 1024 * 1024 });
  saveLogs.push(start(['--filter', '@contest-center/server', 'start'], 'api'));
  saveLogs.push(start(['--filter', '@contest-center/server', 'worker'], 'worker'));
  saveLogs.push(
    start(
      ['--filter', '@contest-center/web', 'dev', '--host', '127.0.0.1', '--port', String(web)],
      'web',
    ),
  );
  await Promise.all([wait(`${env.TEST_URL}/api/v1/health`), wait(env.WEB_URL)]);
  setup = true;
  saveLogs.push(start(['exec', 'node', 'tests/fixtures/feishu-oauth.mjs'], 'feishu-fixture'));
  await wait(`${env.FEISHU_API_BASE_URL}/fixture`);
  const suites = (
    process.env.FULL_REGRESSION_SUITES ??
    'test:integration,test:auth,test:accounts,test:feishu,test:invitations,test:mail,test:mail-failover,test:template-bugs,test:overview,test:enhancements,test:admissions,test:activity-workflows,test:workflow-upgrade,test:bugs,test:security,test:permissions,test:file-race,test:load,test:mcp,test:e2e'
  )
    .split(',')
    .filter(Boolean);
  if (process.env.FULL_REGRESSION_OJ === '1') {
    for (const mode of ['hydro', 'domjudge']) {
      const file = `infra/fixtures/${mode}/compose.yaml`,
        name = `${project}-${mode}`;
      if (mode === 'domjudge') {
        try {
          await exec('docker', ['image', 'inspect', 'contest-center-domjudge:9.0.1']);
        } catch {
          await exec('pnpm', ['fixtures:domjudge'], {
            cwd: root,
            timeout: 1200000,
            maxBuffer: 5 * 1024 * 1024,
          });
        }
      }
      ojProjects.push({ project: name, file });
      await exec(
        'docker',
        ['compose', '-p', name, '-f', file, 'up', '-d', ...(mode === 'hydro' ? ['--build'] : [])],
        { cwd: root, timeout: 600000, maxBuffer: 5 * 1024 * 1024 },
      );
    }
  }
  for (const suite of suites) {
    if (suite === 'test:e2e' && process.env.FULL_REGRESSION_OJ === '1') {
      for (const mode of ['HYDRO', 'DOMJUDGE'])
        for (const ojSuite of [
          'test:oj',
          'test:oj-enhancements',
          'test:oj-recovery',
          'test:boundaries',
        ])
          await runSuite(ojSuite, {
            ...env,
            OJ_TYPE: mode,
            DOMJUDGE_TEST_PROJECT: `${project}-domjudge`,
          });
    }
    await runSuite(suite);
  }
} finally {
  for (const child of children)
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
  await Promise.all(saveLogs.map((save) => save()));
  await compose(['down', '-v', '--remove-orphans']);
  for (const fixture of ojProjects)
    await exec(
      'docker',
      ['compose', '-p', fixture.project, '-f', fixture.file, 'down', '-v', '--remove-orphans'],
      { cwd: root, timeout: 120000 },
    );
  await writeFile(
    path.join(root, '.runtime/reports/full-regression.json'),
    JSON.stringify(
      {
        success: setup && results.length > 0 && results.every((result) => result.success),
        results,
        checkedAt: new Date().toISOString(),
        commit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
        workingTreeDirty: !!(
          await exec('git', ['status', '--porcelain'], { cwd: root })
        ).stdout.trim(),
      },
      null,
      2,
    ),
  );
  await rm(stage, { recursive: true, force: true });
}
assert.ok(
  setup && results.length > 0 && results.every((result) => result.success),
  'Full regression failed; inspect .runtime/reports/full-regression.json and suite logs',
);
