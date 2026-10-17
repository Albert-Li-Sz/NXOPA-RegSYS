import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Principal } from '@contest-center/contracts';
import { db, lock, audit } from './db.js';
import { getRegistration, getSupportTicket, manages, owns } from './security.js';
import { getFinance } from './finance-accounts.js';
import { rateLimit } from './auth.js';
import { pageOptions, type ListQuery } from './pagination.js';
const authMail = (payload: any) =>
  String(payload.category ?? '').startsWith('AUTH_') ||
  payload.category === 'ACCOUNT_CLOSE' ||
  String(payload.actionPath ?? '').startsWith('/account/');
export class MailDeliveryService {
  private async access(u: Principal, id: string) {
    if (owns(u, id)) return true;
    const registration = await db.registration.findUnique({ where: { id } });
    if (registration) {
      await getRegistration(u, id);
      return (
        manages(u, registration.contestId, 'REGISTRATIONS') ||
        manages(u, registration.contestId, 'FINANCE') ||
        manages(u, registration.contestId, 'ADMISSIONS')
      );
    }
    if (await db.financeAccount.count({ where: { id } })) {
      const account = await getFinance(u, id);
      return manages(u, account.contestId, 'FINANCE');
    }
    const ticket = await db.supportTicket.findUnique({ where: { id } });
    if (ticket) {
      await getSupportTicket(u, ticket.id);
      return u.isAdmin || manages(u, ticket.contestId ?? '', 'SUPPORT');
    }
    const identity = await db.identityRequest.findUnique({ where: { id } });
    if (identity && (owns(u, identity.userId) || u.isAdmin)) return u.isAdmin;
    throw new ForbiddenException('没有邮件状态的访问权限');
  }
  async list(u: Principal, id: string, query: ListQuery = {}) {
    const manager = await this.access(u, id);
    const p = pageOptions(query);
    const rows = await db.$queryRaw<any[]>`
      SELECT * FROM (
        SELECT id,state,payload,attempts,error,"createdAt",result FROM "Job" WHERE kind='MAIL' AND "resourceId"=${id}
        UNION ALL
        SELECT id,'OUTBOX' AS state,payload,0 AS attempts,NULL AS error,"createdAt",NULL AS result FROM "OutboxEvent" WHERE type='MAIL' AND "resourceId"=${id} AND "deliveredAt" IS NULL
      ) AS notifications ORDER BY "createdAt" DESC,id DESC LIMIT ${p?.take ?? 200} OFFSET ${p?.skip ?? 0}`;
    const view = (item: any, state: string) => {
      const payload = item.payload as any;
      return {
        id: item.id,
        state: (item.result as any)?.skipped ? 'SKIPPED' : state,
        subject: payload.subject,
        to:
          manager || payload.to === u.email
            ? payload.to
            : String(payload.to ?? '').replace(/^(.{1,2}).*(@.*)$/, '$1***$2'),
        attempts: item.attempts ?? 0,
        error: item.error,
        createdAt: item.createdAt,
        canRetry: state === 'FAILED' && !authMail(payload) && (manager || payload.to === u.email),
      };
    };
    const items = rows.map((x) => view(x, x.state));
    if (!p) return items;
    const counts = await Promise.all([
      db.job.count({ where: { kind: 'MAIL', resourceId: id } }),
      db.outboxEvent.count({ where: { type: 'MAIL', resourceId: id, deliveredAt: null } }),
    ]);
    return { items, total: counts[0] + counts[1], page: p.page, pageSize: p.pageSize };
  }
  async retry(u: Principal, id: string) {
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    if (job.kind !== 'MAIL' || job.state !== 'FAILED')
      throw new BadRequestException('仅可重发失败的业务邮件');
    const manager = await this.access(u, job.resourceId),
      payload = job.payload as any;
    if (authMail(payload)) throw new BadRequestException('验证码请在邮箱页面重新发送');
    if (!manager && payload.to !== u.email)
      throw new ForbiddenException('仅可重发发送给本人的邮件');
    await rateLimit(`mail-retry:${u.id}`, 3);
    return db.$transaction(async (tx) => {
      await lock(tx, `mail-retry:${id}`);
      const reset = await tx.job.updateMany({
        where: { id, kind: 'MAIL', state: 'FAILED' },
        data: { state: 'PENDING', attempts: 0, error: null, leaseToken: null, leaseUntil: null },
      });
      if (!reset.count) throw new BadRequestException('邮件已开始重试，请刷新投递状态');
      await audit(tx, u.id, 'MAIL_RETRY', job.id);
      return { jobId: job.id };
    });
  }
}
