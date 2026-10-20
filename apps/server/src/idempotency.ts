import {
  ConflictException,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { getFinance } from './finance-accounts.js';
import { db, atomicRequest, lock, json } from './db.js';
import {
  sha,
  encrypt,
  decrypt,
  getRegistration,
  getSupportTicket,
  requireAdmin,
  requireManager,
} from './security.js';
import type { AuthRequest } from './auth.js';
// Auth endpoints and uploads are excluded. Registration/finance writes and their
// replay record use a single database transaction, including concurrent retries.
export class Idempotency implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const key = req.headers['idempotency-key'];
    if (
      req.method === 'GET' ||
      !req.principal ||
      !key ||
      req.path.includes('/auth/') ||
      req.path.endsWith('/admissions/batch') ||
      /\/platform-exports\/*$/i.test(req.path) ||
      req.path.endsWith('/files')
    )
      return next.handle();
    return defer(async () => {
      const actor = req.principal!;
      const id = sha(`${actor.id}:${String(key).slice(0, 200)}`);
      const fingerprint = sha(JSON.stringify([req.method, req.originalUrl, req.body]));
      return atomicRequest(async () => {
        await lock(db, id);
        const existing = await db.idempotencyRecord.findUnique({ where: { id } });
        const expired = existing && existing.createdAt.getTime() <= Date.now() - 86400000;
        if (existing && expired) await db.idempotencyRecord.delete({ where: { id } });
        if (existing && !expired) {
          if (existing.requestHash !== fingerprint)
            throw new ConflictException('此幂等键已用于不同请求');
          const [, , , module, resource, resourceId] = req.path.split('/');
          const savedResult = existing.result as Record<string, unknown>;
          const decoded = savedResult.encrypted
            ? JSON.parse(decrypt(String(savedResult.encrypted)))
            : existing.result;
          if ((decoded as any)?.deleted) return decoded;
          if (module === 'registrations' && resource) await getRegistration(actor, resource);
          if (module === 'admin') requireAdmin(actor);
          if (module === 'contests') {
            if (resource) requireManager(actor, resource);
            else requireAdmin(actor);
          }
          if (module === 'integrations') {
            if (resource === 'registrations' && resourceId)
              await getRegistration(actor, resourceId);
            else requireAdmin(actor);
          }
          if (module === 'admissions') {
            if (req.body.contestId) requireManager(actor, req.body.contestId);
            else if (req.body.registrationIds)
              for (const registrationId of req.body.registrationIds) {
                const r = await getFinance(actor, registrationId);
                requireManager(actor, r.contestId);
              }
            else requireAdmin(actor);
          }
          if (module === 'finance' && resource) {
            let registrationId: string | undefined = resource;
            if (resourceId) {
              const record =
                resource === 'vouchers'
                  ? await db.paymentVoucher.findUnique({ where: { id: resourceId } })
                  : resource === 'refunds'
                    ? await db.refund.findUnique({ where: { id: resourceId } })
                    : resource === 'invoices'
                      ? await db.invoiceRequest.findUnique({ where: { id: resourceId } })
                      : resource === 'ledger'
                        ? await db.ledgerEntry.findUnique({ where: { id: resourceId } })
                        : null;
              if (record) registrationId = record.registrationId;
            }
            if (registrationId && /^[0-9a-f-]{36}$/.test(registrationId))
              await getFinance(actor, registrationId);
          }
          if (module === 'support' && resource) {
            await getSupportTicket(actor, resource);
          }
          const stored = existing.result as Record<string, unknown>;
          return stored.encrypted ? JSON.parse(decrypt(String(stored.encrypted))) : existing.result;
        }
        const result = await lastValueFrom(next.handle());
        await db.idempotencyRecord.create({
          data: {
            id,
            requestHash: fingerprint,
            resourceType: req.path.includes('/finance/')
              ? 'FINANCE'
              : req.path.includes('/registrations')
                ? 'REGISTRATION'
                : 'OTHER',
            resourceId:
              req.path.match(/\/registrations\/([0-9a-f-]{36})(?:\/|$)/)?.[1] ??
              ((result as any)?.contestId && (result as any)?.id ? (result as any).id : null),
            result: json({ encrypted: encrypt(JSON.stringify(result ?? { ok: true })) }),
          },
        });
        return result;
      });
    });
  }
}
