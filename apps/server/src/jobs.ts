import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Principal } from '@contest-center/contracts';
import { db, audit, lock } from './db.js';
import { requireSystemAdmin, requireManager, getRegistration } from './security.js';
import { paginated, dateFilter, type ListQuery } from './pagination.js';
export class JobService {
  async jobs(u: Principal, query: ListQuery = {}) {
    if (!u.isAdmin && !u.contestIds.length) throw new ForbiddenException();
    const resourceGroups = u.isAdmin
      ? undefined
      : await Promise.all([
          db.registration.findMany({
            where: { contestId: { in: u.contestIds } },
            select: { id: true },
          }),
          db.financeAccount.findMany({
            where: { contestId: { in: u.contestIds } },
            select: { id: true },
          }),
          db.admissionBatch.findMany({
            where: { contestId: { in: u.contestIds } },
            select: { id: true },
          }),
        ]);
    const resources = resourceGroups
      ? [
          ...new Set([
            ...resourceGroups[0].map((r) => r.id),
            ...resourceGroups[1].map((r) => r.id),
            ...resourceGroups[2].map((r) => r.id),
            ...u.contestIds,
          ]),
        ]
      : undefined;
    const where = {
      AND: [
        ...(resources ? [{ resourceId: { in: resources } }] : []),
        ...(query.search ? [{ resourceId: { contains: query.search } }] : []),
      ],
      ...(query.status ? { state: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      createdAt: dateFilter(query),
    };
    return paginated(
      query,
      async (options) => {
        const rows = await db.job.findMany({
          where,
          select: {
            id: true,
            kind: true,
            resourceId: true,
            state: true,
            attempts: true,
            error: true,
            createdAt: true,
            updatedAt: true,
            payload: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...options,
        });
        const registrations = await db.registration.findMany({
          where: {
            id: { in: rows.filter((j) => j.kind === 'ADMISSION').map((j) => j.resourceId) },
          },
          select: { id: true, contestId: true },
        });
        const contests = new Map(registrations.map((r) => [r.id, r.contestId]));
        return rows.map(({ payload, ...row }) => {
          const permission =
            row.kind === 'ADMISSION'
              ? 'ADMISSIONS'
              : row.kind === 'ADMISSION_BATCH'
                ? 'ADMISSIONS'
                : row.kind === 'ACCOUNT_BACKFILL'
                  ? 'CONTEST'
                  : null;
          const contestId =
            contests.get(row.resourceId) ?? String((payload as any)?.contestId ?? '');
          const allowed = permission
            ? !!(u.isAdmin || u.permissions?.[contestId]?.includes(permission))
            : !!u.isSystemAdmin;
          const authenticationMail =
            row.kind === 'MAIL' &&
            (String((payload as any)?.category ?? '').startsWith('AUTH_') ||
              (payload as any)?.category === 'ACCOUNT_CLOSE');
          return {
            ...row,
            error: allowed ? row.error : null,
            canRetry:
              row.state === 'FAILED' &&
              allowed &&
              !authenticationMail &&
              [
                'ADMISSION',
                'ADMISSION_BATCH',
                'ACCOUNT_BACKFILL',
                'MAIL',
                'OBJECT_DELETE',
                'SPOOL_DELETE',
                'STORAGE_MIGRATION',
                'PDF_PREVIEW',
              ].includes(row.kind),
          };
        });
      },
      () => db.job.count({ where }),
      100,
    );
  }
  async retry(u: Principal, id: string) {
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    if (
      ![
        'ADMISSION',
        'ADMISSION_BATCH',
        'ACCOUNT_BACKFILL',
        'MAIL',
        'OBJECT_DELETE',
        'SPOOL_DELETE',
        'STORAGE_MIGRATION',
        'PDF_PREVIEW',
      ].includes(job.kind)
    )
      throw new BadRequestException('此类任务不支持重试');
    if (job.state === 'CANCELLED') throw new BadRequestException('已删除报名的任务不可重试');
    if (job.kind === 'ADMISSION') {
      const r = await getRegistration(u, job.resourceId);
      requireManager(u, r.contestId, 'ADMISSIONS');
    } else if (job.kind === 'ADMISSION_BATCH') {
      requireManager(u, String((job.payload as any).contestId), 'ADMISSIONS');
    } else if (job.kind === 'ACCOUNT_BACKFILL') {
      requireManager(u, String((job.payload as any).contestId), 'CONTEST');
    } else requireSystemAdmin(u);
    if (
      job.kind === 'MAIL' &&
      (String((job.payload as any).category ?? '').startsWith('AUTH_') ||
        (job.payload as any).category === 'ACCOUNT_CLOSE')
    )
      throw new BadRequestException('验证码请在账号页面重新发送');
    if (job.kind === 'MAIL' && !u.isSystemAdmin)
      throw new ForbiddenException('请通过邮件推送页面重发业务通知');
    if (!['FAILED', 'PENDING'].includes(job.state)) throw new BadRequestException('任务不能重试');
    if (job.kind === 'ADMISSION_BATCH') {
      const contestId = String((job.payload as any).contestId);
      return db.$transaction(async (tx) => {
        await lock(tx, `admission-batches:${contestId}`);
        const batch = await tx.admissionBatch.findUniqueOrThrow({ where: { id: job.resourceId } });
        if (batch.expiresAt <= new Date())
          throw new BadRequestException('批次已过期，请重新预览范围');
        if (
          await tx.admissionBatch.count({
            where: { contestId, id: { not: batch.id }, state: { in: ['RUNNING', 'QUEUED'] } },
          })
        )
          throw new BadRequestException('此活动已有准考证批次正在处理');
        const changed = await tx.job.updateMany({
          where: { id, state: { in: ['FAILED', 'PENDING'] }, leaseToken: null },
          data: { state: 'PENDING', error: null, attempts: 0 },
        });
        if (!changed.count) throw new BadRequestException('任务已被领取，请刷新');
        await tx.admissionBatch.update({ where: { id: batch.id }, data: { state: 'QUEUED' } });
        await audit(tx, u.id, 'JOB_RETRY', job.resourceId, { jobId: id, kind: job.kind });
        return { id, state: 'PENDING' };
      });
    }
    const changed = await db.job.updateMany({
      where: { id, state: { in: ['FAILED', 'PENDING'] }, leaseToken: null },
      data: { state: 'PENDING', error: null, attempts: 0 },
    });
    if (!changed.count) throw new BadRequestException('任务已被领取，请刷新');
    await audit(db, u.id, 'JOB_RETRY', job.resourceId, { jobId: id, kind: job.kind });
    return { id, state: 'PENDING' };
  }
}
