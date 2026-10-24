import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';
let admin: Client, alice: Client;
const ids: string[] = [];
const run = Date.now();
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
  admin = await new Client().login('admin');
  alice = await new Client().login('alice');
});
test.afterAll(async () => {
  await db.contest.updateMany({
    where: { id: { in: ids } },
    data: { archived: true, published: false },
  });
  await db.$disconnect();
});
async function contest(fields: unknown[] = []) {
  const c = await admin.api('/contests', 'POST', {
    title: `元与导出验收 ${run} ${ids.length}`,
    season: '验收',
    description: '独立测试活动',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({
      coachMode: 'DISABLED',
      manualReview: false,
      feeMode: 'FIXED',
      feeCents: 12345,
    }),
    fields,
  });
  ids.push(c.id);
  return c;
}
async function login(page: Page) {
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test('fee editor displays yuan and saves exact cents without multiplying existing fees', async ({
  page,
}) => {
  const c = await contest();
  await login(page);
  await page.goto(`/admin/contests/${c.id}`);
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  const field = page
    .locator('.el-form-item')
    .filter({ has: page.locator('label').filter({ hasText: '费用（元）' }) });
  const input = field.getByRole('spinbutton');
  await expect(input).toHaveValue('123.45');
  await input.fill('0.01');
  await input.blur();
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith(`/contests/${c.id}`),
  );
  await page.getByRole('button', { name: '保存活动配置', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  expect((await admin.api(`/contests/${c.id}`)).policy.feeCents).toBe(1);
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await expect(input).toHaveValue('0.01');
  await input.fill('128.99');
  await input.blur();
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await expect(input).toHaveValue('0.01');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  for (const width of [1440, 831, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(1);
  }
});
test('roster download has separate dynamic columns and yuan amounts', async ({ page }) => {
  const c = await contest([
    { key: 'student_no', label: '学号', type: 'text', scope: 'PERSON' },
    { key: 'note', label: '报名备注', type: 'text', scope: 'REGISTRATION' },
  ]);
  let r = await alice.api('/registrations', 'POST', { contestId: c.id });
  r = await alice.api(`/registrations/${r.id}`, 'PUT', {
    ...r,
    people: r.people.map((p: any) => ({ ...p, answers: { student_no: 'TEST-2026' } })),
    answers: { registration: { note: '一列一字段' }, team: {} },
  });
  await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  await login(page);
  await page.goto(`/admin/contests/${c.id}?tab=registrations`);
  await page.getByRole('button', { name: '导出名单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导出报名信息', exact: true });
  await dialog.getByText('CSV', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: 'CSV', exact: true })).toBeChecked();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载', exact: true }).click();
  const download = await downloading;
  const csv = await readFile((await download.path())!, 'utf8');
  const header = csv.split('\r\n')[0]!;
  expect(header).toContain('成员·学号 (student_no)');
  expect(header).toContain('报名·报名备注 (note)');
  expect(header).toContain('应收(元)');
  expect(header).not.toContain('自定义字段');
  expect(csv).toContain('123.45');
  expect(csv).toContain('一列一字段');
});
