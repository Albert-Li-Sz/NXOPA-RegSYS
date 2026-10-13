import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Principal } from '@contest-center/contracts';
import { db, enqueue, audit } from './db.js';
import { getRegistration, getSupportTicket, manages, owns } from './security.js';
import { rateLimit } from './auth.js';
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
    const ticket = await db.supportTicket.findUnique({ where: { id } });
    if (ticket) {
      await getSupportTicket(u, ticket.id);
      return u.isAdmin || manages(u, ticket.contestId ?? '', 'SUPPORT');
    }
    const identity = await db.identityRequest.findUnique({ where: { id } });
    if (identity && (owns(u, identity.userId) || u.isAdmin)) return u.isAdmin;
    throw new ForbiddenException('没有邮件状态的访问权限');
  }
  async list(u: Principal, id: string) {
    const manager = await this.access(u, id);
    const [jobs, events] = await Promise.all([
      db.job.findMany({
        where: { kind: 'MAIL', resourceId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      db.outboxEvent.findMany({
        where: { type: 'MAIL', resourceId: id, deliveredAt: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
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
    return [...events.map((x) => view(x, 'OUTBOX')), ...jobs.map((x) => view(x, x.state))];
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
      const next = await enqueue(tx, 'MAIL', job.resourceId, `mail-retry:${randomUUID()}`, payload);
      await audit(tx, u.id, 'MAIL_RETRY', job.id, { nextJobId: next.id });
      return { jobId: next.id };
    });
  }
}
