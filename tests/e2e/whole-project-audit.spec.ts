import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

const contestIds: string[] = [],
  grantIds: string[] = [];
let admin: Client, alice: Client;
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  alice = await new Client().login('alice');
  await mkdir('.runtime/reports/ui-audit', { recursive: true });
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  await db.contest.updateMany({
    where: { id: { in: contestIds } },
    data: { archived: true, published: false },
  });
  await db.adminGrant.updateMany({
    where: { id: { in: grantIds } },
    data: { revokedAt: new Date() },
  });
  await db.$disconnect();
  redis.disconnect();
});
async function login(page: Page, account = 'admin') {
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function logout(page: Page) {
  await page.locator('.user-menu').click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
}
async function contest(fields: unknown[] = []) {
  const c = await admin.api('/contests', 'POST', {
    title: `全项目交互回归 ${Date.now()}-${contestIds.length}`,
    season: '回归',
    description: '虚构测试资料',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields,
  });
  contestIds.push(c.id);
  return c;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
test('pending dynamic uploads block save, cancel and logout, then persist the uploaded answer', async ({
  page,
}) => {
  const c = await contest([
    { key: 'proof', label: '回归材料', scope: 'REGISTRATION', type: 'file' },
  ]);
  const r = await alice.api('/registrations', 'POST', { contestId: c.id });
  await login(page, 'alice');
  await page.goto(`/registrations/${r.id}?edit=1`);
  const held = deferred(),
    started = deferred();
  let writes = 0,
    logouts = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/v1/registrations/${r.id}` && request.method() === 'PUT') writes++;
    if (url.pathname === '/api/v1/auth/logout') logouts++;
  });
  await page.route(
    '**/api/v1/files?registrationId=*',
    async (route) => {
      started.release();
      await held.promise;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await page.locator('#REGISTRATION-proof').setInputFiles({
      name: 'proof.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('audited upload'),
    });
    await started.promise;
    await expect(page.getByRole('status').filter({ hasText: '附件正在上传' })).toBeVisible();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('附件正在上传，请稍候再保存或离开', { exact: true })).toBeVisible();
    expect(writes).toBe(0);
    await expect(page.getByRole('button', { name: '取消修改', exact: true })).toBeDisabled();
    await logout(page);
    expect(logouts).toBe(0);
    await expect(page.locator('.user-menu')).toBeVisible();
  } finally {
    held.release();
  }
  await expect(page.getByRole('link', { name: '查看已上传文件', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('报名草稿已保存', { exact: true })).toBeVisible();
  expect((await alice.api(`/registrations/${r.id}`)).answers.registration.proof).toMatch(
    /^[a-f\d-]{36}$/,
  );
});
test('support uploads stop logout before the session is destroyed', async ({ page }) => {
  const ticket = await alice.api('/support', 'POST', {
    title: '上传退出回归',
    category: '回归',
    text: '虚构工单',
  });
  await login(page, 'alice');
  await page.goto(`/support/${ticket.id}`);
  await page.getByLabel('工单回复', { exact: true }).fill('保留上传中的回复草稿');
  const held = deferred(),
    started = deferred();
  let logouts = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/auth/logout') logouts++;
  });
  await page.route(
    '**/api/v1/files?ticketId=*',
    async (route) => {
      started.release();
      await held.promise;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await page.locator('input[type=file]').setInputFiles({
      name: 'support.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('support fixture'),
    });
    await started.promise;
    await logout(page);
    await expect(page.getByText('附件正在上传，请稍候再保存或离开', { exact: true })).toBeVisible();
    expect(logouts).toBe(0);
    expect((await (await page.request.get('/api/v1/auth/me')).json()).user.username).toBe('alice');
  } finally {
    held.release();
  }
  await expect(page.getByText('1 个附件', { exact: true })).toBeVisible();
  await expect(page.getByLabel('工单回复', { exact: true })).toHaveValue('保留上传中的回复草稿');
});
test('saving a global template preserves an independently edited site draft', async ({ page }) => {
  const templates = await admin.api('/admissions/templates'),
    original = templates.find((t: any) => t.active && !t.contestId);
  await login(page);
  await page.goto('/admin?tab=site');
  const site = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: '站点设置', exact: true }) });
  const template = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: '全局准考证模板', exact: true }) });
  await site.getByRole('button', { name: '编辑', exact: true }).click();
  await site.locator('input').first().fill('尚未保存的站点草稿');
  await template.getByRole('button', { name: '编辑', exact: true }).click();
  await template.locator('textarea').fill(`${original.source}\n% audit draft preservation`);
  try {
    await template.getByRole('button', { name: '保存新版本', exact: true }).click();
    await expect(template.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
    await expect(site.locator('input').first()).toHaveValue('尚未保存的站点草稿');
    await expect(site.getByText('有未保存修改', { exact: true })).toBeVisible();
    await site.getByRole('button', { name: '取消修改', exact: true }).click();
  } finally {
    const current = (await admin.api('/admissions/templates')).find(
      (t: any) => t.active && !t.contestId,
    );
    await admin.api('/admissions/templates', 'POST', {
      name: original.name,
      source: original.source,
      version: current.version,
    });
  }
});
test('exam-site creation works when the secure-context randomUUID API is unavailable', async ({
  page,
}) => {
  const c = await contest();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }),
  );
  await login(page);
  await page.goto(`/admin/contests/${c.id}`);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '新增考点', exact: true }).click();
  await page.getByLabel('考点 1 名称', { exact: true }).fill('内网 HTTP 考点');
  await page.getByRole('button', { name: '保存活动配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  expect((await admin.api(`/contests/${c.id}`)).examSites[0].name).toBe('内网 HTTP 考点');
  expect(errors).toEqual([]);
});
test('expired sessions recover with the original account while retaining the unsaved profile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/me/profile');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#profile-email').fill('session-draft@example.test');
  await page.route(
    '**/api/v1/auth/profile',
    (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: '登录已失效，请重新登录' }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '登录已失效', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('main.page')).toHaveAttribute('inert', '');
  await dialog.getByLabel('恢复登录密码', { exact: true }).fill('DemoContest2026!');
  await page.screenshot({
    path: '.runtime/reports/ui-audit/session-recovery-mobile.png',
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: '重新登录并继续', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#profile-email')).toHaveValue('session-draft@example.test');
  await expect(page.locator('#profile-email')).toBeEnabled();
});
test('a denied finance refresh removes stale records and actionable controls', async ({ page }) => {
  const c = await contest(),
    r = await alice.api('/registrations', 'POST', { contestId: c.id });
  await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  await login(page);
  await page.goto(`/finance/${r.id}`);
  await expect(
    page.getByRole('heading', { name: `${c.title} · 财务记录`, exact: true }),
  ).toBeVisible();
  await page.route(`**/api/v1/finance/accounts/${r.id}`, (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ message: '财务授权已撤销' }),
    }),
  );
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: `${c.title} · 财务记录`, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /申请退款|申请发票|确认到账/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
});
test('switching accounts after expiry requires discarding the original draft', async ({ page }) => {
  await login(page, 'alice');
  await page.goto('/me/profile');
  await expect(page.locator('#profile-name')).toBeDisabled();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#profile-nickname').fill('不得带入其他账号的草稿');
  await page.route(
    '**/api/v1/auth/profile',
    (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: '登录已失效' }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '登录已失效', exact: true });
  await expect(dialog).toBeVisible();
  const current = await (await page.request.get('/api/v1/auth/me')).json();
  const otherLogin = await page.request.post('/api/v1/auth/login', {
    data: { account: 'admin', password: 'DemoContest2026!' },
    headers: { 'X-CSRF-Token': current.csrf },
  });
  expect(otherLogin.ok()).toBe(true);
  await dialog.getByRole('button', { name: '已登录，恢复编辑', exact: true }).click();
  await expect(dialog).toContainText('更换账号需先放弃当前草稿');
  await dialog.getByRole('button', { name: '放弃草稿并前往登录', exact: true }).click();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole('heading', { name: '系统管理员', exact: true })).toBeVisible();
  await expect(page.locator('#profile-nickname')).not.toHaveValue('不得带入其他账号的草稿');
});
test('a contest viewer cannot open the finance tab through a URL query', async ({ page }) => {
  const c = await contest(),
    r = await alice.api('/registrations', 'POST', { contestId: c.id });
  const bob = await new Client().login('bob');
  grantIds.push(
    (
      await admin.api('/admin/grants', 'POST', {
        userId: bob.user.id,
        level: 'CONTEST',
        contestId: c.id,
        permissions: ['VIEW'],
      })
    ).id,
  );
  await login(page, 'bob');
  await page.goto(`/registrations/${r.id}?tab=finance`);
  await expect(page.getByRole('tab', { name: '报名资料', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: '财务', exact: true })).toHaveCount(0);
});
