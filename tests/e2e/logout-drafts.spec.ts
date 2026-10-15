import { test, expect, type Page } from '@playwright/test';
import { redis } from '../../apps/server/src/auth.js';

test.beforeEach(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
  await page.goto('/me/profile');
  await expect(page.locator('#profile-email')).toBeVisible();
}
async function logout(page: Page) {
  await page.locator('.user-menu').click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
}
test('cancelling logout keeps the authenticated session and unsaved profile; discarding logs out', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#profile-email').fill('logout-draft@example.test');
  let requests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/auth/logout') requests++;
  });
  await logout(page);
  const prompt = page.locator('.el-message-box');
  await expect(prompt).toContainText('有未保存的修改');
  expect(requests).toBe(0);
  await prompt.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(/\/me\/profile$/);
  await expect(page.locator('#profile-email')).toHaveValue('logout-draft@example.test');
  await expect(page.locator('.user-menu')).toBeVisible();
  expect((await (await page.request.get('/api/v1/auth/me')).json()).user.username).toBe('admin');
  await logout(page);
  await prompt.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(requests).toBe(1);
  expect((await (await page.request.get('/api/v1/auth/me')).json()).user).toBeNull();
});
test('pending logout blocks page edits and navigation, and a failed request unlocks the page', async ({
  page,
}) => {
  await login(page);
  let release!: () => void, arrived!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(
    '**/api/v1/auth/logout',
    async (route) => {
      arrived();
      await pending;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: '退出暂时失败，请重试' }),
      });
    },
    { times: 1 },
  );
  await logout(page);
  await started;
  try {
    await expect(page.locator('main.page')).toHaveAttribute('inert', '');
    await expect(page.locator('header.site-header')).toHaveAttribute('inert', '');
    await expect(page.locator('footer.site-footer')).toHaveAttribute('inert', '');
  } finally {
    release();
  }
  await expect(page.getByText('退出暂时失败，请重试', { exact: true })).toBeVisible();
  await expect(page.locator('main.page')).not.toHaveAttribute('inert');
  await expect(page.locator('.user-menu')).toBeVisible();
  expect((await (await page.request.get('/api/v1/auth/me')).json()).user.username).toBe('admin');
  await logout(page);
  await expect(page).toHaveURL(/\/$/);
  expect((await (await page.request.get('/api/v1/auth/me')).json()).user).toBeNull();
});
