import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { Client } from '../integrations/client.js';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
let original: Awaited<ReturnType<typeof db.setting.findUnique>>;
test.beforeAll(async () => {
  await mkdir('.runtime/reports', { recursive: true });
  original = await db.setting.findUnique({ where: { key: 'mail' } });
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  if (original)
    await db.setting.upsert({
      where: { key: 'mail' },
      create: { key: 'mail', value: json(original.value), version: original.version },
      update: { value: json(original.value), version: original.version },
    });
  else await db.setting.deleteMany({ where: { key: 'mail' } });
});
async function signIn(page: any, account: string) {
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
test('public landing, login redirect and original contest return on desktop and mobile', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /南晓开放原子社/ })).toBeVisible();
  await page.locator('.hero-actions').getByRole('link', { name: '进入报名系统' }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/login' && url.searchParams.get('next') === '/contests',
  );
  await signIn(page, 'alice');
  await expect(page).toHaveURL(/\/contests$/);
  await expect(page.getByRole('heading', { name: '比赛列表' })).toBeVisible();
  await page.goto('/');
  await page.locator('.hero-actions').getByRole('link', { name: '进入报名系统' }).click();
  await expect(page).toHaveURL(/\/contests$/);
  const mobile = await browser.newContext({
    baseURL: process.env.WEB_URL ?? 'http://localhost:5173',
    viewport: { width: 390, height: 844 },
  });
  const mobilePage = await mobile.newPage();
  const destination = '/contests/11111111-1111-4111-8111-111111111111?tab=registration';
  await mobilePage.goto(destination);
  await expect(mobilePage).toHaveURL(
    (url) => url.pathname === '/login' && url.searchParams.get('next') === destination,
  );
  expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    390,
  );
  await mobilePage.screenshot({
    path: '.runtime/reports/settings-login-mobile.png',
    fullPage: true,
  });
  await signIn(mobilePage, 'alice');
  await expect(mobilePage).toHaveURL(destination);
  await mobile.close();
});
test('administrator saves SMTP in Chinese, tests delivery, and sees saved values after reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const admin = await new Client().login('admin');
  const prior = await admin.api('/admin/mail');
  await admin.api('/admin/mail', 'PUT', {
    ...prior,
    enabled: true,
    host: 'localhost',
    port: Number(process.env.SMTP_PORT ?? 51025),
    security: 'NONE',
    authEnabled: false,
    fromAddress: 'noreply@example.test',
    fromName: '南晓开放原子社在线报名系统',
  });
  await page.goto('/admin?tab=mail');
  await expect(page.locator('#account')).toBeVisible();
  await signIn(page, 'admin');
  await expect(page.getByRole('heading', { name: '系统邮件设置' })).toBeVisible();
  await expect(page.locator('#mail-host')).toHaveValue('localhost');
  await expect(page.getByRole('button', { name: '检测连接', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#mail-from-name').fill('浏览器配置邮件验收');
  await expect(page.getByRole('button', { name: '检测连接', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送测试邮件', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存邮件设置', exact: true }).click();
  await page.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(page.getByText('邮件服务器连接及认证正常', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发送测试邮件', exact: true }).click();
  await expect(page.getByText(/测试邮件发送成功/)).toBeVisible({ timeout: 30000 });
  await page.reload();
  await expect(page.locator('#mail-from-name')).toHaveValue('浏览器配置邮件验收');
  await page.screenshot({ path: '.runtime/reports/settings-mail-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator('#mail-host')).toBeVisible();
  await page.screenshot({ path: '.runtime/reports/settings-mail-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('contest administrators cannot open system mail configuration and platform exports are available in Chinese', async ({
  page,
}) => {
  await page.goto('/admin?tab=mail');
  await signIn(page, 'manager');
  await expect(
    page.getByRole('heading', { name: '活动及竞赛管理中心', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: '邮件设置', exact: true })).toHaveCount(0);
  await expect(page.locator('#mail-host')).toHaveCount(0);
  await page.getByRole('link', { name: '平台导出中心', exact: true }).click();
  await expect(page.getByRole('heading', { name: '导出平台导入文件' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(默认导出|导出平台导入包)$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /同步|添加.*实例/ })).toHaveCount(0);
});
