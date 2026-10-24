import { randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { accountSettingsSchema } from '@contest-center/contracts';
import { db, lock, type Tx } from './db.js';
import { decrypt, encrypt } from './security.js';

export const accountSettings = (contest: { accountSettings: unknown }) =>
  accountSettingsSchema.parse(contest.accountSettings);

// Both account creation and prefix changes hold this lock. Credentials are never
// returned from ordinary registration/list APIs.
export async function ensureCompetitionAccount(tx: Tx, registrationId: string) {
  const r = await tx.registration.findUniqueOrThrow({ where: { id: registrationId } });
  await lock(tx, `competition-accounts:${r.contestId}`);
  const contest = await tx.contest.findUniqueOrThrow({ where: { id: r.contestId } });
  const settings = accountSettings(contest);
  if (!settings.enabled || !r.eligible || r.number === null) return null;
  return tx.competitionAccount.upsert({
    where: { registrationId },
    create: {
      registrationId,
      contestId: r.contestId,
      username: `${settings.prefix}${String(r.number).padStart(4, '0')}`,
      credential: encrypt(randomBytes(18).toString('base64url'), 'competition-account'),
    },
    update: {},
  });
}

export async function competitionCredentials(registrationId: string, forAdmission = false) {
  const r = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: { contest: true, competitionAccount: true },
  });
  const settings = accountSettings(r.contest);
  if (!settings.enabled || !r.eligible || (forAdmission && !settings.showOnAdmission)) return null;
  if (!r.competitionAccount) throw new BadRequestException('比赛账号正在生成，请稍后重试');
  return {
    username: r.competitionAccount.username,
    password: decrypt(r.competitionAccount.credential, 'competition-account'),
  };
}

export async function backfillCompetitionAccounts(contestId: string) {
  let cursor: string | undefined;
  while (true) {
    const rows: { id: string }[] = await db.registration.findMany({
      where: { contestId, eligible: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true },
    });
    for (const r of rows)
      await db.$transaction(async (tx) => {
        await lock(tx, r.id);
        await ensureCompetitionAccount(tx, r.id);
      });
    if (rows.length < 100) return;
    cursor = rows.at(-1)!.id;
  }
}
