import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { Client } from '../integrations/client.js';
import { redis } from '../../apps/server/src/auth.js';
import { db } from '../../apps/server/src/db.js';
import { policySchema } from '../../packages/contracts/src/index.js';
async function login(page: Page, who: string) {
  await page.goto('/login');
  await page.locator('#account').fill(who);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test.beforeEach(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  await db.$disconnect();
});
test('ordinary users leave admin routes safely; cold token page has contest choices', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, 'alice');
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/contests$/);
  await page.context().clearCookies();
  await login(page, 'admin');
  await page.goto('/admin?tab=tokens');
  await page.getByRole('button', { name: '签发范围 Token', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建 API Token', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByText('授权竞赛', { exact: true }).locator('..').locator('.el-select').click();
  await expect(
    page.locator('.el-select-dropdown:visible .el-select-dropdown__item').first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('a failed logout preserves a draft even after confirming discard', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/me/profile');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#profile-email').fill('kept-audit-draft@example.test');
  await page.route('**/api/v1/auth/logout', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: '退出暂时失败，请重试' }),
    }),
  );
  await page.locator('.user-menu').click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page.getByText('退出暂时失败，请重试', { exact: true })).toBeVisible();
  await expect(page.locator('#profile-email')).toHaveValue('kept-audit-draft@example.test');
  await expect(page.locator('#profile-email')).toBeEnabled();
});
test('long registration answers retain their limit and saving locks the form', async ({ page }) => {
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice');
  const contest = await admin.api('/contests', 'POST', {
    title: `页面审计 ${Date.now()}`,
    season: '验收',
    description: '浏览器专项验证',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [{ key: 'experience', label: '个人经历', scope: 'REGISTRATION', type: 'textarea' }],
  });
  const r = await alice.api('/registrations', 'POST', { contestId: contest.id });
  await login(page, 'alice');
  await page.goto(`/registrations/${r.id}?edit=1`);
  const answer = page.locator('textarea[maxlength="10000"]');
  await expect(answer).toBeVisible();
  await answer.fill('A'.repeat(1500));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/registrations/${r.id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    await held;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(answer).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByText('报名草稿已保存', { exact: true })).toBeVisible();
  await expect(page.getByText('A'.repeat(1500), { exact: true })).toBeVisible();
  await mkdir('/tmp/nxopa-audit-qa', { recursive: true });
  await page.screenshot({ path: '/tmp/nxopa-audit-qa/registration-saved.png' });
});
