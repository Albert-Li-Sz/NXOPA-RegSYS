import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, enqueue, lock } from './db.js';
import { config } from './config.js';
import { removeBlob, reconcileStorage, type StorageRef } from './storage.js';

export async function cleanSpool() {
  await mkdir(config.spool, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(config.spool, { withFileTypes: true })) {
    const match = /^([a-f0-9-]{36})-([a-f0-9-]{36})$/i.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const job = await db.job.findUnique({
      where: { id: match[1] },
      select: { state: true, leaseToken: true, leaseUntil: true },
    });
    if (
      job?.state === 'RUNNING' &&
      job.leaseToken === match[2] &&
      job.leaseUntil &&
      job.leaseUntil > new Date()
    )
      continue;
    await rm(path.join(config.spool, entry.name), { force: true, recursive: true });
  }
}
export async function retainTemporaryData() {
  const now = new Date(),
    week = new Date(Date.now() - 7 * 86400000),
    month = new Date(Date.now() - 30 * 86400000);
  await cleanSpool();
  const expiredBatches = await db.admissionBatch.findMany({
    where: { expiresAt: { lt: now }, state: { notIn: ['RUNNING', 'QUEUED'] } },
    take: 100,
  });
  for (const batch of expiredBatches) {
    for (const file of (batch.result as any)?.files ?? []) await removeBlob(file);
    await db.admissionBatch.delete({ where: { id: batch.id } });
  }
  await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.emailToken.deleteMany({ where: { expiresAt: { lt: week } } });
  await db.registrationVerification.deleteMany({ where: { expiresAt: { lt: week } } });
  await db.outboxEvent.deleteMany({ where: { deliveredAt: { lt: week } } });
  const previews = await db.job.findMany({
    where: {
      kind: 'PDF_PREVIEW',
      createdAt: { lt: new Date(Date.now() - 3600000) },
      state: { not: 'RUNNING' },
    },
    take: 100,
  });
  for (const job of previews) {
    if ((job.result as any)?.storageKey) await removeBlob(job.result as unknown as StorageRef);
    await db.job.deleteMany({ where: { id: job.id, state: { not: 'RUNNING' } } });
  }
  const stale = await db.admissionDocument.findMany({
    where: { state: { in: ['STALE', 'FAILED'] }, storageKey: { not: null } },
    take: 100,
  });
  for (const document of stale)
    await db.$transaction(async (tx) => {
      await lock(tx, document.registrationId);
      const changed = await tx.admissionDocument.updateMany({
        where: {
          id: document.id,
          version: document.version,
          state: { in: ['STALE', 'FAILED'] },
          storageKey: document.storageKey,
        },
        data: { storageKey: null },
      });
      if (changed.count)
        await enqueue(
          tx,
          'OBJECT_DELETE',
          document.id,
          `stale-document:${document.id}:${document.version}`,
          { storageRef: document },
        );
    });
  await db.job.updateMany({
    where: {
      kind: 'MAIL',
      createdAt: { lt: new Date(Date.now() - 3600000) },
      OR: [
        { payload: { path: ['category'], string_starts_with: 'AUTH_' } },
        { payload: { path: ['category'], equals: 'ACCOUNT_CLOSE' } },
      ],
    },
    data: { payload: { redacted: true, category: 'AUTH_REDACTED' } },
  });
  await db.job.deleteMany({
    where: {
      kind: { not: 'PDF_PREVIEW' },
      state: { in: ['SUCCESS', 'CANCELLED'] },
      updatedAt: { lt: month },
    },
  });
}
let nextStorageCleanup = 0;
export async function reconcileOrphans() {
  if (Date.now() < nextStorageCleanup) return;
  nextStorageCleanup = Date.now() + 86400000;
  void reconcileStorage().catch((error) =>
    console.warn('Storage reconciliation failed:', error instanceof Error ? error.name : 'error'),
  );
}
