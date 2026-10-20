import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { examSitesSchema } from '@contest-center/contracts';
import type { Registration, Tx } from './db.js';

export const examSiteOrder = [{ sortOrder: 'asc' }, { id: 'asc' }] as const;

// Callers share the contest's seating lock with registration edits and room allocation.
export async function saveExamSites(
  tx: Tx,
  contestId: string,
  sites: z.infer<typeof examSitesSchema>,
) {
  const previous = await tx.examSite.findMany({ where: { contestId } });
  const retained = sites.flatMap((s) => (s.id ? [s.id] : []));
  const removed = previous.filter((s) => !retained.includes(s.id)).map((s) => s.id);
  if (
    removed.length &&
    ((await tx.registration.count({ where: { examSiteId: { in: removed } } })) ||
      (await tx.examRoom.count({ where: { examSiteId: { in: removed } } })))
  )
    throw new BadRequestException('考点已被报名或考场使用，请停用考点，或先调整关联数据再删除');
  const supplied = await tx.examSite.findMany({ where: { id: { in: retained } } });
  if (supplied.some((s) => s.contestId !== contestId))
    throw new BadRequestException('考点不属于此活动');
  await tx.examSite.deleteMany({ where: { id: { in: removed } } });
  for (const [sortOrder, site] of sites.entries()) {
    const { id = randomUUID(), ...data } = site;
    if (previous.some((s) => s.id === id))
      await tx.examSite.update({ where: { id }, data: { sortOrder, ...data } });
    else await tx.examSite.create({ data: { id, contestId, sortOrder, ...data } });
  }
  const changed = previous.some((s) => {
    const next = sites.find((n) => n.id === s.id);
    return next && (s.name !== next.name || s.address !== next.address);
  });
  if (changed)
    await tx.admissionDocument.updateMany({
      where: { registration: { contestId } },
      data: { state: 'STALE', releasedAt: null, version: { increment: 1 } },
    });
}

export function validateExamSite(r: Registration, id: string | null, required = false) {
  if (!id) {
    if (required && r.contest.examSites.length) throw new BadRequestException('请选择参赛考点');
    return;
  }
  const site = r.contest.examSites.find((s) => s.id === id);
  if (!site) throw new BadRequestException('考点不属于此活动');
  const previous = (r.snapshot as { examSiteId?: string } | null)?.examSiteId;
  const retained = required ? !!r.submittedAt && previous === id : id === r.examSiteId;
  if (!site.enabled && !retained) throw new BadRequestException('此考点已停用，请选择其他考点');
}

export function examSiteLocation(site: { name: string; address: string } | null) {
  return site ? [site.name, site.address].filter(Boolean).join(' · ') : '';
}
