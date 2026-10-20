import { test, expect, type Page } from '@playwright/test';
import { createServer, request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client, base, until } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15000 });
const run = Date.now(),
  contestIds: string[] = [],
  remoteAccounts = new Map<string, string>(),
  screenshots = process.env.QA_SCREENSHOT_DIR ?? path.join(tmpdir(), 'contest-center-entry-qa');
let admin: Client, originalSite: any, remoteUrl: string;
const remote = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/contest-center/v1/probe') {
    res.end(
      JSON.stringify({
        version: '5.0.7',
        capabilities: ['nickname', 'unofficial', 'contest_linkage'],
      }),
    );
    return;
  }
  if (req.url !== '/contest-center/v1/provision') {
    res.writeHead(404).end('{}');
    return;
  }
  let content = '';
  for await (const chunk of req) content += chunk;
  const body = JSON.parse(content);
  const key = `${body.contestId}:${body.envelope.registrationId}`;
  const previous = remoteAccounts.get(key);
  if (previous && previous !== body.username) {
    res.writeHead(409).end('{}');
    return;
  }
  remoteAccounts.set(key, body.username);
  res.end(
    JSON.stringify({
      schemaVersion: 1,
      registrationId: body.envelope.registrationId,
      state: 'VERIFIED',
      remoteUserId: `remote-${body.username}`,
      username: body.username,
    }),
  );
});

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  originalSite = await admin.api('/admin/site');
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  if (!address || typeof address === 'string') throw new Error('Mock platform did not start');
  remoteUrl = `http://127.0.0.1:${address.port}`;
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  if (originalSite && admin) {
    const current = await admin.api('/admin/site');
    await admin.api('/admin/site', 'PUT', { ...originalSite, version: current.version });
  }
  await db.contest.updateMany({ where: { id: { in: contestIds } }, data: { archived: true } });
  remote.closeAllConnections();
  await new Promise<void>((resolve) => remote.close(() => resolve()));
  await db.$disconnect();
  redis.disconnect();
});

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function originWrite(origin: string, csrf = admin.csrf) {
  return fetch(`${base}/api/v1/admin/site`, {
    method: 'PUT',
    headers: {
      Cookie: admin.cookie,
      Origin: origin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(await admin.api('/admin/site')),
  });
}
async function verified(registrationId: string, bindingId: string) {
  return until(
    () =>
      db.accountMapping.findUnique({
        where: { registrationId_bindingId: { registrationId, bindingId } },
      }),
    (mapping) => mapping?.state === 'VERIFIED',
    30000,
  );
}

test('multiple trusted origins take effect immediately and retain origin, role and CSRF checks', async () => {
  const alice = await new Client().login('alice');
  expect((await alice.raw('/api/v1/admin/site')).status).toBe(403);
  expect((await new Client().raw('/api/v1/admin/site')).status).toBe(401);
  expect(await admin.api('/site')).not.toHaveProperty('trustedOrigins');
  const publicUrl = 'https://public-entry.example.test',
    internal = 'http://192.168.1.10:8080',
    alternate = 'https://alternate-entry.example.test';
  const site = await admin.api('/admin/site');
  const saved = await admin.api('/admin/site', 'PUT', {
    ...site,
    publicUrl,
    trustedOrigins: [internal + '/', alternate.toUpperCase() + ':443/', alternate],
  });
  expect(saved.trustedOrigins).toEqual([internal, alternate]);
  expect((await admin.raw('/api/v1/admin/site', 'PUT', site)).status).toBe(409);
  for (const origin of [internal, alternate, publicUrl]) {
    expect((await originWrite(origin)).status).toBe(200);
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: 'DemoContest2026!' }),
    });
    expect(response.ok).toBe(true);
  }
  expect((await originWrite(alternate, '')).status).toBe(403);
  for (const origin of ['https://alternate-entry.example.test.attacker.test', internal + '1'])
    expect((await originWrite(origin)).status).toBe(403);
  const missingToken = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example.test', 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(missingToken.status).toBe(403);
  for (const origin of [
    'https://*.example.test',
    'https://example.test/path',
    'javascript:alert(1)',
  ]) {
    const current = await admin.api('/admin/site');
    expect(
      (await admin.raw('/api/v1/admin/site', 'PUT', { ...current, trustedOrigins: [origin] }))
        .status,
    ).toBe(400);
  }
  expect(
    (
      await admin.raw('/api/v1/admin/site', 'PUT', {
        ...(await admin.api('/admin/site')),
        trustedOrigins: Array.from({ length: 51 }, (_, i) => `https://entry-${i}.example.test`),
      })
    ).status,
  ).toBe(400);
  expect(
    (await alice.raw('/api/v1/admin/site', 'PUT', await admin.api('/admin/site'))).status,
  ).toBe(403);
  // Older callers which only read the public site settings must retain the private origin list.
  await admin.api('/admin/site', 'PUT', await admin.api('/site'));
  expect((await admin.api('/admin/site')).trustedOrigins).toEqual([internal, alternate]);
  // Use raw HTTP to preserve the internal Host instead of fetch's URL-derived host.
  const internalLogin = await new Promise<{ status: number; secure: boolean }>(
    (resolve, reject) => {
      const req = request(
        `${base}/api/v1/auth/login`,
        {
          method: 'POST',
          headers: {
            Host: '192.168.1.10:8080',
            Origin: internal,
            'Content-Type': 'application/json',
          },
        },
        (response) => {
          response.resume();
          resolve({
            status: response.statusCode!,
            secure: /; Secure/i.test(response.headers['set-cookie']?.join(';') ?? ''),
          });
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ account: 'admin', password: 'DemoContest2026!' }));
    },
  );
  expect(internalLogin.status).toBe(201);
  expect(internalLogin.secure).toBe(false);
  await admin.api('/admin/site', 'PUT', {
    ...(await admin.api('/admin/site')),
    trustedOrigins: [internal],
  });
  expect((await originWrite(alternate)).status).toBe(403);
  expect((await originWrite(internal)).status).toBe(200);
  for (const origin of (await admin.api('/admin/site')).environmentTrustedOrigins)
    expect((await originWrite(origin)).status).toBe(200);
});

