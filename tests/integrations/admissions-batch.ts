import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { Client, until, base } from './client.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { policySchema } from '../../packages/contracts/src/index.js';
import { db } from '../../apps/server/src/db.js';
if (config.production) throw new Error('Admission fixtures are development-only');
const fixture = JSON.parse(await readFile('.runtime/acceptance-context.json', 'utf8'));
const report: string[] = [];
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice'),
    bob = await new Client().login('bob');
  const generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [fixture.individual, fixture.paid],
    room: 'A101',
    seat: '1',
    incrementSeats: true,
  });
  const ids: string[] = [];
  for (const result of generated.results) {
    assert.ok(result.documentId);
    ids.push(result.documentId);
    await until(
      () => admin.api(`/registrations/${result.registrationId}`),
      (r) =>
        r.admissions.some(
          (d: any) => d.id === result.documentId && ['READY', 'RELEASED'].includes(d.state),
        ),
      120000,
    );
    await admin.api(`/admissions/${result.documentId}/release`, 'POST');
  }
  const response = await alice.raw('/api/v1/admissions/batch', 'POST', { ids: [...ids, ids[0]] });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/zip/);
  const archive = Buffer.from(await response.arrayBuffer());
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0);
  const count = archive.readUInt16LE(end + 10);
  assert.equal(count, 2);
  let cursor = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10),
      size = archive.readUInt32LE(cursor + 20),
      nameLength = archive.readUInt16LE(cursor + 28),
      extraLength = archive.readUInt16LE(cursor + 30),
      commentLength = archive.readUInt16LE(cursor + 32),
      local = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    assert.match(name, /^[A-Z0-9-]+\.pdf$/);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const compressed = archive.subarray(start, start + size);
    const pdf = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  await writeFile('.runtime/reports/admissions.zip', archive);
  report.push(
    'Actual ZIP contains two complete individual/shared-team PDFs; repeated ID is deduplicated',
  );
  assert.equal((await bob.raw('/api/v1/admissions/batch', 'POST', { ids })).status, 403);
  report.push('Mixed batch validates every document permission before sending ZIP');
  assert.equal(
    (
      await admin.raw('/api/v1/admissions/batch', 'POST', {
        ids: Array.from({ length: 1001 }, () => ids[0]),
      })
    ).status,
    400,
  );
  report.push('Oversized batch is rejected explicitly rather than silently truncating');
  const selected = await admin.raw('/api/v1/admissions/batch', 'POST', {
    registrationIds: [fixture.individual, fixture.paid],
  });
  assert.equal(selected.status, 200);
  const selectedZip = Buffer.from(await selected.arrayBuffer());
  const selectedEnd = selectedZip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(selectedZip.readUInt16LE(selectedEnd + 10), 2);
  report.push('Administrator registration selection resolves the current eligible documents');
  const registration = await admin.api(`/registrations/${fixture.paid}`);
  const contest = await admin.api('/contests', 'POST', {
    title: '验收自动审核的管理员否决',
    season: '验收',
    description: '自动审核仍服从管理员明确拒绝',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 10000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [],
  });
  let entry = await alice.api('/registrations', 'POST', { contestId: contest.id });
  entry = await alice.api(`/registrations/${entry.id}/submit`, 'POST', { version: entry.version });
  assert.equal(entry.eligible, true);
  entry = await admin.api(`/registrations/${entry.id}/review`, 'POST', {
    version: entry.version,
    decision: 'REJECTED',
    reason: '验收管理员否决',
  });
  assert.equal(entry.review, 'REJECTED');
  assert.equal(entry.eligible, false);
  await db.contest.update({ where: { id: contest.id }, data: { archived: true } });
  report.push(
    'Explicit administrator rejection revokes eligibility even for automatic-review competitions',
  );
  console.log(`Admission batch acceptance: ${report.length} checks passed`);
} finally {
  await writeFile('.runtime/reports/admissions-batch.json', JSON.stringify({ report }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
