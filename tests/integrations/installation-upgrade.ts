import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { policySchema } from '../../packages/contracts/src/index.js';
import { Client, until, base } from './client.js';

type Run = (args: string[], overrides?: NodeJS.ProcessEnv) => Promise<string>;

export async function verifyInstallationUpgrade(
  run: Run,
  envFile: string,
  source: string,
  previousTag: string,
  targetTag: string,
  passed: (message: string) => void,
) {
  assert.match(previousTag, /^v\d+\.\d+\.\d+$/);
  assert.notEqual(previousTag, targetTag);
  await run(['compose', 'down', '-v', '--remove-orphans']);
  await writeFile(
    envFile,
    source
      .replace(/^IMAGE_TAG=.+$/m, `IMAGE_TAG=${previousTag}`)
      .replace(/^STORAGE_MODE=.+$/m, 'STORAGE_MODE=LOCAL'),
    {
      mode: 0o600,
    },
  );
  // Keep the installation script's env-file authoritative, including in CI.
  await run(['up'], { INSTALL_MODE: 'images', IMAGE_TAG: previousTag });
  assert.equal(
    (
      await run([
        'compose',
        'exec',
        '-T',
        'api',
        'node',
        '-p',
        "require('/app/package.json').version",
      ])
    ).trim(),
    previousTag.slice(1),
  );
  const credentials = {
    ADMIN_EMAIL: 'upgrade-check@example.test',
    ADMIN_USERNAME: 'upgrade_admin',
    ADMIN_PASSWORD: randomBytes(24).toString('base64url'),
  };
  await run(['admin'], { ...credentials, INSTALL_MODE: 'images', IMAGE_TAG: previousTag });
  const admin = await new Client().login(credentials.ADMIN_EMAIL, credentials.ADMIN_PASSWORD);
  await admin.completeProfile();
  const contest = await admin.api('/contests', 'POST', {
    title: '旧版本升级验收',
    season: '升级验收',
    description: '保留数据库与私有文件',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [],
  });
  let registration = await admin.api('/registrations', 'POST', { contestId: contest.id });
  registration = await admin.api(`/registrations/${registration.id}/submit`, 'POST', {
    version: registration.version,
  });
  const attachment = await admin.upload(registration.id);
  const generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [registration.id],
    room: '升级验收',
    seat: '1',
  });
  const documentId = generated.results[0].documentId;
  await until(
    () => admin.api(`/registrations/${registration.id}`),
    (r) => r.admissions.some((d: any) => d.id === documentId && d.state === 'READY'),
    120000,
  );
  await admin.api(`/admissions/${documentId}/release`, 'POST');

  async function emailLink(client: Client, purpose: 'verify' | 'reset') {
    assert.match(client.user.id, /^[a-f0-9-]{36}$/i);
    const output = await run([
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'contest',
      '-d',
      'contest_center',
      '-At',
      '-c',
      `SELECT "payload"->>'actionPath' FROM "OutboxEvent" WHERE "resourceId"='${client.user.id}' AND "type"='MAIL' AND "payload"->>'actionPath' LIKE '/account/${purpose}%' ORDER BY "createdAt" DESC LIMIT 1`,
    ]);
    assert.ok(output.trim().startsWith(`/account/${purpose}?`), 'Email endpoint creates a link');
    return new URL(output.trim(), base).searchParams.get('token')!;
  }
  const users: { client: Client; purpose: 'verify' | 'reset'; token: string }[] = [];
  for (const purpose of ['verify', 'reset'] as const) {
    const client = new Client();
    // This account is created on the previous image, before the new registration prerequisite exists.
    const session = await client.api('/auth/register', 'POST', {
      email: `upgrade-${purpose}@example.test`,
      username: `upgrade_${purpose}`,
      name: '升级邮件验收用户',
      password: 'UpgradeFixture2026!',
    });
    client.user = session.user;
    client.csrf = session.csrf;
    if (purpose === 'reset') await client.api('/auth/forgot', 'POST', { email: client.user.email });
    const token = await emailLink(client, purpose);
    client.user = await client.api('/auth/profile', 'PUT', {
      version: client.user.version,
      name: client.user.name,
      profile: client.user.profile,
      email: `upgrade-${purpose}-new@example.test`,
    });
    users.push({ client, purpose, token });
  }
  const outstanding = await run([
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'contest',
    '-d',
    'contest_center',
    '-At',
    '-c',
    'SELECT count(*) FROM "EmailToken" WHERE "usedAt" IS NULL',
  ]);
  assert.ok(Number(outstanding.trim()) >= 4, 'Old release leaves mailbox links outstanding');
  passed(`真实 ${previousTag} 空库已创建报名、附件、中文准考证和遗留邮件链接`);

  await writeFile(envFile, source, { mode: 0o600 });
  await run(['update', '--yes'], { IMAGE_TAG: targetTag });
  assert.equal(
    (
      await run([
        'compose',
        'exec',
        '-T',
        'api',
        'node',
        '-p',
        "require('/app/package.json').version",
      ])
    ).trim(),
    targetTag.slice(1),
  );
  const restored = await admin.api(`/registrations/${registration.id}`);
  assert.equal(restored.version, registration.version);
  assert.equal(restored.eligible, true);
  assert.equal(restored.ownerId, admin.user.id);
  if (Number(targetTag.split('.')[1]) >= 2) {
    assert.equal(restored.number, 1, 'Historical submissions receive chronological numbers');
    const counter = await run([
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'contest',
      '-d',
      'contest_center',
      '-At',
      '-c',
      `SELECT "nextRegistrationNumber" FROM "Contest" WHERE id='${contest.id}'`,
    ]);
    assert.equal(counter.trim(), '2', 'Counter resumes after the historical last submission');
  }
  assert.equal(
    await (await admin.raw(`/api/v1/files/${attachment.id}`)).text(),
    'offline payment proof',
  );
  const pdf = await admin.raw(`/api/v1/admissions/${documentId}/download`);
  assert.equal(pdf.status, 200);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
  passed(`${previousTag} 升级到 ${targetTag} 自动备份并迁移，管理员会话、报名、附件和准考证保留`);

  for (const { client, purpose, token } of users) {
    const response = await client.raw(`/api/v1/auth/${purpose}`, 'POST', {
      token,
      ...(purpose === 'reset' ? { password: 'OldMailbox2026!' } : {}),
    });
    assert.equal(response.status, 400, 'Legacy mailbox links must be invalid after upgrade');
    assert.equal((await client.api('/auth/me')).user.verified, false);
    if (purpose === 'verify') await client.api('/auth/resend', 'POST', {});
    else await client.api('/auth/forgot', 'POST', { email: client.user.email });
    const current = await emailLink(client, purpose);
    await client.api(`/auth/${purpose}`, 'POST', {
      token: current,
      ...(purpose === 'reset' ? { password: 'NewMailbox2026!' } : {}),
    });
    if (purpose === 'verify') assert.equal((await client.api('/auth/me')).user.verified, true);
    else {
      assert.equal((await client.api('/auth/me')).user, null);
      await new Client().login(client.user.email, 'NewMailbox2026!');
    }
  }
  passed('升级前遗留的验证与重置链接失效，新邮箱重新申请链接可用；重置密码撤销旧会话');
}
