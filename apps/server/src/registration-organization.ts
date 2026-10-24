import { BadRequestException } from '@nestjs/common';
import { type Registration, type Tx } from './db.js';

export async function verifiedOrganization(tx: Tx, r: Registration, required = false) {
  const captain = r.people.find((p) => p.active && p.captain);
  const user = captain?.userId
    ? await tx.user.findUnique({ where: { id: captain.userId }, include: { person: true } })
    : null;
  const school = (user?.person?.data as any)?.profile?.school;
  const name = typeof school === 'string' ? school.trim() : '';
  if (!user || user.deactivatedAt || user.bannedAt || user.identityStatus !== 'VERIFIED' || !name) {
    if (required)
      throw new BadRequestException('本人／队长须先通过实名认证，并完善实名学校／单位后再提交报名');
    return null;
  }
  return { name };
}
