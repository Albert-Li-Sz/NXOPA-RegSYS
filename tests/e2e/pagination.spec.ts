import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';
let admin: Client, alice: Client, bob: Client;
const run = Date.now(),
  ids: string[] = [],
  grants: string[] = [];
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  alice = await new Client().login('alice');
  bob = await new Client().login('bob');
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  await db.contest.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  await db.adminGrant.updateMany({
    where: { id: { in: grants } },
    data: { revokedAt: new Date() },
  });
  await db.$disconnect();
});
async function login(page: Page, account = 'admin') {
  await page.goto('/login');
  await page.locator('#account').fill(account);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function contest(extra: Record<string, unknown> = {}) {
  const c = await admin.api('/contests', 'POST', {
    title: `分页验收 ${run} ${ids.length}`,
    description: '分页与统计的独立测试数据',
    season: `分页验收 ${run}`,
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({ coachMode: 'DISABLED' }),
    fields: [],
    ...extra,
  });
  ids.push(c.id);
  return c;
}
test('activity management paginates authorized activities and counts people rather than teams or drafts', async ({
  page,
}) => {
  const c = await contest({
    policy: policySchema.parse({
      mode: 'TEAM',
      memberMode: 'MANUAL',
      minMembers: 2,
      maxMembers: 3,
      allowUnofficial: true,
      coachMode: 'DISABLED',
    }),
  });
  async function team(client: Client, participationType: string) {
    let r = await client.api('/registrations', 'POST', { contestId: c.id });
    r = await client.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      version: r.version,
      teamName: participationType,
      participationType,
      people: [
        ...r.people,
        {
          name: '代填成员',
          email: 'member@example.test',
          captain: false,
          confirmed: true,
          answers: {},
        },
      ],
    });
    return client.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  }
  const official = await team(alice, 'OFFICIAL');
  let unofficial = await team(bob, 'UNOFFICIAL');
  await admin.api('/registrations', 'POST', { contestId: c.id });
  for (let i = 0; i < 22; i++) await contest();
  const path = `/contests?all=true&managed=true&page=1&pageSize=20&search=${encodeURIComponent(`分页验收 ${run}`)}`;
  const first = await admin.api(path),
    second = await admin.api(path.replace('page=1', 'page=2'));
  expect(first.items).toHaveLength(20);
  expect(first.total).toBe(23);
  expect(second.items).toHaveLength(3);
  expect(first.items.some((a: any) => second.items.some((b: any) => b.id === a.id))).toBe(false);
  const all = await admin.api(path.replace('pageSize=20', 'pageSize=50'));
  expect(all.items.find((row: any) => row.id === c.id).registrationCounts).toEqual({
    official: 2,
    unofficial: 2,
  });
  expect((await bob.api(path)).total).toBe(0);
  const grant = await admin.api('/admin/grants', 'POST', {
    userId: bob.user.id,
    level: 'CONTEST',
    contestId: c.id,
    permissions: ['VIEW'],
  });
  grants.push(grant.id);
  const scoped = await bob.api(path);
  expect(scoped.total).toBe(1);
  expect(scoped.items[0].id).toBe(c.id);
  unofficial = await admin.api(`/registrations/${unofficial.id}/review`, 'POST', {
    version: unofficial.version,
    decision: 'CORRECTION',
    reason: '人数仍计入已提交报名',
  });
  await login(page);
  await page.goto('/admin/contests');
  await page.getByPlaceholder('搜索活动或赛季').fill(`分页验收 ${run}`);
  const rows = page.locator('.el-table__body-wrapper tbody tr.el-table__row'),
    pager = page.locator('.list-pagination');
  await expect(rows).toHaveCount(20);
  await pager.locator('.btn-next').click();
  await expect(rows).toHaveCount(3);
  await pager.locator('.el-select__wrapper').click();
  await page.getByRole('option', { name: /^50\s*条/ }).click();
  await expect(rows).toHaveCount(23);
  const row = rows.filter({ hasText: c.title });
  await expect(row.getByText('正式 2 人', { exact: true })).toBeVisible();
  await expect(row.getByText('非正式 2 人', { exact: true })).toBeVisible();
  await page.reload();
  await expect(pager).toContainText('50条/页');
  await page.getByPlaceholder('搜索活动或赛季').fill(`分页验收 ${run}`);
  await expect(rows).toHaveCount(23);
  await alice.api(`/registrations/${official.id}/cancel`, 'POST', { version: official.version });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(
    rows.filter({ hasText: c.title }).getByText('正式 0 人', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 831, height: 883 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(832);
  await page.screenshot({
    path: '.runtime/reports/pagination-activities.png',
    fullPage: true,
    animations: 'disabled',
  });
});
test('attachment paging searches every record and falls back when the last row is deleted', async ({
  page,
}) => {
  for (let i = 0; i < 21; i++) {
    const body = new FormData();
    body.append(
      'file',
      new Blob([`附件 ${i}`], { type: 'text/plain' }),
      `pagination-${run}-${i}.txt`,
    );
    await alice.api('/files?purpose=PERSONAL', 'POST', body);
  }
  await login(page, 'alice');
  await page.goto('/me/files');
  await page.getByPlaceholder('搜索文件名称').fill(`pagination-${run}`);
  const root = page.locator('.file-library'),
    rows = root.locator('tbody tr.el-table__row'),
    pager = root.locator('.list-pagination');
  await expect(rows).toHaveCount(20);
  await pager.locator('.btn-next').click();
  await expect(rows).toHaveCount(1);
  await rows.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.el-message-box').getByRole('button', { name: '确定', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(pager.locator('.el-pager li.is-active')).toHaveText('1');
  await pager.locator('.el-select__wrapper').click();
  await page.getByRole('option', { name: /^50\s*条/ }).click();
  await page.reload();
  await expect(pager).toContainText('50条/页');
});
test('field configuration uses global row identity and preserves edits across pages', async ({
  page,
}) => {
  const fields = Array.from({ length: 22 }, (_, i) => ({
    key: `f${i + 1}`,
    label: `分页字段${i + 1}`,
    scope: 'PERSON',
    type: 'text',
    required: true,
    options: [],
  }));
  const c = await contest({ fields });
  await login(page);
  await page.goto(`/admin/contests/${c.id}?tab=fields`);
  const root = page.locator('[data-pagination-key="contesteditor-form-fields"]'),
    rows = root.locator('tbody tr.el-table__row');
  await expect(rows).toHaveCount(20);
  await root.locator('.btn-next').click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await rows
    .filter({ hasText: '分页字段21' })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '编辑报名字段', exact: true });
  await dialog
    .getByText('显示名称', { exact: true })
    .locator('..')
    .locator('input')
    .fill('跨页修改第21项');
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await expect(rows.filter({ hasText: '跨页修改第21项' })).toHaveCount(1);
  await root.locator('.btn-prev').click();
  await expect(rows.first()).toContainText('分页字段1');
  await root.locator('.btn-next').click();
  await expect(rows.first()).toContainText('跨页修改第21项');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(rows.first()).toContainText('分页字段21');
  expect((await admin.api(`/contests/${c.id}`)).fields[20].label).toBe('分页字段21');
});
test('long entry forms retain answers across pages and submit the complete form', async ({
  page,
}) => {
  const fields = Array.from({ length: 22 }, (_, i) => ({
    key: `a${i + 1}`,
    label: `填写项目${i + 1}`,
    scope: 'PERSON',
    type: 'text',
    required: true,
    options: [],
  }));
  const c = await contest({ fields });
  const r = await alice.api('/registrations', 'POST', { contestId: c.id });
  await login(page, 'alice');
  await page.goto(`/registrations/${r.id}?edit=1`);
  const root = page.locator('[data-pagination-key="dynamic-fields-PERSON"]');
  await expect(root.locator('.el-form-item')).toHaveCount(20);
  for (let i = 1; i <= 20; i++) await page.locator(`#member-0-a${i}`).fill(`答案${i}`);
  await root.locator('.btn-next').click();
  await expect(root.locator('.el-form-item')).toHaveCount(2);
  await page.locator('#member-0-a21').fill('答案21');
  await page.locator('#member-0-a22').fill('答案22');
  await root.locator('.btn-prev').click();
  await expect(page.locator('#member-0-a1')).toHaveValue('答案1');
  await page.getByRole('button', { name: '提交报名', exact: true }).click();
  await expect(page.getByText('报名已提交', { exact: true })).toBeVisible();
  const saved = await alice.api(`/registrations/${r.id}`);
  for (let i = 1; i <= 22; i++) expect(saved.people[0].answers[`a${i}`]).toBe(`答案${i}`);
  const readout = page.locator('[data-pagination-key="readout-fields-PERSON"]');
  await expect(readout.locator('dt')).toHaveCount(20);
  await readout.locator('.btn-next').click();
  await expect(readout).toContainText('答案22');
});
test('seating selections survive local and server page changes', async ({ page }) => {
  const c = await contest({
    modules: { admissions: true, rooms: true, integrations: false },
    policy: policySchema.parse({ coachMode: 'DISABLED', manualReview: false }),
  });
  for (let i = 1; i <= 22; i++) {
    const uid = randomUUID();
    await db.user.create({
      data: {
        id: uid,
        username: `page-${run}-${i}`,
        email: `page-${run}-${i}@example.test`,
        name: `分页成员${i}`,
        verified: true,
      },
    });
    await db.registration.create({
      data: {
        contestId: c.id,
        ownerId: uid,
        number: i,
        formVersion: c.formVersion,
        status: 'SUBMITTED',
        review: 'APPROVED',
        eligible: true,
        submittedAt: new Date(),
        people: {
          create: {
            contestId: c.id,
            userId: uid,
            name: `分页成员${i}`,
            email: `page-${run}-${i}@example.test`,
            captain: true,
            confirmed: true,
          },
        },
      },
    });
  }
  await admin.api(`/contests/${c.id}/rooms`, 'POST', { name: '分页测试考场', capacity: 30 });
  await login(page);
  await page.goto(`/admin/contests/${c.id}?tab=rooms`);
  await page.getByRole('button', { name: '自动排考预览', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '排考预览与确认', exact: true });
  await dialog.getByText('仅已勾选（0 份）', { exact: true }).click();
  const root = dialog.locator('[data-pagination-key="seatingmanager-candidates"]');
  await root.locator('tbody tr.el-table__row').first().locator('.el-checkbox').click();
  await root.locator('.btn-next').click();
  await root.locator('tbody tr.el-table__row').first().locator('.el-checkbox').click();
  await expect(dialog.getByText('仅已勾选（2 份）', { exact: true })).toBeVisible();
  await root.locator('.btn-prev').click();
  await expect(root.locator('tbody tr.el-table__row').first().getByRole('checkbox')).toBeChecked();
  await dialog.getByRole('button', { name: '预览分配结果', exact: true }).click();
  await expect(dialog).toContainText('本次作用范围：2 份报名；新增／替换 2 个座位。');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: '报名管理', exact: true }).click();
  const roster = page.locator('table.el-table__body').locator('tbody tr.el-table__row');
  await roster.first().locator('.el-checkbox').click();
  await page.locator('.list-pagination .btn-next').click();
  await roster.first().locator('.el-checkbox').click();
  await page.locator('.list-pagination .btn-prev').click();
  await expect(roster.first().getByRole('checkbox')).toBeChecked();
});
test('file pagination reaches records beyond the legacy limit without widening ownership', async () => {
  const marker = `pagination-limit-${randomUUID()}`;
  const rows = Array.from({ length: 502 }, (_, i) => ({
    id: randomUUID(),
    ownerId: alice.user.id,
    name: `${marker}-${i}.txt`,
    mime: 'text/plain',
    size: 1,
    purpose: 'PERSONAL',
    storageKey: `${marker}/${i}.txt`,
  }));
  await db.attachment.createMany({ data: rows });
  try {
    const query = `search=${marker}&pageSize=100`;
    const first = await alice.api(`/files?${query}&page=1`),
      last = await alice.api(`/files?${query}&page=6`);
    expect(first.total).toBe(502);
    expect(first.items).toHaveLength(100);
    expect(last.items).toHaveLength(2);
    expect((await bob.api(`/files?${query}&page=1`)).total).toBe(0);
    expect(await alice.api(`/files?search=${marker}`)).toHaveLength(500);
  } finally {
    await db.attachment.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }
});
test('identity history reaches older reviews without widening account access', async ({ page }) => {
  const before = await db.identityRequest.count({ where: { userId: alice.user.id } });
  const rows = Array.from({ length: 26 }, (_, i) => ({
    id: randomUUID(),
    userId: i < 23 ? alice.user.id : bob.user.id,
    data: { name: '分页审核资料' },
    status: 'REJECTED',
    reason: `分页审核记录 ${i + 1}`,
    createdAt: new Date(Date.now() + i * 1000),
  }));
  await db.identityRequest.createMany({ data: rows });
  try {
    const own = await alice.api('/auth/identity');
    expect(own.requests).toHaveLength(before + 23);
    expect(own.requests.some((row: { userId: string }) => row.userId !== alice.user.id)).toBe(
      false,
    );
    const other = await bob.api('/auth/identity');
    expect(other.requests.some((row: { userId: string }) => row.userId !== bob.user.id)).toBe(
      false,
    );
    await login(page, 'alice');
    await page.goto('/me/profile?tab=identity');
    const root = page.locator('[data-pagination-key="profilecenter-requests"]');
    const visible = root.locator('tbody tr.el-table__row');
    await expect(visible).toHaveCount(20);
    await root.locator('.btn-next').click();
    await expect(visible).toHaveCount(Math.min(20, before + 3));
    await expect(root).toContainText('分页审核记录 1');
    await root.locator('.el-pagination__sizes').click();
    await page.getByRole('option', { name: /^50\s*条/ }).click();
    await expect(visible).toHaveCount(Math.min(50, before + 23));
    await page.reload();
    await expect(root).toContainText('50条/页');
    await expect(visible).toHaveCount(Math.min(50, before + 23));
  } finally {
    await db.identityRequest.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }
});
test('global template history paginates old versions and remembers the selected size', async ({
  page,
}) => {
  const before = await db.admissionTemplate.count({ where: { contestId: null } });
  const latest = await db.admissionTemplate.aggregate({
    where: { contestId: null },
    _max: { version: true },
  });
  const rows = Array.from({ length: 23 }, (_, i) => ({
    id: randomUUID(),
    name: `分页模板版本 ${i + 1}`,
    source: `Historical template source number ${i + 1}`,
    version: (latest._max.version ?? 0) + i + 1,
    active: false,
    createdAt: new Date(Date.now() + i * 1000),
  }));
  await db.admissionTemplate.createMany({ data: rows });
  try {
    await login(page);
    await page.goto('/admin?tab=site');
    const root = page.locator('[data-pagination-key="global-template-versions"]');
    const visible = root.locator('.template-version');
    await expect(visible).toHaveCount(20);
    await root.locator('.btn-next').click();
    await expect(visible).toHaveCount(Math.min(20, before + 3));
    await expect(root).toContainText('分页模板版本 1');
    await root.locator('.el-pagination__sizes').click();
    await page.getByRole('option', { name: /^50\s*条/ }).click();
    await expect(visible).toHaveCount(Math.min(50, before + 23));
    await page.reload();
    await expect(root).toContainText('50条/页');
    await expect(visible).toHaveCount(Math.min(50, before + 23));
  } finally {
    await db.admissionTemplate.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }
});
test('mail notifications paginate in creation order and keep their resource authorization', async ({
  page,
}) => {
  const path = `/notifications/mail?resourceId=${alice.user.id}`;
  const before = await alice.api(`${path}&page=1&pageSize=20`);
  const rows = Array.from({ length: 23 }, (_, i) => ({
    id: randomUUID(),
    kind: 'MAIL',
    resourceId: alice.user.id,
    dedupeKey: randomUUID(),
    state: 'SUCCESS',
    createdAt: new Date(Date.now() + i * 1000),
    payload: { category: 'REGISTRATION', subject: `分页邮件${i}`, to: alice.user.email },
  }));
  await db.job.createMany({ data: rows });
  try {
    const first = await alice.api(`${path}&page=1&pageSize=20`),
      next = await alice.api(`${path}&page=2&pageSize=20`);
    expect(first.total).toBe(before.total + 23);
    expect(first.items).toHaveLength(20);
    expect(first.items[0].subject).toBe('分页邮件22');
    expect(first.items.some((a: any) => next.items.some((b: any) => a.id === b.id))).toBe(false);
    expect((await bob.raw(`/api/v1${path}&page=1&pageSize=20`)).status).toBe(403);
    await login(page, 'alice');
    await page.goto('/me/profile');
    const card = page.locator('.mail-delivery');
    await expect(card.locator('tbody tr.el-table__row')).toHaveCount(20);
    await card.locator('.btn-next').click();
    await expect(card.locator('tbody tr.el-table__row')).toHaveCount(next.items.length);
    await card.locator('.el-select__wrapper').click();
    await page.getByRole('option', { name: /^50\s*条/ }).click();
    await expect(card.locator('tbody tr.el-table__row')).toHaveCount(Math.min(50, first.total));
  } finally {
    await db.job.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }
});
