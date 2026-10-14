import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from './client.js';
import { registrationProof } from './registration-proof.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { sha } from '../../apps/server/src/security.js';
import { config } from '../../apps/server/src/config.js';
import { policySchema } from '../../packages/contracts/src/index.js';

if (config.production) throw new Error('Acceptance fixtures are development-only');
const run = randomUUID().slice(0, 8),
  checks: string[] = [];
async function resetRate() {
  await redis.del(
    ...['127.0.0.1', '::ffff:127.0.0.1'].flatMap((ip) => [
      `rate:register:${ip}`,
      `rate:register-code:${ip}`,
      `rate:login:${ip}`,
    ]),
  );
}
function passed(message: string) {
  checks.push(message);
  console.log(`PASS ${message}`);
}
try {
  await resetRate();
  const anonymous = new Client(),
    email = `prerequisite-${run}@example.test`;
  const signup = {
    email,
    username: `prereq_${run}`,
    name: '邮箱前置验证',
    password: 'AccountFixture2026!',
  };
  assert.equal((await anonymous.raw('/api/v1/auth/register', 'POST', signup)).status, 400);
  assert.equal(await db.user.count({ where: { email } }), 0);
  assert.equal(anonymous.cookie, '');
  const proof = await registrationProof(anonymous, email);
  assert.equal(await db.user.count({ where: { email } }), 0);
  assert.equal(
    (
      await anonymous.raw('/api/v1/auth/register', 'POST', {
        ...signup,
        ...proof,
        email: `other-${email}`,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await anonymous.raw('/api/v1/auth/register', 'POST', {
        ...signup,
        ...proof,
        code: String((Number(proof.code) + 1) % 1000000).padStart(6, '0'),
      })
    ).status,
    400,
  );
  const registered = await anonymous.api('/auth/register', 'POST', { ...signup, ...proof });
  anonymous.user = registered.user;
  anonymous.csrf = registered.csrf;
  assert.equal(registered.user.verified, true);
  assert.equal(
    (
      await new Client().raw('/api/v1/auth/register', 'POST', {
        ...signup,
        ...proof,
        username: `replay_${run}`,
      })
    ).status,
    400,
  );
  passed('邮箱验证是账号创建的前置条件，验证码绑定邮箱且只能使用一次');

  const expiryEmail = `expiry-${run}@example.test`,
    expired = await registrationProof(new Client(), expiryEmail);
  await db.registrationVerification.update({
    where: { id: sha(expired.token) },
    data: { expiresAt: new Date(0) },
  });
  assert.equal(
    (
      await new Client().raw('/api/v1/auth/register', 'POST', {
        ...signup,
        ...expired,
        email: expiryEmail,
      })
    ).status,
    400,
  );
  const refreshed = await registrationProof(new Client(), expiryEmail);
  assert.equal(
    (
      await new Client().raw('/api/v1/auth/register', 'POST', {
        ...signup,
        ...expired,
        email: expiryEmail,
      })
    ).status,
    400,
  );
  const attempts = await Promise.all(
    [1, 2].map(() =>
      new Client().raw('/api/v1/auth/register', 'POST', {
        ...signup,
        ...refreshed,
        email: expiryEmail,
        username: `concurrent_${run}`,
      }),
    ),
  );
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 400]);
  assert.equal(await db.user.count({ where: { email: expiryEmail } }), 1);
  passed('过期、重发后的旧验证码和并发重放均不能创建额外账号');

  await resetRate();
  const admin = await new Client().login('admin'),
    manager = await new Client().login('manager');
  const student = new Client(),
    teacher = new Client();
  await student.register({
    email: `student-${run}@example.test`,
    username: `student_${run}`,
    name: '管理测试学生',
    password: signup.password,
    kind: 'STUDENT',
    identifier: `STU-${run}`,
    enrollmentYear: 2026,
  });
  await student.completeProfile();
  await teacher.register({
    email: `teacher-${run}@example.test`,
    username: `teacher_${run}`,
    name: '管理测试教师',
    password: signup.password,
    kind: 'TEACHER',
    identifier: `TEA-${run}`,
    employedAt: '2020-09-01',
  });
  teacher.user = await teacher.api('/auth/profile', 'PUT', {
    version: teacher.user.version,
    name: teacher.user.name,
    profile: { ...teacher.user.profile, college: '教师院系', gender: '女' },
  });
  const contest = await admin.api('/contests', 'POST', {
    title: `账号管理回归 ${run}`,
    season: '回归',
    description: '虚构数据',
    opensAt: new Date(Date.now() - 10000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'OPTIONAL' }),
    fields: [],
  });
  let registration = await student.api('/registrations', 'POST', { contestId: contest.id });
  registration = await student.api(`/registrations/${registration.id}/submit`, 'POST', {
    version: registration.version,
  });
  await db.registrationCoach.create({
    data: { userId: teacher.user.id, registrationId: registration.id },
  });
  const grant = await admin.api('/admin/grants', 'POST', {
    userId: manager.user.id,
    level: 'CONTEST',
    contestId: contest.id,
    permissions: ['VIEW', 'STUDENTS'],
  });
  const teacherDetail = await admin.api(`/admin/teachers/${teacher.user.id}`);
  assert.ok(teacherDetail.registrations.some((row: any) => row.id === registration.id));
  assert.equal(
    (await admin.api(`/admin/teachers?page=1&pageSize=20&search=${teacher.user.email}`)).items[0]
      .participationCount,
    1,
  );
  assert.equal((await manager.api(`/admin/teachers/${teacher.user.id}`)).canEdit, false);
  assert.equal(
    (await manager.raw(`/api/v1/admin/users/${student.user.id}`, 'PUT', {})).status,
    403,
  );
  assert.equal(
    (await student.raw(`/api/v1/admin/users/${teacher.user.id}`, 'DELETE', {})).status,
    403,
  );
  await admin.api(`/admin/grants/${grant.id}`, 'DELETE');
  assert.equal((await manager.raw(`/api/v1/admin/teachers/${teacher.user.id}`)).status, 403);
  passed('教师视图统计指导记录，并保持竞赛授权范围及账号操作权限');

  const identity = await student.api('/auth/identity', 'POST', {
    kind: 'STUDENT',
    name: student.user.name,
    profile: { ...student.user.profile, enrollment_year: 2026 },
    version: student.user.version,
  });
  await admin.api(`/admin/identities/${identity.id}/review`, 'POST', { decision: 'APPROVED' });
  const detail = await admin.api(`/admin/students/${student.user.id}`);
  const edited = await admin.api(`/admin/users/${detail.id}`, 'PUT', {
    ...detail,
    name: '管理员修改姓名',
    profile: { ...detail.profile, college: '管理员修改院系', student_id: `UPDATED-${run}` },
  });
  assert.equal(edited.name, '管理员修改姓名');
  assert.equal(
    (await db.personRecord.findUniqueOrThrow({ where: { id: edited.personId } })).identifier,
    `UPDATED-${run}`,
  );
  assert.equal((await admin.raw(`/api/v1/admin/users/${detail.id}`, 'PUT', detail)).status, 409);
  passed('管理员可修改实名资料，身份档案同步更新并阻止过期版本覆盖');

  const banned = await admin.api(`/admin/users/${edited.id}/ban`, 'PUT', {
    version: edited.version,
    banned: true,
    reason: '封禁回归',
  });
  assert.equal((await student.api('/auth/me')).user, null);
  assert.equal(
    (
      await new Client().raw('/api/v1/auth/login', 'POST', {
        account: student.user.email,
        password: signup.password,
      })
    ).status,
    403,
  );
  const unbanned = await admin.api(`/admin/users/${edited.id}/ban`, 'PUT', {
    version: banned.version,
    banned: false,
  });
  await student.login(student.user.email, signup.password);
  assert.equal(student.user.name, '管理员修改姓名');
  passed('封禁立即撤销已有会话并拒绝新登录，解除后可以重新登录');

  const temporarySystem = await admin.api('/admin/grants', 'POST', {
    userId: teacher.user.id,
    level: 'SYSTEM',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await teacher.login(teacher.user.email, signup.password);
  const adminDetail = await teacher.api(`/admin/users/${admin.user.id}`);
  assert.equal(
    (
      await teacher.raw(`/api/v1/admin/users/${admin.user.id}/ban`, 'PUT', {
        version: adminDetail.version,
        banned: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await teacher.raw(`/api/v1/admin/users/${admin.user.id}`, 'DELETE', {
        version: adminDetail.version,
        confirmation: '删除账号',
      })
    ).status,
    400,
  );
  await admin.api(`/admin/grants/${temporarySystem.id}`, 'DELETE');
  passed('最后一名永久系统管理员不能被封禁或删除');

  await admin.api(`/admin/users/${edited.id}`, 'DELETE', {
    version: unbanned.version,
    confirmation: '删除账号',
  });
  assert.equal((await student.api('/auth/me')).user, null);
  assert.equal(
    (
      await new Client().raw('/api/v1/auth/login', 'POST', {
        account: student.user.username,
        password: signup.password,
      })
    ).status,
    401,
  );
  assert.equal(await db.user.count({ where: { email: student.user.email } }), 0);
  assert.equal(
    (await db.registration.findUniqueOrThrow({ where: { id: registration.id } })).ownerId,
    edited.id,
  );
  assert.equal(await db.adminGrant.count({ where: { userId: edited.id, revokedAt: null } }), 0);
  assert.equal(
    (await admin.api(`/admin/students?page=1&pageSize=20&search=${student.user.email}`)).total,
    0,
  );
  const retained = await admin.api(`/registrations/${registration.id}`);
  assert.equal(retained.id, registration.id);
  assert.equal(
    await db.auditEvent.count({
      where: { actorId: admin.user.id, resourceId: edited.id, action: 'ACCOUNT_DELETE' },
    }),
    1,
  );
  passed('删除释放邮箱、撤销登录与权限，管理员仍可查看保留的参赛历史和操作日志');
  await resetRate();
  const replacement = new Client();
  await replacement.register({
    email: student.user.email,
    username: student.user.username,
    name: edited.name,
    password: signup.password,
    kind: 'STUDENT',
    identifier: edited.profile.student_id,
    enrollmentYear: 2026,
  });
  const request = await replacement.api('/auth/identity', 'POST', {
    kind: 'STUDENT',
    name: replacement.user.name,
    profile: edited.profile,
    version: replacement.user.version,
  });
  assert.equal((await replacement.raw(`/api/v1/registrations/${registration.id}`)).status, 403);
  await admin.api(`/admin/identities/${request.id}/review`, 'POST', { decision: 'APPROVED' });
  assert.equal((await replacement.api(`/registrations/${registration.id}`)).id, registration.id);
  assert.equal((await replacement.api('/auth/me')).user.isAdmin, false);
  passed('已删除邮箱可重新注册，同身份仅在实名审核通过后恢复历史访问');
} finally {
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile('.runtime/reports/account-management.json', JSON.stringify({ checks }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
