import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { mailpitBase } from '../integrations/mailpit.js';
import { until } from '../integrations/client.js';
let originalMail: Awaited<ReturnType<typeof db.setting.findUnique>>,
  originalTemplates: Awaited<ReturnType<typeof db.mailTemplate.findMany>>;
test.beforeAll(async () => {
  await mkdir('.runtime/reports', { recursive: true });
  originalMail = await db.setting.findUnique({ where: { key: 'mail' } });
  originalTemplates = await db.mailTemplate.findMany();
});
test.beforeEach(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
});
test.afterAll(async () => {
  if (originalMail)
    await db.setting.upsert({
      where: { key: 'mail' },
      create: {
        key: originalMail.key,
        value: json(originalMail.value),
        version: originalMail.version,
      },
      update: { value: json(originalMail.value), version: originalMail.version },
    });
  else await db.setting.deleteMany({ where: { key: 'mail' } });
  await db.mailTemplate.deleteMany();
  for (const row of originalTemplates) await db.mailTemplate.create({ data: row });
  await db.$disconnect();
});
async function login(page: Page, name: string) {
  await page.goto('/login');
  await page.locator('#account').fill(name);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test('activity overview is the first navigation entry and real statistics fit desktop and mobile', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, 'admin');
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByRole('link').first(),
  ).toHaveText('活动总览');
  await page.getByRole('link', { name: '活动总览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '活动总览', exact: true })).toBeVisible();
  await expect(page.locator('.overview-table tbody tr').first().getByRole('link')).toBeVisible();
  const buttons = await Promise.all(
    ['刷新数据', '全屏大屏'].map((name) =>
      page.getByRole('button', { name, exact: true }).boundingBox(),
    ),
  );
  expect(Math.abs(buttons[0]!.y - buttons[1]!.y)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '.runtime/reports/activity-overview-desktop.png',
    fullPage: false,
    animations: 'disabled',
  });
  const context = JSON.parse(await readFile('.runtime/acceptance-context.json', 'utf8'));
  const data = await (await page.request.get('/api/v1/overview')).json();
  const chosen = data.choices.find((row: any) => row.id === context.contestId) ?? data.choices[0];
  const select = page.getByRole('combobox', { name: '选择统计活动' });
  await select.fill(chosen.title);
  await page.getByRole('option', { name: chosen.title, exact: true }).click();
  await expect(page.locator('.overview-table tbody tr')).toHaveCount(1);
  const listbox = await select.getAttribute('aria-controls');
  if (listbox) await expect(page.locator(`[id="${listbox}"]`)).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: '.runtime/reports/activity-overview-mobile.png',
    fullPage: false,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});
