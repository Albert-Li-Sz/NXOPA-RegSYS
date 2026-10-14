import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client, until, base } from './client.js';
import {
  policySchema,
  defaultFields,
  defaultTemplate,
} from '../../packages/contracts/src/index.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
if (config.production) throw new Error('Acceptance fixtures must run in development');
const report: { case: string; status: string; details?: unknown }[] = [];
const run = Date.now().toString();
const record = (name: string, details?: unknown) => {
  report.push({ case: name, status: 'PASS', details });
  console.log(`PASS ${name}`);
};
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice'),
    bob = await new Client().login('bob'),
    carol = await new Client().login('carol'),
    teacher = await new Client().login('teacher'),
    manager = await new Client().login('manager');
  async function contest(policy: Record<string, unknown>, fields = defaultFields) {
    const c = await admin.api('/contests', 'POST', {
      title: `验收竞赛 ${run} ${report.length}`,
      season: '验收',
      description: '独立验收数据',
      announcement: '',
      location: '示例大学竞赛楼',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      published: true,
      policy: policySchema.parse(policy),
      fields,
    });
    const authorization = await admin.api('/admin/roles', 'POST', {
      userId: manager.user.id,
      contestId: c.id,
      grant: true,
    });
    await manager.api(
      `/invitations/${new URL(authorization.url).pathname.split('/').pop()}/accept`,
      'POST',
      {},
    );
    manager.user = (await manager.api('/auth/me')).user;
    return c;
  }
  async function detail(c: Client, r: any) {
    return c.api(`/registrations/${r.id}`);
  }
  async function save(c: Client, r: any, overrides: Record<string, unknown> = {}) {
    return c.api(`/registrations/${r.id}`, 'PUT', {
      version: r.version,
      teamName: r.teamName,
      teamEnglishName: r.teamEnglishName,
      answers: r.answers,
      people: r.people,
      ...overrides,
    });
  }
  async function submit(c: Client, r: any) {
    return c.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  }
  async function approve(r: any) {
    return admin.api(`/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'APPROVED',
    });
  }
  const free = await contest({ manualReview: true, coachMode: 'OPTIONAL' });
  const idem = randomUUID();
  const [one, two] = await Promise.all([
    alice.api('/registrations', 'POST', { contestId: free.id }, idem),
    alice.api('/registrations', 'POST', { contestId: free.id }, idem),
  ]);
  assert.equal(one.id, two.id);
  assert.equal(await db.registration.count({ where: { contestId: free.id } }), 1);
  record('atomic HTTP idempotency / concurrent create');
  let r = await submit(alice, one);
  assert.equal(r.eligible, false);
  r = await approve(r);
  assert.equal(r.eligible, true);
  record('free individual, optional coach, review and eligibility');
  assert.equal((await bob.raw(`/api/v1/registrations/${r.id}`)).status, 403);
  assert.equal((await manager.raw('/api/v1/admin/users')).status, 403);
  assert.equal(
    (await alice.raw(`/api/v1/registrations/${r.id}`, 'PUT', {}, randomUUID())).status,
    400,
  );
  record('participant isolation and manager scope');
  const stale = r;
  const edits = await Promise.all([
    alice.raw(
      `/api/v1/registrations/${r.id}`,
      'PUT',
      { ...r, version: r.version, teamName: '并发 A' },
      randomUUID(),
    ),
    alice.raw(
      `/api/v1/registrations/${r.id}`,
      'PUT',
      { ...r, version: r.version, teamName: '并发 B' },
      randomUUID(),
    ),
  ]);
  assert.deepEqual(edits.map((x) => x.status).sort(), [200, 409]);
  r = await detail(alice, r);
  assert.equal(r.eligible, false);
  assert.equal(r.status, 'CORRECTION');
  record('optimistic concurrency and critical edits invalidate qualification');
  r = await save(alice, r, {
    people: r.people.map((p: any) => ({
      ...p,
      name: '中文选手 & 100%_#',
      answers: { ...p.answers, school: '示例大学 & 学院' },
    })),
  });
  r = await approve(await submit(alice, r));
  const teamContest = await contest({
    mode: 'TEAM',
    minMembers: 3,
    maxMembers: 3,
    memberMode: 'INVITE',
    coachMode: 'REQUIRED',
  });
  let team = await alice.api('/registrations', 'POST', { contestId: teamContest.id });
  team = await save(alice, team, { teamName: '示例团队' });
  assert.equal(
    (await alice.raw(`/api/v1/registrations/${team.id}/submit`, 'POST', { version: team.version }))
      .status,
    400,
  );
  for (const c of [bob, carol]) {
    const i = await alice.api(`/registrations/${team.id}/invites`, 'POST', {
      kind: 'MEMBER',
      targetEmail: c.user.email,
    });
    const t = i.url.split('/').at(-1);
    await c.api(`/invitations/${t}/accept`, 'POST', {});
    await c.api(`/invitations/${t}/accept`, 'POST', {});
  }
  const coachLink = await teacher.api('/coach/links', 'POST', { kind: 'COACH_LINK' });
  await alice.api(`/invitations/${coachLink.url.split('/').at(-1)}/accept`, 'POST', {
    registrationId: team.id,
  });
  team = await detail(teacher, team);
  assert.equal(team.coaches.length, 1);
  team = await save(teacher, team, { teamEnglishName: 'Shared admission' });
  team = await approve(await submit(teacher, team));
  assert.equal(team.eligible, true);
  record('invited team, confirmed teacher link, teacher edits and submits');
  const personalPdf = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [r.id],
    room: 'A101',
    seat: '1',
  });
  const teamPdf = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [team.id],
    room: 'A101',
    seat: '2',
  });
  const documentIds = [personalPdf.results[0].documentId, teamPdf.results[0].documentId];
  for (const [i, id] of documentIds.entries()) {
    const owner = i ? team : r;
    await until(
      () => detail(admin, owner),
      (x) => x.admissions.some((a: any) => a.id === id && a.state === 'READY'),
      120000,
    );
    const denied = await alice.raw(`/api/v1/admissions/${id}/download`);
    assert.equal(denied.status, 403);
    await admin.api(`/admissions/${id}/release`, 'POST');
    const download = await alice.raw(`/api/v1/admissions/${id}/download`);
    assert.equal(download.status, 200);
    const pdf = Buffer.from(await download.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    await mkdir('.runtime/reports', { recursive: true });
    await writeFile(`.runtime/reports/${i ? 'team' : 'individual'}.pdf`, pdf);
  }
  assert.equal((await detail(admin, team)).admissions.length, 1);
  record('Chinese individual / shared team PDF, release and download authorization', documentIds);
  team = await detail(alice, team);
  await alice.api(`/registrations/${team.id}/coaches/${team.coaches[0].id}`, 'DELETE', {
    version: team.version,
  });
  assert.equal((await teacher.raw(`/api/v1/registrations/${team.id}`)).status, 403);
  assert.equal((await alice.raw(`/api/v1/admissions/${documentIds[1]}/download`)).status, 403);
  record('teacher unlink immediately revokes access and admission');
  const fee = await contest({
    mode: 'TEAM',
    memberMode: 'MANUAL',
    minMembers: 3,
    maxMembers: 3,
    coachMode: 'DISABLED',
    feeMode: 'PER_PERSON',
    feeCents: 1000,
    paymentSequence: 'REVIEW_FIRST',
  });
  let paid = await alice.api('/registrations', 'POST', { contestId: fee.id });
  paid = await save(alice, paid, {
    teamName: '代填团队',
    people: [
      paid.people[0],
      ...['代填甲', '代填乙'].map((name, i) => ({
        name,
        email: '',
        captain: false,
        answers: {
          school: '示例大学',
          student_id: `${run}-${i}`,
          phone: '00000000000',
          class_name: '验收一班',
          college: '验收学院',
          gender: '男',
        },
      })),
    ],
  });
  paid = await submit(alice, paid);
  assert.equal(paid.feeCents, 3000);
  const proof = await alice.upload(paid.id);
  const input = {
    amountCents: 1000,
    channel: '验收银行',
    reference: `partial-${run}`,
    payer: '示例队长',
    paidAt: new Date().toISOString(),
    attachmentId: proof.id,
  };
  assert.equal((await alice.raw(`/api/v1/finance/${paid.id}/vouchers`, 'POST', input)).status, 400);
  paid = await approve(paid);
  let v = await alice.api(`/finance/${paid.id}/vouchers`, 'POST', input);
  assert.equal((await detail(alice, paid)).eligible, false);
  await Promise.all([
    admin.api(`/finance/vouchers/${v.id}/review`, 'POST', { decision: 'CONFIRMED' }),
    admin.api(`/finance/vouchers/${v.id}/review`, 'POST', { decision: 'CONFIRMED' }),
  ]);
  paid = await detail(alice, paid);
  assert.equal(paid.netPaidCents, 1000);
  assert.equal(paid.eligible, false);
  assert.equal(paid.ledger.filter((e: any) => e.kind === 'PAYMENT').length, 1);
  v = await alice.api(`/finance/${paid.id}/vouchers`, 'POST', {
    ...input,
    amountCents: 2000,
    reference: `full-${run}`,
  });
  await admin.api(`/finance/vouchers/${v.id}/review`, 'POST', { decision: 'CONFIRMED' });
  paid = await detail(alice, paid);
  assert.equal(paid.netPaidCents, 3000);
  assert.equal(paid.eligible, true);
  record('manual team, per-person fee, review first, partial payment, duplicate confirmation');
  const invoice = await alice.api(`/finance/${paid.id}/invoices`, 'POST', {
    amountCents: 3000,
    title: '示例大学',
    taxId: 'TEST',
    email: alice.user.email,
  });
  const f = await admin.upload(paid.id);
  await admin.api(`/finance/invoices/${invoice.id}/review`, 'POST', {
    decision: 'ISSUED',
    attachmentId: f.id,
  });
  assert.equal((await alice.raw(`/api/v1/files/${f.id}`)).status, 200);
  await admin.api(`/finance/invoices/${invoice.id}/review`, 'POST', {
    decision: 'VOID',
    reason: '验收退款前作废',
  });
  record('invoice request, admin uploads invoice, authorized download and void');
  const before = await contest({
    feeMode: 'FIXED',
    feeCents: 2000,
    paymentSequence: 'PAYMENT_FIRST',
    coachMode: 'DISABLED',
  });
  let prepaid = await submit(
    bob,
    await bob.api('/registrations', 'POST', { contestId: before.id }),
  );
  assert.equal(
    (
      await admin.raw(`/api/v1/registrations/${prepaid.id}/review`, 'POST', {
        version: prepaid.version,
        decision: 'APPROVED',
      })
    ).status,
    400,
  );
  const pf = await bob.upload(prepaid.id);
  const pv = await bob.api(`/finance/${prepaid.id}/vouchers`, 'POST', {
    ...input,
    amountCents: 2000,
    reference: `prepay-${run}`,
    attachmentId: pf.id,
  });
  await admin.api(`/finance/vouchers/${pv.id}/review`, 'POST', { decision: 'CONFIRMED' });
  prepaid = await detail(admin, prepaid);
  prepaid = await admin.api(`/registrations/${prepaid.id}/review`, 'POST', {
    version: prepaid.version,
    decision: 'REJECTED',
    reason: '验收拒绝后退款',
  });
  assert.equal(prepaid.eligible, false);
  const refund = await bob.api(`/finance/${prepaid.id}/refunds`, 'POST', {
    amountCents: 2000,
    reason: '预缴后拒绝',
  });
  await admin.api(`/finance/refunds/${refund.id}/review`, 'POST', { decision: 'APPROVED' });
  await Promise.all([
    admin.api(`/finance/refunds/${refund.id}/review`, 'POST', {
      decision: 'COMPLETED',
      reference: `refund-${run}`,
    }),
    admin.api(`/finance/refunds/${refund.id}/review`, 'POST', {
      decision: 'COMPLETED',
      reference: `refund-${run}`,
    }),
  ]);
  prepaid = await detail(admin, prepaid);
  assert.equal(prepaid.netPaidCents, 0);
  assert.equal(prepaid.ledger.filter((e: any) => e.kind === 'REFUND').length, 1);
  record('payment first, rejection, actual offline refund is idempotent');
  const attachment = await alice.upload();
  const ticket = await alice.api('/support', 'POST', {
    contestId: free.id,
    registrationId: r.id,
    title: '准考证咨询',
    category: '准考证',
    text: '请协助确认',
    attachments: [attachment.id],
  });
  assert.equal((await bob.raw(`/api/v1/support/${ticket.id}`)).status, 403);
  await manager.api(`/support/${ticket.id}/messages`, 'POST', {
    version: ticket.version,
    text: '已确认',
    status: 'RESOLVED',
    attachments: [],
  });
  assert.equal((await alice.api(`/support/${ticket.id}`)).status, 'RESOLVED');
  record('scoped support, attachments, replies and status');
  const token = await admin.api('/admin/tokens', 'POST', {
    name: `acceptance-${run}`,
    contestIds: [free.id],
    scopes: ['contests:read', 'registrations:read', 'finance:read', 'support:read'],
    fields: ['PERSON.name'],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const read = await fetch(`${base}/api/automation/v1/registrations/${r.id}`, {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  const filtered = (await read.json()) as any;
  assert.equal(filtered.people[0].name, '中文选手 & 100%_#');
  assert.equal(filtered.people[0].email, undefined);
  assert.deepEqual(filtered.people[0].answers, {});
  assert.equal(
    (
      await fetch(`${base}/api/automation/v1/registrations/${team.id}`, {
        headers: { Authorization: `Bearer ${token.token}` },
      })
    ).status,
    403,
  );
  record('automation token contest and field boundaries');
  const bad = await admin.api('/admissions/preview', 'POST', {
    source: '\\documentclass{article}\\begin{document}\\undefinedcommand\\end{document}',
  });
  const failure = await until(
    () => admin.api(`/jobs/${bad.id}`),
    (j) => j.state === 'FAILED',
    120000,
  );
  assert.ok(failure.error);
  record('compiler failures persisted and queryable');
  const templateChange = await admin.api('/admissions/templates', 'POST', {
    contestId: free.id,
    name: '新模板版本',
    source: defaultTemplate,
  });
  assert.equal((await alice.raw(`/api/v1/admissions/${documentIds[0]}/download`)).status, 403);
  record('template version invalidates previously issued admission');
  await writeFile(
    '.runtime/acceptance-context.json',
    JSON.stringify(
      {
        individual: r.id,
        team: team.id,
        paid: paid.id,
        freeContest: free.id,
        ticket: ticket.id,
        token: token.token,
        tokenId: token.id,
        templateId: templateChange.id,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Business acceptance: ${report.length} cases passed`);
} finally {
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile('.runtime/reports/business.json', JSON.stringify({ run, report }, null, 2));
  await db.$disconnect();
  await redis.quit();
}
