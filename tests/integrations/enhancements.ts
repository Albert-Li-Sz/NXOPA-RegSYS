import assert from 'node:assert/strict';
import { mailpitBase } from './mailpit.js';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client, until, base } from './client.js';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';
const run = Date.now(),
  checks: string[] = [];
const originalSite = await db.setting.findUnique({ where: { key: 'site' } });
function pass(value: string) {
  checks.push(value);
  console.log(`PASS ${value}`);
}
async function rejected(client: Client, path: string, method: string, body: unknown, status = 400) {
  assert.equal((await client.raw(`/api/v1${path}`, method, body)).status, status);
}
async function mailText(email: string, includes: string) {
  return until(
    async () => {
      const search = (await (
        await fetch(`${mailpitBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
      ).json()) as any;
      for (const row of search.messages ?? []) {
        const msg = (await (await fetch(`${mailpitBase}/api/v1/message/${row.ID}`)).json()) as any;
        if (String(msg.Text).includes(includes)) return String(msg.Text);
      }
      return '';
    },
    (value) => !!value,
    30000,
  );
}
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice'),
    bob = await new Client().login('bob');
  let site = await admin.api('/site');
  await rejected(alice, '/admin/site', 'PUT', site, 403);
  for (const publicUrl of [
    'ftp://example.org',
    'https://user:password@example.org',
    'https://example.org/path',
    'https://example.org?foo=1',
    'https://example.org#x',
    'https://example.org:65536',
    'https://example.org:0',
    'https://bad_host.example.org',
    'https://example..org',
  ])
    await rejected(admin, '/admin/site', 'PUT', { ...site, publicUrl });
  const publicUrl = `https://reg-${run}.example.test`;
  const saved = await admin.api('/admin/site', 'PUT', { ...site, publicUrl });
  assert.equal(saved.publicUrl, publicUrl);
  await rejected(admin, '/admin/site', 'PUT', { ...site, publicUrl }, 409);
  site = await admin.api('/site');
  for (const origin of [publicUrl, 'http://localhost:5173']) {
    const response = await fetch(`${base}/api/v1/admin/site`, {
      method: 'PUT',
      headers: {
        Cookie: admin.cookie,
        'X-CSRF-Token': admin.csrf,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(site),
    });
    assert.ok(response.ok);
    site = await admin.api('/site');
  }
  assert.equal(
    (
      await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  const invite = await admin.api('/admin/invitations', 'POST', {
    kind: 'ACCOUNT',
    targetEmail: `invite-${run}@example.test`,
  });
  assert.ok(invite.url.startsWith(`${publicUrl}/invite/`));
  const email = `enhancement-${run}@example.test`,
    newcomer = new Client();
  const session = await newcomer.register({
    email,
    username: `enhance_${run}`,
    name: '公网配置验收',
    password: 'Enhancement2026!',
  });
  newcomer.csrf = session.csrf;
  const changedEmail = `changed-${email}`;
  await newcomer.api('/auth/profile', 'PUT', {
    version: session.user.version,
    name: session.user.name,
    profile: session.user.profile,
    email: changedEmail,
  });
  const verifyMail = await mailText(changedEmail, '/account/verify?');
  assert.ok(verifyMail.includes(`${publicUrl}/account/verify?`));
  const token = verifyMail.match(/token=([A-Za-z0-9_-]+)/)![1];
  await newcomer.api('/auth/verify', 'POST', { token });
  await newcomer.api('/auth/forgot', 'POST', { email: changedEmail });
  assert.ok(
    (await mailText(changedEmail, '/account/reset?')).includes(`${publicUrl}/account/reset?`),
  );
  const priorVersion = (await admin.api('/site')).version;
  execFileSync('pnpm', ['restore:public-url', publicUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal((await admin.api('/site')).version, priorVersion + 1);
  assert.equal(
    (await admin.api('/admin/audit?page=1&pageSize=20&status=SITE_URL_RECOVERY')).items[0].details
      .publicUrl,
    publicUrl,
  );
  pass('公网地址数据库生效、校验、版本冲突、邮件链接与反向代理来源兼容');

  const contest = await admin.api('/contests', 'POST', {
    title: `增强验收 ${run}`,
    season: '验收',
    description: '## 中文介绍\n\n| 项目 | 内容 |\n| --- | --- |\n| 报名 | 团队 |',
    descriptionFormat: 'MARKDOWN',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({
      mode: 'TEAM',
      memberMode: 'MANUAL',
      minMembers: 2,
      maxMembers: 3,
      coachMode: 'OPTIONAL',
      manualReview: false,
      allowUnofficial: true,
      platformProfiles: ['HYDRO_5_0_7', 'DOMJUDGE_9_0_1'],
      feeMode: 'FIXED',
      feeCents: 30000,
      paymentSequence: 'PAYMENT_FIRST',
      invoiceTypes: ['NORMAL', 'SPECIAL'],
      invoiceRequiredFields: ['contactName'],
    }),
    fields: [],
  });
  const form = await admin.api(`/contests/${contest.id}`);
  assert.equal(form.fields.length, 3);
  assert.ok(form.fields.every((f: any) => f.locked));
  let r = await alice.api('/registrations', 'POST', { contestId: contest.id });
  const organization = { name: '南京晓庄学院', shortName: '晓庄', country: 'CHN', icpcId: '' };
  const saveBody = {
    version: r.version,
    teamName: '增强验收团队',
    teamEnglishName: 'Enhancement Team',
    participationType: 'UNOFFICIAL',
    organization,
    answers: { registration: { team_label: 'A101', team_location: '南京' }, team: {} },
    people: [
      ...r.people,
      { name: '队员乙', email: 'member@example.test', captain: false, answers: {} },
    ],
  };
  r = await alice.api(`/registrations/${r.id}`, 'PUT', saveBody);
  assert.equal(r.participationType, 'UNOFFICIAL');
  const memberInvite = await alice.api(`/registrations/${r.id}/invites`, 'POST', { kind: 'COACH' });
  assert.ok(memberInvite.url.startsWith(`${publicUrl}/invite/`));
  r = await alice.api(`/registrations/${r.id}`);
  r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  assert.equal(r.review, 'PENDING');
  assert.equal(r.eligible, false);
  assert.equal((r.snapshot as any).participationType, 'UNOFFICIAL');
  assert.equal(r.snapshot.organization.name, organization.name);
  await rejected(admin, `/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'APPROVED',
  });
  const proof = await alice.upload(r.id),
    voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', {
      amountCents: 30000,
      channel: '验收转账',
      reference: `enhance-${run}`,
      payer: '验收队长',
      paidAt: new Date().toISOString(),
      attachmentId: proof.id,
    });
  await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
  await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
  r = await alice.api(`/registrations/${r.id}`);
  assert.equal(r.netPaidCents, 30000);
  assert.equal(r.eligible, false);
  r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'APPROVED',
  });
  assert.equal(r.eligible, true);
  pass('非正式申请强制人工审核、平台基础字段、组织与参赛性质快照、先缴费顺序');

  for (const body of [
    { titleType: 'PERSON', title: '个人选手', invoiceType: 'NORMAL', taxId: '' },
    {
      titleType: 'ENTERPRISE',
      title: '验收企业',
      invoiceType: 'NORMAL',
      taxId: '913200001234567890',
    },
    {
      titleType: 'ORGANIZATION',
      title: '验收事业单位',
      invoiceType: 'SPECIAL',
      taxId: '123200001234567890',
      address: '南京市',
      bankName: '示例银行',
      bankAccount: '0000000000000000',
    },
  ]) {
    const invoice = await alice.api(
      `/finance/${r.id}/invoices`,
      'POST',
      {
        ...body,
        amountCents: 10000,
        email: alice.user.email,
        contactName: '验收联系人',
        phone: '00000000000',
        remarks: '参赛报名费用，请核对抬头',
      },
      randomUUID(),
    );
    assert.equal(invoice.snapshot.remarks, '参赛报名费用，请核对抬头');
  }
  await rejected(alice, `/finance/${r.id}/invoices`, 'POST', {
    titleType: 'ENTERPRISE',
    title: '缺少税号',
    amountCents: 1,
    email: alice.user.email,
    contactName: '联系人',
  });
  await rejected(alice, `/finance/${r.id}/invoices`, 'POST', {
    titleType: 'PERSON',
    invoiceType: 'SPECIAL',
    title: '个人专票',
    taxId: '123',
    amountCents: 1,
    email: alice.user.email,
    contactName: '联系人',
  });
  await rejected(alice, `/finance/${r.id}/invoices`, 'POST', {
    title: '超额',
    amountCents: 1,
    email: alice.user.email,
    contactName: '联系人',
  });
  const finance = await alice.api(`/registrations/${r.id}?history=false`);
  assert.equal(finance.invoices.length, 0);
  assert.equal(finance.invoiceReservedCents, 30000);
  assert.equal(
    (await alice.api(`/registrations/${r.id}/finance/invoices?page=1&pageSize=20`)).total,
    3,
  );
  const invoiceFilter = await alice.api(
    `/registrations/${r.id}/finance/invoices?page=1&pageSize=20&search=${encodeURIComponent('验收企业')}&status=REQUESTED&from=${encodeURIComponent(new Date(run - 1000).toISOString())}`,
  );
  assert.equal(invoiceFilter.total, 1);
  assert.equal(invoiceFilter.items[0].title, '验收企业');
  await rejected(bob, `/registrations/${r.id}/finance/invoices?page=1`, 'GET', undefined, 403);
  pass('个人普票、企业普票、单位专票、备注快照、金额限制与分页附件权限');

  await db.auditEvent.createMany({
    data: Array.from({ length: 61 }, (_, i) => ({
      actorId: admin.user.id,
      action: 'ENHANCEMENT_PAGINATION',
      resourceId: contest.id,
      details: { index: i },
    })),
  });
  const auditFilter = `status=ENHANCEMENT_PAGINATION&search=${contest.id}`;
  const a = await admin.api(`/admin/audit?page=1&pageSize=20&${auditFilter}`),
    b = await admin.api(`/admin/audit?page=2&pageSize=20&${auditFilter}`);
  assert.equal(a.total, 61);
  assert.equal(b.total, 61);
  assert.equal(a.items.length, 20);
  assert.ok(!b.items.some((x: any) => a.items.some((y: any) => y.id === x.id)));
  assert.equal(
    (await admin.api(`/admin/audit?page=1&pageSize=50&${auditFilter}`)).items.length,
    50,
  );
  await rejected(admin, '/admin/audit?page=1&pageSize=21', 'GET', undefined);
  assert.equal(
    (
      await admin.api(
        `/registrations?page=1&pageSize=20&contestId=${contest.id}&participationType=UNOFFICIAL`,
      )
    ).total,
    1,
  );
  assert.equal(
    (await bob.api(`/registrations?page=1&pageSize=20&contestId=${contest.id}`)).total,
    0,
  );
  const csv = await admin.raw(
    `/api/v1/registrations/export?contestId=${contest.id}&participationType=UNOFFICIAL`,
  );
  assert.equal((await csv.text()).split('\r\n').filter(Boolean).length, 3);
  await writeFile(
    '.runtime/enhancement-context.json',
    JSON.stringify({ contestId: contest.id, registrationId: r.id }, null, 2),
  );
  pass('后端分页总数、稳定跨页排序、20／50条、筛选全量导出与越权拒绝');
  console.log(`Enhancements: ${checks.length} groups passed`);
} finally {
  if (originalSite)
    await db.setting.upsert({
      where: { key: 'site' },
      create: originalSite as any,
      update: { value: json(originalSite.value), version: originalSite.version },
    });
  else await db.setting.deleteMany({ where: { key: 'site' } });
  await writeFile(
    '.runtime/reports/enhancements.json',
    JSON.stringify({ checks, at: new Date().toISOString() }, null, 2),
  );
  await redis.quit();
  await db.$disconnect();
}
