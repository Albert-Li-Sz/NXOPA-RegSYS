import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

let admin: Client, contestId: string;
const extraContests: string[] = [];
const evidence = process.env.UI_QA_OUTPUT_DIR ?? path.join(tmpdir(), 'contest-center-controls');
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  const alice = await new Client().login('alice');
  await alice.completeProfile();
  const contest = await admin.api('/contests', 'POST', {
    title: `按钮与键盘交互验收 ${Date.now()}`,
    season: '界面回归',
    description: '仅限隔离测试环境的虚构资料',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({ coachMode: 'DISABLED', manualReview: false }),
    fields: [],
  });
  contestId = contest.id;
  const registration = await alice.api('/registrations', 'POST', { contestId });
  await alice.api(`/registrations/${registration.id}/submit`, 'POST', {
    version: registration.version,
  });
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  if (contestId)
    await db.contest.updateMany({
      where: { id: { in: [contestId, ...extraContests] } },
      data: { archived: true },
    });
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
async function assertControls(page: Page) {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.locator('a button, button a, button button')).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const groups = await page
    .locator(
      '.actions, .button-group:not(.pdf-controls), .el-dialog__footer, .el-message-box__btns',
    )
    .evaluateAll((elements) =>
      elements.map((element) => ({
        name: element.className,
        buttons: [
          ...element.querySelectorAll<HTMLElement>('.el-button:not(.is-text):not(.is-link)'),
        ]
          .filter((button) => button.getBoundingClientRect().width > 0)
          .map((button) => {
            const box = button.getBoundingClientRect();
            return {
              text: button.innerText.trim(),
              width: box.width,
              height: box.height,
              left: box.left,
              top: box.top,
            };
          }),
      })),
    );
  for (const group of groups.filter((group) => group.buttons.length > 1)) {
    const widths = group.buttons.map((button) => button.width);
    expect(Math.max(...widths) - Math.min(...widths), JSON.stringify(group)).toBeLessThanOrEqual(1);
    if (group.buttons.length === 2) {
      const [first, second] = group.buttons;
      expect(
        Math.abs(first!.top - second!.top) <= 1 || Math.abs(first!.left - second!.left) <= 1,
        JSON.stringify(group),
      ).toBe(true);
    }
  }
}

