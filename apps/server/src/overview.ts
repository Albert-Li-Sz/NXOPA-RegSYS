import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@contest-center/contracts';
import { db } from './db.js';

export class OverviewService {
  async stats(u: Principal, contestId?: string) {
    const contests = await db.contest.findMany({
      where: {
        archived: false,
        ...(u.isAdmin ? {} : { OR: [{ published: true }, { id: { in: u.contestIds } }] }),
      },
      select: {
        id: true,
        title: true,
        season: true,
        startsAt: true,
        opensAt: true,
        closesAt: true,
        manuallyClosed: true,
        published: true,
      },
      orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
    });
    if (contestId && !contests.some((c) => c.id === z.string().uuid().parse(contestId)))
      throw new ForbiddenException('没有此活动的统计访问权限');
    const selected = contestId ? contests.filter((c) => c.id === contestId) : contests;
    const ids = selected.map((c) => c.id);
    const activeStatuses = ['SUBMITTED', 'CORRECTION', 'CANCEL_REQUESTED'];
    const [groups, participants] = await Promise.all([
      db.registration.groupBy({
        by: ['contestId', 'status', 'review', 'eligible', 'participationType'],
        where: { contestId: { in: ids }, submittedAt: { not: null } },
        _count: { _all: true },
      }),
      db.registrationPerson.groupBy({
        by: ['contestId'],
        where: {
          contestId: { in: ids },
          active: true,
          registration: { status: { in: activeStatuses }, submittedAt: { not: null } },
        },
        _count: { _all: true },
      }),
    ]);
    const empty = () => ({
      submitted: 0,
      active: 0,
      participants: 0,
      pending: 0,
      approved: 0,
      correction: 0,
      eligible: 0,
      unofficial: 0,
      cancelled: 0,
    });
    const now = new Date();
    const activities = selected.map((c) => {
      const stats = empty();
      stats.participants = participants.find((row) => row.contestId === c.id)?._count._all ?? 0;
      for (const group of groups.filter((row) => row.contestId === c.id)) {
        const count = group._count._all;
        stats.submitted += count;
        if (group.status === 'CANCELLED') stats.cancelled += count;
        if (!activeStatuses.includes(group.status)) continue;
        stats.active += count;
        if (group.status === 'SUBMITTED' && group.review === 'PENDING') stats.pending += count;
        if (group.review === 'APPROVED') stats.approved += count;
        if (group.status === 'CORRECTION') stats.correction += count;
        if (group.eligible) stats.eligible += count;
        if (group.participationType === 'UNOFFICIAL') stats.unofficial += count;
      }
      return {
        ...c,
        phase:
          c.manuallyClosed || c.closesAt < now ? 'CLOSED' : c.opensAt > now ? 'UPCOMING' : 'OPEN',
        ...stats,
      };
    });
    const totals = empty();
    for (const activity of activities)
      for (const key of Object.keys(totals) as (keyof typeof totals)[])
        totals[key] += activity[key];
    return {
      updatedAt: now.toISOString(),
      totals: {
        ...totals,
        activities: activities.length,
        openActivities: activities.filter((c) => c.phase === 'OPEN').length,
      },
      activities,
      choices: contests.map(({ id, title }) => ({ id, title })),
    };
  }
}
