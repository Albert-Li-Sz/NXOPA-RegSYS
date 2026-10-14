import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { Client } from '../integrations/client.js';
import { until } from '../integrations/client.js';
import { mailpitBase } from '../integrations/mailpit.js';
import { policySchema } from '../../packages/contracts/src/index.js';

const stamp = Date.now().toString(36),
  users: Record<string, any> = {};
const userIds: string[] = [],
  contestIds: string[] = [],
  invitationIds: string[] = [];
let admin: Client;
test.beforeAll(async () => {
  if (config.production) throw new Error('Browser authorization fixtures are development-only');
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  await mkdir('.runtime/reports', { recursive: true });
  admin = await new Client().login('admin');
  const passwordHash = (await db.user.findUniqueOrThrow({ where: { username: 'alice' } }))
    .passwordHash;
  for (const name of ['manager', 'coach', 'other']) {
    users[name] = await db.user.create({
      data: {
        username: `url_${stamp}_${name}`,
        email: `url-${stamp}-${name}@example.test`,
        name: `链接邀请验收 ${name}`,
        verified: true,
        passwordHash,
      },
    });
    userIds.push(users[name].id);
  }
});
test.beforeEach(async () => {
  await redis.del(
    'rate:login:::ffff:127.0.0.1',
    'rate:login:127.0.0.1',
    'rate:register:::ffff:127.0.0.1',
    'rate:register:127.0.0.1',
  );
});
test.afterAll(async () => {
  await db.invitation.deleteMany({ where: { id: { in: invitationIds } } });
  await db.contest.deleteMany({ where: { id: { in: contestIds } } });
  await db.emailToken.deleteMany({ where: { userId: { in: userIds } } });
  await db.adminGrant.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
  await redis.quit();
});
async function loginCurrent(page: Page, username: string) {
  await page.locator('#account').fill(username);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function administrator(page: Page) {
  await page.goto('/login');
  await loginCurrent(page, 'admin');
  await page.goto('/admin/users?tab=users');
  await expect(page.getByRole('button', { name: '生成邀请链接', exact: true })).toBeVisible();
}
function userRow(page: Page, email: string) {
  return page.locator('.panel .card').first().getByRole('row').filter({ hasText: email });
}
async function generate(page: Page) {
  const dialog = page.getByRole('dialog', { name: '生成账号 / 授权邀请' });
  const result = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/admin/invitations') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '生成链接', exact: true }).click();
  const response = await result;
  expect(response.ok()).toBeTruthy();
  const invitation = await response.json();
  invitationIds.push(invitation.id);
  const link = dialog.getByRole('textbox', { name: '邀请链接', exact: true });
  await expect(link).toHaveValue(invitation.url);
  await expect(dialog.getByText('权限尚未生效', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  return invitation;
}
async function contest() {
  const c = await admin.api('/contests', 'POST', {
    title: `授权链接竞赛 ${stamp}`,
    season: '界面验收',
    description: '虚构竞赛',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({}),
    fields: [],
  });
  contestIds.push(c.id);
  return c;
}

test('administrator generates contest URL, recipient logs in and confirms, revocation survives old URL', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const c = await contest();
  await administrator(page);
  await userRow(page, users.manager.email)
    .getByRole('button', { name: '授权竞赛', exact: true })
    .click();
  await page.locator('#authorization-contest').click();
  await page.getByRole('option', { name: c.title, exact: true }).click();
  const i = await generate(page);
  expect(
    await db.roleAssignment.count({ where: { userId: users.manager.id, contestId: c.id } }),
  ).toBe(0);
  await page.screenshot({
    path: '.runtime/reports/authorization-admin.png',
    fullPage: true,
    animations: 'disabled',
  });
  const context = await browser.newContext(),
    recipient = await context.newPage();
  recipient.on('pageerror', (e) => errors.push(e.message));
  try {
    await recipient.goto(i.url);
    await expect(recipient).toHaveURL(/\/login\?next=/);
    await loginCurrent(recipient, users.manager.username);
    await expect(
      recipient.getByRole('heading', { name: '确认授权邀请', exact: true }),
    ).toBeVisible();
    await expect(recipient.getByText(c.title, { exact: true })).toBeVisible();
    expect(await db.roleAssignment.count({ where: { userId: users.manager.id } })).toBe(0);
    await recipient.screenshot({
      path: '.runtime/reports/authorization-confirm.png',
      fullPage: true,
      animations: 'disabled',
    });
    await recipient.getByRole('button', { name: '确认接受', exact: true }).click();
    await expect(recipient).toHaveURL(/\/admin\/contests$/);
    await expect(recipient.getByRole('row').filter({ hasText: c.title })).toBeVisible();
    await expect(recipient.getByRole('tab', { name: '用户与邀请', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await userRow(page, users.manager.email)
      .getByRole('button', { name: `撤销 ${c.title}`, exact: true })
      .click();
    await expect
      .poll(() => db.roleAssignment.count({ where: { userId: users.manager.id } }))
      .toBe(0);
    expect((await recipient.request.get(`/api/v1/contests/${c.id}/statistics`)).status()).toBe(403);
    await recipient.goto(i.url);
    await expect(
      recipient.getByText('此邀请已确认，但相应权限已被撤销。', { exact: false }),
    ).toBeVisible();
    await expect(recipient.getByRole('button', { name: '确认接受', exact: true })).toHaveCount(0);
    await recipient.getByRole('link', { name: '继续前往', exact: true }).click();
    await expect(recipient).toHaveURL(/\/account$/);
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});

test('mobile account invitation retains public signup and returns from email verification for explicit confirmation', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const email = `url-${stamp}-signup@example.test`;
  await administrator(page);
  await page.getByRole('button', { name: '生成邀请链接', exact: true }).click();
  await page.locator('#authorization-email').fill(email);
  const invitation = await generate(page);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }),
    recipient = await context.newPage();
  const errors: string[] = [];
  recipient.on('pageerror', (e) => errors.push(e.message));
  try {
    await recipient.goto(invitation.url);
    await recipient.getByRole('button', { name: '创建账号', exact: true }).click();
    await recipient.locator('#email').fill(email);
    await expect(recipient.getByRole('button', { name: '注册账号', exact: true })).toBeDisabled();
    await recipient.getByRole('button', { name: '发送验证码', exact: true }).click();
    const code = await until(
      async () => {
        const search = (await (
          await fetch(`${mailpitBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
        ).json()) as any;
        for (const item of search.messages ?? []) {
          const message = (await (
            await fetch(`${mailpitBase}/api/v1/message/${item.ID}`)
          ).json()) as any;
          const match = String(message.Text).match(/验证码[：:\s]+(\d{6})/);
          if (match) return match[1] as string;
        }
        return '';
      },
      Boolean,
      30000,
    );
    expect(await db.user.count({ where: { email } })).toBe(0);
    await recipient.locator('#register-code').fill(code);
    await recipient.locator('#username').fill(`url_${stamp}_signup`);
    await recipient.locator('#name').fill('链接注册验收');
    await recipient.locator('#register-identifier').fill(`E2E-${stamp}`);
    await recipient.locator('#password').fill('PublicInvitation2026!');
    await recipient.getByRole('button', { name: '注册账号', exact: true }).click();
    await expect(
      recipient.getByRole('heading', { name: '确认账号邀请', exact: true }),
    ).toBeVisible();
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    userIds.push(user.id);
    expect(user.verified).toBe(true);
    await expect(recipient).toHaveURL(invitation.url);
    await expect(recipient.getByRole('button', { name: '确认接受', exact: true })).toBeEnabled();
    expect(
      await recipient.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await recipient.screenshot({
      path: '.runtime/reports/authorization-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    expect(
      (await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedBy,
    ).toBeNull();
    await recipient.getByRole('button', { name: '确认接受', exact: true }).click();
    await expect(recipient).toHaveURL(/\/account$/);
    const accepted = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(accepted.verified).toBe(true);
    expect(accepted.isAdmin || accepted.isCoach).toBe(false);
    await expect(recipient.locator('.el-switch')).toHaveCount(0);
    expect(
      (await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedBy,
    ).toBe(user.id);
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});

test('pending administrator link can be withdrawn; teacher identity is confirmed by URL', async ({
  page,
  browser,
}) => {
  await administrator(page);
  await userRow(page, users.coach.email)
    .getByRole('button', { name: '邀请系统管理员', exact: true })
    .click();
  const pending = await generate(page);
  const invitations = page.locator('.panel .card').nth(1);
  await invitations
    .getByRole('row')
    .filter({ hasText: users.coach.email })
    .getByRole('button', { name: '撤销邀请', exact: true })
    .click();
  await expect(
    invitations
      .getByRole('row')
      .filter({ hasText: users.coach.email })
      .getByText('已撤销', { exact: true }),
  ).toBeVisible();
  const context = await browser.newContext(),
    recipient = await context.newPage();
  try {
    await recipient.goto(pending.url);
    await loginCurrent(recipient, users.coach.username);
    await expect(recipient.locator('.error-state')).toContainText('邀请已失效或被撤销');
    await expect(recipient.getByRole('button', { name: '确认接受', exact: true })).toHaveCount(0);
    await userRow(page, users.coach.email)
      .getByRole('button', { name: '邀请指导老师', exact: true })
      .click();
    const teacher = await generate(page);
    await recipient.goto(teacher.url);
    await expect(
      recipient.getByRole('heading', { name: '确认授权邀请', exact: true }),
    ).toBeVisible();
    expect((await db.user.findUniqueOrThrow({ where: { id: users.coach.id } })).isCoach).toBe(
      false,
    );
    await recipient.getByRole('button', { name: '确认接受', exact: true }).click();
    await expect(recipient).toHaveURL(/\/coach$/);
    await expect(
      recipient.getByRole('heading', { name: '指导老师中心', exact: true }),
    ).toBeVisible();
    expect((await db.user.findUniqueOrThrow({ where: { id: users.coach.id } })).isCoach).toBe(true);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await userRow(page, users.coach.email)
      .getByRole('button', { name: '撤销指导老师', exact: true })
      .click();
    await expect
      .poll(
        async () => (await db.user.findUniqueOrThrow({ where: { id: users.coach.id } })).isCoach,
      )
      .toBe(false);
  } finally {
    await context.close();
  }
});
