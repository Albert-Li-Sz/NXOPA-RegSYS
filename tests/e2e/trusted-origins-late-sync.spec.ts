import { test, expect, type Page } from '@playwright/test';
import { createServer, request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client, base, until } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15000 });
const run = Date.now(),
  contestIds: string[] = [],
  screenshots = process.env.QA_SCREENSHOT_DIR ?? path.join(tmpdir(), 'contest-center-entry-qa');
let admin: Client, originalSite: any;
test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  originalSite = await admin.api('/admin/site');
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  if (originalSite && admin) {
    const current = await admin.api('/admin/site');
    await admin.api('/admin/site', 'PUT', { ...originalSite, version: current.version });
  }
  await db.contest.updateMany({ where: { id: { in: contestIds } }, data: { archived: true } });
  await db.$disconnect();
  redis.disconnect();
});

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function originWrite(origin: string, csrf = admin.csrf) {
  return fetch(`${base}/api/v1/admin/site`, {
    method: 'PUT',
    headers: {
      Cookie: admin.cookie,
      Origin: origin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(await admin.api('/admin/site')),
  });
}
test('multiple trusted origins take effect immediately and retain origin, role and CSRF checks', async () => {
  const alice = await new Client().login('alice');
  expect((await alice.raw('/api/v1/admin/site')).status).toBe(403);
  expect((await new Client().raw('/api/v1/admin/site')).status).toBe(401);
  expect(await admin.api('/site')).not.toHaveProperty('trustedOrigins');
  const publicUrl = 'https://public-entry.example.test',
    internal = 'http://192.168.1.10:8080',
    alternate = 'https://alternate-entry.example.test';
  const site = await admin.api('/admin/site');
  const saved = await admin.api('/admin/site', 'PUT', {
    ...site,
    publicUrl,
    trustedOrigins: [internal + '/', alternate.toUpperCase() + ':443/', alternate],
  });
  expect(saved.trustedOrigins).toEqual([internal, alternate]);
  await admin.login('admin');
  await alice.login('alice');
  expect((await admin.raw('/api/v1/admin/site', 'PUT', site)).status).toBe(409);
  for (const origin of [internal, alternate, publicUrl]) {
    expect((await originWrite(origin)).status).toBe(200);
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: 'DemoContest2026!' }),
    });
    expect(response.ok).toBe(true);
  }
  expect((await originWrite(alternate, '')).status).toBe(403);
  for (const origin of ['https://alternate-entry.example.test.attacker.test', internal + '1'])
    expect((await originWrite(origin)).status).toBe(403);
  const missingToken = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example.test', 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(missingToken.status).toBe(403);
  for (const origin of [
    'https://*.example.test',
    'https://example.test/path',
    'javascript:alert(1)',
  ]) {
    const current = await admin.api('/admin/site');
    expect(
      (await admin.raw('/api/v1/admin/site', 'PUT', { ...current, trustedOrigins: [origin] }))
        .status,
    ).toBe(400);
  }
  expect(
    (
      await admin.raw('/api/v1/admin/site', 'PUT', {
        ...(await admin.api('/admin/site')),
        trustedOrigins: Array.from({ length: 51 }, (_, i) => `https://entry-${i}.example.test`),
      })
    ).status,
  ).toBe(400);
  expect(
    (await alice.raw('/api/v1/admin/site', 'PUT', await admin.api('/admin/site'))).status,
  ).toBe(403);
  // Older callers which only read the public site settings must retain the private origin list.
  await admin.api('/admin/site', 'PUT', await admin.api('/site'));
  expect((await admin.api('/admin/site')).trustedOrigins).toEqual([internal, alternate]);
  // Use raw HTTP to preserve the internal Host instead of fetch's URL-derived host.
  const internalLogin = await new Promise<{ status: number; secure: boolean }>(
    (resolve, reject) => {
      const req = request(
        `${base}/api/v1/auth/login`,
        {
          method: 'POST',
          headers: {
            Host: '192.168.1.10:8080',
            Origin: internal,
            'Content-Type': 'application/json',
          },
        },
        (response) => {
          response.resume();
          resolve({
            status: response.statusCode!,
            secure: /; Secure/i.test(response.headers['set-cookie']?.join(';') ?? ''),
          });
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ account: 'admin', password: 'DemoContest2026!' }));
    },
  );
  expect(internalLogin.status).toBe(201);
  expect(internalLogin.secure).toBe(false);
  await admin.api('/admin/site', 'PUT', {
    ...(await admin.api('/admin/site')),
    trustedOrigins: [internal],
  });
  expect((await originWrite(alternate)).status).toBe(403);
  expect((await originWrite(internal)).status).toBe(200);
  for (const origin of (await admin.api('/admin/site')).environmentTrustedOrigins)
    expect((await originWrite(origin)).status).toBe(200);
});

test('site origins require edit mode, cancel cleanly, and persist after save and reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await admin.api('/admin/site', 'PUT', {
    ...(await admin.api('/admin/site')),
    publicUrl: originalSite.publicUrl,
    trustedOrigins: [],
  });
  await admin.login('admin');
  await login(page);
  await page.goto('/admin?tab=site');
  await expect(page).toHaveTitle(/南晓开放原子社/);
  await expect(page.getByRole('heading', { name: '站点设置', exact: true })).toBeVisible();
  const card = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: '站点设置', exact: true }) });
  const input = card.locator('#site-trusted-origins');
  await expect(input).toBeDisabled();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await input.fill('https://discarded.example.test');
  await card.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeDisabled();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await input.fill('https://public-ui.example.test, https://public-ui.example.test');
  await input.press('End');
  await input.press('Enter');
  await input.pressSequentially('http://192.168.1.10:8080');
  await expect(input).toHaveValue(
    'https://public-ui.example.test, https://public-ui.example.test\nhttp://192.168.1.10:8080',
  );
  await card.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('站点配置已保存', { exact: true })).toBeVisible();
  await expect(input).toBeDisabled();
  await page.reload();
  await expect(input).toHaveValue('https://public-ui.example.test\nhttp://192.168.1.10:8080');
  expect((await admin.api('/admin/site')).trustedOrigins).toEqual([
    'https://public-ui.example.test',
    'http://192.168.1.10:8080',
  ]);
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await card.screenshot({ path: path.join(screenshots, 'trusted-origins-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await input.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: path.join(screenshots, 'trusted-origins-mobile.png') });
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});
