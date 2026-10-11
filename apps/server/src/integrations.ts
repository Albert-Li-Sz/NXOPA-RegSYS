import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
  policySchema,
  fieldsSchema,
  provisioningResultSchema,
  type Principal,
  type ConnectorConfiguration,
  type RegistrationEnvelopeV1,
  type Answers,
} from '@contest-center/contracts';
import { connector } from '@contest-center/connectors';
import {
  db,
  json,
  audit,
  lock,
  enqueue,
  registrationInclude,
  type Registration,
  type Tx,
} from './db.js';
import { config } from './config.js';
import {
  decrypt,
  encrypt,
  opaqueToken,
  sha,
  safeUrl,
  requireAdmin,
  requireManager,
  manages,
  getRegistration,
  checkVersion,
} from './security.js';
import { rateLimit } from './auth.js';
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
export async function platformConfig(
  bindingId: string,
): Promise<{ configuration: ConnectorConfiguration; type: string }> {
  const b = await db.platformBinding.findUniqueOrThrow({
    where: { id: bindingId },
    include: { instance: true },
  });
  if (!b.enabled || !b.instance.enabled) throw new Error('Platform binding disabled');
  await safeUrl(b.instance.baseUrl);
  return {
    type: b.instance.type,
    configuration: {
      baseUrl: b.instance.baseUrl,
      credentials: JSON.parse(decrypt(b.instance.credentials)),
      remoteContestId: b.remoteContestId,
      domainId: b.domainId,
      groupIds: b.groupIds as string[],
      organizationId: b.organizationId ?? undefined,
    },
  };
}
export async function scheduleSync(tx: Tx, registrationId: string, bindingId: string) {
  await lock(tx, registrationId);
  const r = await tx.registration.findUniqueOrThrow({ where: { id: registrationId } });
  if (!r.eligible) throw new BadRequestException('报名尚未取得参赛资格');
  const b = await tx.platformBinding.findUniqueOrThrow({
    where: { id: bindingId },
    include: { instance: true },
  });
  if (b.contestId !== r.contestId || !b.enabled || !b.instance.enabled)
    throw new BadRequestException('平台绑定不属于此竞赛或已停用');
  const username = `cc_${sha(`${bindingId}:${registrationId}`).slice(0, 24)}`;
  const m = await tx.accountMapping.upsert({
    where: { registrationId_bindingId: { registrationId, bindingId } },
    create: {
      registrationId,
      bindingId,
      username,
      credential: encrypt(opaqueToken().slice(0, 24)),
    },
    update: {},
  });
  const job = await enqueue(tx, 'SYNC', registrationId, `sync:${m.id}:${r.version}`, {
    mappingId: m.id,
    version: r.version,
  });
  return { mappingId: m.id, jobId: job.id, state: job.state };
}
export async function verifyCallback(id: string, body: unknown) {
  const b = z
    .object({
      bindingId: z.string().uuid(),
      registrationVersion: z.number().int(),
      result: provisioningResultSchema,
    })
    .parse(body);
  const r = await db.registration.findUniqueOrThrow({
    where: { id },
    include: registrationInclude,
  });
  if (
    !r.eligible ||
    r.version !== b.registrationVersion ||
    b.result.registrationId !== id ||
    b.result.state !== 'VERIFIED'
  )
    throw new BadRequestException('回调与当前报名版本或资格不符');
  const mapping = await db.accountMapping.findUniqueOrThrow({
    where: { registrationId_bindingId: { registrationId: id, bindingId: b.bindingId } },
  });
  const c = await platformConfig(b.bindingId);
  const verified = await connector(c.type).getProvisioningResult(c.configuration, {
    envelope: await envelope(r),
    username: mapping.username,
    password: decrypt(mapping.credential),
  });
  if (
    verified.remoteUserId !== b.result.remoteUserId ||
    verified.remoteTeamId !== b.result.remoteTeamId
  )
    throw new BadRequestException('回调结果未通过远端核验');
  return db.$transaction(async (tx) => {
    await lock(tx, id);
    const current = await tx.registration.findUniqueOrThrow({ where: { id } });
    if (!current.eligible || current.version !== b.registrationVersion)
      throw new BadRequestException('报名在核验期间已变更');
    await tx.accountMapping.update({
      where: { id: mapping.id },
      data: {
        state: 'VERIFIED',
        remoteUserId: verified.remoteUserId,
        remoteTeamId: verified.remoteTeamId,
        details: json(verified),
      },
    });
    await audit(tx, 'integration', 'PROVISION_CALLBACK', id, { mappingId: mapping.id });
    return verified;
  });
}
export class IntegrationService {
  async instances(u: Principal) {
    if (!u.isAdmin && !u.contestIds.length) throw new ForbiddenException();
    return db.platformInstance.findMany({
      where: u.isAdmin
        ? {}
        : { OR: u.contestIds.map((id) => ({ allowedContestIds: { array_contains: [id] } })) },
      select: {
        id: true,
        name: true,
        type: true,
        baseUrl: true,
        enabled: true,
        version: true,
        allowedContestIds: true,
      },
    });
  }
  async instance(u: Principal, body: unknown, id?: string) {
    requireAdmin(u);
    const b = z
      .object({
        name: z.string().min(1).max(100),
        type: z.enum(['HYDRO', 'DOMJUDGE']),
        baseUrl: z.url(),
        credentials: z.object({
          username: z.string().optional(),
          password: z.string().optional(),
          token: z.string().optional(),
        }),
        allowedContestIds: z.array(z.string().uuid()).default([]),
        enabled: z.boolean().default(true),
        version: z.number().int().optional(),
      })
      .parse(body);
    await safeUrl(b.baseUrl);
    const { credentials, ...rest } = b;
    const current = id ? await db.platformInstance.findUniqueOrThrow({ where: { id } }) : null;
    if (current) checkVersion(current.version, b.version);
    const savedCredentials: Record<string, string> =
      current?.type === b.type ? JSON.parse(decrypt(current.credentials)) : {};
    for (const [key, value] of Object.entries(credentials)) {
      if (value !== undefined && value !== '') savedCredentials[key] = value;
    }
    const nextCredentials =
      b.type === 'HYDRO'
        ? { token: savedCredentials.token }
        : { username: savedCredentials.username, password: savedCredentials.password };
    if (b.type === 'HYDRO' && (nextCredentials.token?.trim().length ?? 0) < 32)
      throw new BadRequestException('Hydro 插件 Token 至少 32 位');
    if (b.type === 'DOMJUDGE' && (!nextCredentials.username?.trim() || !nextCredentials.password))
      throw new BadRequestException('请配置 DOMjudge API 用户名与密码');
    const data = { ...rest, allowedContestIds: json(b.allowedContestIds) };
    const saved = id
      ? await db.platformInstance.update({
          where: { id, version: b.version },
          data: {
            ...data,
            version: { increment: 1 },
            credentials: encrypt(JSON.stringify(nextCredentials)),
          },
        })
      : await db.platformInstance.create({
          data: { ...data, version: 1, credentials: encrypt(JSON.stringify(nextCredentials)) },
        });
    return { id: saved.id };
  }
  async bindings(u: Principal, contestId: string) {
    requireManager(u, contestId);
    return db.platformBinding.findMany({
      where: { contestId },
      include: { instance: { select: { id: true, name: true, type: true } } },
    });
  }
  async bind(u: Principal, body: unknown) {
    const b = z
      .object({
        contestId: z.string().uuid(),
        instanceId: z.string().uuid(),
        remoteContestId: z.string().min(1).max(100),
        domainId: z.string().max(100).default('system'),
        groupIds: z.array(z.string()).max(1).default([]),
        organizationId: z.string().optional(),
        automatic: z.boolean().default(true),
        enabled: z.boolean().default(true),
      })
      .parse(body);
    requireManager(u, b.contestId);
    const instance = await db.platformInstance.findUniqueOrThrow({ where: { id: b.instanceId } });
    if (!u.isAdmin && !(instance.allowedContestIds as string[]).includes(b.contestId))
      throw new ForbiddenException('该竞赛未获授权使用此平台实例');
    return db.platformBinding.upsert({
      where: {
        contestId_instanceId_remoteContestId: {
          contestId: b.contestId,
          instanceId: b.instanceId,
          remoteContestId: b.remoteContestId,
        },
      },
      create: { ...b, organizationId: b.organizationId || null, groupIds: json(b.groupIds) },
      update: { ...b, organizationId: b.organizationId || null, groupIds: json(b.groupIds) },
    });
  }
  async probe(u: Principal, id: string) {
    const b = await db.platformBinding.findUniqueOrThrow({ where: { id } });
    requireManager(u, b.contestId);
    const c = await platformConfig(id);
    try {
      return await connector(c.type).probe(c.configuration);
    } catch (e) {
      throw new BadRequestException(
        `连接探测失败：${e instanceof Error ? e.message : '平台暂未响应'}`,
      );
    }
  }
  async sync(u: Principal, id: string, body: unknown) {
    const { bindingId } = z.object({ bindingId: z.string().uuid() }).parse(body);
    const r = await getRegistration(u, id);
    requireManager(u, r.contestId);
    return db.$transaction((tx) => scheduleSync(tx, id, bindingId));
  }
  async credentials(u: Principal, id: string) {
    const r = await getRegistration(u, id);
    if (
      policySchema.parse(r.policySnapshot ?? r.contest.policy).mode === 'INDIVIDUAL' &&
      r.ownerId !== u.id &&
      !manages(u, r.contestId)
    )
      throw new ForbiddenException('个人比赛账号仅向参赛者本人及管理员交付');
    if (!r.eligible && !manages(u, r.contestId))
      throw new ForbiddenException('此报名暂不能领取比赛账号');
    const rows = await db.accountMapping.findMany({
      where: { registrationId: id, state: 'VERIFIED' },
    });
    await db.$transaction((tx) => audit(tx, u.id, 'CREDENTIAL_VIEW', id));
    return rows.map((x) => ({
      id: x.id,
      username: x.username,
      password: decrypt(x.credential),
      bindingId: x.bindingId,
    }));
  }
  async jobs(u: Principal) {
    if (!u.isAdmin && !u.contestIds.length) throw new ForbiddenException();
    const regs = u.isAdmin
      ? undefined
      : (
          await db.registration.findMany({
            where: { contestId: { in: u.contestIds } },
            select: { id: true },
          })
        ).map((r) => r.id);
    return db.job.findMany({
      where: regs ? { resourceId: { in: regs } } : {},
      select: {
        id: true,
        kind: true,
        resourceId: true,
        state: true,
        attempts: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  async retry(u: Principal, id: string) {
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    if (!u.isAdmin) {
      const r = await getRegistration(u, job.resourceId);
      requireManager(u, r.contestId);
    }
    if (!['FAILED', 'PENDING'].includes(job.state)) throw new BadRequestException('任务不能重试');
    return db.job.update({
      where: { id },
      data: { state: 'PENDING', error: null, attempts: 0 },
      select: { id: true, state: true },
    });
  }
  async token(u: Principal, body: unknown) {
    requireAdmin(u);
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
              'integration:write',
            ]),
          )
          .min(1),
        fields: z.array(z.string()).default(['PERSON.name']),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .parse(body);
    const token = opaqueToken();
    const row = await db.apiToken.create({
      data: {
        ...b,
        contestIds: json(b.contestIds),
        scopes: json(b.scopes),
        fields: json(b.fields),
        expiresAt: new Date(b.expiresAt),
        tokenHash: sha(token),
      },
    });
    return { id: row.id, token };
  }
  async tokens(u: Principal) {
    requireAdmin(u);
    return db.apiToken.findMany({
      select: {
        id: true,
        name: true,
        contestIds: true,
        scopes: true,
        fields: true,
        expiresAt: true,
        revoked: true,
      },
    });
  }
  async revokeToken(u: Principal, id: string) {
    requireAdmin(u);
    await db.apiToken.update({ where: { id }, data: { revoked: true } });
    return { ok: true };
  }
  async webhook(u: Principal, body: unknown) {
    const b = z.object({ contestId: z.string().uuid().optional(), url: z.url() }).parse(body);
    if (b.contestId) requireManager(u, b.contestId);
    else requireAdmin(u);
    await safeUrl(b.url);
    const secret = opaqueToken();
    const row = await db.webhook.create({ data: { ...b, secret: encrypt(secret) } });
    return { id: row.id, secret };
  }
}
export async function apiPrincipal(req: Request, scope: string) {
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  const token = await db.apiToken.findUnique({ where: { tokenHash: sha(bearer) } });
  if (!token || token.revoked || token.expiresAt < new Date())
    throw new UnauthorizedException('API Token 已失效');
  if (!(token.scopes as string[]).includes(scope))
    throw new ForbiddenException('API Token 未授权此操作');
  await rateLimit(`api:${token.id}`, 300);
  return token;
}
export function apiContest(token: { contestIds: unknown }, id: string) {
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
  };
}
