import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client } from './client.js';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
const mock = process.env.FEISHU_API_BASE_URL;
if (!mock?.startsWith('http://127.0.0.1:'))
  throw new Error('Use the isolated full-regression fixture');
const original = await db.setting.findUnique({ where: { key: 'feishu-login' } }),
  checks: string[] = [],
  stamp = randomUUID().slice(0, 8);
async function profile(open_id: string, email: string) {
  await fetch(mock + '/fixture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ open_id, email }),
  });
}
async function flow(actor: Client, mode = '') {
  if (mode === 'link') await actor.api('/auth/reauth', 'POST', { password: 'DemoContest2026!' });
  const start = await actor.raw(
    '/api/v1/auth/feishu?next=%2Foverview' + (mode ? '&mode=' + mode : ''),
  );
  assert.equal(start.status, 302);
  const url = new URL(start.headers.get('location')!);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const authorize = await fetch(url, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  return new URL(authorize.headers.get('location')!);
}
async function finish(actor: Client, callback: URL) {
  const response = await actor.raw(callback.pathname + callback.search);
  assert.equal(response.status, 302);
  return response.headers.get('location')!;
}
async function hydrate(actor: Client) {
  const me = await actor.api('/auth/me');
  actor.user = me.user;
  actor.csrf = me.csrf;
  return me.user;
}
function pass(message: string) {
  checks.push(message);
  console.log('PASS ' + message);
}
try {
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice');
  assert.equal((await alice.raw('/api/v1/admin/feishu')).status, 403);
  const initial = await admin.api('/admin/feishu');
  const configured = await admin.api('/admin/feishu', 'PUT', {
    ...initial,
    enabled: true,
    appId: 'cli_fixture',
    appSecret: 'fixture-secret',
  });
  assert.equal(configured.secretConfigured, true);
  assert.ok(!JSON.stringify(configured).includes('fixture-secret'));
  const retained = await admin.api('/admin/feishu', 'PUT', { ...configured, appSecret: '' });
  assert.equal(retained.secretConfigured, true);
  pass('系统管理员配置飞书，密钥加密存储、留空保留且不返回浏览器');
  await profile(`ou_${stamp}`, admin.user.email);
  const newcomer = new Client(),
    callback = await flow(newcomer);
  const before = (await (await fetch(mock + '/fixture')).json()).tokenRequests;
  assert.match(
    await finish(
      newcomer,
      new URL(callback.href.replace(callback.searchParams.get('state')!, 'x'.repeat(43))),
    ),
    /feishu_error=state/,
  );
  assert.equal((await (await fetch(mock + '/fixture')).json()).tokenRequests, before);
  const fresh = await flow(newcomer),
    oldCookie = newcomer.cookie;
  const redirect = await finish(newcomer, fresh);
  assert.ok(redirect.includes('feishu_claim='));
  assert.equal((await newcomer.api('/auth/me')).user, null);
  const claim = new URL(redirect, 'http://localhost').searchParams.get('feishu_claim')!;
  assert.equal((await newcomer.api('/auth/feishu/signup?claim=' + claim)).email, admin.user.email);
  assert.equal((await new Client().raw('/api/v1/auth/feishu/signup?claim=' + claim)).status, 400);
  pass('飞书返回同邮箱不会自动合并管理员账号，注册验证绑定浏览器且 state 篡改被拒绝');
  const registered = await newcomer.register({
    email: `feishu-${stamp}@example.test`,
    username: `feishu_${stamp}`,
    name: '飞书注册用户',
    kind: 'STUDENT',
    identifier: `FS-${stamp}`,
    enrollmentYear: 2026,
    password: 'FeishuFixture2026!',
    feishuClaim: claim,
  });
  assert.equal(registered.user.verified, true);
  assert.equal(registered.user.isAdmin, false);
  await newcomer.completeProfile();
  const logged = new Client();
  assert.equal(await finish(logged, await flow(logged)), '/overview');
  assert.equal((await hydrate(logged)).id, registered.user.id);
  const replay = new Client();
  replay.cookie = oldCookie;
  assert.match(await finish(replay, fresh), /feishu_error=state/);
  pass('邮箱验证码通过后注册并绑定飞书，可经 v3、PKCE 和用户信息接口重新登录，授权回调不能重放');
  assert.match(await finish(admin, await flow(admin, 'link')), /feishu_error=bound/);
  const detail = await admin.api(`/admin/users/${registered.user.id}`);
  const banned = await admin.api(`/admin/users/${registered.user.id}/ban`, 'PUT', {
    version: detail.version,
    banned: true,
    reason: '飞书封禁测试',
  });
  assert.equal((await logged.api('/auth/me')).user, null);
  const refused = new Client();
  assert.match(await finish(refused, await flow(refused)), /feishu_error=failed/);
  await admin.api(`/admin/users/${registered.user.id}/ban`, 'PUT', {
    version: banned.version,
    banned: false,
  });
  await finish(logged, await flow(logged));
  await hydrate(logged);
  await logged.api('/auth/reauth', 'POST', { password: 'FeishuFixture2026!' });
  await logged.api('/auth/feishu', 'DELETE');
  assert.equal((await logged.api('/auth/providers')).feishu.linked, false);
  pass('飞书不能绑定其他账号或绕过封禁，解除绑定即时生效');
  await profile(`ou_bind_${stamp}`, 'unverified-contact@example.test');
  assert.equal(await finish(alice, await flow(alice, 'link')), '/me/profile?tab=settings');
  await hydrate(alice);
  const bound = new Client();
  await finish(bound, await flow(bound));
  assert.equal((await hydrate(bound)).id, alice.user.id);
  await alice.api('/auth/reauth', 'POST', { password: 'DemoContest2026!' });
  await alice.api('/auth/feishu', 'DELETE');
  pass('已有账号可主动绑定飞书，按 open_id 登录，不依赖飞书提供的未验证联系邮箱');
} finally {
  if (original)
    await db.setting.upsert({
      where: { key: 'feishu-login' },
      create: { key: original.key, value: json(original.value), version: original.version },
      update: { value: json(original.value), version: original.version },
    });
  else await db.setting.deleteMany({ where: { key: 'feishu-login' } });
  await writeFile('.runtime/reports/feishu.json', JSON.stringify({ checks }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
