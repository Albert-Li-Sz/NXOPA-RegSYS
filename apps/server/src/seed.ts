import { hash, argon2id } from 'argon2';
import {
  defaultFields,
  policySchema,
  fieldsJsonSchema,
  defaultTemplate,
  defaultSite,
} from '@contest-center/contracts';
import { db, json } from './db.js';
import { config } from './config.js';
if (config.production || process.env.NODE_ENV !== 'development')
  throw new Error('Demo seed is restricted to NODE_ENV=development');
const users = [
  ['admin', '系统管理员', true, false],
  ['manager', '竞赛管理员', false, false],
  ['teacher', '示例老师', false, true],
  ['alice', '林同学', false, false],
  ['bob', '陈同学', false, false],
  ['carol', '许同学', false, false],
] as const;
for (const [username, name, isAdmin, isCoach] of users) {
  const seeded = await db.user.upsert({
    where: { username },
    create: {
      username,
      name,
      isAdmin,
      isCoach,
      email: `${username}@example.test`,
      verified: true,
      passwordHash: await hash('DemoContest2026!', { type: argon2id }),
      profile: {
        school: '示例大学',
        student_id: `DEMO-${username}`,
        class_name: '计算机 2026 级 1 班',
        college: '信息工程学院',
        gender: '不便透露',
        major: '计算机科学与技术',
        phone: '00000000000',
        size: 'L',
      },
    },
    update: {},
  });
  if (
    isAdmin &&
    !(await db.adminGrant.count({
      where: { userId: seeded.id, level: 'SYSTEM', revokedAt: null, expiresAt: null },
    }))
  )
    await db.adminGrant.create({
      data: { userId: seeded.id, level: 'SYSTEM', grantedBy: seeded.id },
    });
}
const now = Date.now(),
  day = 86400000;
const competitions = [
  [
    '11111111-1111-4111-8111-111111111111',
    '2026 全国大学生程序设计竞赛 · 秋季个人赛',
    'INDIVIDUAL',
    'INVITE',
    'FREE',
    0,
    'OPTIONAL',
    1,
    -2,
    20,
    true,
    'REVIEW_FIRST',
  ],
  [
    '22222222-2222-4222-8222-222222222222',
    '2026 区域程序设计邀请赛 · 团队赛',
    'TEAM',
    'INVITE',
    'FREE',
    0,
    'REQUIRED',
    3,
    -3,
    25,
    true,
    'REVIEW_FIRST',
  ],
  [
    '33333333-3333-4333-8333-333333333333',
    '2026 高校算法挑战赛 · 现场赛',
    'TEAM',
    'MANUAL',
    'FIXED',
    150000,
    'OPTIONAL',
    3,
    -5,
    18,
    true,
    'REVIEW_FIRST',
  ],
  [
    '44444444-4444-4444-8444-444444444444',
    '2026 青年算法公开赛 · 冬季赛',
    'INDIVIDUAL',
    'INVITE',
    'FREE',
    0,
    'DISABLED',
    1,
    10,
    40,
    true,
    'REVIEW_FIRST',
  ],
  [
    '55555555-5555-4555-8555-555555555555',
    '2026 城市程序设计竞赛 · 春季赛',
    'TEAM',
    'MANUAL',
    'FREE',
    0,
    'OPTIONAL',
    3,
    -50,
    -20,
    true,
    'REVIEW_FIRST',
  ],
  [
    '66666666-6666-4666-8666-666666666666',
    '2026 算法练习赛 · 个人公开赛',
    'INDIVIDUAL',
    'INVITE',
    'FIXED',
    5000,
    'DISABLED',
    1,
    -1,
    30,
    false,
    'PAYMENT_FIRST',
  ],
] as const;
for (const [
  id,
  title,
  mode,
  memberMode,
  feeMode,
  feeCents,
  coachMode,
  n,
  open,
  close,
  manualReview,
  paymentSequence,
] of competitions) {
  const policy = policySchema.parse({
    mode,
    memberMode,
    minMembers: n,
    maxMembers: n,
    coachMode,
    maxCoaches: coachMode === 'DISABLED' ? 0 : 1,
    feeMode,
    feeCents,
    manualReview,
    paymentSequence,
    paymentInstructions: '线下缴费后，请上传真实收款凭证。演示环境不提供实际收款账户。',
  });
  await db.contest.upsert({
    where: { id },
    create: {
      id,
      title,
      season: '2026',
      description:
        '欢迎参加本次程序设计竞赛。请仔细阅读竞赛要求，准确填写报名资料。\n报名审核、财务与准考证进度均可在本站查看。',
      announcement: '请以本页面公布的报名规则和时间安排为准。',
      location: '示例大学 · 计算机实验中心',
      opensAt: new Date(now + open * day),
      closesAt: new Date(now + close * day),
      startsAt: new Date(now + (close + 5) * day),
      published: true,
      policy: json(policy),
      forms: {
        create: {
          version: 1,
          fields: json(defaultFields),
          schema: json(fieldsJsonSchema(defaultFields, 'PERSON')),
        },
      },
    },
    update: {},
  });
  const manager = await db.user.findUniqueOrThrow({ where: { username: 'manager' } });
  await db.roleAssignment.upsert({
    where: { userId_contestId: { userId: manager.id, contestId: id } },
    create: { userId: manager.id, contestId: id },
    update: {},
  });
  if (
    !(await db.adminGrant.count({
      where: { userId: manager.id, level: 'CONTEST', contestId: id, revokedAt: null },
    }))
  )
    await db.adminGrant.create({
      data: {
        userId: manager.id,
        level: 'CONTEST',
        contestId: id,
        grantedBy: manager.id,
        permissions: [
          'VIEW',
          'CONTEST',
          'REGISTRATIONS',
          'FINANCE',
          'ADMISSIONS',
          'FILES',
          'SUPPORT',
          'STUDENTS',
          'INTEGRATIONS',
        ],
      },
    });
}
if (!(await db.admissionTemplate.count()))
  await db.admissionTemplate.create({
    data: { name: '默认中文准考证', source: defaultTemplate, version: 1 },
  });
await db.setting.upsert({
  where: { key: 'site' },
  create: {
    key: 'site',
    value: defaultSite,
  },
  update: {},
});
for (const f of defaultFields)
  await db.fieldDefinition.upsert({
    where: { key: f.key },
    create: { key: f.key, definition: json(f) },
    update: {},
  });
console.log(
  'Development demo ready: admin, manager, teacher, alice, bob, carol @example.test. See README for the local-only demo password.',
);
await db.$disconnect();
