import { test, expect, type Page } from '@playwright/test';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';

const stamp = Date.now().toString(36),
  ids: string[] = [],
  emails: Record<string, string> = {};
test.beforeAll(async () => {
  const admin = await db.user.findUniqueOrThrow({ where: { username: 'admin' } });
  for (const kind of ['STUDENT', 'TEACHER']) {
    const email = `centers-${kind.toLowerCase()}-${stamp}@example.test`;
    const target = await db.user.create({
      data: {
        name: kind === 'TEACHER' ? '教师功能验收' : '学生功能验收',
        email,
        username: `centers_${kind.toLowerCase()}_${stamp}`,
        kind,
        verified: true,
        passwordHash: admin.passwordHash,
        profile:
          kind === 'TEACHER'
            ? {
                employee_id: `T-${stamp}`,
                employed_at: '2020-09-01',
                college: '测试院系',
                gender: '女',
              }
            : {
                student_id: `S-${stamp}`,
                enrollment_year: 2026,
                class_name: '测试班级',
                college: '测试学院',
                gender: '女',
              },
      },
    });
    ids.push(target.id);
    emails[kind] = email;
  }
});
test.beforeEach(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
async function login(page: Page, account: string) {
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test('personal destinations are peers and administrators have separate centers', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, 'alice');
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await expect(navigation.getByRole('link', { name: '首页', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: '活动及竞赛中心', exact: true })).toBeVisible();
  for (const [name, path] of [
    ['我的报名', '/registrations'],
    ['我的准考证', '/me/admissions'],
    ['我的附件', '/me/files'],
  ]) {
    await navigation.getByRole('link', { name: name!, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: name!, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: '返回竞赛', exact: true })).toHaveCount(0);
    await expect(page.locator('.personal-nav')).toHaveCount(0);
  }
  for (const name of [
    '活动及竞赛管理中心',
    '平台导出中心',
    '用户中心',
    '日志与任务中心',
    '审核中心',
  ])
    await expect(navigation.getByRole('link', { name, exact: true })).toHaveCount(0);
  await page.locator('.user-menu').click();
  await page.getByRole('menuitem', { name: '个人信息', exact: true }).click();
  await expect(page).toHaveURL(/\/me\/profile$/);
  await expect(page.locator('.personal-nav')).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/contests$/);
  await page.locator('.brand').click();
  await expect(page).toHaveURL(/\/$/);
  expect(errors).toEqual([]);
});
test('administrator centers group their tabs and fit desktop and mobile widths', async ({
  page,
}) => {
  await login(page, 'admin');
  for (const [name, tabs] of [
    ['活动及竞赛管理中心', ['活动及竞赛管理']],
    ['用户中心', ['学生视图', '教师视图', '用户与邀请', '管理员授权']],
    ['日志与任务中心', ['任务', '审计日志']],
    ['审核中心', ['实名审核']],
  ] as [string, string[]][]) {
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name, exact: true })
      .click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(tabs.length);
    for (const label of tabs)
      await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
  }
  await page.goto('/admin/users');
  await page.screenshot({
    path: '.runtime/reports/account-centers-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: '.runtime/reports/account-centers-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.goto('/admin?tab=students');
  await expect(page).toHaveURL(/\/admin\/users\?tab=students$/);
});
test('student and teacher details support editing, banning, unbanning and deleting', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, 'admin');
  for (const kind of ['STUDENT', 'TEACHER']) {
    const teacher = kind === 'TEACHER';
    await page.goto(`/admin/users?tab=${teacher ? 'teachers' : 'students'}`);
    await page.getByPlaceholder('姓名 / 邮箱', { exact: true }).fill(emails[kind]!);
    const row = page.getByRole('row').filter({ hasText: emails[kind]! });
    await row.getByRole('button', { name: '查看详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: / · (学生|教师)详情$/ });
    await dialog
      .getByRole('button', { name: `修改${teacher ? '教师' : '学生'}信息`, exact: true })
      .click();
    await dialog.locator('#admin-user-name').fill(`${teacher ? '教师' : '学生'}修改后`);
    await dialog.locator('#admin-user-college').fill('管理员修改院系');
    await dialog.getByRole('button', { name: '保存用户信息', exact: true }).click();
    await expect(dialog).toContainText('管理员修改院系');
    await expect(row).toContainText(`${teacher ? '教师' : '学生'}修改后`);
    await dialog.getByRole('button', { name: '封禁账号', exact: true }).click();
    await page.locator('.el-message-box input').fill('浏览器封禁测试');
    await page.getByRole('button', { name: '确认封禁', exact: true }).click();
    await expect(dialog).toContainText('浏览器封禁测试');
    await expect(row).toContainText('已封禁');
    await dialog.getByRole('button', { name: '解除封禁', exact: true }).click();
    await page.getByRole('button', { name: '确认解除', exact: true }).click();
    await expect(row).toContainText('正常');
    await page.screenshot({
      path: `.runtime/reports/account-detail-${kind.toLowerCase()}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: '删除账号', exact: true }).click();
    await page.locator('.el-message-box input').fill('删除账号');
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