test('gender has only two options and dropdowns can filter typed text', async ({ page }) => {
  await login(page, 'alice');
  await page.goto('/me/profile?tab=identity');
  const select = page.locator('#identity-gender');
  await select.fill('其他');
  await expect(page.getByRole('option', { name: '其他', exact: true })).toHaveCount(0);
  await select.fill('女');
  await expect(page.getByRole('option', { name: '女', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '男', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: '女', exact: true }).click();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/contests$/);
});
test('administrator adds and sorts backup SMTP servers and sends through the first healthy one', async ({
  page,
}) => {
  await login(page, 'admin');
  await page.goto('/admin?tab=mail');
  await page.locator('#mail-host').fill('127.0.0.1');
  await page.locator('#mail-port').fill('1');
  await page.locator('#mail-port').press('Tab');
  for (const [name, port] of [
    ['失败备用', 1],
    ['浏览器可用备用', Number(process.env.SMTP_PORT ?? 51025)],
  ] as [string, number][]) {
    await page.getByRole('button', { name: '新增备用 SMTP', exact: true }).click();
    const section = page.locator('.smtp-fallback').last();
    await section.locator('input[id$="-name"]').first().fill(name);
    await section.locator('input[id$="-host"]').fill(process.env.SMTP_HOST ?? 'localhost');
    await section.locator('input[id$="-port"]').fill(String(port));
    await section.locator('input[id$="-port"]').press('Tab');
    await section.locator('.el-select').click();
    const listbox = await section.getByRole('combobox').getAttribute('aria-controls');
    await page
      .locator(`[id="${listbox}"]`)
      .getByRole('option', { name: /^不加密/ })
      .click();
    await section.locator('.el-switch').last().click();
  }
  await page
    .locator('.smtp-fallback')
    .last()
    .getByRole('button', { name: '上移', exact: true })
    .click();
  await expect(
    page.locator('.smtp-fallback').first().locator('input[id$="-name"]').first(),
  ).toHaveValue('浏览器可用备用');
  await page.getByRole('button', { name: '保存邮件设置', exact: true }).click();
  await page.getByRole('button', { name: '发送测试邮件', exact: true }).click();
  await expect(page.getByText(/测试邮件发送成功（浏览器可用备用）/)).toBeVisible({
    timeout: 30000,
  });
  await page.reload();
  await expect(page.locator('.smtp-fallback')).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '.runtime/reports/mail-fallbacks.png',
    fullPage: true,
    animations: 'disabled',
  });
});
test('mail template CSS preview matches delivery, invalid saves retain edits, and versioned tests send saved content', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, 'admin');
  await page.goto('/admin?tab=mail-templates');
  await page.locator('.el-select').first().click();
  await page.getByRole('option', { name: '工单回复与状态', exact: true }).click();
  const html =
    '<!doctype html><html><head><style>#mail-preview{color:rgb(12, 34, 56)}</style></head><body><h1 id="mail-preview">{{message}}</h1></body></html>';
  await page.locator('#template-html').fill(html);
  await page.locator('#template-subject').fill('错误 {{unsupported}}');
  await page.getByRole('button', { name: '保存邮件模板', exact: true }).click();
  await expect(page.locator('.card .el-alert').filter({ hasText: '模板变量不支持' })).toBeVisible();
  await expect(page.locator('#template-subject')).toHaveValue('错误 {{unsupported}}');
  await page.locator('#template-subject').fill('浏览器模板验收 {{subject}}');
  await page.locator('#template-text').fill('测试正文 {{message}}');
  await page.getByRole('button', { name: '保存邮件模板', exact: true }).click();
  await expect(page.getByText('邮件模板已保存', { exact: true })).toBeVisible();
  const frame = page.frameLocator('iframe[title="邮件模板预览"]');
  await expect(frame.locator('#mail-preview')).toHaveCSS('color', 'rgb(12, 34, 56)');
  await page.getByRole('button', { name: '发送模板测试邮件', exact: true }).click();
  await expect(page.getByText(/工单回复与状态 测试邮件发送成功/)).toBeVisible({ timeout: 30000 });
  const message = await until<{ Subject: string; HTML: string; Text: string } | null>(
    async () => {
      const response = (await (
        await fetch(
          `${mailpitBase}/api/v1/search?query=${encodeURIComponent('subject:浏览器模板验收')}`,
        )
      ).json()) as any;
      const id = response.messages?.[0]?.ID;
      return id
        ? ((await (await fetch(`${mailpitBase}/api/v1/message/${id}`)).json()) as {
            Subject: string;
            HTML: string;
            Text: string;
          })
        : null;
    },
    Boolean,
    30000,
  );
  if (!message) throw new Error('Template message missing');
  expect(message.Subject).toBe('浏览器模板验收 工单有新回复');
  expect(message.HTML).toContain('color:rgb(12, 34, 56)');
  expect(message.Text).toContain('这是使用当前已保存模板发送的测试邮件。');
  await page
    .locator('iframe[title="邮件模板预览"]')
    .screenshot({ path: '.runtime/reports/mail-template-preview.png' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '.runtime/reports/mail-template-editor.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});
