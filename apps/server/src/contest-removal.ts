import { BadRequestException, NotFoundException } from '@nestjs/common';
import { contestDeletionSchema, type Principal } from '@contest-center/contracts';
import { db, audit, lock } from './db.js';
import { requireAdmin, checkVersion } from './security.js';
import { effectiveAuthorization } from './authorization.js';

export function contestDeletionAccess(
  u: Principal | undefined,
  counts: { registrations: number; financeAccounts: number },
) {
  const reason = !u?.isAdmin
    ? '仅系统管理员或高级管理员可删除活动'
    : counts.registrations
      ? `仍有 ${counts.registrations} 条报名（含草稿），请先处理报名`
      : counts.financeAccounts
        ? `仍有 ${counts.financeAccounts} 个财务账户，需保留账目，不能删除活动`
        : '';
  return { allowed: !reason, reason };
}

export async function removeContest(u: Principal, id: string, body: unknown) {
  requireAdmin(u);
  const { version } = contestDeletionSchema.parse(body);
  return db.$transaction(async (tx) => {
    await lock(tx, 'role-authorizations');
    requireAdmin({ ...u, ...(await effectiveAuthorization(u.id, tx)) });
    await lock(tx, id);
    await lock(tx, `seating:${id}`);
    await lock(tx, `template:${id}`);
    const c = await tx.contest.findUnique({
      where: { id },
      include: { _count: { select: { registrations: true, financeAccounts: true } } },
    });
    if (!c) throw new NotFoundException('活动及竞赛不存在或已删除');
    checkVersion(c.version, version);
    const access = contestDeletionAccess(u, c._count);
    if (!access.allowed) throw new BadRequestException(access.reason);
    const resources = [id];
    // Files and independent support tickets still belong to their original owners.
    // Removing public access happens in the same transaction as removing the activity.
    const files = await tx.attachment.updateMany({
      where: { contestId: id },
      data: { contestId: null, public: false },
    });
    const tickets = await tx.supportTicket.updateMany({
      where: { contestId: id },
      data: { contestId: null, version: { increment: 1 } },
    });
    await tx.admissionTemplate.deleteMany({ where: { contestId: id } });
    await tx.adminGrant.updateMany({
      where: { contestId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.invitation.updateMany({
      where: { contestId: id, revoked: false },
      data: { revoked: true },
    });
    await tx.job.updateMany({
      where: {
        OR: [{ resourceId: { in: resources } }, { payload: { path: ['contestId'], equals: id } }],
        kind: { notIn: ['OBJECT_DELETE', 'SPOOL_DELETE', 'MAIL'] },
        state: { in: ['PENDING', 'OUTBOX', 'RUNNING', 'FAILED'] },
      },
      data: { state: 'CANCELLED', error: '活动已删除', payload: {}, result: {} },
    });
    await tx.examRoom.deleteMany({ where: { contestId: id } });
    await tx.contest.delete({ where: { id } });
    await audit(tx, u.id, 'CONTEST_DELETE', id, {
      title: c.title,
      season: c.season,
      retainedFiles: files.count,
      retainedTickets: tickets.count,
      deletedSubmittedCount: c.deletedSubmittedCount,
      deletedCancelledCount: c.deletedCancelledCount,
    });
    return { deleted: true, contestId: id };
  });
}
