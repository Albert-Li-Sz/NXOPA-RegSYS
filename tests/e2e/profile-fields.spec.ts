import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Client } from '../integrations/client.js';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import {
  defaultFields,
  maximumEnrollmentYear,
  policySchema,
} from '../../packages/contracts/src/index.js';
import { chooseInstitution, editRegistration } from './workflow-helpers.js';
let admin: Client, owner: Client, contestId: string, registrationId: string, userId: string;
const username = `year_ui_${Date.now()}`,
  email = `${username}@example.test`;
const profile = {
  student_id: '0020260088',
  class_name: '一班',
  college: '信息学院',
  gender: '男',
  phone: '00000000000',
  school: '原有培训单位',
  enrollment_year: '2023级',
};
async function login(page: Page, account: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  admin = await new Client().login('admin');
  const source = await db.user.findUniqueOrThrow({ where: { id: admin.user.id } });
  const user = await db.user.create({
    data: {
      username,
      email,
      name: '年份选择验收',
      verified: true,
      passwordHash: source.passwordHash,
      profile: json(profile),
    },
  });
  userId = user.id;
  owner = await new Client().login(username);
  const c = await admin.api('/contests', 'POST', {
    title: '资料与排版浏览器验收',
    season: '2026',
    description: '资料和布局',
    published: true,
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    policy: policySchema.parse({
      mode: 'TEAM',
      memberMode: 'MANUAL',
      minMembers: 1,
      maxMembers: 4,
      coachMode: 'DISABLED',
    }),
    fields: defaultFields,
  });
  contestId = c.id;
  registrationId = (await owner.api('/registrations', 'POST', { contestId })).id;
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  if (contestId) await db.contest.update({ where: { id: contestId }, data: { archived: true } });
  await db.$disconnect();
  await redis.quit();
});

test('registration uses a year picker, allows next year and labels staff identifiers correctly', async ({
  page,
}) => {
  await page.goto('/login?mode=register');
  const year = page.locator('#register-year');
  await year.click();
  const panel = page.locator('.el-picker-panel:visible');
  await expect(
    panel.locator('td').filter({ hasText: String(maximumEnrollmentYear() + 1) }),
  ).toHaveClass(/disabled/);
  await panel.getByText(String(maximumEnrollmentYear()), { exact: true }).click();
  await expect(year).toHaveValue(String(maximumEnrollmentYear()));
  await page.locator('.el-radio-button').filter({ hasText: '教师' }).click();
  await expect(page.locator('label[for="register-identifier"]')).toHaveText('职工号');
  await expect(year).toHaveCount(0);
  await expect(page.locator('#register-employment')).toBeVisible();
});

test('legacy years and institutions render, searchable selections save and account email appears once', async ({
  page,
}) => {
  await db.user.update({
    where: { id: userId },
    data: { profile: json(profile), identityStatus: 'UNSUBMITTED', version: { increment: 1 } },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, username);
  await page.goto('/account');
  await expect(page.locator('#profile-email')).toHaveValue(email);
  await expect(page.locator('input[type="email"]')).toHaveCount(1);
  await expect(page.locator('#profile-enrollment_year')).toHaveValue('2023');
  await expect(
    page
      .locator('#profile-school')
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]'),
  ).toContainText('原有培训单位');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await chooseInstitution(page, '#profile-school', '南京晓庄学院');
  await page.locator('#profile-enrollment_year').click();
  await page
    .locator('.el-picker-panel:visible')
    .getByText(String(maximumEnrollmentYear()), { exact: true })
    .click();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByText('资料已保存', { exact: true })).toBeVisible();
  const saved = await db.user.findUniqueOrThrow({ where: { id: userId } });
  expect(saved.profile).toMatchObject({
    school: '南京晓庄学院',
    enrollment_year: maximumEnrollmentYear(),
    student_id: '0020260088',
  });
  expect(errors).toEqual([]);
});

test('administrators can add and find institution aliases and cancel unsaved edits', async ({
  page,
}) => {
  await login(page, 'admin');
  await page.goto('/admin?tab=institutions');
  await page.getByRole('button', { name: '添加单位', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^(添加|编辑)院校或单位$/ });
  const name = `浏览器单位 ${randomUUID().slice(0, 8)}`;
  await dialog.locator('#institution-name').fill(name);
  await dialog.locator('#institution-aliases').fill(`别名${name}`);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('textbox', { name: '搜索院校与单位' }).fill(`别名${name}`);
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.locator('#institution-aliases').fill('未保存别名');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

for (const width of [1440, 390])
  test(`activity values align next to labels and bound email is readonly at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, username);
    await page.goto(`/contests/${contestId}`);
    await expect(page.locator('.season-info')).toBeVisible();
    const geometry = await page.locator('.info-row').evaluateAll((rows) =>
      rows.map((row) => {
        const [label, value] = [...row.children].map((element) => element.getBoundingClientRect());
        return { label: label!.left, right: label!.right, value: value!.left };
      }),
    );
    expect(geometry.length).toBe(4);
    for (const item of geometry) {
      expect(item.value - item.right).toBeGreaterThanOrEqual(16);
      expect(item.value - item.right).toBeLessThanOrEqual(24);
      expect(item.value).toBeCloseTo(geometry[0]!.value);
    }
    await expect(page.locator('.info-row .muted').nth(2)).toHaveText('费　　用');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.goto(`/registrations/${registrationId}`);
    await editRegistration(page);
    await expect(page.locator('#person-0-email')).toHaveValue(email);
    await expect(page.locator('#person-0-email')).toBeDisabled();
    await expect(page.locator('#member-0-email')).toHaveCount(0);
  });
