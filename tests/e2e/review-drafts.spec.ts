import { test, expect, type Page } from '@playwright/test';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

let admin: Client, alice: Client;
const ids: string[] = [];
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  alice = await new Client().login('alice');
});
test.afterAll(async () => {
  await db.contest.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  await db.$disconnect();
});
async function openReview(page: Page) {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const contest = await admin.api('/contests', 'POST', {
    title: `审核草稿保护 ${Date.now()}`,
    season: '流程验收',
    description: '审核草稿与异步操作回归',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ coachMode: 'DISABLED', allowUnofficial: true }),
    fields: [],
  });
  ids.push(contest.id);
  const draft = await alice.api('/registrations', 'POST', { contestId: contest.id });
  const registration = await alice.api(`/registrations/${draft.id}/submit`, 'POST', {
    version: draft.version,
  });
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
  await page.goto('/admin/contests');
  await page.getByPlaceholder('搜索活动或赛季').fill(contest.title);
  await page
    .getByRole('row')
    .filter({ hasText: contest.title })
    .getByRole('link', { name: '报名管理', exact: true })
    .click();
  await page
    .getByRole('row')
    .filter({ hasText: alice.user.name })
    .getByRole('button', { name: '审核', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '报名审核', exact: true });
  await expect(dialog.locator('textarea')).toBeVisible();
  return { dialog, registration };
}

test('review drafts survive X, Escape and browser-back cancellation', async ({ page }) => {
  const { dialog } = await openReview(page);
  const url = page.url();
  await dialog.locator('textarea').fill('关闭前尚未保存的审核建议');
  const prompt = page.locator('.el-message-box');
  for (const trigger of [
    () => dialog.locator('.el-dialog__headerbtn').click(),
    () => page.keyboard.press('Escape'),
    () => page.evaluate(() => window.history.back()),
  ]) {
    await trigger();
    await expect(prompt).toContainText('有未保存的修改');
    await prompt.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(prompt).toHaveCount(0);
    await expect(dialog.locator('textarea')).toHaveValue('关闭前尚未保存的审核建议');
    await expect(page).toHaveURL(url);
  }
  await dialog.locator('.el-dialog__headerbtn').click();
  await prompt.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('review submission locks controls and failed refresh cannot resubmit stale data', async ({
  page,
}) => {
  const { dialog, registration } = await openReview(page);
  await dialog.locator('label.el-radio-button').filter({ hasText: '退回补正' }).click();
  await dialog.locator('label.el-radio').filter({ hasText: '非正式' }).click();
  await dialog.locator('textarea').fill('保留审核意见与参加性质');
  let release!: () => void, ready!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const reviewUrl = `**/api/v1/registrations/${registration.id}/review`;
  await page.route(reviewUrl, async (route) => {
    ready();
    await pending;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ message: '报名已更新，请重新核对' }),
    });
  });
  await dialog.getByRole('button', { name: '确认审核', exact: true }).click();
  await started;
  try {
    await expect(dialog.locator('textarea')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '确认审核', exact: true })).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: '审核并查看下一条', exact: true }),
    ).toBeDisabled();
    await expect(dialog.locator('.el-dialog__headerbtn')).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(dialog.getByText('报名已更新，请重新核对', { exact: true })).toBeVisible();
  await page.unroute(reviewUrl);
  const detailUrl = `**/api/v1/registrations/${registration.id}`;
  await page.route(detailUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: '暂时无法读取最新报名' }),
    }),
  );
  await dialog.getByRole('button', { name: '重新加载报名（保留审核意见）', exact: true }).click();
  await expect(dialog.getByText('暂时无法读取最新报名', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认审核', exact: true })).toBeDisabled();
  await expect(dialog.locator('textarea')).toHaveValue('保留审核意见与参加性质');
  await page.unroute(detailUrl);
  await dialog.getByRole('button', { name: '重新加载报名（保留审核意见）', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认审核', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('radio', { name: '非正式', exact: true })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: '退回补正', exact: true })).toBeChecked();
  await expect(dialog.locator('textarea')).toHaveValue('保留审核意见与参加性质');
  await dialog.getByRole('button', { name: '确认审核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.el-message-box')).not.toBeVisible();
  const saved = await admin.api(`/registrations/${registration.id}`);
  expect(saved.review).toBe('CORRECTION');
  expect(saved.participationType).toBe('UNOFFICIAL');
});
