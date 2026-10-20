import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@contest-center/contracts';
import { defaultSite, fieldSchema, fieldsSchema, userTagsSchema } from '@contest-center/contracts';
import { db, json, audit } from './db.js';
import { lock } from './db.js';
import {
  siteSettings,
  validatePublicUrl,
  validateTrustedOrigins,
  environmentTrustedOrigins,
} from './site-settings.js';
import { paginated, dateFilter, type ListQuery } from './pagination.js';
import { activeGrantWhere } from './authorization.js';
import { requireAdmin, requireSystemAdmin, requireManager, checkVersion } from './security.js';
export class AdminService {
  async users(u: Principal, query: ListQuery = {}) {
    requireAdmin(u);
    const where = {
      deactivatedAt: null,
      ...(query.tag ? { tags: { has: z.string().min(1).max(40).parse(query.tag) } } : {}),
      ...(query.search
        ? {
            OR: ['name', 'email', 'username'].map((k) => ({
              [k]: { contains: query.search, mode: 'insensitive' as const },
            })),
          }
        : {}),
    };
    const result = await paginated(
      query,
      (options) =>
        db.user.findMany({
          where,
          select: {
            id: true,
            name: true,
            email: true,
            username: true,
            isAdmin: true,
            isCoach: true,
            verified: true,
            bannedAt: true,
            banReason: true,
            version: true,
            grants: { where: activeGrantWhere() },
            kind: true,
            createdAt: true,
            identityStatus: true,
            tags: true,
            profile: true,
          },
          ...options,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      () => db.user.count({ where }),
    );
    const rows = Array.isArray(result) ? result : result.items;
    const items = rows.map((row) => ({
      ...row,
      isAdmin: row.grants.some((g) => ['SYSTEM', 'SENIOR'].includes(g.level)),
      isSystemAdmin: row.grants.some((g) => g.level === 'SYSTEM'),
      roles: [
        ...new Set(row.grants.filter((g) => g.level === 'CONTEST').map((g) => g.contestId)),
      ].map((contestId) => ({ contestId })),
    }));
    return Array.isArray(result) ? items : { ...result, items };
  }
  async userTags(u: Principal) {
    requireAdmin(u);
    const rows = await db.$queryRaw<
      { tag: string }[]
    >`SELECT DISTINCT unnest("tags") AS tag FROM "User" ORDER BY tag LIMIT 500`;
    return rows.map((row) => row.tag);
  }
  async tagUser(u: Principal, id: string, body: unknown) {
    requireAdmin(u);
    const b = z.object({ version: z.number().int().positive(), tags: userTagsSchema }).parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, `auth:${id}`);
      const previous = await tx.user.findUniqueOrThrow({ where: { id } });
      checkVersion(previous.version, b.version);
      const result = await tx.user.update({
        where: { id, version: b.version },
        data: { tags: b.tags, version: { increment: 1 } },
        select: { id: true, tags: true, version: true },
      });
      await audit(tx, u.id, 'USER_TAGS_UPDATE', id, { before: previous.tags, tags: b.tags });
      return result;
    });
  }
  async site() {
    const { trustedOrigins, ...site } = await siteSettings();
    return site;
  }
  async siteConfiguration(u: Principal) {
    requireSystemAdmin(u);
    return { ...(await siteSettings()), environmentTrustedOrigins: environmentTrustedOrigins() };
  }
  async saveSite(u: Principal, body: unknown) {
    requireSystemAdmin(u);
    const b = z
      .object({
        name: z.string().min(1).max(80),
        primaryColor: z.string().regex(/^#[a-fA-F0-9]{6}$/),
        footer: z.string().max(300).default(''),
        version: z.number().int(),
        publicUrl: z.string().max(2048).optional(),
        trustedOrigins: z.array(z.string().max(2048)).max(50).optional(),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, 'setting:site');
      const row = await tx.setting.findUnique({ where: { key: 'site' } });
      checkVersion(row?.version ?? 0, b.version);
      const { version, ...data } = b;
      const previous = await siteSettings();
      const value = {
        ...data,
        publicUrl: b.publicUrl === undefined ? previous.publicUrl : validatePublicUrl(b.publicUrl),
        trustedOrigins:
          b.trustedOrigins === undefined
            ? previous.trustedOrigins
            : validateTrustedOrigins(b.trustedOrigins),
      };
      const result = await tx.setting.upsert({
        where: { key: 'site', ...(row ? { version: b.version } : {}) },
        create: { key: 'site', value },
        update: { value, version: { increment: 1 } },
      });
      await audit(tx, u.id, 'SITE_UPDATE', 'site', {
        version: result.version,
        publicUrl: value.publicUrl,
        previousPublicUrl: previous.publicUrl,
        trustedOrigins: value.trustedOrigins,
        previousTrustedOrigins: previous.trustedOrigins,
      });
      return { ...value, version: result.version };
    });
  }
  async fields(u: Principal) {
    if (!u.isAdmin && !u.contestIds.length) throw new BadRequestException('需要管理员身份');
    return db.fieldDefinition.findMany({ orderBy: { key: 'asc' } });
  }
  async field(u: Principal, body: unknown) {
    requireAdmin(u);
    const { version, ...f } = fieldSchema
      .extend({ version: z.number().int().optional() })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, `global-field:${f.key}`);
      const current = await tx.fieldDefinition.findUnique({ where: { key: f.key } });
      if (version !== undefined) checkVersion(current?.version ?? 0, version);
      const saved = await tx.fieldDefinition.upsert({
        where: { key: f.key },
        create: { key: f.key, definition: json(f) },
        update: { definition: json(f), version: { increment: 1 } },
      });
      await audit(tx, u.id, 'GLOBAL_FIELD_SAVE', saved.id, { key: f.key, version: saved.version });
      return saved;
    });
  }

  async logs(u: Principal, contestId?: string, query: ListQuery = {}) {
    if (contestId) requireManager(u, contestId);
    else requireAdmin(u);
    const ids = contestId
      ? [
          contestId,
          ...(await db.registration.findMany({ where: { contestId }, select: { id: true } })).map(
            (r) => r.id,
          ),
        ]
      : undefined;
    const where = {
      ...(ids ? { resourceId: { in: ids } } : {}),
      ...(query.status ? { action: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { action: { contains: query.search, mode: 'insensitive' as const } },
              { resourceId: { contains: query.search } },
            ],
          }
        : {}),
      createdAt: dateFilter(query),
    };
    const result = await paginated(
      query,
      (options) =>
        db.auditEvent.findMany({
          where,
          ...options,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      () => db.auditEvent.count({ where }),
      200,
    );
    const rows = Array.isArray(result) ? result : result.items;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const resourceIds = [
      ...new Set(rows.map((row) => row.resourceId).filter((id) => uuid.test(id))),
    ];
    const actorIds = [...new Set(rows.map((row) => row.actorId).filter((id) => uuid.test(id)))];
    const [contests, registrations, tickets, instances, users, actors] = await Promise.all([
      db.contest.findMany({
        where: { id: { in: resourceIds } },
        select: { id: true, title: true },
      }),
      db.registration.findMany({
        where: { id: { in: resourceIds } },
        select: {
          id: true,
          teamName: true,
          contest: { select: { title: true } },
          people: { select: { name: true }, take: 1, orderBy: { id: 'asc' } },
        },
      }),
      db.supportTicket.findMany({
        where: { id: { in: resourceIds } },
        select: { id: true, title: true },
      }),
      db.platformInstance.findMany({
        where: { id: { in: resourceIds } },
        select: { id: true, name: true },
      }),
      db.user.findMany({ where: { id: { in: resourceIds } }, select: { id: true, name: true } }),
      db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }),
    ]);
    const names = new Map<string, string>([
      ['site', '全局站点设置'],
      ['mail', '邮件服务设置'],
    ]);
    contests.forEach((row) => names.set(row.id, row.title));
    registrations.forEach((row) =>
      names.set(
        row.id,
        `${row.teamName || row.people[0]?.name || '报名单'} · ${row.contest.title}`,
      ),
    );
    tickets.forEach((row) => names.set(row.id, `工单：${row.title}`));
    instances.forEach((row) => names.set(row.id, row.name));
    users.forEach((row) => names.set(row.id, row.name));
    const actorNames = new Map(actors.map((row) => [row.id, row.name]));
    const items = rows.map((row) => ({
      ...row,
      resourceName: names.get(row.resourceId) ?? row.resourceId,
      actorName: actorNames.get(row.actorId) ?? '系统服务',
    }));
    return Array.isArray(result) ? items : { ...result, items };
  }
  async metrics(u: Principal) {
    requireAdmin(u);
    const [jobs, outbox, oldest, heartbeat] = await Promise.all([
      db.job.groupBy({ by: ['state'], _count: true }),
      db.outboxEvent.count({ where: { deliveredAt: null } }),
      db.outboxEvent.findFirst({ where: { deliveredAt: null }, orderBy: { createdAt: 'asc' } }),
      db.setting.findUnique({ where: { key: 'workerHeartbeat' } }),
    ]);
    const at = (heartbeat?.value as { at?: string } | undefined)?.at;
    return {
      jobs: Object.fromEntries(jobs.map((j) => [j.state, j._count])),
      outboxPending: outbox,
      outboxLagSeconds: oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) : 0,
      workerAt: at ?? null,
      workerHealthy: !!at && Date.now() - new Date(at).getTime() < 30000,
    };
  }
}
