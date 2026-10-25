import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { policySchema } from '../../packages/contracts/src/index.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const defaultTag = `v${JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version}`;
await mkdir(path.join(root, '.runtime/reports'), { recursive: true });
const stage = await mkdtemp(path.join(root, '.runtime/install-check-'));
const envFile = path.join(stage, '.env');
const project = `nxopa-install-check-${process.pid}`;
const script = path.join(root, 'install.sh');
const checks: string[] = [];
const installMode = process.env.INSTALL_TEST_MODE ?? 'source';
assert.ok(['source', 'images'].includes(installMode), 'INSTALL_TEST_MODE is source or images');
const env: NodeJS.ProcessEnv = { ...process.env, INSTALL_ENV_FILE: envFile };
for (const key of [
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_FILE',
  'COMPOSE_ENV_FILES',
  'POSTGRES_PASSWORD',
  'ENCRYPTION_KEY',
  'PUBLIC_URL',
  'SITE_ADDRESS',
  'HTTP_PORT',
  'HTTPS_PORT',
  'WEB_PORT',
  'API_PORT',
  'GATEWAY_PORT',
  'REVERSE_PROXY_MODE',
  'INSTALL_MODE',
])
  delete env[key];
env.INSTALL_MODE = installMode;
const run = async (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
  const result = await exec('bash', [script, ...args], {
    cwd: stage,
    env: { ...env, ...overrides },
    timeout: 900000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (['up', 'update'].includes(args[0])) {
    await exec(
      'bash',
      [
        script,
        'compose',
        '-f',
        path.join(root, 'tests/fixtures/install-gateway-proxy.yaml'),
        'up',
        '-d',
        '--no-deps',
        '--wait',
        'acceptance-proxy',
      ],
      {
        cwd: stage,
        env: { ...env, ...overrides },
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
    );
  }
  return result.stdout;
};
function passed(message: string) {
  checks.push(message);
  console.log(`[安装验收] ${message}`);
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
const restoredEnvFile = path.join(root, '.runtime/restored-environment.env');
const previousRestoredEnv = existsSync(restoredEnvFile) ? await readFile(restoredEnvFile) : null;
let started = false;
let success = false;
let httpPort = 0;
try {
  await run(['init']);
  let source = await readFile(envFile, 'utf8');
  assert.ok(/^POSTGRES_PASSWORD=[a-f0-9]{48}$/m.test(source), 'Random database password');
  assert.ok(/^ENCRYPTION_KEY=[a-f0-9]{64}$/m.test(source), 'Random encryption key');
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  httpPort = await unusedPort();
  const gatewayPort = await unusedPort();
  env.TEST_PROXY_PORT = String(httpPort);
  source = source
    .replace(/^COMPOSE_PROJECT_NAME=.+$/m, `COMPOSE_PROJECT_NAME=${project}`)
    .replace(/^PUBLIC_URL=.+$/m, `PUBLIC_URL=http://localhost:${httpPort}`)
    .replace(/^GATEWAY_PORT=.+$/m, `GATEWAY_PORT=127.0.0.1:${gatewayPort}`)
    .replace(/^INSTALL_MODE=.+$/m, `INSTALL_MODE=${installMode}`)
    .replace(
      /^IMAGE_PREFIX=.+$/m,
      `IMAGE_PREFIX=${env.IMAGE_PREFIX ?? 'ghcr.io/albert-li-sz/nxopa-regsys'}`,
    )
    .replace(/^IMAGE_TAG=.+$/m, `IMAGE_TAG=${env.IMAGE_TAG ?? defaultTag}`);
  await writeFile(envFile, source, { mode: 0o600 });
  await run(['init']);
  assert.ok((await readFile(envFile, 'utf8')) === source, 'Repeat init preserves secrets and URL');
  passed('从任意目录生成权限 600 的随机配置，重复初始化保留原密钥和地址');

  await run(['config']);
  const model = JSON.parse(await run(['compose', 'config', '--format', 'json']));
  assert.equal(model.name, project);
  assert.equal(model.services.api.environment.NODE_ENV, 'production');
  assert.ok(model.services.api.environment.DATABASE_URL.includes('@postgres:5432/contest_center'));
  assert.equal(model.services.api.environment.REDIS_URL, 'redis://redis:6379');
  assert.ok(model.services.api.environment.ENCRYPTION_KEY.length === 64);
  if (installMode === 'source')
    assert.equal(model.services.api.build.context, root.replace(/\/$/, ''));
  else {
    for (const service of ['initialize', 'api', 'worker', 'web', 'latex', 'minio']) {
      assert.ok(!model.services[service].build, `${service} does not build in image mode`);
      assert.ok(model.services[service].image.startsWith('ghcr.io/'));
      assert.ok(!model.services[service].image.includes('@'), `${service} uses a version tag`);
      assert.ok(model.services[service].image.endsWith(`:${env.IMAGE_TAG ?? defaultTag}`));
    }
  }
  assert.ok(model.services.minio);
  assert.equal(model.services.minio.ports[0].host_ip, '127.0.0.1');
  assert.equal(model.services.minio.ports[0].target, 9001);
  assert.equal(model.services.api.environment.STORAGE_MODE, 'MINIO');
  assert.equal(model.services.latex.network_mode, 'none');
  assert.equal(model.services.latex.read_only, true);
  for (const service of ['postgres', 'redis', 'worker', 'latex', 'api', 'web'])
    assert.ok(!model.services[service].ports, `${service} has no public port`);
  assert.equal(model.services.caddy.ports.length, 1);
  assert.equal(model.services.caddy.ports[0].host_ip, '127.0.0.1');
  assert.equal(model.services.caddy.ports[0].published, String(gatewayPort));
  assert.equal(model.services.caddy.ports[0].target, 80);
  assert.ok(!model.services.caddy.environment?.SITE_ADDRESS);
  assert.ok(!Object.keys(model.services.caddy.networks).includes('data'));
  assert.deepEqual(Object.keys(model.volumes).sort(), [
    'caddy_config',
    'caddy_data',
    'files',
    'latex_jobs',
    'minio_data',
    'postgres_data',
    'redis_data',
  ]);
  passed('默认内部 Caddy 仅发布本机 HTTP 单端口；前端、API、数据库与队列不映射端口');

  const officialImages = {
    postgres: 'postgres:17.6-alpine',
    redis: 'redis:7.4.5-alpine',
    caddy: 'caddy:2.10.2-alpine',
  };
  for (const [service, image] of Object.entries(officialImages)) {
    assert.equal(model.services[service].image, image);
    assert.ok(!model.services[service].build, `${service} uses the official image directly`);
  }
  if (installMode === 'source') {
    assert.equal(model.services.worker.build.target, 'worker');
    assert.equal(model.services.web.build.target, 'web');
  }
  assert.equal(model.services.web.read_only, true);
  assert.ok(!model.services.web.environment?.DATABASE_URL);
  assert.ok(!model.services.web.environment?.ENCRYPTION_KEY);
  assert.deepEqual(Object.keys(model.services.web.networks), ['edge']);
  assert.deepEqual(Object.keys(model.services.postgres.networks), ['data']);
  assert.equal(model.networks.data.internal, true);
  passed('官方基础服务使用固定版本标签；前端无后端凭据，服务与数据库网络隔离');

  const httpsModel = JSON.parse(
    await run(['compose', 'config', '--format', 'json'], {
      PUBLIC_URL: 'https://reg.example.org',
      GATEWAY_PORT: '127.0.0.1:8080',
    }),
  );
  assert.equal(httpsModel.services.api.environment.PUBLIC_URL, 'https://reg.example.org');
  assert.equal(httpsModel.services.caddy.ports[0].published, '8080');
  const externalModel = JSON.parse(
    await run(['compose', 'config', '--format', 'json'], {
      REVERSE_PROXY_MODE: 'external',
      WEB_PORT: '127.0.0.1:8081',
      API_PORT: '127.0.0.1:3000',
    }),
  );
  assert.ok(!externalModel.services.caddy);
  for (const service of ['api', 'web'])
    assert.ok(externalModel.services[service].ports.every((p: any) => p.host_ip === '127.0.0.1'));
  const legacyModel = JSON.parse(
    await run(['compose', 'config', '--format', 'json'], {
      REVERSE_PROXY_MODE: 'caddy',
      SITE_ADDRESS: 'reg.example.org',
      HTTP_PORT: '127.0.0.1:8080',
      HTTPS_PORT: '127.0.0.1:8443',
    }),
  );
  assert.equal(legacyModel.services.caddy.image, officialImages.caddy);
  assert.equal(legacyModel.services.caddy.environment.SITE_ADDRESS, 'reg.example.org');
  assert.ok(!legacyModel.services.api.ports && !legacyModel.services.web.ports);
  passed('公网 HTTPS 地址与已有反向代理的本机端口绑定正确解析');

  const imageModel = JSON.parse(
    await run(['compose', 'config', '--format', 'json'], { INSTALL_MODE: 'images' }),
  );
  for (const service of ['initialize', 'api', 'worker', 'web', 'latex', 'minio'])
    assert.ok(!imageModel.services[service].build);
  assert.equal(imageModel.services.initialize.image, imageModel.services.api.image);
  assert.equal(imageModel.services.api.volumes[0].source, model.services.api.volumes[0].source);
  console.log(
    `[安装验收] ${installMode === 'images' ? '拉取发布镜像' : '构建镜像'}并启动独立 Compose 实例……`,
  );
  started = true;
  await writeFile(path.join(stage, 'build.log'), await run(['up']), { mode: 0o600 });
  process.env.TEST_URL = `http://localhost:${httpPort}`;
  const { Client, until, base } = await import('./client.js');
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  const services = (await run(['compose', 'ps', '--format', 'json']))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const name of [
    'postgres',
    'redis',
    'api',
    'worker',
    'web',
    'caddy',
    'minio',
    'acceptance-proxy',
  ])
    assert.equal(services.find((s) => s.Service === name).Health, 'healthy');
  for (const [service, image] of Object.entries(officialImages)) {
    const containerId = (await run(['compose', 'ps', '-q', service])).trim();
    const { stdout } = await exec(
      'docker',
      ['inspect', '--format', '{{.Config.Image}}', containerId],
      { env },
    );
    assert.equal(stdout.trim(), image, `${service} runs the official image`);
  }
  const homepage = await fetch(base);
  assert.equal(homepage.status, 200);
  assert.ok(homepage.headers.get('content-security-policy')?.includes("object-src 'none'"));
  assert.ok(homepage.headers.get('strict-transport-security')?.includes('max-age='));
  assert.equal((await fetch(`${base}/api/docs-json`)).status, 404);
  const html = await homepage.text();
  assert.ok(html.includes('南晓开放原子社在线报名系统'));
  passed(
    `从空数据卷${installMode === 'images' ? '拉取发布镜像' : '构建镜像'}并启动，迁移成功；官方基础容器、官网、API 和 Worker 健康`,
  );

  const route = await fetch(`${base}/contests`);
  assert.equal(route.status, 200);
  assert.ok(route.headers.get('content-type')?.includes('text/html'));
  const assetUrl = html.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
  assert.ok(assetUrl, 'Production entry asset exists');
  const asset = await fetch(`${base}${assetUrl}`);
  assert.equal(asset.status, 200);
  assert.ok(asset.headers.get('content-type')?.includes('text/javascript'));
  assert.ok(asset.headers.get('cache-control')?.includes('immutable'));
  assert.ok((await asset.text()).length > 100);
  const head = await fetch(`${base}${assetUrl}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.ok([400, 404].includes((await fetch(`${base}/%2e%2e%2fpackage.json`)).status));
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  passed(
    '外部 Nginx 经内部 Caddy 统一代理前端与 API，历史路由、MIME / 缓存和 HEAD 正常，私有路径与缺失文件拒绝访问',
  );

  const credentials = {
    ADMIN_EMAIL: 'install-check@example.test',
    ADMIN_PASSWORD: randomBytes(24).toString('base64url'),
    ADMIN_USERNAME: 'install_admin',
  };
  await run(['admin'], credentials);
  const admin = await new Client().login(credentials.ADMIN_EMAIL, credentials.ADMIN_PASSWORD);
  assert.equal(admin.user.isAdmin, true);
  assert.equal((await admin.api('/admin/mail')).enabled, false);
  assert.equal(
    (
      await admin.raw('/api/v1/auth/login', 'POST', {
        account: 'admin',
        password: 'DemoContest2026!',
      })
    ).status,
    401,
  );
  passed('安装入口初始化管理员并登录；正式数据库无演示账号，邮件默认停用');

  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await expect(page.getByRole('heading', { name: /南晓开放原子社/ })).toBeVisible();
    await page.locator('.hero-actions').getByRole('link', { name: '进入报名系统' }).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === '/login' && url.searchParams.get('next') === '/contests',
    );
    await page.locator('#account').fill(credentials.ADMIN_EMAIL);
    await page.locator('#password').fill(credentials.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/contests$/);
    await expect(page.getByRole('heading', { name: '比赛列表' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '比赛列表' })).toBeVisible();
    await expect(page.locator('.user-menu')).toBeVisible();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
  passed('生产浏览器通过 Nginx → Caddy 完成首页进入、登录及刷新，会话保持且无脚本错误');

  await admin.completeProfile();
  const contest = await admin.api('/contests', 'POST', {
    title: '独立安装验收竞赛',
    modules: { admissions: true, rooms: false, integrations: false },
    season: '安装验收',
    description: '正式 Docker Compose 空库部署',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 10000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [],
  });
  let registration = await admin.api('/registrations', 'POST', { contestId: contest.id });
  registration = await admin.api(`/registrations/${registration.id}/submit`, 'POST', {
    version: registration.version,
  });
  assert.equal(registration.eligible, true);
  const attachment = await admin.upload(registration.id);
  const attachmentContents = await (await admin.raw(`/api/v1/files/${attachment.id}`)).text();
  assert.match(attachmentContents, /^offline payment proof [0-9a-f-]{36}$/);
  assert.equal((await fetch(`${base}/api/v1/files/${attachment.id}`)).status, 401);
  const generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [registration.id],
    room: '安装验收考场',
    seat: '1',
  });
  const documentId = generated.results[0].documentId;
  await until(
    () => admin.api(`/registrations/${registration.id}`),
    (r) => r.admissions.some((d: any) => d.id === documentId && d.state === 'READY'),
    120000,
  );
  await admin.api(`/admissions/${documentId}/release`, 'POST');
  const pdf = await admin.raw(`/api/v1/admissions/${documentId}/download`);
  assert.equal(pdf.status, 200);
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  passed('真实报名、私有附件、Redis 队列与 Worker / XeLaTeX 生成中文准考证');

  const upload = new FormData();
  upload.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'CSP预览验收.pdf');
  await admin.api('/files?purpose=PERSONAL', 'POST', upload);
  const pdfBrowser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  try {
    const page = await pdfBrowser.newPage();
    const violations: string[] = [];
    await page.addInitScript(() => {
      window.addEventListener('securitypolicyviolation', (event) =>
        console.error(`CSP-violation:${event.violatedDirective}:${event.blockedURI}`),
      );
    });
    page.on('console', (message) => {
      if (message.text().startsWith('CSP-violation:')) violations.push(message.text());
    });
    await page.goto(`${base}/login`);
    await page.locator('#account').fill(credentials.ADMIN_EMAIL);
    await page.locator('#password').fill(credentials.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.user-menu')).toBeVisible();
    await page.goto(`${base}/me/files`);
    await page.getByRole('link', { name: 'CSP预览验收.pdf', exact: true }).click();
    await expect(page.getByRole('img', { name: 'PDF 第 1 页', exact: true })).toHaveAttribute(
      'data-rendered',
      'true',
      { timeout: 20000 },
    );
    assert.deepEqual(violations, []);
  } finally {
    await pdfBrowser.close();
  }
  passed('生产 CSP 下 PDF.js 的 worker、WASM 及中文 PDF 实际渲染通过，无策略违规');

  await run(['compose', 'restart', 'postgres', 'redis', 'api', 'worker']);
  const healthy = async () => {
    try {
      return (await fetch(`${base}/api/v1/health`)).ok;
    } catch {
      return false;
    }
  };
  await until(healthy, (v) => v, 90000);
  assert.equal((await admin.api(`/registrations/${registration.id}`)).eligible, true);
  assert.equal((await admin.raw(`/api/v1/files/${attachment.id}`)).status, 200);
  passed('重启数据库、Redis、API 和 Worker 后保留管理员会话、报名及附件');

  const backups = path.join(stage, 'backups');
  await run(['backup', backups]);
  const backup = (await readdir(backups)).find((file) => file.endsWith('.ccbak'));
  assert.ok(backup);
  assert.equal((await stat(path.join(backups, backup))).mode & 0o777, 0o600);
  const before = await until(healthy, (v) => v, 90000).then(() =>
    admin.api(`/registrations/${registration.id}`),
  );
  await admin.api(`/registrations/${registration.id}/cancel`, 'POST', { version: before.version });
  await run(['restore', path.join(backups, backup), '--yes']);
  await until(healthy, (v) => v, 90000);
  const restored = await admin.api(`/registrations/${registration.id}`);
  assert.equal(restored.version, before.version);
  assert.equal(restored.eligible, true);
  assert.equal(
    await (await admin.raw(`/api/v1/files/${attachment.id}`)).text(),
    attachmentContents,
  );
  assert.ok(
    (await readFile(restoredEnvFile, 'utf8')) === source,
    'Backup stores install environment',
  );
  passed('安装入口加密备份与恢复使用正确实例、密钥和环境文件，报名与附件恢复');

  await run(['restore-url', 'https://reg.example.test']);
  assert.equal((await admin.api('/site')).publicUrl, 'https://reg.example.test');
  assert.equal((await admin.api('/auth/me')).user, null);
  await admin.login(credentials.ADMIN_EMAIL, credentials.ADMIN_PASSWORD);
  const site = await admin.api('/site');
  const saved = await fetch(`${base}/api/v1/admin/site`, {
    method: 'PUT',
    headers: {
      Cookie: admin.cookie,
      Origin: base,
      'Content-Type': 'application/json',
      'X-CSRF-Token': admin.csrf,
    },
    body: JSON.stringify({ ...site, name: '安装验收站点' }),
  });
  assert.equal(saved.status, 200);
  passed('公网地址恢复命令生效，HTTPS Cookie 切换后重新登录可继续管理');
  if (
    process.env.INSTALL_UPGRADE_FROM &&
    process.env.INSTALL_UPGRADE_FROM !== (env.IMAGE_TAG ?? defaultTag)
  ) {
    const { verifyInstallationUpgrade } = await import('./installation-upgrade.js');
    await verifyInstallationUpgrade(
      run,
      envFile,
      source,
      process.env.INSTALL_UPGRADE_FROM,
      env.IMAGE_TAG ?? defaultTag,
      passed,
    );
  }
  success = true;
  console.log(`独立安装验收通过：${checks.length} 项。`);
} finally {
  if (started) await run(['compose', 'down', '-v', '--remove-orphans']);
  if (previousRestoredEnv) {
    await writeFile(restoredEnvFile, previousRestoredEnv, { mode: 0o600 });
    await chmod(restoredEnvFile, 0o600);
  } else {
    await rm(restoredEnvFile, { force: true });
  }
  await writeFile(
    path.join(root, '.runtime/reports/install.json'),
    JSON.stringify(
      {
        success,
        installMode,
        imageTag: env.IMAGE_TAG ?? null,
        upgradeFrom: process.env.INSTALL_UPGRADE_FROM ?? null,
        platform: process.platform,
        architecture: process.arch,
        checkedAt: new Date().toISOString(),
        checks,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await rm(stage, { recursive: true, force: true });
}
