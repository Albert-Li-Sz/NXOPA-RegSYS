import { editRegistration, approveRegistration, chooseInstitution } from './workflow-helpers.js';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { redis } from '../../apps/server/src/auth.js';
import { db } from '../../apps/server/src/db.js';
import { Client } from '../integrations/client.js';
import { policySchema } from '../../packages/contracts/src/index.js';
let admin: Client;
let contestId = '';
const markdown =
  '## 安全 Markdown\n\n| 名称 | 说明 |\n| --- | --- |\n| 团队 | 学生 |\n\n> 报名须知\n\n```text\n代码示例\n```\n\n<script>window.markdownAttack = true</script>\n\n[危险链接](javascript:alert(1))\n\n<img src=x onerror="window.markdownAttack=true">';
async function login(page: Page, account = 'admin') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  const c = await admin.api('/contests', 'POST', {
    title: '浏览器增强验收',
    season: '验收',
    description: markdown,
    descriptionFormat: 'MARKDOWN',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({
      allowUnofficial: true,
      platformProfiles: ['HYDRO_5_0_7', 'DOMJUDGE_9_0_1'],
      coachMode: 'DISABLED',
      manualReview: false,
    }),
    fields: [],
  });
  contestId = c.id;
});
test.afterAll(async () => {
  if (contestId) await db.contest.update({ where: { id: contestId }, data: { archived: true } });
  await db.$disconnect();
  await redis.quit();
});
test('backend pagination is visible, persists page size, and resets after filtering', async ({
  page,
}) => {
  await login(page);
  await page.goto('/admin?tab=audit');
  const pager = page.locator('.list-pagination');
  await expect(pager).toBeVisible();
  await expect(page.locator('.el-table__body tr').first()).toBeVisible();
  const size = pager.getByRole('combobox');
  await expect(size).toBeEnabled();
  await pager.locator('.el-select__wrapper').click();
  await page.getByRole('option', { name: /^50\s*条/ }).click();
  await expect(pager).toContainText('50条/页');
  await page.reload();
  await expect(page.locator('.list-pagination')).toContainText('50条/页');
  await page.locator('.btn-next').click();
  await expect(page.locator('.el-pager li.is-active')).toHaveText('2');
  const context = JSON.parse(await readFile('.runtime/enhancement-context.json', 'utf8'));
  await page.getByPlaceholder('搜索日志', { exact: true }).fill(context.contestId);
  await expect(page.locator('.el-pager li.is-active')).toHaveText('1');
  await expect(page.locator('.el-table__body tr').first()).toContainText('增强验收');
  await page.screenshot({ path: '.runtime/reports/enhancements-pagination.png', fullPage: true });
});
test('Markdown renders tables and code safely and preserves plaintext mode', async ({ page }) => {
  await login(page);
  await page.goto(`/contests/${contestId}`);
  await expect(page.locator('.markdown-content h2')).toHaveText('安全 Markdown');
  await expect(page.locator('.markdown-content table')).toHaveCount(1);
  await expect(page.locator('.markdown-content blockquote')).toHaveCount(1);
  await expect(page.locator('.markdown-content pre code')).toContainText('代码示例');
  expect(
    await page
      .locator('.markdown-content')
      .locator('script,[onerror],a[href^="javascript:"]')
      .count(),
  ).toBe(0);
  expect(await page.evaluate(() => (window as any).markdownAttack)).toBeUndefined();
  await page.goto(`/admin/contests/${contestId}`);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.markdown-editor').getByText('预览', { exact: true }).click();
  await expect(page.locator('.markdown-editor h2')).toHaveText('安全 Markdown');
  await page.locator('.markdown-editor').getByText('纯文本', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: '活动介绍', exact: true })).toHaveValue(markdown);
  await page.screenshot({ path: '.runtime/reports/enhancements-markdown.png', fullPage: true });
});
test('unofficial individual application requires review and basic organization fields', async ({
  page,
}) => {
  const applicant = await new Client().login('alice');
  const r = await applicant.api('/registrations', 'POST', { contestId });
  await login(page, 'alice');
  await page.goto(`/registrations/${r.id}`);
  await editRegistration(page);
  await page.locator('.el-radio').filter({ hasText: '非正式参赛' }).click();
  await chooseInstitution(page, '#organization-name', '南京晓庄学院');
  await page.locator('#organization-short').fill('晓庄');
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/registrations/${r.id}/submit`) &&
        response.request().method() === 'POST' &&
        response.ok(),
    ),
    page.getByRole('button', { name: '提交报名', exact: true }).click(),
  ]);
  await expect(page.getByText('报名已提交', { exact: true })).toBeVisible();
  const submitted = await admin.api(`/registrations/${r.id}`);
  expect(submitted.participationType).toBe('UNOFFICIAL');
  expect(submitted.review).toBe('PENDING');
  expect(submitted.eligible).toBe(false);
  await login(page);
  await page.goto(`/registrations/${r.id}`);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/registrations/${r.id}/review`) &&
        response.request().method() === 'POST' &&
        response.ok(),
    ),
    approveRegistration(page),
  ]);
  await expect.poll(async () => (await admin.api(`/registrations/${r.id}`)).eligible).toBe(true);
});
test('invoice form captures Chinese purchaser information and responsive administration has no overflow', async ({
  page,
}) => {
  const context = JSON.parse(await readFile('.runtime/enhancement-context.json', 'utf8'));
  for (const invoice of (
    await admin.api(`/registrations/${context.registrationId}/finance/invoices?page=1&pageSize=20`)
  ).items.filter((row: any) => row.status === 'REQUESTED'))
    await admin.api(`/finance/invoices/${invoice.id}/review`, 'POST', {
      decision: 'REJECTED',
      reason: '重建浏览器开票测试余额',
    });
  const history = await admin.api(
    `/registrations/${context.registrationId}/finance/invoices?page=1&pageSize=20`,
  );
  for (const row of history.items.filter(
    (x: any) => x.status === 'REQUESTED' && x.title === '增强验收示例企业',
  ))
    await admin.api(`/finance/invoices/${row.id}/review`, 'POST', {
      decision: 'REJECTED',
      reason: '浏览器验收重新准备申请余额',
    });
  await login(page, 'alice');
  await page.goto(`/registrations/${context.registrationId}?tab=finance`);
  await expect(page.locator('.list-pagination')).toHaveCount(4);
  await page.getByRole('button', { name: '申请开票', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.el-select').nth(1).click();
  await page.getByRole('option', { name: '企业', exact: true }).click();
  await dialog.locator('#invoice-title').fill('增强验收示例企业');
  await dialog.locator('#invoice-tax').fill('913200001234567890');
  await dialog.locator('#invoice-email').fill('finance@example.test');
  await dialog.locator('#invoice-contactName').fill('示例联系人');
  await dialog.locator('#invoice-phone').fill('025-00000000');
  await dialog.locator('#invoice-remarks').fill('请核对参赛报名费用');
  await dialog.getByText('我已核对抬头、税号、金额和接收信息').click();
  await dialog.getByRole('button', { name: '提交开票申请', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const invoices = await admin.api(
    `/registrations/${context.registrationId}/finance/invoices?page=1&pageSize=20`,
  );
  const invoice = invoices.items.find((x: any) => x.title === '增强验收示例企业');
  expect(invoice.snapshot.remarks).toBe('请核对参赛报名费用');
  await login(page);
  for (const width of [390, 1440, 2560]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const url of [
      `/registrations/${context.registrationId}?tab=finance`,
      '/admin?tab=audit',
      `/admin/contests/${contestId}`,
    ]) {
      await page.goto(url);
      await expect(page.locator('.panel').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
    }
    await page.screenshot({
      path: `.runtime/reports/enhancements-admin-${width}.png`,
      fullPage: true,
    });
  }
});
