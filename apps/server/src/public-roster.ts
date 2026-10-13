import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@contest-center/contracts';
import { db, audit } from './db.js';
import { paginated, type ListQuery } from './pagination.js';
import { requireManager } from './security.js';
export class PublicRosterService {
  private async contest(id: string) {
    const contest = await db.contest.findFirst({
      where: { id, published: true, archived: false, publicRosterEnabled: true },
    });
    if (!contest) throw new NotFoundException('此竞赛未开放队伍公示');
    return contest;
  }
  async list(id: string, query: ListQuery = {}) {
    const contest = await this.contest(id);
    const where = {
      contestId: id,
      status: 'SUBMITTED',
      submittedAt: { not: null },
      review: { in: contest.publicRosterReviews },
      ...(query.search
        ? {
            OR: [
              { teamName: { contains: query.search, mode: 'insensitive' as const } },
              { teamEnglishName: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const result = await paginated(
      query,
      (options) =>
        db.registration.findMany({
          where,
          ...options,
          select: {
            id: true,
            number: true,
            teamName: true,
            teamEnglishName: true,
            participationType: true,
            organization: true,
            publicRank: true,
            review: true,
            people: {
              where: { active: true },
              select: { name: true, captain: true, answers: true },
            },
            coaches: { select: { user: { select: { name: true } } } },
          },
          orderBy: [
            { publicRank: { sort: 'asc', nulls: 'last' } },
            { number: 'asc' },
            { id: 'asc' },
          ],
        }),
      () => db.registration.count({ where }),
    );
    const rows = Array.isArray(result) ? result : result.items;
    const items = rows.map((r) => ({
      id: r.id,
      number: r.number,
      teamName: r.teamName || r.people[0]?.name || '',
      teamEnglishName: r.teamEnglishName,
      school: (r.organization as any)?.name || (r.people[0]?.answers as any)?.school || '',
      rank: r.publicRank,
      members: r.people.map((p) => ({ name: p.name, captain: p.captain })),
      coaches: r.coaches.map((c) => c.user.name),
      review: r.review,
      participationType: r.participationType,
    }));
    return {
      contest: { id: contest.id, title: contest.title, mode: (contest.policy as any).mode },
      ...(Array.isArray(result) ? { items, total: items.length } : { ...result, items }),
    };
  }
  async csv(id: string) {
    const data = await this.list(id, { page: '1', pageSize: '100' });
    for (let page = 2; data.items.length < data.total; page++) {
      const next = await this.list(id, { page: String(page), pageSize: '100' });
      if (!next.items.length) break;
      data.items.push(...next.items);
    }
    const cell = (value: unknown) => {
      const text = String(value ?? '');
      return `"${(/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
    };
    return (
      '\ufeff' +
      [
        [
          '报名编号',
          '队名',
          '英文队名',
          '学校',
          '排名',
          '队员',
          '指导老师',
          '审核状态',
          '参赛性质',
        ],
        ...data.items.map((r) => [
          r.number,
          r.teamName,
          r.teamEnglishName,
          r.school,
          r.rank,
          r.members.map((m) => `${m.name}${m.captain ? '（队长）' : ''}`).join(' / '),
          r.coaches.join(' / '),
          r.review,
          r.participationType,
        ]),
      ]
        .map((row) => row.map(cell).join(','))
        .join('\r\n')
    );
  }
  async rank(u: Principal, id: string, body: unknown) {
    const b = z.object({ rank: z.number().int().positive().nullable() }).parse(body);
    const registration = await db.registration.findUniqueOrThrow({ where: { id } });
    requireManager(u, registration.contestId, 'REGISTRATIONS');
    await db.registration.update({ where: { id }, data: { publicRank: b.rank } });
    await audit(db, u.id, 'PUBLIC_RANK_SET', id, { rank: b.rank });
    return { ok: true };
  }
}
