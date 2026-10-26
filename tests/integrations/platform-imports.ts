import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, until } from './client.js';
import { exportFixture } from './platform-export-fixture.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import type { HydroFieldMappings } from '../../packages/contracts/src/index.js';
const exec = promisify(execFile);
const stage = await mkdtemp(path.join(tmpdir(), 'platform-import-'));
const reports: Record<string, unknown>[] = [];
let fixture: Awaited<ReturnType<typeof exportFixture>> | undefined;
const compose = (platform: string, args: string[]) =>
  exec(
    'docker',
    [
      'compose',
      ...(process.env[`${platform}_TEST_PROJECT`]
        ? ['-p', process.env[`${platform}_TEST_PROJECT`]!]
        : []),
      '-f',
      `infra/fixtures/${platform.toLowerCase()}/compose.yaml`,
      ...args,
    ],
    { timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
  );
async function exported(
  admin: Client,
  platform: string,
  force = false,
  hydroFields?: string[],
  hydroFieldMappings?: HydroFieldMappings,
) {
  const response = await admin.raw(
    `/api/v1/contests/${fixture!.contest.id}/platform-exports`,
    'POST',
    {
      platform,
      importMode: force ? 'FORCE_UNOFFICIAL' : 'FOLLOW',
      ...(hydroFields ? { hydroFields } : {}),
      ...(hydroFieldMappings ? { hydroFieldMappings } : {}),
    },
  );
  if (!response.ok) throw new Error(`Export failed ${response.status}: ${await response.text()}`);
  const zip = path.join(stage, platform + '.zip');
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  await exec('unzip', ['-o', zip, '-d', path.join(stage, platform)]);
  return JSON.parse(await readFile(path.join(stage, platform, 'teams.json'), 'utf8')) as any[];
}
async function hydro(admin: Client) {
  const base = 'http://127.0.0.1:58888';
  await until(
    async () =>
      fetch(base)
        .then((r) => r.ok)
        .catch(() => false),
    Boolean,
    120000,
  );
  const headers = {
    Authorization: 'Bearer local-fixture-token-32characters-for-testing-only',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const created = await fetch(`${base}/contest-center-fixture/create`, { method: 'POST', headers });
  assert.ok(
    created.ok,
    `Create Hydro test contest: ${created.status} ${await created.clone().text()}`,
  );
  const target = (await created.json()) as any;
  const room = await db.examRoom.create({
    data: { contestId: fixture!.contest.id, name: 'Hydro 导入考场', code: 'A', capacity: 200 },
  });
  await db.seatAssignment.createMany({
    data: fixture!.rows.slice(0, 2).map((r, i) => ({
      registrationId: r.id,
      roomId: room.id,
      unitKey: 'registration',
      seat: i === 0 ? 1 : 100,
    })),
  });
  await db.registrationPerson.createMany({
    data: ['张三', '李四', '王五', '赵六'].map((name) => ({
      registrationId: fixture!.rows[0]!.id,
      contestId: fixture!.contest.id,
      name,
    })),
  });
  await db.registrationCoach.create({
    data: { registrationId: fixture!.rows[0]!.id, userId: admin.user.id },
  });
  const teams = await exported(admin, 'HYDRO');
  assert.equal(teams[0].id, fixture!.rows[0]!.id);
  assert.equal(teams[0].name, fixture!.studentIds[0]);
  async function importFile() {
    await compose('HYDRO', [
      'cp',
      path.join(stage, 'HYDRO/teams.json'),
      'hydro:/tmp/cc-teams.json',
    ]);
    await compose('HYDRO', [
      'exec',
      '-T',
      'hydro',
      '/opt/hydro/node_modules/.bin/hydrooj',
      'cli',
      'system',
      'onsiteImport',
      '/tmp/cc-teams.json',
      target.contestId,
      'webp',
      target.domainId,
    ]);
  }
  const inspect = async () => {
    const response = await fetch(`${base}/contest-center-fixture/inspect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...target, usernames: teams.map((t) => t.name) }),
    });
    assert.ok(response.ok, `Inspect Hydro ${response.status}`);
    return (await response.json()) as any[];
  };
  await importFile();
  const first = await inspect();
  assert.equal(first.length, 2);
  assert.ok(first.every((t) => t?.attend));
  assert.equal(first[0].displayName, 'NULL');
  assert.deepEqual(first[0].members, teams[0].members);
  assert.equal(first[0].members.length, 5);
  assert.equal(new Set(first[0].members).size, 5);
  assert.equal(first[0].members[0], 'NULL');
  assert.equal(first[0].username, fixture!.studentIds[0]);
  assert.equal(first[0].school, '测试大学');
  assert.equal(first[0].coach, admin.user.name);
  assert.deepEqual(
    first.map((t: any) => t.seat),
    ['A01', 'A100'],
  );
  assert.equal(first[0].unrank ?? false, false);
  assert.equal(first[1].unrank, true);
  assert.ok(first.every((t) => t.contestMode === target.domainId));
  const reexported = await exported(admin, 'HYDRO', true);
  assert.deepEqual(
    reexported.map((t: any) => [t.id, t.name, t.password]),
    teams.map((t: any) => [t.id, t.name, t.password]),
  );
  await importFile();
  const repeat = await inspect();
  assert.deepEqual(
    repeat.map((t) => t.uid),
    first.map((t) => t.uid),
  );
  assert.ok(repeat.every((t) => t.unrank === true));
  assert.deepEqual(repeat[0].members, teams[0].members);
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      uname: teams[0].name,
      password: teams[0].password,
      rememberme: 'false',
    }),
    redirect: 'manual',
  });
  assert.ok(login.ok, `Hydro login ${login.status}`);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const view = await fetch(`${base}/d/${target.domainId}/contest/${target.contestId}`, {
    headers: { Cookie: cookie, Accept: 'application/json', 'X-Hydro-Inject': 'usercontext' },
  });
  assert.ok(view.ok, `Hydro contest access ${view.status}`);
  const data = (await view.json()) as any;
  assert.equal(String(data.UserContext?._id ?? data.user?._id), String(first[0].uid));
  assert.ok(data.tsdoc?.attend);
  const mappingFields = [
    { key: 'export_title', label: '参赛展示名', scope: 'TEAM', type: 'text' },
    { key: 'export_school', label: '参赛单位', scope: 'REGISTRATION', type: 'text' },
    { key: 'export_seat', label: '参赛座位', scope: 'REGISTRATION', type: 'text' },
    { key: 'export_name', label: '成员别名', scope: 'PERSON', type: 'text' },
    { key: 'export_coach', label: '教练别名', scope: 'COACH', type: 'text' },
  ];
  await db.formVersion.create({
    data: { contestId: fixture!.contest.id, version: 1, fields: mappingFields, schema: {} },
  });
  await db.registration.update({
    where: { id: fixture!.rows[0]!.id },
    data: {
      answers: {
        team: { export_title: '自定义参赛展示名' },
        registration: { export_school: '自定义参赛单位', export_seat: 'M01' },
      },
    },
  });
  await db.registrationPerson.updateMany({
    where: { registrationId: fixture!.rows[0]!.id, captain: true },
    data: { answers: { student_id: fixture!.studentIds[0], export_name: '队长别名' } },
  });
  await db.registrationCoach.updateMany({
    where: { registrationId: fixture!.rows[0]!.id },
    data: { answers: { export_coach: '指导教练别名' } },
  });
  const mapped = await exported(admin, 'HYDRO', true, undefined, {
    displayName: { type: 'FORM_FIELD', scope: 'TEAM', key: 'export_title' },
    school: { type: 'FORM_FIELD', scope: 'REGISTRATION', key: 'export_school' },
    seat: { type: 'FORM_FIELD', scope: 'REGISTRATION', key: 'export_seat' },
    members: { type: 'FORM_FIELD', scope: 'PERSON', key: 'export_name' },
    coach: { type: 'FORM_FIELD', scope: 'COACH', key: 'export_coach' },
  });
  await importFile();
  const mappedRemote = await inspect();
  assert.deepEqual(
    mappedRemote.map((team) => team.uid),
    first.map((team) => team.uid),
  );
  for (const field of ['displayName', 'school', 'seat', 'coach', 'members'])
    assert.deepEqual(mappedRemote[0][field], mapped[0][field]);
  assert.equal(mappedRemote[0].displayName, '自定义参赛展示名');
  assert.equal(mappedRemote[0].members[0], '队长别名');
  assert.equal(mappedRemote[0].members.length, 5);
  assert.equal(mappedRemote[1].displayName, teams[1].displayName);
  assert.deepEqual(
    mapped.map((team) => [team.id, team.name, team.password]),
    teams.map((team) => [team.id, team.name, team.password]),
  );
  await exported(admin, 'HYDRO', true);
  await importFile();
  const restoredRemote = await inspect();
  for (const field of ['displayName', 'school', 'seat', 'coach', 'members'])
    assert.deepEqual(restoredRemote[0][field], first[0][field]);
  const remotePassword = `Remote-${crypto.randomUUID()}`;
  const changed = await fetch(`${base}/contest-center-fixture/password`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      domainId: target.domainId,
      username: teams[0].name,
      password: remotePassword,
    }),
  });
  assert.ok(changed.ok);
  const minimal = await exported(admin, 'HYDRO', true, ['id', 'name', 'rank']);
  assert.deepEqual(Object.keys(minimal[0]), ['id', 'name', 'rank']);
  await importFile();
  const selected = await inspect();
  assert.deepEqual(
    selected.map((team) => team.uid),
    first.map((team) => team.uid),
  );
  assert.deepEqual(selected[0].members, []);
  const preservedLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      uname: teams[0].name,
      password: remotePassword,
      rememberme: 'false',
    }),
    redirect: 'manual',
  });
  assert.ok(
    preservedLogin.ok,
    `Selected Hydro reimport must preserve an independently changed remote password: ${preservedLogin.status}`,
  );
  await db.registration.update({
    where: { id: fixture!.rows[2]!.id },
    data: { status: 'SUBMITTED', eligible: true },
  });
  const withNewAccount = await exported(admin, 'HYDRO', true, ['id', 'name', 'rank']);
  await importFile();
  const inspectedNew = await fetch(`${base}/contest-center-fixture/inspect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...target, usernames: withNewAccount.map((team) => team.name) }),
  });
  const newAccounts = (await inspectedNew.json()) as any[];
  assert.equal(newAccounts.length, 3);
  assert.ok(newAccounts.every((team) => team?.attend));
  await exported(admin, 'HYDRO', true);
  await importFile();
  const resetLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      uname: teams[0].name,
      password: teams[0].password,
      rememberme: 'false',
    }),
    redirect: 'manual',
  });
  assert.ok(
    resetLogin.ok,
    `Full Hydro reimport must restore the shared password: ${resetLogin.status}`,
  );
  reports.push({
    platform: 'HYDRO',
    version: '5.0.7',
    onsiteToolkit: '0.1.1',
    status: 'PASS',
    customDomain: true,
    officialAndUnofficial: true,
    repeatAndRankUpdate: true,
    studentIdLoginAndRegistrationUuid: true,
    fiveMembersWithoutDuplicates: true,
    roomCodeSeats: ['A01', 'A100'],
    actualLoginAndContestAccess: true,
    selectedFieldsReimport: true,
    customSourceMappingsReimport: true,
    mappedMissingValuesFallback: true,
    mappedCredentialsStable: true,
    defaultSourcesRestoredAfterMappedImport: true,
    omittedPasswordPreservesRemoteChange: true,
    omittedMembersClearsArray: true,
    newAccountWithoutPassword: true,
  });
  console.log(
    'PASS Hydro official onsiteImport: student-ID login, registration UUID, five members, A01/A100 seats, rank, repeat import and actual contest access',
  );
}
async function domjudge(admin: Client) {
  const base = 'http://127.0.0.1:58901';
  await until(
    async () =>
      fetch(`${base}/api/info`)
        .then((r) => r.ok)
        .catch(() => false),
    Boolean,
    180000,
  );
  const secret = (
    await compose('DOMJUDGE', [
      'exec',
      '-T',
      'domserver',
      'cat',
      '/opt/domjudge/domserver/etc/initial_admin_password.secret',
    ])
  ).stdout.trim();
  const authorization = `Basic ${Buffer.from(`admin:${secret}`).toString('base64')}`;
  async function importFile(endpoint: string, filename: string) {
    const body = new FormData();
    body.append(
      'json',
      new Blob([await readFile(filename)], { type: 'application/json' }),
      path.basename(filename),
    );
    const response = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: authorization },
      body,
    });
    const result = await response.text();
    assert.ok(response.ok, `DOMjudge ${endpoint}: ${response.status} ${result.slice(0, 500)}`);
    return result;
  }
  const teams = await exported(admin, 'DOMJUDGE');
  const folder = path.join(stage, 'DOMJUDGE');
  for (const [type, file] of [
    ['groups', 'groups.json'],
    ['organizations', 'organizations.json'],
    ['teams', 'teams.json'],
    ['accounts', 'accounts.json'],
  ])
    await importFile(`users/${type}`, path.join(folder, file));
  const id = `cc-import-${Date.now()}`;
  const contestFile = path.join(stage, 'contest.json');
  await writeFile(
    contestFile,
    JSON.stringify({
      id,
      name: 'File import acceptance',
      start_time: new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      activation_time: new Date(Date.now() - 7200000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      duration: '48:00:00',
      public: false,
    }),
  );
  await importFile('contests', contestFile);
  const get = async (url: string, auth = authorization) => {
    const response = await fetch(`${base}/api/${url}`, { headers: { Authorization: auth } });
    assert.ok(response.ok, `DOMjudge read ${url}: ${response.status}`);
    return (await response.json()) as any;
  };
  const before = await get('users');
  const accounts = JSON.parse(await readFile(path.join(folder, 'accounts.json'), 'utf8'));
  const user = before.find((u: any) => u.username === accounts[0].username);
  assert.ok(user);
  assert.equal(user.enabled, true);
  assert.deepEqual(user.roles, ['team']);
  assert.equal(String(user.team_id ?? user.teamId), teams[0].id);
  await importFile('users/teams', path.join(folder, 'teams.json'));
  // Re-importing accounts may report already-existing users; it must not create duplicates.
  const body = new FormData();
  body.append(
    'json',
    new Blob([await readFile(path.join(folder, 'accounts.json'))], { type: 'application/json' }),
    'accounts.json',
  );
  const repeat = await fetch(`${base}/api/users/accounts`, {
    method: 'POST',
    headers: { Authorization: authorization },
    body,
  });
  assert.ok(
    [200, 201, 400].includes(repeat.status),
    `Unexpected account re-import status ${repeat.status}`,
  );
  await repeat.text();
  const after = await get('users');
  assert.equal(
    after.filter((u: any) => accounts.some((a: any) => a.username === u.username)).length,
    accounts.length,
  );
  const auth = `Basic ${Buffer.from(`${accounts[0].username}:${accounts[0].password}`).toString('base64')}`;
  const me = await get('user', auth);
  assert.equal(me.username, accounts[0].username);
  const contests = await get('contests', auth);
  assert.ok(contests.some((c: any) => String(c.id) === id));
  const remoteTeams = await get(`contests/${id}/teams?strict=false`);
  const team = remoteTeams.find((t: any) => t.id === teams[0].id);
  assert.ok(team);
  assert.equal(team.name, 'NULL');
  assert.equal(team.public_description, teams[0].members);
  assert.equal(team.organization_id, teams[0].organization_id);
  assert.deepEqual(team.group_ids, teams[0].group_ids);
  reports.push({
    platform: 'DOMJUDGE',
    version: '9.0.1',
    status: 'PASS',
    teamsAndAccounts: true,
    organizationsAndGroups: true,
    repeatImportNoDuplicates: true,
    actualLoginAndContestAccess: true,
  });
  console.log(
    'PASS DOMjudge 9.x native team/account import: associations, duplicate protection and actual team authentication',
  );
}
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  fixture = await exportFixture(admin.user.id);
  if (!process.env.OJ_TYPE || process.env.OJ_TYPE === 'HYDRO') await hydro(admin);
  if (!process.env.OJ_TYPE || process.env.OJ_TYPE === 'DOMJUDGE') await domjudge(admin);
} finally {
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    `.runtime/reports/platform-imports${process.env.OJ_TYPE ? '-' + process.env.OJ_TYPE.toLowerCase() : ''}.json`,
    JSON.stringify(
      {
        reports,
        success: reports.length === (process.env.OJ_TYPE ? 1 : 2),
        commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
        sourceDirty: !!(await exec('git', ['status', '--porcelain'])).stdout.trim(),
      },
      null,
      2,
    ),
  );
  await fixture?.cleanup();
  await rm(stage, { recursive: true, force: true });
  await db.$disconnect();
  redis.disconnect();
}
