import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { Invitation } from '@prisma/client';
import {
  accountInvitationKinds,
  accountInvitationLabels,
  accountInvitationSchema,
  type Principal,
} from '@contest-center/contracts';
import { db, audit, lock, type Tx } from './db.js';
import { opaqueToken, requireAdmin, sha } from './security.js';
import { publicLink } from './site-settings.js';
import { pageOptions, dateFilter, type ListQuery } from './pagination.js';
import { RegistrationService, dirty, loaded } from './registrations.js';

const isAccountInvitation = (kind: string): kind is (typeof accountInvitationKinds)[number] =>
  accountInvitationKinds.some((value) => value === kind);
const roleLock = (tx: Tx) => lock(tx, 'role-authorizations');
async function currentAdmin(tx: Tx, u: Principal) {
  requireAdmin(u);
  const actor = await tx.user.findUnique({ where: { id: u.id } });
  if (!actor?.isAdmin) throw new ForbiddenException('系统管理员权限已被撤销');
}
function available(invitation: Invitation | null): asserts invitation is Invitation {
  if (!invitation || invitation.revoked || invitation.expiresAt <= new Date())
    throw new BadRequestException('邀请已失效或被撤销');
}
function recipient(invitation: Invitation, u: Principal) {
  if (
    (invitation.targetUserId && invitation.targetUserId !== u.id) ||
    (invitation.targetEmail && invitation.targetEmail !== u.email.toLowerCase())
  )
    throw new ForbiddenException('此邀请仅限指定账号接受，请使用受邀账号登录');
  if (invitation.acceptedBy && invitation.acceptedBy !== u.id)
    throw new ConflictException('邀请已被其他账号接受');
}
function destination(kind: string) {
  return kind === 'COACH_ROLE' ? '/coach' : kind === 'ACCOUNT' ? '/account' : '/admin';
}
async function authorizationActive(tx: Tx, i: Invitation, userId: string) {
  const receiver = await tx.user.findUnique({ where: { id: userId } });
  if (!receiver) return false;
  if (i.kind === 'SYSTEM_ADMIN') return receiver.isAdmin;
  if (i.kind === 'COACH_ROLE') return receiver.isCoach;
  if (i.kind === 'CONTEST_ADMIN')
    return (
      !!i.contestId &&
      !!(await tx.roleAssignment.findUnique({
        where: { userId_contestId: { userId, contestId: i.contestId } },
      }))
    );
  return receiver.verified;
}
export class InvitationService {
  constructor(@Inject(RegistrationService) private readonly registrations: RegistrationService) {}

  async create(u: Principal, body: unknown) {
    requireAdmin(u);
    const b = accountInvitationSchema.parse(body);
    return db.$transaction(async (tx) => {
      await roleLock(tx);
      await currentAdmin(tx, u);
      const target = b.userId
        ? await tx.user.findUnique({ where: { id: b.userId } })
        : await tx.user.findUnique({ where: { email: b.targetEmail!.toLowerCase() } });
      if (b.userId && !target) throw new NotFoundException('受邀账号不存在');
      if (target && b.targetEmail && target.email !== b.targetEmail.toLowerCase())
        throw new BadRequestException('受邀账号与邮箱不一致');
      const targetEmail = target?.email ?? b.targetEmail!.toLowerCase();
      if (b.contestId && !(await tx.contest.findUnique({ where: { id: b.contestId } })))
        throw new NotFoundException('竞赛不存在');
      const raw = opaqueToken();
      const invitation = await tx.invitation.create({
        data: {
          kind: b.kind,
          tokenHash: sha(raw),
          inviterId: u.id,
          targetUserId: target?.id,
          targetEmail,
          contestId: b.contestId,
          expiresAt: new Date(Date.now() + b.expiresInDays * 86400000),
        },
      });
      await audit(tx, u.id, 'AUTHORIZATION_INVITE_CREATE', invitation.id, {
        kind: b.kind,
        targetUserId: target?.id,
        targetEmail,
        contestId: b.contestId,
        expiresAt: invitation.expiresAt,
      });
      return {
        id: invitation.id,
        kind: b.kind,
        url: await publicLink(`/invite/${raw}`),
        expiresAt: invitation.expiresAt,
      };
    });
  }

