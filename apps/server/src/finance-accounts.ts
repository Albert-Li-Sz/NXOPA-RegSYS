import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { policySchema, type Principal } from '@contest-center/contracts';
import { db, json, event, type Tx, type Registration } from './db.js';
import { canRead, canActForApplicant, owns, manages } from './security.js';

export async function ensureFinance(tx: Tx, r: Registration) {
  const data = {
    contestId: r.contestId,
    ownerId: r.ownerId,
    number: r.number,
    feeCents: r.feeCents,
    netPaidCents: r.netPaidCents,
    policySnapshot: json(r.policySnapshot ?? r.contest.policy),
  };
  return tx.financeAccount.upsert({
    where: { id: r.id },
    create: { id: r.id, ...data },
    update: data,
  });
}
export async function financeLoaded(tx: Tx, id: string) {
  const registration = await tx.registration.findUnique({
    where: { id },
    include: {
      contest: true,
      people: true,
      coaches: { include: { user: { select: { id: true, name: true, email: true } } } },
    },
  });
  if (registration && !(await tx.financeAccount.count({ where: { id } })))
    await ensureFinance(tx, registration);
  const account = await tx.financeAccount.findUnique({ where: { id }, include: { contest: true } });
  if (!account) throw new NotFoundException('财务账户不存在');
  return {
    ...account,
    registration,
    status: registration?.status ?? 'REMOVED',
    review: registration?.review ?? 'APPROVED',
    participationType: registration?.participationType ?? 'OFFICIAL',
    policySnapshot: account.policySnapshot,
  };
}
export type FinanceContext = Awaited<ReturnType<typeof financeLoaded>>;
export const financePolicy = (r: FinanceContext) => policySchema.parse(r.policySnapshot);
export function canEditFinance(u: Principal, r: FinanceContext) {
  return r.registration ? canActForApplicant(u, r.registration) : owns(u, r.ownerId);
}
export async function getFinance(u: Principal, id: string, edit = false) {
  const r = await financeLoaded(db, id);
  const allowed = edit
    ? canEditFinance(u, r)
    : r.registration
      ? canRead(u, r.registration) || manages(u, r.contestId, 'FINANCE')
      : owns(u, r.ownerId) || manages(u, r.contestId, 'FINANCE');
  if (!allowed) throw new ForbiddenException('没有此财务账户的访问权限');
  return r;
}
export async function balanceChange(tx: Tx, r: FinanceContext, delta: number) {
  await tx.financeAccount.update({
    where: { id: r.id },
    data: {
      netPaidCents: { increment: delta },
      version: { increment: 1 },
    },
  });
  if (r.registration)
    await tx.registration.update({
      where: { id: r.id },
      data: {
        netPaidCents: { increment: delta },
        version: { increment: 1 },
      },
    });
}
export async function financeNotify(tx: Tx, r: FinanceContext, payload: Record<string, unknown>) {
  if (r.registration) return event(tx, 'NOTIFY', r.id, payload);
  const owner = await tx.user.findUnique({ where: { id: r.ownerId } });
  if (owner?.verified && !owner.deactivatedAt)
    await event(tx, 'MAIL', r.id, {
      to: owner.email,
      subject: '活动财务处理更新',
      text: String(payload.message),
      category: String(payload.category ?? 'REGISTRATION'),
      status: String(payload.status ?? ''),
      actionPath: `/finance/${r.id}`,
      finance: true,
    });
}
