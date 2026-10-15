import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../apps/server/src/db.js';
import { writeFile } from 'node:fs/promises';
import { Client } from './client.js';
import { policySchema } from '../../packages/contracts/src/index.js';

const checks: string[] = [],
  failures: string[] = [];
async function check(name: string, test: () => Promise<void>) {
  try {
    await test();
    checks.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.log(`FAIL ${name}: ${(error as Error).message}`);
  }
}
const admin = await new Client().login('admin'),
  owner = await new Client().login('alice'),
  viewer = await new Client().login('bob');
const contest = await admin.api('/contests', 'POST', {
  title: '细分授权与资料边界回归',
  season: '回归',
  description: '虚构回归数据',
  startsAt: new Date(Date.now() + 86400000).toISOString(),
  opensAt: new Date(Date.now() - 10000).toISOString(),
  closesAt: new Date(Date.now() + 86400000).toISOString(),
  published: true,
  policy: policySchema.parse({ coachMode: 'DISABLED' }),
  fields: [],
});
const grant = await admin.api('/admin/grants', 'POST', {
  userId: viewer.user.id,
  level: 'CONTEST',
  contestId: contest.id,
  permissions: ['VIEW'],
});
const registration = await owner.api('/registrations', 'POST', { contestId: contest.id });
async function ticket(registrationId?: string) {
  return owner.api('/support', 'POST', {
    contestId: contest.id,
    registrationId,
    title: '私有工单',
    category: '回归',
    text: '仅工单授权管理员及参与人可读',
  });
}
const standalone = await ticket(),
  linked = await ticket(registration.id);
const upload = async (ticketId: string) => {
  const form = new FormData();
  form.append('file', new Blob(['private support file'], { type: 'text/plain' }), 'support.txt');
  return owner.api(`/files?ticketId=${ticketId}`, 'POST', form);
};
const standaloneFile = await upload(standalone.id),
  linkedFile = await upload(linked.id);
