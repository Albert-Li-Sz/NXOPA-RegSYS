import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { policySchema } from '../../packages/contracts/src/index.js';
import { checkUserInterfaces } from './ui-regressions.js';
import { registrationProof } from './registration-proof.js';

const root = fileURLToPath(new URL('../../', import.meta.url)),
  exec = promisify(execFile);
const tag = `v${JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version}`;
const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
const sourceDirty = !!(
  await exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })
).stdout.trim();
await mkdir(path.join(root, '.runtime/reports'), { recursive: true });
const screenshotRoot = path.join(
  root,
  process.env.CAPTURE_CONFIGURATION_GUIDE === '1'
    ? 'docs/configuration-screenshots'
    : '.runtime/reports/release-feature-screenshots',
);
await mkdir(screenshotRoot, { recursive: true });
const stage = await mkdtemp(path.join(root, '.runtime/release-features-'));
const project = `nxopa-features-${process.pid}`,
  children: ChildProcess[] = [],
  checks: string[] = [];
let success = false;
async function port() {
  const server = netServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  await new Promise<void>((r) => server.close(() => r()));
  return addr.port;
}
const pgPort = await port(),
  redisPort = await port(),
  apiPort = await port(),
  webPort = await port(),
  mockPort = await port(),
  smtpPort = await port(),
  mailPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`,
  webBase = `http://127.0.0.1:${webPort}`,
  mockBase = `http://127.0.0.1:${mockPort}`;
const secret = randomBytes(24).toString('hex'),
  password = randomBytes(24).toString('base64url');
const env = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: String(apiPort),
  PUBLIC_URL: 'http://old.example.invalid',
  DATABASE_URL: `postgresql://contest:${secret}@127.0.0.1:${pgPort}/contest_center`,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  STORAGE_DIR: path.join(stage, 'files'),
  LATEX_SPOOL: path.join(stage, 'latex'),
  GITHUB_OAUTH_BASE_URL: mockBase,
  GITHUB_API_BASE_URL: mockBase,
  GITHUB_CLIENT_ID: 'mock-client',
  GITHUB_CLIENT_SECRET: secret,
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtpPort),
  SMTP_SECURITY: 'NONE',
  SMTP_FROM: 'release@example.test',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
};
const fixture = path.join(stage, 'compose.json');
const arch = (await exec('docker', ['info', '--format', '{{.Architecture}}'])).stdout.trim();
const pgImage = /arm64|aarch64/.test(arch)
  ? 'sha256:9b9fb55f7e3b2149854def33c728b781dc44d1c5e86492ad62912a527ae234b3'
  : 'sha256:747d5ed1fdeeb124b880fbe3d7c6557d2c4064ae41d6b6297d417882effce4be';
