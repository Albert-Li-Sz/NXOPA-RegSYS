import { webhookTarget } from './webhook-http.js';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
  policySchema,
  fieldsSchema,
  organizationSchema,
  type Principal,
  type RegistrationEnvelopeV1,
  type Answers,
} from '@contest-center/contracts';
import { db, json, audit, lock, type Registration } from './db.js';
import { effectiveAuthorization, activeGrantWhere } from './authorization.js';
import { modulesFor } from './workflow.js';
import {
  decrypt,
  encrypt,
  opaqueToken,
  sha,
  requireSystemAdmin,
  requireManager,
  getRegistration,
} from './security.js';
import { rateLimit } from './auth.js';
import { paginated, dateFilter, type ListQuery } from './pagination.js';
export async function envelope(r: Registration): Promise<RegistrationEnvelopeV1> {
  const instance = await db.setting.upsert({
    where: { key: 'instance' },
    create: { key: 'instance', value: { id: randomUUID() } },
    update: {},
  });
  const snapshot = (r.snapshot ?? {}) as Record<string, unknown>;
  return {
    schemaVersion: 1,
    sourceInstance: String((instance.value as Record<string, unknown>).id),
    registrationId: r.id,
    registrationVersion: r.version,
    contest: {
      id: r.contestId,
      title: r.contest.title,
      mode: policySchema.parse(r.policySnapshot ?? r.contest.policy).mode,
    },
    teamName: r.teamName,
    teamEnglishName: r.teamEnglishName,
    participationType: r.participationType as 'OFFICIAL' | 'UNOFFICIAL',
    ...(r.organization ? { organization: organizationSchema.parse(r.organization) } : {}),
    people: r.people.map((p) => ({
      id: p.id,
      name: p.name,
      captain: p.captain,
      email: p.email,
      answers: p.answers as Answers,
    })),
    form: {
      version: r.formVersion,
      fields: fieldsSchema.parse(snapshot.fields ?? []),
      answers: r.answers as Answers,
    },
    coaches: r.coaches.map((c) => ({
      id: c.id,
      name: c.user.name,
      email: c.user.email,
      answers: c.answers as Answers,
    })),
    qualification: {
      eligible: r.eligible,
      review: r.review,
      feeCents: r.feeCents,
      netPaidCents: r.netPaidCents,
    },
  };
}
export async function scopedEnvelope(r: Registration, fields: string[]) {
  const e = await envelope(r);
  const answers = (scope: string, a: Answers) =>
    Object.fromEntries(Object.entries(a).filter(([k]) => fields.includes(`${scope}.${k}`)));
  return {
    ...e,
    organization: fields.includes('REGISTRATION.organization') ? e.organization : undefined,
    participationType: fields.includes('REGISTRATION.participationType')
      ? e.participationType
      : undefined,
    people: e.people.map((p) => ({
      id: p.id,
      captain: p.captain,
      ...(fields.includes('PERSON.name') ? { name: p.name } : {}),
      ...(fields.includes('PERSON.email') ? { email: p.email } : {}),
      answers: answers('PERSON', p.answers ?? {}),
    })),
    coaches: e.coaches?.map((c) => ({
      id: c.id,
      ...(fields.includes('COACH.name') ? { name: c.name } : {}),
      ...(fields.includes('COACH.email') ? { email: c.email } : {}),
      answers: answers('COACH', c.answers),
    })),
    form: {
      version: e.form!.version,
      fields: e.form!.fields.filter((f) => fields.includes(`${f.scope}.${f.key}`)),
      answers: {
        registration: answers('REGISTRATION', (e.form!.answers.registration ?? {}) as Answers),
        team: answers('TEAM', (e.form!.answers.team ?? {}) as Answers),
      },
    },
    qualification: {
      eligible: r.eligible,
      review: r.review,
      ...(fields.includes('FINANCE.summary')
        ? { feeCents: r.feeCents, netPaidCents: r.netPaidCents }
        : {}),
    },
  };
}
export class IntegrationService {
  async jobs(u: Principal, query: ListQuery = {}) {
    if (!u.isAdmin && !u.contestIds.length) throw new ForbiddenException();
    const resourceGroups = u.isAdmin
      ? undefined
      : await Promise.all([
          db.registration.findMany({
            where: { contestId: { in: u.contestIds } },
            select: { id: true },
          }),
          db.financeAccount.findMany({
            where: { contestId: { in: u.contestIds } },
            select: { id: true },
          }),
          db.remoteRevocation.findMany({
            where: { contestId: { in: u.contestIds } },
            select: { registrationId: true },
          }),
        ]);
    const resources = resourceGroups
      ? [
          ...new Set([
            ...resourceGroups[0].map((r) => r.id),
            ...resourceGroups[1].map((r) => r.id),
            ...resourceGroups[2].map((r) => r.registrationId),
          ]),
        ]
      : undefined;
    const where = {
      AND: [
        ...(resources ? [{ resourceId: { in: resources } }] : []),
        ...(query.search ? [{ resourceId: { contains: query.search } }] : []),
      ],
      ...(query.status ? { state: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      createdAt: dateFilter(query),
    };
    return paginated(
      query,
      async (options) => {
        const rows = await db.job.findMany({
          where,
          select: {
            id: true,
            kind: true,
            resourceId: true,
            state: true,
            attempts: true,
            error: true,
            createdAt: true,
            updatedAt: true,
            payload: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...options,
        });
        const registrations = await db.registration.findMany({
          where: {
            id: { in: rows.filter((j) => j.kind === 'ADMISSION').map((j) => j.resourceId) },
          },
          select: { id: true, contestId: true },
        });
        const contests = new Map(registrations.map((r) => [r.id, r.contestId]));
        return rows.map(({ payload, ...row }) => {
          const permission =
            row.kind === 'ADMISSION'
              ? 'ADMISSIONS'
              : row.kind === 'WEBHOOK'
                ? 'INTEGRATIONS'
                : null;
          const contestId =
            contests.get(row.resourceId) ?? String((payload as any)?.body?.contestId ?? '');
          const allowed = permission
            ? !!(u.isAdmin || u.permissions?.[contestId]?.includes(permission))
            : !!u.isSystemAdmin;
          const authenticationMail =
            row.kind === 'MAIL' &&
            (String((payload as any)?.category ?? '').startsWith('AUTH_') ||
              (payload as any)?.category === 'ACCOUNT_CLOSE');
          return {
            ...row,
            error: allowed ? row.error : null,
            canRetry:
              row.state === 'FAILED' &&
              allowed &&
              !authenticationMail &&
              [
                'ADMISSION',
                'WEBHOOK',
                'MAIL',
                'OBJECT_DELETE',
                'SPOOL_DELETE',
                'STORAGE_MIGRATION',
                'PDF_PREVIEW',
              ].includes(row.kind),
          };
        });
      },
      () => db.job.count({ where }),
      100,
    );
  }
  async retry(u: Principal, id: string) {
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    if (
      ![
        'ADMISSION',
        'WEBHOOK',
        'MAIL',
        'OBJECT_DELETE',
        'SPOOL_DELETE',
        'STORAGE_MIGRATION',
        'PDF_PREVIEW',
      ].includes(job.kind)
    )
      throw new BadRequestException('此类任务不支持重试');
    if (job.kind === 'SYNC') throw new BadRequestException('平台同步已移除，请使用平台文件导出');
    if (job.state === 'CANCELLED') throw new BadRequestException('已删除报名的任务不可重试');
    const permissions = { ADMISSION: 'ADMISSIONS', WEBHOOK: 'INTEGRATIONS' } as const;
    if (!Object.hasOwn(permissions, job.kind)) requireSystemAdmin(u);
    if (!u.isSystemAdmin && !['ADMISSION', 'WEBHOOK'].includes(job.kind))
      throw new ForbiddenException('此类任务仅系统管理员可重试');
    if (Object.hasOwn(permissions, job.kind)) {
      const deletedContest =
        job.kind === 'WEBHOOK' ? (job.payload as any)?.body?.contestId : undefined;
      if (deletedContest) requireManager(u, String(deletedContest), 'INTEGRATIONS');
      else {
        const r = await getRegistration(u, job.resourceId);
        requireManager(u, r.contestId, permissions[job.kind as keyof typeof permissions]);
      }
    }
    if (
      job.kind === 'MAIL' &&
      (String((job.payload as any).category ?? '').startsWith('AUTH_') ||
        (job.payload as any).category === 'ACCOUNT_CLOSE')
    )
      throw new BadRequestException('验证码请在账号页面重新发送');
    if (job.kind === 'MAIL' && !u.isSystemAdmin)
      throw new ForbiddenException('请通过邮件推送页面重发业务通知');
    if (!['FAILED', 'PENDING'].includes(job.state)) throw new BadRequestException('任务不能重试');
    const changed = await db.job.updateMany({
      where: { id, state: { in: ['FAILED', 'PENDING'] }, leaseToken: null },
      data: { state: 'PENDING', error: null, attempts: 0 },
    });
    if (!changed.count) throw new BadRequestException('任务已被领取，请刷新');
    await audit(db, u.id, 'JOB_RETRY', job.resourceId, { jobId: id, kind: job.kind });
    return { id, state: 'PENDING' };
  }
  async token(u: Principal, body: unknown) {
    requireSystemAdmin(u);
    const b = z
      .object({
        name: z.string().min(1).max(100),
        contestIds: z.array(z.string().uuid()).min(1).max(1000),
        scopes: z
          .array(
            z.enum([
              'contests:read',
              'registrations:read',
              'finance:read',
              'support:read',
              'integration:read',
            ]),
          )
          .min(1),
        fields: z.array(z.string()).default(['PERSON.name']),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .parse(body);
    const token = opaqueToken();
    const grant = await db.adminGrant.findFirst({
      where: { userId: u.id, level: 'SYSTEM', ...activeGrantWhere() },
      orderBy: { createdAt: 'asc' },
    });
    if (!grant) throw new ForbiddenException('签发人的系统授权已失效');
    const expiresAt = new Date(
      Math.min(new Date(b.expiresAt).getTime(), grant.expiresAt?.getTime() ?? Infinity),
    );
    if (expiresAt <= new Date()) throw new BadRequestException('Token 到期时间必须在未来');
    const row = await db.apiToken.create({
      data: {
        ...b,
        contestIds: json(b.contestIds),
        scopes: json(b.scopes),
        fields: json(b.fields),
        expiresAt,
        tokenHash: sha(token),
        createdBy: u.id,
      },
    });
    await audit(db, u.id, 'API_TOKEN_CREATE', row.id, {
      name: row.name,
      contestIds: b.contestIds,
      scopes: b.scopes,
    });
    return { id: row.id, token, expiresAt: row.expiresAt };
  }
  async tokens(u: Principal) {
    requireSystemAdmin(u);
    return db.apiToken.findMany({
      select: {
        id: true,
        name: true,
        contestIds: true,
        scopes: true,
        fields: true,
        expiresAt: true,
        revoked: true,
        createdBy: true,
      },
    });
  }
  async revokeToken(u: Principal, id: string) {
    requireSystemAdmin(u);
    await db.apiToken.update({ where: { id }, data: { revoked: true } });
    await audit(db, u.id, 'API_TOKEN_REVOKE', id);
    return { ok: true };
  }
  async webhook(u: Principal, body: unknown) {
    const b = z
      .object({
        contestId: z.string().uuid().optional(),
        url: z.url(),
        allowPrivate: z.boolean().default(false),
      })
      .parse(body);
    if (b.contestId) requireManager(u, b.contestId, 'INTEGRATIONS');
    else requireSystemAdmin(u);
    if (b.allowPrivate) requireSystemAdmin(u);
    const approver = b.allowPrivate
      ? await db.adminGrant.findFirst({
          where: { userId: u.id, level: 'SYSTEM', ...activeGrantWhere() },
          orderBy: { createdAt: 'asc' },
        })
      : null;
    if (b.allowPrivate && !approver) throw new ForbiddenException('私网审批授权已失效');
    if (
      b.contestId &&
      !modulesFor(await db.contest.findUniqueOrThrow({ where: { id: b.contestId } })).integrations
    )
      throw new BadRequestException('此活动未启用外部联动');
    await webhookTarget(b.url, { allowPrivate: b.allowPrivate });
    const secret = opaqueToken();
    const { allowPrivate, ...data } = b;
    const row = await db.$transaction(async (tx) => {
      const hook = await tx.webhook.create({
        data: {
          ...data,
          privateApprovedBy: allowPrivate ? u.id : null,
          privateApprovalExpiresAt: approver?.expiresAt,
          secret: encrypt(secret),
        },
      });
      await audit(tx, u.id, allowPrivate ? 'WEBHOOK_PRIVATE_APPROVE' : 'WEBHOOK_CREATE', hook.id, {
        contestId: b.contestId,
        allowPrivate,
      });
      return hook;
    });
    return { id: row.id, secret };
  }
  async webhooks(u: Principal, contestId?: string) {
    if (contestId) requireManager(u, contestId, 'INTEGRATIONS');
    else requireSystemAdmin(u);
    return db.webhook.findMany({
      where: contestId ? { contestId } : {},
      select: {
        id: true,
        contestId: true,
        url: true,
        enabled: true,
        version: true,
        privateApprovedBy: true,
        privateApprovalExpiresAt: true,
      },
    });
  }
  async changeWebhook(u: Principal, id: string, body: unknown, remove = false) {
    const b = z
      .object({
        version: z.number().int(),
        enabled: z.boolean().optional(),
        rotateSecret: z.boolean().default(false),
        revokePrivate: z.boolean().default(false),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, `webhook:${id}`);
      const hook = await tx.webhook.findUniqueOrThrow({ where: { id } });
      if (hook.contestId) requireManager(u, hook.contestId, 'INTEGRATIONS');
      else requireSystemAdmin(u);
      if (hook.version !== b.version) throw new BadRequestException('Webhook 已更新，请刷新');
      if (
        b.enabled &&
        hook.contestId &&
        !modulesFor(await tx.contest.findUniqueOrThrow({ where: { id: hook.contestId } }))
          .integrations
      )
        throw new BadRequestException('此活动未启用外部联动');
      const secret = b.rotateSecret ? opaqueToken() : undefined;
      if (remove) await tx.webhook.delete({ where: { id } });
      else
        await tx.webhook.update({
          where: { id },
          data: {
            enabled: b.enabled,
            ...(secret ? { secret: encrypt(secret) } : {}),
            ...(b.revokePrivate ? { privateApprovedBy: null, enabled: false } : {}),
            version: { increment: 1 },
          },
        });
      await audit(tx, u.id, remove ? 'WEBHOOK_DELETE' : 'WEBHOOK_UPDATE', hook.contestId ?? id, {
        webhookId: id,
        rotateSecret: !!secret,
        enabled: b.enabled,
        revokePrivate: b.revokePrivate,
      });
      return { id, ...(secret ? { secret } : {}), version: hook.version + 1 };
    });
  }
}
export async function apiPrincipal(req: Request, scope: string) {
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  await rateLimit(`api-credential:${req.ip}:${sha(bearer).slice(0, 16)}`, 300);
  const token = await db.apiToken.findUnique({ where: { tokenHash: sha(bearer) } });
  if (!token || token.revoked || token.expiresAt < new Date())
    throw new UnauthorizedException('API Token 已失效');
  if (!token.createdBy || !(await effectiveAuthorization(token.createdBy)).isSystemAdmin)
    throw new UnauthorizedException('API Token 签发人授权已失效');
  if (!(token.scopes as string[]).includes(scope))
    throw new ForbiddenException('API Token 未授权此操作');
  await rateLimit(`api:${token.id}`, 300);
  return token;
}
export function apiContest(token: { contestIds: unknown }, id: string) {
  if (!id) throw new BadRequestException('请提供 contestId');
  if (!(token.contestIds as string[]).includes(id))
    throw new ForbiddenException('API Token 未授权此竞赛');
}
export function apiRegistration(r: Registration, fields: string[]) {
  const snapshot = r.snapshot as Record<string, unknown> | null;
  return {
    id: r.id,
    contestId: r.contestId,
    version: r.version,
    teamName: r.teamName,
    status: r.status,
    review: r.review,
    eligible: r.eligible,
    ...(fields.includes('REGISTRATION.participationType')
      ? { participationType: r.participationType }
      : {}),
    ...(fields.includes('REGISTRATION.organization') ? { organization: r.organization } : {}),
    people: r.people.map((p) => ({
      id: p.id,
      captain: p.captain,
      ...(fields.includes('PERSON.name') ? { name: p.name } : {}),
      ...(fields.includes('PERSON.email') ? { email: p.email } : {}),
      answers: Object.fromEntries(
        Object.entries(p.answers as Record<string, unknown>).filter(([k]) =>
          fields.includes(`PERSON.${k}`),
        ),
      ),
    })),
    coaches: r.coaches.map((c) => ({
      id: c.id,
      ...(fields.includes('COACH.name') ? { name: c.user.name } : {}),
      ...(fields.includes('COACH.email') ? { email: c.user.email } : {}),
      answers: Object.fromEntries(
        Object.entries(c.answers as Answers).filter(([key]) => fields.includes(`COACH.${key}`)),
      ),
    })),
    answers: Object.fromEntries(
      ['REGISTRATION', 'TEAM'].map((scope) => [
        scope.toLowerCase(),
        Object.fromEntries(
          Object.entries(((r.answers as Answers)[scope.toLowerCase()] ?? {}) as Answers).filter(
            ([key]) => fields.includes(`${scope}.${key}`),
          ),
        ),
      ]),
    ),
  };
}
