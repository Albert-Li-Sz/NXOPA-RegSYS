import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

const mode = process.env.OJ_TYPE ?? 'HYDRO';
const context = JSON.parse(
  await readFile(`.runtime/reports/${mode.toLowerCase()}-enhancements.json`, 'utf8'),
);
assert.equal(context.status, 'PASS');
const upstream = mode === 'HYDRO' ? 'http://localhost:58888' : 'http://localhost:58901';
let lostResponses = 0;
// Forward to the actual OJ and discard one successful creation response.
const proxy = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const target = new URL(request.url ?? '/', upstream);
    assert.equal(
      target.origin,
      new URL(upstream).origin,
      'Recovery proxy must stay on its fixture upstream',
    );
    const remote = await fetch(target, {
      method: request.method,
      headers: {
        Authorization: String(request.headers.authorization ?? ''),
        'Content-Type': String(request.headers['content-type'] ?? 'application/json'),
        Accept: 'application/json',
      },
      body: ['GET', 'HEAD'].includes(request.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    });
    const body = await remote.arrayBuffer();
    const creation = mode === 'HYDRO' ? '/contest-center/v1/provision' : '/api/users';
    if (!lostResponses && request.method === 'POST' && request.url === creation && remote.ok) {
      lostResponses++;
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"acceptance: successful remote response discarded"}');
    } else {
      response.writeHead(remote.status, {
        'Content-Type': remote.headers.get('content-type') ?? 'application/json',
      });
      response.end(Buffer.from(body));
    }
  } catch {
    response.writeHead(502);
    response.end('Acceptance upstream unavailable');
  }
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
const port = (proxy.address() as { port: number }).port;
const checks: string[] = [];
let contestId = '';
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  const contest = await admin.api('/contests', 'POST', {
    title: `${mode} 个人报名恢复验收`,
    season: '验收',
    description: '独立本地真实评测平台验收',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({
      mode: 'INDIVIDUAL',
      coachMode: 'DISABLED',
      allowUnofficial: true,
      platformProfiles: [mode === 'HYDRO' ? 'HYDRO_5_0_7' : 'DOMJUDGE_9_0_1'],
    }),
    fields: [],
  });
  contestId = contest.id;
  let r = await admin.api('/registrations', 'POST', { contestId });
  r = await admin.api(`/registrations/${r.id}`, 'PUT', {
    ...r,
    organization: { name: '南京晓庄学院', shortName: '晓庄', country: 'CHN' },
    people: [{ ...r.people[0], name: '个人验收选手', email: 'individual@example.test' }],
  });
  r = await admin.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'APPROVED',
  });
  const previousBinding = (
    await admin.api(
      `/integrations/bindings?contestId=${context.registrationId ? (await admin.api(`/registrations/${context.registrationId}`)).contestId : ''}`,
    )
  ).find((x: any) => x.id === context.bindingId);
  const credentials =
    mode === 'HYDRO'
      ? { token: 'local-fixture-token-32characters-for-testing-only' }
      : { username: 'cc_api', password: 'FixtureAPI2026!' };
  const instance = await admin.api('/integrations/instances', 'POST', {
    name: `${mode} 恢复验收转发`,
    type: mode,
    baseUrl: `http://127.0.0.1:${port}`,
    credentials,
    allowedContestIds: [contestId],
  });
  let binding = await admin.api('/integrations/bindings', 'POST', {
    contestId,
    instanceId: instance.id,
    remoteContestId: context.remoteContestId,
    domainId: 'system',
    automatic: false,
    groupIds: previousBinding.groupIds,
    unofficialGroupId: previousBinding.unofficialGroupId,
  });
  let sync = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  if (mode === 'DOMJUDGE') {
    assert.equal(sync.state, 'WAITING_ORGANIZATION');
    const school = (
      await admin.api(`/integrations/bindings/${binding.id}/schools?page=1&pageSize=20`)
    ).items.find((x: any) => x.id === sync.organizationMappingId);
    await admin.api(`/integrations/bindings/${binding.id}/schools/${school.id}`, 'PUT', {
      ...school,
      remoteId: context.organizationId,
      create: false,
    });
    sync = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
      bindingId: binding.id,
    });
  }
  let job = await until(
    () => admin.api(`/jobs/${sync.jobId}`),
    (value) => value.state === 'SUCCESS' || (value.state === 'FAILED' && value.attempts >= 4),
    90000,
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  assert.equal(lostResponses, 1);
  assert.ok(job.attempts >= 2);
  const recoveryAttempts = job.attempts;
  const result = job.result;
  const account = (await admin.api(`/integrations/registrations/${r.id}/credentials`)).find(
    (x: any) => x.bindingId === binding.id,
  );
  assert.ok(account);
  if (mode === 'HYDRO') {
    assert.equal(result.verification.nickname, '个人验收选手');
    assert.equal(result.verification.unrank, false);
    const count = Number(
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
          `print(db.user.countDocuments({uname:'${account.username}'}))`,
        ],
        { encoding: 'utf8' },
      ).trim(),
    );
    assert.equal(count, 1);
  } else {
    assert.equal(result.verification.teamName, '个人验收选手');
    const headers = {
      Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
    };
    const users = (await (await fetch(`${upstream}/api/users`, { headers })).json()) as any[];
    const teams = (await (await fetch(`${upstream}/api/teams`, { headers })).json()) as any[];
    assert.equal(users.filter((x) => x.username === account.username).length, 1);
    assert.equal(teams.filter((x) => String(x.id) === result.remoteTeamId).length, 1);
  }
  checks.push('个人报名姓名映射，真实远端创建后丢失响应，自动重试且账号／队伍没有重复');
  r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'APPROVED',
    participationType: 'UNOFFICIAL',
  });
  binding = await admin.api('/integrations/bindings', 'POST', {
    ...binding,
    includeUnofficial: false,
  });
  const skipped = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  assert.equal(skipped.state, 'SKIPPED');
  assert.equal(skipped.jobId, undefined);
  binding = await admin.api('/integrations/bindings', 'POST', {
    ...binding,
    includeUnofficial: true,
  });
  sync = await admin.api(`/integrations/registrations/${r.id}/sync`, 'POST', {
    bindingId: binding.id,
  });
  job = await until(
    () => admin.api(`/jobs/${sync.jobId}`),
    (value) => ['SUCCESS', 'FAILED'].includes(value.state),
    90000,
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  assert.equal(job.result.remoteUserId, result.remoteUserId);
  if (mode === 'HYDRO') assert.equal(job.result.verification.unrank, true);
  else assert.deepEqual(job.result.verification.groupIds, [binding.unofficialGroupId]);
  checks.push('禁用非正式导入时跳过，重新启用后复用原账号并恢复非正式关联');
  await writeFile(
    `.runtime/reports/${mode.toLowerCase()}-recovery.json`,
    JSON.stringify(
      {
        platform: mode,
        at: new Date().toISOString(),
        status: 'PASS',
        checks,
        lostResponses,
        attempts: recoveryAttempts,
        registrationId: r.id,
        bindingId: binding.id,
        remoteUserId: result.remoteUserId,
        remoteTeamId: result.remoteTeamId,
      },
      null,
      2,
    ),
  );
  console.log(`${mode}: ${checks.length} real recovery groups passed`);
} finally {
  if (contestId)
    await db.contest.update({
      where: { id: contestId },
      data: { published: false, archived: true },
    });
  proxy.close();
  proxy.closeAllConnections();
  await db.$disconnect();
  await redis.quit();
}
