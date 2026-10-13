import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client, until } from './client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
const mode = process.env.OJ_TYPE ?? 'HYDRO',
  run = Date.now();
const context = JSON.parse(await readFile('.runtime/enhancement-context.json', 'utf8'));
const report: any = { platform: mode, at: new Date().toISOString(), checks: [] };
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  let r = await admin.api(`/registrations/${context.registrationId}`);
  if (mode === 'DOMJUDGE') {
    r = await admin.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      answers: {
        ...r.answers,
        registration: { ...r.answers.registration, team_label: `E-${run}` },
      },
    });
    r = await admin.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  }
  if (r.participationType !== 'UNOFFICIAL' || r.review !== 'APPROVED')
    r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'APPROVED',
      participationType: 'UNOFFICIAL',
    });
  const baseUrl = mode === 'HYDRO' ? 'http://localhost:58888' : 'http://localhost:58901';
  let remoteContestId = '',
    groups: string[] = [],
    unofficialGroupId = '';
  const credentials =
    mode === 'HYDRO'
      ? { token: 'local-fixture-token-32characters-for-testing-only' }
      : { username: 'cc_api', password: 'FixtureAPI2026!' };
  if (mode === 'HYDRO') {
    const response = await fetch(`${baseUrl}/contest-center-fixture/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.token}` },
    });
    assert.ok(response.ok);
    remoteContestId = ((await response.json()) as any).contestId;
  } else {
    const password = execFileSync(
      'docker',
      [
        'compose',
        ...(process.env.DOMJUDGE_TEST_PROJECT ? ['-p', process.env.DOMJUDGE_TEST_PROJECT] : []),
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
    const headers = {
      Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
    groups = [`enh-off-${run}`];
    unofficialGroupId = `enh-unoff-${run}`;
    remoteContestId = `enhanced-${run}`;
    const body = new FormData();
    body.append(
      'json',
      new Blob(
        [
          JSON.stringify({
            id: remoteContestId,
            name: '增强验收比赛',
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
    const res = await fetch(`${baseUrl}/api/contests`, {
      method: 'POST',
      headers: { Authorization: headers.Authorization },
      body,
    });
    assert.ok(res.ok, `Contest create ${res.status}`);
    for (const [id, name, sortorder] of [
      [groups[0], '正式参赛', 0],
      [unofficialGroupId, '非正式参赛', 1],
    ] as const) {
      const group = await fetch(`${baseUrl}/api/contests/${remoteContestId}/groups/${id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ id, name, sortorder, hidden: false }),
      });
      assert.ok(group.ok, `Group create ${group.status}: ${await group.text()}`);
    }
  }
  const instance = await admin.api('/integrations/instances', 'POST', {
    name: mode === 'HYDRO' ? '社团在线评测平台（增强验收）' : '社团竞赛评测平台（增强验收）',
    type: mode,
    baseUrl,
    credentials,
    allowedContestIds: [r.contestId],
  });
  let binding = await admin.api('/integrations/bindings', 'POST', {
    contestId: r.contestId,
    instanceId: instance.id,
    remoteContestId,
    domainId: 'system',
    automatic: false,
    groupIds: groups,
    unofficialGroupId,
    nickname: true,
    includeUnofficial: true,
  });
  const probe = await admin.api(`/integrations/bindings/${binding.id}/probe`, 'POST');
  report.version = probe.version;
  report.pluginVersion = probe.pluginVersion;
  let first = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  if (mode === 'DOMJUDGE') {
    assert.equal(first.state, 'WAITING_ORGANIZATION');
    assert.equal(first.jobId, undefined);
    const schools = await admin.api(
      `/integrations/bindings/${binding.id}/schools?page=1&pageSize=20`,
    );
    const school = schools.items.find((x: any) => x.id === first.organizationMappingId);
    assert.ok(school);
    const confirmation = await admin.api(
      `/integrations/bindings/${binding.id}/schools/${school.id}`,
      'PUT',
      { ...school, remoteId: undefined, create: true },
    );
    assert.equal(confirmation.status, 'CONFIRMED');
    report.organizationId = confirmation.remoteId;
    first = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
      bindingId: binding.id,
    });
    const metadata = await admin.api(`/integrations/bindings/${binding.id}/metadata`);
    const remoteSchool = metadata.organizations.find(
      (x: any) => String(x.id) === confirmation.remoteId,
    );
    assert.ok(remoteSchool);
    assert.equal(remoteSchool.country, 'CHN');
    assert.equal(remoteSchool.name, confirmation.shortName);
    assert.equal(remoteSchool.formal_name, confirmation.name);
    report.checks.push('学校待映射允许报名、管理员创建组织并恢复同步');
  }
  let job = await until(
    () => admin.api(`/jobs/${first.jobId}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    90000,
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  const verified = job.result;
  if (mode === 'HYDRO') {
    assert.equal(verified.verification.nickname, r.teamName);
    assert.equal(verified.verification.unrank, true);
  } else {
    assert.equal(verified.verification.teamName, r.teamName);
    assert.equal(verified.verification.organizationId, report.organizationId);
    assert.deepEqual(verified.verification.groupIds, [unofficialGroupId]);
    assert.ok(verified.verification.publicDescription.includes(r.teamEnglishName));
    for (const person of r.people)
      assert.ok(verified.verification.publicDescription.includes(person.name));
  }
  const repeat = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  assert.equal(repeat.jobId, first.jobId);
  const login = (await admin.api(`/integrations/registrations/${r.id}/credentials`)).find(
    (x: any) => x.bindingId === binding.id,
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
    assert.ok(response.ok);
    const cookie = response.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const view = (await (
      await fetch(`${baseUrl}/d/system/contest/${remoteContestId}`, {
        headers: { Cookie: cookie, Accept: 'application/json', 'X-Hydro-Inject': 'usercontext' },
      })
    ).json()) as any;
    assert.equal(String(view.UserContext?._id ?? view.user?._id), verified.remoteUserId);
    assert.equal(view.tsdoc.attend, 1);
    // Hydro 5.0.7 intentionally omits unrank from the public tsdoc response.
    const persisted = JSON.parse(
      execFileSync(
        'docker',
        [
          'compose',
          ...((process.env.HYDRO_TEST_PROJECT ??
          process.env.DOMJUDGE_TEST_PROJECT?.replace(/-domjudge$/, '-hydro'))
            ? [
                '-p',
                process.env.HYDRO_TEST_PROJECT ??
                  process.env.DOMJUDGE_TEST_PROJECT!.replace(/-domjudge$/, '-hydro'),
              ]
            : []),
          '-f',
          'infra/fixtures/hydro/compose.yaml',
          'exec',
          '-T',
          'mongo',
          'mongosh',
          '--quiet',
          'hydro',
          '--eval',
          `print(JSON.stringify(db.getCollection('document.status').findOne({domainId:'system',docType:30,docId:ObjectId('${remoteContestId}'),uid:${Number(verified.remoteUserId)}},{attend:1,unrank:1,_id:0})))`,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(persisted.unrank, true);
    assert.equal(persisted.attend, 1);
  } else {
    const headers = {
      Authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`,
    };
    const me = (await (await fetch(`${baseUrl}/api/user`, { headers })).json()) as any;
    assert.equal(me.username, login.username);
    const contests = (await (await fetch(`${baseUrl}/api/contests`, { headers })).json()) as any[];
    assert.ok(contests.some((c) => String(c.id) === remoteContestId));
  }
  report.checks.push('昵称／队名、组织、非正式状态／分组读回，实际登录与比赛访问，重复同步复用');
  await db.job.update({
    where: { id: first.jobId },
    data: { state: 'FAILED', attempts: 4, error: '验收：远端提交后响应丢失' },
  });
  await admin.api(`/admin/jobs/${first.jobId}/retry`, 'POST');
  job = await until(
    () => admin.api(`/jobs/${first.jobId}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    90000,
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  assert.equal(job.result.remoteUserId, verified.remoteUserId);
  report.checks.push('远端提交后失败恢复不重复创建账号与队伍');
  r = await admin.api(`/registrations/${r.id}`);
  r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'APPROVED',
    participationType: 'OFFICIAL',
  });
  assert.ok(r.eligible);
  const adjusted = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  job = await until(
    () => admin.api(`/jobs/${adjusted.jobId}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    90000,
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  assert.equal(job.result.remoteUserId, verified.remoteUserId);
  if (mode === 'HYDRO') assert.equal(job.result.verification.unrank, false);
  else assert.deepEqual(job.result.verification.groupIds, groups);
  report.checks.push('审核调整为正式参赛后更新同一远端对象');
  binding = await admin.api('/integrations/bindings', 'POST', {
    ...binding,
    importMode: 'FORCE_UNOFFICIAL',
  });
  const force = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  job = await until(
    () => admin.api(`/jobs/${force.jobId}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    90000,
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  if (mode === 'HYDRO') assert.equal(job.result.verification.unrank, true);
  else assert.deepEqual(job.result.verification.groupIds, [unofficialGroupId]);
  // A task from the former binding version must fail without changing the current mapping.
  await db.job.update({ where: { id: adjusted.jobId }, data: { state: 'FAILED', attempts: 4 } });
  await admin.api(`/admin/jobs/${adjusted.jobId}/retry`, 'POST');
  const obsolete = await until(
    () => admin.api(`/jobs/${adjusted.jobId}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    90000,
  );
  assert.equal(obsolete.state, 'FAILED');
  assert.match(obsolete.error, /已改变/);
  assert.equal(
    (await db.accountMapping.findUniqueOrThrow({ where: { id: force.mappingId } })).state,
    'VERIFIED',
  );
  report.checks.push('全部非正式导入策略、过期绑定任务拒绝且不覆盖最新映射');
  report.bindingId = binding.id;
  report.instanceId = instance.id;
  report.remoteContestId = remoteContestId;
  report.registrationId = r.id;
  report.remoteUserId = job.result.remoteUserId;
  report.remoteTeamId = job.result.remoteTeamId;
  report.status = 'PASS';
  console.log(`${mode}: ${report.checks.length} enhancement groups passed`);
} finally {
  await writeFile(
    `.runtime/reports/${mode.toLowerCase()}-enhancements.json`,
    JSON.stringify(report, null, 2),
  );
  await db.$disconnect();
  await redis.quit();
}
