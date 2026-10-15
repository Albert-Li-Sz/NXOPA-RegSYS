import { BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { invoiceSchema, policySchema, type Principal } from '@contest-center/contracts';
import { db, audit, event, lock, json } from './db.js';
import { paginated, dateFilter, type ListQuery } from './pagination.js';
import { refresh } from './registrations.js';
import {
  financeLoaded as loaded,
  financePolicy as policy,
  getFinance,
  canEditFinance as canEdit,
  balanceChange,
  financeNotify,
} from './finance-accounts.js';
import { requireManager, ownerIds } from './security.js';
import { bindFile } from './files.js';
const cents = z.number().int().positive().max(100_000_000);
async function ledgerWithReversalState<T extends { id: string; kind: string }>(rows: T[]) {
  const payments = rows.filter((row) => row.kind === 'PAYMENT').map((row) => `reverse:${row.id}`);
  const reversals = payments.length
    ? await db.ledgerEntry.findMany({
        where: { sourceId: { in: payments }, kind: 'REVERSAL' },
        select: { sourceId: true },
      })
    : [];
  const reversed = new Set(reversals.map((row) => row.sourceId));
  return rows.map((row) => ({ ...row, reversed: reversed.has(`reverse:${row.id}`) }));
}
export class FinanceService {
  async accounts(u: Principal, query: ListQuery = {}) {
    if (query.contestId && query.role !== 'mine') requireManager(u, query.contestId, 'FINANCE');
    const where = {
      OR: [
        { feeCents: { gt: 0 } },
        { netPaidCents: { not: 0 } },
        { vouchers: { some: {} } },
        { ledger: { some: {} } },
        { refunds: { some: {} } },
        { invoices: { some: {} } },
      ],
      ...(query.contestId
        ? {
            contestId: query.contestId,
            ...(query.role === 'mine' ? { ownerId: { in: ownerIds(u) } } : {}),
          }
        : { ownerId: { in: ownerIds(u) } }),
      ...(query.search
        ? { contest: { title: { contains: query.search, mode: 'insensitive' as const } } }
        : {}),
    };
    return paginated(
      { page: '1', ...query },
      (options) =>
        db.financeAccount.findMany({
          where,
          ...options,
          include: { contest: { select: { title: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      () => db.financeAccount.count({ where }),
    );
  }
  async account(u: Principal, id: string) {
    const r = await getFinance(u, id);
    const [vouchers, ledger, refunds, invoices] = await Promise.all([
      db.paymentVoucher.findMany({ where: { registrationId: id }, orderBy: { createdAt: 'desc' } }),
      db.ledgerEntry.findMany({ where: { registrationId: id }, orderBy: { createdAt: 'desc' } }),
      db.refund.findMany({ where: { registrationId: id }, orderBy: { createdAt: 'desc' } }),
      db.invoiceRequest.findMany({ where: { registrationId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      id: r.id,
      ownerId: r.ownerId,
      contestId: r.contestId,
      contest: { title: r.contest.title },
      number: r.number,
      feeCents: r.feeCents,
      netPaidCents: r.netPaidCents,
      cancelledAt: r.cancelledAt,
      policy: policy(r),
      invoicePolicy: policySchema.parse(r.contest.policy),
      version: r.version,
      canEdit: canEdit(u, r),
      canManage:
        u.isAdmin ||
        !!u.permissions?.[r.contestId]?.includes('FINANCE') ||
        (!u.permissions && u.contestIds.includes(r.contestId)),
      vouchers,
      ledger: await ledgerWithReversalState(ledger),
      refunds,
      invoices,
    };
  }
  async history(u: Principal, id: string, collection: string, query: ListQuery = {}) {
    await getFinance(u, id);
    const models = {
      vouchers: db.paymentVoucher,
      ledger: db.ledgerEntry,
      refunds: db.refund,
      invoices: db.invoiceRequest,
    };
    if (!Object.hasOwn(models, collection)) throw new BadRequestException('财务记录类型无效');
    const model = models[collection as keyof typeof models] as any;
    const searchFields: Record<string, string[]> = {
      vouchers: ['payer', 'channel', 'reference', 'reason'],
      ledger: ['sourceId', 'channelReference', 'note'],
      refunds: ['reason', 'reference'],
      invoices: ['title', 'taxId', 'email', 'contactName', 'remarks', 'reason'],
    };
    const where = {
      registrationId: id,
      createdAt: dateFilter(query),
      ...(query.status ? { [collection === 'ledger' ? 'kind' : 'status']: query.status } : {}),
      ...(query.search
        ? {
            OR: searchFields[collection].map((field) => ({
              [field]: { contains: query.search, mode: 'insensitive' },
            })),
          }
        : {}),
    };
    return paginated(
      { page: '1', ...query },
      async (options) => {
        const rows = await model.findMany({
          where,
          ...options,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        return collection === 'ledger' ? ledgerWithReversalState(rows) : rows;
      },
      () => model.count({ where }),
    );
  }
  async voucher(u: Principal, id: string, body: unknown) {
    const b = z
      .object({
        amountCents: cents,
        channel: z.string().min(1).max(100),
        reference: z.string().max(150).optional(),
        payer: z.string().min(1).max(100),
        paidAt: z.iso.datetime({ offset: true }),
        attachmentId: z.string().uuid(),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      const p = policy(r);
      if (r.status !== 'SUBMITTED' || p.feeMode === 'FREE' || r.review === 'REJECTED')
        throw new BadRequestException('当前报名无法上传缴费凭证');
      if (
        p.paymentSequence === 'REVIEW_FIRST' &&
        (p.manualReview || r.participationType === 'UNOFFICIAL') &&
        r.review !== 'APPROVED'
      )
        throw new BadRequestException('请先等待审核通过');
      await bindFile(tx, u, b.attachmentId, id);
      if (await tx.paymentProofClaim.findUnique({ where: { attachmentId: b.attachmentId } }))
        throw new ConflictException('该附件已经用于缴费凭证，请勿重复提交');
      const v = await tx.paymentVoucher.create({
        data: {
          ...b,
          reference: b.reference?.trim() || null,
          paidAt: new Date(b.paidAt),
          registrationId: id,
          createdBy: u.id,
        },
      });
      await tx.paymentProofClaim.create({
        data: { attachmentId: b.attachmentId, voucherId: v.id },
      });
      await audit(tx, u.id, 'VOUCHER_UPLOAD', id, { voucherId: v.id });
      await financeNotify(tx, r, { message: '缴费凭证已上传，等待管理员核账。' });
      return v;
    });
  }
  async confirm(u: Principal, id: string, body: unknown) {
    const b = z
      .object({
        decision: z.enum(['CONFIRMED', 'REJECTED']),
        reason: z.string().max(3000).default(''),
        amountCents: cents.optional(),
        reference: z.string().trim().min(1).max(150).optional(),
      })
      .parse(body);
    const v = await db.paymentVoucher.findUniqueOrThrow({ where: { id } });
    return db.$transaction(async (tx) => {
      await lock(tx, v.registrationId);
      const r = await loaded(tx, v.registrationId);
      requireManager(u, r.contestId, 'FINANCE');
      const current = await tx.paymentVoucher.findUniqueOrThrow({ where: { id } });
      const attachment = await tx.attachment.findUnique({ where: { id: current.attachmentId } });
      if (
        ownerIds(u).some((actor) =>
          [r.ownerId, current.createdBy, attachment?.ownerId].includes(actor),
        )
      )
        throw new ForbiddenException(
          '不能审核本人提交或本人账户的缴费凭证，请由其他财务管理员处理',
        );
      if (current.status !== 'PENDING') {
        if (current.status === b.decision) return current;
        throw new BadRequestException('该凭证已经核账，需要通过冲正更正');
      }
      if (b.decision === 'REJECTED' && !b.reason) throw new BadRequestException('请填写拒绝原因');
      if (b.amountCents !== undefined && b.amountCents !== current.amountCents)
        throw new BadRequestException('核账不能改写申报金额，请退回凭证后重新提交');
      const amount = current.amountCents;
      const reference = current.reference?.trim() || b.reference;
      if (b.decision === 'CONFIRMED') {
        if (!reference) throw new BadRequestException('确认到账前请填写银行或支付平台的交易参考号');
        await lock(tx, `file:${current.attachmentId}`);
        const claim = await tx.paymentProofClaim.findUnique({
          where: { attachmentId: current.attachmentId },
        });
        if (claim && claim.voucherId !== id)
          throw new ConflictException('此附件已用于其他缴费凭证');
        if (!claim)
          await tx.paymentProofClaim.create({
            data: { attachmentId: current.attachmentId, voucherId: id },
          });
      }
      const result = await tx.paymentVoucher.update({
        where: { id },
        data: { status: b.decision, reason: b.reason, reference, confirmedBy: u.id },
      });
      if (b.decision === 'CONFIRMED') {
        await tx.ledgerEntry.create({
          data: {
            registrationId: r.id,
            contestId: r.contestId,
            kind: 'PAYMENT',
            amountCents: amount,
            sourceId: `voucher:${id}`,
            channelReference: `${current.channel}:${reference}`,
            actorId: u.id,
            note: b.reason || '管理员确认线下实际到账',
          },
        });
        await balanceChange(tx, r, amount);
      }
      await audit(tx, u.id, 'VOUCHER_REVIEW', r.id, {
        voucherId: id,
        decision: b.decision,
        amountCents: amount,
        declaredAmountCents: current.amountCents,
        differenceCents: amount - current.amountCents,
      });
      await financeNotify(tx, r, { message: `缴费核账：${b.decision}。${b.reason}` });
      if (r.registration) await refresh(tx, r.id);
      return result;
    });
  }
  async reverse(u: Principal, id: string, body: unknown) {
    const { reason } = z.object({ reason: z.string().min(1).max(3000) }).parse(body);
    const e = await db.ledgerEntry.findUniqueOrThrow({ where: { id } });
    return db.$transaction(async (tx) => {
      await lock(tx, e.registrationId);
      const r = await loaded(tx, e.registrationId);
      requireManager(u, r.contestId, 'FINANCE');
      if (e.kind !== 'PAYMENT') throw new BadRequestException('只能冲正确认收款');
      const prior = await tx.ledgerEntry.findUnique({ where: { sourceId: `reverse:${id}` } });
      if (prior) return prior;
      const totalInvoices = await tx.invoiceRequest.aggregate({
        where: { registrationId: r.id, status: { in: ['REQUESTED', 'ISSUED'] } },
        _sum: { amountCents: true },
      });
      if (r.netPaidCents - e.amountCents < (totalInvoices._sum.amountCents ?? 0))
        throw new BadRequestException('请先处理已开票 / 待开票金额');
      const result = await tx.ledgerEntry.create({
        data: {
          registrationId: r.id,
          contestId: r.contestId,
          kind: 'REVERSAL',
          amountCents: -e.amountCents,
          sourceId: `reverse:${id}`,
          actorId: u.id,
          note: reason,
        },
      });
      await balanceChange(tx, r, -e.amountCents);
      await audit(tx, u.id, 'PAYMENT_REVERSE', r.id, { ledgerId: id, reason });
      await financeNotify(tx, r, { message: '收款已冲正，请查看账簿与资格状态。' });
      if (r.registration) await refresh(tx, r.id);
      return result;
    });
  }
  async requestRefund(u: Principal, id: string, body: unknown) {
    const b = z.object({ amountCents: cents, reason: z.string().min(1).max(3000) }).parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      if (!policy(r).refundsEnabled) throw new BadRequestException('此竞赛未开放退款');
      const pending = await tx.refund.aggregate({
        where: { registrationId: id, status: { in: ['REQUESTED', 'APPROVED'] } },
        _sum: { amountCents: true },
      });
      if (b.amountCents > r.netPaidCents - (pending._sum.amountCents ?? 0))
        throw new BadRequestException('退款金额超过可退款余额');
      const x = await tx.refund.create({ data: { ...b, registrationId: id, requestedBy: u.id } });
      await audit(tx, u.id, 'REFUND_REQUEST', id, { refundId: x.id });
      await financeNotify(tx, r, { message: '退款申请已提交，等待管理员处理。' });
      return x;
    });
  }
  async refundDecision(u: Principal, id: string, body: unknown) {
    const b = z
      .object({
        decision: z.enum(['APPROVED', 'REJECTED', 'COMPLETED']),
        reference: z.string().max(150).optional(),
        attachmentId: z.string().uuid().optional(),
      })
      .parse(body);
    const refund = await db.refund.findUniqueOrThrow({ where: { id } });
    return db.$transaction(async (tx) => {
      await lock(tx, refund.registrationId);
      const r = await loaded(tx, refund.registrationId);
      requireManager(u, r.contestId, 'FINANCE');
      const x = await tx.refund.findUniqueOrThrow({ where: { id } });
      if (ownerIds(u).some((actor) => [r.ownerId, x.requestedBy].includes(actor)))
        throw new ForbiddenException('不能审核或完成本人的退款申请，请由其他财务管理员处理');
      if (x.status === b.decision) return x;
      if (['REJECTED', 'COMPLETED'].includes(x.status)) throw new BadRequestException('退款已结束');
      if (b.decision === 'COMPLETED' && x.status !== 'APPROVED')
        throw new BadRequestException('先审核通过，再记录实际退款');
      if (b.decision === 'COMPLETED') {
        if (x.amountCents > r.feeCents && ownerIds(u).includes(x.approvedBy ?? x.handledBy ?? ''))
          throw new ForbiddenException('超过应收费用的退款须由另一位财务管理员复核并登记实际退款');
        if (!b.reference?.trim()) throw new BadRequestException('请填写实际退款参考号');
        if (x.amountCents > r.netPaidCents) throw new BadRequestException('余额不足');
        if (
          await tx.invoiceRequest.count({
            where: { registrationId: r.id, status: { in: ['REQUESTED', 'ISSUED'] } },
          })
        )
          throw new BadRequestException('请先取消申请或作废发票，再完成退款');
        if (b.attachmentId) await bindFile(tx, u, b.attachmentId, r.id);
        await tx.ledgerEntry.create({
          data: {
            registrationId: r.id,
            contestId: r.contestId,
            kind: 'REFUND',
            amountCents: -x.amountCents,
            sourceId: `refund:${id}`,
            channelReference: `refund:${b.reference}`,
            actorId: u.id,
            note: x.reason,
          },
        });
        await balanceChange(tx, r, -x.amountCents);
      }
      const result = await tx.refund.update({
        where: { id },
        data: {
          status: b.decision,
          reference: b.reference,
          attachmentId: b.attachmentId,
          handledBy: u.id,
          ...(b.decision === 'APPROVED' ? { approvedBy: u.id } : {}),
          completedAt: b.decision === 'COMPLETED' ? new Date() : null,
        },
      });
      await audit(tx, u.id, 'REFUND_REVIEW', r.id, { refundId: id, decision: b.decision });
      await financeNotify(tx, r, { message: `退款处理：${b.decision}` });
      if (r.registration) await refresh(tx, r.id);
      return result;
    });
  }
  async invoice(u: Principal, id: string, body: unknown) {
    const b = invoiceSchema.parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      const invoicePolicy = policySchema.parse(r.contest.policy);
      if (!invoicePolicy.invoicesEnabled) throw new BadRequestException('此竞赛未开启开票');
      if (!invoicePolicy.invoiceTypes.includes(b.invoiceType))
        throw new BadRequestException('此竞赛未开放该票种');
      for (const key of invoicePolicy.invoiceRequiredFields)
        if (!b[key].trim())
          throw new BadRequestException(
            `开票方要求填写 ${{ contactName: '联系人', phone: '联系电话', address: '地址', bankName: '开户银行', bankAccount: '银行账号' }[key]}`,
          );
      const total = await tx.invoiceRequest.aggregate({
        where: { registrationId: id, status: { in: ['REQUESTED', 'ISSUED'] } },
        _sum: { amountCents: true },
      });
      if (b.amountCents > r.netPaidCents - (total._sum.amountCents ?? 0))
        throw new BadRequestException('金额超过可开票余额');
      const x = await tx.invoiceRequest.create({
        data: { ...b, snapshot: json(b), registrationId: id },
      });
      await audit(tx, u.id, 'INVOICE_REQUEST', id, { invoiceId: x.id });
      await financeNotify(tx, r, {
        message: '开票申请已提交，等待管理员上传发票。',
        category: 'INVOICE',
        status: 'REQUESTED',
      });
      return x;
    });
  }
  async invoiceDecision(u: Principal, id: string, body: unknown) {
    const b = z
      .object({
        decision: z.enum(['ISSUED', 'REJECTED', 'VOID']),
        attachmentId: z.string().uuid().optional(),
        reason: z.string().max(3000).default(''),
      })
      .parse(body);
    const x = await db.invoiceRequest.findUniqueOrThrow({ where: { id } });
    return db.$transaction(async (tx) => {
      await lock(tx, x.registrationId);
      const r = await loaded(tx, x.registrationId);
      requireManager(u, r.contestId, 'FINANCE');
      const current = await tx.invoiceRequest.findUniqueOrThrow({ where: { id } });
      if (current.status === b.decision) return current;
      if (
        (b.decision === 'VOID' && current.status !== 'ISSUED') ||
        (b.decision !== 'VOID' && current.status !== 'REQUESTED')
      )
        throw new BadRequestException('发票状态不允许此操作');
      if (b.decision === 'ISSUED') {
        if (!b.attachmentId) throw new BadRequestException('请上传实际发票');
        await bindFile(tx, u, b.attachmentId, r.id);
      }
      if (b.decision === 'REJECTED' && !b.reason.trim())
        throw new BadRequestException('请填写拒绝开票原因');
      const out = await tx.invoiceRequest.update({
        where: { id },
        data: {
          status: b.decision,
          attachmentId: b.attachmentId,
          handledBy: u.id,
          reason: b.reason,
        },
      });
      await audit(tx, u.id, 'INVOICE_REVIEW', r.id, { invoiceId: id, decision: b.decision });
      await financeNotify(tx, r, {
        message: `开票处理：${b.decision}`,
        category: 'INVOICE',
        status: b.decision,
      });
      await event(tx, 'MAIL', r.id, {
        to: current.email,
        subject: '开票申请处理结果',
        text: `开票状态：${b.decision}${b.reason ? `；${b.reason}` : ''}`,
        category: 'INVOICE',
        actionPath: `/finance/${r.id}`,
        finance: true,
      });
      return out;
    });
  }
}
