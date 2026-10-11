import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
  policySchema,
  fieldsSchema,
  provisioningResultSchema,
  organizationSchema,
  mergePlatformFields,
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
import { paginated, dateFilter, type ListQuery } from './pagination.js';
export function organizationKey(info: { name: string; country: string }) {
  return `${info.country}:${info.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()}`;
}
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
      importMode: b.importMode as 'FOLLOW' | 'FORCE_UNOFFICIAL',
      includeUnofficial: b.includeUnofficial,
      unofficialGroupId: b.unofficialGroupId ?? undefined,
      nickname: b.nickname,
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
  if (r.participationType === 'UNOFFICIAL' && !b.includeUnofficial) {
    await tx.accountMapping.update({
      where: { id: m.id },
      data: { state: 'SKIPPED', details: { message: '平台配置不导入非正式报名' } },
    });
    return { mappingId: m.id, state: 'SKIPPED' };
  }
  const unofficial = b.importMode === 'FORCE_UNOFFICIAL' || r.participationType === 'UNOFFICIAL';
  let school;
  if (b.instance.type === 'DOMJUDGE' && r.organization) {
    const info = organizationSchema.parse(r.organization);
    school = await tx.organizationMapping.upsert({
      where: { instanceId_nameKey: { instanceId: b.instanceId, nameKey: organizationKey(info) } },
      create: { instanceId: b.instanceId, nameKey: organizationKey(info), ...info },
      update: {},
    });
    if (school.status !== 'CONFIRMED' || !school.remoteId) {
      await tx.accountMapping.update({
        where: { id: m.id },
        data: {
          state: 'WAITING_ORGANIZATION',
          details: {
            message: '等待管理员确认学校映射',
            organizationMappingId: school.id,
            organization: json(info),
          },
        },
      });
      return { mappingId: m.id, state: 'WAITING_ORGANIZATION', organizationMappingId: school.id };
    }
  }
  if (b.instance.type === 'DOMJUDGE' && unofficial && !b.unofficialGroupId) {
    await tx.accountMapping.update({
      where: { id: m.id },
      data: { state: 'NEEDS_CONFIGURATION', details: { message: '请配置 DOMjudge 非正式分组' } },
    });
    return { mappingId: m.id, state: 'NEEDS_CONFIGURATION' };
  }
  const job = await enqueue(
    tx,
    'SYNC',
    registrationId,
    `sync:${m.id}:${r.version}:${b.version}:${b.instance.version}:${school?.version ?? 0}`,
    {
      mappingId: m.id,
      version: r.version,
      bindingVersion: b.version,
      instanceVersion: b.instance.version,
      organizationMappingId: school?.id,
      organizationVersion: school?.version,
      organizationId: school?.remoteId ?? b.organizationId,
      remoteTeamId: m.remoteTeamId ?? `cc-${sha(`${bindingId}:${registrationId}`).slice(0, 32)}`,
    },
  );
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
  const binding = await db.platformBinding.findUniqueOrThrow({
    where: { id: b.bindingId },
    include: { instance: true },
  });
  if (binding.contestId !== r.contestId || !binding.enabled || !binding.instance.enabled)
    throw new BadRequestException('回调的平台绑定不属于该报名或已停用');
  const task = await db.job.findFirst({
    where: { kind: 'SYNC', resourceId: id, payload: { path: ['mappingId'], equals: mapping.id } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const expected = task?.payload as Record<string, unknown> | undefined;
  const school =
    r.organization && binding.instance.type === 'DOMJUDGE'
      ? await db.organizationMapping.findUnique({
          where: {
            instanceId_nameKey: {
              instanceId: binding.instanceId,
              nameKey: organizationKey(organizationSchema.parse(r.organization)),
            },
          },
        })
      : null;
  if (
    !expected ||
    expected.version !== r.version ||
    expected.bindingVersion !== binding.version ||
    expected.instanceVersion !== binding.instance.version ||
    (school && (school.status !== 'CONFIRMED' || school.version !== expected.organizationVersion))
  )
    throw new BadRequestException('回调的学校或平台配置已改变，请重新发起同步');
  const c = await platformConfig(b.bindingId);
  c.configuration.organizationId = school?.remoteId ?? c.configuration.organizationId;
  const verified = await connector(c.type).getProvisioningResult(c.configuration, {
    envelope: await envelope(r),
    username: mapping.username,
    password: decrypt(mapping.credential),
    remoteTeamId: mapping.remoteTeamId ?? String(expected.remoteTeamId),
  });
  if (
    verified.remoteUserId !== b.result.remoteUserId ||
    verified.remoteTeamId !== b.result.remoteTeamId
  )
    throw new BadRequestException('回调结果未通过远端核验');
  return db.$transaction(async (tx) => {
    await lock(tx, `sync:${mapping.id}`);
    await lock(tx, id);
    const current = await tx.registration.findUniqueOrThrow({ where: { id } });
    if (!current.eligible || current.version !== b.registrationVersion)
      throw new BadRequestException('报名在核验期间已变更');
    if (
      school &&
      (await tx.organizationMapping.findUniqueOrThrow({ where: { id: school.id } })).version !==
        school.version
    )
      throw new BadRequestException('学校映射在核验期间已变更');
    const updated = await tx.accountMapping.updateMany({
      where: {
        id: mapping.id,
        registration: { version: b.registrationVersion, eligible: true },
        binding: {
          version: binding.version,
          enabled: true,
          instance: { version: binding.instance.version, enabled: true },
        },
      },
      data: {
        state: 'VERIFIED',
        remoteUserId: verified.remoteUserId,
        remoteTeamId: verified.remoteTeamId,
        details: json({
          ...verified,
          registrationVersion: current.version,
          bindingVersion: binding.version,
        }),
      },
    });
    if (updated.count !== 1) throw new BadRequestException('平台配置在核验期间已变更');
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
        organizationId: z.string().max(100).nullish(),
        version: z.number().int().optional(),
        importMode: z.enum(['FOLLOW', 'FORCE_UNOFFICIAL']).default('FOLLOW'),
        includeUnofficial: z.boolean().default(true),
        nickname: z.boolean().default(true),
        unofficialGroupId: z.string().max(100).nullable().optional(),
        automatic: z.boolean().default(true),
        enabled: z.boolean().default(true),
      })
      .parse(body);
    requireManager(u, b.contestId);
    const instance = await db.platformInstance.findUniqueOrThrow({ where: { id: b.instanceId } });
    if (!u.isAdmin && !(instance.allowedContestIds as string[]).includes(b.contestId))
      throw new ForbiddenException('该竞赛未获授权使用此平台实例');
    return db.$transaction(async (tx) => {
      await lock(tx, b.contestId);
      const key = {
        contestId: b.contestId,
        instanceId: b.instanceId,
        remoteContestId: b.remoteContestId,
      };
      const current = await tx.platformBinding.findUnique({
        where: { contestId_instanceId_remoteContestId: key },
      });
      if (current) checkVersion(current.version, b.version);
      if (b.unofficialGroupId && b.groupIds.includes(b.unofficialGroupId))
        throw new BadRequestException('正式与非正式参赛须使用不同分组');
      const { version, ...data } = b;
      const saved = await tx.platformBinding.upsert({
        where: { contestId_instanceId_remoteContestId: key },
        create: { ...data, organizationId: b.organizationId || null, groupIds: json(b.groupIds) },
        update: {
          ...data,
          organizationId: b.organizationId || null,
          groupIds: json(b.groupIds),
          version: { increment: 1 },
        },
      });
      const contest = await tx.contest.findUniqueOrThrow({ where: { id: b.contestId } });
      const policy = policySchema.parse(contest.policy);
      const profile = instance.type === 'HYDRO' ? 'HYDRO_5_0_7' : 'DOMJUDGE_9_0_1';
      if (!policy.platformProfiles.includes(profile)) {
        policy.platformProfiles.push(profile);
        const previous = await tx.formVersion.findUniqueOrThrow({
          where: { contestId_version: { contestId: contest.id, version: contest.formVersion } },
        });
        const fields = mergePlatformFields(
          fieldsSchema.parse(previous.fields),
          policy.platformProfiles,
        );
        await tx.contest.update({
          where: { id: contest.id },
          data: { policy: json(policy), formVersion: { increment: 1 }, version: { increment: 1 } },
        });
        await tx.formVersion.create({
          data: {
            contestId: contest.id,
            version: contest.formVersion + 1,
            fields: json(fields),
            schema: previous.schema as any,
          },
        });
      }
      if (current) {
        await tx.accountMapping.updateMany({
          where: { bindingId: saved.id },
          data: { state: 'STALE', details: { message: '平台配置已更新，请重新同步' } },
        });
        if (saved.automatic && saved.enabled) {
          const rows = await tx.registration.findMany({
            where: { contestId: saved.contestId, eligible: true },
            select: { id: true },
          });
          for (const row of rows) await scheduleSync(tx, row.id, saved.id);
        }
      }
      await audit(tx, u.id, 'PLATFORM_BINDING_SAVE', saved.contestId, {
        bindingId: saved.id,
        version: saved.version,
      });
      return saved;
    });
  }
  async remoteMetadata(u: Principal, id: string) {
    const b = await db.platformBinding.findUniqueOrThrow({ where: { id } });
    requireManager(u, b.contestId);
    const c = await platformConfig(id);
    if (c.type !== 'DOMJUDGE') throw new BadRequestException('仅 DOMjudge 支持学校和分组查询');
    const adapter = new (await import('@contest-center/connectors')).DOMjudgeConnector();
    return {
      organizations: await adapter.organizations(c.configuration),
      groups: await adapter.groups(c.configuration),
    };
  }
  async schools(u: Principal, bindingId: string, query: ListQuery = {}) {
    const b = await db.platformBinding.findUniqueOrThrow({ where: { id: bindingId } });
    requireManager(u, b.contestId);
    const registrations = await db.registration.findMany({
      where: {
        contestId: b.contestId,
        organization: { not: (await import('@prisma/client')).Prisma.DbNull },
      },
      select: { organization: true },
    });
    const keys = registrations.flatMap((r) =>
      r.organization ? [organizationKey(organizationSchema.parse(r.organization))] : [],
    );
    const where = {
      instanceId: b.instanceId,
      nameKey: { in: keys },
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
    };
    return paginated(
      { page: '1', ...query },
      (options) =>
        db.organizationMapping.findMany({
          where,
          ...options,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      () => db.organizationMapping.count({ where }),
    );
  }
  async confirmSchool(u: Principal, bindingId: string, id: string, body: unknown) {
    const b = await db.platformBinding.findUniqueOrThrow({ where: { id: bindingId } });
    requireManager(u, b.contestId);
    const input = organizationSchema
      .extend({
        shortName: z.string().trim().min(1).max(32),
        version: z.number().int(),
        remoteId: z.string().max(100).optional(),
        create: z.boolean().default(false),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, `school:${id}`);
      const m = await tx.organizationMapping.findUniqueOrThrow({ where: { id } });
      if (m.instanceId !== b.instanceId) throw new ForbiddenException();
      const candidates = await tx.registration.findMany({
        where: { contestId: b.contestId },
        select: { organization: true },
      });
      const registration = candidates.find(
        (r) =>
          r.organization && organizationKey(organizationSchema.parse(r.organization)) === m.nameKey,
      );
      if (!registration) throw new ForbiddenException('学校不属于该竞赛');
      checkVersion(m.version, input.version);
      const c = await platformConfig(bindingId);
      const adapter = new (await import('@contest-center/connectors')).DOMjudgeConnector();
      const remoteId = input.create
        ? `cc-${sha(`${m.instanceId}:${m.nameKey}`).slice(0, 32)}`
        : input.remoteId;
      if (!remoteId) throw new BadRequestException('请选择已有组织或确认创建');
      if (input.create) await adapter.createOrganization(c.configuration, remoteId, input);
      const remote = (await adapter.organizations(c.configuration)).find(
        (x: any) => String(x.id) === remoteId,
      );
      if (!remote) throw new BadRequestException('远端学校不存在');
      if (
        input.create &&
        (remote.formal_name !== input.name ||
          remote.name !== input.shortName ||
          (remote.country !== undefined && remote.country !== input.country))
      )
        throw new BadRequestException('学校全称、简称或国家读回校验失败，请检查远端资料');
      const info = organizationSchema.parse(input);
      const saved = await tx.organizationMapping.update({
        where: { id },
        data: { ...info, remoteId, status: 'CONFIRMED', version: { increment: 1 } },
      });
      await audit(tx, u.id, 'ORGANIZATION_MAP_CONFIRM', b.contestId, {
        mappingId: id,
        remoteId,
        organization: info,
      });
      const bindings = await tx.platformBinding.findMany({
        where: { instanceId: b.instanceId, enabled: true },
        include: { contest: { select: { id: true } } },
      });
      for (const binding of bindings) {
        const rows = await tx.registration.findMany({
          where: { contestId: binding.contestId, eligible: true },
          select: { id: true, organization: true },
        });
        for (const row of rows)
          if (
            row.organization &&
            organizationKey(organizationSchema.parse(row.organization)) === m.nameKey
          ) {
            if (
              !binding.automatic &&
              !(await tx.accountMapping.findUnique({
                where: {
                  registrationId_bindingId: { registrationId: row.id, bindingId: binding.id },
                },
              }))
            )
              continue;
            await tx.accountMapping.updateMany({
              where: { registrationId: row.id, bindingId: binding.id },
              data: { state: 'STALE', details: { message: '学校映射已更新，等待重新同步' } },
            });
            await scheduleSync(tx, row.id, binding.id);
          }
      }
      return saved;
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
  async jobs(u: Principal, query: ListQuery = {}) {
    if (!u.isAdmin && !u.contestIds.length) throw new ForbiddenException();
    const regs = u.isAdmin
      ? undefined
      : (
          await db.registration.findMany({
            where: { contestId: { in: u.contestIds } },
            select: { id: true },
          })
        ).map((r) => r.id);
    const where = {
      ...(regs ? { resourceId: { in: regs } } : {}),
      ...(query.status ? { state: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.search ? { resourceId: { contains: query.search } } : {}),
      createdAt: dateFilter(query),
    };
    return paginated(
      query,
      (options) =>
        db.job.findMany({
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
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...options,
        }),
      () => db.job.count({ where }),
      100,
    );
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
  };
}
