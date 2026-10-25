import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

let admin: Client, alice: Client;
const ids: string[] = [];
const run = Date.now();
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  alice = await new Client().login('alice');
});
test.afterAll(async () => {
  await db.contest.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  await db.adminGrant.updateMany({
    where: { contestId: { in: ids }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const fixtures = await db.platformInstance.findMany({
    where: { name: `删除验收平台 ${run}` },
    select: { id: true },
  });
  await db.platformBinding.deleteMany({ where: { instanceId: { in: fixtures.map((f) => f.id) } } });
  await db.platformInstance.deleteMany({ where: { id: { in: fixtures.map((f) => f.id) } } });
  await db.$disconnect();
});
async function contest() {
  const c = await admin.api('/contests', 'POST', {
    title: `删除与布局验收 ${run} ${ids.length}`,
    description: '独立验收数据',
    season: '验收',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({ coachMode: 'DISABLED' }),
    fields: [],
  });
  ids.push(c.id);
  return c;
}
async function login(page: Page) {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}

test('empty contest can be deleted from management after confirmation', async ({ page }) => {
  const c = await contest();
  await login(page);
  await page.goto('/admin/contests');
  await page.getByPlaceholder('搜索活动或赛季').fill(c.title);
  const row = page.locator('.el-table__body-wrapper tr.el-table__row').filter({ hasText: c.title });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('button', { name: '删除', exact: true })).toBeVisible();
  await row.getByRole('button', { name: '删除', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除活动及竞赛', exact: true });
  await expect(confirmation).toContainText(c.title);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await confirmation.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await admin.raw(`/api/v1/contests/${c.id}`)).status).toBe(404);
});

test('registration action controls align horizontally or in one vertical column', async ({
  page,
}) => {
  const c = await contest();
  await alice.completeProfile();
  const draft = await alice.api('/registrations', 'POST', { contestId: c.id });
  await alice.api(`/registrations/${draft.id}/submit`, 'POST', { version: draft.version });
  await login(page);
  await page.goto(`/admin/contests/${c.id}?tab=registrations`);
  const row = page.locator('.el-table__body-wrapper tr.el-table__row').first();
  await expect(row.getByRole('button', { name: '审核', exact: true })).toBeVisible();
  for (const width of [1440, 831, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const boxes = await row
      .locator('td')
      .last()
      .locator('button, a')
      .evaluateAll((elements) =>
        elements.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y + r.height / 2 };
        }),
      );
    expect(boxes).toHaveLength(3);
    const sameRow = boxes.every((b) => Math.abs(b.y - boxes[0]!.y) <= 1);
    const sameColumn = boxes.every((b) => Math.abs(b.x - boxes[0]!.x) <= 1);
    expect(sameRow || sameColumn, `action positions at ${width}px: ${JSON.stringify(boxes)}`).toBe(
      true,
    );
    const controls = await page
      .locator('.toolbar')
      .filter({ has: page.getByRole('link', { name: '导出名单', exact: true }) })
      .locator('button, a.el-button, input[type="file"]')
      .evaluateAll((elements) =>
        elements.map((e) => {
          const r = e.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
        }),
      );
    for (const control of controls) {
      expect(control.height).toBe(32);
      expect(control.width).toBeGreaterThan(40);
    }
    for (const a of controls)
      for (const b of controls) {
        if (Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top))
          expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);
      }
    await row.getByRole('button', { name: '审核', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '报名审核', exact: true });
    await expect(dialog.getByRole('button', { name: '确认审核', exact: true })).toBeVisible();
    const footer = await dialog.locator('.el-dialog__footer button').evaluateAll((elements) =>
      elements.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, cy: r.y + r.height / 2, width: r.width };
      }),
    );
    expect(
      footer.every((b) => Math.abs(b.cy - footer[0]!.cy) <= 1) ||
        footer.every((b) => Math.abs(b.x - footer[0]!.x) <= 1),
    ).toBe(true);
    if (width < 600) expect(new Set(footer.map((b) => Math.round(b.width))).size).toBe(1);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `.runtime/reports/contest-actions-${width}.png`,
      fullPage: true,
    });
  }
});

