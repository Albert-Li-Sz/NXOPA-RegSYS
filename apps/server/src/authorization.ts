import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { adminPermissions, type Principal } from '@contest-center/contracts';
import { db, audit, lock, type Tx } from './db.js';
import { requireAdmin, requireSystemAdmin } from './security.js';

export const activeGrantWhere = () => ({
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
});
export async function effectiveAuthorization(id: string, database: Tx = db) {
  const grants = await database.adminGrant.findMany({
    where: { userId: id, ...activeGrantWhere(), user: { deactivatedAt: null, bannedAt: null } },
    orderBy: { createdAt: 'asc' },
  });
  const isSystemAdmin = grants.some((g) => g.level === 'SYSTEM');
  const isSeniorAdmin = grants.some((g) => g.level === 'SENIOR');
  const permissions: Record<string, string[]> = {};
  for (const grant of grants)
    if (grant.level === 'CONTEST' && grant.contestId)
      permissions[grant.contestId] = [
        ...new Set([...(permissions[grant.contestId] ?? []), ...grant.permissions]),
      ];
  return {
    isAdmin: isSystemAdmin || isSeniorAdmin,
    isSystemAdmin,
    isSeniorAdmin,
    adminLevel: isSystemAdmin
      ? ('SYSTEM' as const)
      : isSeniorAdmin
        ? ('SENIOR' as const)
        : grants.length
          ? ('CONTEST' as const)
          : null,
    contestIds: Object.keys(permissions),
    permissions,
    grants: grants.map((g) => ({
      id: g.id,
      level: g.level,
      contestId: g.contestId,
      permissions: g.permissions,
      expiresAt: g.expiresAt?.toISOString() ?? null,
    })),
  };
}
export async function ensurePermanentAdministrator(
  tx: Tx,
  excludedGrant?: string,
  excludedUser?: string,
) {
  if (
    !(await tx.adminGrant.count({
      where: {
        level: 'SYSTEM',
        expiresAt: null,
        revokedAt: null,
        ...(excludedGrant ? { id: { not: excludedGrant } } : {}),
        ...(excludedUser ? { userId: { not: excludedUser } } : {}),
        user: { deactivatedAt: null, bannedAt: null },
      },
    }))
  )
    throw new BadRequestException('必须保留至少一名永久授权的系统管理员');
}
export async function revokeIssuedAuthorizationInvitations(tx: Tx, userId: string) {
  const authority = await effectiveAuthorization(userId, tx);
  if (!authority.isSystemAdmin) {
    await tx.apiToken.updateMany({
      where: { createdBy: userId, revoked: false },
      data: { revoked: true },
    });
    await tx.webhook.updateMany({
      where: { privateApprovedBy: userId },
      data: { enabled: false, privateApprovedBy: null, version: { increment: 1 } },
    });
  }
  const kinds = !authority.isAdmin
    ? ['ACCOUNT', 'SYSTEM_ADMIN', 'SENIOR_ADMIN', 'CONTEST_ADMIN', 'COACH_ROLE']
    : !authority.isSystemAdmin
      ? ['SYSTEM_ADMIN', 'SENIOR_ADMIN']
      : [];
  if (kinds.length)
    await tx.invitation.updateMany({
      where: { inviterId: userId, acceptedBy: null, revoked: false, kind: { in: kinds } },
      data: { revoked: true },
    });
}
export async function revokeRecipientInvitations(
  tx: Tx,
  userId: string,
  extra: Record<string, unknown> = {},
) {
  const account = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  await tx.invitation.updateMany({
    where: {
      ...extra,
      OR: [{ targetUserId: userId }, { targetEmail: account.email.toLowerCase() }],
      acceptedBy: null,
    },
    data: { revoked: true },
  });
}
export class AuthorizationService {
  async resign(u: Principal, id: string) {
    return db.$transaction(async (tx) => {
      await lock(tx, 'role-authorizations');
      const grant = await tx.adminGrant.findFirst({
        where: { id: z.string().uuid().parse(id), userId: u.id },
      });
      if (!grant) throw new ForbiddenException();
      if (grant.level === 'SYSTEM' && !grant.revokedAt)
        await ensurePermanentAdministrator(tx, undefined, grant.userId);
      await tx.adminGrant.updateMany({
        where: {
          userId: grant.userId,
          level: grant.level,
          contestId: grant.contestId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await tx.user.update({ where: { id: u.id }, data: { version: { increment: 1 } } });
      await revokeRecipientInvitations(tx, u.id, {
        kind:
          grant.level === 'SYSTEM'
            ? 'SYSTEM_ADMIN'
            : grant.level === 'SENIOR'
              ? 'SENIOR_ADMIN'
              : 'CONTEST_ADMIN',
        ...(grant.contestId ? { contestId: grant.contestId } : {}),
      });
      await revokeIssuedAuthorizationInvitations(tx, u.id);
      await audit(tx, u.id, 'ADMIN_GRANT_RESIGN', id);
      return { ok: true };
    });
  }
  async list(u: Principal, userId?: string) {
    requireAdmin(u);
    return db.adminGrant.findMany({
      where: userId ? { userId: z.string().uuid().parse(userId) } : {},
      include: { user: { select: { id: true, name: true, email: true, kind: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
  async grant(u: Principal, body: unknown) {
    requireAdmin(u);
    const b = z
      .object({
        userId: z.string().uuid(),
        level: z.enum(['SYSTEM', 'SENIOR', 'CONTEST']),
        contestId: z.string().uuid().nullable().optional(),
        permissions: z.array(z.enum(adminPermissions)).default([...adminPermissions]),
        expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
      })
      .parse(body);
    if (b.level !== 'CONTEST') requireSystemAdmin(u);
    if ((b.level === 'CONTEST') !== !!b.contestId)
      throw new BadRequestException('竞赛管理员必须指定竞赛，全局授权不指定竞赛');
    if (b.expiresAt && new Date(b.expiresAt) <= new Date())
      throw new BadRequestException('授权到期时间必须在未来');
    return db.$transaction(async (tx) => {
      await lock(tx, 'role-authorizations');
      const actor = await effectiveAuthorization(u.id, tx);
      if (!actor.isAdmin || (b.level !== 'CONTEST' && !actor.isSystemAdmin))
        throw new ForbiddenException('授权权限已经失效');
      const target = await tx.user.findUniqueOrThrow({ where: { id: b.userId } });
      if (target.deactivatedAt || target.bannedAt)
        throw new BadRequestException('已停用或封禁账号不能接受授权');
      if (b.contestId) await tx.contest.findUniqueOrThrow({ where: { id: b.contestId } });
      if (
        await tx.adminGrant.findFirst({
          where: {
            userId: b.userId,
            level: b.level,
            contestId: b.contestId ?? null,
            ...activeGrantWhere(),
          },
        })
      )
        throw new BadRequestException('此账号已有同一范围的有效授权，请先撤销原授权');
      const result = await tx.adminGrant.create({
        data: {
          userId: b.userId,
          level: b.level,
          contestId: b.contestId,
          permissions:
            b.level === 'CONTEST'
              ? [...new Set(['VIEW', ...b.permissions])]
              : [...adminPermissions],
          expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
          grantedBy: u.id,
        },
      });
      await tx.user.update({ where: { id: b.userId }, data: { version: { increment: 1 } } });
      await audit(tx, u.id, 'ADMIN_GRANT', result.id, {
        userId: b.userId,
        level: b.level,
        contestId: b.contestId,
        expiresAt: b.expiresAt,
        permissions: result.permissions,
      });
      return result;
    });
  }
  async revoke(u: Principal, id: string) {
    requireAdmin(u);
    return db.$transaction(async (tx) => {
      await lock(tx, 'role-authorizations');
      const grant = await tx.adminGrant.findUniqueOrThrow({
        where: { id: z.string().uuid().parse(id) },
      });
      const actor = await effectiveAuthorization(u.id, tx);
      if (!actor.isAdmin || (grant.level !== 'CONTEST' && !actor.isSystemAdmin))
        throw new ForbiddenException();
      if (grant.level === 'SYSTEM' && !grant.revokedAt)
        await ensurePermanentAdministrator(tx, undefined, grant.userId);
      await tx.adminGrant.updateMany({
        where: {
          userId: grant.userId,
          level: grant.level,
          contestId: grant.contestId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await tx.user.update({ where: { id: grant.userId }, data: { version: { increment: 1 } } });
      await revokeRecipientInvitations(tx, grant.userId, {
        kind:
          grant.level === 'SYSTEM'
            ? 'SYSTEM_ADMIN'
            : grant.level === 'SENIOR'
              ? 'SENIOR_ADMIN'
              : 'CONTEST_ADMIN',
        ...(grant.contestId ? { contestId: grant.contestId } : {}),
      });
      await revokeIssuedAuthorizationInvitations(tx, grant.userId);
      await audit(tx, u.id, 'ADMIN_GRANT_REVOKE', id);
      return { ok: true };
    });
  }
}
