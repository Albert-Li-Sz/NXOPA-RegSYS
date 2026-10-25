import { editRegistration, approveRegistration, chooseInstitution } from './workflow-helpers.js';
import { test, expect, type Page, type Browser } from '@playwright/test';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema, defaultFields } from '../../packages/contracts/src/index.js';
const contestIds: string[] = [];
let admin: Client;
const stamp = Date.now();
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  await db.contest.updateMany({ where: { id: { in: contestIds } }, data: { archived: true } });
  await db.$disconnect();
});
async function contest(extra: Record<string, unknown>) {
  const c = await admin.api('/contests', 'POST', {
    title: `浏览器验收 ${stamp} ${contestIds.length}`,
    season: '界面验收',
    description: '虚构竞赛',
    location: '测试考点',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse(extra),
    fields: defaultFields,
  });
  contestIds.push(c.id);
  return c;
}
async function login(page: Page, account: string) {
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function actor(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, name);
  return { context, page };
}
async function create(page: Page, id: string) {
  await page.goto(`/contests/${id}`);
  await page.getByRole('button', { name: '立即报名', exact: true }).click();
  await expect(page).toHaveURL(/\/registrations\//);
  return new URL(page.url()).pathname.split('/').at(-1)!;
}
async function link(page: Page, name: string) {
  await editRegistration(page);
  const input = page.locator('.copy-link input');
  const old = (await input.count()) ? await input.inputValue() : '';
  await page.getByRole('button', { name, exact: true }).click();
  await expect(input).toBeVisible();
  await expect(input).not.toHaveValue(old);
  return input.inputValue();
}
async function confirmReceipt(page: Page, amountYuan: string) {
  const box = page.locator('.el-message-box');
  await expect(box).toBeVisible();
  await expect(box).toContainText(`¥ ${Number(amountYuan).toFixed(2)}`);
  await expect(box.locator('input:visible,textarea:visible')).toHaveCount(0);
  await box.getByRole('button', { name: '确定', exact: true }).click();
  await expect(box).not.toBeVisible();
}
test('three invited members, required teacher confirmation, teacher submits, unlink revokes access', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const c = await contest({
    mode: 'TEAM',
    memberMode: 'INVITE',
    minMembers: 3,
    maxMembers: 3,
    coachMode: 'REQUIRED',
  });
  const owner = await actor(browser, 'alice'),
    member = await actor(browser, 'bob'),
    third = await actor(browser, 'carol'),
    teacher = await actor(browser, 'teacher'),
    manager = await actor(browser, 'admin');
  try {
    const id = await create(owner.page, c.id);
    await owner.page.locator('#team-name').fill('浏览器邀请团队');
    await owner.page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(owner.page.getByText('报名草稿已保存')).toBeVisible();
    for (const person of [member, third]) {
      const invite = await link(owner.page, '生成成员邀请链接');
      await person.page.goto(invite);
      await person.page.getByRole('button', { name: '确认接受' }).click();
      await expect(person.page).toHaveURL(new RegExp(`/registrations/${id}$`));
      await owner.page.getByRole('button', { name: '刷新状态' }).click();
    }
    const invite = await link(owner.page, '邀请老师确认');
    await teacher.page.goto(invite);
    await teacher.page.getByRole('button', { name: '确认接受' }).click();
    await expect(teacher.page).toHaveURL(new RegExp(`/registrations/${id}$`));
    await editRegistration(teacher.page);
    await expect(teacher.page.locator('#team-name')).toBeEnabled();
    await teacher.page.locator('#team-english').fill('Teacher submitted team');
    await teacher.page.getByRole('button', { name: '提交报名', exact: true }).click();
    await expect(teacher.page.getByText('已提交', { exact: true })).toBeVisible();
    await manager.page.goto(`/registrations/${id}`);
    await approveRegistration(manager.page);
    await expect(manager.page.getByText('参加资格已确认', { exact: true })).toBeVisible();
    await owner.page.getByRole('button', { name: '刷新状态' }).click();
    await editRegistration(owner.page);
    await owner.page.getByRole('button', { name: '解除关联', exact: true }).click();
    await expect(owner.page.getByText('参加资格待完成', { exact: true })).toBeVisible();
    await teacher.page.reload();
    await expect(
      teacher.page.getByText('没有此报名的访问权限', { exact: true }).first(),
    ).toBeVisible();
  } finally {
    for (const a of [owner, member, third, teacher, manager]) await a.context.close();
  }
});
test('manual team, optional teacher, review first, receipt and partial/full confirmation', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const c = await contest({
    mode: 'TEAM',
    memberMode: 'MANUAL',
    minMembers: 3,
    maxMembers: 3,
    coachMode: 'OPTIONAL',
    feeMode: 'PER_PERSON',
    feeCents: 1000,
    paymentSequence: 'REVIEW_FIRST',
  });
  const owner = await actor(browser, 'alice'),
    manager = await actor(browser, 'admin');
  try {
    const id = await create(owner.page, c.id);
    await owner.page.locator('#team-name').fill('浏览器代填团队');
    for (const index of [1, 2]) {
      await owner.page.getByRole('button', { name: '添加代填成员' }).click();
      await owner.page.locator(`#person-${index}-name`).fill(`代填选手${index}`);
      await chooseInstitution(owner.page, `#member-${index}-school`, '南京晓庄学院');
      await owner.page.locator(`#member-${index}-student_id`).fill(`E2E-${stamp}-${index}`);
      await owner.page.locator(`#member-${index}-phone`).fill('00000000000');
      await owner.page.locator(`#member-${index}-class_name`).fill('验收一班');
      await owner.page.locator(`#member-${index}-college`).fill('验收学院');
      await owner.page
        .locator('.el-form-item')
        .filter({ has: owner.page.locator(`#member-${index}-gender`) })
        .locator('.el-select')
        .click();
      await owner.page.getByRole('option', { name: '男', exact: true }).click();
      await expect(owner.page.getByRole('option', { name: '男', exact: true })).toHaveCount(0);
    }
    await owner.page.getByRole('button', { name: '提交报名', exact: true }).click();
    await expect(owner.page.getByText('已提交', { exact: true })).toBeVisible();
    await manager.page.goto(`/registrations/${id}`);
    await approveRegistration(manager.page);
    await expect(manager.page.getByText('参加资格待完成', { exact: true })).toBeVisible();
    for (const amount of [10, 20]) {
      await owner.page.goto(`/registrations/${id}?tab=finance`);
      await owner.page.getByRole('button', { name: '上传收款凭证', exact: true }).click();
      const dialog = owner.page.getByRole('dialog');
      await dialog.getByRole('spinbutton').fill(String(amount));
      await dialog
        .locator('.el-form-item')
        .filter({ hasText: '付款人' })
        .getByRole('textbox')
        .fill('示例队长');
      await dialog
        .locator('.el-form-item')
        .filter({ hasText: '流水 / 参考号' })
        .getByRole('textbox')
        .fill(`E2E-${stamp}-${amount}`);
      await dialog.locator('input[type=file]').setInputFiles({
        name: 'proof.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(`offline proof ${stamp}-${amount}`),
      });
      await dialog.getByRole('button', { name: '提交凭证' }).click();
      await expect(dialog).not.toBeVisible();
      await manager.page.goto(`/registrations/${id}?tab=finance`);
      await manager.page.getByRole('button', { name: '核账', exact: true }).click();
      await confirmReceipt(manager.page, String(amount));
      await expect(
        manager.page.getByText(amount === 20 ? '参加资格已确认' : '参加资格待完成', {
          exact: true,
        }),
      ).toBeVisible();
    }
    const r = await admin.api(`/registrations/${id}`);
    expect(r.netPaidCents).toBe(3000);
    expect(r.people).toHaveLength(3);
    expect(r.coaches).toHaveLength(0);
  } finally {
    await owner.context.close();
    await manager.context.close();
  }
});
test('payment first blocks review until actual receipt confirmation', async ({ browser }) => {
  const c = await contest({
    feeMode: 'FIXED',
    feeCents: 2000,
    paymentSequence: 'PAYMENT_FIRST',
    coachMode: 'DISABLED',
  });
  const owner = await actor(browser, 'bob'),
    manager = await actor(browser, 'admin');
  try {
    const id = await create(owner.page, c.id);
    await owner.page.getByRole('button', { name: '提交报名', exact: true }).click();
    await expect(owner.page.getByText('已提交', { exact: true })).toBeVisible();
    await manager.page.goto(`/registrations/${id}`);
    await manager.page.getByRole('button', { name: '审核报名', exact: true }).click();
    await expect(
      manager.page.getByRole('dialog').getByRole('button', { name: '确认审核', exact: true }),
    ).toBeDisabled();
    await expect(
      manager.page.getByText('此活动要求先确认足额到账；目前可退回补正或拒绝，暂不能审核通过', {
        exact: true,
      }),
    ).toBeVisible();
    await manager.page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await owner.page.goto(`/registrations/${id}?tab=finance`);
    await owner.page.getByRole('button', { name: '上传收款凭证', exact: true }).click();
    const dialog = owner.page.getByRole('dialog');
    await dialog.getByRole('spinbutton').fill('20');
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '付款人' })
      .getByRole('textbox')
      .fill('示例选手');
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '流水 / 参考号' })
      .getByRole('textbox')
      .fill(`prepay-ui-${stamp}`);
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'receipt.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('offline receipt'),
    });
    await dialog.getByRole('button', { name: '提交凭证' }).click();
    await expect(dialog).not.toBeVisible();
    await manager.page.goto(`/registrations/${id}?tab=finance`);
    await manager.page.getByRole('button', { name: '核账', exact: true }).click();
    await confirmReceipt(manager.page, '20');
    await expect(manager.page.getByText('参加资格待完成', { exact: true })).toBeVisible();
    await manager.page.getByRole('tab', { name: '报名资料', exact: true }).click();
    await approveRegistration(manager.page);
    await expect(manager.page.getByText('参加资格已确认', { exact: true })).toBeVisible();
  } finally {
    await owner.context.close();
    await manager.context.close();
  }
});
