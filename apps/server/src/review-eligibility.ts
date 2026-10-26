import { db, lock, event, audit } from './db.js';

/** Idempotent, bounded batches; existing snapshots, finance and credentials are preserved. */
export async function migrateReviewEligibility() {
  const key = 'migration:review-eligibility-v2.1';
  while (true) {
    const finished = await db.$transaction(
      async (tx) => {
        await lock(tx, key);
        if (await tx.setting.findUnique({ where: { key } })) return true;
        const rows = await tx.registration.findMany({
          where: {
            eligible: true,
            OR: [{ status: { not: 'SUBMITTED' } }, { review: { not: 'APPROVED' } }],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 100,
        });
        if (!rows.length) {
          await tx.setting.create({ data: { key, value: { completed: true } } });
          return true;
        }
        for (const { id } of rows) {
          await lock(tx, id);
          const r = await tx.registration.findUnique({ where: { id } });
          if (!r?.eligible || (r.status === 'SUBMITTED' && r.review === 'APPROVED')) continue;
          await tx.registration.update({
            where: { id },
            data: { eligible: false, version: { increment: 1 } },
          });
          await tx.admissionDocument.updateMany({
            where: { registrationId: id },
            data: { state: 'STALE', releasedAt: null },
          });
          await tx.accountMapping.updateMany({
            where: { registrationId: id },
            data: { state: 'STALE' },
          });
          await event(tx, 'ELIGIBILITY', id, { eligible: false, version: r.version + 1 });
          await audit(tx, 'system', 'REVIEW_ELIGIBILITY_MIGRATION', id, {
            previousStatus: r.status,
            previousReview: r.review,
          });
        }
        return false;
      },
      { timeout: 120000 },
    );
    if (finished) return;
  }
}