await check('job search retains contest authorization scope', async () => {
  const resourceId = randomUUID();
  const job = await db.job.create({
    data: {
      kind: 'WEBHOOK',
      resourceId,
      dedupeKey: `permission-test:${resourceId}`,
      state: 'SUCCESS',
      payload: {},
      error: 'Private task from another activity',
    },
  });
  try {
    const result = await viewer.api(`/admin/jobs?page=1&pageSize=20&search=${resourceId}`);
    assert.equal(result.total, 0, 'Search must not replace the contest resource scope');
  } finally {
    await db.job.delete({ where: { id: job.id } });
  }
});
await check('VIEW grant cannot enumerate other users support tickets', async () => {
  const rows = await viewer.api(`/support?contestId=${contest.id}&page=1&pageSize=20`);
  assert.equal(rows.total, 0);
});
for (const [name, item, file] of [
  ['standalone', standalone, standaloneFile],
  ['registration-linked', linked, linkedFile],
] as const) {
  await check(`VIEW grant cannot read ${name} ticket`, async () => {
    assert.equal((await viewer.raw(`/api/v1/support/${item.id}`)).status, 403);
  });
  await check(`VIEW grant cannot read ${name} support file`, async () => {
    assert.equal((await viewer.raw(`/api/v1/files/${file.id}`)).status, 403);
  });
  await check(`VIEW grant cannot upload to ${name} ticket`, async () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob(['unauthorized support file'], { type: 'text/plain' }),
      'denied.txt',
    );
    assert.equal((await viewer.raw(`/api/v1/files?ticketId=${item.id}`, 'POST', form)).status, 403);
  });
  await check(`VIEW grant cannot read ${name} support mail status`, async () => {
    assert.equal(
      (await viewer.raw(`/api/v1/notifications/mail?resourceId=${item.id}`)).status,
      403,
    );
  });
}
await check('invalid student year returns a validation error', async () => {
  const response = await admin.raw('/api/v1/admin/students?year=not-a-year&page=1&pageSize=20');
  assert.equal(response.status, 400);
});
await check('invalid calendar date cannot enter identity approval queue', async () => {
  const current = (await owner.api('/auth/me')).user;
  const response = await owner.raw('/api/v1/auth/identity', 'POST', {
    version: current.version,
    kind: 'TEACHER',
    name: current.name,
    profile: {
      employee_id: `INVALID-${current.id}`,
      employed_at: '2026-02-31',
      college: '测试院系',
      gender: '男',
    },
  });
  assert.equal(response.status, 400);
});
await check('deleting a submitted form attachment invalidates qualification', async () => {
  const c = await admin.api('/contests', 'POST', {
    ...contest,
    title: '报名附件删除与资格回归',
    policy: policySchema.parse({ coachMode: 'DISABLED', manualReview: false }),
    fields: [
      { key: 'proof', label: '报名证明', type: 'file', scope: 'REGISTRATION', required: true },
    ],
  });
  let r = await owner.api('/registrations', 'POST', { contestId: c.id });
  try {
    const file = await owner.upload(r.id);
    r = await owner.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      answers: { registration: { proof: file.id } },
    });
    r = await owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    assert.equal(r.eligible, true);
    await owner.api(`/files/${file.id}`, 'DELETE');
    const current = await owner.api(`/registrations/${r.id}`);
    assert.equal(current.eligible, false, 'Removed required evidence must revoke qualification');
    assert.equal(current.status, 'CORRECTION');
    assert.equal(
      (
        await owner.raw(`/api/v1/registrations/${r.id}/submit`, 'POST', {
          version: current.version,
        })
      ).status,
      403,
    );
  } finally {
    const current = await owner.api(`/registrations/${r.id}`);
    await owner.api(`/registrations/${r.id}/cancel`, 'POST', { version: current.version });
  }
});
await check('deleted files cannot be bound to a new support ticket', async () => {
  const file = await owner.upload();
  await owner.api(`/files/${file.id}`, 'DELETE');
  const response = await owner.raw('/api/v1/support', 'POST', {
    contestId: contest.id,
    title: '已删除附件',
    category: '回归',
    text: '应拒绝无效引用',
    attachments: [file.id],
  });
  assert.equal(response.status, 400);
});
await check('a support attachment cannot be moved to another ticket', async () => {
  const response = await owner.raw('/api/v1/support', 'POST', {
    contestId: contest.id,
    title: '附件重复绑定',
    category: '回归',
    text: '旧工单引用必须保持有效',
    attachments: [standaloneFile.id],
  });
  assert.equal(response.status, 400);
  assert.equal((await owner.raw(`/api/v1/files/${standaloneFile.id}`)).status, 200);
});
const supportGrant = await admin.api('/admin/grants', 'POST', {
  userId: viewer.user.id,
  level: 'CONTEST',
  contestId: contest.id,
  permissions: ['SUPPORT'],
});
await check('SUPPORT grant permits ticket, file and delivery reads', async () => {
  for (const [item, file] of [
    [standalone, standaloneFile],
    [linked, linkedFile],
  ]) {
    assert.equal((await viewer.raw(`/api/v1/support/${item.id}`)).status, 200);
    assert.equal((await viewer.raw(`/api/v1/files/${file.id}`)).status, 200);
    assert.equal(
      (await viewer.raw(`/api/v1/notifications/mail?resourceId=${item.id}`)).status,
      200,
    );
  }
});
await check('SUPPORT revocation removes access immediately', async () => {
  await admin.api(`/admin/grants/${supportGrant.id}`, 'DELETE');
  assert.equal((await viewer.raw(`/api/v1/support/${linked.id}`)).status, 403);
  assert.equal((await owner.raw(`/api/v1/support/${linked.id}`)).status, 200);
});
await admin.api(`/admin/grants/${grant.id}`, 'DELETE');
await writeFile(
  '.runtime/reports/permission-regressions.json',
  JSON.stringify({ success: !failures.length, checks, failures }, null, 2),
);
await db.$disconnect();
assert.deepEqual(failures, []);
