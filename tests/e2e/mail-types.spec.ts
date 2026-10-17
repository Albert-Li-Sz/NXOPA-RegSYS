import { test, expect } from '@playwright/test';
import { redis } from '../../apps/server/src/auth.js';
import { db } from '../../apps/server/src/db.js';
import { until } from '../integrations/client.js';
import { mailpitBase } from '../integrations/mailpit.js';

test.beforeEach(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
});
test.afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
});
test('new ticket templates use ticket content and never include verification codes in preview or delivery', async ({
  page,
}) => {
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
  await page.goto('/admin?tab=mail-templates');
  const select = page.locator('.el-select').first(),
    text = page.locator('#template-text'),
    html = page.locator('#template-html'),
    frame = page.frameLocator('iframe[title="邮件模板预览"]');
  await select.click();
  await page.getByRole('option', { name: '新工单', exact: true }).click();
  await page.locator('iframe[title="邮件模板预览"]').scrollIntoViewIfNeeded();
  await expect(text).not.toHaveValue(/code|验证码/);
  await expect(html).not.toHaveValue(/code|验证码/);
  await expect(frame.locator('body')).toContainText('报名资料咨询');
  await expect(frame.locator('body')).not.toContainText('123456');
  await expect(frame.getByRole('link', { name: '查看工单', exact: true })).toHaveAttribute(
    'href',
    /\/support$/,
  );
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await text.fill('自定义工单正文 {{message}}');
  await select.click();
  await page.getByRole('option', { name: '邮箱验证 / 注册验证码', exact: true }).click();
  await expect(text).toHaveValue(/{{code}}/);
  await expect(frame.locator('body')).toContainText('123456');
  await select.click();
  await page.getByRole('option', { name: '新工单', exact: true }).click();
  await expect(text).toHaveValue('自定义工单正文 {{message}}');
  await page.getByRole('button', { name: '恢复默认格式', exact: true }).click();
  await expect(text).not.toHaveValue(/code|验证码/);
  await page.getByRole('button', { name: '发送模板测试邮件', exact: true }).click();
  await expect(page.getByText(/新工单 测试邮件发送成功/)).toBeVisible({ timeout: 30000 });
  const message = await until<{ Subject: string; Text: string; HTML: string } | null>(
    async () => {
      const results = (await (
        await fetch(
          `${mailpitBase}/api/v1/search?query=${encodeURIComponent('subject:新工单待处理')}`,
        )
      ).json()) as { messages: { ID: string }[] };
      if (!results.messages?.length) return null;
      return (await (
        await fetch(`${mailpitBase}/api/v1/message/${results.messages[0]!.ID}`)
      ).json()) as { Subject: string; Text: string; HTML: string };
    },
    Boolean,
    30000,
  );
  expect(message!.Text).toContain('报名资料咨询');
  expect(message!.Text).not.toMatch(/123456|验证码/);
  expect(message!.HTML).not.toMatch(/123456|验证码/);
  const job = await db.job.findFirstOrThrow({
    where: { resourceId: 'mail-template:SUPPORT_NEW' },
    orderBy: { createdAt: 'desc' },
  });
  expect(job.payload).not.toHaveProperty('encryptedCode');
  await page
    .locator('iframe[title="邮件模板预览"]')
    .screenshot({ path: '.runtime/reports/new-ticket-template-preview.png' });
});
