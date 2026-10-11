import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client, until } from './client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
const context = JSON.parse(await readFile('.runtime/acceptance-context.json', 'utf8'));
const mode = process.env.OJ_TYPE ?? 'HYDRO';
const report: any = { platform: mode, startedAt: new Date().toISOString() };
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  const r = await admin.api(`/registrations/${context.paid}`);
  assert.equal(r.eligible, true);
  let baseUrl: string, credentials: any, remoteContestId: string;
  if (mode === 'HYDRO') {
    baseUrl = 'http://localhost:58888';
    credentials = { token: 'local-fixture-token-32characters-for-testing-only' };
    const response = await fetch(`${baseUrl}/contest-center-fixture/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.token}` },
    });
    assert.ok(response.ok, `Hydro fixture HTTP ${response.status}`);
    const fixture = (await response.json()) as any;
    remoteContestId = fixture.contestId;
  } else {
    baseUrl = 'http://localhost:58901';
    const password = execFileSync(
      'docker',
      [
        'compose',
        '-f',
        'infra/fixtures/domjudge/compose.yaml',
        'exec',
        '-T',
        'domserver',
        'cat',
        '/opt/domjudge/domserver/etc/initial_admin_password.secret',
      ],
      { encoding: 'utf8' },
    ).trim();
    const auth = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
    const response = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'cc_api',
        name: 'Contest Center integration',
        email: null,
        ip: null,
        password: 'FixtureAPI2026!',
        enabled: true,
        teamId: null,
        roles: ['api_reader', 'api_writer'],
      }),
    });
    if (!response.ok && response.status !== 400)
      throw new Error(`API account setup ${response.status}`);
    credentials = { username: 'cc_api', password: 'FixtureAPI2026!' };
    remoteContestId = `cc-fixture-${Date.now()}`;
    const body = new FormData();
    body.append(
      'json',
      new Blob(
        [
          JSON.stringify({
            id: remoteContestId,
            name: 'Contest Center acceptance',
            start_time: new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
            activation_time: new Date(Date.now() - 7200000)
              .toISOString()
              .replace(/\.\d{3}Z$/, '+00:00'),
            duration: '48:00:00',
            public: false,
          }),
        ],
        { type: 'application/json' },
      ),
      'contest.json',
    );
    const c = await fetch(`${baseUrl}/api/contests`, {
      method: 'POST',
      headers: { Authorization: auth },
      body,
    });
    assert.ok(c.ok, `Create contest ${c.status} ${await c.text()}`);
  }
  const instance = await admin.api('/integrations/instances', 'POST', {
    name: mode === 'HYDRO' ? '本地在线评测系统验收' : '本地程序设计竞赛评测系统验收',
    type: mode,
    baseUrl,
    credentials,
    allowedContestIds: [r.contestId],
  });
  const binding = await admin.api('/integrations/bindings', 'POST', {
    contestId: r.contestId,
    instanceId: instance.id,
    remoteContestId,
    domainId: 'system',
    automatic: false,
    groupIds: [],
    enabled: true,
  });
  const probe = await admin.api(`/integrations/bindings/${binding.id}/probe`, 'POST');
  report.version = probe.version;
  const first = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  let job = await until(
    () => admin.api(`/jobs/${first.jobId}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    90000,
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  report.result = job.result;
  const second = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  assert.equal(second.mappingId, first.mappingId);
  assert.equal(second.jobId, first.jobId);
  assert.equal(
    await db.accountMapping.count({ where: { registrationId: r.id, bindingId: binding.id } }),
    1,
  );
  report.repeatSync = 'PASS';
  const login = (await admin.api(`/integrations/registrations/${r.id}/credentials`)).find(
    (c: any) => c.bindingId === binding.id,
  );
  assert.ok(login);
  if (mode === 'HYDRO') {
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        uname: login.username,
        password: login.password,
        rememberme: 'false',
      }),
      redirect: 'manual',
    });
    assert.ok(response.ok, `Hydro login ${response.status}`);
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const view = await fetch(`${baseUrl}/d/system/contest/${remoteContestId}`, {
      headers: { Cookie: cookie, Accept: 'application/json', 'X-Hydro-Inject': 'usercontext' },
    });
    assert.ok(view.ok);
    const data = (await view.json()) as any;
    assert.equal(String(data.UserContext?._id ?? data.user?._id), String(job.result.remoteUserId));
    assert.ok(data.tsdoc?.attend);
    report.contestAccess = 'PASS';
    report.login = 'PASS';
  } else {
    const auth = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`;
    const me = await fetch(`${baseUrl}/api/user`, { headers: { Authorization: auth } });
    assert.ok(me.ok);
    const user = (await me.json()) as any;
    assert.equal(user.username, login.username);
    const contests = (await (
      await fetch(`${baseUrl}/api/contests`, { headers: { Authorization: auth } })
    ).json()) as any[];
    assert.ok(contests.some((c) => String(c.id) === remoteContestId));
    report.login = 'PASS';
    report.contestAccess = 'PASS';
  }
  // A failed run retries the persisted mapping, so a new job never creates a second account.
  await db.job.update({
    where: { id: first.jobId },
    data: {
      state: 'FAILED',
      error: 'Acceptance simulated response loss after remote commit',
      attempts: 4,
    },
  });
  await admin.api(`/admin/jobs/${first.jobId}/retry`, 'POST');
  job = await until(
    () => admin.api(`/jobs/${first.jobId}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    90000,
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  assert.equal(job.result.remoteUserId, report.result.remoteUserId);
  report.failureRecovery = 'PASS';
  report.status = 'PASS';
  console.log(
    `${mode} ${report.version}: real account login, contest access, repeat sync and recovery passed`,
  );
} finally {
  await writeFile(`.runtime/reports/${mode.toLowerCase()}.json`, JSON.stringify(report, null, 2));
  await db.$disconnect();
  await redis.quit();
}
