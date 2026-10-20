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
async function exported(admin: Client, platform: string, force = false) {
  const response = await admin.raw(
    `/api/v1/contests/${fixture!.contest.id}/platform-exports`,
    'POST',
    { platform, importMode: force ? 'FORCE_UNOFFICIAL' : 'FOLLOW' },
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
  const teams = await exported(admin, 'HYDRO');
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
  assert.deepEqual(first[0].members, ['NULL']);
  assert.equal(first[0].unrank ?? false, false);
  assert.equal(first[1].unrank, true);
  assert.ok(first.every((t) => t.contestMode === target.domainId));
  await exported(admin, 'HYDRO', true);
  await importFile();
  const repeat = await inspect();
  assert.deepEqual(
    repeat.map((t) => t.uid),
    first.map((t) => t.uid),
  );
  assert.ok(repeat.every((t) => t.unrank === true));
  assert.deepEqual(repeat[0].members, ['NULL']);
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
  reports.push({
    platform: 'HYDRO',
    version: '5.0.7',
    onsiteToolkit: '0.1.1',
    status: 'PASS',
    customDomain: true,
    officialAndUnofficial: true,
    repeatAndRankUpdate: true,
    actualLoginAndContestAccess: true,
  });
  console.log(
    'PASS Hydro official onsiteImport: custom domain, rank, names, members, repeat import and actual contest login',
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
