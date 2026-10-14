import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { policySchema } from '../../packages/contracts/src/index.js';
import { registrationProof } from './registration-proof.js';
const root = fileURLToPath(new URL('../../', import.meta.url)),
  exec = promisify(execFile),
  checks: string[] = [],
  children: ChildProcess[] = [];
await mkdir(path.join(root, '.runtime/reports'), { recursive: true });
const stage = await mkdtemp(path.join(root, '.runtime/platform-features-')),
  project = `nxopa-platform-${process.pid}`;
async function port() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}
const [pg, redis, apiPort, webPort, s3Port, smtpPort, mailPort] = await Promise.all(
  Array.from({ length: 7 }, port),
);
const apiBase = `http://127.0.0.1:${apiPort}`,
  webBase = `http://127.0.0.1:${webPort}`,
  mailBase = `http://127.0.0.1:${mailPort}`,
  password = randomBytes(20).toString('base64url'),
  secret = randomBytes(24).toString('hex');
const env = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: String(apiPort),
  PUBLIC_URL: 'https://links.example.test',
  DATABASE_URL: `postgresql://contest:${secret}@127.0.0.1:${pg}/contest_center`,
  REDIS_URL: `redis://127.0.0.1:${redis}`,
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  STORAGE_DIR: path.join(stage, 'files'),
  LATEX_SPOOL: path.join(stage, 'latex'),
  STORAGE_MODE: 'LOCAL',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtpPort),
  SMTP_SECURITY: 'NONE',
  SMTP_FROM: '测试系统 <test@example.test>',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
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
        healthcheck: { test: ['CMD', 'pg_isready', '-U', 'contest'], interval: '2s', retries: 30 },
      },
      redis: {
        image: 'redis:7.4.5-alpine',
        ports: [`127.0.0.1:${redis}:6379`],
        healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', retries: 30 },
      },
      minio: {
        image: process.env.PLATFORM_TEST_MINIO_IMAGE || 'nxopa-minio-test:current',
        environment: { MINIO_ROOT_USER: 'feature-storage', MINIO_ROOT_PASSWORD: secret },
        ports: [`127.0.0.1:${s3Port}:9000`],
        healthcheck: {
          test: ['CMD', 'curl', '-fsS', 'http://localhost:9000/minio/health/live'],
          interval: '2s',
          retries: 60,
        },
      },
      mail: {
        image: 'axllent/mailpit:v1.27.8',
        ports: [`127.0.0.1:${smtpPort}:1025`, `127.0.0.1:${mailPort}:8025`],
      },
      latex: {
        image:
          process.env.PLATFORM_TEST_LATEX_IMAGE || 'ghcr.io/albert-li-sz/nxopa-regsys-latex:v0.2.2',
        volumes: [`${env.LATEX_SPOOL}:/jobs`],
        environment: { LATEX_SPOOL: '/jobs' },
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
function start(args: string[], variables: NodeJS.ProcessEnv) {
  const child = spawn('pnpm', args, {
    cwd: root,
    env: variables,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  children.push(child);
  let tail = '';
  child.stdout!.on('data', (b) => (tail = (tail + b).slice(-5000)));
  child.stderr!.on('data', (b) => (tail = (tail + b).slice(-5000)));
  return () => tail;
}
async function until<T>(read: () => Promise<T>, ready: (v: T) => boolean, timeout = 45000) {
  const stop = Date.now() + timeout;
  let value: T;
  while (Date.now() < stop) {
    value = await read();
    if (ready(value)) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for result');
}
async function wait(url: string) {
  await until(async () => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  }, Boolean);
}
async function sql(query: string) {
  return (
    await compose([
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
      query,
    ])
  ).stdout.trim();
}
function passed(message: string) {
  checks.push(message);
  console.log(`[平台验收] ${message}`);
}
class Actor {
  cookie = '';
  csrf = '';
  user: any;
  async raw(route: string, method = 'GET', body?: unknown) {
    const form = body instanceof FormData;
    const response = await fetch(`${apiBase}/api/v1${route}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(form ? {} : { 'Content-Type': 'application/json' }),
        Origin: 'https://reverse-proxy.example.test',
        Cookie: this.cookie,
        'X-CSRF-Token': this.csrf,
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    const jar = new Map(
      this.cookie
        .split('; ')
        .filter(Boolean)
        .map((pair) => [pair.split('=')[0]!, pair.slice(pair.indexOf('=') + 1)]),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!,
        name = pair.split('=')[0]!,
        value = pair.slice(pair.indexOf('=') + 1);
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    this.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    return response;
  }
  async api(route: string, method = 'GET', body?: unknown) {
    const response = await this.raw(route, method, body),
      value = await response.json();
    assert.ok(
      response.ok,
      `${method} ${route}: ${response.status} ${JSON.stringify(value).slice(0, 300)}`,
    );
    return value;
  }
  async refresh() {
    const result = await this.api('/auth/me');
    this.user = result.user;
    this.csrf = result.csrf;
  }
  async login(username: string) {
    const result = await this.api('/auth/login', 'POST', { account: username, password });
    this.user = result.user;
    this.csrf = result.csrf;
    return this;
  }
  async file(name: string, content: Buffer, purpose: string, context: Record<string, string> = {}) {
    const body = new FormData();
    body.append(
      'file',
      new Blob([new Uint8Array(content)], {
        type: name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream',
      }),
      name,
    );
    return this.api(`/files?${new URLSearchParams({ purpose, ...context })}`, 'POST', body);
  }
}
async function message(email: string, match: (m: any) => boolean = () => true): Promise<any> {
  return until(async () => {
    const search = await (
      await fetch(`${mailBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json();
    const messages = await Promise.all(
      (search.messages ?? []).map(async (m: any) =>
        (await fetch(`${mailBase}/api/v1/message/${m.ID}`)).json(),
      ),
    );
    return messages.find(match);
  }, Boolean);
}
async function register(index: number, kind = 'STUDENT') {
  const actor = new Actor(),
    result = await actor.api('/auth/register', 'POST', {
      ...(await registrationProof(actor, `platform-${index}@example.test`, undefined, mailBase)),
      email: `platform-${index}@example.test`,
      username: `platform_${index}`,
      name: `测试用户${index}`,
      password,
      kind,
      identifier: `TEST${index}`,
      ...(kind === 'STUDENT' ? { enrollmentYear: 2026 } : { employedAt: '2020-09-01' }),
    });
  actor.user = result.user;
  actor.csrf = result.csrf;
  assert.equal(actor.user.verified, true);
  await sql(`UPDATE "User" SET verified=false WHERE id='${actor.user.id}'`);
  await actor.api('/auth/resend', 'POST', {});
  const tokenId = await sql(
    `SELECT id FROM "EmailToken" WHERE "userId"='${actor.user.id}' AND purpose='VERIFY' ORDER BY "expiresAt" DESC LIMIT 1`,
  );
  const delivered = await message(actor.user.email, (m) => {
      const token = String(m.Text).match(/\/account\/verify\?token=([^\s&]+)/)?.[1];
      return (
        m.Subject.includes('验证') &&
        token &&
        createHash('sha256').update(token).digest('hex') === tokenId
      );
    }),
    code = (delivered.Text as string).match(/验证码：\s*(\d{6})/)?.[1];
  assert.ok(code);
  assert.equal(
    (
      await actor.raw('/auth/verify-code', 'POST', {
        code: String((Number(code) + 1) % 1000000).padStart(6, '0'),
      })
    ).status,
    400,
  );
  assert.equal((await actor.raw('/auth/verify-code', 'POST', { code: 'INVALID' })).status, 400);
  await actor.api('/auth/verify-code', 'POST', { code });
  assert.equal((await actor.raw('/auth/verify-code', 'POST', { code })).status, 400);
  await actor.refresh();
  actor.user = await actor.api('/auth/profile', 'PUT', {
    version: actor.user.version,
    name: actor.user.name,
    profile: {
      ...actor.user.profile,
      class_name: kind === 'STUDENT' ? '测试一班' : undefined,
      college: '测试学院',
      school: '测试大学',
      gender: '女',
    },
  });
  assert.ok(actor.user.profileComplete);
  assert.equal(actor.user.identityStatus, 'RECORDED');
  for (const proposed of [
    { name: '未审核的姓名', profile: actor.user.profile },
    { name: actor.user.name, profile: { ...actor.user.profile, college: '未审核的院系' } },
  ])
    assert.equal(
      (await actor.raw('/auth/profile', 'PUT', { version: actor.user.version, ...proposed }))
        .status,
      400,
    );
  assert.equal(
    (
      await actor.raw('/auth/profile', 'PUT', {
        version: actor.user.version,
        name: actor.user.name,
        profile: { ...actor.user.profile, display_name: { invalid: true } },
      })
    ).status,
    400,
  );
  return actor;
}
let success = false;
try {
  await compose(['up', '-d', '--wait']);
  await exec('pnpm', ['db:migrate'], { cwd: root, env, timeout: 60000 });
  await exec('pnpm', ['bootstrap:admin'], {
    cwd: root,
    env: {
      ...env,
      ADMIN_USERNAME: 'platform_admin',
      ADMIN_NAME: '测试系统管理员',
      ADMIN_EMAIL: 'platform-admin@example.test',
      ADMIN_PASSWORD: password,
    },
    timeout: 60000,
  });
  const apiTail = start(['--filter', '@contest-center/server', 'start'], env),
    workerTail = start(['--filter', '@contest-center/server', 'worker'], env);
  try {
    await wait(`${apiBase}/api/v1/health`);
  } catch {
    throw new Error(apiTail());
  }
  const admin = await new Actor().login('platform_admin'),
    student = await register(1),
    teacher = await register(2, 'TEACHER'),
    stranger = await register(3);
  assert.equal(teacher.user.kind, 'TEACHER');
  assert.equal(teacher.user.isAdmin, false);
  assert.equal(student.user.kind, 'STUDENT');
  passed('学生与教师注册、真实 SMTP 验证码、格式错误与重复使用拒绝');
  const site = await admin.api('/site');
  await admin.api('/admin/site', 'PUT', {
    ...site,
    publicUrl: 'https://public-links.example.test',
  });
  const local = await student.file('history.txt', Buffer.from('historical local file'), 'PERSONAL');
  const settings = await admin.api('/admin/storage');
  assert.equal(settings.mode, 'LOCAL');
  const configured = await admin.api('/admin/storage', 'PUT', {
    version: settings.version,
    mode: 'S3',
    name: '内置 MinIO',
    endpoint: `http://127.0.0.1:${s3Port}`,
    region: 'us-east-1',
    bucket: 'feature-private',
    prefix: 'test',
    accessKey: 'feature-storage',
    secretKey: secret,
    forcePathStyle: true,
    createBucket: true,
  });
  assert.ok(!JSON.stringify(configured).includes(secret));
  await admin.api('/admin/storage/test', 'POST');
  const migration = await admin.api('/admin/storage/migrate', 'POST');
  await until(
    () => admin.api(`/jobs/${migration.id}`),
    (j) => j.state === 'SUCCESS',
  );
  assert.equal(await sql(`SELECT "storageBackend" FROM "Attachment" WHERE id='${local.id}'`), 'S3');
  await rm(path.join(env.STORAGE_DIR, local.id), { force: true });
  assert.equal(await (await student.raw(`/files/${local.id}`)).text(), 'historical local file');
  assert.equal((await stranger.raw(`/files/${local.id}`)).status, 403);
  const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSxkAAAAASUVORK5CYII=',
      'base64',
    ),
    avatar = await student.file('avatar.png', png, 'AVATAR');
  student.user = await student.api('/auth/profile', 'PUT', {
    version: student.user.version,
    name: student.user.name,
    profile: student.user.profile,
    avatarAttachmentId: avatar.id,
  });
  assert.equal((await fetch(`${apiBase}${student.user.avatarUrl}`)).status, 200);
  const current = await admin.api('/admin/storage');
  await admin.api('/admin/storage', 'PUT', {
    ...current,
    bucket: 'external-second',
    name: '第三方 S3 配置',
    secretKey: '',
  });
  await admin.api('/admin/storage/test', 'POST');
  assert.equal(await (await student.raw(`/files/${local.id}`)).text(), 'historical local file');
  passed('MinIO 真实写入读取删除、历史本地迁移、头像、切换桶后旧对象可读、私有文件越权拒绝');
  const contest = await admin.api('/contests', 'POST', {
    title: '平台功能测试赛',
    season: '2026',
    description: '附件与公示验收',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 43200000).toISOString(),
    published: true,
    publicRosterEnabled: true,
    publicRosterReviews: ['APPROVED'],
    policy: policySchema.parse({
      allowUnofficial: true,
      mode: 'TEAM',
      minMembers: 1,
      maxMembers: 3,
      coachMode: 'DISABLED',
      manualReview: false,
    }),
    fields: [],
  });
  const other = await admin.api('/contests', 'POST', {
    ...contest,
    title: '无授权范围的比赛',
    version: undefined,
    fields: [],
  });
  let reg = await student.api('/registrations', 'POST', { contestId: contest.id });
  reg = await student.api(`/registrations/${reg.id}`, 'PUT', {
    version: reg.version,
    teamName: '测试队伍',
    teamEnglishName: 'Fixture Team',
    answers: {},
    people: reg.people,
    participationType: 'UNOFFICIAL',
  });
  reg = await student.api(`/registrations/${reg.id}/submit`, 'POST', { version: reg.version });
  assert.equal(reg.number, 1);
  reg = await admin.api(`/registrations/${reg.id}/review`, 'POST', {
    version: reg.version,
    decision: 'APPROVED',
  });
  const view = await admin.api('/admin/grants', 'POST', {
    userId: stranger.user.id,
    level: 'CONTEST',
    contestId: contest.id,
    permissions: ['VIEW'],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await stranger.refresh();
  assert.equal((await stranger.raw('/admin/students')).status, 403);
  assert.equal(
    (
      await stranger.raw(`/registrations/${reg.id}/review`, 'POST', {
        version: reg.version,
        decision: 'APPROVED',
      })
    ).status,
    403,
  );
  const material = await admin.file(
    'competition-guide.txt',
    Buffer.from('public contest guide'),
    'CONTEST_PUBLIC',
    { contestId: contest.id },
  );
  assert.ok(material.url.startsWith('https://public-links.example.test/'));
  assert.equal(
    await (await fetch(`${apiBase}/api/v1/files/public/${material.id}`)).text(),
    'public contest guide',
  );
  const privateFile = await admin.file(
    'team-pack.txt',
    Buffer.from('private team materials'),
    'CONTEST_PRIVATE',
    { contestId: contest.id },
  );
  await admin.api(`/contests/${contest.id}/files/distribute`, 'POST', {
    attachmentId: privateFile.id,
    registrationIds: [reg.id],
  });
  assert.equal((await student.raw(`/files/${privateFile.id}`)).status, 200);
  assert.equal((await teacher.raw(`/files/${privateFile.id}`)).status, 403);
  assert.equal((await student.raw(`/files/${privateFile.id}`, 'DELETE')).status, 403);
  const uploaded = await student.file('answer.txt', Buffer.from('team answer'), 'TEAM', {
    registrationId: reg.id,
  });
  assert.equal((await admin.raw(`/files/${uploaded.id}`)).status, 200);
  await student.api(`/files/${uploaded.id}`, 'DELETE');
  assert.equal((await student.raw(`/files/${uploaded.id}`)).status, 404);
  await admin.api(`/registrations/${reg.id}/public-rank`, 'PUT', { rank: 12 });
  const publicList = await (
    await fetch(`${apiBase}/api/v1/contests/${contest.id}/public-teams`)
  ).json();
  assert.equal(publicList.items[0].rank, 12);
  assert.equal(publicList.items[0].members[0].captain, true);
  assert.ok(!JSON.stringify(publicList).includes(student.user.email));
  assert.ok(!JSON.stringify(publicList).includes('student_id'));
  assert.equal((await fetch(`${apiBase}/api/v1/contests/${other.id}/public-teams`)).status, 200);
  passed('队伍公示隐私、公开材料链接、队伍文件分发与上传、仅本人或管理员可删除');
  const seniorGrant = await admin.api('/admin/grants', 'POST', {
    userId: teacher.user.id,
    level: 'SENIOR',
  });
  await teacher.refresh();
  assert.ok(teacher.user.isSeniorAdmin);
  for (const route of [
    '/admin/mail',
    '/admin/storage',
    '/admin/github',
    '/admin/tokens',
    '/admin/mail/templates',
  ])
    assert.equal((await teacher.raw(route)).status, 403, route);
  assert.equal(
    (await teacher.raw('/admin/site', 'PUT', { ...(await admin.api('/site')) })).status,
    403,
  );
  assert.equal(
    (await teacher.raw('/admin/grants', 'POST', { userId: student.user.id, level: 'SYSTEM' }))
      .status,
    403,
  );
  await teacher.api('/contests', 'POST', {
    ...contest,
    title: '高级管理员创建比赛',
    version: undefined,
    fields: [],
  });
  await admin.api(`/admin/grants/${view.id}`, 'DELETE');
  const scoped = await teacher.api('/admin/grants', 'POST', {
    userId: stranger.user.id,
    level: 'CONTEST',
    contestId: contest.id,
    permissions: ['VIEW', 'STUDENTS', 'FILES'],
  });
  await stranger.refresh();
  const students = await stranger.api('/admin/students?page=1&pageSize=20');
  assert.ok(
    students.items.some(
      (s: any) => s.id === student.user.id && s.participationCount === 1 && s.unofficialCount === 1,
    ),
  );
  assert.ok(!students.items.some((s: any) => s.id === stranger.user.id));
  assert.equal((await stranger.raw(`/admin/students/${stranger.user.id}`)).status, 403);
  await sql(
    `UPDATE "AdminGrant" SET "expiresAt"=now()-interval '1 minute' WHERE id='${scoped.id}'`,
  );
  assert.equal((await stranger.raw('/admin/students')).status, 403);
  await admin.api(`/admin/grants/${seniorGrant.id}`, 'DELETE');
  await teacher.refresh();
  assert.equal(teacher.user.isAdmin, false);
  passed('三种管理员权限、学生教师均可授权、即时撤回与到期、学生视图计数和竞赛范围');
  const identity = await student.api('/auth/identity', 'POST', {
    kind: 'STUDENT',
    name: student.user.name,
    profile: student.user.profile,
    version: student.user.version,
  });
  await admin.api(`/admin/identities/${identity.id}/review`, 'POST', { decision: 'APPROVED' });
  await student.refresh();
  assert.equal(student.user.identityStatus, 'VERIFIED');
  assert.equal(
    (
      await student.raw('/auth/profile', 'PUT', {
        version: student.user.version,
        name: '未经审核的新姓名',
        profile: student.user.profile,
      })
    ).status,
    400,
  );
  const templates = await admin.api('/admin/mail/templates'),
    template = templates.find((t: any) => t.key === 'SUPPORT_REPLY');
  const initialIdentityActor = new Actor(),
    initialIdentitySignup = await initialIdentityActor.api('/auth/register', 'POST', {
      ...(await registrationProof(
        initialIdentityActor,
        'first-identity@example.test',
        undefined,
        mailBase,
      )),
      email: 'first-identity@example.test',
      username: 'first_identity',
      name: '首次实名测试',
      password,
      kind: 'STUDENT',
      identifier: 'FIRST-IDENTITY',
      enrollmentYear: 2026,
    });
  initialIdentityActor.user = initialIdentitySignup.user;
  initialIdentityActor.csrf = initialIdentitySignup.csrf;
  const initialIdentity = await initialIdentityActor.api('/auth/identity', 'POST', {
    kind: 'STUDENT',
    name: initialIdentityActor.user.name,
    profile: {
      ...initialIdentityActor.user.profile,
      class_name: '实名测试班级',
      college: '实名测试学院',
      school: '实名测试学校',
      gender: '男',
    },
    version: initialIdentityActor.user.version,
  });
  await admin.api(`/admin/identities/${initialIdentity.id}/review`, 'POST', {
    decision: 'REJECTED',
    reason: '需要补充核验',
  });
  await initialIdentityActor.refresh();
  assert.equal(initialIdentityActor.user.identityStatus, 'REJECTED');
  const correctedIdentity = await initialIdentityActor.api('/auth/identity', 'POST', {
    kind: 'STUDENT',
    name: '修正后实名测试',
    profile: initialIdentityActor.user.profile,
    version: initialIdentityActor.user.version,
  });
  await initialIdentityActor.refresh();
  assert.equal(initialIdentityActor.user.name, '首次实名测试');
  await admin.api(`/admin/identities/${correctedIdentity.id}/review`, 'POST', {
    decision: 'APPROVED',
  });
  await initialIdentityActor.refresh();
  assert.equal(initialIdentityActor.user.name, '修正后实名测试');
  await admin.api('/admin/mail/templates/SUPPORT_REPLY', 'PUT', {
    ...template,
    subject: '[测试反馈] {{subject}}',
    text: '{{message}}\n{{actionUrl}}\n{{siteName}}',
    html: '<h1>{{siteName}}</h1><p>{{message}}</p><a href="{{actionUrl}}">详情</a>',
  });
  const ticket = await student.api('/support', 'POST', {
    registrationId: reg.id,
    title: '邮件通知测试工单',
    category: '报名',
    text: '请核验附件',
    emailNotifications: true,
  });
  await admin.api(`/support/${ticket.id}/messages`, 'POST', {
    version: ticket.version,
    text: '<script>alert(1)</script> 审核完成',
    status: 'RESOLVED',
  });
  const reply = await message(student.user.email, (m) => m.Subject.startsWith('[测试反馈]'));
  assert.ok(reply.HTML.includes('&lt;script&gt;'));
  assert.ok(reply.HTML.includes('https://public-links.example.test/'));
  assert.ok(!reply.HTML.includes('<script>'));
  const delivery = await until(
    () => student.api(`/notifications/mail?resourceId=${ticket.id}`),
    (rows) => rows.some((r: any) => r.state === 'SUCCESS'),
  );
  assert.ok(!JSON.stringify(delivery).includes('encryptedCode'));
  passed('实名信息修改必须审核、完整 HTML 邮件模板、变量转义、工单反馈与投递状态');
  const savedMail = await admin.api('/admin/mail');
  await admin.api('/admin/mail', 'PUT', { ...savedMail, enabled: false });
  const beforeFailed = await student.api(`/support/${ticket.id}`);
  await admin.api(`/support/${ticket.id}/messages`, 'POST', {
    version: beforeFailed.version,
    text: '邮件失败重试测试',
    status: 'RESOLVED',
  });
  const failedRows = await until(
    () => student.api(`/notifications/mail?resourceId=${ticket.id}`),
    (rows) => rows.some((r: any) => r.state === 'FAILED' && r.canRetry),
  );
  const failedMail = failedRows.find((r: any) => r.state === 'FAILED' && r.canRetry);
  assert.equal(
    (await teacher.raw(`/notifications/mail/${failedMail.id}/retry`, 'POST')).status,
    403,
  );
  await admin.api('/admin/mail', 'PUT', { ...(await admin.api('/admin/mail')), enabled: true });
  const retried = await student.api(`/notifications/mail/${failedMail.id}/retry`, 'POST');
  await until(
    () => student.api(`/notifications/mail?resourceId=${ticket.id}`),
    (rows) => rows.some((r: any) => r.id === retried.jobId && r.state === 'SUCCESS'),
  );
  await teacher.api('/auth/forgot', 'POST', { email: teacher.user.email });
  const resetId = await sql(
    `SELECT id FROM "EmailToken" WHERE "userId"='${teacher.user.id}' AND purpose='RESET' ORDER BY "expiresAt" DESC LIMIT 1`,
  );
  const resetMessage = await message(teacher.user.email, (m) => {
    const token = String(m.Text).match(/\/account\/reset\?token=([^\s&]+)/)?.[1];
    return !!token && createHash('sha256').update(token).digest('hex') === resetId;
  });
  const resetCode = resetMessage.Text.match(/验证码：\s*(\d{6})/)[1];
  await teacher.api('/auth/reset-code', 'POST', {
    email: teacher.user.email,
    code: resetCode,
    password,
  });
  assert.equal((await teacher.raw('/auth/me')).status, 200);
  await teacher.refresh();
  assert.equal((await teacher.api('/auth/me')).user, null);
  await teacher.login('platform_2');
  assert.equal(
    (
      await teacher.raw('/auth/reset-code', 'POST', {
        email: teacher.user.email,
        code: resetCode,
        password,
      })
    ).status,
    400,
  );
  passed('业务邮件失败可查看并授权重发、SMTP 恢复后成功投递、验证码重置密码和重放拒绝');
  const source =
    '\\documentclass{article}\n\\begin{document}\nAdmission {{ADMISSION.number}}\\end{document}';
  await admin.api('/admissions/templates', 'POST', {
    contestId: contest.id,
    name: 'S3 验收准考证',
    source,
  });
  const generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [reg.id],
    room: 'A',
    seat: '1',
  });
  assert.ok(!generated.results[0].error, JSON.stringify(generated));
  const documentId = generated.results[0].documentId;
  await until(
    () => sql(`SELECT state FROM "AdmissionDocument" WHERE id='${documentId}'`),
    (state) => state === 'READY',
    100000,
  );
  assert.equal(
    await sql(`SELECT "storageBackend" FROM "AdmissionDocument" WHERE id='${documentId}'`),
    'S3',
  );
  await admin.api(`/admissions/${documentId}/release`, 'POST');
  const pdf = await student.raw(`/admissions/${documentId}/download`);
  assert.equal(pdf.status, 200);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
  assert.equal((await teacher.raw(`/admissions/${documentId}/download`)).status, 403);
  assert.equal((await student.api('/admissions/mine')).length, 1);
  passed('真实 LaTeX 生成准考证存入 S3、发放下载与他人访问拒绝');
  const closure = await admin.raw('/auth/account', 'DELETE', {
    confirmation: '注销账号',
    password,
  });
  assert.equal(closure.status, 400);
  const oldId = student.user.id;
  await student.api('/auth/account', 'DELETE', { confirmation: '注销账号', password });
  assert.equal((await student.raw(`/registrations/${reg.id}`)).status, 401);
  assert.equal(await sql(`SELECT count(*) FROM "Registration" WHERE id='${reg.id}'`), '1');
  const fresh = await register(1);
  assert.notEqual(fresh.user.id, oldId);
  assert.equal((await fresh.raw(`/registrations/${reg.id}`)).status, 403);
  const reclaim = await fresh.api('/auth/identity', 'POST', {
    kind: 'STUDENT',
    name: fresh.user.name,
    profile: fresh.user.profile,
    version: fresh.user.version,
  });
  await admin.api(`/admin/identities/${reclaim.id}/review`, 'POST', { decision: 'APPROVED' });
  await fresh.refresh();
  assert.equal((await fresh.raw(`/registrations/${reg.id}`)).status, 200);
  assert.equal((await fresh.raw(`/files/${local.id}`)).status, 200);
  assert.equal((await fresh.api('/admissions/mine')).length, 1);
  assert.equal(fresh.user.isAdmin, false);
  passed('注销保留报名与附件、禁止直接凭学号恢复、重新注册经实名审核恢复历史、保留最后系统管理员');
  const beforeBackup = await fresh.api('/files'),
    backupDir = path.join(env.STORAGE_DIR, '.s3-backup');
  await exec(
    'pnpm',
    [
      '--filter',
      '@contest-center/server',
      'exec',
      'tsx',
      'src/storage-cli.ts',
      'export',
      backupDir,
    ],
    { cwd: root, env, timeout: 60000 },
  );
  await exec(
    'pnpm',
    [
      '--filter',
      '@contest-center/server',
      'exec',
      'tsx',
      'src/storage-cli.ts',
      'restore',
      backupDir,
    ],
    { cwd: root, env, timeout: 60000 },
  );
  assert.ok(beforeBackup.length > 0);
  assert.equal(await (await fresh.raw(`/files/${local.id}`)).text(), 'historical local file');
  assert.equal(
    await sql(`SELECT "storageBackend" FROM "Attachment" WHERE id='${local.id}'`),
    'LOCAL',
  );
  passed('S3 文件导出与恢复为本地副本，不依赖原存储端点');
  const webTail = start(
    ['--filter', '@contest-center/web', 'dev', '--host', '127.0.0.1', '--port', String(webPort)],
    { ...env, NODE_ENV: 'development', API_PROXY_TARGET: apiBase },
  );
  try {
    await wait(webBase);
  } catch {
    throw new Error(webTail());
  }
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'darwin'
      ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
      : {}),
  });
  try {
    const page = await browser.newPage(),
      errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${webBase}/login`);
    await page.locator('#account').fill('platform_admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL((url) => url.pathname !== '/login');
    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of [
        '/me/profile',
        '/me/profile?tab=settings',
        '/me/profile?tab=identity',
        '/me/profile?tab=management',
        '/me/files',
        '/me/admissions',
        '/admin?tab=storage',
        '/admin?tab=mail-templates',
        '/admin?tab=grants',
        '/admin?tab=students',
        '/admin?tab=identities',
        `/contests/${contest.id}/public-teams`,
        `/admin/contests/${contest.id}?tab=files`,
        `/registrations/${reg.id}?tab=files`,
        `/support/${ticket.id}`,
      ]) {
        await page.goto(webBase + route);
        await page.waitForTimeout(400);
        const dimensions = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          width: window.innerWidth,
        }));
        if (dimensions.scroll > dimensions.width + 2) {
          const directory = path.join(root, '.runtime/reports/platform-ui');
          await mkdir(directory, { recursive: true });
          await page.screenshot({
            path: path.join(directory, `overflow-${width}.png`),
            fullPage: true,
          });
          const controls = await page.locator('input,button,label').evaluateAll((elements) =>
            elements
              .map((element) => ({
                tag: element.tagName,
                type: element.getAttribute('type'),
                right: element.getBoundingClientRect().right,
                width: element.getBoundingClientRect().width,
              }))
              .filter((element) => element.width && element.right > window.innerWidth + 2),
          );
          console.log(JSON.stringify({ route, width, controls }));
        }
        assert.ok(
          dimensions.scroll <= dimensions.width + 2,
          `Overflow ${width} ${route}: ${dimensions.scroll}`,
        );
        if (
          [360, 1440].includes(width) &&
          ['/me/profile', '/admin?tab=students', `/contests/${contest.id}/public-teams`].includes(
            route,
          )
        ) {
          const directory = path.join(root, '.runtime/reports/platform-ui');
          await mkdir(directory, { recursive: true });
          await page.screenshot({
            path: path.join(
              directory,
              `${width}-${route === '/me/profile' ? 'profile' : route.includes('students') ? 'students' : 'roster'}.png`,
            ),
            fullPage: true,
          });
        }
      }
    }
    await page.goto(webBase + '/me/files');
    await page.locator('.file-library input[type=file]').setInputFiles({
      name: 'browser-upload.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('browser file upload verified'),
    });
    await page.getByRole('link', { name: 'browser-upload.txt', exact: true }).waitFor();
    await page.goto(`${webBase}/admin/contests/${contest.id}?tab=files`);
    await page.locator('.file-library input[type=file]').waitFor({ state: 'visible' });
    await page
      .getByRole('button', { name: '复制链接', exact: true })
      .first()
      .waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
  passed('真实浏览器验证新增页面的手机、平板、桌面布局与脚本错误');
  if (process.env.VERIFY_BASELINE_BUGS === '1') {
    for (const child of children)
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
    await until(
      async () => {
        try {
          return (await fetch(`${apiBase}/api/v1/health`)).ok;
        } catch {
          return false;
        }
      },
      (value) => !value,
    );
    const development = { ...env, NODE_ENV: 'development', TEST_URL: apiBase };
    await exec('pnpm', ['seed'], {
      cwd: root,
      env: development,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    start(['--filter', '@contest-center/server', 'start'], development);
    await wait(`${apiBase}/api/v1/health`);
    const result = await exec('pnpm', ['test:bugs'], {
      cwd: root,
      env: development,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    console.log(result.stdout);
    passed('独立数据库运行旧邮箱链接、取消资格、非正式审核与队员工单回归');
  }
  success = true;
} finally {
  for (const child of children)
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
  await compose(['down', '-v', '--remove-orphans']);
  await writeFile(
    path.join(root, '.runtime/reports/platform-features.json'),
    JSON.stringify(
      {
        success,
        checks,
        checkedAt: new Date().toISOString(),
        commit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
      },
      null,
      2,
    ),
  );
  await rm(stage, { recursive: true, force: true });
}
