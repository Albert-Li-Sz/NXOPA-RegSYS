import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
const users: string[] = [];
test.afterAll(async () => {
  await db.emailToken.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
  redis.disconnect();
});
for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test(`email change requires reauthentication and retains the verified login mailbox (${name})`, async ({
    page,
  }) => {
    if (redis.status === 'end') await redis.connect();
    await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
    const stamp = randomUUID().slice(0, 8),
      email = `audit-ui-${stamp}@example.test`,
      next = `next-${email}`;
    const seed = await db.user.findUniqueOrThrow({ where: { username: 'admin' } });
    const account = await db.user.create({
      data: {
        username: `auditui_${stamp}`,
        email,
        name: '审计验证用户',
        verified: true,
        passwordHash: seed.passwordHash,
        identityStatus: 'RECORDED',
        profile: {
          student_id: `UI-${stamp}`,
          class_name: '测试班',
          college: '测试学院',
          gender: '男',
        },
      },
    });
    users.push(account.id);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize(viewport);
    await page.goto('/login');
    await page.locator('#account').fill(account.username);
    await page.locator('#password').fill('DemoContest2026!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.user-menu')).toBeVisible();
    await page.goto('/me/profile');
    await expect(page).toHaveURL(/\/me\/profile$/);
    await expect(page).toHaveTitle(/报名系统/);
    await expect(page.locator('main')).toContainText('邮箱');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#profile-email').fill(next);
    await page.getByRole('button', { name: '保存资料', exact: true }).click();
    const dialog = page.locator('.el-message-box');
    await expect(dialog).toContainText('验证身份');
    await dialog.locator('input[type="password"]').fill('DemoContest2026!');
    await dialog.getByRole('button', { name: '确定', exact: true }).click();
    await expect(dialog).toBeHidden();
    const pending = page.getByText(`待验证新邮箱：${next}`, { exact: false });
    await expect(pending).toBeVisible();
    await pending.scrollIntoViewIfNeeded();
    const current = await db.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(current.email).toBe(email);
    expect(current.pendingEmail).toBe(next);
    expect(current.verified).toBe(true);
    await mkdir('.runtime/reports/ui-audit', { recursive: true });
    await page.screenshot({
      path: `.runtime/reports/ui-audit/email-change-${name}.png`,
      fullPage: false,
    });
    expect(errors).toEqual([]);
  });
}
