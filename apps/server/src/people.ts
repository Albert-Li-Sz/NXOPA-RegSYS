import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { verify } from 'argon2';
import { randomUUID } from 'node:crypto';
import { profileComplete, type Principal } from '@contest-center/contracts';
import { db, lock, audit, event, json } from './db.js';
import { requireAdmin, manages, ownerIds, sha } from './security.js';
import { activeGrantWhere, ensurePermanentAdministrator } from './authorization.js';
import { paginated, type ListQuery } from './pagination.js';
const identityKeys = [
  'student_id',
  'employee_id',
  'class_name',
  'college',
  'school',
  'enrollment_year',
  'employed_at',
  'gender',
];
export function identitySnapshot(kind: string, name: string, profile: Record<string, unknown>) {
  return {
    kind,
    name,
    profile: Object.fromEntries(
      identityKeys.filter((k) => profile[k] !== undefined).map((k) => [k, profile[k]]),
    ),
  };
}
function identityKey(data: ReturnType<typeof identitySnapshot>) {
  const identifier = String(
    data.profile[data.kind === 'TEACHER' ? 'employee_id' : 'student_id'] ?? '',
  ).trim();
  if (!identifier) throw new BadRequestException('请填写学号或工号');
  const institution =
    String(data.profile.school ?? '')
      .trim()
      .toLowerCase() || 'default';
  return {
    key: sha(`${data.kind}:${institution}:${identifier.toLowerCase()}`),
    identifier,
    institution,
  };
}
export class PeopleService {
  async requests(u: Principal, query: ListQuery = {}) {
    requireAdmin(u);
    const where = { ...(query.status ? { status: query.status } : {}) };
    return paginated(
      query,
      (options) =>
        db.identityRequest.findMany({
          where,
          ...options,
          include: { user: { select: { id: true, name: true, email: true, kind: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      () => db.identityRequest.count({ where }),
    );
  }
  async identity(u: Principal) {
    return {
      status: u.identityStatus,
      data: identitySnapshot(u.kind ?? 'STUDENT', u.name, u.profile),
      requests: await db.identityRequest.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    };
  }
  async submitIdentity(u: Principal, body: unknown) {
    const b = z
      .object({
        kind: z.enum(['STUDENT', 'TEACHER']),
        name: z.string().trim().min(1).max(100),
        profile: z.record(z.string(), z.json()),
        version: z.number().int(),
      })
      .parse(body);
    if (!profileComplete(b))
      throw new BadRequestException('请完善姓名、院系、性别及学号 / 班级，教师填写工号与入职日期');
    if (
      b.profile.enrollment_year !== undefined &&
      (!Number.isInteger(Number(b.profile.enrollment_year)) ||
        Number(b.profile.enrollment_year) < 1950 ||
        Number(b.profile.enrollment_year) > new Date().getFullYear() + 1)
    )
      throw new BadRequestException('入学年份无效');
    if (b.kind === 'STUDENT' && b.profile.enrollment_year === undefined)
      throw new BadRequestException('请填写入学年份');
    if (b.kind === 'STUDENT') b.profile.enrollment_year = Number(b.profile.enrollment_year);
    const proposed = identitySnapshot(b.kind, b.name, b.profile);
    identityKey(proposed);
    return db.$transaction(async (tx) => {
      await lock(tx, `auth:${u.id}`);
      const current = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
      if (current.version !== b.version) throw new BadRequestException('资料已更新，请刷新');
      if (await tx.identityRequest.count({ where: { userId: u.id, status: 'PENDING' } }))
        throw new BadRequestException('已有待审核申请，请等待管理员处理');
      const request = await tx.identityRequest.create({
        data: { userId: u.id, data: json(proposed) },
      });
      if (current.identityStatus === 'UNSUBMITTED')
        await tx.user.update({
          where: { id: u.id },
          data: {
            name: b.name,
            kind: b.kind,
            profile: json({ ...(current.profile as object), ...proposed.profile }),
            identityStatus: 'PENDING',
            version: { increment: 1 },
          },
        });
      await audit(tx, u.id, 'IDENTITY_SUBMIT', request.id);
      const administrators = await tx.user.findMany({
        where: {
          verified: true,
          deactivatedAt: null,
          grants: { some: { level: { in: ['SYSTEM', 'SENIOR'] }, ...activeGrantWhere() } },
        },
        select: { email: true },
      });
      for (const admin of administrators)
        await event(tx, 'MAIL', request.id, {
          to: admin.email,
          subject: '实名资料待审核',
          text: `${u.name} 提交了实名资料申请`,
          category: 'IDENTITY',
          actionPath: '/admin?tab=identities',
        });
      return request;
    });
  }
  async reviewIdentity(u: Principal, id: string, body: unknown) {
    requireAdmin(u);
    const b = z
      .object({
        decision: z.enum(['APPROVED', 'REJECTED']),
        reason: z.string().trim().max(2000).default(''),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, `identity:${id}`);
      const request = await tx.identityRequest.findUniqueOrThrow({ where: { id } });
      if (request.status !== 'PENDING') throw new BadRequestException('此申请已经处理');
      await lock(tx, `auth:${request.userId}`);
      const target = await tx.user.findUniqueOrThrow({ where: { id: request.userId } });
      if (target.deactivatedAt) throw new BadRequestException('此账号已经注销');
      const data = request.data as unknown as ReturnType<typeof identitySnapshot>;
      if (b.decision === 'APPROVED') {
        const identity = identityKey(data);
        await lock(tx, `person:${identity.key}`);
        let person = await tx.personRecord.findUnique({ where: { identityKey: identity.key } });
        if (
          person &&
          (await tx.user.count({
            where: { personId: person.id, deactivatedAt: null, id: { not: target.id } },
          }))
        )
          throw new BadRequestException('此学号 / 工号已关联有效账号，不能合并');
        if (!person)
          person = await tx.personRecord.create({
            data: {
              identityKey: identity.key,
              identifier: identity.identifier,
              institution: identity.institution,
              kind: data.kind,
              data: json(data),
            },
          });
        else await tx.personRecord.update({ where: { id: person.id }, data: { data: json(data) } });
        await tx.user.update({
          where: { id: target.id },
          data: {
            personId: person.id,
            name: data.name,
            kind: data.kind,
            profile: json({ ...(target.profile as object), ...data.profile }),
            identityStatus: 'VERIFIED',
            version: { increment: 1 },
          },
        });
      }
      if (b.decision === 'REJECTED' && target.identityStatus === 'PENDING')
        await tx.user.update({
          where: { id: target.id },
          data: { identityStatus: 'REJECTED', version: { increment: 1 } },
        });
      const result = await tx.identityRequest.update({
        where: { id },
        data: { status: b.decision, reason: b.reason, reviewedBy: u.id, reviewedAt: new Date() },
      });
      await event(tx, 'MAIL', id, {
        to: target.email,
        subject: '实名资料审核结果',
        text: `${b.decision === 'APPROVED' ? '实名资料审核通过' : '实名资料未通过'}${b.reason ? `：${b.reason}` : ''}`,
        category: 'IDENTITY',
        actionPath: '/me/profile?tab=identity',
      });
      await audit(tx, u.id, 'IDENTITY_REVIEW', id, { decision: b.decision, reason: b.reason });
      return result;
    });
  }
  async close(u: Principal, body: unknown, confirmCode: () => Promise<void>) {
    const b = z
      .object({
        confirmation: z.literal('注销账号'),
        password: z.string().max(128).optional(),
        code: z.string().optional(),
      })
      .parse(body);
    const current = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    if (b.password) {
      if (!current.passwordHash || !(await verify(current.passwordHash, b.password)))
        throw new ForbiddenException('密码错误');
    } else await confirmCode();
    return db.$transaction(async (tx) => {
      await lock(tx, 'role-authorizations');
      await lock(tx, `auth:${u.id}`);
      if (
        await tx.adminGrant.count({
          where: { userId: u.id, level: 'SYSTEM', ...activeGrantWhere() },
        })
      )
        await ensurePermanentAdministrator(tx, undefined, u.id);
      let personId = current.personId;
      if (!personId && profileComplete(current)) {
        const data = identitySnapshot(
            current.kind,
            current.name,
            current.profile as Record<string, unknown>,
          ),
          identity = identityKey(data);
        await lock(tx, `person:${identity.key}`);
        let person = await tx.personRecord.findUnique({ where: { identityKey: identity.key } });
        if (!person)
          person = await tx.personRecord.create({
            data: {
              identityKey: identity.key,
              identifier: identity.identifier,
              institution: identity.institution,
              kind: current.kind,
              data: json(data),
            },
          });
        if (
          !(await tx.user.count({
            where: { personId: person.id, deactivatedAt: null, id: { not: u.id } },
          }))
        )
          personId = person.id;
      }
      await tx.session.deleteMany({ where: { userId: u.id } });
      await tx.externalIdentity.deleteMany({ where: { userId: u.id } });
      await tx.emailToken.updateMany({
        where: { userId: u.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.adminGrant.updateMany({
        where: { userId: u.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.roleAssignment.deleteMany({ where: { userId: u.id } });
      await tx.invitation.updateMany({
        where: { OR: [{ inviterId: u.id }, { targetUserId: u.id }], acceptedBy: null },
        data: { revoked: true },
      });
      await tx.identityRequest.updateMany({
        where: { userId: u.id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      await tx.outboxEvent.updateMany({
        where: {
          type: 'MAIL',
          payload: { path: ['to'], equals: current.email },
          deliveredAt: null,
        },
        data: { deliveredAt: new Date() },
      });
      await tx.job.updateMany({
        where: {
          kind: 'MAIL',
          payload: { path: ['to'], equals: current.email },
          state: { in: ['OUTBOX', 'PENDING', 'FAILED'] },
        },
        data: { state: 'CANCELLED' },
      });
      await tx.user.update({
        where: { id: u.id },
        data: {
          personId,
          deactivatedAt: new Date(),
          previousEmailHash: sha(current.email),
          email: `deleted-${u.id}@account.invalid`,
          username: `deleted_${u.id}`,
          passwordHash: null,
          verified: false,
          isAdmin: false,
          isCoach: false,
          avatarAttachmentId: null,
          version: { increment: 1 },
        },
      });
      await audit(tx, u.id, 'ACCOUNT_CLOSE', u.id, { personId, recordsRetained: true });
      return { ok: true };
    });
  }
  private accessibleContests(u: Principal) {
    if (u.isAdmin) return undefined;
    const ids = u.contestIds.filter((id) => manages(u, id, 'STUDENTS'));
    if (!ids.length) throw new ForbiddenException('没有学生视图权限');
    return ids;
  }
  async students(u: Principal, query: ListQuery & { year?: string } = {}) {
    const contests = this.accessibleContests(u);
    const year = query.year
      ? z.coerce
          .number()
          .int()
          .min(1950)
          .max(new Date().getFullYear() + 1)
          .parse(query.year)
      : undefined;
    const registrations = contests
      ? await db.registration.findMany({
          where: { contestId: { in: contests } },
          include: { people: true },
        })
      : undefined;
    let scoped = registrations
      ? [
          ...new Set(
            registrations.flatMap((r) => [
              r.ownerId,
              ...r.people.flatMap((p) => (p.userId ? [p.userId] : [])),
            ]),
          ),
        ]
      : undefined;
    if (scoped) {
      const people = await db.user.findMany({
        where: { id: { in: scoped }, personId: { not: null } },
        select: { personId: true },
      });
      const associated = await db.user.findMany({
        where: { personId: { in: people.flatMap((p) => (p.personId ? [p.personId] : [])) } },
        select: { id: true },
      });
      scoped = [...new Set([...scoped, ...associated.map((p) => p.id)])];
    }
    const where = {
      kind: 'STUDENT',
      deactivatedAt: null,
      ...(scoped ? { id: { in: scoped } } : {}),
      ...(year
        ? {
            AND: [
              {
                OR: [
                  { profile: { path: ['enrollment_year'], equals: year } },
                  { profile: { path: ['enrollment_year'], equals: String(year) } },
                ],
              },
            ],
          }
        : {}),
      ...(query.search
        ? {
            OR: ['name', 'email'].map((key) => ({
              [key]: { contains: query.search, mode: 'insensitive' as const },
            })),
          }
        : {}),
    };
    const result = await paginated(
      query,
      (options) =>
        db.user.findMany({
          where,
          ...options,
          select: {
            id: true,
            name: true,
            email: true,
            profile: true,
            personId: true,
            createdAt: true,
            identityStatus: true,
            tags: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      () => db.user.count({ where }),
    );
    const rows = Array.isArray(result) ? result : result.items;
    const allUsers = await db.user.findMany({
      where: {
        OR: [
          { id: { in: rows.map((r) => r.id) } },
          { personId: { in: rows.flatMap((r) => (r.personId ? [r.personId] : [])) } },
        ],
      },
      select: { id: true, personId: true },
    });
    const ids = allUsers.map((r) => r.id);
    const history = await db.registration.findMany({
      where: {
        submittedAt: { not: null },
        ...(contests ? { contestId: { in: contests } } : {}),
        OR: [{ ownerId: { in: ids } }, { people: { some: { userId: { in: ids } } } }],
      },
      include: { people: true },
    });
    const items = rows.map((row) => {
      const associated = allUsers
        .filter((x) => x.id === row.id || (row.personId && x.personId === row.personId))
        .map((x) => x.id);
      const entries = history.filter(
        (r) =>
          associated.includes(r.ownerId) ||
          r.people.some((p) => p.userId && associated.includes(p.userId)),
      );
      return {
        ...row,
        participationCount: entries.length,
        unofficialCount: entries.filter((r) => r.participationType === 'UNOFFICIAL').length,
      };
    });
    return Array.isArray(result) ? items : { ...result, items };
  }
  async studentDetail(u: Principal, id: string) {
    const contests = this.accessibleContests(u);
    const target = await db.user.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        kind: true,
        profile: true,
        personId: true,
        createdAt: true,
        identityStatus: true,
        tags: true,
      },
    });
    if (target.kind !== 'STUDENT') throw new BadRequestException('此账号不是学生');
    const ids = target.personId
      ? (
          await db.user.findMany({ where: { personId: target.personId }, select: { id: true } })
        ).map((x) => x.id)
      : [id];
    const registrations = await db.registration.findMany({
      where: {
        ...(contests ? { contestId: { in: contests } } : {}),
        OR: [{ ownerId: { in: ids } }, { people: { some: { userId: { in: ids } } } }],
      },
      include: { contest: { select: { id: true, title: true, startsAt: true } }, people: true },
      orderBy: { createdAt: 'desc' },
    });
    if (contests && !registrations.length) throw new ForbiddenException('该学生不在授权竞赛范围');
    return { ...target, registrations };
  }
}
