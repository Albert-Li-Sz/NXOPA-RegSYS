import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@contest-center/contracts';
import { db, audit, event, lock } from './db.js';
import { loaded, policy, refresh } from './registrations.js';
import { canEdit, requireManager, checkVersion } from './security.js';
import { bindFile } from './files.js';
const cents = z.number().int().positive().max(100_000_000);
export class FinanceService {
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
      if (p.paymentSequence === 'REVIEW_FIRST' && p.manualReview && r.review !== 'APPROVED')
        throw new BadRequestException('请先等待审核通过');
      await bindFile(tx, u, b.attachmentId, id);
      const v = await tx.paymentVoucher.create({
        data: {
          ...b,
          reference: b.reference?.trim() || null,
          paidAt: new Date(b.paidAt),
          registrationId: id,
        },
      });
      await audit(tx, u.id, 'VOUCHER_UPLOAD', id, { voucherId: v.id });
      await event(tx, 'NOTIFY', id, { message: '缴费凭证已上传，等待管理员核账。' });
      return v;
    });
  }
  async confirm(u: Principal, id: string, body: unknown) {
    const b = z
      .object({
        decision: z.enum(['CONFIRMED', 'REJECTED']),
        reason: z.string().max(3000).default(''),
        amountCents: cents.optional(),
      })
      .parse(body);
    const v = await db.paymentVoucher.findUniqueOrThrow({ where: { id } });
    return db.$transaction(async (tx) => {
      await lock(tx, v.registrationId);
      const r = await loaded(tx, v.registrationId);
      requireManager(u, r.contestId);
      const current = await tx.paymentVoucher.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'PENDING') {
        if (current.status === b.decision) return current;
        throw new BadRequestException('该凭证已经核账，需要通过冲正更正');
      }
      if (b.decision === 'REJECTED' && !b.reason) throw new BadRequestException('请填写拒绝原因');
      const amount = b.amountCents ?? v.amountCents;
      const result = await tx.paymentVoucher.update({
        where: { id },
        data: { status: b.decision, reason: b.reason, amountCents: amount, confirmedBy: u.id },
      });
      if (b.decision === 'CONFIRMED') {
        await tx.ledgerEntry.create({
          data: {
            registrationId: r.id,
            contestId: r.contestId,
            kind: 'PAYMENT',
            amountCents: amount,
            sourceId: `voucher:${id}`,
            channelReference: v.reference ? `${v.channel}:${v.reference}` : null,
            actorId: u.id,
            note: b.reason || '管理员确认线下实际到账',
          },
        });
        await tx.registration.update({
          where: { id: r.id },
          data: { netPaidCents: { increment: amount }, version: { increment: 1 } },
        });
      }
      await audit(tx, u.id, 'VOUCHER_REVIEW', r.id, {
        voucherId: id,
        decision: b.decision,
        amountCents: amount,
      });
      await event(tx, 'NOTIFY', r.id, { message: `缴费核账：${b.decision}。${b.reason}` });
      await refresh(tx, r.id);
      return result;
    });
  }
  async reverse(u: Principal, id: string, body: unknown) {
    const { reason } = z.object({ reason: z.string().min(1).max(3000) }).parse(body);
    const e = await db.ledgerEntry.findUniqueOrThrow({ where: { id } });
    return db.$transaction(async (tx) => {
      await lock(tx, e.registrationId);
      const r = await loaded(tx, e.registrationId);
      requireManager(u, r.contestId);
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
      await tx.registration.update({
        where: { id: r.id },
        data: { netPaidCents: { decrement: e.amountCents }, version: { increment: 1 } },
      });
      await audit(tx, u.id, 'PAYMENT_REVERSE', r.id, { ledgerId: id, reason });
      await event(tx, 'NOTIFY', r.id, { message: '收款已冲正，请查看账簿与资格状态。' });
      await refresh(tx, r.id);
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
      const x = await tx.refund.create({ data: { ...b, registrationId: id } });
      await audit(tx, u.id, 'REFUND_REQUEST', id, { refundId: x.id });
      await event(tx, 'NOTIFY', id, { message: '退款申请已提交，等待管理员处理。' });
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
      requireManager(u, r.contestId);
      const x = await tx.refund.findUniqueOrThrow({ where: { id } });
      if (x.status === b.decision) return x;
      if (['REJECTED', 'COMPLETED'].includes(x.status)) throw new BadRequestException('退款已结束');
      if (b.decision === 'COMPLETED' && x.status !== 'APPROVED')
        throw new BadRequestException('先审核通过，再记录实际退款');
      if (b.decision === 'COMPLETED') {
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
        await tx.registration.update({
          where: { id: r.id },
          data: { netPaidCents: { decrement: x.amountCents }, version: { increment: 1 } },
        });
      }
      const result = await tx.refund.update({
        where: { id },
        data: {
          status: b.decision,
          reference: b.reference,
          attachmentId: b.attachmentId,
          handledBy: u.id,
          completedAt: b.decision === 'COMPLETED' ? new Date() : null,
        },
      });
      await audit(tx, u.id, 'REFUND_REVIEW', r.id, { refundId: id, decision: b.decision });
      await event(tx, 'NOTIFY', r.id, { message: `退款处理：${b.decision}` });
      await refresh(tx, r.id);
      return result;
    });
  }
  async invoice(u: Principal, id: string, body: unknown) {
    const b = z
      .object({
        amountCents: cents,
        title: z.string().min(1).max(200),
        taxId: z.string().max(100),
        email: z.email(),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      if (!policy(r).invoicesEnabled) throw new BadRequestException('此竞赛未开启开票');
      const total = await tx.invoiceRequest.aggregate({
        where: { registrationId: id, status: { in: ['REQUESTED', 'ISSUED'] } },
        _sum: { amountCents: true },
      });
      if (b.amountCents > r.netPaidCents - (total._sum.amountCents ?? 0))
        throw new BadRequestException('金额超过可开票余额');
      const x = await tx.invoiceRequest.create({ data: { ...b, registrationId: id } });
      await audit(tx, u.id, 'INVOICE_REQUEST', id, { invoiceId: x.id });
      await event(tx, 'NOTIFY', id, { message: '开票申请已提交，等待管理员上传发票。' });
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
      requireManager(u, r.contestId);
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
      await event(tx, 'NOTIFY', r.id, { message: `开票处理：${b.decision}` });
      return out;
    });
  }
}
