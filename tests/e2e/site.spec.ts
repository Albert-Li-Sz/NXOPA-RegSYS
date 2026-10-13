import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { redis } from '../../apps/server/src/auth.js';
import { Client, until } from '../integrations/client.js';
import { defaultFields, policySchema } from '../../packages/contracts/src/index.js';
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  await mkdir('.runtime/reports', { recursive: true });
});

async function login(page: any, account: string) {
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test('desktop home, filters and account center', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /南晓开放原子社/ })).toBeVisible();
  await expect(page.getByRole('img', { name: '开放原子社 Logo', exact: true })).toBeVisible();
  await expect(
    page.getByRole('img', { name: '南京晓庄学院 ICPC 集训队 Logo', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle('南晓开放原子社在线报名系统');
  await expect(page.locator('.contest-card')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '搜索竞赛' })).toHaveCount(0);
  await page.screenshot({
    path: '.runtime/reports/landing-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('.hero-actions').getByRole('link', { name: '进入报名系统' }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/login' && url.searchParams.get('next') === '/contests',
  );
  await page.locator('#account').fill('alice');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/contests$/);
  await expect(page.getByRole('heading', { name: '比赛列表' })).toBeVisible();
  await expect(page.locator('.contest-card').first()).toBeVisible();
  await expect(page.locator('.card-tags .el-tag').first()).toHaveText(/个人报名|团队报名/);
  const seedIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
  ];
  const seededCards = page.locator('.contest-card').filter({
    has: page.locator(seedIds.map((id) => `a[href="/contests/${id}"]`).join(',')),
  });
  await expect(seededCards.locator('.card-tags')).toContainText([
    '即将开始',
    '报名中',
    '报名中',
    '报名中',
    '报名中',
    '已关闭',
  ]);
  expect(
    await page
      .locator('.contest-grid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
  ).toBe(2);
  await page.screenshot({
    path: '.runtime/reports/home-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByText('即将开始', { exact: true }).first().click();
  await expect(seededCards).toHaveCount(1);
  await page.getByText('全部竞赛', { exact: true }).click();
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: '个人信息' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '总览', exact: true })).toBeVisible();
  await expect(page.locator('#profile-name')).toHaveValue('林同学');
  await expect(page.getByText('第三方账号', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('individual registration is completed in browser', async ({ page }) => {
  const admin = await new Client().login('admin');
  const contest = await admin.api('/contests', 'POST', {
    title: `浏览器个人报名 ${Date.now()}`,
    season: '界面验收',
    description: '独立个人报名测试数据',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ coachMode: 'DISABLED' }),
    fields: defaultFields,
  });
  try {
    await login(page, 'alice');
    await page.goto(`/contests/${contest.id}`);
    await page.getByRole('tab', { name: '报名', exact: true }).click();
    await page.getByRole('button', { name: '创建报名', exact: true }).click();
    await expect(page).toHaveURL(/\/registrations\//);
    await page.getByRole('button', { name: '提交报名', exact: true }).click();
    await expect(page.getByText('已提交', { exact: true })).toBeVisible();
    await expect(page.getByText('等待审核', { exact: true }).first()).toBeVisible();
    await page.screenshot({
      path: '.runtime/reports/registration-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await admin.api(`/contests/${contest.id}`, 'PUT', {
      ...contest,
      fields: defaultFields,
      archived: true,
    });
  }
});
test('admin and contest configuration pages, financial and support views', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'admin');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '管理后台' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '认证服务', exact: true })).toHaveCount(0);
  for (const name of ['用户与邀请', '评测平台', '邮件设置', 'API 与 Webhook', '全局设置', '任务']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.locator('.panel')).toBeVisible();
  }
  await page.goto('/admin/contests/33333333-3333-4333-8333-333333333333');
  await page.getByRole('tab', { name: '报名字段' }).click();
  await page.getByRole('button', { name: '添加字段' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('tab', { name: '准考证模板' }).click();
  await expect(page.getByRole('textbox', { name: 'LaTeX 模板源码' })).toBeVisible();
  const context = JSON.parse(await readFile('.runtime/acceptance-context.json', 'utf8'));
  await page.goto(`/registrations/${context.paid}?tab=finance`);
  await expect(page.getByRole('heading', { name: '账簿' })).toBeVisible();
  await expect(page.getByText('确认到账', { exact: true }).first()).toBeVisible();
  await page.goto(`/support/${context.ticket}`);
  await expect(page.getByRole('heading', { name: '添加回复' })).toBeVisible();
  await page.screenshot({
    path: '.runtime/reports/support-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});
test('mobile layout and empty/error states', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /南晓开放原子社/ })).toBeVisible();
  await expect(page.locator('.contest-card')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: '.runtime/reports/landing-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('.hero-actions').getByRole('link', { name: '进入报名系统' }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/login' && url.searchParams.get('next') === '/contests',
  );
  await page.locator('#account').fill('alice');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/contests$/);
  await expect(page.locator('.contest-card').first()).toBeVisible();
  expect(
    await page
      .locator('.contest-grid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
  ).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: '.runtime/reports/home-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('textbox', { name: '搜索竞赛' }).fill('无此竞赛');
  await expect(page.getByText('暂时没有符合条件的竞赛')).toBeVisible();
  await page.goto('/nonexistent');
  await expect(page.getByText('页面不存在')).toBeVisible();
  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.locator('#account')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});

test('administrator downloads the selected current admission as ZIP in browser', async ({
  page,
}) => {
  await login(page, 'admin');
  const fixture = JSON.parse(await readFile('.runtime/acceptance-context.json', 'utf8'));
  const registration = await (
    await page.request.get(`/api/v1/registrations/${fixture.paid}`)
  ).json();
  const admin = await new Client().login('admin');
  const generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [registration.id],
    room: 'A101',
    seat: '2',
  });
  const documentId = generated.results[0].documentId;
  const prepared = await until(
    () => admin.api(`/registrations/${registration.id}`),
    (value) =>
      value.admissions.some(
        (a: any) => a.id === documentId && ['READY', 'RELEASED', 'FAILED'].includes(a.state),
      ),
    45000,
  );
  expect(prepared.admissions.find((a: any) => a.id === documentId).state).toMatch(
    /^(READY|RELEASED)$/,
  );
  await admin.api(`/admissions/${documentId}/release`, 'POST');
  await page.goto(`/admin/contests/${registration.contestId}?tab=registrations`);
  await expect(page.getByRole('button', { name: '下载准考证 ZIP', exact: true })).toBeVisible();
  await page
    .getByPlaceholder('搜索姓名或队名')
    .fill(registration.teamName || registration.people[0].name);
  const row = page
    .locator('tr')
    .filter({ has: page.locator(`a[href="/registrations/${registration.id}"]`) });
  await expect(row).toBeVisible();
  await row.locator('.el-checkbox').click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载准考证 ZIP', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('admissions.zip');
  await download.saveAs('.runtime/reports/browser-admissions.zip');
  expect(await download.failure()).toBeNull();
});