for (const width of [1440, 390, 360]) {
  test(`action groups, table controls and review dialogs remain aligned at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page);
    for (const route of [
      '/admin?tab=site',
      '/admin?tab=tokens',
      '/admin?tab=mail',
      '/overview',
      `/admin/contests/${contestId}`,
      `/admin/contests/${contestId}?tab=rooms`,
      `/admin/contests/${contestId}?tab=registrations`,
    ]) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('main.page h1')).not.toBeEmpty();
      await expect(page.getByText('竞赛配置加载失败', { exact: true })).toHaveCount(0);
      await assertControls(page);
    }
    await expect(page.getByRole('button', { name: '删除活动', exact: true })).toBeDisabled();
    await expect(page.locator('.action-control .form-help')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^无法删除：.*报名/ })).toBeVisible();
    await page
      .getByRole('button', { name: /^(审核|修改审核)$/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: '修改审核', exact: true });
    await expect(dialog).toBeVisible();
    await assertControls(page);
    await page.screenshot({
      path: path.join(evidence, `review-dialog-${width}.png`),
      animations: 'disabled',
    });
    await dialog
      .locator('.el-dialog__footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test('password and OAuth entry controls have equal dimensions and one interactive target', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/v1/auth/providers', (route) =>
    route.fulfill({
      json: { github: { enabled: true, linked: false }, feishu: { enabled: true, linked: false } },
    }),
  );
  await page.goto('/login');
  const submit = page.getByRole('button', { name: '登录', exact: true });
  const github = page.getByRole('link', { name: '使用 GitHub 登录', exact: true });
  const feishu = page.getByRole('link', { name: '使用飞书登录', exact: true });
  await expect(github).toBeVisible();
  await expect(feishu).toBeVisible();
  const boxes = await Promise.all([submit, github, feishu].map((control) => control.boundingBox()));
  expect(
    boxes.every(
      (box) =>
        box &&
        Math.abs(box.height - boxes[0]!.height) <= 1 &&
        Math.abs(box.width - boxes[0]!.width) <= 1 &&
        Math.abs(box.x - boxes[0]!.x) <= 1,
    ),
  ).toBe(true);
  await assertControls(page);
  await page.screenshot({
    path: path.join(evidence, 'login-providers-mobile.png'),
    animations: 'disabled',
  });
});

test('keyboard navigation has visible focus and reduced motion respects the system preference', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const enter = page.getByRole('link', { name: '进入报名系统', exact: true });
  await enter.focus();
  await expect(enter).toBeFocused();
  const style = await enter.evaluate((button) => {
    const value = getComputedStyle(button);
    return {
      outline: value.outlineStyle,
      width: parseFloat(value.outlineWidth),
      transitions: value.transitionDuration
        .split(',')
        .map((duration) => parseFloat(duration) * 1000),
    };
  });
  expect(style.outline).toBe('solid');
  expect(style.width).toBeGreaterThanOrEqual(2);
  expect(Math.max(...style.transitions)).toBeLessThanOrEqual(0.1);
  await page.keyboard.press('Tab');
  await expect(
    page.locator('.hero-actions').getByRole('link', { name: '创建账号', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/login\?mode=register/);
  await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
});

test('a pending action keeps its dimensions, rejects duplicate clicks and returns usable feedback', async ({
  page,
}) => {
  await login(page);
  await page.goto('/admin?tab=mail');
  const send = page.getByRole('button', { name: '发送测试邮件', exact: true });
  await expect(send).toBeEnabled();
  const before = await send.boundingBox();
  let release!: () => void,
    started!: () => void,
    requests = 0;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/admin/mail/test', async (route) => {
    requests++;
    started();
    await hold;
    await route.fulfill({ json: { jobId: 'control-feedback', to: 'admin@example.test' } });
  });
  await page.route('**/api/v1/admin/mail/tests/control-feedback', (route) =>
    route.fulfill({
      json: { state: 'SUCCESS', result: { providerName: '本地测试 SMTP' } },
    }),
  );
  try {
    await send.click();
    await ready;
    await expect(send).toBeDisabled();
    const during = await send.boundingBox();
    expect(during!.width).toBeCloseTo(before!.width, 0);
    expect(during!.height).toBeCloseTo(before!.height, 0);
    await page.mouse.click(during!.x + during!.width / 2, during!.y + during!.height / 2);
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(send).toBeEnabled();
  await expect(page.getByText(/测试邮件发送成功（本地测试 SMTP）/)).toBeVisible();
});

test('disabled module links select an available tab without mounting inactive operations', async ({
  page,
}) => {
  const contest = await admin.api('/contests', 'POST', {
    title: `关闭功能入口验收 ${Date.now()}`,
    season: '界面回归',
    description: '虚构资料',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    modules: { admissions: false, rooms: false, integrations: false },
    policy: policySchema.parse({ coachMode: 'DISABLED' }),
    fields: [],
  });
  extraContests.push(contest.id);
  await login(page);
  const inactive: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/v1/contests/${contest.id}/rooms`)
      inactive.push(request.url());
  });
  for (const tab of ['rooms', 'templates', 'integrations', 'unknown']) {
    await page.goto(`/admin/contests/${contest.id}?tab=${tab}`);
    await expect(page.getByRole('tab', { name: '活动设置', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: '新增考场', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^(默认导出|导出平台导入包)$/, exact: true }),
    ).toHaveCount(0);
  }
  await page.goto('/admin/contests/new?tab=rooms');
  await expect(page.getByRole('tab', { name: '活动设置', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: '新增考场', exact: true })).toHaveCount(0);
  expect(inactive).toEqual([]);
});

test('closed public rosters clear stale people and export actions while allowing recovery', async ({
  page,
}) => {
  await db.contest.update({ where: { id: contestId }, data: { publicRosterEnabled: true } });
  const rows = page.locator('.el-table__body-wrapper tr.el-table__row');
  const exported = page.getByRole('link', { name: '导出名单', exact: true });
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    await page.goto(`/contests/${contestId}/public-teams`);
    await expect(rows).toHaveCount(1);
    await expect(exported).toBeVisible();
    await db.contest.update({ where: { id: contestId }, data: { publicRosterEnabled: false } });
    await page.route(
      `**/api/v1/contests/${contestId}/public-teams?**`,
      async (route) => {
        started();
        await hold;
        await route.continue();
      },
      { times: 1 },
    );
    await page.getByPlaceholder('搜索队名 / 英文队名').fill('关闭公示');
    await ready;
    await expect(rows).toHaveCount(0);
    await expect(exported).toHaveCount(0);
    release();
    await expect(
      page.locator('main .el-alert').filter({ hasText: '此竞赛未开放队伍公示' }),
    ).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect(exported).toHaveCount(0);
    await page.screenshot({
      path: path.join(evidence, 'public-roster-closed.png'),
      animations: 'disabled',
    });
    await db.contest.update({ where: { id: contestId }, data: { publicRosterEnabled: true } });
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(exported).toBeVisible();
    await page.getByPlaceholder('搜索队名 / 英文队名').fill('');
    await expect(rows).toHaveCount(1);
  } finally {
    release?.();
    await db.contest.update({ where: { id: contestId }, data: { publicRosterEnabled: false } });
  }
});
