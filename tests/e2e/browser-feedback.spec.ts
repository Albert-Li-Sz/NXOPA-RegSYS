import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { Client } from '../integrations/client.js';

const stamp = Date.now().toString(36),
  accounts: Record<string, { id: string; username: string }> = {},
  attachmentIds: string[] = [];
test.beforeAll(async () => {
  if (config.production) throw new Error('Browser fixtures are development-only');
  await mkdir('.runtime/reports', { recursive: true });
  const source = await db.user.findUniqueOrThrow({ where: { username: 'alice' } });
  for (const kind of ['pdf', 'sessions', 'other'])
    accounts[kind] = await db.user.create({
      data: {
        username: `feedback_${stamp}_${kind}`,
        email: `feedback-${stamp}-${kind}@example.test`,
        name: `界面验收 ${kind}`,
        verified: true,
        passwordHash: source.passwordHash,
        profile: source.profile ?? {},
      },
      select: { id: true, username: true },
    });
});
test.beforeEach(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
});
test.afterAll(async () => {
  await db.attachment.deleteMany({ where: { id: { in: attachmentIds } } });
  await db.user.deleteMany({
    where: { id: { in: Object.values(accounts).map((user) => user.id) } },
  });
  await db.$disconnect();
  await redis.quit();
});
async function login(page: Page, account: string) {
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test('PDF attachments preview in place, retain downloads and cannot be read by unrelated users', async ({
  page,
  request,
}) => {
  await login(page, accounts.pdf!.username);
  await page.goto('/me/files');
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/files?') && response.request().method() === 'POST',
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: '附件预览验收.pdf',
    mimeType: 'application/pdf',
    buffer: await readFile('docs/acceptance/individual.pdf'),
  });
  const response = await uploaded;
  expect(response.ok()).toBeTruthy();
  const file = await response.json();
  attachmentIds.push(file.id);
  const row = page.getByRole('row').filter({ hasText: '附件预览验收.pdf' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: '下载', exact: true })).toHaveAttribute(
    'href',
    `/api/v1/files/${file.id}`,
  );
  const download = await page.request.get(`/api/v1/files/${file.id}`);
  expect(download.headers()['content-disposition']).toMatch(/^attachment;/);
  expect((await download.body()).subarray(0, 5).toString()).toBe('%PDF-');
  expect((await request.get(`/api/v1/files/${file.id}`)).status()).toBe(401);
  const other = await new Client().login(accounts.other!.username);
  expect((await other.raw(`/api/v1/files/${file.id}`)).status).toBe(403);
  await row.getByRole('link', { name: '附件预览验收.pdf', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'PDF 预览 · 附件预览验收.pdf' });
  await expect(dialog).toBeVisible();
  const canvas = dialog.getByRole('img', { name: 'PDF 第 1 页', exact: true });
  await expect(canvas).toHaveAttribute('data-rendered', 'true', { timeout: 15000 });
  expect(
    await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement,
        pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let index = 0; index < pixels.length; index += 40)
        if (
          pixels[index + 3] &&
          (pixels[index]! < 180 || pixels[index + 1]! < 180 || pixels[index + 2]! < 180)
        )
          ink++;
      return ink;
    }),
  ).toBeGreaterThan(10);
  await dialog.getByRole('button', { name: '放大 PDF', exact: true }).click();
  await expect(dialog).toContainText('125%');
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  await dialog.getByRole('button', { name: '适应宽度', exact: true }).click();
  await expect(dialog).toContainText('100%');
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  const url = (await dialog
    .getByRole('link', { name: '新窗口预览', exact: true })
    .getAttribute('href'))!;
  expect(
    await page.evaluate(async (url) => {
      const response = await fetch(url);
      return { type: response.headers.get('Content-Type'), size: (await response.blob()).size };
    }, url),
  ).toEqual({ type: 'application/pdf', size: file.size });
  await page.screenshot({
    path: '.runtime/reports/pdf-attachment-preview.png',
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(
      async (url) =>
        fetch(url)
          .then(() => false)
          .catch(() => true),
      url,
    ),
  ).toBe(true);
  await row.getByRole('button', { name: '预览', exact: true }).click();
  await expect(dialog.getByRole('img', { name: 'PDF 第 1 页', exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
});
test('login sessions are fixed at 20 per page, scoped to the user and return to the previous page after revocation', async ({
  page,
  request,
}) => {
  const now = Date.now();
  await db.session.createMany({
    data: [
      ...Array.from({ length: 40 }, (_, index) => ({
        id: randomBytes(32).toString('hex'),
        userId: accounts.sessions!.id,
        createdAt: new Date(now - (index + 1) * 1000),
        expiresAt: new Date(now + 86400000),
        userAgent: `分页会话 ${index + 1}`,
      })),
      {
        id: randomBytes(32).toString('hex'),
        userId: accounts.sessions!.id,
        expiresAt: new Date(now - 1000),
        userAgent: '过期会话',
      },
      {
        id: randomBytes(32).toString('hex'),
        userId: accounts.other!.id,
        expiresAt: new Date(now + 86400000),
        userAgent: '其他账号会话',
      },
    ],
  });
  await login(page, accounts.sessions!.username);
  await page.goto('/me/profile');
  const card = page.locator('.login-sessions'),
    rows = card.locator('.el-table__body-wrapper tbody tr.el-table__row');
  await expect(rows).toHaveCount(20);
  await expect(card).toContainText('每页 20 条');
  await expect(card.locator('.el-pagination__total')).toContainText('41');
  await expect(card.locator('.el-select')).toHaveCount(0);
  const first = await (await page.request.get('/api/v1/auth/sessions?page=1&pageSize=20')).json();
  expect(first.items).toHaveLength(20);
  expect(first.total).toBe(41);
  expect(
    first.items.every(
      (session: { userAgent: string }) => !['过期会话', '其他账号会话'].includes(session.userAgent),
    ),
  ).toBe(true);
  const second = await (await page.request.get('/api/v1/auth/sessions?page=2')).json();
  expect(second.items).toHaveLength(20);
  expect(
    first.items.some((session: { id: string }) =>
      second.items.some((other: { id: string }) => other.id === session.id),
    ),
  ).toBe(false);
  const legacy = await (await page.request.get('/api/v1/auth/sessions')).json();
  expect(legacy).toHaveLength(20);
  expect((await page.request.get('/api/v1/auth/sessions?page=1&pageSize=50')).status()).toBe(400);
  expect((await request.get('/api/v1/auth/sessions?page=1')).status()).toBe(401);
  await card.locator('.btn-next').click();
  await expect(card.locator('.el-pager li.is-active')).toHaveText('2');
  await expect(rows).toHaveCount(20);
  await card.locator('.btn-next').click();
  await expect(card.locator('.el-pager li.is-active')).toHaveText('3');
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card.locator('.el-pager li.is-active')).toHaveText('2');
  await expect(rows).toHaveCount(20);
  await expect(card.locator('.el-pagination__total')).toContainText('40');
  await expect(page.locator('.user-menu')).toBeVisible();
  await card.screenshot({
    path: '.runtime/reports/login-sessions-paged.png',
    animations: 'disabled',
  });
});
