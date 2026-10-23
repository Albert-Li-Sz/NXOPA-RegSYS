import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client, base, until } from './client.js';
import { exportFixture } from './platform-export-fixture.js';
import { db } from '../../apps/server/src/db.js';
import { sha } from '../../apps/server/src/security.js';
import { redis } from '../../apps/server/src/auth.js';
const checks: string[] = [];
const fixtures: Awaited<ReturnType<typeof exportFixture>>[] = [];
const stage = await mkdtemp(path.join(tmpdir(), 'platform-exports-'));
async function bundle(client: Client, id: string, options: Record<string, unknown>) {
  const key = randomUUID();
  const response = await until(
    async () => {
      const response = await client.raw(
        `/api/v1/contests/${id}/platform-exports`,
        'POST',
        options,
        key,
      );
      if (
        response.status === 429 &&
        (await response.clone().json()).message === '导出繁忙，请稍后重试'
      )
        return null;
      return response;
    },
    (response) => response !== null,
    10000,
  );
  assert.ok(response);
  if (!response.ok) throw new Error(`Export failed: ${response.status} ${await response.text()}`);
  assert.equal(response.status, 201);
  assert.match(response.headers.get('content-type') ?? '', /application\/zip/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const zip = path.join(stage, `${randomUUID()}.zip`);
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  const get = (name: string) => execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8' });
  return { teams: JSON.parse(get('teams.json')), get, key };
}
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice'),
    manager = await new Client().login('manager');
  await redis.del(`rate:exports:${admin.user.id}`);
  const f = await exportFixture(alice.user.id);
  fixtures.push(f);
  const route = `/api/v1/contests/${f.contest.id}/platform-exports`;
  for (const client of [alice, manager])
    assert.equal((await client.raw(route, 'POST', { platform: 'HYDRO' })).status, 403);
  assert.equal((await new Client().raw(route, 'POST', { platform: 'HYDRO' })).status, 401);
  checks.push('匿名、参赛者和无活动权限的管理员不能下载账号密码');
  const hydro = await bundle(admin, f.contest.id, { platform: 'HYDRO' });
  assert.equal(
    await db.idempotencyRecord.findUnique({ where: { id: sha(`${admin.user.id}:${hydro.key}`) } }),
    null,
  );
  const invalidCsrf = new Client();
  invalidCsrf.cookie = admin.cookie;
  invalidCsrf.csrf = 'invalid';
  assert.equal((await invalidCsrf.raw(route, 'POST', { platform: 'HYDRO' })).status, 403);
  assert.equal(hydro.teams.length, 2);
  assert.equal(hydro.teams[0].displayName, 'NULL');
  assert.equal(hydro.teams[0].id, f.rows[0]!.id);
  assert.equal(hydro.teams[0].name, f.studentIds[0]);
  assert.equal(hydro.teams[1].name, f.studentIds[1]);
  assert.ok(hydro.teams.every((t: any) => t.seat === ''));
  assert.deepEqual(hydro.teams[0].members, ['NULL']);
  assert.equal(hydro.teams[0].rank, true);
  assert.equal(hydro.teams[1].rank, false);
  assert.match(hydro.get('credentials.csv'), /"'=SUM\(1,2\)"/);
  assert.ok(hydro.teams[0].password.length >= 20);
  assert.ok(!Object.keys(hydro.teams[0]).some((key) => /^member[1-4]$/.test(key)));
  assert.ok(hydro.get('credentials.csv').includes(`"${f.studentIds[0]}"`));
  assert.notEqual(
    (await db.platformExportAccount.findFirstOrThrow({ where: { registrationId: f.rows[0]!.id } }))
      .credential,
    hydro.teams[0].password,
  );
  checks.push(
    'Hydro 导出保留 NULL 和中文，排除草稿／无资格，性质布尔值正确，密码加密保存且 CSV 防公式执行',
  );
  const [again, concurrent] = await Promise.all([
    bundle(admin, f.contest.id, { platform: 'HYDRO' }),
    bundle(admin, f.contest.id, { platform: 'HYDRO' }),
  ]);
  assert.deepEqual(again.teams, hydro.teams);
  assert.deepEqual(concurrent.teams, hydro.teams);
  assert.equal(
    await db.platformExportAccount.count({
      where: { registration: { contestId: f.contest.id }, platform: 'HYDRO' },
    }),
    2,
  );
  checks.push('重复及并发导出账号、密码和文件内容稳定且不重复建号');
  const onlyOfficial = await bundle(admin, f.contest.id, {
    platform: 'HYDRO',
    includeUnofficial: false,
    importMode: 'FORCE_UNOFFICIAL',
  });
  assert.equal(onlyOfficial.teams.length, 1);
  assert.equal(onlyOfficial.teams[0].rank, false);
  // Individuals use their own name and student ID even if an unused team name is present.
  const personal = await exportFixture(alice.user.id, 'INDIVIDUAL');
  fixtures.push(personal);
  const individual = await bundle(admin, personal.contest.id, { platform: 'HYDRO' });
  assert.equal(individual.teams[1].displayName, '同名选手');
  assert.equal(individual.teams[1].name, personal.studentIds[1]);
  checks.push('Hydro 登录名使用本人／队长学号并保留前导零，报名 UUID 稳定，多条空座位允许导出');

  await redis.del(`rate:exports:${admin.user.id}`);
  const captain = await db.registrationPerson.findFirstOrThrow({
    where: { registrationId: f.rows[0]!.id, captain: true },
  });
  for (const studentId of [undefined, 123456, '12', 'x'.repeat(32), 'bad\u0007id', 'a\u0627bc']) {
    await db.registrationPerson.update({
      where: { id: captain.id },
      data: { answers: studentId === undefined ? {} : { student_id: studentId } },
    });
    const response = await admin.raw(route, 'POST', { platform: 'HYDRO' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /报名 1.*学号/);
  }
  const secondCaptain = await db.registrationPerson.findFirstOrThrow({
    where: { registrationId: f.rows[1]!.id, captain: true },
  });
  await db.registrationPerson.update({
    where: { id: captain.id },
    data: { answers: { student_id: 'AbC001' } },
  });
  for (const duplicate of ['abc001', 'ＡＢＣ００１']) {
    await db.registrationPerson.update({
      where: { id: secondCaptain.id },
      data: { answers: { student_id: duplicate } },
    });
    const response = await admin.raw(route, 'POST', { platform: 'HYDRO' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /报名 1 与 2.*学号重复/);
  }
  for (const [person, studentId] of [
    [captain, f.studentIds[0]],
    [secondCaptain, f.studentIds[1]],
  ] as const)
    await db.registrationPerson.update({
      where: { id: person.id },
      data: { answers: { student_id: studentId } },
    });
  assert.deepEqual((await bundle(admin, f.contest.id, { platform: 'HYDRO' })).teams, hydro.teams);
  checks.push(
    '缺失、非字符串、过短／过长、禁止字符和双向文本学号拒绝导出，重名按 Hydro 规范化及大小写规则校验',
  );

  await redis.del(`rate:exports:${admin.user.id}`);
  const extraMembers = ['张三', '李四', '王五', '赵六'];
  await db.registrationPerson.createMany({
    data: extraMembers.map((name) => ({
      registrationId: f.rows[0]!.id,
      contestId: f.contest.id,
      name,
    })),
  });
  await db.registrationPerson.create({
    data: {
      registrationId: f.rows[0]!.id,
      contestId: f.contest.id,
      name: '已退出成员',
      active: false,
    },
  });
  await db.registrationCoach.create({
    data: { registrationId: f.rows[0]!.id, userId: alice.user.id },
  });
  await db.registration.update({ where: { id: f.rows[0]!.id }, data: { teamName: '晓庄战队' } });
  const expanded = await bundle(admin, f.contest.id, { platform: 'HYDRO' });
  assert.equal(expanded.teams[0].members[0], 'NULL');
  assert.deepEqual(expanded.teams[0].members.slice(1).sort(), extraMembers.sort());
  assert.equal(expanded.teams[0].members.length, 5);
  assert.equal(expanded.teams[0].coach, alice.user.name);
  assert.equal(expanded.teams[0].displayName, '晓庄战队');
  assert.equal(expanded.teams[0].id, hydro.teams[0].id);
  assert.equal(expanded.teams[0].password, hydro.teams[0].password);
  assert.equal(expanded.teams[0].name, hydro.teams[0].name);
  checks.push(
    '中文队名、五名有效队员与教练正确，队长在前，退出成员不导出；改队名保留身份及比赛密码',
  );

  await db.contest.update({
    where: { id: f.contest.id },
    data: { modules: { admissions: false, rooms: true, integrations: true } },
  });
  const roomPath = `/contests/${f.contest.id}/rooms`;
  let roomA = await admin.api(roomPath, 'POST', { name: '一号考场', code: ' a ', capacity: 200 });
  assert.equal(roomA.code, 'A');
  const roomB = await admin.api(roomPath, 'POST', { name: '二号考场', code: 'b', capacity: 200 });
  const blankRoom = await admin.api(roomPath, 'POST', { name: '未编号考场', capacity: 200 });
  assert.equal(blankRoom.code, null);
  await db.examRoom.create({
    data: { contestId: personal.contest.id, name: '另一活动考场', code: 'A', capacity: 1 },
  });
  assert.equal(
    (await admin.api(roomPath, 'POST', { name: '字母数字组合编号', code: ' k_1-x ', capacity: 1 }))
      .code,
    'K_1-X',
  );
  for (const code of ['A', ' a ', 'A,1', 'A\n1', 'x'.repeat(21)])
    assert.equal(
      (await admin.raw(`/api/v1${roomPath}`, 'POST', { name: randomUUID(), code, capacity: 1 }))
        .status,
      400,
    );
  const { code: omittedCode, ...withoutCode } = roomA;
  roomA = await admin.api(`${roomPath}/${roomA.id}`, 'PUT', withoutCode);
  assert.equal(roomA.code, 'A');
  const aSeat = await db.seatAssignment.create({
    data: { registrationId: f.rows[0]!.id, roomId: roomA.id, seat: 1, unitKey: 'registration' },
  });
  const bSeat = await db.seatAssignment.create({
    data: { registrationId: f.rows[1]!.id, roomId: roomB.id, seat: 100, unitKey: 'registration' },
  });
  const seated = await bundle(admin, f.contest.id, { platform: 'HYDRO' });
  assert.deepEqual(
    seated.teams.map((t: any) => t.seat),
    ['A01', 'B100'],
  );
  assert.match(seated.get('credentials.csv'), /"A01"/);
  assert.match(seated.get('credentials.csv'), /"B100"/);
  roomA = await admin.api(`${roomPath}/${roomA.id}`, 'PUT', { ...roomA, code: 'c' });
  assert.equal(roomA.code, 'C');
  assert.equal((await bundle(admin, f.contest.id, { platform: 'HYDRO' })).teams[0].seat, 'C01');
  assert.equal(
    (
      await admin.raw(`/api/v1${roomPath}/${roomA.id}`, 'PUT', {
        ...roomA,
        version: roomA.version - 1,
        code: 'd',
      })
    ).status,
    409,
  );
  for (const code of ['', null]) {
    roomA = await admin.api(`${roomPath}/${roomA.id}`, 'PUT', { ...roomA, code });
    assert.equal(roomA.code, null);
  }
  assert.equal((await bundle(admin, f.contest.id, { platform: 'HYDRO' })).teams[0].seat, '');
  const ambiguousRoom = await admin.api(roomPath, 'POST', {
    name: '编号边界考场',
    code: 'A1',
    capacity: 1,
  });
  roomA = await admin.api(`${roomPath}/${roomA.id}`, 'PUT', { ...roomA, code: 'A' });
  await db.seatAssignment.update({ where: { id: aSeat.id }, data: { seat: 101 } });
  await db.seatAssignment.update({
    where: { id: bSeat.id },
    data: { roomId: ambiguousRoom.id, seat: 1 },
  });
  const duplicateSeat = await admin.raw(route, 'POST', { platform: 'HYDRO' });
  assert.equal(duplicateSeat.status, 400);
  assert.match((await duplicateSeat.json()).message, /报名 1 与 2 座位重复：A101/);
  await db.seatAssignment.update({
    where: { id: bSeat.id },
    data: { roomId: blankRoom.id, seat: 2 },
  });
  const extraSeat = await db.seatAssignment.create({
    data: { registrationId: f.rows[0]!.id, roomId: roomA.id, seat: 102, unitKey: 'extra' },
  });
  assert.equal((await admin.raw(route, 'POST', { platform: 'HYDRO' })).status, 400);
  await db.seatAssignment.delete({ where: { id: extraSeat.id } });
  assert.equal(
    (await admin.api(roomPath)).rooms.find((r: any) => r.id === blankRoom.id).code,
    null,
  );
  checks.push(
    '考场编号创建／大写／唯一／省略保留／清空／版本校验通过，A01 与三位座号、空编号和拼接冲突正确处理',
  );

  await redis.del(`rate:exports:${admin.user.id}`);
  const dom = await bundle(admin, f.contest.id, { platform: 'DOMJUDGE' });
  const accounts = JSON.parse(dom.get('accounts.json')),
    groups = JSON.parse(dom.get('groups.json'));
  assert.equal(accounts[0].type, 'team');
  assert.equal(accounts[0].team_id, dom.teams[0].id);
  assert.equal(accounts[0].id, accounts[0].username);
  assert.notEqual(dom.teams[0].id, hydro.teams[0].id);
  assert.notEqual(groups[0].sortorder, groups[1].sortorder);
  assert.equal(dom.teams[1].group_ids[0], groups[1].id);
  assert.equal(JSON.parse(dom.get('organizations.json')).length, 1);
  assert.match(dom.teams[0].label, /^cc_.*-一号考场-101$/);
  assert.ok(accounts.every((a: any) => /^cc_/.test(a.username)));
  assert.equal(
    (
      await admin.raw(route, 'POST', {
        platform: 'DOMJUDGE',
        officialGroupId: 'same',
        unofficialGroupId: 'same',
      })
    ).status,
    400,
  );
  checks.push(
    'DOMjudge 队伍与用户通过外部 ID 关联，固定 team 权限，学校去重，正式／非正式分组独立',
  );
  await db.seatAssignment.deleteMany({
    where: { registrationId: { in: f.rows.map((r) => r.id) } },
  });
  for (const r of f.rows.slice(0, 2))
    await db.registration.update({
      where: { id: r.id },
      data: { answers: { registration: { team_label: 'A-01' } } },
    });
  assert.ok(
    (await bundle(admin, f.contest.id, { platform: 'HYDRO' })).teams.every(
      (t: any) => t.seat === '',
    ),
  );
  assert.equal((await admin.raw(route, 'POST', { platform: 'DOMJUDGE' })).status, 400);
  await db.registration.update({ where: { id: f.rows[1]!.id }, data: { answers: {} } });
  await db.registration.update({
    where: { id: f.rows[0]!.id },
    data: { organization: { name: 'missing country' } },
  });
  assert.equal((await admin.raw(route, 'POST', { platform: 'HYDRO' })).status, 400);
  await db.contest.update({
    where: { id: f.contest.id },
    data: { modules: { admissions: false, rooms: false, integrations: false } },
  });
  assert.equal((await admin.raw(route, 'POST', { platform: 'HYDRO' })).status, 400);
  checks.push(
    'Hydro 忽略人工队伍编号作为座位回退，DOMjudge 保留原编号规则；缺少代表单位和停用导出模块仍拒绝导出',
  );
  for (const [url, method] of [
    ['/integrations/instances', 'GET'],
    ['/integrations/bindings', 'POST'],
    [`/integrations/registrations/${f.rows[0]!.id}/sync`, 'POST'],
    [`/integrations/registrations/${f.rows[0]!.id}/credentials`, 'GET'],
  ])
    assert.equal(
      (await admin.raw(`/api/v1${url}`, method, method === 'POST' ? {} : undefined)).status,
      404,
    );
  checks.push('旧实例、绑定、同步和凭据接口已移除');
  const aliasFixture = await exportFixture(alice.user.id);
  fixtures.push(aliasFixture);
  for (const suffix of ['platform-exports/', 'PLATFORM-EXPORTS']) {
    const key = randomUUID();
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/v1/contests/${aliasFixture.contest.id}/${suffix}`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
          Cookie: admin.cookie,
          'X-CSRF-Token': admin.csrf,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ platform: 'HYDRO' }),
      });
      assert.equal(response.status, 201);
      assert.match(response.headers.get('content-type') ?? '', /application\/zip/);
      assert.equal(
        Buffer.from(await response.arrayBuffer())
          .subarray(0, 2)
          .toString(),
        'PK',
      );
    }
    assert.equal(
      await db.idempotencyRecord.findUnique({ where: { id: sha(`${admin.user.id}:${key}`) } }),
      null,
    );
  }
  checks.push('末尾斜杠和大小写路径重复使用同一幂等键仍返回 ZIP，不缓存空响应或挂起下载');
  for (const check of checks) console.log(`PASS ${check}`);
} finally {
  for (const f of fixtures) await f.cleanup();
  await rm(stage, { recursive: true, force: true });
  await db.$disconnect();
  redis.disconnect();
}
