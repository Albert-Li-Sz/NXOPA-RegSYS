import assert from 'node:assert/strict';
import { mailpitBase } from './mailpit.js';
import { writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { redis } from '../../apps/server/src/auth.js';
import { db } from '../../apps/server/src/db.js';
const run = Date.now(),
  report: string[] = [];
if (process.env.NODE_ENV === 'production')
  throw new Error('Acceptance fixtures are development-only');
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const client = new Client(),
    password = 'MailFixture2026!';
  let email = `mail-${run}@example.test`;
  let session = await client.register({
    email,
    username: `mail_${run}`,
    name: '邮箱验收用户',
    password,
  });
  client.user = session.user;
  client.csrf = session.csrf;
  assert.equal(session.user.verified, true);
  report.push('Mailbox code delivered and consumed before the account is created');
  email = `changed-${email}`;
  await client.api('/auth/profile', 'PUT', {
    version: session.user.version,
    name: session.user.name,
    profile: session.user.profile,
    email,
  });
  assert.equal((await client.api('/auth/me')).user.verified, false);
  async function mailToken() {
    return until(
      async () => {
        const s = (await (
          await fetch(`${mailpitBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
        ).json()) as any;
        const id = s.messages?.[0]?.ID;
        if (!id) return '';
        const m = (await (await fetch(`${mailpitBase}/api/v1/message/${id}`)).json()) as any;
        return String(m.Text ?? '').match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
      },
      (v) => !!v,
      30000,
    );
  }
  const verifyToken = await mailToken();
  await client.api('/auth/verify', 'POST', { token: verifyToken });
  assert.equal((await client.api('/auth/me')).user.verified, true);
  assert.equal(
    (await client.raw('/api/v1/auth/verify', 'POST', { token: verifyToken })).status,
    400,
  );
  report.push('Mailpit delivery, email verification and single-use token');
  await client.api('/auth/forgot', 'POST', { email });
  const resetToken = await until(mailToken, (v) => v !== verifyToken, 30000);
  await client.api('/auth/reset', 'POST', { token: resetToken, password: 'ResetFixture2026!' });
  assert.equal((await client.api('/auth/me')).user, null);
  await new Client().login(email, 'ResetFixture2026!');
  report.push('password recovery and revocation of previous sessions');
  const admin = await new Client().login('admin');
  assert.equal((await admin.raw('/api/v1/auth/providers')).status, 200);
  assert.equal((await admin.raw('/api/v1/auth/identities')).status, 404);
  for (const path of [
    '/api/v1/auth/oauth/11111111-1111-4111-8111-111111111111',
    '/api/v1/auth/oauth/11111111-1111-4111-8111-111111111111/callback',
    '/api/v1/admin/oauth',
  ]) {
    assert.equal((await admin.raw(path)).status, 404);
  }
  assert.equal((await admin.raw('/api/v1/admin/oauth', 'POST', {})).status, 404);
  report.push(
    'GitHub provider discovery remains available; retired generic OAuth routes return 404',
  );
  console.log(`Authentication acceptance: ${report.length} checks passed`);
} finally {
  await writeFile('.runtime/reports/auth.json', JSON.stringify({ report }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
