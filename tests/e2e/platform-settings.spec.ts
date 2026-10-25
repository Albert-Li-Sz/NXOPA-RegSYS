import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { Client } from '../integrations/client.js';
import { exportFixture } from '../integrations/platform-export-fixture.js';
let fixture: Awaited<ReturnType<typeof exportFixture>>;
const screenshots = path.join(tmpdir(), 'contest-center-platform-qa');
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    manager = await new Client().login('manager');
  fixture = await exportFixture(admin.user.id);
  await admin.api('/admin/grants', 'POST', {
    userId: manager.user.id,
    level: 'CONTEST',
    contestId: fixture.contest.id,
    permissions: ['VIEW', 'INTEGRATIONS'],
  });
  await mkdir(screenshots, { recursive: true });
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  await fixture?.cleanup();
  await db.$disconnect();
  redis.disconnect();
});
async function login(page: Page, account: string) {
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test('administrator downloads both import formats and old connection controls are absent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, 'admin');
  await page.goto('/admin/platforms');
  await expect(page).toHaveURL(/\/admin\/platforms/);
  await expect(page.getByRole('heading', { name: '导出平台导入文件' })).toBeVisible();
  await expect(page.getByRole('button', { name: /同步|添加.*实例|探测连接/ })).toHaveCount(0);
  await page.locator('#export-contest').click();
  await page.getByRole('option', { name: fixture.contest.title, exact: true }).click();
  for (const [label, type] of [
    ['Hydro 最新版（Onsite Toolkit）', 'hydro'],
    ['DOMjudge 9.x', 'domjudge'],
  ]) {
    await page.getByText(label, { exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出平台导入包', exact: true }).click();
    const file = await download,
      filePath = await file.path();
    expect(file.suggestedFilename()).toBe(`${type}-${fixture.contest.id}.zip`);
    const teams = JSON.parse(
      execFileSync('unzip', ['-p', filePath!, 'teams.json'], { encoding: 'utf8' }),
    );
    expect(teams).toHaveLength(2);
    if (type === 'hydro') expect(teams[0].displayName).toBe('NULL');
    else
      expect(
        JSON.parse(
          execFileSync('unzip', ['-p', filePath!, 'accounts.json'], { encoding: 'utf8' }),
        )[0].type,
      ).toBe('team');
    await expect(page.getByRole('button', { name: '导出平台导入包', exact: true })).toBeEnabled();
    await expect(page.locator('.el-message')).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(screenshots, `${type}-desktop.png`), fullPage: true });
    if (process.env.CAPTURE_PLATFORM_GUIDE === '1')
      await page.screenshot({
        fullPage: true,
        path: `docs/configuration-screenshots/${type === 'hydro' ? '07-platform-hydro-export' : '08-platform-domjudge-export'}.png`,
      });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: '导出平台导入包' })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'domjudge-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
test('activity administrators export qualified entries after registration without storing platform secrets', async ({
  page,
}) => {
  await login(page, 'manager');
  await page.goto(`/admin/contests/${fixture.contest.id}?tab=integrations`);
  await expect(page.getByRole('tab', { name: '平台文件导出', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '导出平台导入文件' })).toBeVisible();
  await page.getByText('包含非正式报名', { exact: true }).click();
  await expect(page.getByRole('switch', { name: '报名范围' })).not.toBeChecked();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出平台导入包' }).click();
  const file = await download;
  const teams = JSON.parse(
    execFileSync('unzip', ['-p', (await file.path())!, 'teams.json'], { encoding: 'utf8' }),
  );
  expect(teams).toHaveLength(1);
  expect(teams[0].rank).toBe(true);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await db.adminGrant.updateMany({
    where: { contestId: fixture.contest.id },
    data: { permissions: ['VIEW'] },
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: '报名管理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '导出平台导入文件' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导出平台导入包' })).toHaveCount(0);
});