  async list(u: Principal, query: ListQuery = {}) {
    requireAdmin(u);
    const p = pageOptions(query);
    const now = new Date();
    const state = query.status;
    const where = {
      kind: { in: [...accountInvitationKinds] },
      ...(query.search
        ? { targetEmail: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
      createdAt: dateFilter(query),
      ...(state === 'REVOKED'
        ? { revoked: true }
        : state === 'ACCEPTED'
          ? { revoked: false, acceptedBy: { not: null } }
          : state === 'EXPIRED'
            ? { revoked: false, acceptedBy: null, expiresAt: { lte: now } }
            : state === 'PENDING'
              ? { revoked: false, acceptedBy: null, expiresAt: { gt: now } }
              : {}),
    };
    const records = await db.invitation.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: p?.take ?? 500,
      skip: p?.skip,
    });
    const ids = [
      ...new Set(
        records.flatMap((i) =>
          [i.inviterId, i.targetUserId, i.acceptedBy].filter((id): id is string => !!id),
        ),
      ),
    ];
    const [users, contests] = await Promise.all([
      db.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true },
      }),
      db.contest.findMany({
        where: { id: { in: records.flatMap((i) => (i.contestId ? [i.contestId] : [])) } },
        select: { id: true, title: true },
      }),
    ]);
    const items = records.map((i) => ({
      id: i.id,
      kind: i.kind,
      targetEmail: i.targetEmail,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      acceptedAt: i.acceptedAt,
      inviter: users.find((user) => user.id === i.inviterId),
      target: users.find((user) => user.id === i.targetUserId),
      acceptedBy: users.find((user) => user.id === i.acceptedBy),
      contest: contests.find((contest) => contest.id === i.contestId),
      state: i.revoked
        ? 'REVOKED'
        : i.acceptedBy
          ? 'ACCEPTED'
          : i.expiresAt <= new Date()
            ? 'EXPIRED'
            : 'PENDING',
    }));
    return p
      ? { items, total: await db.invitation.count({ where }), page: p.page, pageSize: p.pageSize }
      : items;
  }

  async preview(u: Principal, token: string) {
    const i = await db.invitation.findUnique({ where: { tokenHash: sha(token) } });
    available(i);
    if (!isAccountInvitation(i.kind)) return this.registrations.invitation(u, token);
    recipient(i, u);
    const inviter = await db.user.findUnique({
      where: { id: i.inviterId },
      select: { name: true, isAdmin: true },
    });
    if (!inviter?.isAdmin && !i.acceptedBy) throw new BadRequestException('邀请人的授权权限已失效');
    const contest = i.contestId
      ? await db.contest.findUnique({
          where: { id: i.contestId },
          select: { id: true, title: true },
        })
      : null;
    if (i.kind === 'CONTEST_ADMIN' && !contest) throw new BadRequestException('受邀竞赛已不存在');
    const active = !i.acceptedBy || (await authorizationActive(db, i, u.id));
    return {
      id: i.id,
      kind: i.kind,
      roleLabel: accountInvitationLabels[i.kind],
      targetEmail: i.targetEmail,
      inviter: { name: inviter?.name ?? '管理员' },
      contest,
      expiresAt: i.expiresAt,
      accepted: i.acceptedBy === u.id,
      acceptedAt: i.acceptedAt,
      authorizationActive: active,
      redirectPath: active ? destination(i.kind) : '/account',
    };
  }

  async accept(u: Principal, token: string, body: unknown) {
    const record = await db.invitation.findUnique({ where: { tokenHash: sha(token) } });
    available(record);
    if (!isAccountInvitation(record.kind)) return this.registrations.accept(u, token, body);
    return db.$transaction(async (tx) => {
      await roleLock(tx);
      await lock(tx, `invitation:${record.id}`);
      const i = await tx.invitation.findUnique({ where: { id: record.id } });
      available(i);
      recipient(i, u);
      const receiver = await tx.user.findUnique({ where: { id: u.id } });
      if (!receiver?.verified) throw new ForbiddenException('请先验证邮箱，再确认授权邀请');
      if (receiver.email !== i.targetEmail)
        throw new ForbiddenException('受邀邮箱已改变，请管理员重新生成邀请');
      const result = { ok: true, kind: i.kind, redirectPath: destination(i.kind) };
      if (i.acceptedBy) {
        const active = await authorizationActive(tx, i, u.id);
        return {
          ...result,
          authorizationActive: active,
          redirectPath: active ? result.redirectPath : '/account',
          alreadyAccepted: true,
        };
      }
      const inviter = await tx.user.findUnique({ where: { id: i.inviterId } });
      if (!inviter?.isAdmin) throw new BadRequestException('邀请人的授权权限已失效');
      if (i.kind === 'SYSTEM_ADMIN')
        await tx.user.update({
          where: { id: u.id },
          data: { isAdmin: true, version: { increment: 1 } },
        });
      if (i.kind === 'COACH_ROLE')
        await tx.user.update({
          where: { id: u.id },
          data: { isCoach: true, version: { increment: 1 } },
        });
      if (i.kind === 'CONTEST_ADMIN') {
        if (!i.contestId || !(await tx.contest.findUnique({ where: { id: i.contestId } })))
          throw new BadRequestException('受邀竞赛已不存在');
        await tx.roleAssignment.upsert({
          where: { userId_contestId: { userId: u.id, contestId: i.contestId } },
          create: { userId: u.id, contestId: i.contestId },
          update: {},
        });
        await tx.user.update({ where: { id: u.id }, data: { version: { increment: 1 } } });
      }
      await tx.invitation.update({
        where: { id: i.id },
        data: { acceptedBy: u.id, acceptedAt: new Date() },
      });
      await audit(tx, u.id, 'AUTHORIZATION_INVITE_ACCEPT', i.id, {
        kind: i.kind,
        contestId: i.contestId,
        inviterId: i.inviterId,
      });
      return { ...result, authorizationActive: true, alreadyAccepted: false };
    });
  }

  async revoke(u: Principal, id: string) {
    const record = await db.invitation.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('邀请不存在');
    if (!isAccountInvitation(record.kind)) return this.registrations.revokeInvite(u, id);
    requireAdmin(u);
    return db.$transaction(async (tx) => {
      await roleLock(tx);
      await currentAdmin(tx, u);
      await lock(tx, `invitation:${id}`);
      const i = await tx.invitation.findUniqueOrThrow({ where: { id } });
      if (i.acceptedBy) throw new ConflictException('邀请已接受，请在用户权限中撤销已授予的身份');
      await tx.invitation.update({ where: { id }, data: { revoked: true } });
      await audit(tx, u.id, 'AUTHORIZATION_INVITE_REVOKE', id);
      return { ok: true };
    });
  }

  async role(u: Principal, body: unknown) {
    requireAdmin(u);
    const b = z
      .object({
        userId: z.string().uuid(),
        contestId: z.string().uuid().optional(),
        isAdmin: z.boolean().optional(),
        isCoach: z.boolean().optional(),
        grant: z.boolean().optional(),
      })
      .parse(body);
    if (
      Number(b.contestId !== undefined) +
        Number(b.isAdmin !== undefined) +
        Number(b.isCoach !== undefined) !==
      1
    )
      throw new BadRequestException('每次操作请选择一个授权身份');
    const kind = b.contestId
      ? 'CONTEST_ADMIN'
      : b.isCoach !== undefined
        ? 'COACH_ROLE'
        : 'SYSTEM_ADMIN';
    const grants = b.contestId ? b.grant !== false : (b.isCoach ?? b.isAdmin);
    if (grants) return this.create(u, { kind, userId: b.userId, contestId: b.contestId });
    return db.$transaction(async (tx) => {
      await roleLock(tx);
      await currentAdmin(tx, u);
      const target = await tx.user.findUniqueOrThrow({ where: { id: b.userId } });
      if (kind === 'SYSTEM_ADMIN' && b.userId === u.id)
        throw new BadRequestException('不能移除自己的系统管理员身份');
      if (kind === 'SYSTEM_ADMIN')
        await tx.user.update({
          where: { id: b.userId },
          data: { isAdmin: false, version: { increment: 1 } },
        });
      if (kind === 'CONTEST_ADMIN') {
        await tx.roleAssignment.deleteMany({ where: { userId: b.userId, contestId: b.contestId } });
        await tx.user.update({ where: { id: b.userId }, data: { version: { increment: 1 } } });
      }
      if (kind === 'COACH_ROLE') {
        await tx.user.update({
          where: { id: b.userId },
          data: { isCoach: false, version: { increment: 1 } },
        });
        const links = await tx.registrationCoach.findMany({
          where: { userId: b.userId },
          orderBy: { registrationId: 'asc' },
        });
        for (const link of links) {
          await lock(tx, link.registrationId);
          const registration = await loaded(tx, link.registrationId);
          await tx.registrationCoach.deleteMany({
            where: { registrationId: link.registrationId, userId: b.userId },
          });
          await dirty(tx, registration, u, 'COACH_ROLE_REVOKE');
        }
        await tx.invitation.updateMany({
          where: { kind: 'COACH_LINK', coachId: b.userId, acceptedBy: null },
          data: { revoked: true },
        });
      }
      await tx.invitation.updateMany({
        where: {
          kind,
          ...(b.contestId ? { contestId: b.contestId } : {}),
          acceptedBy: null,
          OR: [{ targetUserId: b.userId }, { targetEmail: target.email }],
        },
        data: { revoked: true },
      });
      if (kind === 'SYSTEM_ADMIN')
        await tx.invitation.updateMany({
          where: {
            inviterId: b.userId,
            kind: { in: [...accountInvitationKinds] },
            acceptedBy: null,
          },
          data: { revoked: true },
        });
      await audit(tx, u.id, 'ROLE_REVOKE', b.userId, { kind, contestId: b.contestId });
      return { ok: true };
    });
  }
}
