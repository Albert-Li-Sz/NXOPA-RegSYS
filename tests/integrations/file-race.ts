import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

if (process.env.NODE_ENV !== 'development')
  throw new Error('File race fixtures require development');
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    owner = await new Client().login('alice');
  const contest = await admin.api('/contests', 'POST', {
    title: '财务凭证删除并发回归',
    season: '回归',
    description: '虚构回归数据',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 10000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({
      coachMode: 'DISABLED',
      manualReview: false,
      feeMode: 'FIXED',
      feeCents: 100,
      paymentSequence: 'PAYMENT_FIRST',
    }),
    fields: [],
  });
  let registration = await owner.api('/registrations', 'POST', { contestId: contest.id });
  registration = await owner.api(`/registrations/${registration.id}/submit`, 'POST', {
    version: registration.version,
  });
  const file = await owner.upload(registration.id);
  const voucher = (attachmentId: string) => ({
    amountCents: 100,
    channel: '回归转账',
    payer: '虚构用户',
    paidAt: new Date().toISOString(),
    attachmentId,
  });
  let ready!: () => void, release!: () => void;
  const locked = new Promise<void>((resolve) => (ready = resolve));
  const unlock = new Promise<void>((resolve) => (release = resolve));
  const blocker = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Attachment" WHERE id = ${file.id} FOR UPDATE`;
      ready();
      await unlock;
    },
    { timeout: 45000 },
  );
  await locked;
  const waiting = async () => {
    const [row] = await db.$queryRaw<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return row!.count;
  };
  let removing: Promise<Response> | undefined, binding: Promise<Response> | undefined;
  try {
    removing = owner.raw(`/api/v1/files/${file.id}`, 'DELETE');
    await until(waiting, (count) => count >= 1, 10000);
    binding = owner.raw(`/api/v1/finance/${registration.id}/vouchers`, 'POST', voucher(file.id));
    await until(waiting, (count) => count >= 2, 10000);
  } finally {
    release();
    await blocker;
  }
  const [removed, bound] = await Promise.all([removing!, binding!]);
  assert.equal(removed.status, 200);
  assert.equal(
    bound.status,
    403,
    'Deleted proof must not be accepted by a request that read it before deletion committed',
  );
  assert.equal(await db.paymentVoucher.count({ where: { attachmentId: file.id } }), 0);
  const retained = await owner.upload(registration.id);
  await owner.api(`/finance/${registration.id}/vouchers`, 'POST', voucher(retained.id));
  assert.equal((await owner.raw(`/api/v1/files/${retained.id}`, 'DELETE')).status, 400);
  assert.equal((await owner.raw(`/api/v1/files/${retained.id}`)).status, 200);
  await writeFile(
    '.runtime/reports/file-race.json',
    JSON.stringify(
      { success: true, concurrentDeleteAndBind: 'PASS', financialProofRetention: 'PASS' },
      null,
      2,
    ),
  );
  console.log(
    'PASS deterministic concurrent deletion / voucher binding and financial proof retention',
  );
} finally {
  await db.$disconnect();
  await redis.quit();
}
