import { randomUUID } from 'node:crypto';
import { db } from './db.js';

export const jobLeaseMs = 120000;
export async function claimJob(id: string) {
  const leaseToken = randomUUID();
  const claimed = await db.job.updateMany({
    where: { id, state: { in: ['PENDING', 'FAILED'] }, attempts: { lt: 4 } },
    data: {
      state: 'RUNNING',
      attempts: { increment: 1 },
      error: null,
      leaseToken,
      leaseUntil: new Date(Date.now() + jobLeaseMs),
    },
  });
  return claimed.count ? leaseToken : null;
}
export async function renewJobLease(id: string, leaseToken: string) {
  const result = await db.job.updateMany({
    where: { id, state: 'RUNNING', leaseToken },
    data: { leaseUntil: new Date(Date.now() + jobLeaseMs) },
  });
  return result.count === 1;
}
export async function recoverExpiredJobs() {
  await db.job.updateMany({
    where: {
      state: { in: ['RUNNING', 'PENDING'] },
      attempts: { gte: 4 },
      OR: [{ leaseUntil: { lt: new Date() } }, { leaseUntil: null }],
    },
    data: { state: 'FAILED', error: '任务重试次数已用尽', leaseToken: null, leaseUntil: null },
  });
  return db.job.updateMany({
    where: {
      state: 'RUNNING',
      attempts: { lt: 4 },
      OR: [
        { leaseUntil: { lt: new Date() } },
        { leaseUntil: null, updatedAt: { lt: new Date(Date.now() - 5 * 60000) } },
      ],
    },
    data: { state: 'PENDING', leaseToken: null, leaseUntil: null },
  });
}
