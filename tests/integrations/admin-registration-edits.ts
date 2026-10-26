import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, until } from './client.js';
import { pdfText } from './pdf-text.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { competitionCredentials } from '../../apps/server/src/competition-accounts.js';
import { migrateReviewEligibility } from '../../apps/server/src/review-eligibility.js';
import { policySchema } from '../../packages/contracts/src/index.js';

const ids: string[] = [],
  checks: string[] = [];
const run = randomUUID().slice(0, 8);
const evidence = process.env.ACCOUNT_QA_DIR ?? path.join('/tmp', 'contest-center-accounts-qa');
await mkdir(evidence, { recursive: true });
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice'),
    manager = await new Client().login('manager');
  const detail = (id: string) => admin.api(`/registrations/${id}`);
  const save = (r: any, extra = {}) =>
    admin.api(`/registrations/${r.id}`, 'PUT', { ...r, ...extra, version: r.version });
  const review = (r: any, decision = 'APPROVED', reason = '') =>
    admin.api(`/registrations/${r.id}/review`, 'POST', { version: r.version, decision, reason });
  async function fixture(extraPolicy = {}, extraFields: any[] = []) {
    const c = await admin.api('/contests', 'POST', {
      title: `管理员修正验收 ${run} ${ids.length}`,
      season: '流程验收',
      description: '状态、凭据和升级兼容验收',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      opensAt: new Date(Date.now() - 3600000).toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
      published: true,
      modules: { admissions: true, rooms: false, integrations: true },
      examSites: [
        { name: '南校区', address: '南京' },
        { name: '北校区', address: '南京北' },
      ],
      policy: policySchema.parse({
        mode: 'TEAM',
        memberMode: 'MANUAL',
        minMembers: 1,
        maxMembers: 4,
        coachMode: 'OPTIONAL',
        maxCoaches: 2,
        manualReview: true,
        allowUnofficial: true,
        uniquePersonFields: ['student_id'],
        ...extraPolicy,
      }),
      fields: [
        { key: 'student_id', label: '学号', scope: 'PERSON', type: 'text', required: true },
        { key: 'admin_note', label: '资料说明', scope: 'TEAM', type: 'text', required: true },
        ...extraFields,
      ],
    });
    ids.push(c.id);
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    assert.equal(
      (await admin.raw(`/api/v1/registrations/${r.id}`, 'PUT', { ...r, teamName: '禁止代改草稿' }))
        .status,
      400,
    );
    r = await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      teamName: `修正战队${ids.length}`,
      examSiteId: c.examSites[0].id,
      organization: { name: '南京晓庄学院', shortName: '晓庄', country: 'CHN', icpcId: '' },
      answers: { ...r.answers, team: { admin_note: '资料完整' } },
      people: r.people.map((p: any) => ({
        ...p,
        answers: { ...p.answers, student_id: `00${run}${ids.length}` },
      })),
    });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    if (r.review === 'PENDING') {
      assert.equal(
        (
          await admin.raw(`/api/v1/registrations/${r.id}`, 'PUT', {
            ...r,
            teamName: '禁止代改待审',
          })
        ).status,
        400,
      );
      r = await review(r);
    }
    return { c, r: await detail(r.id) };
  }
  async function generate(r: any, fileName: string) {
    await redis.del(
      `rate:admission-generate:${admin.user.id}`,
      `admission-generate:${admin.user.id}`,
    );
    const result = await admin.api('/admissions/generate', 'POST', {
      registrationIds: [r.id],
      room: 'A101',
      seat: '1',
    });
    const id = result.results[0].documentId;
    assert.ok(id, JSON.stringify(result));
    await until(
      () => db.admissionDocument.findUniqueOrThrow({ where: { id } }),
      (d) => {
        assert.notEqual(d.state, 'FAILED', d.error ?? 'PDF failed');
        return ['READY', 'RELEASED'].includes(d.state);
      },
      120000,
    );
    const response = await admin.raw(`/api/v1/admissions/${id}/download`);
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path.join(evidence, fileName), bytes);
    return { id, text: (await pdfText(bytes)).replace(/\s/g, '') };
  }
  const f = await fixture();
  let r = f.r;
  assert.equal(
    (await manager.raw(`/api/v1/registrations/${r.id}`, 'PUT', { ...r, teamName: '越权' })).status,
    403,
  );
  assert.equal((await new Client().raw(`/api/v1/registrations/${r.id}`, 'PUT', r)).status, 401);
  assert.equal((await save(r)).version, r.version);
  assert.equal(
    (await save(r, { answers: { team: {}, registration: {}, ...r.answers } })).version,
    r.version,
  );
  checks.push('管理员草稿／待审状态禁改，权限隔离，已通过报名无变化保存不增版本');

  const old = await generate(r, 'admin-edit-before.pdf');
  const originalAccount = await competitionCredentials(r.id, r.version);
  assert.ok(originalAccount);
  const before = await db.registration.findUniqueOrThrow({ where: { id: r.id } });
  for (const extra of [
    { teamName: '' },
    { answers: { team: { admin_note: '' } } },
    { people: r.people.map((p: any) => ({ ...p, answers: { ...p.answers, student_id: '' } })) },
  ]) {
    assert.equal(
      (await admin.raw(`/api/v1/registrations/${r.id}`, 'PUT', { ...r, ...extra })).status,
      400,
    );
    const unchanged = await db.registration.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(unchanged.version, before.version);
    assert.deepEqual(unchanged.snapshot, before.snapshot);
    assert.equal(
      (await db.admissionDocument.findUniqueOrThrow({ where: { id: old.id } })).state,
      'READY',
    );
  }
  checks.push('完整资料校验失败整笔回滚，版本、快照与有效准考证不变');

  const submittedAt = r.submittedAt,
    number = r.number;
  r = await save(r, {
    teamName: '管理员修正后的战队',
    people: r.people.map((p: any) => ({
      ...p,
      answers: { ...p.answers, student_id: `00${run}NEW` },
    })),
  });
  assert.equal(r.status, 'SUBMITTED');
  assert.equal(r.review, 'PENDING');
  assert.equal(r.eligible, false);
  assert.equal(r.submittedAt, submittedAt);
  assert.equal(r.number, number);
  assert.equal(r.snapshot.teamName, '管理员修正后的战队');
  assert.equal(r.snapshot.people[0].answers.student_id, `00${run}NEW`);
  assert.equal(
    (await db.admissionDocument.findUniqueOrThrow({ where: { id: old.id } })).state,
    'STALE',
  );
  assert.notEqual((await admin.raw(`/api/v1/admissions/${old.id}/download`)).status, 200);
  r = await detail(r.id);
  assert.equal(r.actions.edit, false);
  assert.equal(r.actions.review, true);
  assert.equal(r.revisions[0].reason, 'ADMIN_EDIT');
  assert.equal(
    (await admin.raw(`/api/v1/registrations/${r.id}`, 'PUT', { ...r, teamName: '待审越界修改' }))
      .status,
    400,
  );
  checks.push('管理员代改直接送待复核、暂停资格、保存新快照并失效旧文件，禁止待审再次代改');

  r = await review(r);
  const nextAccount = await competitionCredentials(r.id, r.version);
  assert.equal(nextAccount?.password, originalAccount.password);
  assert.equal(nextAccount?.username, `00${run}NEW`);
  const next = await generate(r, 'admin-edit-after.pdf');
  assert.ok(next.text.includes('管理员修正后的战队'));
  assert.ok(next.text.includes(nextAccount!.username));
  assert.ok(next.text.includes(originalAccount.password));
  assert.ok(!next.text.includes(f.r.teamName));
  checks.push('管理员直接复核通过，新 PDF 使用新快照和新学号，报名 ID、密码及审核历史保留');

  const room = await db.examRoom.create({
    data: {
      contestId: f.c.id,
      examSiteId: f.c.examSites[0].id,
      name: '座位保留验证',
      code: 'A',
      capacity: 20,
    },
  });
  await db.seatAssignment.create({
    data: { registrationId: r.id, roomId: room.id, unitKey: 'registration', seat: 1 },
  });
  r = await save(r, { teamName: '保留座位的文字修改' });
  assert.equal(await db.seatAssignment.count({ where: { registrationId: r.id } }), 1);
  r = await review(r);
  r = await save(r, { examSiteId: f.c.examSites[1].id });
  assert.equal(await db.seatAssignment.count({ where: { registrationId: r.id } }), 0);
  assert.equal(r.snapshot.examSiteId, f.c.examSites[1].id);
  r = await review(r);
  checks.push('文字修正保留座位，变更考点清理座位并更新快照');

  await db.contest.update({
    where: { id: f.c.id },
    data: { closesAt: new Date(Date.now() - 10000), correctionUntil: new Date(Date.now() - 5000) },
  });
  r = await detail(r.id);
  assert.equal(r.actions.edit, true);
  assert.equal(
    (
      await admin.raw(`/api/v1/registrations/${r.id}/review`, 'POST', {
        version: r.version,
        decision: 'CORRECTION',
        reason: '',
      })
    ).status,
    400,
  );
  r = await review(r, 'CORRECTION', '管理员继续完善');
  assert.equal((await alice.api(`/registrations/${r.id}`)).actions.edit, false);
  r = await save(await detail(r.id));
  assert.equal(r.review, 'PENDING');
  assert.equal(r.status, 'SUBMITTED');
  r = await review(r);
  await db.contest.update({ where: { id: f.c.id }, data: { archived: true } });
  r = await detail(r.id);
  assert.equal(r.actions.edit, false);
  assert.equal(r.actions.amendReview, false);
  assert.equal(
    (await admin.raw(`/api/v1/registrations/${r.id}`, 'PUT', { ...r, teamName: '归档修改' }))
      .status,
    400,
  );
  assert.equal(
    (
      await admin.raw(`/api/v1/registrations/${r.id}/review`, 'POST', {
        version: r.version,
        decision: 'CORRECTION',
        reason: '归档打回',
      })
    ).status,
    400,
  );
  await db.contest.update({ where: { id: f.c.id }, data: { archived: false } });
  checks.push('截止后管理员可代改和退回补正，选手期限不放开，完整补正可直接送审，归档禁止修改审核');

  for (const [status, state] of [
    ['SUBMITTED', 'REJECTED'],
    ['CANCEL_REQUESTED', 'APPROVED'],
    ['CANCELLED', 'APPROVED'],
  ] as const) {
    await db.registration.update({ where: { id: r.id }, data: { status, review: state } });
    const blocked = await detail(r.id);
    assert.equal(blocked.actions.edit, false);
    assert.equal(
      (
        await admin.raw(`/api/v1/registrations/${r.id}`, 'PUT', {
          ...blocked,
          teamName: '状态越界',
        })
      ).status,
      400,
    );
  }
  await db.registration.update({
    where: { id: r.id },
    data: { status: 'SUBMITTED', review: 'APPROVED' },
  });
  r = await detail(r.id);
  const race = await Promise.all([
    admin.raw(`/api/v1/registrations/${r.id}`, 'PUT', { ...r, teamName: '并发保存' }),
    admin.raw(`/api/v1/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'REJECTED',
      reason: '并发审核',
    }),
  ]);
  assert.deepEqual(
    race.map((response) => response.status).sort(),
    [200, 201, 409].filter((n) => race.some((res) => res.status === n)).sort(),
  );
  assert.equal(race.filter((response) => response.ok).length, 1);
  assert.ok(race.some((response) => response.status === 409));
  checks.push('拒绝和取消状态禁止代改，并发保存／审核仅一个事务成功');

  const automatic = await fixture({ manualReview: false });
  let a = await save(automatic.r, { teamName: '自动审核活动仍待人工复核' });
  assert.equal(a.review, 'PENDING');
  assert.equal(a.eligible, false);
  a = await review(a);
  assert.equal(a.eligible, true);
  checks.push('普通自动审核照常通过，管理员代改后自动审核活动仍须人工复核');

  const paid = await fixture({ feeMode: 'PER_PERSON', feeCents: 1000 });
  let p = paid.r;
  const beforeLedger = await db.ledgerEntry.findMany({ where: { registrationId: p.id } });
  p = await save(p, {
    people: [
      ...p.people,
      {
        name: '手工新增成员',
        email: 'manual@example.test',
        captain: false,
        answers: { student_id: `00${run}ADDED`, school: '南京晓庄学院' },
      },
    ],
  });
  assert.equal(p.feeCents, 2000);
  assert.equal(p.netPaidCents, paid.r.netPaidCents);
  const afterLedger = await db.ledgerEntry.findMany({ where: { registrationId: p.id } });
  assert.equal(afterLedger.length, beforeLedger.length + 1);
  assert.equal(
    afterLedger.find((entry) => !beforeLedger.some((oldEntry) => oldEntry.id === entry.id))
      ?.amountCents,
    1000,
  );
  checks.push('人数变更重算冻结规则下的应收，仅新增差额账，到账金额保持不变');

  const coach = await db.registrationCoach.create({
    data: { registrationId: a.id, userId: admin.user.id },
  });
  a = await detail(a.id);
  a = await admin.api(`/registrations/${a.id}/coaches/${coach.id}`, 'PUT', {
    version: a.version,
    answers: { coaching_note: '管理员教练资料修正' },
  });
  assert.equal(a.review, 'PENDING');
  assert.equal(a.snapshot.coaches[0].answers.coaching_note, '管理员教练资料修正');
  assert.equal(
    (
      await admin.raw(`/api/v1/registrations/${a.id}/coaches/${coach.id}`, 'PUT', {
        version: a.version,
        answers: {},
      })
    ).status,
    400,
  );
  a = await review(a);
  a = await admin.api(`/registrations/${a.id}/coaches/${coach.id}`, 'DELETE', {
    version: a.version,
  });
  assert.equal(a.review, 'PENDING');
  assert.equal(a.snapshot.coaches.length, 0);
  checks.push('教练子接口执行同样的状态门禁、完整校验、快照及待复核流程');

  await db.registration.update({ where: { id: a.id }, data: { eligible: true } });
  const migrationBefore = await db.registration.findUniqueOrThrow({ where: { id: a.id } });
  const credentialBefore = await db.competitionAccount.findUnique({
    where: { registrationId: r.id },
  });
  await db.setting.deleteMany({ where: { key: 'migration:review-eligibility-v2.1' } });
  await migrateReviewEligibility();
  const migrated = await db.registration.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(migrated.eligible, false);
  assert.equal(migrated.version, migrationBefore.version + 1);
  assert.deepEqual(migrated.snapshot, migrationBefore.snapshot);
  assert.equal(migrated.feeCents, migrationBefore.feeCents);
  assert.deepEqual(
    await db.competitionAccount.findUnique({ where: { registrationId: r.id } }),
    credentialBefore,
  );
  await migrateReviewEligibility();
  assert.equal(
    (await db.registration.findUniqueOrThrow({ where: { id: a.id } })).version,
    migrated.version,
  );
  checks.push('升级资格校正幂等，保留原快照、财务及共享凭据');

  const personal = await fixture({ mode: 'INDIVIDUAL', minMembers: 1, maxMembers: 1 });
  let person = await save(personal.r, {
    people: personal.r.people.map((member: any) => ({ ...member, name: '个人修正姓名' })),
  });
  assert.equal(person.review, 'PENDING');
  assert.equal(person.snapshot.people[0].name, '个人修正姓名');
  person = await review(person);
  await db.contest.update({
    where: { id: personal.c.id },
    data: { opensAt: new Date(Date.now() - 10000), closesAt: new Date(Date.now() + 3600000) },
  });
  person = await alice.api(`/registrations/${person.id}`, 'PUT', {
    ...person,
    people: person.people.map((member: any) => ({ ...member, name: '选手自行修改' })),
  });
  assert.equal(person.status, 'CORRECTION');
  person = await alice.api(`/registrations/${person.id}/submit`, 'POST', {
    version: person.version,
  });
  assert.equal(person.review, 'PENDING');
  checks.push('个人报名同样支持管理员代改，选手自行修改仍需原提交流程');

  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/admin-registration-edits.json',
    JSON.stringify({ success: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ success: true, checks }, null, 2));
} finally {
  await db.contest.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  await db.$disconnect();
  await redis.quit();
}
