import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { mailpitBase } from './mailpit.js';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { migrateProfileFields } from '../../apps/server/src/profile-data.js';
import { seedInstitutions } from '../../apps/server/src/institutions.js';
import {
  defaultFields,
  policySchema,
  maximumEnrollmentYear,
} from '../../packages/contracts/src/index.js';
if (process.env.NXOPA_ISOLATED_TEST_DATABASE !== '1')
  throw new Error('Disposable test database required');
const checks: string[] = [],
  run = Date.now(),
  password = 'ProfileFixture2026!';
const pass = (name: string) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  const admin = await new Client().login('admin');
  const owner = new Client();
  await owner.register({
    username: `profile_${run}`,
    name: '资料验收',
    email: `profile-${run}@example.test`,
    password,
  });
  const first = await owner.api('/institutions');
  assert.ok(first.total >= 1412);
  assert.equal(first.items.length, 50);
  const official = await owner.api(`/institutions?search=${encodeURIComponent('南京晓庄学院')}`);
  assert.equal(official.items[0].name, '南京晓庄学院');
  assert.equal((await new Client().raw('/api/v1/institutions')).status, 401);
  assert.equal((await owner.raw('/api/v1/admin/institutions')).status, 403);
  assert.equal(
    (await owner.raw('/api/v1/admin/institutions', 'POST', { name: '越权单位' })).status,
    403,
  );
  pass(
    'Official directory is complete, bounded, searchable and administration is permission checked',
  );
  const custom = await admin.api('/admin/institutions', 'POST', {
    name: `测试研究所 ${run}`,
    aliases: [`研究别名${run}`],
    shortName: '研究所',
  });
  assert.equal(
    (await owner.api(`/institutions?search=${encodeURIComponent(custom.aliases[0])}`)).items[0].id,
    custom.id,
  );
  assert.equal(
    (await admin.raw('/api/v1/admin/institutions', 'POST', { name: `  测试研究所 ${run}  ` }))
      .status,
    409,
  );
  const disabled = await admin.api(`/admin/institutions/${custom.id}`, 'PUT', {
    ...custom,
    enabled: false,
  });
  assert.equal(
    (await owner.api(`/institutions?search=${encodeURIComponent(custom.name)}`)).total,
    0,
  );
  assert.equal(
    (await admin.raw(`/api/v1/admin/institutions/${custom.id}`, 'PUT', custom)).status,
    409,
  );
  await seedInstitutions();
  assert.equal(
    (await db.institution.findUniqueOrThrow({ where: { id: custom.id } })).enabled,
    false,
  );
  pass(
    'Custom names and aliases are unique; optimistic edits, disabling and restart-safe seeds preserve admin changes',
  );
  const profile = {
    student_id: `00${run}`,
    class_name: '一班',
    college: '信息学院',
    gender: '男',
    phone: '00000000000',
    school: '南京晓庄学院',
  };
  for (const year of [9999, '大一', 1949, maximumEnrollmentYear() + 1])
    assert.equal(
      (
        await owner.raw('/api/v1/auth/profile', 'PUT', {
          version: owner.user.version,
          name: owner.user.name,
          profile: { ...profile, enrollment_year: year },
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await owner.raw('/api/v1/auth/profile', 'PUT', {
        version: owner.user.version,
        name: owner.user.name,
        profile: { ...profile, school: '未登记的新单位' },
      })
    ).status,
    400,
  );
  owner.user = await owner.api('/auth/profile', 'PUT', {
    version: owner.user.version,
    name: owner.user.name,
    profile: {
      ...profile,
      enrollment_year: `${maximumEnrollmentYear()}级`,
      email: 'fake@example.test',
    },
  });
  assert.equal(owner.user.profile.enrollment_year, maximumEnrollmentYear());
  assert.equal(owner.user.profile.student_id, profile.student_id);
  assert.equal(owner.user.profile.email, undefined);
  pass(
    'Profile writes reject invalid years and unknown new institutions, retain leading zeroes and permit next year',
  );
  await admin.api(`/admin/institutions/${custom.id}`, 'PUT', { ...disabled, enabled: true });
  const c = await admin.api('/contests', 'POST', {
    title: `资料兼容验收 ${run}`,
    description: '资料、目录与邮箱测试',
    season: '2026',
    published: true,
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    policy: policySchema.parse({
      mode: 'TEAM',
      memberMode: 'MANUAL',
      minMembers: 1,
      maxMembers: 5,
      coachMode: 'OPTIONAL',
      manualReview: false,
    }),
    fields: [
      ...defaultFields,
      { key: 'enrollment_year', label: '旧入学年份', type: 'text', scope: 'PERSON' },
      { key: 'email', label: '教练邮箱', type: 'email', scope: 'COACH', required: true },
    ],
  });
  let r = await owner.api('/registrations', 'POST', { contestId: c.id });
  assert.equal(r.people[0].email, owner.user.email);
  assert.equal(r.people[0].answers.email, owner.user.email);
  r.people[0].email = 'forged@example.test';
  r.people[0].answers.email = 'forged@example.test';
  r.people.push({
    name: '手工成员',
    email: `manual-${run}@example.test`,
    captain: false,
    answers: {
      ...profile,
      student_id: `MANUAL-${run}`,
      school: custom.name,
      enrollment_year: '2023年',
    },
  });
  r = await owner.api(`/registrations/${r.id}`, 'PUT', { ...r, teamName: '资料验收队' });
  assert.equal(r.people.find((p: any) => p.userId).email, owner.user.email);
  assert.equal(r.people.find((p: any) => p.userId).answers.email, owner.user.email);
  const manual = r.people.find((p: any) => !p.userId);
  assert.equal(manual.answers.email, manual.email);
  assert.equal(manual.answers.enrollment_year, 2023);
  const ownerAccount = await db.user.findUniqueOrThrow({ where: { id: owner.user.id } });
  const coachAccount = await db.user.create({
    data: {
      username: `coach_profile_${run}`,
      email: `coach-profile-${run}@example.test`,
      name: '邮箱同步教练',
      kind: 'TEACHER',
      isCoach: true,
      verified: true,
      passwordHash: ownerAccount.passwordHash,
      profile: {
        employee_id: `T${run}`,
        employed_at: '2026-01-01',
        college: '信息学院',
        gender: '男',
        school: '南京晓庄学院',
      },
    },
  });
  await db.registrationCoach.create({
    data: { registrationId: r.id, userId: coachAccount.id, answers: { email: coachAccount.email } },
  });
  r = await owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  const view = await owner.api(`/registrations/${r.id}`);
  assert.equal(view.fields.find((f: any) => f.key === 'enrollment_year').type, 'year');
  const csv = await admin.raw(`/api/v1/registrations/export?contestId=${c.id}`);
  assert.equal(csv.status, 200);
  assert.ok(!(await csv.text()).includes('成员·邮箱 (email)'));
  pass(
    'Bound and manual member emails are canonical; year fields, submission snapshots and CSV avoid duplicate email fields',
  );

  const template = await db.admissionTemplate.findFirstOrThrow();
  const document = await db.admissionDocument.create({
    data: {
      registrationId: r.id,
      number: `PROFILE-${run}`,
      location: '',
      templateId: template.id,
      templateVersion: template.version,
      registrationVersion: r.version,
      state: 'RELEASED',
      releasedAt: new Date(),
    },
  });
  const newEmail = `changed-profile-${run}@example.test`;
  owner.user = (await owner.api('/auth/me')).user;
  await owner.api('/auth/reauth', 'POST', { password });
  await owner.api('/auth/profile', 'PUT', {
    version: owner.user.version,
    name: owner.user.name,
    profile: owner.user.profile,
    email: newEmail,
  });
  assert.equal(
    (await owner.api(`/registrations/${r.id}`)).people.find((p: any) => p.userId).email,
    owner.user.email,
  );
  async function mailToken(email: string) {
    return until(
      async () => {
        const search = (await (
          await fetch(`${mailpitBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
        ).json()) as any;
        const id = search.messages?.[0]?.ID;
        if (!id) return '';
        const mail = (await (await fetch(`${mailpitBase}/api/v1/message/${id}`)).json()) as any;
        return String(mail.Text).match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
      },
      Boolean,
      30000,
    );
  }
  await owner.api('/auth/verify', 'POST', { token: await mailToken(newEmail) });
  const afterMail = await owner.api(`/registrations/${r.id}`);
  assert.equal(afterMail.people.find((p: any) => p.userId).email, newEmail);
  assert.equal(afterMail.people.find((p: any) => p.userId).answers.email, newEmail);
  assert.equal(afterMail.snapshot.people.find((p: any) => p.userId).email, newEmail);
  assert.equal(
    (await db.admissionDocument.findUniqueOrThrow({ where: { id: document.id } })).state,
    'STALE',
  );
  assert.equal(afterMail.eligible, r.eligible);
  const coach = await new Client().login(coachAccount.username, password);
  const coachEmail = `changed-${coachAccount.email}`;
  await coach.api('/auth/reauth', 'POST', { password });
  await coach.api('/auth/profile', 'PUT', {
    version: coach.user.version,
    name: coach.user.name,
    profile: coach.user.profile,
    email: coachEmail,
  });
  await coach.api('/auth/verify', 'POST', { token: await mailToken(coachEmail) });
  const afterCoachMail = await owner.api(`/registrations/${r.id}`);
  assert.equal(afterCoachMail.coaches[0].user.email, coachEmail);
  assert.equal(afterCoachMail.coaches[0].answers.email, coachEmail);
  assert.equal(afterCoachMail.snapshot.coaches[0].user.email, coachEmail);
  const coachCsv = await admin.raw(`/api/v1/registrations/export?contestId=${c.id}`);
  const coachCsvText = await coachCsv.text();
  assert.ok(coachCsvText.includes(coachEmail));
  assert.ok(!coachCsvText.includes('老师1·邮箱 (email)'));
  pass(
    'Verified email changes update current registrations and snapshots, invalidate documents and preserve eligibility',
  );

  const legacy = await db.user.create({
    data: {
      email: `legacy-${run}@example.test`,
      username: `legacy_${run}`,
      name: '旧年份',
      profile: { ...profile, enrollment_year: '9999', untouched: true },
    },
  });
  const record = await db.personRecord.create({
    data: {
      identityKey: randomUUID(),
      kind: 'STUDENT',
      identifier: '00042',
      institution: '旧单位',
      data: { profile: { enrollment_year: '2023级', student_id: '00042' } },
    },
  });
  await db.registrationPerson.update({
    where: { id: manual.id },
    data: { answers: json({ ...manual.answers, enrollment_year: '不合理年份' }) },
  });
  const auditBefore = await db.registrationRevision.findMany({ where: { registrationId: r.id } });
  await db.setting.delete({ where: { key: 'migration:profile-fields-v2' } });
  await migrateProfileFields();
  assert.deepEqual((await db.user.findUniqueOrThrow({ where: { id: legacy.id } })).profile, {
    ...profile,
    untouched: true,
  });
  assert.equal(
    ((await db.personRecord.findUniqueOrThrow({ where: { id: record.id } })).data as any).profile
      .enrollment_year,
    2023,
  );
  assert.equal(
    ((await db.registrationPerson.findUniqueOrThrow({ where: { id: manual.id } })).answers as any)
      .enrollment_year,
    undefined,
  );
  assert.deepEqual(
    await db.registrationRevision.findMany({ where: { registrationId: r.id } }),
    auditBefore,
  );
  const current = await db.registration.findUniqueOrThrow({ where: { id: r.id } });
  await migrateProfileFields();
  assert.equal(
    (await db.registration.findUniqueOrThrow({ where: { id: r.id } })).version,
    current.version,
  );
  pass(
    'Upgrade cleanup clears unreasonable live years, normalizes valid legacy years, preserves audit revisions and is idempotent',
  );
} finally {
  await writeFile('.runtime/reports/profile-fields.json', JSON.stringify({ checks }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
