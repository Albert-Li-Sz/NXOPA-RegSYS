import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { mailpitBase } from './mailpit.js';
import { db, json, enqueue } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { decrypt } from '../../apps/server/src/security.js';
if (process.env.NODE_ENV === 'production') throw new Error('Mail fixtures are development-only');
const exec = promisify(execFile),
  run = Date.now(),
  report: string[] = [];
const fixture = `contest-center-mail-settings-${run}`;
const password = 'FictitiousMailPassword2026!';
const original = await db.setting.findUnique({ where: { key: 'mail' } });
try {
  await mkdir('.runtime/reports', { recursive: true });
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  await exec('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    fixture,
    '-p',
    '127.0.0.1:51125:1025',
    '-p',
    '127.0.0.1:58125:8025',
    '-e',
    `MP_SMTP_AUTH=fixture:${password}`,
    '-e',
    'MP_SMTP_AUTH_ALLOW_INSECURE=true',
    'axllent/mailpit:v1.27.8',
  ]);
  await until(
    async () =>
      fetch('http://localhost:58125/api/v1/info')
        .then((r) => r.ok)
        .catch(() => false),
    (v) => v,
  );
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice'),
    manager = await new Client().login('manager');
  for (const client of [alice, manager]) {
    for (const [path, method] of [
      ['/admin/mail', 'GET'],
      ['/admin/mail', 'PUT'],
      ['/admin/mail/probe', 'POST'],
      ['/admin/mail/test', 'POST'],
      ['/admin/mail/tests/00000000-0000-4000-8000-000000000000', 'GET'],
    ]) {
      assert.equal(
        (await client.raw(`/api/v1${path}`, method, method === 'GET' ? undefined : {})).status,
        403,
      );
    }
  }
  assert.equal((await new Client().raw('/api/v1/admin/mail')).status, 401);
  report.push('Only system administrators can read, save, probe or test mail settings');
  const initial = await admin.api('/admin/mail');
  let current = await admin.api('/admin/mail', 'PUT', {
    ...initial,
    enabled: true,
    host: 'localhost',
    port: 51125,
    security: 'NONE',
    authEnabled: true,
    username: 'fixture',
    password,
    fromAddress: `mail-${run}@example.test`,
    fromName: '配置验收邮件',
  });
  assert.equal(current.source, 'DATABASE');
  assert.equal(current.passwordConfigured, true);
  assert.equal('password' in current, false);
  assert.equal('encryptedPassword' in current, false);
  const stored = await db.setting.findUniqueOrThrow({ where: { key: 'mail' } });
  const storedValue = stored.value as Record<string, unknown>;
  assert.equal(JSON.stringify(stored.value).includes(password), false);
  assert.equal(decrypt(String(storedValue.encryptedPassword)), password);
  const audits = await db.auditEvent.findMany({ where: { resourceId: 'mail' } });
  assert.equal(JSON.stringify(audits).includes(password), false);
  assert.equal(JSON.stringify(audits).includes(String(storedValue.encryptedPassword)), false);
  assert.equal(
    JSON.stringify(await new Client().api('/site')).includes('passwordConfigured'),
    false,
  );
  report.push(
    'Passwords encrypted at rest and absent from read responses, public settings and audit logs',
  );
  assert.equal(
    (await admin.api('/admin/mail/probe', 'POST', { version: current.version })).ok,
    true,
  );
  report.push('Real authenticated SMTP connection verified against isolated Mailpit');
  async function delivered(version: number, mailbox = 'http://localhost:58125') {
    const key = `mail-test-${run}-${version}`;
    const response = await admin.api('/admin/mail/test', 'POST', { version }, key);
    const replay = await admin.api('/admin/mail/test', 'POST', { version }, key);
    assert.equal(response.jobId, replay.jobId);
    const job = await until(
      () => admin.api(`/admin/mail/tests/${response.jobId}`),
      (j) => j.state === 'SUCCESS' || j.state === 'FAILED',
    );
    assert.equal(job.state, 'SUCCESS', job.error);
    assert.equal(job.result.configurationVersion, version);
    const message = await until(
      async () => {
        const found = (await (
          await fetch(
            `${mailbox}/api/v1/search?query=${encodeURIComponent(`to:${admin.user.email}`)}`,
          )
        ).json()) as any;
        for (const m of found.messages ?? []) {
          const body = (await (await fetch(`${mailbox}/api/v1/message/${m.ID}`)).json()) as any;
          if (body.Text?.includes(`配置版本：${version}\n`)) return body;
        }
        return null;
      },
      (m) => !!m,
    );
    assert.equal(message.From.Address, current.fromAddress);
    assert.equal(message.From.Name, current.fromName);
    return response;
  }
  await delivered(current.version);
  report.push(
    'Persistent worker sends a real test email using saved credentials and deduplicates request replay',
  );
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    password: '',
    fromName: '修改后即时生效',
  });
  assert.equal(current.passwordConfigured, true);
  await delivered(current.version);
  report.push(
    'Blank password preserves credentials; changed sender applies without restarting API or worker',
  );
  const raced = await Promise.all([
    admin.raw('/api/v1/admin/mail', 'PUT', { ...current, fromName: '并发配置甲' }),
    admin.raw('/api/v1/admin/mail', 'PUT', { ...current, fromName: '并发配置乙' }),
  ]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
  current = await admin.api('/admin/mail');
  assert.equal(
    (await admin.raw('/api/v1/admin/mail/test', 'POST', { version: stored.version })).status,
    409,
  );
  assert.equal(
    (await admin.raw('/api/v1/admin/mail/probe', 'POST', { version: stored.version })).status,
    409,
  );
  report.push(
    'Concurrent edits and stale test requests cannot overwrite or test a different configuration',
  );
  assert.equal(
    (
      await admin.raw('/api/v1/admin/mail', 'PUT', {
        ...current,
        username: 'changed',
        password: '',
      })
    ).status,
    400,
  );
  assert.equal(
    (await admin.raw('/api/v1/admin/mail', 'PUT', { ...current, host: 'smtp://localhost' })).status,
    400,
  );
  assert.equal(
    (await admin.raw('/api/v1/admin/mail', 'PUT', { ...current, port: 70000 })).status,
    400,
  );
  assert.equal(
    (await admin.raw('/api/v1/admin/mail', 'PUT', { ...current, fromName: '名称\r\n注入' })).status,
    400,
  );
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    password: 'WrongFictitiousPassword',
  });
  const denied = await admin.raw('/api/v1/admin/mail/probe', 'POST', { version: current.version });
  assert.equal(denied.status, 400);
  assert.match(((await denied.json()) as any).message, /认证失败/);
  current = await admin.api('/admin/mail', 'PUT', { ...current, password, security: 'STARTTLS' });
  const tls = await admin.raw('/api/v1/admin/mail/probe', 'POST', { version: current.version });
  assert.equal(tls.status, 400);
  assert.match(((await tls.json()) as any).message, /加密/);
  report.push(
    'Invalid settings rejected; authentication and required-TLS failures return sanitized Chinese messages',
  );
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    password,
    enabled: false,
    security: 'NONE',
  });
  assert.equal(
    (await admin.raw('/api/v1/admin/mail/test', 'POST', { version: current.version })).status,
    400,
  );
  assert.equal(
    (await admin.raw('/api/v1/admin/mail/probe', 'POST', { version: current.version })).status,
    400,
  );
  const staleJob = await db.$transaction((tx) =>
    enqueue(tx, 'MAIL', 'mail', `mail-stale-${run}`, {
      to: admin.user.email,
      subject: '过期配置测试',
      text: '不应发送',
      test: true,
      configurationVersion: current.version - 1,
    }),
  );
  const stale = await until(
    () => admin.api(`/admin/mail/tests/${staleJob.id}`),
    (j) => j.state === 'FAILED',
  );
  assert.match(stale.error, /设置已变更/);
  await db.job.update({ where: { id: staleJob.id }, data: { attempts: 4 } });
  report.push(
    'Disabled service rejects test sends; worker rejects jobs targeting an obsolete settings version',
  );
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    enabled: true,
    host: 'localhost',
    port: Number(process.env.SMTP_PORT ?? 51025),
    authEnabled: false,
    password: '',
  });
  assert.equal(current.passwordConfigured, false);
  const cleared = await db.setting.findUniqueOrThrow({ where: { key: 'mail' } });
  assert.equal((cleared.value as any).encryptedPassword, '');
  await delivered(current.version, mailpitBase);
  const email = `mail-settings-${run}@example.test`,
    client = new Client();
  const session = await client.register({
    email,
    username: `mail_settings_${run}`,
    password: 'MailSettings2026!',
    name: '邮件配置注册验收',
  });
  client.csrf = session.csrf;
  assert.equal((await client.api('/auth/me')).user.verified, true);
  report.push(
    'Clearing authentication removes its secret; normal public registration still delivers and verifies email',
  );
  console.log(`Mail settings acceptance: ${report.length} checks passed`);
} finally {
  await db.job.deleteMany({ where: { dedupeKey: `mail-stale-${run}` } });
  if (original)
    await db.setting.upsert({
      where: { key: 'mail' },
      create: { key: 'mail', value: json(original.value), version: original.version },
      update: { value: json(original.value), version: original.version },
    });
  else await db.setting.deleteMany({ where: { key: 'mail' } });
  await exec('docker', ['rm', '-f', fixture]).catch(() => {});
  await writeFile('.runtime/reports/mail-settings.json', JSON.stringify({ report }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
