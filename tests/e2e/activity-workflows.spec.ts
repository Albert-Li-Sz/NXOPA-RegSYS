import { test, expect, type Page } from '@playwright/test';
import { Client } from '../integrations/client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema, defaultTemplate } from '../../packages/contracts/src/index.js';
let admin: Client, alice: Client, bob: Client;
const ids: string[] = [];
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
  await db.$disconnect();
});
async function login(page: Page, who = 'admin') {
  await page.goto('/login');
  await page.locator('#account').fill(who);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
async function contest(extra: Record<string, unknown> = {}) {
  const c = await admin.api('/contests', 'POST', {
    title: `浏览器流程 ${Date.now()}`,
    season: '流程验收',
    description: '报名资料核对',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ coachMode: 'DISABLED' }),
    fields: [],
    ...extra,
  });
  ids.push(c.id);
  return c;
}
async function entry(c: any, client = alice) {
  const r = await client.api('/registrations', 'POST', { contestId: c.id });
  return client.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
}
test('administrators edit and save other peoples entries without participant submission actions', async ({
  page,
}) => {
  const c = await contest();
  let r = await alice.api('/registrations', 'POST', { contestId: c.id });
  await login(page);
  await page.goto(`/registrations/${r.id}`);
  await expect(page.getByRole('button', { name: '编辑报名资料', exact: true })).toBeVisible();
  await expect(page.getByText('等待审核', { exact: true })).toHaveCount(0);
  await expect(page.getByText('队长', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '提交报名', exact: true })).toHaveCount(0);
  expect((await admin.api(`/registrations/${r.id}`)).actions.submit).toBe(false);
  expect(
    (await admin.raw(`/api/v1/registrations/${r.id}/submit`, 'POST', { version: r.version }))
      .status,
  ).toBe(403);
  await page.getByRole('button', { name: '编辑报名资料', exact: true }).click();
  await page.locator('#person-0-name').fill('管理员更正的姓名');
  await expect(page.getByRole('button', { name: '提交报名', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('#person-0-name')).toHaveCount(0);
  r = await alice.api(`/registrations/${r.id}`);
  expect(r.people[0].name).toBe('管理员更正的姓名');
  expect(r.status).toBe('DRAFT');
  expect(r.actions.submit).toBe(true);
  r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  expect(
    (await admin.raw(`/api/v1/registrations/${r.id}/withdraw`, 'POST', { version: r.version }))
      .status,
  ).toBe(403);
  expect((await alice.api(`/registrations/${r.id}`)).actions.withdraw).toBe(true);
  r = await alice.api(`/registrations/${r.id}/withdraw`, 'POST', { version: r.version });
  expect(r.status).toBe('DRAFT');
  const own = await admin.api('/registrations', 'POST', { contestId: c.id });
  expect((await admin.api(`/registrations/${own.id}`)).actions.submit).toBe(true);
  await admin.api(`/registrations/${own.id}/submit`, 'POST', { version: own.version });
});
test('completed reviews use amendment actions and require a new decision and reason', async ({
  page,
}) => {
  const c = await contest();
  let r = await entry(c);
  r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'APPROVED',
  });
  expect((await alice.api(`/registrations/${r.id}`)).actions.withdraw).toBe(false);
  expect(
    (await alice.raw(`/api/v1/registrations/${r.id}/withdraw`, 'POST', { version: r.version }))
      .status,
  ).toBe(400);
  await login(page);
  await page.goto(`/admin/contests/${c.id}?tab=registrations`);
  const row = page.getByRole('row').filter({ hasText: alice.user.name });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: '审核', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: '修改审核', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改审核', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('label.el-radio-button').filter({ hasText: '通过' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '审核并查看下一条', exact: true })).toHaveCount(
    0,
  );
  await dialog.locator('label.el-radio-button').filter({ hasText: '退回补正' }).click();
  await dialog.getByRole('button', { name: '保存审核修改', exact: true }).click();
  await expect(dialog.getByText('请填写审核意见', { exact: true })).toBeVisible();
  await dialog.locator('textarea').fill('复核后需要补充材料');
  await dialog.getByRole('button', { name: '保存审核修改', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  r = await alice.api(`/registrations/${r.id}`);
  expect(r.status).toBe('CORRECTION');
  expect(r.review).toBe('CORRECTION');
  expect(r.eligible).toBe(false);
  await row.getByRole('button', { name: '修改审核', exact: true }).click();
  await dialog.locator('label.el-radio-button').filter({ hasText: '拒绝' }).click();
  await dialog.locator('textarea').fill('复核后明确不符合要求');
  await dialog.getByRole('button', { name: '保存审核修改', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  r = await alice.api(`/registrations/${r.id}`);
  expect(r.review).toBe('REJECTED');
  expect(r.eligible).toBe(false);
  await page.goto(`/registrations/${r.id}`);
  await expect(page.getByRole('button', { name: '审核报名', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '修改审核', exact: true })).toBeVisible();
  r = await alice.api(`/registrations/${r.id}`, 'PUT', {
    ...r,
    version: r.version,
    people: r.people.map((p: any) => ({ ...p, name: '补正资料中的姓名' })),
  });
  const unsubmitted = await admin.api(`/registrations/${r.id}`);
  expect(unsubmitted.actions.review).toBe(false);
  expect(unsubmitted.actions.amendReview).toBe(false);
  expect(
    (
      await admin.raw(`/api/v1/registrations/${r.id}/review`, 'POST', {
        version: r.version,
        decision: 'APPROVED',
        reason: '不能审核尚未重新提交的修改',
      })
    ).status,
  ).toBe(400);
});
test('finance applications belong to applicants while administrators process the applications', async ({
  page,
}) => {
  const c = await contest({
    policy: policySchema.parse({
      coachMode: 'OPTIONAL',
      feeMode: 'FIXED',
      feeCents: 5000,
      paymentSequence: 'PAYMENT_FIRST',
      refundsEnabled: true,
      invoicesEnabled: true,
    }),
  });
  let r = await entry(c);
  const teacher = await new Client().login('teacher');
  const invitation = await alice.api(`/registrations/${r.id}/invites`, 'POST', { kind: 'COACH' });
  await teacher.api(
    `/invitations/${new URL(invitation.url).pathname.split('/').pop()}/accept`,
    'POST',
    {},
  );
  r = await teacher.api(`/registrations/${r.id}`);
  expect(r.actions.submit).toBe(true);
  r = await teacher.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  expect((await teacher.api(`/finance/accounts/${r.id}`)).canEdit).toBe(true);
  const file = await alice.upload(r.id);
  const voucherBody = {
    amountCents: 5000,
    channel: '测试转账',
    payer: '报名者',
    paidAt: new Date().toISOString(),
    attachmentId: file.id,
  };
  const voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', voucherBody);
  await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
  const account = await admin.api(`/finance/accounts/${r.id}`);
  expect(account.canEdit).toBe(false);
  expect(account.canManage).toBe(true);
  expect((await admin.api(`/registrations/${r.id}`)).actions.requestFinance).toBe(false);
  for (const [suffix, body] of [
    ['vouchers', voucherBody],
    ['refunds', { amountCents: 1000, reason: '管理员不能代申请' }],
    [
      'invoices',
      {
        amountCents: 1000,
        title: '个人',
        titleType: 'PERSON',
        invoiceType: 'NORMAL',
        email: 'alice@example.test',
        taxId: '',
      },
    ],
  ] as const) {
    expect((await admin.raw(`/api/v1/finance/${r.id}/${suffix}`, 'POST', body)).status).toBe(403);
  }
  await login(page);
  await page.goto(`/registrations/${r.id}?tab=finance`);
  await expect(page.getByRole('heading', { name: '收款凭证', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^(上传收款凭证|申请退款|申请开票)$/ }),
  ).toHaveCount(0);
  await page.goto(`/finance/${r.id}`);
  await expect(page.getByRole('link', { name: '活动财务记录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(申请退款|申请发票)$/ })).toHaveCount(0);
  const payment = account.ledger.find((row: any) => row.kind === 'PAYMENT');
  await admin.api(`/finance/ledger/${payment.id}/reverse`, 'POST', { reason: '回归测试冲正' });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('已冲正', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '冲正', exact: true })).toHaveCount(0);
  const ledger = await admin.api(
    `/registrations/${r.id}/finance/ledger?status=PAYMENT&page=1&pageSize=20`,
  );
  expect(ledger.items[0].reversed).toBe(true);
  r = await alice.api(`/registrations/${r.id}`);
  await alice.api(`/registrations/${r.id}/cancel`, 'POST', { version: r.version });
  expect((await admin.api(`/finance/accounts/${r.id}`)).canEdit).toBe(false);
  expect((await alice.api(`/finance/accounts/${r.id}`)).canEdit).toBe(true);
});
test('finance-only administrators can issue invoices without registration file-management permissions', async ({
  page,
}) => {
  const c = await contest({
    policy: policySchema.parse({
      coachMode: 'DISABLED',
      feeMode: 'FIXED',
      feeCents: 5000,
      paymentSequence: 'PAYMENT_FIRST',
      invoicesEnabled: true,
    }),
  });
  const r = await entry(c);
  const file = await alice.upload(r.id);
  const voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', {
    amountCents: 5000,
    channel: '测试转账',
    payer: '报名者',
    paidAt: new Date().toISOString(),
    attachmentId: file.id,
  });
  await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
  const invoice = await alice.api(`/finance/${r.id}/invoices`, 'POST', {
    amountCents: 1000,
    title: '财务权限回归',
    titleType: 'PERSON',
    invoiceType: 'NORMAL',
    email: 'alice@example.test',
    taxId: '',
  });
  await alice.api(`/finance/${r.id}/invoices`, 'POST', {
    amountCents: 1000,
    title: '另一份发票权限验收',
    titleType: 'PERSON',
    invoiceType: 'NORMAL',
    email: 'alice@example.test',
    taxId: '',
  });
  const grant = await admin.api('/admin/grants', 'POST', {
    userId: bob.user.id,
    level: 'CONTEST',
    contestId: c.id,
    permissions: ['VIEW', 'FINANCE'],
  });
  try {
    await login(page, 'bob');
    await page.goto(`/registrations/${r.id}?tab=finance`);
    await page
      .getByRole('row')
      .filter({ hasText: '财务权限回归' })
      .getByRole('button', { name: '上传发票', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '上传实际发票', exact: true });
    const uploading = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/api/v1/files'),
    );
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\nfinancial test invoice\n%%EOF'),
    });
    expect((await uploading).ok()).toBe(true);
    await expect(dialog.getByRole('button', { name: '确认上传', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: '确认上传', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const issued = (await alice.api(`/finance/accounts/${r.id}`)).invoices.find(
      (item: any) => item.id === invoice.id,
    );
    expect(issued.status).toBe('ISSUED');
    expect((await bob.raw(`/api/v1/files/${issued.attachmentId}`)).status).toBe(200);
    expect((await bob.api(`/registrations/${r.id}`)).actions.edit).toBe(false);
    await page
      .getByRole('row')
      .filter({ hasText: '另一份发票权限验收' })
      .getByRole('button', { name: '上传发票', exact: true })
      .click();
    await expect(dialog.getByRole('button', { name: '确认上传', exact: true })).toBeDisabled();
    await expect(dialog.locator('input[type=file]')).toHaveValue('');
  } finally {
    await admin.api(`/admin/grants/${grant.id}`, 'DELETE');
  }
});
test('personal activity tabs never inherit administrator list scope', async ({ page }) => {
  const c = await contest();
  await entry(c);
  await login(page);
  await page.goto(`/contests/${c.id}`);
  await page.getByRole('tab', { name: '报名', exact: true }).click();
  await expect(page.getByText('您尚未报名此竞赛', { exact: true })).toBeVisible();
  expect(await admin.api(`/registrations?contestId=${c.id}&role=mine`)).toHaveLength(0);
  const own = await admin.api('/registrations', 'POST', { contestId: c.id });
  await page.reload();
  await page.getByRole('tab', { name: '报名', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看报名', exact: true })).toHaveCount(1);
  await expect(page.locator(`a[href="/registrations/${own.id}"]`)).toBeVisible();
  await expect(page.locator('#pane-registrations')).not.toContainText(alice.user.name);
});
test('view-only management grants do not expose applicant actions or contest credentials', async ({
  page,
}) => {
  const c = await contest();
  let r = await entry(c);
  r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'APPROVED',
  });
  const grant = await admin.api('/admin/grants', 'POST', {
    userId: bob.user.id,
    level: 'CONTEST',
    contestId: c.id,
    permissions: ['VIEW'],
  });
  try {
    const template = await admin.api('/admissions/templates', 'POST', {
      contestId: c.id,
      name: '未发放准考证权限回归',
      source: defaultTemplate,
    });
    const document = await db.admissionDocument.create({
      data: {
        registrationId: r.id,
        number: `VIEW-${r.id}`,
        location: '测试地点',
        registrationVersion: r.version,
        templateId: template.id,
        templateVersion: template.version,
        state: 'READY',
        storageKey: `permission-fixture-${r.id}.pdf`,
      },
    });
    expect((await bob.raw(`/api/v1/admissions/${document.id}/download`)).status).toBe(403);
    const detail = await bob.api(`/registrations/${r.id}`);
    for (const key of [
      'edit',
      'submit',
      'withdraw',
      'review',
      'amendReview',
      'requestFinance',
      'credentials',
      'delete',
    ])
      expect(detail.actions[key]).toBe(false);
    expect((await bob.raw(`/api/v1/integrations/registrations/${r.id}/credentials`)).status).toBe(
      403,
    );
    await login(page, 'bob');
    await page.goto(`/registrations/${r.id}?tab=accounts`);
    await expect(
      page.getByText('比赛账号与本站账号分别管理。请妥善保存比赛账号。', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '查看获授权的比赛账号', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('tab', { name: '报名资料', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /^(编辑报名资料|提交报名|审核报名|修改审核|删除报名)$/ }),
    ).toHaveCount(0);
  } finally {
    await db.admissionDocument.deleteMany({ where: { registrationId: r.id } });
    await admin.api(`/admin/grants/${grant.id}`, 'DELETE');
  }
});
test('saved profile and settings require Edit; Cancel restores the saved values', async ({
  page,
}) => {
  await login(page);
  await page.goto('/me/profile');
  await expect(page.locator('#profile-email')).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存资料', exact: true })).toHaveCount(0);
  const original = await page.locator('#profile-email').inputValue();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.locator('#profile-email')).toBeEnabled();
  await page.locator('#profile-email').fill('unsaved@example.test');
  await page.getByRole('link', { name: '我的报名', exact: true }).click();
  await expect(page.locator('.el-message-box')).toContainText('有未保存的修改');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.locator('#profile-email')).toHaveValue('unsaved@example.test');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(page.locator('#profile-email')).toHaveValue(original);
  await expect(page.locator('#profile-email')).toBeDisabled();
  await page.goto('/admin?tab=mail');
  await expect(page.locator('#mail-host')).toBeDisabled();
  await expect(page.getByRole('button', { name: '新增备用 SMTP', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.locator('#mail-host')).toBeEnabled();
  await page.getByRole('button', { name: '新增备用 SMTP', exact: true }).click();
  await expect(page.getByText('第 2 顺序', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(page.getByText('第 2 顺序', { exact: true })).toHaveCount(0);
  await page.goto('/admin?tab=mail-templates');
  await expect(page.locator('#template-text')).toBeDisabled();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#template-text').fill('暂存模板 {{code}}');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(page.locator('#template-text')).not.toHaveValue('暂存模板 {{code}}');
  await expect(page.locator('#template-text')).toBeDisabled();
});
test('review opens a read-only information dialog and separates correction, editing and approval', async ({
  page,
}) => {
  const c = await contest();
  let r = await entry(c);
  await login(page);
  await page.goto(`/admin/contests/${c.id}?tab=registrations`);
  const row = page.getByRole('row').filter({ hasText: alice.user.name });
  await row.getByRole('button', { name: '审核', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '报名审核', exact: true });
  await expect(dialog.getByRole('heading', { name: new RegExp(alice.user.name) })).toBeVisible();
  await expect(dialog.getByText('审核结论', { exact: true })).toBeVisible();
  await dialog.locator('label.el-radio-button').filter({ hasText: '退回补正' }).click();
  await dialog.getByRole('button', { name: '确认审核', exact: true }).click();
  await expect(dialog.getByText('请填写审核意见', { exact: true })).toBeVisible();
  await dialog.locator('textarea').fill('补充联系信息');
  await dialog.getByRole('button', { name: '确认审核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  r = await alice.api(`/registrations/${r.id}`);
  expect(r.status).toBe('CORRECTION');
  await page.goto(`/registrations/${r.id}`);
  await expect(page.locator('#person-0-name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '编辑报名资料', exact: true }).click();
  await expect(page.locator('#person-0-name')).toBeEnabled();
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  expect((await alice.api(`/registrations/${r.id}`)).version).toBe(r.version);
  r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  await page.goto(`/admin/contests/${c.id}?tab=registrations`);
  await page
    .getByRole('row')
    .filter({ hasText: alice.user.name })
    .getByRole('button', { name: '审核', exact: true })
    .click();
  await expect(page.getByRole('dialog').getByText('补充联系信息', { exact: true })).toBeVisible();
  await page.getByRole('dialog').screenshot({ path: '.runtime/reports/review-dialog.png' });
  await page.getByRole('dialog').getByRole('button', { name: '确认审核', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '报名审核', exact: true })).not.toBeVisible();
  expect((await alice.api(`/registrations/${r.id}`)).eligible).toBe(true);
  await page
    .getByRole('row')
    .filter({ hasText: alice.user.name })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  const prompt = page.locator('.el-message-box');
  await prompt.locator('textarea').fill('删除测试报名');
  await prompt.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: alice.user.name })).toHaveCount(0);
  expect((await alice.raw(`/api/v1/registrations/${r.id}`)).status).toBe(404);
});
test('coach field drafts cancel cleanly and save with the rest of the registration', async ({
  page,
}) => {
  const c = await contest({
    policy: policySchema.parse({ coachMode: 'OPTIONAL' }),
    fields: [
      { key: 'contact_note', label: '老师备注', scope: 'COACH', type: 'text', required: false },
    ],
  });
  let r = await entry(c);
  const teacher = await new Client().login('teacher');
  const invitation = await alice.api(`/registrations/${r.id}/invites`, 'POST', { kind: 'COACH' });
  await teacher.api(
    `/invitations/${new URL(invitation.url).pathname.split('/').pop()}/accept`,
    'POST',
    {},
  );
  r = await alice.api(`/registrations/${r.id}`);
  r = await alice.api(`/registrations/${r.id}/coaches/${r.coaches[0].id}`, 'PUT', {
    version: r.version,
    answers: { contact_note: '已保存的备注' },
  });
  await login(page, 'alice');
  await page.goto(`/registrations/${r.id}`);
  const field = page.locator(`[id="${r.coaches[0].id}-contact_note"]`);
  await expect(field).toHaveCount(0);
  await page.getByRole('button', { name: '编辑报名资料', exact: true }).click();
  await field.fill('未保存的备注');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await page.getByRole('button', { name: '编辑报名资料', exact: true }).click();
  await expect(field).toHaveValue('已保存的备注');
  await field.fill('统一保存后的备注');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(field).toHaveCount(0);
  const saved = await alice.api(`/registrations/${r.id}`);
  expect(saved.coaches[0].answers.contact_note).toBe('统一保存后的备注');
  expect(saved.version).toBe(r.version + 1);
});
test('version conflicts preserve draft fields until the user explicitly cancels', async ({
  page,
}) => {
  const c = await contest();
  const r = await entry(c);
  await login(page, 'alice');
  await page.goto(`/registrations/${r.id}`);
  await page.getByRole('button', { name: '编辑报名资料', exact: true }).click();
  await page.locator('#person-0-name').fill('未保存的姓名');
  await admin.api(`/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'CORRECTION',
    reason: '并发审核意见',
  });
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('.el-message--error')).toBeVisible();
  await expect(page.locator('#person-0-name')).toHaveValue('未保存的姓名');
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(page.locator('#person-0-name')).toHaveCount(0);
});
test('multiple rooms preview allocations before commit and saved configuration stays read-only', async ({
  page,
}) => {
  const c = await contest({
    modules: { admissions: true, rooms: true, integrations: false },
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
  });
  const a = await entry(c),
    b = await entry(c, bob);
  await admin.api(`/contests/${c.id}/rooms`, 'POST', {
    name: '教学楼 A101',
    capacity: 1,
    sortOrder: 1,
  });
  await admin.api(`/contests/${c.id}/rooms`, 'POST', {
    name: '教学楼 A102',
    capacity: 1,
    sortOrder: 2,
  });
  await login(page);
  await page.goto(`/admin/contests/${c.id}`);
  await expect(page.locator('#contest-title')).toBeDisabled();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#contest-title').fill('没有保存的标题');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(page.locator('#contest-title')).toHaveValue(c.title);
  await page.getByRole('tab', { name: '考场与座位', exact: true }).click();
  await page.getByRole('button', { name: '自动排考预览', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '排考预览与确认' });
  await expect(
    dialog.getByRole('button', { name: '确认保存本次排考', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: '预览分配结果', exact: true }).click();
  await expect(
    dialog.getByText('本次作用范围：2 份报名；新增／替换 2 个座位。', { exact: true }),
  ).toBeVisible();
  expect(await db.seatAssignment.count({ where: { registrationId: { in: [a.id, b.id] } } })).toBe(
    0,
  );
  await dialog.screenshot({ path: '.runtime/reports/seating-preview.png' });
  await dialog.getByRole('button', { name: '确认保存本次排考', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await db.seatAssignment.count({ where: { registrationId: { in: [a.id, b.id] } } })).toBe(
    2,
  );
  await page.screenshot({ path: '.runtime/reports/seating-management.png', fullPage: true });
});
test('new generic activities default to optional modules off and narrow screens remain usable', async ({
  page,
}) => {
  await login(page);
  await page.goto('/admin/contests/new');
  await page.getByText('配置类型', { exact: true }).locator('..').locator('.el-select').click();
  await page.getByRole('option', { name: '通用活动', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '启用准考证', exact: true })).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: '启用考场与座位', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: '启用评测平台联动', exact: true }),
  ).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#contest-title')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(391);
  await page.screenshot({ path: '.runtime/reports/activity-settings-mobile.png', fullPage: true });
});
