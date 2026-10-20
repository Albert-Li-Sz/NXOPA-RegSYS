import { test, expect, type Page } from '@playwright/test';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

let admin: Client;
const ids: string[] = [];
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  await db.contest.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  await db.$disconnect();
});
async function login(page: Page, who: string) {
  await page.goto('/login');
  await page.locator('#account').fill(who);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function create(examSites: Record<string, unknown>[] = []) {
  const c = await admin.api('/contests', 'POST', {
    title: `考点浏览器验收 ${Date.now()}`,
    season: '考点验收',
    description: '隔离演示活动',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    modules: { admissions: true, rooms: true, integrations: false },
    policy: policySchema.parse({ coachMode: 'DISABLED', manualReview: false }),
    fields: [],
    examSites,
  });
  ids.push(c.id);
  return c;
}

test('managers configure sites in explicit edit mode and associate rooms', async ({ page }) => {
  const c = await create();
  await login(page, 'admin');
  await page.goto(`/admin/contests/${c.id}`);
  await expect(page.getByTestId('exam-site-config')).toContainText('暂未配置考点');
  await expect(page.getByRole('button', { name: '新增考点', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  for (const [i, name] of ['主校区', '分校区'].entries()) {
    await page.getByRole('button', { name: '新增考点', exact: true }).click();
    await page.getByLabel(`考点 ${i + 1} 名称`, { exact: true }).fill(name);
    await page.getByLabel(`考点 ${i + 1} 地址`, { exact: true }).fill(`${name}教学楼`);
  }
  await page.getByRole('button', { name: '保存活动配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('考点 1 名称', { exact: true })).toHaveValue('主校区');
  await expect(page.getByLabel('考点 1 名称', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('考点 2 名称', { exact: true })).toHaveValue('分校区');
  const saved = await admin.api(`/contests/${c.id}`);
  await page.getByRole('tab', { name: '考场与座位', exact: true }).click();
  await page.getByRole('button', { name: '新增考场', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增考场', exact: true });
  await dialog.getByLabel('考场名称', { exact: true }).fill('B101');
  await dialog.getByLabel('所属考点', { exact: true }).click();
  await page.getByRole('option', { name: '分校区', exact: true }).click();
  await dialog.getByRole('button', { name: '保存考场', exact: true }).click();
  await expect(dialog).toBeHidden();
  const state = await admin.api(`/contests/${c.id}/rooms`);
  expect(state.rooms[0].examSiteId).toBe(saved.examSites[1].id);
  await expect(page.getByRole('row').filter({ hasText: 'B101' })).toContainText('分校区');
});

test('mobile applicants must choose an enabled site and the selection survives save and submit', async ({
  page,
}) => {
  const c = await create([
    { name: '主校区', address: '主校区教学楼' },
    { name: '分校区', address: '分校区实验楼' },
    { name: '停用考点', enabled: false },
  ]);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'alice');
  await page.goto(`/contests/${c.id}`);
  await expect(page.getByRole('heading', { name: '主校区', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '停用考点', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '立即报名', exact: true }).click();
  await expect(page.getByLabel('选择考点', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '提交报名', exact: true }).click();
  await expect(
    page.locator('.el-message__content').filter({ hasText: /^请选择参赛考点$/ }),
  ).toBeVisible();
  await expect(page.getByLabel('选择考点', { exact: true })).toBeEnabled();
  await page.getByLabel('选择考点', { exact: true }).click();
  await expect(page.getByRole('option', { name: '停用考点', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: '分校区', exact: true }).click();
  await expect(page.getByText('分校区实验楼', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const registrationId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.goto(`/registrations/${registrationId}`);
  await expect(page.getByRole('cell', { name: '分校区', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑报名资料', exact: true }).click();
  await page.getByLabel('选择考点', { exact: true }).click();
  await page.getByRole('option', { name: '主校区', exact: true }).click();
  await page.getByRole('button', { name: '提交报名', exact: true }).click();
  await expect(page.getByText('报名已提交', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '主校区', exact: true })).toBeVisible();
  const saved = await admin.api(`/registrations/${registrationId}`);
  expect(saved.eligible).toBe(true);
  expect(saved.examSiteId).toBe(c.examSites[0].id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.goto(`/admin/contests/${c.id}`);
  // Applicants cannot use a contest's configuration page to edit the site list.
  await expect(page.getByRole('button', { name: '新增考点', exact: true })).toHaveCount(0);
});
