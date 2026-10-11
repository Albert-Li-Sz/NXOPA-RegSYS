import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { verificationUrl } from './mailpit.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { policySchema, type AccountInvitationInput } from '../../packages/contracts/src/index.js';

if (config.production) throw new Error('Authorization acceptance fixtures are development-only');
const run = Date.now().toString(36),
  started = Date.now();
const userIds: string[] = [],
  contestIds: string[] = [],
  registrationIds: string[] = [],
  invitationIds: string[] = [];
const report: { case: string; status: 'PASS' }[] = [];
let passed = false;
const record = (name: string) => {
  report.push({ case: name, status: 'PASS' });
  console.log(`PASS ${name}`);
};
const invitationToken = (invitation: { url: string }) =>
  new URL(invitation.url).pathname.split('/').pop()!;
const invitationPath = (invitation: { url: string }) =>
  `/invitations/${invitationToken(invitation)}`;
async function status(c: Client, path: string, method: string, body: unknown, expected: number) {
  const response = await c.raw(`/api/v1${path}`, method, body);
  assert.equal(
    response.status,
    expected,
    `${method} invitation operation: ${await response.text()}`,
  );
}
async function refresh(c: Client) {
  c.user = (await c.api('/auth/me')).user;
  return c.user;
}

try {
  await mkdir('.runtime/reports', { recursive: true });
  await redis.del(
    'rate:login:::ffff:127.0.0.1',
    'rate:login:127.0.0.1',
    'rate:register:::ffff:127.0.0.1',
    'rate:register:127.0.0.1',
  );
  const admin = await new Client().login('admin');
  const passwordHash = (await db.user.findUniqueOrThrow({ where: { username: 'alice' } }))
    .passwordHash;
  async function actor(key: string) {
    const user = await db.user.create({
      data: {
        username: `invite_${run}_${key}`,
        email: `invite-${run}-${key}@example.test`,
        name: `授权验收 ${key}`,
        passwordHash,
        verified: true,
      },
    });
    userIds.push(user.id);
    return new Client().login(user.username);
  }
  const receiver = await actor('receiver'),
    wrong = await actor('wrong'),
    coach = await actor('coach'),
    issuer = await actor('issuer'),
    member1 = await actor('member1'),
    member2 = await actor('member2');
  async function contest(extra: Record<string, unknown> = {}) {
    const c = await admin.api('/contests', 'POST', {
      title: `链接授权验收 ${run} ${contestIds.length + 1}`,
      season: '授权验收',
      description: '虚构验收数据',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      published: true,
      policy: policySchema.parse(extra),
      fields: [],
    });
    contestIds.push(c.id);
    return c;
  }
  async function invite(input: Partial<AccountInvitationInput>, by = admin, key?: string) {
    const i = await by.api('/admin/invitations', 'POST', input, key);
    invitationIds.push(i.id);
    return i;
  }
  async function association(owner: Client, registrationId: string | undefined, kind: string) {
    const i = await owner.api(
      registrationId ? `/registrations/${registrationId}/invites` : '/coach/links',
      'POST',
      { kind },
    );
    invitationIds.push(i.id);
    return i;
  }
  async function registration(owner: Client, contestId: string) {
    const r = await owner.api('/registrations', 'POST', { contestId });
    registrationIds.push(r.id);
    return r;
  }
  const c1 = await contest(),
    c2 = await contest();
  await status(
    receiver,
    '/admin/invitations',
    'POST',
    { kind: 'SYSTEM_ADMIN', userId: receiver.user.id },
    403,
  );
  await status(receiver, '/admin/roles', 'POST', { userId: receiver.user.id, isAdmin: true }, 403);
  await status(
    admin,
    '/admin/invitations',
    'POST',
    { kind: 'CONTEST_ADMIN', userId: receiver.user.id },
    400,
  );
  await status(
    admin,
    '/admin/invitations',
    'POST',
    { kind: 'SYSTEM_ADMIN', contestId: c1.id, userId: receiver.user.id },
    400,
  );
  await status(admin, '/admin/invitations', 'POST', { kind: 'SYSTEM_ADMIN' }, 400);
  await status(
    admin,
    '/admin/invitations',
    'POST',
    { kind: 'ACCOUNT', userId: receiver.user.id, targetEmail: wrong.user.email },
    400,
  );
  await status(
    admin,
    '/admin/roles',
    'POST',
    { userId: receiver.user.id, contestId: c1.id, isAdmin: true },
    400,
  );
  record('only system administrators issue invitations; recipient and scope validation');

  const role = await admin.api('/admin/roles', 'POST', {
    userId: receiver.user.id,
    contestId: c1.id,
    grant: true,
  });
  invitationIds.push(role.id);
  assert.equal(
    await db.roleAssignment.count({ where: { userId: receiver.user.id, contestId: c1.id } }),
    0,
  );
  await status(new Client(), invitationPath(role), 'GET', undefined, 401);
  await status(wrong, invitationPath(role), 'GET', undefined, 403);
  await status(wrong, `${invitationPath(role)}/accept`, 'POST', {}, 403);
  await status(receiver, `/contests/${c1.id}/statistics`, 'GET', undefined, 403);
  const preview = await receiver.api(invitationPath(role));
  assert.equal(preview.kind, 'CONTEST_ADMIN');
  assert.equal(preview.contest.id, c1.id);
  assert.equal(preview.accepted, false);
  assert.equal((await refresh(receiver)).contestIds.length, 0);
  record('grant endpoint returns a URL; opening it grants nothing; wrong account is rejected');

  const accepted = await Promise.all(
    Array.from({ length: 10 }, () => receiver.api(`${invitationPath(role)}/accept`, 'POST', {})),
  );
  assert.equal(accepted.filter((value) => !value.alreadyAccepted).length, 1);
  assert.equal(
    await db.roleAssignment.count({ where: { userId: receiver.user.id, contestId: c1.id } }),
    1,
  );
  assert.equal(
    await db.auditEvent.count({
      where: { resourceId: role.id, action: 'AUTHORIZATION_INVITE_ACCEPT' },
    }),
    1,
  );
  assert.ok((await db.invitation.findUniqueOrThrow({ where: { id: role.id } })).acceptedAt);
  await receiver.api(`/contests/${c1.id}/statistics`);
  await status(receiver, `/contests/${c2.id}/statistics`, 'GET', undefined, 403);
  await status(receiver, '/admin/users', 'GET', undefined, 403);
  record(
    'ten concurrent confirmations grant one contest role once; other contests remain forbidden',
  );

  const waiting = await invite({
    kind: 'CONTEST_ADMIN',
    userId: receiver.user.id,
    contestId: c1.id,
  });
  await admin.api('/admin/roles', 'POST', {
    userId: receiver.user.id,
    contestId: c1.id,
    grant: false,
  });
  await status(receiver, `/contests/${c1.id}/statistics`, 'GET', undefined, 403);
  await status(receiver, `${invitationPath(waiting)}/accept`, 'POST', {}, 400);
  const replay = await receiver.api(`${invitationPath(role)}/accept`, 'POST', {});
  assert.equal(replay.alreadyAccepted, true);
  assert.equal(replay.authorizationActive, false);
  assert.equal(replay.redirectPath, '/account');
  assert.equal(await db.roleAssignment.count({ where: { userId: receiver.user.id } }), 0);
  record(
    'revocation is immediate, cancels pending links, and replaying a used link cannot restore permissions',
  );

  const expired = await invite({ kind: 'SYSTEM_ADMIN', userId: receiver.user.id });
  await db.invitation.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await status(receiver, invitationPath(expired), 'GET', undefined, 400);
  await status(receiver, `${invitationPath(expired)}/accept`, 'POST', {}, 400);
  const revoked = await invite({ kind: 'SYSTEM_ADMIN', userId: receiver.user.id });
  await status(receiver, `/invitations/${revoked.id}`, 'DELETE', undefined, 403);
  await admin.api(`/invitations/${revoked.id}`, 'DELETE');
  await status(receiver, `${invitationPath(revoked)}/accept`, 'POST', {}, 400);
  record(
    'expired and withdrawn invitations are unusable; recipients cannot manage administrator invitations',
  );

  const idem = randomUUID();
  const idemBody = { kind: 'ACCOUNT' as const, userId: receiver.user.id };
  const [same1, same2] = await Promise.all([
    invite(idemBody, admin, idem),
    invite(idemBody, admin, idem),
  ]);
  assert.equal(same1.id, same2.id);
  assert.equal(same1.url, same2.url);
  const stored = await db.invitation.findUniqueOrThrow({ where: { id: same1.id } });
  assert.equal(stored.tokenHash, createHash('sha256').update(invitationToken(same1)).digest('hex'));
  const listing = await admin.api('/admin/invitations');
  assert.equal(listing.find((i: any) => i.id === same1.id).state, 'PENDING');
  assert.ok(
    !JSON.stringify(listing).includes(invitationToken(same1)) &&
      !JSON.stringify(listing).includes('tokenHash'),
  );
  assert.ok(
    !JSON.stringify(await db.auditEvent.findMany({ where: { resourceId: same1.id } })).includes(
      invitationToken(same1),
    ),
  );
  record(
    'invitation creation is idempotent; database, list and audit never reveal raw invitation tokens',
  );

  const deletedContest = await contest();
  const deleted = await invite({
    kind: 'CONTEST_ADMIN',
    userId: receiver.user.id,
    contestId: deletedContest.id,
  });
  await db.contest.delete({ where: { id: deletedContest.id } });
  await status(receiver, invitationPath(deleted), 'GET', undefined, 400);
  await status(receiver, `${invitationPath(deleted)}/accept`, 'POST', {}, 400);
  record('deleted competition cannot be authorized');

  const teacherProfile = {
    version: coach.user.version,
    name: coach.user.name,
    profile: coach.user.profile,
    isCoach: true,
  };
  await status(coach, '/auth/profile', 'PUT', teacherProfile, 403);
  const teacherInvite = await admin.api('/admin/roles', 'POST', {
    userId: coach.user.id,
    isCoach: true,
  });
  invitationIds.push(teacherInvite.id);
  assert.equal((await refresh(coach)).isCoach, false);
  await coach.api(`${invitationPath(teacherInvite)}/accept`, 'POST', {});
  assert.equal((await refresh(coach)).isCoach, true);
  record(
    'teacher identity requires explicit invitation confirmation; profile cannot self-grant roles',
  );

  const adminInvite = await invite({ kind: 'SYSTEM_ADMIN', userId: issuer.user.id });
  assert.equal((await refresh(issuer)).isAdmin, false);
  await issuer.api(`${invitationPath(adminInvite)}/accept`, 'POST', {});
  assert.equal((await refresh(issuer)).isAdmin, true);
  await issuer.api('/admin/users');
  const issued = await invite(
    { kind: 'CONTEST_ADMIN', userId: wrong.user.id, contestId: c2.id },
    issuer,
  );
  await admin.api('/admin/roles', 'POST', { userId: issuer.user.id, isAdmin: false });
  await status(issuer, '/admin/users', 'GET', undefined, 403);
  await status(wrong, `${invitationPath(issued)}/accept`, 'POST', {}, 400);
  const restore = await invite({ kind: 'SYSTEM_ADMIN', userId: issuer.user.id });
  await issuer.api(`${invitationPath(restore)}/accept`, 'POST', {});
  await status(wrong, `${invitationPath(issued)}/accept`, 'POST', {}, 400);
  await admin.api('/admin/roles', 'POST', { userId: issuer.user.id, isAdmin: false });
  await status(admin, '/admin/roles', 'POST', { userId: admin.user.id, isAdmin: false }, 400);
  record(
    'system administrator confirms before granting; revoked issuer links cannot revive after reauthorization',
  );

  const email = `invite-${run}-signup@example.test`;
  const accountInvitation = await invite({ kind: 'ACCOUNT', targetEmail: email.toUpperCase() });
  const signupCoach = await invite({ kind: 'COACH_ROLE', targetEmail: email });
  const signup = new Client();
  const session = await signup.api('/auth/register', 'POST', {
    username: `invited_${run}`,
    email,
    name: '邀请注册验收',
    password: 'InvitedAccount2026!',
    next: new URL(accountInvitation.url).pathname,
  });
  signup.user = session.user;
  signup.csrf = session.csrf;
  userIds.push(session.user.id);
  await signup.api(invitationPath(accountInvitation));
  await status(signup, `${invitationPath(accountInvitation)}/accept`, 'POST', {}, 403);
  await status(signup, `${invitationPath(signupCoach)}/accept`, 'POST', {}, 403);
  await status(signup, '/auth/resend', 'POST', { next: 'https://example.test/' }, 400);
  await signup.api('/auth/resend', 'POST', { next: new URL(accountInvitation.url).pathname });
  const verification = await verificationUrl(email, new URL(accountInvitation.url).pathname);
  assert.ok(verification);
  assert.equal(verification.searchParams.get('next'), new URL(accountInvitation.url).pathname);
  await signup.api('/auth/verify', 'POST', { token: verification.searchParams.get('token') });
  await signup.api(`${invitationPath(accountInvitation)}/accept`, 'POST', {});
  assert.equal((await refresh(signup)).isAdmin, false);
  assert.equal(signup.user.isCoach, false);
  assert.deepEqual(signup.user.contestIds, []);
  await signup.api(`${invitationPath(signupCoach)}/accept`, 'POST', {});
  assert.equal((await refresh(signup)).isCoach, true);
  record(
    'new account invitation supports public signup, Mailpit verification, safe return URL and later role acceptance',
  );

  const publicSignup = new Client();
  const publicSession = await publicSignup.api('/auth/register', 'POST', {
    username: `public_${run}`,
    email: `public-${run}@example.test`,
    name: '公开邮箱注册验收',
    password: 'PublicAccount2026!',
  });
  userIds.push(publicSession.user.id);
  assert.equal(publicSession.user.isAdmin, false);
  assert.equal(publicSession.user.isCoach, false);
  assert.equal(publicSession.user.verified, false);
  record('public email registration remains open without an invitation and grants no extra role');

  const teamContest = await contest({
    mode: 'TEAM',
    minMembers: 1,
    maxMembers: 4,
    memberMode: 'INVITE',
    coachMode: 'REQUIRED',
    manualReview: false,
  });
  let team = await registration(receiver, teamContest.id);
  const memberLink = await association(receiver, team.id, 'MEMBER');
  const race = await Promise.all(
    [member1, member2].map((c) => c.raw(`/api/v1${invitationPath(memberLink)}/accept`, 'POST', {})),
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  const winner = race[0]!.ok ? member1 : member2;
  const winnerRetry = await winner.api(`${invitationPath(memberLink)}/accept`, 'POST', {});
  assert.equal(winnerRetry.registrationId, team.id);
  assert.equal(await db.registrationPerson.count({ where: { registrationId: team.id } }), 2);
  const duplicateMember = await association(receiver, team.id, 'MEMBER');
  await status(winner, `${invitationPath(duplicateMember)}/accept`, 'POST', {}, 409);
  record(
    'existing member links remain single-use under competing accounts and do not duplicate members',
  );

  const coachLink = await association(coach, undefined, 'COACH_LINK');
  await receiver.api(`${invitationPath(coachLink)}/accept`, 'POST', { registrationId: team.id });
  team = await receiver.api(`/registrations/${team.id}`);
  team = await coach.api(`/registrations/${team.id}`, 'PUT', {
    version: team.version,
    teamName: '老师关联链接团队',
    teamEnglishName: 'Invitation team',
    answers: team.answers,
    people: team.people,
  });
  team = await coach.api(`/registrations/${team.id}/submit`, 'POST', { version: team.version });
  assert.equal(team.eligible, true);
  const another = await registration(wrong, c2.id);
  const pendingAssociation = await association(coach, undefined, 'COACH_LINK');
  const pendingCoachRole = await invite({ kind: 'COACH_ROLE', userId: coach.user.id });
  await admin.api('/admin/roles', 'POST', { userId: coach.user.id, isCoach: false });
  assert.equal((await refresh(coach)).isCoach, false);
  await status(coach, `/registrations/${team.id}`, 'GET', undefined, 403);
  assert.equal(await db.registrationCoach.count({ where: { userId: coach.user.id } }), 0);
  team = await receiver.api(`/registrations/${team.id}`);
  assert.equal(team.eligible, false);
  assert.equal(team.status, 'CORRECTION');
  await status(
    wrong,
    `${invitationPath(pendingAssociation)}/accept`,
    'POST',
    { registrationId: another.id },
    400,
  );
  await status(coach, `${invitationPath(pendingCoachRole)}/accept`, 'POST', {}, 400);
  await coach.api(`${invitationPath(teacherInvite)}/accept`, 'POST', {});
  assert.equal((await refresh(coach)).isCoach, false);
  record(
    'teacher role revocation immediately removes access, association, eligibility and all pending teacher links',
  );

  const coachRestore = await invite({ kind: 'COACH_ROLE', userId: coach.user.id });
  await coach.api(`${invitationPath(coachRestore)}/accept`, 'POST', {});
  for (let iteration = 0; iteration < 3; iteration++) {
    if (!(await refresh(coach)).isCoach) {
      const restoreRole = await invite({ kind: 'COACH_ROLE', userId: coach.user.id });
      await coach.api(`${invitationPath(restoreRole)}/accept`, 'POST', {});
    }
    const racingLink = await association(coach, undefined, 'COACH_LINK');
    const responses = await Promise.all([
      wrong.raw(`/api/v1${invitationPath(racingLink)}/accept`, 'POST', {
        registrationId: another.id,
      }),
      admin.raw('/api/v1/admin/roles', 'POST', { userId: coach.user.id, isCoach: false }),
    ]);
    assert.equal(responses[1]!.status, 201);
    assert.ok([201, 400, 403].includes(responses[0]!.status));
    assert.equal(await db.registrationCoach.count({ where: { userId: coach.user.id } }), 0);
    await status(coach, `/registrations/${another.id}`, 'GET', undefined, 403);
  }
  record('concurrent teacher association and role revocation cannot leave residual access');
  passed = true;
  console.log(`Authorization invitation acceptance: ${report.length} checks passed`);
} finally {
  const resources = [...userIds, ...registrationIds];
  if (resources.length) {
    await until(
      () => db.outboxEvent.count({ where: { resourceId: { in: resources }, deliveredAt: null } }),
      (n) => n === 0,
      30000,
    ).catch(() => undefined);
    await db.invitation.deleteMany({ where: { id: { in: invitationIds } } });
    await db.registration.deleteMany({ where: { id: { in: registrationIds } } });
    await db.contest.deleteMany({ where: { id: { in: contestIds } } });
    await db.emailToken.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/invitations.json',
    JSON.stringify(
      { passed, report, durationMs: Date.now() - started, checkedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  await redis.quit();
  await db.$disconnect();
}