test('site origins require edit mode, cancel cleanly, and persist after save and reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await admin.api('/admin/site', 'PUT', {
    ...(await admin.api('/admin/site')),
    publicUrl: originalSite.publicUrl,
    trustedOrigins: [],
  });
  await login(page);
  await page.goto('/admin?tab=site');
  await expect(page).toHaveTitle(/南晓开放原子社/);
  await expect(page.getByRole('heading', { name: '站点设置', exact: true })).toBeVisible();
  const card = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: '站点设置', exact: true }) });
  const input = card.locator('#site-trusted-origins');
  await expect(input).toBeDisabled();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await input.fill('https://discarded.example.test');
  await card.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeDisabled();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await input.fill('https://public-ui.example.test, https://public-ui.example.test');
  await input.press('End');
  await input.press('Enter');
  await input.pressSequentially('http://192.168.1.10:8080');
  await expect(input).toHaveValue(
    'https://public-ui.example.test, https://public-ui.example.test\nhttp://192.168.1.10:8080',
  );
  await card.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('站点配置已保存', { exact: true })).toBeVisible();
  await expect(input).toBeDisabled();
  await page.reload();
  await expect(input).toHaveValue('https://public-ui.example.test\nhttp://192.168.1.10:8080');
  expect((await admin.api('/admin/site')).trustedOrigins).toEqual([
    'https://public-ui.example.test',
    'http://192.168.1.10:8080',
  ]);
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await card.screenshot({ path: path.join(screenshots, 'trusted-origins-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await input.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: path.join(screenshots, 'trusted-origins-mobile.png') });
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('existing approved registrations synchronize after a later binding, automatically and manually', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  const alice = await new Client().login('alice'),
    bob = await new Client().login('bob'),
    carol = await new Client().login('carol');
  let contest = await admin.api('/contests', 'POST', {
    title: `先报名后接平台 ${run}`,
    season: '回归验收',
    description: '先完成报名及审核，再接入平台',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    modules: { integrations: false, admissions: false, rooms: false },
    policy: policySchema.parse({ manualReview: true, coachMode: 'DISABLED' }),
    fields: [],
  });
  contestIds.push(contest.id);
  let first = await alice.api('/registrations', 'POST', { contestId: contest.id });
  first = await alice.api(`/registrations/${first.id}/submit`, 'POST', { version: first.version });
  first = await admin.api(`/registrations/${first.id}/review`, 'POST', {
    version: first.version,
    decision: 'APPROVED',
  });
  expect(first.eligible).toBe(true);
  let pending = await bob.api('/registrations', 'POST', { contestId: contest.id });
  pending = await bob.api(`/registrations/${pending.id}/submit`, 'POST', {
    version: pending.version,
  });
  const draft = await carol.api('/registrations', 'POST', { contestId: contest.id });
  const original = await db.registration.findUniqueOrThrow({ where: { id: first.id } });
  contest = await admin.api(`/contests/${contest.id}`);
  await admin.api(`/contests/${contest.id}`, 'PUT', {
    ...contest,
    modules: { ...contest.modules, integrations: true },
  });
  const instance = await admin.api('/integrations/instances', 'POST', {
    name: `后期接入平台 ${run}`,
    type: 'HYDRO',
    baseUrl: remoteUrl,
    credentials: { token: 'late-binding-acceptance-token-32-characters' },
    allowedContestIds: [contest.id],
  });
  const automatic = await admin.api('/integrations/bindings', 'POST', {
    contestId: contest.id,
    instanceId: instance.id,
    remoteContestId: 'automatic',
    automatic: true,
  });
  const firstMapping = await verified(first.id, automatic.id);
  expect(remoteAccounts.get(`automatic:${first.id}`)).toBe(firstMapping!.username);
  expect(
    await db.accountMapping.count({ where: { registrationId: { in: [pending.id, draft.id] } } }),
  ).toBe(0);
  const after = await db.registration.findUniqueOrThrow({ where: { id: first.id } });
  for (const key of [
    'status',
    'review',
    'eligible',
    'version',
    'formVersion',
    'feeCents',
    'netPaidCents',
    'policySnapshot',
    'snapshot',
  ] as const)
    expect(after[key], key).toEqual(original[key]);
  pending = await admin.api(`/registrations/${pending.id}/review`, 'POST', {
    version: pending.version,
    decision: 'APPROVED',
  });
  await verified(pending.id, automatic.id);
  await login(page);
  await page.goto(`/admin/contests/${contest.id}?tab=integrations`);
  await expect(page).toHaveURL(new RegExp(`/admin/contests/${contest.id}\\?tab=integrations$`));
  await expect(page).toHaveTitle(/南晓开放原子社/);
  await expect(
    page.getByRole('heading', { name: '比赛绑定与报名同步', exact: true }),
  ).toBeVisible();
  await page
    .locator('.el-select')
    .filter({ has: page.locator('#binding-instance') })
    .click();
  await page.getByRole('option', { name: `后期接入平台 ${run} · Hydro`, exact: true }).click();
  await page.locator('#binding-remote').fill('manual');
  await page
    .locator('.el-switch')
    .filter({ has: page.getByRole('switch', { name: '参赛资格生效时自动同步' }) })
    .locator('.el-switch__core')
    .click();
  await page.getByRole('button', { name: '保存比赛绑定', exact: true }).click();
  await expect(page.getByText('比赛绑定已保存', { exact: true })).toBeVisible();
  const manual = await db.platformBinding.findUniqueOrThrow({
    where: {
      contestId_instanceId_remoteContestId: {
        contestId: contest.id,
        instanceId: instance.id,
        remoteContestId: 'manual',
      },
    },
  });
  expect(manual.automatic).toBe(false);
  expect(await db.accountMapping.count({ where: { bindingId: manual.id } })).toBe(0);
  const row = page.getByRole('row').filter({ hasText: 'manual' });
  await row.getByRole('button', { name: '同步已有报名', exact: true }).click();
  await expect(
    page.getByText('已为 2 条符合条件的报名提交同步任务', { exact: true }),
  ).toBeVisible();
  const manualMapping = await verified(first.id, manual.id);
  await verified(pending.id, manual.id);
  const job = await db.job.findFirstOrThrow({
    where: { kind: 'SYNC', payload: { path: ['mappingId'], equals: manualMapping!.id } },
  });
  await until(
    () => db.job.findUniqueOrThrow({ where: { id: job.id } }),
    (current) => current.state === 'SUCCESS',
    30000,
  );
  await db.job.update({
    where: { id: job.id },
    data: { state: 'FAILED', attempts: 4, error: 'Simulated exhausted retry' },
  });
  await db.accountMapping.update({ where: { id: manualMapping!.id }, data: { state: 'FAILED' } });
  await admin.api(`/integrations/bindings/${manual.id}/sync`, 'POST');
  const retried = await verified(first.id, manual.id);
  expect(retried!.id).toBe(manualMapping!.id);
  expect(retried!.credential).toBe(manualMapping!.credential);
  expect(
    await db.job.count({
      where: { kind: 'SYNC', payload: { path: ['mappingId'], equals: manualMapping!.id } },
    }),
  ).toBe(1);
  expect((await alice.raw(`/api/v1/integrations/bindings/${manual.id}/sync`, 'POST')).status).toBe(
    403,
  );
  const credentials = await alice.api(`/integrations/registrations/${first.id}/credentials`);
  expect(credentials.some((credential: any) => credential.bindingId === automatic.id)).toBe(true);
  expect(credentials.some((credential: any) => credential.bindingId === manual.id)).toBe(true);
  expect(await db.accountMapping.count({ where: { registrationId: draft.id } })).toBe(0);
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .locator('.platform-bindings')
    .screenshot({ path: path.join(screenshots, 'late-binding-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: path.join(screenshots, 'late-binding-mobile.png') });
  await admin.api('/integrations/bindings', 'POST', { ...manual, enabled: false });
  expect((await admin.raw(`/api/v1/integrations/bindings/${manual.id}/sync`, 'POST')).status).toBe(
    400,
  );
  await page.reload();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'manual' })
      .getByRole('button', { name: '同步已有报名', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});
