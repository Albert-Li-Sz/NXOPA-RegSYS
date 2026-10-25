import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { policySchema } from '../../packages/contracts/src/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const defaultTag = `v${JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version}`;
await mkdir(path.join(root, '.runtime/reports'), { recursive: true });
const stage = await mkdtemp(path.join(root, '.runtime/interactive-install-'));
const envFile = path.join(stage, '.env');
const project = `nxopa-interactive-check-${process.pid}`;
const backupDir = path.join(stage, 'backups');
const env: NodeJS.ProcessEnv = { ...process.env, INSTALL_ENV_FILE: envFile };
for (const key of [
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_FILE',
  'COMPOSE_ENV_FILES',
  'INSTALL_MODE',
  'IMAGE_TAG',
  'PUBLIC_URL',
  'POSTGRES_PASSWORD',
  'ENCRYPTION_KEY',
  'WEB_PORT',
  'API_PORT',
  'GATEWAY_PORT',
  'REVERSE_PROXY_MODE',
])
  delete env[key];
const initialTag =
  process.env.INTERACTIVE_INSTALL_FROM ?? process.env.INSTALL_UPGRADE_FROM ?? 'v0.10.0';
const targetTag = process.env.INTERACTIVE_INSTALL_TO ?? process.env.IMAGE_TAG ?? defaultTag;
const checks: string[] = [];
let success = false;

