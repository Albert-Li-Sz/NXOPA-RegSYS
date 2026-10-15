import { db, audit, enqueue, event, json, lock, type Registration, type Tx } from './db.js';
import { ensureFinance } from './finance-accounts.js';
import { decrypt, encrypt } from './security.js';
import type { StorageRef } from './storage.js';
const objectRef = (file: StorageRef) => ({
  storageKey: file.storageKey,
  storageBackend: file.storageBackend,
  storageConfigId: file.storageConfigId,
  sha256: file.sha256,
});

export async function recordRemoteRevocation(
  tx: Tx,
  m: {
    bindingId: string;
    registrationId: string;
    remoteUserId: string | null;
    remoteTeamId: string | null;
  },
  contestId: string,
  fallbackTarget: Record<string, unknown> = {},
) {
  if (!m.remoteUserId && !m.remoteTeamId) return;
  const prior = await tx.remoteRevocation.findFirst({
    where: { bindingId: m.bindingId, registrationId: m.registrationId, state: 'PENDING' },
  });
  if (
    prior &&
    (!m.remoteUserId || !prior.remoteUserId || prior.remoteUserId === m.remoteUserId) &&
    (!m.remoteTeamId || !prior.remoteTeamId || prior.remoteTeamId === m.remoteTeamId)
  ) {
    await tx.remoteRevocation.update({
      where: { id: prior.id },
      data: {
        remoteUserId: m.remoteUserId ?? prior.remoteUserId,
        remoteTeamId: m.remoteTeamId ?? prior.remoteTeamId,
      },
    });
    return;
  }
  const binding = await tx.platformBinding.findUnique({
    where: { id: m.bindingId },
    include: { instance: { select: { name: true, baseUrl: true } } },
  });
  await tx.remoteRevocation.create({
    data: {
      contestId,
      bindingId: m.bindingId,
      registrationId: m.registrationId,
      remoteUserId: m.remoteUserId,
      remoteTeamId: m.remoteTeamId,
      target: json({
        ...fallbackTarget,
        platformName: binding?.instance.name ?? fallbackTarget.platformName,
        baseUrl: binding?.instance.baseUrl ?? fallbackTarget.baseUrl,
        remoteContestId: binding?.remoteContestId ?? fallbackTarget.remoteContestId,
      }),
    },
  });
}
// Callers hold the registration lock. Only settlement data and minimal deletion metadata survive.
export async function removeRegistration(
  tx: Tx,
  r: Registration,
  actorId: string,
  reason: string,
  source: 'CANCEL' | 'DELETE' = 'CANCEL',
) {
  await lock(tx, `seating:${r.contestId}`);
  const account = await ensureFinance(tx, r);
  const financialCount =
    (await tx.ledgerEntry.count({ where: { registrationId: r.id } })) +
    (await tx.paymentVoucher.count({ where: { registrationId: r.id } })) +
    (await tx.refund.count({ where: { registrationId: r.id } })) +
    (await tx.invoiceRequest.count({ where: { registrationId: r.id } }));
  const financial = financialCount > 0 || account.netPaidCents !== 0;
  if (financial)
    await tx.financeAccount.update({
      where: { id: r.id },
      data: { cancelledAt: new Date(), version: { increment: 1 } },
    });
  else await tx.financeAccount.delete({ where: { id: r.id } });

  const mappings = await tx.accountMapping.findMany({ where: { registrationId: r.id } });
  for (const m of mappings) await recordRemoteRevocation(tx, m, r.contestId);
  await tx.accountMapping.deleteMany({ where: { registrationId: r.id } });
  const documents = await tx.admissionDocument.findMany({ where: { registrationId: r.id } });
  for (const d of documents)
    if (d.storageKey)
      await enqueue(tx, 'OBJECT_DELETE', d.id, `removed-document:${d.id}`, {
        storageRef: objectRef(d),
      });
  await tx.admissionDocument.deleteMany({ where: { registrationId: r.id } });
  await tx.teamFile.deleteMany({ where: { registrationId: r.id } });
  const files = await tx.attachment.findMany({ where: { registrationId: r.id } });
  for (const file of files) {
    const protectedFile =
      (await tx.paymentVoucher.count({ where: { attachmentId: file.id } })) +
      (await tx.invoiceRequest.count({ where: { attachmentId: file.id } })) +
      (await tx.refund.count({ where: { attachmentId: file.id } }));
    if (protectedFile) continue;
    const shared = await tx.teamFile.count({ where: { attachmentId: file.id } });
    const used = await tx.$queryRaw<{ used: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM "Registration" WHERE id <> ${r.id}::uuid AND (answers::text LIKE ${`%${file.id}%`} OR snapshot::text LIKE ${`%${file.id}%`})
      UNION ALL SELECT 1 FROM "RegistrationRevision" WHERE "registrationId" <> ${r.id}::uuid AND snapshot::text LIKE ${`%${file.id}%`}
      UNION ALL SELECT 1 FROM "RegistrationPerson" WHERE "registrationId" <> ${r.id}::uuid AND answers::text LIKE ${`%${file.id}%`}
      UNION ALL SELECT 1 FROM "RegistrationCoach" WHERE "registrationId" <> ${r.id}::uuid AND answers::text LIKE ${`%${file.id}%`}
      UNION ALL SELECT 1 FROM "SupportMessage" WHERE attachments::text LIKE ${`%${file.id}%`}
      UNION ALL SELECT 1 FROM "User" WHERE "avatarAttachmentId" = ${file.id}::uuid
    ) AS used`;
    if (
      file.ticketId ||
      shared ||
      used[0]?.used ||
      ['PERSONAL', 'AVATAR', 'CONTEST_PUBLIC', 'CONTEST_PRIVATE'].includes(file.purpose)
    ) {
      await tx.attachment.update({ where: { id: file.id }, data: { registrationId: null } });
    } else {
      await tx.attachment.delete({ where: { id: file.id } });
      await enqueue(tx, 'OBJECT_DELETE', file.id, `removed-file:${file.id}`, {
        storageRef: objectRef(file),
      });
    }
  }
  await tx.supportTicket.updateMany({
    where: { registrationId: r.id },
    data: { registrationId: null },
  });
  await tx.invitation.deleteMany({ where: { registrationId: r.id } });
  // Old notifications and generated payloads must not retain a copy or revive a deleted registration.
  const relatedIds = [r.id, ...documents.map((d) => d.id)];
  const spoolJobs = await tx.job.findMany({
    where: { resourceId: r.id, kind: 'ADMISSION' },
    select: { id: true },
  });
  for (const job of spoolJobs)
    await enqueue(tx, 'SPOOL_DELETE', job.id, `removed-spool:${job.id}`, { jobId: job.id });
  const financialJobs = await tx.job.findMany({
    where: {
      resourceId: { in: relatedIds },
      kind: 'MAIL',
      payload: { path: ['finance'], equals: true },
    },
    select: { id: true },
  });
  await tx.job.updateMany({
    where: {
      resourceId: { in: relatedIds },
      kind: { not: 'OBJECT_DELETE' },
      id: { notIn: financialJobs.map((j) => j.id) },
    },
    data: {
      state: 'CANCELLED',
      payload: {},
      result: { deleted: true },
      error: null,
    },
  });
  const financialEvents = await tx.outboxEvent.findMany({
    where: {
      resourceId: { in: relatedIds },
      type: 'MAIL',
      payload: { path: ['finance'], equals: true },
    },
    select: { id: true },
  });
  await tx.outboxEvent.deleteMany({
    where: {
      resourceId: { in: relatedIds },
      type: { not: 'TASK' },
      id: { notIn: financialEvents.map((e) => e.id) },
    },
  });
  const receipt = {
    deleted: true,
    registrationId: r.id,
    financeAccountId: financial ? r.id : null,
  };
  const replays = await tx.idempotencyRecord.findMany({
    where: {
      AND: [
        { OR: [{ resourceType: null }, { resourceType: { not: 'FINANCE' } }] },
        { OR: [{ resourceId: r.id }, { resourceId: null }] },
      ],
    },
  });
  for (const replay of replays) {
    let raw = JSON.stringify(replay.result);
    try {
      if ((replay.result as any)?.encrypted)
        raw = decrypt(String((replay.result as any).encrypted));
    } catch {
      continue;
    }
    try {
      const value = JSON.parse(raw);
      if (value?.registrationId === r.id && typeof value.amountCents === 'number') {
        await tx.idempotencyRecord.update({
          where: { id: replay.id },
          data: { resourceType: 'FINANCE', resourceId: r.id },
        });
        continue;
      }
    } catch {}
    if (replay.resourceId === r.id || raw.includes(r.id))
      await tx.idempotencyRecord.update({
        where: { id: replay.id },
        data: {
          resourceId: r.id,
          result: json({ encrypted: encrypt(JSON.stringify(receipt)) }),
        },
      });
  }
  // Keep the action timeline for accountability, but discard recoverable form data.
  await tx.auditEvent.updateMany({
    where: {
      resourceId: r.id,
      NOT: {
        OR: ['VOUCHER_', 'PAYMENT_', 'REFUND_', 'INVOICE_'].map((prefix) => ({
          action: { startsWith: prefix },
        })),
      },
    },
    data: { details: { deleted: true, personalDataRemoved: true } },
  });
  await tx.registration.delete({ where: { id: r.id } });
  await tx.contest.update({
    where: { id: r.contestId },
    data: {
      deletedSubmittedCount: { increment: r.submittedAt ? 1 : 0 },
      deletedCancelledCount: { increment: r.submittedAt && source === 'CANCEL' ? 1 : 0 },
      seatingVersion: { increment: 1 },
    },
  });
  if (actorId !== 'migration')
    await event(tx, 'REGISTRATION_REMOVED', r.id, {
      contestId: r.contestId,
      version: r.version + 1,
      deleted: true,
    });
  await audit(tx, actorId, 'REGISTRATION_DELETE', r.id, {
    contestId: r.contestId,
    reason,
    financial,
    source,
  });
  return receipt;
}
export async function migrateCancelledRegistrations() {
  const ids = await db.registration.findMany({
    where: { status: { in: ['CANCELLED', 'CANCEL_REQUESTED'] } },
    select: { id: true },
  });
  for (const { id } of ids)
    await db.$transaction(
      async (tx) => {
        await lock(tx, id);
        const r = await tx.registration.findUnique({
          where: { id },
          include: {
            contest: true,
            people: true,
            coaches: { include: { user: { select: { id: true, name: true, email: true } } } },
          },
        });
        if (r && ['CANCELLED', 'CANCEL_REQUESTED'].includes(r.status))
          await removeRegistration(tx, r, 'migration', '历史取消报名迁移');
      },
      { timeout: 120000 },
    );
}
