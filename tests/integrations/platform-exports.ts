import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from './client.js';
import { exportFixture } from './platform-export-fixture.js';
import { db } from '../../apps/server/src/db.js';
import { sha } from '../../apps/server/src/security.js';
import { redis } from '../../apps/server/src/auth.js';
const checks: string[] = [];
const fixtures: Awaited<ReturnType<typeof exportFixture>>[] = [];
const stage = await mkdtemp(path.join(tmpdir(), 'platform-exports-'));
async function bundle(client: Client, id: string, options: Record<string, unknown>) {
  const key = randomUUID();
  const response = await client.raw(
    `/api/v1/contests/${id}/platform-exports`,
    'POST',
    options,
    key,
  );
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
  assert.match(hydro.teams[0].name, /^NULL_/);
  assert.ok(hydro.teams[0].name.length <= 31);
  assert.deepEqual(hydro.teams[0].members, ['NULL']);
  assert.equal(hydro.teams[0].rank, true);
  assert.equal(hydro.teams[1].rank, false);
  assert.match(hydro.get('credentials.csv'), /"'=SUM\(1,2\)"/);
  assert.ok(hydro.teams[0].password.length >= 20);
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
  for (const r of f.rows.slice(0, 2))
    await db.registration.update({
      where: { id: r.id },
      data: { answers: { registration: { team_label: 'A-01' } } },
    });
  assert.equal((await admin.raw(route, 'POST', { platform: 'HYDRO' })).status, 400);
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
  checks.push('重复座位、缺少代表单位、停用导出模块均拒绝生成误导性导入包');
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
  for (const check of checks) console.log(`PASS ${check}`);
} finally {
  for (const f of fixtures) await f.cleanup();
  await rm(stage, { recursive: true, force: true });
  await db.$disconnect();
  redis.disconnect();
}
