import { test, expect } from '@playwright/test';
import { Client } from '../integrations/client.js';
import { redis } from '../../apps/server/src/auth.js';

test('expired verification link keeps an explanation visible without script errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/account/verify?token=missing-verification-token-with-valid-length');
  await expect(page.locator('.notice')).toContainText('链接已失效');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('senior administrator is displayed with the correct system-role action', async ({ page }) => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    recipient = await new Client().login('bob');
  const grant = await admin.api('/admin/grants', 'POST', {
    userId: recipient.user.id,
    level: 'SENIOR',
  });
  try {
    await page.goto('/login');
    await page.locator('#account').fill('admin');
    await page.locator('#password').fill('DemoContest2026!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.user-menu')).toBeVisible();
    await page.goto('/admin?tab=users');
    await page.getByRole('textbox', { name: '搜索用户', exact: true }).fill(recipient.user.email);
    const row = page.getByRole('row').filter({ hasText: recipient.user.email });
    await expect(row).toContainText('高级管理员');
    await expect(row.getByRole('button', { name: '取消系统管理员', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: '邀请系统管理员', exact: true })).toBeVisible();
  } finally {
    await admin.api(`/admin/grants/${grant.id}`, 'DELETE');
  }
});
