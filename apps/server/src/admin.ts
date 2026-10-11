import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@contest-center/contracts';
import { defaultSite, fieldSchema, fieldsSchema } from '@contest-center/contracts';
import { db, json, audit } from './db.js';
import { requireAdmin, requireManager, checkVersion } from './security.js';
export class AdminService {
  async users(u: Principal) {
    requireAdmin(u);
    return db.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        username: true,
        isAdmin: true,
        isCoach: true,
        verified: true,
        version: true,
        roles: true,
      },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });
  }
  async site() {
    const row = await db.setting.findUnique({ where: { key: 'site' } });
    return row
      ? { ...(row.value as object), version: row.version }
      : { ...defaultSite, version: 0 };
  }
  async saveSite(u: Principal, body: unknown) {
    requireAdmin(u);
    const b = z
      .object({
        name: z.string().min(1).max(80),
        primaryColor: z.string().regex(/^#[a-fA-F0-9]{6}$/),
        footer: z.string().max(300).default(''),
        version: z.number().int(),
      })
      .parse(body);
    const row = await db.setting.findUnique({ where: { key: 'site' } });
    checkVersion(row?.version ?? 0, b.version);
    const { version, ...value } = b;
    return db.setting.upsert({
      where: { key: 'site', ...(row ? { version: b.version } : {}) },
      create: { key: 'site', value },
      update: { value, version: { increment: 1 } },
    });
  }
  async fields(u: Principal) {
    if (!u.isAdmin && !u.contestIds.length) throw new BadRequestException('需要管理员身份');
    return db.fieldDefinition.findMany({ orderBy: { key: 'asc' } });
  }
  async field(u: Principal, body: unknown) {
    requireAdmin(u);
    const f = fieldSchema.parse(body);
    return db.fieldDefinition.upsert({
      where: { key: f.key },
      create: { key: f.key, definition: json(f) },
      update: { definition: json(f), version: { increment: 1 } },
    });
  }
  async logs(u: Principal, contestId?: string) {
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
    return db.auditEvent.findMany({
      where: ids ? { resourceId: { in: ids } } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
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