async function run(entry: string, input = '', args: string[] = []) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'bash',
      [
        path.join(root, 'install.sh'),
        ...(entry === 'update.sh'
          ? ['update', ...args]
          : entry === 'uninstall.sh'
            ? ['uninstall', ...args]
            : args.length
              ? args
              : ['install']),
      ],
      {
        cwd: stage,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 900000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${entry} exited ${code}: ${output.slice(-4000)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const exec = promisify(execFile);
async function volumes() {
  const { stdout } = await exec(
    'docker',
    ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
    { env },
  );
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
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}
function passed(message: string) {
  checks.push(message);
  console.log(`[交互安装验收] ${message}`);
}

async function startProxy() {
  await run('install.sh', '', [
    'compose',
    '-f',
    path.join(root, 'tests/fixtures/install-gateway-proxy.yaml'),
    'up',
    '-d',
    '--no-deps',
    '--wait',
    'acceptance-proxy',
  ]);
}

try {
  const httpPort = await unusedPort(),
    gatewayPort = await unusedPort();
  env.TEST_PROXY_PORT = String(httpPort);
  const password = randomBytes(24).toString('base64url');
  console.log(`[交互安装验收] 从空数据卷交互安装 ${initialTag}……`);
  const output = await run(
    'install.sh',
    `${project}\n\n1\n${initialTag}\n3\n${gatewayPort}\nhttp://localhost:${httpPort}\ny\ny\ninteractive_admin\ninteractive@example.test\n${password}\n${password}\n`,
  );
  assert.ok(!output.includes(password));
  await writeFile(path.join(stage, 'install.log'), output, { mode: 0o600 });
  const originalConfig = await readFile(envFile, 'utf8');
  assert.match(originalConfig, /^POSTGRES_PASSWORD=[a-f0-9]{48}$/m);
  assert.match(originalConfig, /^ENCRYPTION_KEY=[a-f0-9]{64}$/m);
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  assert.ok(!originalConfig.includes(password));
  assert.match(originalConfig, /^REVERSE_PROXY_MODE=gateway$/m);
  const services = await run('install.sh', '', ['compose', 'config', '--services']);
  assert.ok(services.split('\n').includes('caddy'));
  await startProxy();
  process.env.TEST_URL = `http://localhost:${httpPort}`;
  const { Client, base } = await import('./client.js');
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  const admin = await new Client().login('interactive_admin', password);
  assert.equal(admin.user.isAdmin, true);
  const version = async () =>
    (
      await run('install.sh', '', [
        'compose',
        'exec',
        '-T',
        'api',
        'node',
        '-p',
        "require('/app/package.json').version",
      ])
    ).trim();
  assert.equal(await version(), initialTag.slice(1));
  const originalVolumes = await volumes();
  assert.equal(originalVolumes.length, 6);
  passed('默认内部 Caddy 的空卷交互安装、隐藏密码创建管理员，经外部 Nginx 实际登录');

  // Initialize identity fields together; later changes correctly require review.
  admin.user = await admin.api('/auth/profile', 'PUT', {
    version: admin.user.version,
    name: admin.user.name,
    profile: {
      ...admin.user.profile,
      student_id: '0020260001',
      class_name: '验收一班',
      college: '验收学院',
      gender: '男',
      school: '验收大学',
      phone: '00000000000',
    },
  });
  const contest = await admin.api('/contests', 'POST', {
    title: '交互安装脚本真实验收',
    season: '安装验收',
    description: '升级与卸载数据保留',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [],
  });
  let registration = await admin.api('/registrations', 'POST', { contestId: contest.id });
  registration = await admin.api(`/registrations/${registration.id}`, 'PUT', {
    ...registration,
    organization: { name: '验收大学', shortName: 'TEST', country: 'CHN', icpcId: '' },
  });
  registration = await admin.api(`/registrations/${registration.id}/submit`, 'POST', {
    version: registration.version,
  });
  const attachment = await admin.upload(registration.id);
  const attachmentContents = await (await admin.raw(`/api/v1/files/${attachment.id}`)).text();
  assert.match(attachmentContents, /^offline payment proof [0-9a-f-]{36}$/);
  assert.equal(registration.eligible, true);

  async function competitionCredentials(platform: 'HYDRO' | 'DOMJUDGE') {
    const response = await admin.raw(`/api/v1/contests/${contest.id}/platform-exports`, 'POST', {
      platform,
    });
    assert.equal(response.status, 201);
    const zip = path.join(stage, `${platform}.zip`);
    await writeFile(zip, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    const { stdout } = await exec('unzip', [
      '-p',
      zip,
      platform === 'HYDRO' ? 'teams.json' : 'accounts.json',
    ]);
    const rows = JSON.parse(stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, registration.id);
    const username = platform === 'HYDRO' ? rows[0].name : rows[0].username;
    assert.equal(username, '0020260001');
    assert.ok(typeof rows[0].password === 'string' && rows[0].password.length >= 12);
    if (platform === 'DOMJUDGE') assert.equal(rows[0].team_id, registration.id);
    return JSON.stringify({ username, password: rows[0].password });
  }
  const originalCredential = await competitionCredentials('HYDRO');
  assert.ok(
    (await competitionCredentials('DOMJUDGE')) === originalCredential,
    'The previous release shares one competition credential across platforms',
  );

  console.log(`[交互安装验收] 交互升级至 ${targetTag}……`);
  const updateOutput = await run('update.sh', `${targetTag}\n${backupDir}\ny\n`);
  await startProxy();
  await writeFile(path.join(stage, 'update.log'), updateOutput, { mode: 0o600 });
  const updatedConfig = await readFile(envFile, 'utf8');
  assert.ok(
    updatedConfig === originalConfig.replace(`IMAGE_TAG=${initialTag}`, `IMAGE_TAG=${targetTag}`),
  );
  assert.equal(await version(), targetTag.slice(1));
  assert.equal((await admin.api(`/registrations/${registration.id}`)).eligible, true);
  assert.equal(
    await (await admin.raw(`/api/v1/files/${attachment.id}`)).text(),
    attachmentContents,
  );
  assert.deepEqual(await volumes(), originalVolumes);
  for (const platform of ['HYDRO', 'DOMJUDGE'] as const)
    assert.ok(
      (await competitionCredentials(platform)) === originalCredential,
      'Upgrading preserves the student ID and encrypted competition password',
    );
  const backups = (await readdir(backupDir)).filter((name) => name.endsWith('.ccbak'));
  assert.ok(backups.length > 0);
  for (const name of backups)
    assert.equal((await stat(path.join(backupDir, name))).mode & 0o777, 0o600);
  passed(
    `${initialTag} 升级至 ${targetTag} 前实际加密备份；旧会话、报名、附件、共享比赛凭据、原密钥和数据卷保留`,
  );

  await run('uninstall.sh', '\ny\nn\n');
  assert.deepEqual(await volumes(), originalVolumes);
  const down = await run('install.sh', '', ['compose', 'ps', '-a', '-q']);
  assert.equal(down.trim(), '');
  assert.ok((await readFile(envFile, 'utf8')) === updatedConfig);
  await run('install.sh', 'y\nn\n');
  await startProxy();
  assert.equal((await admin.api(`/registrations/${registration.id}`)).eligible, true);
  assert.equal(
    await (await admin.raw(`/api/v1/files/${attachment.id}`)).text(),
    attachmentContents,
  );
  assert.ok(
    (await competitionCredentials('HYDRO')) === originalCredential,
    'Reinstalling with preserved volumes retains competition credentials',
  );
  passed('默认卸载移除容器并保留六个卷；再次交互安装恢复原管理员会话、报名和附件');

  await run('uninstall.sh', `2\nDELETE ${project}\nn\n`);
  assert.equal((await volumes()).length, 0);
  assert.ok((await readFile(envFile, 'utf8')) === updatedConfig);
  assert.ok((await readdir(backupDir)).some((name) => name.endsWith('.ccbak')));
  passed('明确输入项目名后永久卸载当前项目六个数据卷，原配置和加密备份保留');
  success = true;
} finally {
  try {
    await run('install.sh', '', ['compose', 'down', '--volumes', '--remove-orphans']);
  } catch {
    /* The env file can be absent if prerequisites or input validation failed. */
  }
  await writeFile(
    path.join(root, '.runtime/reports/install-interactive.json'),
    JSON.stringify(
      {
        success,
        checkedAt: new Date().toISOString(),
        initialTag,
        targetTag,
        platform: process.platform,
        architecture: process.arch,
        checks,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await rm(stage, { recursive: true, force: true });
}
