import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { Client } from './client.js';
import { policySchema, defaultFields } from '../../packages/contracts/src/index.js';
if (config.production) throw new Error('Load data is restricted to development');
let contestId: string | undefined;
const ids = Array.from({ length: 10000 }, () => randomUUID()),
  userIds = ids.map(() => randomUUID()),
  run = Date.now();
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  const c = await db.contest.create({
    data: {
      title: `负载验收 ${run}`,
      season: '验收',
      description: '10000 registrations / 100 concurrent clients',
      startsAt: new Date(),
      opensAt: new Date(),
      closesAt: new Date(Date.now() + 86400000),
      policy: json(policySchema.parse({ coachMode: 'DISABLED', manualReview: false })),
      forms: { create: { version: 1, fields: json(defaultFields), schema: {} } },
    },
  });
  contestId = c.id;
  const started = performance.now();
  for (let chunk = 0; chunk < 10000; chunk += 500) {
    const n = ids.slice(chunk, chunk + 500);
    await db.$transaction(
      async (tx) => {
        await tx.user.createMany({
          data: n.map((id, i) => ({
            id: userIds[chunk + i]!,
            username: `load_${run}_${chunk + i}`,
            email: `load-${run}-${chunk + i}@example.test`,
            name: `负载选手 ${chunk + i}`,
            verified: true,
            profile: { school: '示例大学' },
          })),
        });
        await tx.registration.createMany({
          data: n.map((id, i) => ({
            id,
            ownerId: userIds[chunk + i]!,
            contestId: c.id,
            formVersion: 1,
            status: 'SUBMITTED',
            review: 'APPROVED',
            eligible: true,
            quoted: true,
            policySnapshot: c.policy as any,
            answers: { registration: {}, team: {} },
            snapshot: {
              people: [
                {
                  name: `负载选手 ${chunk + i}`,
                  answers: { school: '示例大学', student_id: String(chunk + i) },
                },
              ],
            },
          })),
        });
        await tx.registrationPerson.createMany({
          data: n.map((id, i) => ({
            registrationId: id,
            contestId: c.id,
            userId: userIds[chunk + i]!,
            captain: true,
            confirmed: true,
            name: `负载选手 ${chunk + i}`,
            email: `load-${run}-${chunk + i}@example.test`,
            answers: {
              school: '示例大学',
              student_id: String(chunk + i),
              major: '计算机科学与技术',
              phone: '00000000000',
              size: 'L',
            },
          })),
        });
      },
      { timeout: 30000 },
    );
  }
  assert.equal(await db.registration.count({ where: { contestId: c.id } }), 10000);
  const statistics = await admin.api(`/contests/${c.id}/statistics`);
  assert.equal(statistics.total, 10000);
  assert.equal(statistics.approved, 10000);
  console.log('Seeded 10000 realistic registration/person/user rows');
  const endpoints = [
      `/api/v1/registrations?contestId=${c.id}`,
      `/api/v1/registrations/${ids[0]}`,
      `/api/v1/contests/${c.id}`,
    ],
    durations: number[] = [],
    errors: any[] = [],
    counts = [0, 0, 0];
  const begin = performance.now();
  let index = 0;
  await Promise.all(
    Array.from({ length: 100 }, async () => {
      while (index < 1000) {
        const i = index++,
          slot = i % 3;
        const start = performance.now();
        try {
          const response = await fetch(`http://localhost:3000${endpoints[slot]}`, {
            headers: { Cookie: admin.cookie },
          });
          await response.arrayBuffer();
          if (!response.ok) errors.push({ endpoint: endpoints[slot], status: response.status });
          counts[slot]++;
        } catch (e) {
          errors.push({ endpoint: endpoints[slot], error: (e as Error).name });
        }
        durations.push(performance.now() - start);
      }
    }),
  );
  const elapsed = performance.now() - begin;
  durations.sort((a, b) => a - b);
  const percentile = (p: number) =>
    Math.round(durations[Math.floor((durations.length - 1) * p)]! * 10) / 10;
  const csv = await admin.raw(`/api/v1/registrations/export?contestId=${c.id}`);
  assert.equal(csv.status, 200);
  const exported = (await csv.text()).trim().split('\r\n').length - 1;
  assert.equal(exported, 10000);
  const pages: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await admin.api(
      `/registrations?contestId=${c.id}${cursor ? `&cursor=${cursor}` : ''}`,
    );
    pages.push(page.length);
    cursor = page.length === 500 ? page.at(-1).id : undefined;
  } while (cursor);
  assert.equal(
    pages.reduce((a, b) => a + b, 0),
    10000,
  );
  const report = {
    time: new Date().toISOString(),
    dataset: {
      registrations: 10000,
      people: 10000,
      users: 10000,
      seedMs: Math.round(begin - started),
    },
    concurrency: 100,
    statistics,
    requests: 1000,
    scenario:
      'authenticated read mix: 1/3 list (500 rows), 1/3 registration detail, 1/3 contest detail',
    counts,
    elapsedMs: Math.round(elapsed),
    requestsPerSecond: Math.round((1000 / (elapsed / 1000)) * 10) / 10,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: percentile(1),
    csvExported: exported,
    paginatedTotal: pages.reduce((a, b) => a + b, 0),
    errors,
  };
  await writeFile('.runtime/reports/load.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(errors.length, 0);
} finally {
  if (contestId) {
    await db.registration.deleteMany({ where: { contestId } });
    await db.formVersion.deleteMany({ where: { contestId } });
    await db.contest.delete({ where: { id: contestId } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
  await redis.quit();
}
