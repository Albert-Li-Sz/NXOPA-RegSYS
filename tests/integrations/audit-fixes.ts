import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client, until, base } from './client.js';
import { request as httpRequest } from 'node:http';
import { db, atomicRequest, enqueue, lock } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { claimJob, renewJobLease, recoverExpiredJobs } from '../../apps/server/src/job-lease.js';
import { MailDeliveryService } from '../../apps/server/src/mail-delivery.js';
import { policySchema } from '../../packages/contracts/src/index.js';
import { config } from '../../apps/server/src/config.js';
if (config.production) throw new Error('Development fixtures only');
const checks: string[] = [];
const pass = (s: string) => {
  checks.push(s);
  console.log(`PASS ${s}`);
};
try {
  await atomicRequest(async () => {
    const job = await db.job.create({
      data: { kind: 'TEST', resourceId: randomUUID(), dedupeKey: randomUUID(), payload: {} },
    });
    const tokens = await Promise.all([claimJob(job.id), claimJob(job.id)]);
    assert.equal(tokens.filter(Boolean).length, 1);
    const token = tokens.find(Boolean)!;
    await db.job.update({
      where: { id: job.id },
      data: { updatedAt: new Date(Date.now() - 10 * 60000) },
    });
    await recoverExpiredJobs();
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).state, 'RUNNING');
    assert.equal(await renewJobLease(job.id, randomUUID()), false);
    assert.equal(await renewJobLease(job.id, token), true);
    await db.job.update({ where: { id: job.id }, data: { leaseUntil: new Date(Date.now() - 1) } });
    await recoverExpiredJobs();
    const next = await claimJob(job.id);
    assert.ok(next && next !== token);
    assert.equal(await renewJobLease(job.id, token), false);
    await db.job.delete({ where: { id: job.id } });
  });
  pass('Live leases survive old updatedAt; expired executions are fenced from renewal');
  await atomicRequest(async () => {
    const key = randomUUID();
    const job = await enqueue(db, 'SYNC', randomUUID(), key, { version: 1 });
    await db.job.update({ where: { id: job.id }, data: { state: 'SUCCESS', attempts: 4 } });
    assert.equal((await enqueue(db, 'SYNC', job.resourceId, key, {})).state, 'SUCCESS');
    const restarted = await enqueue(
      db,
      'SYNC',
      job.resourceId,
      key,
      { version: 2 },
      { restart: true },
    );
    assert.equal(restarted.id, job.id);
    assert.equal(restarted.state, 'PENDING');
    assert.equal(restarted.attempts, 0);
    assert.deepEqual(restarted.payload, { version: 2 });
    await db.outboxEvent.deleteMany({ where: { resourceId: job.resourceId } });
    await db.job.delete({ where: { id: job.id } });
  });
  pass('Automatic deduplication remains idempotent; explicit sync can restart terminal jobs');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice'),
    bob = await new Client().login('bob');
  for (const [purpose, mb] of [
    ['AVATAR', 5],
    ['PRIVATE', 10],
    ['TEAM', 50],
  ] as const) {
    const body = new FormData();
    body.append(
      'file',
      new Blob([new Uint8Array(mb * 1024 * 1024 + 1)], { type: 'text/plain' }),
      'oversized.txt',
    );
    assert.equal((await alice.raw(`/api/v1/files?purpose=${purpose}`, 'POST', body)).status, 413);
  }
  pass('AVATAR, PRIVATE and TEAM uploads enforce distinct request-size limits');
  const uploads = [1, 2].map(() => {
    const request = httpRequest(`${base}/api/v1/files`, {
      method: 'POST',
      headers: {
        Cookie: alice.cookie,
        'X-CSRF-Token': alice.csrf,
        'Content-Type': 'multipart/form-data; boundary=audit',
        'Transfer-Encoding': 'chunked',
      },
    });
    request.on('error', () => undefined);
    request.write(
      '--audit\r\nContent-Disposition: form-data; name="file"; filename="pending.txt"\r\nContent-Type: text/plain\r\n\r\npartial',
    );
    return request;
  });
  // Give both incomplete streams time to enter the server's asynchronous auth
  // and upload interceptors; a probe racing them could itself take the second slot.
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await until(
      async () => {
        const body = new FormData();
        body.append('file', new Blob(['probe'], { type: 'text/plain' }), 'probe.txt');
        return (await alice.raw('/api/v1/files', 'POST', body)).status;
      },
      (status) => status === 403,
      5000,
    );
  } finally {
    uploads.forEach((request) => request.destroy());
  }
  await until(
    async () => {
      const body = new FormData();
      body.append('file', new Blob(['resumed'], { type: 'text/plain' }), 'resumed.txt');
      return (await alice.raw('/api/v1/files', 'POST', body)).status;
    },
    (status) => status === 201,
    5000,
  );
  pass('Two active uploads enforce the gate; aborted connections release both slots');
  const failed = await db.job.create({
    data: {
      kind: 'MAIL',
      resourceId: alice.user.id,
      dedupeKey: randomUUID(),
      state: 'FAILED',
      attempts: 4,
      payload: {
        to: alice.user.email,
        subject: `audit-${randomUUID()}`,
        text: 'Audit retry',
        category: 'GENERIC',
      },
    },
  });
  const retry = await Promise.allSettled([
    new MailDeliveryService().retry(alice.user, failed.id),
    new MailDeliveryService().retry(alice.user, failed.id),
  ]);
  assert.equal(retry.filter((r) => r.status === 'fulfilled').length, 1);
  await until(
    () => db.job.findUniqueOrThrow({ where: { id: failed.id } }),
    (j) => j.state === 'SUCCESS',
  );
  assert.equal(
    await db.job.count({
      where: {
        resourceId: alice.user.id,
        payload: { path: ['subject'], equals: (failed.payload as any).subject },
      },
    }),
    1,
  );
  pass('Concurrent manual mail retries reuse one delivery job');
  const contest = await admin.api('/contests', 'POST', {
    title: `审计回归 ${Date.now()}`,
    season: '验收',
    description: '审计专项验证',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [],
  });
  const registrations: { id: string; version: number }[] = [];
  for (const client of [alice, bob]) {
    let r = await client.api('/registrations', 'POST', { contestId: contest.id });
    r = await client.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    assert.equal(r.eligible, true);
    registrations.push(r);
  }
  const number = `AUDIT-${randomUUID().toUpperCase()}`;
  const conflict = await admin.raw('/api/v1/admissions/generate', 'POST', {
    registrationIds: registrations.map((r) => r.id),
    seats: registrations.map((r) => ({ registrationId: r.id, number, room: '', seat: '' })),
  });
  assert.equal(conflict.status, 400);
  assert.equal(
    await db.admissionDocument.count({
      where: { registrationId: { in: registrations.map((r) => r.id) } },
    }),
    0,
  );
  // Both requests must finish the preflight before either can write. Holding
  // their registration locks makes the unique-number race deterministic.
  let releaseLocks!: () => void;
  let locksReady!: () => void;
  const release = new Promise<void>((resolve) => (releaseLocks = resolve));
  const ready = new Promise<void>((resolve) => (locksReady = resolve));
  const blocker = db.$transaction(
    async (tx) => {
      for (const id of registrations.map((r) => r.id).sort()) await lock(tx, id);
      locksReady();
      await release;
    },
    { timeout: 15000 },
  );
  await ready;
  const raceNumber = `RACE-${randomUUID().toUpperCase()}`;
  const raced = Promise.all(
    registrations.map((r) =>
      admin.raw(
        '/api/v1/admissions/generate',
        'POST',
        {
          registrationIds: [r.id],
          seats: [{ registrationId: r.id, number: raceNumber, room: '', seat: '' }],
        },
        randomUUID(),
      ),
    ),
  );
  try {
    await until(
      () =>
        db.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        `,
      (rows) => Number(rows[0]!.count) >= 2,
      5000,
    );
  } finally {
    releaseLocks();
    await blocker;
  }
  const responses = await raced;
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 400]);
  assert.match(
    await responses.find((response) => response.status === 400)!.text(),
    /编号.*已被使用/,
  );
  assert.equal(await db.admissionDocument.count({ where: { number: raceNumber } }), 1);
  pass('Concurrent idempotent admission requests report number conflicts without HTTP 500');
  const generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [registrations[0].id],
    releaseAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const documentId = generated.results[0].documentId;
  await until(
    () => db.admissionDocument.findUniqueOrThrow({ where: { id: documentId } }),
    (d) => d.state === 'READY',
    120000,
  );
  await admin.api('/admissions/generate', 'POST', {
    registrationIds: [registrations[0].id],
    releaseAt: null,
  });
  assert.equal(
    (await db.admissionDocument.findUniqueOrThrow({ where: { id: documentId } })).releaseAt,
    null,
  );
  pass('Duplicate admission numbers fail before writing; scheduled release can be cleared');
  const file = await alice.upload(registrations[0].id);
  const removed = await alice.api(`/registrations/${registrations[0].id}/cancel`, 'POST', {
    version: registrations[0].version,
  });
  assert.equal(removed.deleted, true);
  const tombstone = await db.attachment.findUniqueOrThrow({ where: { id: file.id } });
  assert.ok(tombstone.deletedAt);
  assert.equal(tombstone.registrationId, null);
  assert.equal((await alice.raw(`/api/v1/files/${file.id}`)).status, 404);
  await until(
    () => db.attachment.findUniqueOrThrow({ where: { id: file.id } }),
    (f) => !!f.purgedAt,
  );
  pass(
    'Cancellation hides attachment immediately and releases accounted bytes only after physical purge',
  );
} finally {
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/audit-fixes.json',
    JSON.stringify({ checks, checkedAt: new Date().toISOString() }, null, 2),
  );
  await db.$disconnect();
  await redis.quit();
}
assert.equal(checks.length, 8);
