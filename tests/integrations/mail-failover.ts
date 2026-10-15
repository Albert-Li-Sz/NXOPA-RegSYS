import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { decrypt } from '../../apps/server/src/security.js';
import { sendSystemMail } from '../../apps/server/src/mail.js';
const original = await db.setting.findUnique({ where: { key: 'mail' } }),
  checks: string[] = [];
let beforeReject: (() => Promise<void>) | undefined;
const server = createServer((socket) => {
  socket.write('220 fixture SMTP\r\n');
  socket.on('data', (bytes) => {
    const line = bytes.toString();
    if (/^EHLO|^HELO/.test(line)) socket.write('250 fixture\r\n');
    else if (/^MAIL FROM/.test(line)) socket.write('250 OK\r\n');
    else if (/^RCPT TO/.test(line)) {
      const action = beforeReject;
      beforeReject = undefined;
      void (async () => {
        if (action) await action();
        socket.write('550 Recipient rejected\r\n');
      })().catch(() => socket.destroy());
    } else if (/^QUIT/.test(line)) socket.end('221 Bye\r\n');
    else socket.write('250 OK\r\n');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
function pass(message: string) {
  checks.push(message);
  console.log('PASS ' + message);
}
try {
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
  const admin = await new Client().login('admin'),
    initial = await admin.api('/admin/mail');
  const working = {
    id: randomUUID(),
    name: '可用备用',
    enabled: true,
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 51025),
    security: 'NONE',
    authEnabled: false,
    username: '',
    password: '',
    fromAddress: admin.user.email,
    fromName: '备用验收',
  };
  const unavailable = { ...working, id: randomUUID(), name: '不可用备用', port: 1 };
  let current = await admin.api('/admin/mail', 'PUT', {
    ...initial,
    enabled: true,
    host: '127.0.0.1',
    port: 1,
    security: 'NONE',
    authEnabled: false,
    username: '',
    password: '',
    fallbacks: [unavailable, working, { ...working, id: randomUUID(), name: '后续备用' }],
  });
  async function deliver() {
    const job = await admin.api('/admin/mail/test', 'POST', { version: current.version });
    const status = await until(
      () => admin.api(`/admin/mail/tests/${job.jobId}`),
      (v) => v.state === 'SUCCESS' || v.state === 'FAILED',
      30000,
    );
    assert.equal(status.state, 'SUCCESS', status.error);
    return status.result;
  }
  let delivered = await deliver();
  assert.equal(delivered.providerId, working.id);
  assert.deepEqual(
    delivered.attempts.map((row: any) => row.providerId),
    ['primary', unavailable.id],
  );
  pass('主 SMTP 失败后按顺序尝试备用，成功后不再调用后续备用');
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    password: '',
    fallbacks: [working, unavailable],
  });
  delivered = await deliver();
  assert.equal(delivered.attempts.length, 1);
  assert.equal(delivered.providerId, working.id);
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    host: working.host,
    port: working.port,
    password: '',
  });
  delivered = await deliver();
  assert.equal(delivered.providerId, 'primary');
  assert.equal(delivered.attempts.length, 0);
  pass('管理员调整备用顺序即时生效，主 SMTP 正常时优先使用主服务器');
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    host: '127.0.0.1',
    port: address.port,
    password: '',
  });
  delivered = await deliver();
  assert.equal(delivered.providerId, working.id);
  assert.equal(delivered.attempts.length, 1);
  pass('SMTP 拒绝收件人时也会自动切换，实际邮件完成投递');
  const activity = await admin.api('/contests', 'POST', {
    title: `邮件取消保护 ${Date.now()}`,
    season: '验收',
    description: '独立取消场景',
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    fields: [],
    policy: {},
  });
  const registration = await admin.api('/registrations', 'POST', { contestId: activity.id });
  beforeReject = async () => {
    await admin.api(`/registrations/${registration.id}/cancel`, 'POST', {
      version: registration.version,
    });
  };
  const stopped = await sendSystemMail(
    {
      to: admin.user.email,
      subject: `删除中止 ${registration.id}`,
      text: '此邮件应在取消后停止备用发送',
      actionPath: `/registrations/${registration.id}`,
    },
    undefined,
    async () => (await db.registration.count({ where: { id: registration.id } })) > 0,
  );
  assert.ok(
    'skipped' in stopped && stopped.skipped,
    'Deletion during SMTP failure must prevent subsequent backup delivery',
  );
  assert.equal(await db.registration.count({ where: { id: registration.id } }), 0);
  await db.contest.update({ where: { id: activity.id }, data: { archived: true } });
  pass('发送中删除报名后，停止切换备用 SMTP，不投递已删除的报名通知');
  const secret = 'FictitiousBackupSecret2026!',
    protectedServer = {
      ...working,
      id: randomUUID(),
      name: '认证备用',
      authEnabled: true,
      username: 'backup-user',
      password: secret,
    };
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    password: '',
    fallbacks: [protectedServer],
  });
  assert.ok(!JSON.stringify(current).includes(secret));
  assert.equal(current.fallbacks[0].passwordConfigured, true);
  let stored = await db.setting.findUniqueOrThrow({ where: { key: 'mail' } });
  assert.equal(decrypt((stored.value as any).fallbacks[0].encryptedPassword), secret);
  current = await admin.api('/admin/mail', 'PUT', {
    ...current,
    password: '',
    fallbacks: current.fallbacks.map((s: any) => ({ ...s, password: '' })),
  });
  stored = await db.setting.findUniqueOrThrow({ where: { key: 'mail' } });
  assert.equal(decrypt((stored.value as any).fallbacks[0].encryptedPassword), secret);
  assert.equal(
    (
      await admin.raw('/api/v1/admin/mail', 'PUT', {
        ...current,
        fallbacks: [{ ...current.fallbacks[0], username: 'different-user', password: '' }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await admin.raw('/api/v1/admin/mail', 'PUT', {
        ...current,
        fallbacks: [current.fallbacks[0], current.fallbacks[0]],
      })
    ).status,
    400,
  );
  pass('备用密码加密、留空保留，更换用户名需重新配置，重复标识被拒绝');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (original)
    await db.setting.upsert({
      where: { key: 'mail' },
      create: { key: original.key, value: json(original.value), version: original.version },
      update: { value: json(original.value), version: original.version },
    });
  else await db.setting.deleteMany({ where: { key: 'mail' } });
  await writeFile('.runtime/reports/mail-failover.json', JSON.stringify({ checks }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