test('detail deletion resolves unsaved changes before deleting and returns to management', async ({
  page,
}) => {
  const c = await contest();
  await login(page);
  await page.goto(`/admin/contests/${c.id}`);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#contest-title').fill(`${c.title} 未保存`);
  await page.getByRole('button', { name: '删除活动', exact: true }).click();
  const unsaved = page.getByRole('dialog', { name: '未保存修改', exact: true });
  await unsaved.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.locator('#contest-title')).toHaveValue(`${c.title} 未保存`);
  expect(await db.contest.count({ where: { id: c.id } })).toBe(1);
  await page.getByRole('button', { name: '删除活动', exact: true }).click();
  await unsaved.getByRole('button', { name: '放弃并离开', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除活动及竞赛', exact: true });
  await expect(confirmation).toContainText(c.title);
  await expect(confirmation).not.toContainText('未保存');
  await confirmation.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/contests$/);
  expect(await db.contest.count({ where: { id: c.id } })).toBe(0);
});

test('deletion checks permissions, versions, drafts and independent financial records', async () => {
  const c = await contest();
  expect(
    (await alice.raw(`/api/v1/contests/${c.id}`, 'DELETE', { version: c.version })).status,
  ).toBe(403);
  expect((await admin.raw(`/api/v1/contests/${c.id}`, 'DELETE', {})).status).toBe(400);
  expect(
    (await admin.raw(`/api/v1/contests/${c.id}`, 'DELETE', { version: c.version + 1 })).status,
  ).toBe(409);
  await alice.completeProfile();
  const r = await alice.api('/registrations', 'POST', { contestId: c.id });
  const blocked = await admin.raw(`/api/v1/contests/${c.id}`, 'DELETE', { version: c.version });
  expect(blocked.status).toBe(400);
  expect((await blocked.json()).message).toContain('报名');
  expect(await db.registration.count({ where: { id: r.id } })).toBe(1);
  await alice.api(`/registrations/${r.id}/cancel`, 'POST', {
    version: r.version,
  });
  const f = await db.financeAccount.create({
    data: {
      id: randomUUID(),
      contestId: c.id,
      ownerId: alice.user.id,
      number: 1,
      feeCents: 100,
      netPaidCents: 100,
      policySnapshot: c.policy,
      cancelledAt: new Date(),
    },
  });
  const ledger = await db.ledgerEntry.create({
    data: {
      registrationId: f.id,
      contestId: c.id,
      kind: 'PAYMENT',
      amountCents: 100,
      sourceId: randomUUID(),
      actorId: admin.user.id,
      note: '独立财务保留验收',
    },
  });
  const financial = await admin.raw(`/api/v1/contests/${c.id}`, 'DELETE', { version: c.version });
  expect(financial.status).toBe(400);
  expect((await financial.json()).message).toContain('财务');
  expect(await db.ledgerEntry.findUnique({ where: { id: ledger.id } })).toEqual(ledger);
  expect((await admin.api(`/contests/${c.id}`)).deletion.allowed).toBe(false);
});

