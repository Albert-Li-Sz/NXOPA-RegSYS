import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { Client } from './client.js';
import { redis } from '../../apps/server/src/auth.js';
import { db } from '../../apps/server/src/db.js';
const admin = await new Client().login('admin');
const savedTemplates = await db.mailTemplate.findMany();
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'darwin'
    ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
    : {}),
});
try {
  const page = await browser.newPage();
  await page.goto((process.env.WEB_URL ?? 'http://localhost:5173') + '/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
  await page.goto((process.env.WEB_URL ?? 'http://localhost:5173') + '/admin?tab=mail-templates');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const selector = page.locator('.el-select').first();
  await selector.click();
  await page.getByRole('option', { name: '报名反馈', exact: true }).click();
  const text = page.getByRole('textbox', { name: '纯文本内容', exact: true });
  await text.fill('保留未保存草稿 {{message}}');
  await selector.click();
  await page.getByRole('option', { name: '工单回复与状态', exact: true }).click();
  await page
    .getByRole('textbox', { name: '邮件标题', exact: true })
    .fill('编辑保存验收 {{subject}}');
  await page.getByRole('button', { name: '保存邮件模板', exact: true }).click();
  await expect(page.getByText('邮件模板已保存', { exact: true })).toBeVisible();
  const persisted = await admin.api('/admin/mail/templates');
  assert.equal(
    persisted.find((row: any) => row.key === 'SUPPORT_REPLY').subject,
    '编辑保存验收 {{subject}}',
  );
  await selector.click();
  await page.getByRole('option', { name: '报名反馈', exact: true }).click();
  await expect(text).toHaveValue('保留未保存草稿 {{message}}');
  console.log('PASS 模板保存正常且不会丢失其他类型的编辑草稿');
} finally {
  await db.$transaction(async (tx) => {
    await tx.mailTemplate.deleteMany();
    if (savedTemplates.length) await tx.mailTemplate.createMany({ data: savedTemplates });
  });
  await browser.close();
  await redis.quit();
  await db.$disconnect();
}
