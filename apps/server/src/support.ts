import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@contest-center/contracts';
import { db, json, lock, audit, event } from './db.js';
import { paginated, dateFilter, type ListQuery } from './pagination.js';
import { getRegistration, manages, checkVersion } from './security.js';
const message = z.object({
  text: z.string().trim().min(1).max(10000),
  attachments: z.array(z.string().uuid()).max(10).default([]),
});
export class SupportService {
  async list(u: Principal, query: ListQuery = {}) {
    const access = u.isAdmin
      ? {}
      : {
          OR: [
            { ownerId: u.id },
            { contestId: { in: u.contestIds } },
            {
              registrationId: {
                in: (
                  await db.registrationCoach.findMany({
                    where: { userId: u.id },
                    select: { registrationId: true },
                  })
                ).map((c) => c.registrationId),
              },
            },
          ],
        };
    const where = {
      AND: [
        access,
        {
          ...(query.search
            ? { title: { contains: query.search, mode: 'insensitive' as const } }
            : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.contestId ? { contestId: z.string().uuid().parse(query.contestId) } : {}),
          createdAt: dateFilter(query),
        },
      ],
    };
    return paginated(
      query,
      (options) =>
        db.supportTicket.findMany({
          where,
          ...options,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      () => db.supportTicket.count({ where }),
    );
  }
  async access(u: Principal, id: string) {
    const t = await db.supportTicket.findUniqueOrThrow({ where: { id } });
    if (t.ownerId !== u.id && !(t.contestId && manages(u, t.contestId)) && !u.isAdmin) {
      if (!t.registrationId) throw new ForbiddenException();
      await getRegistration(u, t.registrationId);
    }
    return t;
  }
  async detail(u: Principal, id: string) {
    const t = await this.access(u, id);
    const messages = await db.supportMessage.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'asc' },
    });
    const ids = [...new Set(messages.map((m) => m.actorId))];
    const actors = await db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return {
      ...t,
      messages: messages.map((m) => ({ ...m, actor: actors.find((a) => a.id === m.actorId) })),
    };
  }
  async create(u: Principal, body: unknown) {
    const b = z
      .object({
        contestId: z.string().uuid().optional(),
        registrationId: z.string().uuid().optional(),
        title: z.string().min(2).max(200),
        category: z.string().min(1).max(100),
      })
      .extend(message.shape)
      .parse(body);
    if (b.registrationId) {
      const r = await getRegistration(u, b.registrationId);
      if (b.contestId && b.contestId !== r.contestId)
        throw new BadRequestException('竞赛与报名不一致');
      b.contestId = r.contestId;
    }
    return db.$transaction(async (tx) => {
      const t = await tx.supportTicket.create({
        data: {
          ownerId: u.id,
          contestId: b.contestId,
          registrationId: b.registrationId,
          title: b.title,
          category: b.category,
        },
      });
      for (const id of b.attachments) {
        const f = await tx.attachment.findUniqueOrThrow({ where: { id } });
        if (f.ownerId !== u.id || (f.registrationId && f.registrationId !== b.registrationId))
          throw new ForbiddenException('附件不属于此工单');
        await tx.attachment.update({ where: { id }, data: { ticketId: t.id } });
      }
      await tx.supportMessage.create({
        data: { ticketId: t.id, actorId: u.id, text: b.text, attachments: json(b.attachments) },
      });
      await audit(tx, u.id, 'TICKET_CREATE', t.id);
      const administrators = await tx.user.findMany({
        where: {
          verified: true,
          OR: [
            { isAdmin: true },
            ...(t.contestId ? [{ roles: { some: { contestId: t.contestId } } }] : []),
          ],
        },
        select: { email: true },
      });
      for (const a of administrators)
        await event(tx, 'MAIL', t.id, {
          to: a.email,
          subject: '新工单待处理',
          text: t.title,
          actionPath: `/support/${t.id}`,
        });
      return t;
    });
  }
  async reply(u: Principal, id: string, body: unknown) {
    const b = message
      .extend({
        version: z.number().int(),
        status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED']).optional(),
      })
      .parse(body);
    await this.access(u, id);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const t = await tx.supportTicket.findUniqueOrThrow({ where: { id } });
      checkVersion(t.version, b.version);
      const manager = u.isAdmin || (!!t.contestId && manages(u, t.contestId));
      if (b.status && !manager && !['OPEN', 'CLOSED'].includes(b.status))
        throw new ForbiddenException();
      for (const fileId of b.attachments) {
        const f = await tx.attachment.findUniqueOrThrow({ where: { id: fileId } });
        if (
          f.ownerId !== u.id ||
          (f.ticketId && f.ticketId !== id) ||
          (f.registrationId && f.registrationId !== t.registrationId)
        )
          throw new ForbiddenException();
        await tx.attachment.update({ where: { id: fileId }, data: { ticketId: id } });
      }
      await tx.supportMessage.create({
        data: { ticketId: id, actorId: u.id, text: b.text, attachments: json(b.attachments) },
      });
      const result = await tx.supportTicket.update({
        where: { id },
        data: {
          version: { increment: 1 },
          status: b.status ?? (manager ? 'WAITING_USER' : 'OPEN'),
        },
      });
      await audit(tx, u.id, 'TICKET_REPLY', id);
      const owner = await tx.user.findUniqueOrThrow({ where: { id: t.ownerId } });
      await event(tx, 'MAIL', id, {
        to: owner.email,
        subject: '工单有新回复',
        text: `${t.title}\n${b.text}`,
        actionPath: `/support/${id}`,
      });
      return result;
    });
  }
}
