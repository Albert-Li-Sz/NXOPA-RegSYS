import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, until } from './client.js';
import { exportFixture } from './platform-export-fixture.js';
import { pdfText } from './pdf-text.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';

const stage = await mkdtemp(path.join(tmpdir(), 'competition-accounts-'));
const evidence = process.env.ACCOUNT_QA_DIR ?? path.join(tmpdir(), 'contest-center-accounts-qa');
await mkdir(evidence, { recursive: true });
const fixtures: Awaited<ReturnType<typeof exportFixture>>[] = [];
const checks: string[] = [];
let serial = 0;
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  async function bundle(id: string, platform: string, extra = {}) {
    await redis.del(`rate:exports:${admin.user.id}`);
    const response = await until(
      async () => {
        const response = await admin.raw(`/api/v1/contests/${id}/platform-exports`, 'POST', {
          platform,
          ...extra,
        });
        return response.status === 429 ? null : response;
      },
      (response) => response !== null,
      15000,
    );
    assert.ok(response);
    assert.equal(response.status, 201, await response.clone().text());
    const file = path.join(stage, `${serial++}.zip`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const text = (name: string) => execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' });
    return {
      teams: JSON.parse(text('teams.json')),
      accounts: platform === 'DOMJUDGE' ? JSON.parse(text('accounts.json')) : null,
      csv: text('credentials.csv'),
    };
  }
  async function generate(registrationId: string) {
    await redis.del(
      `admission-generate:${admin.user.id}`,
      `rate:admission-generate:${admin.user.id}`,
    );
    const result = await admin.api('/admissions/generate', 'POST', {
      registrationIds: [registrationId],
      room: 'A101',
      seat: '1',
    });
    assert.ok(result.results[0].documentId, JSON.stringify(result));
    return result.results[0].documentId as string;
  }
  async function pdf(documentId: string, label: string) {
    await until(
      () => db.admissionDocument.findUniqueOrThrow({ where: { id: documentId } }),
      (d) => {
        assert.notEqual(d.state, 'FAILED', d.error ?? 'PDF compilation failed');
        return ['READY', 'RELEASED'].includes(d.state);
      },
      120000,
    );
    const response = await admin.raw(`/api/v1/admissions/${documentId}/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const file = path.join(evidence, `${label}.pdf`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const text = await pdfText(new Uint8Array(await readFile(file)));
    return text.replace(/\s/g, '');
  }
  for (const mode of ['TEAM', 'INDIVIDUAL'] as const) {
    const f = await exportFixture(admin.user.id, mode);
    fixtures.push(f);
    await db.contest.update({
      where: { id: f.contest.id },
      data: { modules: { admissions: true, rooms: false, integrations: true } },
    });
    await db.contest.update({ where: { id: f.contest.id }, data: { title: '2026 程序设计竞赛' } });
    for (const [index, row] of f.rows.slice(0, 2).entries()) {
      f.studentIds[index] = `002026000${index + 1}`;
      await db.registrationPerson.updateMany({
        where: { registrationId: row.id },
        data: {
          name: index === 0 ? '张三' : '赵六',
          answers: { student_id: f.studentIds[index], school: '南京晓庄学院' },
        },
      });
      await db.registration.update({
        where: { id: row.id },
        data: { teamName: mode === 'TEAM' ? (index === 0 ? '晓庄战队' : '特邀队') : '' },
      });
    }
    if (mode === 'TEAM')
      await db.registrationPerson.createMany({
        data: ['李四', '王五'].map((name) => ({
          registrationId: f.rows[0]!.id,
          contestId: f.contest.id,
          name,
          answers: { school: '南京晓庄学院' },
        })),
      });
    await db.formVersion.create({
      data: { contestId: f.contest.id, version: 1, fields: [], schema: {} },
    });
    const first = f.rows[0]!;
    const documentId = await generate(first.id);
    const initialPdf = await pdf(documentId, `${mode.toLowerCase()}-admission-first`);
    const hydro = await bundle(f.contest.id, 'HYDRO');
    const dom = await bundle(f.contest.id, 'DOMJUDGE');
    assert.equal(hydro.teams[0].name, f.studentIds[0]);
    assert.equal(dom.accounts[0].username, hydro.teams[0].name);
    assert.equal(dom.accounts[0].password, hydro.teams[0].password);
    assert.equal(dom.accounts[0].id, first.id);
    assert.equal(dom.accounts[0].team_id, first.id);
    assert.equal(dom.teams[0].id, first.id);
    for (const value of [hydro.teams[0].name, hydro.teams[0].password]) {
      assert.ok(
        initialPdf.includes(value),
        'Actual admission PDF must contain the exported credential',
      );
      assert.ok(hydro.csv.includes(value));
      assert.ok(dom.csv.includes(value));
    }
    assert.notEqual(hydro.teams[0].password, hydro.teams[1].password);
    const secondPdf = await pdf(
      await generate(f.rows[1]!.id),
      `${mode.toLowerCase()}-export-first`,
    );
    assert.ok(secondPdf.includes(hydro.teams[1].password));
    const [again, concurrent, repeatedDocument] = await Promise.all([
      bundle(f.contest.id, 'HYDRO'),
      bundle(f.contest.id, 'DOMJUDGE'),
      generate(first.id),
    ]);
    assert.deepEqual(again.teams, hydro.teams);
    assert.deepEqual(concurrent.accounts, dom.accounts);
    assert.equal(repeatedDocument, documentId);
    assert.equal(await db.competitionAccount.count({ where: { contestId: f.contest.id } }), 2);
    const detail = await admin.api(`/registrations/${first.id}`);
    assert.ok(!JSON.stringify(detail).includes(hydro.teams[0].password));
    checks.push(
      `${mode}: PDF-first/export-first, shared credentials, concurrent operations, distinct passwords and private APIs`,
    );

    const captain = await db.registrationPerson.findFirstOrThrow({
      where: { registrationId: first.id, captain: true },
    });
    const changedId = `00changed${f.contest.id.replaceAll('-', '').slice(0, 12)}`;
    await db.registrationPerson.update({
      where: { id: captain.id },
      data: { answers: { student_id: changedId } },
    });
    await db.registration.update({ where: { id: first.id }, data: { version: { increment: 1 } } });
    const changed = await bundle(f.contest.id, 'HYDRO');
    assert.equal(changed.teams[0].name, changedId);
    assert.equal(changed.teams[0].id, hydro.teams[0].id);
    assert.equal(changed.teams[0].password, hydro.teams[0].password);
    assert.equal((await admin.raw(`/api/v1/admissions/${documentId}/download`)).status, 403);
    assert.ok(
      (await pdf(await generate(first.id), `${mode.toLowerCase()}-updated-student-id`)).includes(
        changedId,
      ),
    );
    if (mode === 'TEAM') {
      const nextCaptainId = `00captain${f.contest.id.replaceAll('-', '').slice(0, 12)}`;
      await db.registrationPerson.update({ where: { id: captain.id }, data: { captain: false } });
      await db.registrationPerson.create({
        data: {
          contestId: f.contest.id,
          registrationId: first.id,
          name: '新队长',
          captain: true,
          answers: { student_id: nextCaptainId },
        },
      });
      await db.registration.update({
        where: { id: first.id },
        data: { version: { increment: 1 } },
      });
      const switched = await bundle(f.contest.id, 'DOMJUDGE');
      assert.equal(switched.accounts[0].username, nextCaptainId);
      assert.equal(switched.accounts[0].password, hydro.teams[0].password);
      assert.equal(switched.teams[0].id, first.id);
    }
    checks.push(
      `${mode}: changing student ID/captain preserves password and UUID, invalidates old PDFs`,
    );

    let contest = await admin.api(`/contests/${f.contest.id}`);
    contest = await admin.api(`/contests/${f.contest.id}`, 'PUT', {
      ...contest,
      modules: { ...contest.modules, integrations: false },
      confirmModuleChanges: true,
    });
    const hidden = await pdf(await generate(first.id), `${mode.toLowerCase()}-accounts-disabled`);
    assert.ok(!hidden.includes(hydro.teams[0].password));
    assert.ok(!hidden.includes('比赛账号'));
    contest = await admin.api(`/contests/${f.contest.id}`);
    await admin.api(`/contests/${f.contest.id}`, 'PUT', {
      ...contest,
      modules: { ...contest.modules, integrations: true },
    });
    const restored = await bundle(f.contest.id, 'HYDRO');
    assert.equal(restored.teams[0].password, hydro.teams[0].password);
    checks.push(
      `${mode}: integration switch hides credentials and reenabling preserves the password`,
    );
  }

  const invalid = await exportFixture(admin.user.id);
  fixtures.push(invalid);
  await db.contest.update({
    where: { id: invalid.contest.id },
    data: { modules: { admissions: true, rooms: false, integrations: true } },
  });
  const other = await db.registrationPerson.findFirstOrThrow({
    where: { registrationId: invalid.rows[1]!.id },
  });
  await db.registrationPerson.update({
    where: { id: other.id },
    data: { answers: { student_id: invalid.studentIds[0]!.toUpperCase() } },
  });
  for (const platform of ['HYDRO', 'DOMJUDGE']) {
    await redis.del(`rate:exports:${admin.user.id}`);
    const response = await admin.raw(
      `/api/v1/contests/${invalid.contest.id}/platform-exports`,
      'POST',
      { platform, includeUnofficial: false },
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /报名 1 与 2.*学号重复/);
  }
  assert.equal(
    (
      await admin.raw('/api/v1/admissions/generate', 'POST', {
        registrationIds: [invalid.rows[0]!.id],
      })
    ).status,
    400,
  );
  assert.equal(await db.competitionAccount.count({ where: { contestId: invalid.contest.id } }), 0);
  await db.registrationPerson.update({ where: { id: other.id }, data: { answers: {} } });
  const missing = await admin.raw(
    `/api/v1/contests/${invalid.contest.id}/platform-exports`,
    'POST',
    { platform: 'DOMJUDGE' },
  );
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).message, /报名 2.*学号/);
  checks.push(
    'Missing/case-normalized duplicate student IDs reject both formats and PDF generation, including conflicts outside the selected group',
  );
  await writeFile(
    '.runtime/reports/competition-accounts.json',
    JSON.stringify({ success: true, checks, evidence }, null, 2),
  );
  console.log(`PASS shared competition accounts: ${checks.length} checks`);
} finally {
  for (const f of fixtures.reverse()) {
    const documents = await db.admissionDocument.findMany({
      where: { registration: { contestId: f.contest.id } },
      select: { id: true },
    });
    await db.job.deleteMany({ where: { resourceId: { in: f.rows.map((r) => r.id) } } });
    await db.admissionDocument.deleteMany({ where: { id: { in: documents.map((d) => d.id) } } });
    await f.cleanup();
  }
  await rm(stage, { recursive: true, force: true });
  await db.$disconnect();
  await redis.quit();
}
