import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from './client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { defaultTemplate, policySchema } from '../../packages/contracts/src/index.js';
if (config.production) throw new Error('Development fixtures only');
const ids: string[] = [];
const pass = (message: string) => console.log(`PASS ${message}`);
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  const alice = await new Client().login('alice');
  const bob = await new Client().login('bob');
  const create = async (extra: Record<string, unknown> = {}) => {
    const c = await admin.api('/contests', 'POST', {
      title: `考点验收 ${Date.now()}`,
      season: '考点验收',
      description: '本地隔离测试',
      startsAt: new Date(Date.now() + 172800000).toISOString(),
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      published: true,
      modules: { admissions: true, rooms: true, integrations: false },
      policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
      fields: [],
      ...extra,
    });
    ids.push(c.id);
    return admin.api(`/contests/${c.id}`);
  };
  let c = await create({
    examSites: [
      { name: ' 主校区 ', address: '主校区教学楼' },
      { name: '分校区', address: '分校区实验楼' },
    ],
  });
  const [first, second] = c.examSites;
  assert.equal(first.name, '主校区');
  assert.equal(first.enabled, true);
  const saveContest = async (sites: unknown[], extra: Record<string, unknown> = {}) => {
    const current = await admin.api(`/contests/${c.id}`);
    return admin.api(`/contests/${c.id}`, 'PUT', { ...current, examSites: sites, ...extra });
  };
  assert.equal((await alice.raw(`/api/v1/contests/${c.id}`, 'PUT', c)).status, 403);
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${c.id}`, 'PUT', {
        ...c,
        examSites: [first, { name: '主校区' }],
      })
    ).status,
    400,
  );
  assert.equal((await admin.api(`/contests/${c.id}`)).version, c.version);
  const other = await create({ examSites: [{ name: '另一竞赛考点' }] });
  assert.equal(
    (await admin.raw(`/api/v1/contests/${c.id}`, 'PUT', { ...c, examSites: [other.examSites[0]] }))
      .status,
    400,
  );
  pass('考点配置、名称去空格、重复校验、跨竞赛与权限保护');

  let r = await alice.api('/registrations', 'POST', { contestId: c.id });
  assert.equal(
    (await alice.raw(`/api/v1/registrations/${r.id}/submit`, 'POST', { version: r.version }))
      .status,
    400,
  );
  assert.equal(
    (
      await alice.raw(`/api/v1/registrations/${r.id}`, 'PUT', {
        ...r,
        examSiteId: other.examSites[0].id,
      })
    ).status,
    400,
  );
  r = await alice.api(`/registrations/${r.id}`, 'PUT', { ...r, examSiteId: first.id });
  r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  assert.equal(r.eligible, true);
  assert.equal(r.snapshot.examSiteId, first.id);
  assert.equal(r.snapshot.examSite.name, '主校区');
  pass('配置考点后必选、拒绝其他竞赛考点、提交快照保留选择');

  await saveContest([{ ...first, enabled: false }, second]);
  let draft = await bob.api('/registrations', 'POST', { contestId: c.id });
  assert.equal(
    (await bob.raw(`/api/v1/registrations/${draft.id}`, 'PUT', { ...draft, examSiteId: first.id }))
      .status,
    400,
  );
  r = await alice.api(`/registrations/${r.id}`, 'PUT', { ...r, teamName: '保留旧考点' });
  r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  assert.equal(r.examSiteId, first.id);
  await saveContest([first, second]);
  draft = await bob.api(`/registrations/${draft.id}`, 'PUT', { ...draft, examSiteId: second.id });
  await saveContest([first, { ...second, enabled: false }]);
  assert.equal(
    (await bob.raw(`/api/v1/registrations/${draft.id}/submit`, 'POST', { version: draft.version }))
      .status,
    400,
  );
  await saveContest([first, second]);
  let b = await bob.api(`/registrations/${draft.id}/submit`, 'POST', { version: draft.version });
  pass('停用阻止新选择和草稿提交、已提交报名保留原考点');

  c = await admin.api(`/contests/${c.id}`);
  assert.equal(
    (await admin.raw(`/api/v1/contests/${c.id}`, 'PUT', { ...c, examSites: [second] })).status,
    400,
  );
  const { examSites: omitted, ...legacyPayload } = c;
  await admin.api(`/contests/${c.id}`, 'PUT', legacyPayload);
  assert.equal((await admin.api(`/contests/${c.id}`)).examSites.length, 2);
  const roomA = await admin.api(`/contests/${c.id}/rooms`, 'POST', {
    name: 'A101',
    capacity: 2,
    examSiteId: first.id,
  });
  const roomB = await admin.api(`/contests/${c.id}/rooms`, 'POST', {
    name: 'B101',
    capacity: 2,
    examSiteId: second.id,
  });
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${c.id}/rooms`, 'POST', {
        name: '错误考场',
        capacity: 2,
        examSiteId: other.examSites[0].id,
      })
    ).status,
    400,
  );
  assert.equal(
    (await admin.raw(`/api/v1/contests/${c.id}/rooms`, 'POST', { name: '未选考点', capacity: 2 }))
      .status,
    400,
  );
  const body = { registrationIds: [r.id, b.id] };
  const preview = await admin.api(`/contests/${c.id}/seating/preview`, 'POST', body);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.assignments.find((a: any) => a.registrationId === r.id).roomId, roomA.id);
  assert.equal(preview.assignments.find((a: any) => a.registrationId === b.id).roomId, roomB.id);
  await admin.api(`/contests/${c.id}/seating/commit`, 'POST', {
    ...body,
    seatingVersion: preview.seatingVersion,
    registrationVersions: preview.registrationVersions,
  });
  const wrong = {
    registrationIds: [r.id],
    replace: true,
    assignments: [{ registrationId: r.id, roomId: roomB.id, seat: 2 }],
  };
  assert.equal(
    (await admin.api(`/contests/${c.id}/seating/preview`, 'POST', wrong)).errors.length,
    1,
  );
  const state = await admin.api(`/contests/${c.id}/rooms`);
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${c.id}/seating/commit`, 'POST', {
        ...wrong,
        seatingVersion: state.seatingVersion,
        registrationVersions: { [r.id]: r.version },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${c.id}/rooms/${roomA.id}`, 'PUT', {
        ...roomA,
        examSiteId: second.id,
      })
    ).status,
    400,
  );
  assert.equal(
    await db.seatAssignment.count({ where: { registrationId: r.id, roomId: roomA.id } }),
    1,
  );
  pass('自动排座按考点分配、手动跨考点及移动已有座位考场被拒绝');

  const filtered = await admin.api(
    `/registrations?contestId=${c.id}&examSiteId=${first.id}&page=1&pageSize=20`,
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, r.id);
  const csv = await (
    await admin.raw(`/api/v1/registrations/export?contestId=${c.id}&examSiteId=${first.id}`)
  ).text();
  assert.ok(csv.includes('"考点","考点地址"'));
  assert.ok(csv.includes('"主校区","主校区教学楼"'));
  assert.ok(!csv.includes('分校区实验楼'));
  await admin.api('/admissions/templates', 'POST', {
    contestId: c.id,
    name: '考点准考证',
    source: defaultTemplate,
  });
  const generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [r.id],
    location: '不可覆盖所选考点',
  });
  assert.ok(!generated.results[0].error, JSON.stringify(generated));
  const document = await db.admissionDocument.findFirstOrThrow({ where: { registrationId: r.id } });
  assert.equal(document.location, '主校区 · 主校区教学楼');
  await saveContest([{ ...first, address: '主校区新教学楼' }, second]);
  assert.equal(
    (await db.admissionDocument.findUniqueOrThrow({ where: { id: document.id } })).state,
    'STALE',
  );
  pass('考点筛选与名单导出、准考证地点、地址修改使旧准考证失效');

  const stale = await admin.api(`/contests/${c.id}/seating/preview`, 'POST', {
    registrationIds: [r.id],
    replace: true,
  });
  r = await alice.api(`/registrations/${r.id}`, 'PUT', { ...r, examSiteId: second.id });
  assert.equal(r.status, 'CORRECTION');
  assert.equal(r.eligible, false);
  assert.equal(await db.seatAssignment.count({ where: { registrationId: r.id } }), 0);
  r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${c.id}/seating/commit`, 'POST', {
        registrationIds: [r.id],
        replace: true,
        seatingVersion: stale.seatingVersion,
        registrationVersions: stale.registrationVersions,
      })
    ).status,
    409,
  );
  const next = await admin.api(`/contests/${c.id}/seating/preview`, 'POST', {
    registrationIds: [r.id],
  });
  assert.equal(next.assignments[0].roomId, roomB.id);
  await admin.api(`/contests/${c.id}/rooms/${roomA.id}`, 'DELETE', { version: roomA.version });
  await saveContest([second]);
  assert.equal((await admin.api(`/contests/${c.id}`)).examSites[0].id, second.id);
  assert.equal(r.snapshot.examSite.name, second.name);
  pass('更换考点清空排座并重新提交、旧排座预览被拒绝、无关联考点可删除');

  const legacy = await create();
  let old = await alice.api('/registrations', 'POST', { contestId: legacy.id });
  old = await alice.api(`/registrations/${old.id}/submit`, 'POST', { version: old.version });
  assert.equal(old.eligible, true);
  assert.equal(old.examSiteId, null);
  await admin.api(`/contests/${legacy.id}/rooms`, 'POST', { name: '原有考场', capacity: 1 });
  assert.deepEqual(
    (
      await admin.api(`/contests/${legacy.id}/seating/preview`, 'POST', {
        registrationIds: [old.id],
      })
    ).errors,
    [],
  );
  const removable = await create({ examSites: [{ name: '可删除考点' }] });
  await admin.api(`/contests/${removable.id}/rooms`, 'POST', {
    name: '空考场',
    capacity: 1,
    examSiteId: removable.examSites[0].id,
  });
  assert.equal(
    (await admin.api(`/contests/${removable.id}`, 'DELETE', { version: removable.version }))
      .deleted,
    true,
  );
  pass('历史无考点竞赛兼容、包含空考场的考点竞赛可正常删除');

  const team = await create({
    seatingMode: 'PERSON',
    policy: policySchema.parse({
      mode: 'TEAM',
      memberMode: 'MANUAL',
      minMembers: 2,
      maxMembers: 2,
      coachMode: 'DISABLED',
      manualReview: false,
      uniquePersonFields: [],
    }),
    examSites: [{ name: '团队考点' }],
  });
  let t = await alice.api('/registrations', 'POST', { contestId: team.id });
  t = await alice.api(`/registrations/${t.id}`, 'PUT', {
    ...t,
    examSiteId: team.examSites[0].id,
    teamName: '同考点团队',
    people: [...t.people, { name: '代填成员', captain: false, answers: {} }],
  });
  t = await alice.api(`/registrations/${t.id}/submit`, 'POST', { version: t.version });
  const teamRoom = await admin.api(`/contests/${team.id}/rooms`, 'POST', {
    name: '团队场',
    capacity: 2,
    examSiteId: t.examSiteId,
  });
  const teamSeats = await admin.api(`/contests/${team.id}/seating/preview`, 'POST', {
    registrationIds: [t.id],
  });
  assert.deepEqual(teamSeats.errors, []);
  assert.equal(teamSeats.assignments.length, 2);
  assert.ok(teamSeats.assignments.every((a: any) => a.roomId === teamRoom.id));
  pass('团队报名共用一个考点、按成员排座保持同考点同场');
} finally {
  await db.contest.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  await db.$disconnect();
  redis.disconnect();
}
