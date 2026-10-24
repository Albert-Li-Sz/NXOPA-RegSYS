import {
  ConflictException,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { getFinance, canEditFinance } from './finance-accounts.js';
import { db, atomicRequest, lock, json } from './db.js';
import {
  sha,
  encrypt,
  decrypt,
  getRegistration,
  getSupportTicket,
  requireAdmin,
  requireSystemAdmin,
  requireManager,
  canEdit,
  owns,
} from './security.js';
import type { AuthRequest } from './auth.js';
// Auth endpoints and uploads are excluded. Registration/finance writes and their
// replay record use a single database transaction, including concurrent retries.
export class Idempotency implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const key = req.headers['idempotency-key'];
    const pathname = req.path.toLowerCase().replace(/\/+$/, '');
    if (
      req.method === 'GET' ||
      !req.principal ||
      !key ||
      pathname.includes('/auth/') ||
      pathname.endsWith('/admissions/batch') ||
      pathname.includes('/seating/') ||
      pathname.includes('/admission-batches') ||
      pathname.endsWith('/admissions/generate') ||
      pathname.endsWith('/admissions/preview') ||
      pathname.endsWith('/files') ||
      !['registrations', 'finance', 'contests', 'admin', 'admissions', 'support', 'files'].includes(
        pathname.split('/')[3] ?? '',
      ) ||
      /\/jobs\/[^/]+\/retry$/.test(pathname)
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
          const [, , , module, resource, resourceId] = pathname.split('/');
          const savedResult = existing.result as Record<string, unknown>;
          const decoded = savedResult.encrypted
            ? JSON.parse(decrypt(String(savedResult.encrypted)))
            : existing.result;
          if (module === 'registrations' && resource) {
            if ((decoded as any)?.deleted) {
              const access = savedResult.access as
                { ownerId?: string; contestId?: string } | undefined;
              if (!owns(actor, access?.ownerId ?? ''))
                requireManager(actor, access?.contestId ?? '', 'REGISTRATIONS');
            } else {
              const r = await getRegistration(actor, resource);
              if (resourceId === 'review' || resourceId === 'public-rank')
                requireManager(actor, r.contestId, 'REGISTRATIONS');
              else if (
                !canEdit(actor, r) &&
                !(
                  resourceId === 'people' &&
                  r.people.some(
                    (p) => p.id === pathname.split('/')[6] && p.userId && owns(actor, p.userId),
                  )
                )
              )
                requireManager(actor, r.contestId, 'REGISTRATIONS');
            }
          }
          if (module === 'admin') {
            if (resource === 'grants' && req.body?.level && req.body.level !== 'CONTEST')
              requireSystemAdmin(actor);
            else if (['fields', 'users', 'roles', 'invitations', 'grants'].includes(resource ?? ''))
              requireAdmin(actor);
            else requireSystemAdmin(actor);
          }
          if (module === 'contests') {
            if (req.method === 'DELETE' && !resourceId) requireAdmin(actor);
            else if (resource)
              requireManager(
                actor,
                resource,
                resourceId === 'files'
                  ? 'FILES'
                  : resourceId === 'rooms'
                    ? 'ADMISSIONS'
                    : 'CONTEST',
              );
            else requireAdmin(actor);
          }
          if (module === 'admissions') {
            if (req.body.contestId) requireManager(actor, req.body.contestId, 'ADMISSIONS');
            else if (resource && /^[0-9a-f-]{36}$/i.test(resource)) {
              const document = await db.admissionDocument.findUniqueOrThrow({
                where: { id: resource },
              });
              const r = await getRegistration(actor, document.registrationId);
              requireManager(actor, r.contestId, 'ADMISSIONS');
            } else if (req.body.registrationIds)
              for (const registrationId of req.body.registrationIds) {
                const r = await getRegistration(actor, registrationId);
                requireManager(actor, r.contestId, 'ADMISSIONS');
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
            if (registrationId && /^[0-9a-f-]{36}$/i.test(registrationId)) {
              if (resourceId === 'attribution') requireSystemAdmin(actor);
              const account = await getFinance(actor, registrationId);
              if (resourceId === 'reconciliation')
                requireManager(actor, account.contestId, 'FINANCE');
              if (!resourceId && !canEditFinance(actor, account))
                requireManager(actor, account.contestId, 'FINANCE');
              if (resourceId && ['vouchers', 'refunds', 'invoices', 'ledger'].includes(resource)) {
                const r = await getFinance(actor, registrationId);
                requireManager(actor, r.contestId, 'FINANCE');
              }
            }
          }
          if (module === 'support' && resource) {
            await getSupportTicket(actor, resource);
          }
          if (module === 'files' && resource) {
            const file = await db.attachment.findUniqueOrThrow({ where: { id: resource } });
            if (!owns(actor, file.ownerId) && !actor.isAdmin)
              requireManager(actor, file.contestId ?? '', 'FILES');
          }
          const stored = existing.result as Record<string, unknown>;
          return stored.encrypted ? JSON.parse(decrypt(String(stored.encrypted))) : existing.result;
        }
        const resource = pathname.match(/\/registrations\/([0-9a-f-]{36})(?:\/|$)/)?.[1];
        const access = resource
          ? await db.registration.findUnique({
              where: { id: resource },
              select: { ownerId: true, contestId: true },
            })
          : null;
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
            result: json({ encrypted: encrypt(JSON.stringify(result ?? { ok: true })), access }),
          },
        });
        return result;
      });
    });
  }
}
