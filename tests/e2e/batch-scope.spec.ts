import { test, expect, type Page } from '@playwright/test';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

let admin: Client, alice: Client, bob: Client;
const ids: string[] = [];
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  alice = await new Client().login('alice');
  bob = await new Client().login('bob');
});
test.afterAll(async () => {
  await db.contest.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  await db.$disconnect();
});
async function setup(page: Page, manualReview = false) {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const c = await admin.api('/contests', 'POST', {
    title: `批量范围核对 ${Date.now()}`,
    season: '流程验收',
    description: '筛选请求及连续审核回归',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ coachMode: 'DISABLED', manualReview }),
    fields: [],
  });
  ids.push(c.id);
  const registrations = [];
  for (const user of [alice, bob]) {
    const r = await user.api('/registrations', 'POST', { contestId: c.id });
    registrations.push(
      await user.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version }),
    );
  }
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
  await page.goto(`/admin/contests/${c.id}?tab=registrations`);
  await expect(page.getByRole('row').filter({ hasText: alice.user.name })).toBeVisible();
  return { c, registrations };
}

for (const filter of ['search', 'review'] as const) {
  test(`${filter} changes block stale batch actions during debounce, pending requests and failures`, async ({
    page,
  }) => {
    await setup(page);
    const generate = page.getByRole('button', { name: '批量生成准考证', exact: true });
    const download = page.getByRole('button', { name: '下载准考证 ZIP', exact: true });
    await expect(generate).toBeEnabled();
    await page
      .getByRole('row')
      .filter({ hasText: alice.user.name })
      .locator('.el-checkbox')
      .click();
    let release!: () => void, ready!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    await page.route('**/api/v1/registrations?**', async (route) => {
      ready();
      await pending;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: '筛选结果加载失败' }),
      });
    });
    try {
      if (filter === 'search') {
        const immediatelyDisabled = await page
          .getByPlaceholder('搜索姓名或队名')
          .evaluate(async (input) => {
            (input as HTMLInputElement).value = '没有匹配结果';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            return [...document.querySelectorAll('button')]
              .filter((button) =>
                ['批量生成准考证', '下载准考证 ZIP'].includes(button.textContent!.trim()),
              )
              .every((button) => button.disabled);
          });
        expect(immediatelyDisabled).toBe(true);
      } else {
        await page.locator('.el-select').filter({ hasText: '审核状态' }).click();
        await page.getByRole('option', { name: '等待审核', exact: true }).click();
      }
      await started;
      await expect(generate).toBeDisabled();
      await expect(download).toBeDisabled();
      await expect(page.locator('tbody tr.el-table__row')).toHaveCount(0);
    } finally {
      release();
    }
    const error = page.locator('.el-alert').filter({ hasText: '筛选结果加载失败' });
    await expect(error).toBeVisible();
    await expect(generate).toBeDisabled();
    await expect(download).toBeDisabled();
    await expect(page.locator('tbody tr.el-table__row')).toHaveCount(0);
    await page.unroute('**/api/v1/registrations?**');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(error).not.toBeVisible();
    await expect(page.locator('tbody tr.el-table__row')).toHaveCount(0);
    await expect(generate).toBeDisabled();
    await expect(download).toBeDisabled();
  });
}

test('review-and-next network failures retain the saved result and recover from the list', async ({
  page,
}) => {
  const {
    registrations: [first, second],
  } = await setup(page, true);
  await page.route(`**/api/v1/registrations/${second.id}?history=false`, (route) =>
    route.abort('failed'),
  );
  await page
    .getByRole('row')
    .filter({ hasText: alice.user.name })
    .getByRole('button', { name: '审核', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '报名审核', exact: true });
  await dialog.getByRole('button', { name: '审核并查看下一条', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const recovery = page.locator('.el-alert').filter({ hasText: /审核已保存.*下一条.*失败/ });
  await expect(recovery).toBeVisible();
  expect((await admin.api(`/registrations/${first.id}`)).review).toBe('APPROVED');
  expect((await admin.api(`/registrations/${second.id}`)).review).toBe('PENDING');
  await recovery.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(recovery).not.toBeVisible();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: alice.user.name })
      .getByRole('button', { name: '修改审核', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('row')
    .filter({ hasText: bob.user.name })
    .getByRole('button', { name: '审核', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '报名审核', exact: true })).toContainText(
    bob.user.name,
  );
});
