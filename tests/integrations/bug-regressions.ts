import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from './client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { policySchema, type ContestPolicy } from '../../packages/contracts/src/index.js';

if (config.production) throw new Error('Bug regression fixtures are development-only');
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const contestIds: string[] = [];
const userIds: string[] = [];
const results: { case: string; status: string; error?: string }[] = [];
const selected = process.argv.slice(2);

async function check(name: string, fn: () => Promise<void>) {
  if (selected.length && !selected.includes(name)) return;
  try {
    await fn();
    results.push({ case: name, status: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ case: name, status: 'FAIL', error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function newcomer(kind: string) {
  const client = new Client();
  const session = await client.register({
    email: `${kind}-${run}@example.test`,
    username: `bug_${kind}_${run}`,
    name: 'BUG 回归用户',
    password: 'BugRegression2026!',
  });
  client.user = session.user;
  client.csrf = session.csrf;
  userIds.push(client.user.id);
  return client;
}

async function mailToken(userId: string, action: 'verify' | 'reset') {
  const messages = await db.outboxEvent.findMany({
    where: { resourceId: userId, type: 'MAIL' },
    orderBy: { createdAt: 'desc' },
  });
  const message = messages.find((row) =>
    String((row.payload as any).actionPath).startsWith(`/account/${action}?`),
  );
  assert.ok(message, 'The actual auth endpoint must create its email event');
  return new URL((message.payload as any).actionPath, 'http://localhost').searchParams.get(
    'token',
  )!;
}

async function changeEmail(client: Client, kind: string) {
  client.user = await client.api('/auth/profile', 'PUT', {
    version: client.user.version,
    name: client.user.name,
    profile: client.user.profile,
    email: `${kind}-new-${run}@example.test`,
  });
  assert.equal(client.user.verified, false);
}

try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  const alice = await new Client().login('alice');
  const bob = await new Client().login('bob');

  async function contest(overrides: Partial<ContestPolicy> = {}) {
    const c = await admin.api('/contests', 'POST', {
      title: `BUG 回归 ${run} ${contestIds.length}`,
      season: '回归测试',
      description: '隔离回归数据',
      startsAt: new Date(Date.now() + 172800000).toISOString(),
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      published: true,
      policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED', ...overrides }),
      fields: [],
    });
    contestIds.push(c.id);
    return c;
  }

  await check('old-verification-link', async () => {
    const client = await newcomer('verify');
    await changeEmail(client, 'verify-first');
    const old = await mailToken(client.user.id, 'verify');
    await changeEmail(client, 'verify');
    const response = await client.raw('/api/v1/auth/verify', 'POST', { token: old });
    assert.equal(response.status, 400, 'A previous mailbox must not verify the new address');
    assert.equal((await client.api('/auth/me')).user.verified, false);
    const current = await mailToken(client.user.id, 'verify');
    await client.api('/auth/verify', 'POST', { token: current });
    assert.equal((await client.api('/auth/me')).user.verified, true);
  });

  await check('old-reset-link', async () => {
    const client = await newcomer('reset');
    await client.api('/auth/forgot', 'POST', { email: client.user.email });
    const old = await mailToken(client.user.id, 'reset');
    await changeEmail(client, 'reset');
    const response = await client.raw('/api/v1/auth/reset', 'POST', {
      token: old,
      password: 'ChangedByOldMailbox2026!',
    });
    assert.equal(response.status, 400, 'A previous mailbox must not reset the account password');
    assert.equal((await client.api('/auth/me')).user.id, client.user.id);
    await client.api('/auth/forgot', 'POST', { email: client.user.email });
    const current = await mailToken(client.user.id, 'reset');
    await client.api('/auth/reset', 'POST', {
      token: current,
      password: 'CurrentMailbox2026!',
    });
    assert.equal((await client.api('/auth/me')).user, null);
    await new Client().login(client.user.email, 'CurrentMailbox2026!');
  });

  await check('cancellation-eligibility-event', async () => {
    for (const feeCents of [0, 1000]) {
      const c = await contest({ feeMode: feeCents ? 'FIXED' : 'FREE', feeCents });
      let r = await alice.api('/registrations', 'POST', { contestId: c.id });
      r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
      if (feeCents) {
        const proof = await alice.upload(r.id);
        const voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', {
          amountCents: feeCents,
          channel: '回归测试',
          payer: '示例付款人',
          reference: `cancel-${run}`,
          paidAt: new Date().toISOString(),
          attachmentId: proof.id,
        });
        await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', {
          decision: 'CONFIRMED',
        });
        r = await alice.api(`/registrations/${r.id}`);
      }
      assert.equal(r.eligible, true);
      const oldId = r.id;
      const receipt = await alice.api(`/registrations/${r.id}/cancel`, 'POST', {
        version: r.version,
      });
      assert.equal(receipt.deleted, true);
      assert.equal((await alice.raw(`/api/v1/registrations/${oldId}`)).status, 404);
      const removed = await db.outboxEvent.findFirstOrThrow({
        where: { resourceId: oldId, type: 'REGISTRATION_REMOVED' },
      });
      assert.equal((removed.payload as any).deleted, true);
      if (feeCents)
        assert.equal((await alice.api(`/finance/accounts/${oldId}`)).netPaidCents, feeCents);
    }
  });

  await check('unofficial-review-before-payment', async () => {
    const c = await contest({
      allowUnofficial: true,
      feeMode: 'FIXED',
      feeCents: 1000,
      paymentSequence: 'REVIEW_FIRST',
    });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      participationType: 'UNOFFICIAL',
    });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    assert.equal(r.review, 'PENDING');
    const proof = await alice.upload(r.id);
    const input = {
      amountCents: 1000,
      channel: '回归测试',
      payer: '示例付款人',
      reference: `bug-${run}`,
      paidAt: new Date().toISOString(),
      attachmentId: proof.id,
    };
    const response = await alice.raw(`/api/v1/finance/${r.id}/vouchers`, 'POST', input);
    assert.equal(response.status, 400, 'Mandatory unofficial review must precede payment');
    r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'APPROVED',
    });
    const voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', input);
    assert.equal(voucher.status, 'PENDING');
  });

  await check('team-member-support-list', async () => {
    const c = await contest({ mode: 'TEAM', minMembers: 2, maxMembers: 2 });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    const invite = await alice.api(`/registrations/${r.id}/invites`, 'POST', {
      kind: 'MEMBER',
      targetEmail: bob.user.email,
    });
    const token = new URL(invite.url).pathname.split('/').at(-1);
    await bob.api(`/invitations/${token}/accept`, 'POST', {});
    const ticket = await alice.api('/support', 'POST', {
      registrationId: r.id,
      title: `团队工单 ${run}`,
      category: '报名',
      text: '团队成员应能在工单列表找到可访问的工单',
    });
    assert.equal((await bob.api(`/support/${ticket.id}`)).id, ticket.id);
    const list = await bob.api(`/support?page=1&pageSize=20&contestId=${c.id}`);
    assert.ok(
      list.items.some((row: any) => row.id === ticket.id),
      'Team members must be able to find the shared ticket in their list',
    );
    const privateTicket = await admin.api('/support', 'POST', {
      title: `私有工单 ${run}`,
      category: '账号',
      text: '不得泄露无关联工单',
    });
    assert.equal((await bob.raw(`/api/v1/support/${privateTicket.id}`)).status, 403);
    const shared = await bob.api(`/support?page=1&pageSize=20&search=${run}`);
    assert.ok(shared.items.some((row: any) => row.id === ticket.id));
    assert.ok(!shared.items.some((row: any) => row.id === privateTicket.id));
    r = await alice.api(`/registrations/${r.id}`);
    await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      people: r.people.filter((person: any) => person.userId !== bob.user.id),
    });
    assert.equal((await bob.raw(`/api/v1/support/${ticket.id}`)).status, 403);
    assert.equal((await bob.api(`/support?page=1&pageSize=20&contestId=${c.id}`)).items.length, 0);
  });
} finally {
  if (contestIds.length)
    await db.contest.updateMany({ where: { id: { in: contestIds } }, data: { archived: true } });
  if (userIds.length) {
    await db.emailToken.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile('.runtime/reports/bug-regressions.json', JSON.stringify({ results }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
if (results.some((row) => row.status === 'FAIL')) process.exitCode = 1;
