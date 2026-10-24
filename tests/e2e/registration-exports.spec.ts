import { editRegistration } from './workflow-helpers.js';
import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

let admin: Client, alice: Client, bob: Client;
const ids: string[] = [];
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  alice = await new Client().login('alice');
  bob = await new Client().login('bob');
  await mkdir('/tmp/contest-center-ui', { recursive: true });
});
test.afterAll(async () => {
  await db.contest.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  await db.$disconnect();
});
async function contest() {
  const c = await admin.api('/contests', 'POST', {
    title: `报名导出与准考证界面验收 ${Date.now()} 第十一届南京晓庄学院大学生程序设计校赛暨第一届南京理工大学紫金学院程序设计校赛`,
    season: '验收',
    description: '页面与交互验收',
    published: true,
    publicRosterEnabled: true,
    opensAt: new Date(Date.now() - 60000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    accountSettings: { enabled: true, prefix: `ui_${Date.now()}_`, showOnAdmission: true },
    policy: policySchema.parse({ coachMode: 'DISABLED', manualReview: false }),
    fields: [],
  });
  ids.push(c.id);
  return c;
}
async function login(page: Page, account = 'admin') {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test('catalogue edges, one-row list actions, tooltip and equal heading buttons match the requested layouts', async ({
  page,
}) => {
  const c = await contest();
  await alice.api('/registrations', 'POST', { contestId: c.id });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/contests');
    await page.getByPlaceholder('搜索竞赛名称').fill(c.title);
    const card = page.locator('.contest-card').filter({ hasText: c.title });
    await expect(card).toBeVisible();
    const view = await card.getByRole('link', { name: /查看竞赛/ }).boundingBox();
    const roster = await card.getByRole('link', { name: '队伍公示', exact: true }).boundingBox();
    expect(Math.abs(view!.x - roster!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(view!.width - roster!.width)).toBeLessThanOrEqual(1);
    await card.screenshot({ path: `/tmp/contest-center-ui/catalogue-${width}.png` });
    await page.goto('/admin/contests');
    await page.getByPlaceholder('搜索活动或赛季').fill(c.title);
    const row = page.locator('.el-table__row').filter({ hasText: c.title });
    await expect(row).toHaveCount(1);
    const actions = row.locator('.contest-list-actions');
    const boxes = await actions
      .locator('a, .contest-delete-control > button.el-button')
      .evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect();
          return r.y + r.height / 2;
        }),
      );
    expect(boxes).toHaveLength(3);
    expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThanOrEqual(1);
    const icon = actions.locator('.delete-reason');
    await icon.scrollIntoViewIfNeeded();
    await icon.hover();
    await expect(page.getByRole('tooltip')).toContainText('仍有 1 条报名');
    await page.mouse.move(10, 10);
    await icon.focus();
    await expect(page.getByRole('tooltip')).toContainText('仍有 1 条报名');
    await page.screenshot({ path: `/tmp/contest-center-ui/management-${width}.png` });
    await page.mouse.click(10, 10);
    await page.goto(`/admin/contests/${c.id}`);
    const header = page.locator('.contest-heading-actions');
    await expect(header.locator('button.el-button')).toHaveCount(2);
    const buttons = await header.locator('button.el-button').evaluateAll((es) =>
      es.map((e) => {
        const r = e.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }),
    );
    expect(buttons).toHaveLength(2);
    expect(Math.abs(buttons[0]!.width - buttons[1]!.width)).toBeLessThanOrEqual(1);
    expect(buttons[0]!.height).toBe(buttons[1]!.height);
    await expect(header.locator('.form-help, .delete-reason')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '平台文件导出', exact: true })).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/contest-center-ui/activity-${width}.png`,
      fullPage: false,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width + 1,
    );
  }
  expect(errors).toEqual([]);
});

test('verified institution is read-only and exports default to real Excel without credentials', async ({
  page,
}) => {
  const c = await contest();
  const r = await alice.api('/registrations', 'POST', { contestId: c.id });
  await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  await login(page, 'alice');
  await page.goto(`/registrations/${r.id}`);
  await editRegistration(page);
  const institution = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: '参赛性质与代表单位' }) });
  await expect(institution).toContainText('示例大学');
  await expect(institution.locator('input')).toHaveCount(0);
  await expect(page.getByText('国家／地区代码', { exact: true })).toHaveCount(0);
  await expect(page.getByText('学校 ICPC 编号（可选）', { exact: true })).toHaveCount(0);
  await page.context().clearCookies();
  await login(page);
  await page.goto(`/admin/contests/${c.id}?tab=registrations`);
  await page.getByRole('button', { name: '导出名单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导出报名信息', exact: true });
  await expect(dialog.getByRole('radio', { name: 'Excel（.xlsx）', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: '包含比赛账号密码' })).not.toBeChecked();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载', exact: true }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe('registrations.xlsx');
  expect((await readFile((await file.path())!)).subarray(0, 2).toString()).toBe('PK');
});

test('cross-page selection, filtered generation, separate release and ZIP download work through the visible UI', async ({
  page,
}) => {
  test.setTimeout(180000);
  const c = await contest();
  const entries = [];
  for (const client of [alice, bob]) {
    const r = await client.api('/registrations', 'POST', { contestId: c.id });
    entries.push(await client.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version }));
  }
  for (let i = 0; i < 23; i++)
    await db.registration.create({
      data: {
        contestId: c.id,
        ownerId: alice.user.id,
        formVersion: 1,
        people: {
          create: {
            contestId: c.id,
            captain: true,
            name: `分页草稿${i}`,
            email: '',
            confirmed: true,
          },
        },
      },
    });
  await login(page);
  await page.goto(`/admin/contests/${c.id}?tab=registrations`);
  const table = page
    .locator('.el-table')
    .filter({ has: page.getByRole('columnheader', { name: '队名 / 姓名' }) });
  const card = table.locator('..');
  await table.locator('thead .el-checkbox').click();
  await expect(
    page.locator('.admission-batch-actions').getByText('已勾选 20 份（支持跨页）', { exact: true }),
  ).toBeVisible();
  await card.locator('.btn-next').click();
  await expect(table.locator('tbody tr.el-table__row')).toHaveCount(5);
  await table.locator('thead .el-checkbox').click();
  await expect(
    page.locator('.admission-batch-actions').getByText('已勾选 25 份（支持跨页）', { exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder('搜索姓名或队名').fill('不存在的姓名');
  await expect(
    page.locator('.admission-batch-actions').getByText('已勾选 0 份（支持跨页）', { exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder('搜索姓名或队名').fill('');
  await expect(table.locator('tbody tr.el-table__row')).toHaveCount(20);
  const scope = page.locator('.admission-batch-actions .el-select');
  await scope.click();
  await page.getByRole('option', { name: '当前筛选条件下的全部报名', exact: true }).click();
  await page.getByRole('textbox', { name: '批量考场', exact: true }).fill('A101');
  await page.getByRole('textbox', { name: '批量起始座位号', exact: true }).fill('1');
  await page.getByRole('button', { name: '批量生成准考证', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '确认准考证批量操作' });
  await expect(preview).toContainText('操作范围：当前筛选条件下的全部报名');
  await expect(preview).toContainText('共 25 份');
  await expect(preview).toContainText('2 份可处理');
  await preview.getByRole('button', { name: '确认执行', exact: true }).click();
  const progress = page.locator('.batch-progress');
  await expect(progress).toContainText('成功 2', { timeout: 120000 });
  await expect(progress).toContainText('跳过 23');
  const document = (await admin.api(`/registrations/${entries[0]!.id}`)).admissions.find(
    (d: any) => d.state === 'READY',
  );
  expect(document).toBeTruthy();
  await page.getByRole('button', { name: '批量发放准考证', exact: true }).click();
  await preview.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(progress).toContainText('成功 2');
  await expect
    .poll(async () => (await alice.raw(`/api/v1/admissions/${document.id}/download`)).status)
    .toBe(200);
  await page.getByRole('button', { name: '下载准考证 ZIP', exact: true }).click();
  await preview.getByRole('button', { name: '确认执行', exact: true }).click();
  const link = progress.getByRole('link', { name: 'admissions-1.zip' });
  await expect(link).toBeVisible();
  const pending = page.waitForEvent('download');
  await link.click();
  const file = await pending;
  expect((await readFile((await file.path())!)).subarray(0, 2).toString()).toBe('PK');
  await page.screenshot({ path: '/tmp/contest-center-ui/batch-desktop.png', fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({ path: '/tmp/contest-center-ui/batch-mobile.png', fullPage: false });
});