test('deletion retains owned files and support while removing configuration and scoped access', async () => {
  const c = await contest(),
    other = await contest();
  const grant = await admin.api('/admin/grants', 'POST', {
    userId: alice.user.id,
    level: 'CONTEST',
    contestId: c.id,
    permissions: ['VIEW', 'CONTEST'],
  });
  expect(
    (await alice.raw(`/api/v1/contests/${c.id}`, 'DELETE', { version: c.version })).status,
  ).toBe(403);
  const fileBody = new FormData();
  fileBody.append(
    'file',
    new Blob(['Activity description'], { type: 'text/plain' }),
    'description.txt',
  );
  const file = await admin.api(`/files?contestId=${c.id}&purpose=CONTEST_PUBLIC`, 'POST', fileBody);
  expect((await new Client().raw(`/api/v1/files/public/${file.id}`)).ok).toBe(true);
  const ticket = await alice.api('/support', 'POST', {
    contestId: c.id,
    title: '删除后保留工单',
    category: 'GENERAL',
    text: '工单独立保留',
    attachments: [],
    emailNotifications: false,
  });
  await db.examRoom.create({ data: { contestId: c.id, name: '验收考场', capacity: 10 } });
  await db.admissionTemplate.create({
    data: { contestId: c.id, name: '验收模板', source: 'test source', version: 1 },
  });
  const instance = await db.platformInstance.create({
    data: {
      name: `删除验收平台 ${run}`,
      type: 'HYDRO',
      baseUrl: 'https://example.test',
      credentials: 'unused-test-fixture',
      allowedContestIds: [c.id, other.id],
    },
  });
  await db.platformBinding.create({
    data: { contestId: c.id, instanceId: instance.id, remoteContestId: 'test' },
  });
  const token = await db.apiToken.create({
    data: {
      name: 'delete-test',
      tokenHash: randomUUID(),
      contestIds: [c.id, other.id],
      scopes: [],
      fields: [],
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const single = await db.apiToken.create({
    data: {
      name: 'delete-test-single',
      tokenHash: randomUUID(),
      contestIds: [c.id],
      scopes: [],
      fields: [],
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  await admin.api(`/contests/${c.id}`, 'DELETE', { version: c.version });
  expect(await db.formVersion.count({ where: { contestId: c.id } })).toBe(0);
  expect(await db.examRoom.count({ where: { contestId: c.id } })).toBe(0);
  expect(await db.admissionTemplate.count({ where: { contestId: c.id } })).toBe(0);
  expect(await db.platformBinding.count({ where: { contestId: c.id } })).toBe(0);
  expect(
    (await db.adminGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt,
  ).not.toBeNull();
  expect(
    (await db.platformInstance.findUniqueOrThrow({ where: { id: instance.id } })).allowedContestIds,
  ).toEqual([other.id]);
  expect((await db.apiToken.findUniqueOrThrow({ where: { id: token.id } })).contestIds).toEqual([
    other.id,
  ]);
  expect((await db.apiToken.findUniqueOrThrow({ where: { id: token.id } })).revoked).toBe(false);
  expect((await db.apiToken.findUniqueOrThrow({ where: { id: single.id } })).revoked).toBe(true);
  expect((await new Client().raw(`/api/v1/files/public/${file.id}`)).status).toBe(403);
  expect((await admin.raw(`/api/v1/files/${file.id}`)).ok).toBe(true);
  expect((await db.attachment.findUniqueOrThrow({ where: { id: file.id } })).contestId).toBeNull();
  expect(
    (await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).contestId,
  ).toBeNull();
  expect((await alice.api(`/support/${ticket.id}`)).id).toBe(ticket.id);
  expect(await db.auditEvent.count({ where: { resourceId: c.id, action: 'CONTEST_DELETE' } })).toBe(
    1,
  );
});

test('registration creation and contest deletion cannot leave an orphan or erase a new draft', async () => {
  alice.user = (await alice.api('/auth/me')).user;
  await alice.completeProfile();
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await contest();
    const [registration, deletion] = await Promise.all([
      alice.raw('/api/v1/registrations', 'POST', { contestId: c.id }),
      admin.raw(`/api/v1/contests/${c.id}`, 'DELETE', { version: c.version }),
    ]);
    expect([200, 201, 404]).toContain(registration.status);
    expect([200, 400]).toContain(deletion.status);
    if (deletion.ok) {
      expect(registration.status).toBe(404);
      expect(await db.registration.count({ where: { contestId: c.id } })).toBe(0);
    } else {
      expect(registration.ok).toBe(true);
      expect(await db.registration.count({ where: { contestId: c.id } })).toBe(1);
      expect(await db.contest.count({ where: { id: c.id } })).toBe(1);
    }
  }
});

test('remote revocation tasks remain actionable from the platform center after contest deletion', async ({
  page,
}) => {
  const c = await contest();
  const todo = await db.remoteRevocation.create({
    data: {
      contestId: c.id,
      bindingId: randomUUID(),
      registrationId: randomUUID(),
      remoteUserId: `deleted-activity-${run}`,
      target: {
        platformName: '活动删除撤权验收',
        baseUrl: 'https://example.test',
        remoteContestId: 'test-deleted',
      },
    },
  });
  await admin.api(`/contests/${c.id}`, 'DELETE', { version: c.version });
  const all = await admin.api('/integrations/revocations');
  expect(all.some((row: any) => row.id === todo.id && row.state === 'PENDING')).toBe(true);
  expect((await alice.raw('/api/v1/integrations/revocations')).status).toBe(403);
  await login(page);
  await page.goto('/admin/platforms?tab=revocations');
  const row = page
    .locator('.el-table__body-wrapper tr.el-table__row')
    .filter({ hasText: todo.remoteUserId! });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '已在外接平台完成撤权', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认远端撤权', exact: true })
    .getByRole('button', { name: '确定', exact: true })
    .click();
  await expect(row).toContainText('已人工确认撤权');
  expect((await db.remoteRevocation.findUniqueOrThrow({ where: { id: todo.id } })).handledBy).toBe(
    admin.user.id,
  );
});
