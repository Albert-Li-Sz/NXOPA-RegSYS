import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { policySchema } from '../../packages/contracts/src/index.js';
import { verifyGatewayTransport } from './install-gateway.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const targetTag =
  process.env.IMAGE_TAG ??
  `v${JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version}`;
await mkdir(path.join(root, '.runtime'), { recursive: true });
const stage = await mkdtemp(path.join(root, '.runtime/proxy-install-'));
const envFile = path.join(stage, '.env');
const project = `nxopa-proxy-check-${process.pid}`;
const env: NodeJS.ProcessEnv = { ...process.env, INSTALL_ENV_FILE: envFile };
for (const key of [
  'INSTALL_MODE',
  'IMAGE_TAG',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_FILE',
  'PUBLIC_URL',
  'POSTGRES_PASSWORD',
  'ENCRYPTION_KEY',
  'REVERSE_PROXY_MODE',
  'WEB_PORT',
  'API_PORT',
  'GATEWAY_PORT',
  'SITE_ADDRESS',
  'HTTP_PORT',
  'HTTPS_PORT',
])
  delete env[key];
const checks: string[] = [];
let success = false;
async function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return (
    await exec('bash', [path.join(root, 'install.sh'), ...args], {
      cwd: stage,
      env: { ...env, ...overrides },
      timeout: 600000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout;
}
async function uninstall(input: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', [path.join(root, 'install.sh'), 'uninstall'], {
      cwd: stage,
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk) => {
      error += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`uninstall exited ${code}: ${error.slice(-2000)}`)),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function volumes() {
  const { stdout } = await exec('docker', [
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  return stdout.trim().split('\n').filter(Boolean).sort();
}
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function passed(message: string) {
  checks.push(message);
  console.log(`[代理迁移验收] ${message}`);
}

try {
  passed(await verifyGatewayTransport());
  const httpPort = await unusedPort(),
    httpsPort = await unusedPort(),
    webPort = await unusedPort(),
    apiPort = await unusedPort(),
    gatewayPort = await unusedPort();
  env.TEST_PROXY_PORT = String(httpPort);
  await run(['init']);
  const fresh = (await readFile(envFile, 'utf8'))
    .replace(/^COMPOSE_PROJECT_NAME=.*$/m, `COMPOSE_PROJECT_NAME=${project}`)
    .replace(/^INSTALL_MODE=.*$/m, 'INSTALL_MODE=images')
    .replace(/^IMAGE_TAG=.*$/m, `IMAGE_TAG=${targetTag}`)
    .replace(/^PUBLIC_URL=.*$/m, `PUBLIC_URL=http://localhost:${httpPort}`)
    .replace(/^GATEWAY_PORT=.*$/m, `GATEWAY_PORT=127.0.0.1:${gatewayPort}`);
  const legacy =
    fresh.replace(/^(REVERSE_PROXY_MODE|GATEWAY_PORT|WEB_PORT|API_PORT)=.*\n/gm, '') +
    `\nSITE_ADDRESS=:80\nHTTP_PORT=127.0.0.1:${httpPort}\nHTTPS_PORT=127.0.0.1:${httpsPort}\n`;
  await writeFile(envFile, legacy, { mode: 0o600 });
  await run(['up']);
  process.env.TEST_URL = `http://localhost:${httpPort}`;
  const { Client, base } = await import('./client.js');
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  const credentials = {
    ADMIN_USERNAME: 'proxy_admin',
    ADMIN_EMAIL: 'proxy@example.test',
    ADMIN_PASSWORD: randomBytes(24).toString('base64url'),
  };
  await run(['admin'], credentials);
  const admin = await new Client().login(credentials.ADMIN_USERNAME, credentials.ADMIN_PASSWORD);
  await admin.completeProfile();
  const reviewerCredentials = {
    ADMIN_USERNAME: 'proxy_reviewer',
    ADMIN_EMAIL: 'proxy-reviewer@example.test',
    ADMIN_PASSWORD: randomBytes(24).toString('base64url'),
  };
  await run(['admin'], reviewerCredentials);
  const identityReviewer = await new Client().login(
    reviewerCredentials.ADMIN_USERNAME,
    reviewerCredentials.ADMIN_PASSWORD,
  );
  await admin.ensureIdentity(identityReviewer);
  const contest = await admin.api('/contests', 'POST', {
    title: '代理切换验收',
    season: '安装验收',
    description: '已有 Caddy 到自配代理的完整安装生命周期',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [],
  });
  let registration = await admin.api('/registrations', 'POST', { contestId: contest.id });
  registration = await admin.api(`/registrations/${registration.id}/submit`, 'POST', {
    version: registration.version,
  });
  const attachment = await admin.upload(registration.id);
  const attachmentContents = await (await admin.raw(`/api/v1/files/${attachment.id}`)).text();
  assert.match(attachmentContents, /^offline payment proof [0-9a-f-]{36}$/);
  assert.equal(
    (
      await run([
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'contest',
        '-d',
        'contest_center',
        '-At',
        '-c',
        `SELECT "storageBackend" FROM "Attachment" WHERE id='${attachment.id}'`,
      ])
    ).trim(),
    'S3',
  );
  const originalVolumes = await volumes();
  assert.deepEqual(
    originalVolumes,
    [
      'caddy_config',
      'caddy_data',
      'files',
      'latex_jobs',
      'minio_data',
      'postgres_data',
      'redis_data',
    ]
      .map((name) => `${project}_${name}`)
      .sort(),
  );
  await run(['backup', path.join(stage, 'backups')]);
  assert.ok((await readdir(path.join(stage, 'backups'))).some((name) => name.endsWith('.ccbak')));
  assert.equal(await readFile(envFile, 'utf8'), legacy);
  passed('旧代理配置保留官方 Caddy 入口及七个卷，MinIO 附件、管理员登录与加密备份正常');

  const external =
    fresh.replace('REVERSE_PROXY_MODE=gateway', 'REVERSE_PROXY_MODE=external') +
    `\nWEB_PORT=127.0.0.1:${webPort}\nAPI_PORT=127.0.0.1:${apiPort}\n`;
  await writeFile(envFile, external, { mode: 0o600 });
  await run(['up']);
  await run([
    'compose',
    '-f',
    path.join(root, 'tests/fixtures/install-proxy.yaml'),
    'up',
    '-d',
    '--no-deps',
    '--wait',
    'acceptance-proxy',
  ]);
  const services = await run(['compose', 'ps', '--services']);
  assert.ok(!services.split('\n').includes('caddy'));
  assert.equal((await admin.api(`/registrations/${registration.id}`)).eligible, true);
  assert.equal(
    await (await admin.raw(`/api/v1/files/${attachment.id}`)).text(),
    attachmentContents,
  );
  assert.deepEqual(await volumes(), originalVolumes);
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  await run(['backup', path.join(stage, 'backups')]);
  await writeFile(envFile, fresh, { mode: 0o600 });
  await run(['up']);
  await run([
    'compose',
    '-f',
    path.join(root, 'tests/fixtures/install-gateway-proxy.yaml'),
    'up',
    '-d',
    '--no-deps',
    '--wait',
    'acceptance-proxy',
  ]);
  assert.ok((await run(['compose', 'ps', '--services'])).split('\n').includes('caddy'));
  assert.equal((await admin.api(`/registrations/${registration.id}`)).eligible, true);
  assert.equal(
    await (await admin.raw(`/api/v1/files/${attachment.id}`)).text(),
    attachmentContents,
  );
  assert.deepEqual(await volumes(), originalVolumes);
  passed(
    '旧 Caddy → 双上游 external → 内部 Caddy gateway，外部 Nginx 单入口保留会话、报名、附件及原卷',
  );

  await uninstall('\ny\nn\n');
  assert.deepEqual(await volumes(), originalVolumes);
  passed('默认卸载继续保留业务卷和旧 Caddy 证书卷');
  await uninstall(`2\nDELETE ${project}\nn\n`);
  assert.deepEqual(await volumes(), []);
  assert.equal(await readFile(envFile, 'utf8'), fresh);
  assert.ok((await readdir(path.join(stage, 'backups'))).some((name) => name.endsWith('.ccbak')));
  passed('永久卸载仅清理当前项目全部七个卷；配置与备份保留');
  success = true;
} finally {
  await run(['compose', 'down', '-v', '--remove-orphans']).catch(() => {});
  const remaining = await volumes();
  if (remaining.length) await exec('docker', ['volume', 'rm', ...remaining]);
  await mkdir(path.join(root, '.runtime/reports'), { recursive: true });
  await writeFile(
    path.join(root, '.runtime/reports/install-proxy.json'),
    JSON.stringify(
      {
        success,
        targetTag,
        platform: process.platform,
        architecture: process.arch,
        checkedAt: new Date().toISOString(),
        checks,
      },
      null,
      2,
    ),
  );
  await rm(stage, { recursive: true, force: true });
}
