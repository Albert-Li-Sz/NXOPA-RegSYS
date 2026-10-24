import { test, expect, type Page } from '@playwright/test';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';

const stamp = Date.now().toString(36);
let userId = '',
  account = '',
  client: Client;
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const source = await db.user.findUniqueOrThrow({ where: { username: 'admin' } });
  const user = await db.user.create({
    data: {
      username: `draft_${stamp}`,
      email: `draft-${stamp}@example.test`,
      name: '草稿流程验收',
      passwordHash: source.passwordHash,
      verified: true,
      identityStatus: 'RECORDED',
      profile: {
        student_id: `DRAFT-${stamp}`,
        class_name: '草稿验收班',
        college: '草稿验收学院',
        school: '草稿验收大学',
        gender: '女',
        enrollment_year: 2026,
      },
    },
  });
  userId = user.id;
  account = user.username;
  client = await new Client().login(account);
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  if (userId) {
    const files = await db.attachment.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    for (const file of files) await client.api(`/files/${file.id}`, 'DELETE');
    await db.supportTicket.deleteMany({ where: { ownerId: userId } });
    await db.identityRequest.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
  }
  await db.$disconnect();
});
async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function newTicket() {
  return client.api('/support', 'POST', {
    title: `草稿工单 ${Date.now()}`,
    category: '其他',
    text: '独立测试工单',
    emailNotifications: false,
  });
}
async function delayedUpload(page: Page) {
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(
    '**/api/v1/files**',
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      arrived();
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  return { release, started };
}
const attachment = {
  name: 'draft-upload.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('draft attachment'),
};

test('support creation and replies wait for attachment uploads and include the uploaded file', async ({
  page,
}) => {
  await login(page);
  await page.goto('/support');
  await page.getByRole('button', { name: '新建工单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工单', exact: true });
  await dialog.locator('#ticket-title').fill(`上传等待验收 ${stamp}`);
  await dialog.locator('#ticket-text').fill('文件必须随第一条消息提交');
  const initial = await delayedUpload(page);
  try {
    await dialog.locator('input[type=file]').setInputFiles(attachment);
    await initial.started;
    await expect(dialog.getByRole('button', { name: '提交工单', exact: true })).toBeDisabled();
  } finally {
    initial.release();
  }
  await expect(dialog.getByText('已上传 1 个')).toBeVisible();
  await dialog.getByRole('button', { name: '提交工单', exact: true }).click();
  await expect(page).toHaveURL(/\/support\/[a-f0-9-]+$/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  let ticket = await client.api(`/support/${id}`);
  expect(ticket.messages[0].attachments).toHaveLength(1);
  expect((await client.raw(`/api/v1/files/${ticket.messages[0].attachments[0]}`)).status).toBe(200);
  await page.getByRole('textbox', { name: '工单回复', exact: true }).fill('补充第二个附件');
  const reply = await delayedUpload(page);
  try {
    await page
      .locator('input[type=file]')
      .setInputFiles({ ...attachment, name: 'reply-upload.txt' });
    await reply.started;
    await expect(page.getByRole('button', { name: '提交回复', exact: true })).toBeDisabled();
  } finally {
    reply.release();
  }
  await expect(page.getByText('1 个附件', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '提交回复', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '工单回复', exact: true })).toHaveValue('');
  ticket = await client.api(`/support/${id}`);
  expect(ticket.messages).toHaveLength(2);
  expect(ticket.messages[1].attachments).toHaveLength(1);
  expect(ticket.messages[1].attachments[0]).not.toBe(ticket.messages[0].attachments[0]);
});

test('new support drafts require confirmation before closing and discard only when confirmed', async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/support');
  await page.getByRole('button', { name: '新建工单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工单', exact: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await dialog.locator('#ticket-title').fill('尚未提交的工单标题');
  await dialog.locator('#ticket-text').fill('关闭窗口前需要保留这段说明');
  await dialog.getByRole('button', { name: '关闭此对话框' }).click();
  await expect(page.locator('.el-message-box')).toContainText('有未保存的修改');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(dialog.locator('#ticket-text')).toHaveValue('关闭窗口前需要保留这段说明');
  await dialog.getByRole('button', { name: '关闭此对话框' }).click();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '新建工单', exact: true }).click();
  await expect(dialog.locator('#ticket-title')).toHaveValue('');
  await expect(dialog.locator('#ticket-text')).toHaveValue('');
});

test('support reply drafts survive cancelled navigation and failed submissions', async ({
  page,
}) => {
  const ticket = await newTicket();
  await login(page);
  await page.goto(`/support/${ticket.id}`);
  const reply = page.getByRole('textbox', { name: '工单回复', exact: true });
  await reply.fill('尚未提交的回复应保留');
  await page.getByRole('link', { name: '返回工单列表', exact: true }).click();
  await expect(page.locator('.el-message-box')).toContainText('有未保存的修改');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(reply).toHaveValue('尚未提交的回复应保留');
  await page.route(
    `**/api/v1/support/${ticket.id}/messages`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: '测试暂时失败' }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: '提交回复', exact: true }).click();
  await expect(page.getByText('测试暂时失败', { exact: true }).first()).toBeVisible();
  await expect(reply).toHaveValue('尚未提交的回复应保留');
  await page.getByRole('button', { name: '提交回复', exact: true }).click();
  await expect(reply).toHaveValue('');
  expect((await client.api(`/support/${ticket.id}`)).messages.at(-1).text).toBe(
    '尚未提交的回复应保留',
  );
  await page.getByRole('link', { name: '返回工单列表', exact: true }).click();
  await expect(page).toHaveURL(/\/support$/);
});

test('identity drafts guard tab changes and navigation, restore discarded values, and submit once', async ({
  page,
}) => {
  await login(page);
  await page.goto('/me/profile?tab=identity');
  const input = page.locator('#identity-name');
  const original = await input.inputValue();
  await input.fill('未保存的实名草稿');
  await page.getByRole('tab', { name: '总览', exact: true }).click();
  await expect(page.locator('.el-message-box')).toContainText('有未保存的修改');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(input).toHaveValue('未保存的实名草稿');
  await page.getByRole('tab', { name: '总览', exact: true }).click();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await page.getByRole('tab', { name: '实名认证', exact: true }).click();
  await expect(input).toHaveValue(original);
  await input.fill('实名信息提交验收');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '我的报名', exact: true })
    .click();
  await expect(page.locator('.el-message-box')).toContainText('有未保存的修改');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(input).toHaveValue('实名信息提交验收');
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/v1/auth/identity'),
  );
  await page.getByRole('button', { name: '提交审核', exact: true }).click();
  expect((await submitted).status()).toBe(201);
  await expect(page.getByText('实名信息已提交，等待管理员审核', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '提交审核', exact: true })).toBeDisabled();
  const identity = await client.api('/auth/identity');
  expect(identity.requests).toHaveLength(1);
  expect(identity.requests[0].data.name).toBe('实名信息提交验收');
  await page.getByRole('tab', { name: '总览', exact: true }).click();
  await expect(page.locator('#profile-email')).toBeVisible();
  await expect(page.locator('.el-message-box')).not.toBeVisible();
});