await writeFile(
  fixture,
  JSON.stringify({
    services: {
      postgres: {
        image: `postgres:17.6-alpine@${pgImage}`,
        environment: {
          POSTGRES_USER: 'contest',
          POSTGRES_PASSWORD: secret,
          POSTGRES_DB: 'contest_center',
        },
        ports: [`127.0.0.1:${pgPort}:5432`],
        healthcheck: { test: ['CMD', 'pg_isready', '-U', 'contest'], interval: '2s', retries: 30 },
      },
      redis: {
        image: 'redis:7.4.5-alpine',
        ports: [`127.0.0.1:${redisPort}:6379`],
        healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', retries: 30 },
      },
      mail: {
        image: 'axllent/mailpit:v1.27.8',
        ports: [`127.0.0.1:${smtpPort}:1025`, `127.0.0.1:${mailPort}:8025`],
      },
    },
  }),
  { mode: 0o600 },
);
const compose = (args: string[]) =>
  exec('docker', ['compose', '-p', project, '-f', fixture, ...args], {
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
function started(args: string[], vars: NodeJS.ProcessEnv) {
  const child = spawn('pnpm', args, {
    cwd: root,
    env: vars,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  children.push(child);
  let tail = '';
  child.stdout!.on('data', (b) => (tail = (tail + b).slice(-3000)));
  child.stderr!.on('data', (b) => (tail = (tail + b).slice(-3000)));
  return () => tail;
}
async function wait(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Service did not start: ${url}`);
}
const students = {
  student_id: '20260001',
  class_name: '计算机一班',
  college: '信息工程学院',
  gender: '女',
};
function passed(value: string) {
  checks.push(value);
  console.log(`[新版功能验收] ${value}`);
}
class Actor {
  cookie = '';
  csrf = '';
  user: any;
  async raw(route: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(`${apiBase}/api/v1${route}`, {
      method,
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://proxy.example.test',
        Cookie: this.cookie,
        'X-CSRF-Token': this.csrf,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookies = response.headers.getSetCookie();
    const jar = new Map(
      this.cookie
        .split('; ')
        .filter(Boolean)
        .map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]),
    );
    for (const cookie of cookies) {
      const pair = cookie.split(';')[0]!,
        name = pair.slice(0, pair.indexOf('=')),
        value = pair.slice(pair.indexOf('=') + 1);
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    return response;
  }
  async api(route: string, method = 'GET', body?: unknown) {
    const r = await this.raw(route, method, body);
    const value = await r.json();
    assert.ok(r.ok, `${method} ${route}: ${r.status} ${JSON.stringify(value).slice(0, 200)}`);
    return value;
  }
  async login() {
    const value = await this.api('/auth/login', 'POST', { account: 'feature_admin', password });
    this.user = value.user;
    this.csrf = value.csrf;
    return this;
  }
  async complete() {
    this.user = await this.api('/auth/profile', 'PUT', {
      version: this.user.version,
      name: this.user.name,
      profile: { ...students, student_id: `TEST-${this.user.id}` },
    });
  }
}
const authorizations = new Map<string, { challenge: string; redirectUri: string }>();
let subject = 10001,
  verified = true,
  email = 'github-student@example.test',
  tokenRequests = 0;
const mock = createServer(async (req, res) => {
  const url = new URL(req.url!, mockBase);
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/login/oauth/access_token') {
    tokenRequests++;
    let body = '';
    for await (const b of req) body += b;
    const params = new URLSearchParams(body),
      record = authorizations.get(params.get('code') ?? '');
    if (
      !record ||
      params.get('client_secret') !== secret ||
      params.get('redirect_uri') !== record.redirectUri ||
      createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url') !== record.challenge
    ) {
      res.statusCode = 400;
      res.end('{}');
      return;
    }
    authorizations.delete(params.get('code')!);
    res.end(JSON.stringify({ access_token: 'fixture-access-token' }));
  } else if (url.pathname === '/user')
    res.end(
      JSON.stringify({
        id: subject,
        login: `fixture_${subject}`,
        name: 'GitHub 同学',
        email: null,
      }),
    );
  else if (url.pathname === '/user/emails')
    res.end(JSON.stringify([{ email, verified, primary: true }]));
  else {
    res.statusCode = 404;
    res.end('{}');
  }
});
await new Promise<void>((r) => mock.listen(mockPort, '127.0.0.1', r));
async function oauth(actor: Actor, mode = '') {
  const response = await actor.raw(`/auth/github?next=%2Fcontests${mode ? '&mode=' + mode : ''}`);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('location')!);
  assert.equal(url.searchParams.get('scope'), 'read:user user:email');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const state = url.searchParams.get('state')!,
    code = randomBytes(12).toString('hex');
  authorizations.set(code, {
    challenge: url.searchParams.get('code_challenge')!,
    redirectUri: url.searchParams.get('redirect_uri')!,
  });
  return { state, code, path: `/auth/github/callback?state=${state}&code=${code}` };
}
try {
  await compose(['up', '-d', '--wait']);
  await exec('pnpm', ['db:migrate'], { cwd: root, env, timeout: 60000 });
  await exec('pnpm', ['bootstrap:admin'], {
    cwd: root,
    env: {
      ...env,
      ADMIN_USERNAME: 'feature_admin',
      ADMIN_EMAIL: 'feature-admin@example.test',
      ADMIN_PASSWORD: password,
    },
    timeout: 60000,
  });
  const apiTail = started(['--filter', '@contest-center/server', 'start'], env);
  started(['--filter', '@contest-center/server', 'worker'], env);
  try {
    await wait(`${apiBase}/api/v1/health`);
  } catch {
    throw new Error('Feature API failed to start: ' + apiTail());
  }
  const admin = await new Actor().login();
  assert.equal(admin.user.profileComplete, false);
  const csrfDenied = await admin.raw('/admin/site', 'PUT', {}, { 'X-CSRF-Token': '' });
  assert.equal(csrfDenied.status, 403);
  const oldSite = await admin.api('/site');
  const site = await admin.api('/admin/site', 'PUT', {
    ...oldSite,
    publicUrl: 'http://proxy.example.test:8080',
  });
  assert.equal(site.publicUrl, 'http://proxy.example.test:8080');
  passed('生产模式下域名与 PUBLIC_URL 不同仍能登录，允许 HTTP 公网地址，登录后的 CSRF 令牌仍有效');

  const contest = await admin.api('/contests', 'POST', {
    title: '新版功能验收',
    season: '回归',
    description: '',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 43200000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [],
  });
  const blocked = await admin.raw('/registrations', 'POST', { contestId: contest.id });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).message, /完善.*学号/);
  await admin.complete();
  assert.equal(admin.user.profileComplete, true);
  const earlyDraft = await admin.api('/registrations', 'POST', { contestId: contest.id });
  async function student(index: number) {
    const actor = new Actor();
    const r = await actor.api('/auth/register', 'POST', {
      ...(await registrationProof(
        actor,
        `student-${index}@example.test`,
        undefined,
        `http://127.0.0.1:${mailPort}`,
      )),
      email: `student-${index}@example.test`,
      username: `student_${index}`,
      name: `验收同学${index}`,
      password,
    });
    actor.user = r.user;
    actor.csrf = r.csrf;
    await compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'contest',
      '-d',
      'contest_center',
      '-c',
      `UPDATE "User" SET "verified"=true WHERE "id"='${actor.user.id}'`,
    ]);
    await actor.complete();
    return actor;
  }
  const firstStudent = await student(1);
  const laterDraft = await firstStudent.api('/registrations', 'POST', { contestId: contest.id });
  const first = await firstStudent.api(`/registrations/${laterDraft.id}/submit`, 'POST', {
    version: laterDraft.version,
  });
  const second = await admin.api(`/registrations/${earlyDraft.id}/submit`, 'POST', {
    version: earlyDraft.version,
  });
  assert.equal(first.number, 1);
  assert.equal(second.number, 2);
  const otherStudents: Actor[] = [];
  for (const index of [2, 3, 4, 5]) otherStudents.push(await student(index));
  const drafts = await Promise.all(
    otherStudents.map((actor) => actor.api('/registrations', 'POST', { contestId: contest.id })),
  );
  const submitted = await Promise.all(
    drafts.map((r, i) =>
      otherStudents[i]!.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version }),
    ),
  );
  assert.deepEqual(submitted.map((r) => r.number).sort(), [3, 4, 5, 6]);
  const repeated = await firstStudent.api(`/registrations/${first.id}/submit`, 'POST', {
    version: first.version,
  });
  assert.equal(repeated.number, 1);
  assert.equal(repeated.submittedAt, first.submittedAt);
  const list = await admin.api(`/registrations?contestId=${contest.id}&page=1&pageSize=20`);
  const csv = await admin.raw(`/registrations/export?contestId=${contest.id}`);
  assert.equal(csv.status, 200);
  const csvText = await csv.text();
  assert.match(csvText, /"报名编号","报名ID"/);
  assert.deepEqual(
    csvText
      .trim()
      .split('\r\n')
      .slice(1)
      .map((line) => Number(line.split(',')[0]!.replaceAll('"', ''))),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    list.items.map((r: any) => r.number),
    [1, 2, 3, 4, 5, 6],
  );
  passed(
    '五项资料不完整时禁止报名；按首次提交时间编号，并发编号唯一、重新提交不改变编号或首次时间',
  );

  const tagged = await admin.api(`/admin/users/${admin.user.id}/tags`, 'PUT', {
    version: admin.user.version,
    tags: [' 集训队 ', '集训队', '2026级'],
  });
  assert.deepEqual(tagged.tags, ['集训队', '2026级']);
  const users = await admin.api('/admin/users?tag=集训队&page=1&pageSize=20');
  assert.equal(users.total, 1);
  assert.equal(users.items[0].id, admin.user.id);
  const missingTag = await admin.api('/admin/users?tag=无此标签&page=1&pageSize=20');
  assert.equal(missingTag.total, 0);
  const taggedRegistrations = await admin.api(
    `/registrations?contestId=${contest.id}&tag=集训队&page=1&pageSize=20`,
  );
  assert.equal(taggedRegistrations.total, 1);
  assert.equal((await admin.api(`/contests/${contest.id}/statistics?tag=集训队`)).total, 1);
  assert.equal(
    (await admin.api(`/registrations/summary?contestId=${contest.id}&tag=集训队`)).total,
    1,
  );
  const taggedExport = await admin.raw(`/registrations/export?contestId=${contest.id}&tag=集训队`);
  assert.equal((await taggedExport.text()).trim().split('\r\n').length, 2);
  const stale = await admin.raw(`/admin/users/${admin.user.id}/tags`, 'PUT', {
    version: admin.user.version,
    tags: [],
  });
  assert.equal(stale.status, 409);
  passed('管理员标签规范化、用户及报名筛选正常，旧版本写入被拒绝');

  const github = new Actor();
  const flow = await oauth(github);
  const before = tokenRequests;
  const tampered = await github.raw(
    `/auth/github/callback?state=${'x'.repeat(40)}&code=${flow.code}`,
  );
  assert.match(tampered.headers.get('location')!, /github_error=state/);
  assert.equal(tokenRequests, before);
  // A new authorization is required after the failed state clears the browser cookie.
  const newFlow = await oauth(github);
  const savedCookie = github.cookie;
  const callback = await github.raw(newFlow.path);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/account?next=%2Fcontests');
  const me = await github.api('/auth/me');
  github.user = me.user;
  github.csrf = me.csrf;
  assert.ok(me.user);
  assert.equal(me.user.email, email);
  assert.equal(me.user.verified, true);
  assert.equal(me.user.hasPassword, false);
  assert.equal(me.user.profileComplete, false);
  const replay = await github.raw(newFlow.path, 'GET', undefined, { Cookie: savedCookie });
  assert.match(replay.headers.get('location')!, /github_error=state/);
  assert.equal((await github.raw('/registrations', 'POST', { contestId: contest.id })).status, 400);
  assert.equal(
    (
      await github.raw(`/admin/users/${admin.user.id}/tags`, 'PUT', {
        version: tagged.version,
        tags: ['攻击'],
      })
    ).status,
    403,
  );
  assert.equal((await github.raw('/auth/github', 'DELETE')).status, 400);
  await github.complete();
  assert.equal(github.user.profileComplete, true);
  passed(
    '真实 GitHub 接口模拟完成 PKCE、已验证私有邮箱、无密码会话；篡改及重放 state 被拒绝，新用户仍需完善资料',
  );
  const githubDetail = await admin.api(`/admin/users/${github.user.id}`);
  const githubBan = await admin.api(`/admin/users/${github.user.id}/ban`, 'PUT', {
    version: githubDetail.version,
    banned: true,
    reason: 'GitHub 封禁回归',
  });
  assert.equal((await github.api('/auth/me')).user, null);
  const bannedGithub = new Actor(),
    bannedFlow = await oauth(bannedGithub);
  assert.match(
    (await bannedGithub.raw(bannedFlow.path)).headers.get('location')!,
    /github_error=failed/,
  );
  assert.equal((await bannedGithub.api('/auth/me')).user, null);
  await admin.api(`/admin/users/${github.user.id}/ban`, 'PUT', {
    version: githubBan.version,
    banned: false,
  });
  const restoredGithub = new Actor(),
    restoredFlow = await oauth(restoredGithub);
  await restoredGithub.raw(restoredFlow.path);
  assert.equal((await restoredGithub.api('/auth/me')).user.id, github.user.id);
  passed('封禁账号的 GitHub 会话立即失效，重新授权不能绕过封禁，解除后恢复登录');

  subject++;
  verified = false;
  email = 'unverified@example.test';
  const unverified = new Actor();
  const unverifiedFlow = await oauth(unverified);
  assert.match(
    (await unverified.raw(unverifiedFlow.path)).headers.get('location')!,
    /github_error=email$/,
  );
  verified = true;
  email = 'feature-admin@example.test';
  const collision = new Actor();
  const collisionFlow = await oauth(collision);
  assert.match(
    (await collision.raw(collisionFlow.path)).headers.get('location')!,
    /github_error=email_exists/,
  );
  const linkFlow = await oauth(admin, 'link');
  assert.equal(
    (await admin.raw(linkFlow.path)).headers.get('location'),
    '/account?github_linked=1',
  );
  const relogin = new Actor(),
    reloginFlow = await oauth(relogin);
  await relogin.raw(reloginFlow.path);
  assert.equal((await relogin.api('/auth/me')).user.id, admin.user.id);
  const settings = await admin.api('/admin/github');
  assert.ok(settings.secretConfigured);
  assert.ok(!JSON.stringify(settings).includes(secret));
  const refreshed = await admin.api('/auth/me');
  admin.user = refreshed.user;
  admin.csrf = refreshed.csrf;
  const configured = await admin.api('/admin/github', 'PUT', { ...settings, clientSecret: secret });
  const retained = await admin.api('/admin/github', 'PUT', { ...configured, clientSecret: '' });
  assert.ok(retained.secretConfigured);
  assert.ok(!JSON.stringify(retained).includes(secret));
  assert.equal(
    (await admin.raw('/admin/github', 'PUT', { ...configured, clientSecret: '' })).status,
    409,
  );
  const storedFlow = await oauth(relogin);
  assert.equal((await relogin.raw(storedFlow.path)).headers.get('location'), '/contests');
  passed(
    '未验证邮箱不能登录，同邮箱不自动合并；本站账号主动绑定后可用 GitHub 登录，后台不返回密钥',
  );

  started(
    ['--filter', '@contest-center/web', 'dev', '--host', '127.0.0.1', '--port', String(webPort)],
    { ...env, API_PROXY_TARGET: apiBase, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'nxopa-ui.test' },
  );
  await wait(webBase);
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP nxopa-ui.test 127.0.0.1', '--no-proxy-server'],
    ...(process.platform === 'darwin' ? { executablePath: chrome } : {}),
  });
  try {
    const page = await browser.newPage(),
      errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(webBase + '/login');
    await expect(page.getByRole('button', { name: '使用 GitHub 登录' })).toBeVisible();
    await page
      .locator('.auth-card')
      .screenshot({ path: path.join(screenshotRoot, '24-github-login.png') });
    await page.locator('#account').fill('feature_admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/contests$/);
    await page.goto(webBase + '/admin?tab=users');
    await expect(page.getByRole('button', { name: '编辑标签' }).first()).toBeVisible();
    await expect(page.locator('.el-table').first()).toContainText('集训队');
    await page
      .locator('.card')
      .first()
      .screenshot({ path: path.join(screenshotRoot, '25-user-tags.png') });
    await page.goto(webBase + '/admin?tab=github');
    await expect(page.getByRole('button', { name: '保存 GitHub 设置' })).toBeVisible();
    await page
      .locator('.card')
      .first()
      .screenshot({
        path: path.join(screenshotRoot, '27-github-settings.png'),
      });
    await page.goto(webBase + '/account');
    await expect(page.locator('#profile-name')).toBeDisabled();
    await page.getByRole('tab', { name: '实名认证', exact: true }).click();
    await expect(page.getByLabel('学院', { exact: true })).toBeVisible();
    await expect(page.getByLabel('班级', { exact: true })).toBeVisible();
    await page
      .locator('.el-tab-pane:visible .card')
      .first()
      .screenshot({ path: path.join(screenshotRoot, '26-profile.png') });
    assert.deepEqual(errors, []);
    await admin.api('/auth/forgot', 'POST', { email: admin.user.email });
    const resetMail = await compose([
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
      `SELECT payload->>'actionPath' FROM "OutboxEvent" WHERE "resourceId"='${admin.user.id}' AND type='MAIL' AND payload->>'actionPath' LIKE '/account/reset%' ORDER BY "createdAt" DESC LIMIT 1`,
    ]);
    await checkUserInterfaces(page, webBase, contest.id, second.id, {
      path: resetMail.stdout.trim(),
      password,
    });
    passed('手机、平板和桌面页面布局，长昵称与联系方式编辑、HTTP 表单、密码重置与会话撤销回归通过');
  } finally {
    await browser.close();
  }
  passed('真实浏览器验证 GitHub 入口、登录、管理员标签 / GitHub 设置及五项资料表单，无脚本错误');
  if (process.env.GENERATE_API_SCHEMA === '1') {
    const response = await fetch(`${apiBase}/api/docs-json`);
    assert.equal(response.status, 200);
    await writeFile(
      path.join(root, 'docs/api/openapi.json'),
      JSON.stringify(await response.json(), null, 2) + '\n',
    );
  }
  success = true;
} finally {
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
  }
  await new Promise<void>((r) => mock.close(() => r()));
  await compose(['down', '-v', '--remove-orphans']);
  await writeFile(
    path.join(root, '.runtime/reports/release-features.json'),
    JSON.stringify(
      {
        tag,
        commit,
        sourceDirty,
        platform: process.platform,
        architecture: process.arch,
        success,
        checks,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await rm(stage, { recursive: true, force: true });
}
