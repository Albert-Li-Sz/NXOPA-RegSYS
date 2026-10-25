import { rateLimit } from './auth.js';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readBlob, type StorageRef } from './storage.js';
import path from 'node:path';
import type { Principal } from '@contest-center/contracts';
import { fieldsSchema } from '@contest-center/contracts';
import { examSiteLocation } from './exam-sites.js';
import {
  db,
  inRequestTransaction,
  json,
  audit,
  event,
  lock,
  enqueue,
  registrationInclude,
  type Registration,
  type Tx,
} from './db.js';
import {
  getRegistration,
  requireManager,
  requireAdmin,
  manages,
  canRead,
  ownerIds,
  checkVersion,
} from './security.js';
import { modulesFor } from './workflow.js';
import { config } from './config.js';
import { renderTemplate } from './templates.js';
import { competitionCredentials, ensureCompetitionAccount } from './competition-accounts.js';

export async function activeTemplate(contestId: string, tx: Tx = db) {
  return (
    (await tx.admissionTemplate.findFirst({
      where: { contestId, active: true },
      orderBy: { version: 'desc' },
    })) ??
    (await tx.admissionTemplate.findFirst({
      where: { contestId: null, active: true },
      orderBy: { version: 'desc' },
    }))
  );
}
export function admissionContext(
  r: Registration,
  a: { number: string; location: string; room: string; seat: string },
) {
  const snapshot = (r.snapshot ?? {}) as Record<string, unknown>;
  const people = (snapshot.people ?? r.people) as Record<string, unknown>[];
  const coaches = (snapshot.coaches ?? r.coaches) as unknown[];
  return {
    contest: {
      id: r.contest.id,
      title: r.contest.title,
      location: r.contest.location,
      startsAt: r.contest.startsAt.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      }),
    },
    registration: { id: r.id, answers: snapshot.answers ?? r.answers, examSite: r.examSite },
    participant: people[0],
    team: {
      name: snapshot.teamName ?? r.teamName,
      englishName: snapshot.teamEnglishName ?? r.teamEnglishName,
      members: people.map((p) => ({ ...p, captainLabel: p.captain ? '是' : '否' })),
    },
    coaches,
    admission: a,
  };
}
export async function admissionMaterial(
  r: Registration,
  a: { number: string; location: string; room: string; seat: string },
) {
  const context = admissionContext(r, a);
  const account = await competitionCredentials(r.id, r.version);
  const fields = fieldsSchema.parse((r.snapshot as Record<string, unknown>)?.fields ?? []);
  const assets: Record<string, string> = {};
  let bytes = 0;
  const add = async (person: Record<string, unknown>, scope: string) => {
    const answers = (person.answers ?? {}) as Record<string, unknown>;
    const photos: Record<string, string> = {};
    for (const f of fields.filter((f) => f.scope === scope && f.type === 'photo')) {
      const id = answers[f.key];
      if (!id) continue;
      const file = await db.attachment.findUnique({ where: { id: String(id) } });
      if (
        !file ||
        file.deletedAt ||
        file.public ||
        file.ticketId ||
        (file.registrationId && file.registrationId !== r.id) ||
        (!file.registrationId &&
          !(await db.teamFile.count({ where: { attachmentId: file.id, registrationId: r.id } }))) ||
        !['image/png', 'image/jpeg'].includes(file.mime)
      )
        throw new Error('Invalid admission photo');
      const name = `photo-${file.id}.${file.mime === 'image/png' ? 'png' : 'jpg'}`;
      if (!assets[name]) {
        const buffer = await readBlob(file);
        bytes += buffer.length;
        if (Object.keys(assets).length >= 30 || bytes > 25 * 1024 * 1024)
          throw new Error('Admission assets exceed limits');
        assets[name] = buffer.toString('base64');
      }
      photos[f.key] = `assets/${name}`;
    }
    return { ...person, assets: photos };
  };
  const members = [];
  for (const person of context.team.members) members.push(await add(person, 'PERSON'));
  const coaches = [];
  for (const coach of context.coaches)
    coaches.push(await add(coach as Record<string, unknown>, 'COACH'));
  const registration = await add(
    { answers: (context.registration.answers as any).registration ?? {} },
    'REGISTRATION',
  );
  const team = await add({ answers: (context.registration.answers as any).team ?? {} }, 'TEAM');
  return {
    context: {
      ...context,
      account,
      registration: { ...context.registration, assets: registration.assets },
      participant: members[0],
      team: { ...context.team, assets: team.assets, members },
      coaches,
    },
    assets,
  };
}
const seatSchema = z.object({
  registrationId: z.string().uuid(),
  number: z
    .string()
    .regex(/^[A-Z0-9-]{1,60}$/)
    .optional(),
  location: z.string().max(300).optional(),
  room: z.string().max(100),
  seat: z.string().max(100),
});
export class AdmissionService {
  async mine(u: Principal) {
    const ids = ownerIds(u);
    const registrations = await db.registration.findMany({
      where: {
        eligible: true,
        OR: [
          { ownerId: { in: ids } },
          { people: { some: { userId: { in: ids }, active: true } } },
          { coaches: { some: { userId: { in: ids } } } },
        ],
      },
      include: {
        contest: true,
        admissions: {
          where: { state: 'RELEASED', storageKey: { not: null } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    const result = [];
    const templates = await db.admissionTemplate.findMany({
      where: {
        active: true,
        OR: [{ contestId: { in: registrations.map((r) => r.contestId) } }, { contestId: null }],
      },
      orderBy: { version: 'desc' },
    });
    for (const registration of registrations) {
      if (!modulesFor(registration.contest).admissions) continue;
      const template =
        templates.find((t) => t.contestId === registration.contestId) ??
        templates.find((t) => t.contestId === null);
      for (const document of registration.admissions)
        if (
          document.registrationVersion === registration.version &&
          document.templateId === template?.id
        )
          result.push({
            id: document.id,
            registrationId: registration.id,
            name: document.number,
            contestTitle: registration.contest.title,
            createdAt: document.createdAt,
          });
    }
    return result;
  }

  async templates(u: Principal, contestId?: string) {
    if (contestId) requireManager(u, contestId, 'ADMISSIONS');
    else requireAdmin(u);
    return db.admissionTemplate.findMany({
      where: { OR: [{ contestId: null }, ...(contestId ? [{ contestId }] : [])] },
      orderBy: { createdAt: 'desc' },
    });
  }
  async saveTemplate(u: Principal, body: unknown) {
    const b = z
      .object({
        contestId: z.string().uuid().optional(),
        version: z.number().int().min(0).optional(),
        name: z.string().min(1).max(100),
        source: z.string().min(20).max(100000),
      })
      .parse(body);
    if (b.contestId) {
      requireManager(u, b.contestId, 'ADMISSIONS');
      if (
        !modulesFor(await db.contest.findUniqueOrThrow({ where: { id: b.contestId } })).admissions
      )
        throw new BadRequestException('此活动未启用准考证');
    } else requireAdmin(u);
    renderTemplate(b.source, {});
    return db.$transaction(async (tx) => {
      await lock(tx, `template:${b.contestId ?? 'global'}`);
      if (b.contestId) await tx.contest.findUniqueOrThrow({ where: { id: b.contestId } });
      const last = await tx.admissionTemplate.findFirst({
        where: { contestId: b.contestId ?? null },
        orderBy: { version: 'desc' },
      });
      if (b.version !== undefined) checkVersion(last?.version ?? 0, b.version);
      await tx.admissionDocument.updateMany({
        where: b.contestId
          ? { registration: { contestId: b.contestId } }
          : {
              templateId: {
                in: (
                  await tx.admissionTemplate.findMany({
                    where: { contestId: null, active: true },
                    select: { id: true },
                  })
                ).map((t) => t.id),
              },
            },
        data: { state: 'STALE', releasedAt: null },
      });
      await tx.admissionTemplate.updateMany({
        where: { contestId: b.contestId ?? null, active: true },
        data: { active: false },
      });
      const t = await tx.admissionTemplate.create({
        data: { ...b, contestId: b.contestId ?? null, version: (last?.version ?? 0) + 1 },
      });
      await audit(tx, u.id, 'TEMPLATE_UPDATE', t.id);
      return t;
    });
  }
  async preview(u: Principal, body: unknown) {
    await rateLimit(`pdf-preview:${u.id}`, 10);
    const b = z
      .object({ contestId: z.string().uuid().optional(), source: z.string().max(100000) })
      .parse(body);
    let showAccount = true;
    if (b.contestId) {
      requireManager(u, b.contestId, 'ADMISSIONS');
      showAccount = modulesFor(
        await db.contest.findUniqueOrThrow({ where: { id: b.contestId } }),
      ).integrations;
      if (
        !modulesFor(await db.contest.findUniqueOrThrow({ where: { id: b.contestId } })).admissions
      )
        throw new BadRequestException('此活动未启用准考证');
    } else requireAdmin(u);
    const source = renderTemplate(b.source, {
      contest: { title: '示例程序设计竞赛', startsAt: '2026/10/18 09:00' },
      participant: { name: '示例选手', answers: { school: '示例大学' }, assets: {} },
      registration: { answers: {} },
      team: {
        name: '示例队伍',
        members: [
          { name: '示例选手', answers: { school: '示例大学' }, assets: {}, captainLabel: '是' },
        ],
      },
      coaches: [],
      account: showAccount ? { username: '0020260001', password: 'PreviewContest2026!' } : null,
      admission: { number: 'PREVIEW-001', location: '示例考点', room: 'A101', seat: '12' },
    });
    const id = randomUUID();
    return db.$transaction(async (tx) => {
      await lock(tx, `preview-budget:${u.id}`);
      const previous = await tx.job.findMany({
        where: { kind: 'PDF_PREVIEW', resourceId: u.id, state: { not: 'CANCELLED' } },
        select: { id: true, result: true },
        take: 1000,
      });
      await tx.job.updateMany({
        where: { id: { in: previous.map((j) => j.id) } },
        data: { state: 'CANCELLED', payload: {}, leaseToken: null, leaseUntil: null },
      });
      for (const prior of previous)
        if ((prior.result as any)?.storageKey)
          await enqueue(tx, 'OBJECT_DELETE', prior.id, `preview-replace:${prior.id}`, {
            storageRef: prior.result,
          });
      const job = await enqueue(tx, 'PDF_PREVIEW', u.id, `preview:${id}`, {
        source,
        ownerId: u.id,
      });
      return { id: job.id, state: job.state };
    });
  }
  async generate(u: Principal, body: unknown) {
    const b = z
      .object({
        registrationIds: z.array(z.string().uuid()).min(1).max(100),
        location: z.string().max(300).default(''),
        room: z.string().max(100).default(''),
        seat: z.string().max(100).default(''),
        incrementSeats: z.boolean().default(false),
        numberPrefix: z
          .string()
          .regex(/^[A-Z0-9-]{1,20}$/)
          .optional(),
        releaseAt: z.iso.datetime({ offset: true }).nullable().optional(),
        seats: z.array(seatSchema).max(100).optional(),
      })
      .parse(body);
    const results = [];
    await rateLimit(`admission-generate:${u.id}`, 10);
    if (
      b.seats?.some((s) => !b.registrationIds.includes(s.registrationId)) ||
      (b.seats && new Set(b.seats.map((s) => s.registrationId)).size !== b.seats.length)
    )
      throw new BadRequestException('座位表包含重复或未选择的报名');
    if (new Set(b.registrationIds).size !== b.registrationIds.length)
      throw new BadRequestException('报名列表包含重复记录');
    const registrations = new Map<string, Registration>();
    for (const id of b.registrationIds) {
      const r = await getRegistration(u, id);
      requireManager(u, r.contestId, 'ADMISSIONS');
      if (!modulesFor(r.contest).admissions) throw new BadRequestException('此活动未启用准考证');
      registrations.set(id, r);
    }
    for (const contestId of new Set([...registrations.values()].map((r) => r.contestId))) {
      if (
        (await db.job.count({
          where: {
            kind: 'ADMISSION',
            state: { in: ['PENDING', 'OUTBOX', 'RUNNING'] },
            resourceId: {
              in: (
                await db.registration.findMany({ where: { contestId }, select: { id: true } })
              ).map((r) => r.id),
            },
          },
        })) +
          b.registrationIds.length >
        200
      )
        throw new BadRequestException('此活动已有较多准考证任务，请等待完成后分批生成');
    }
    const numbers = (b.seats ?? []).flatMap((s) => (s.number ? [s.number] : []));
    if (new Set(numbers).size !== numbers.length)
      throw new BadRequestException('准考证编号重复，请检查座位表');
    const existing = await db.admissionDocument.findMany({ where: { number: { in: numbers } } });
    for (const assignment of b.seats ?? []) {
      if (!assignment.number) continue;
      const prior = existing.find((d) => d.number === assignment.number);
      const registration = registrations.get(assignment.registrationId)!;
      if (
        prior &&
        (prior.registrationId !== registration.id ||
          prior.registrationVersion !== registration.version ||
          prior.templateId !== (await activeTemplate(registration.contestId))?.id)
      )
        throw new BadRequestException(`准考证编号 ${assignment.number} 已被使用，请修改后重试`);
    }
    for (const [index, id] of b.registrationIds.entries()) {
      const r = registrations.get(id)!;
      if (r.contest.examSites.length && !r.examSiteId) {
        results.push({ registrationId: id, error: '请先补充参赛考点' });
        continue;
      }
      if (!r.eligible) {
        results.push({ registrationId: id, error: '尚未取得参赛资格' });
        continue;
      }
      const assignment = b.seats?.find((s) => s.registrationId === id);
      let room = assignment?.room ?? b.room;
      let seat =
        assignment?.seat ??
        (b.incrementSeats && /^\d+$/.test(b.seat) ? String(Number(b.seat) + index) : b.seat);
      let location = r.examSite
        ? examSiteLocation(r.examSite)
        : (assignment?.location ?? (b.location || r.contest.location));
      try {
        const a = await db.$transaction(async (tx) => {
          await lock(tx, `competition-accounts:${r.contestId}`);
          await lock(tx, id);
          await lock(tx, `seating:${r.contestId}`);
          await lock(tx, `admission-budget:${r.contestId}`);
          const queued = await tx.job.count({
            where: {
              kind: 'ADMISSION',
              state: { in: ['PENDING', 'OUTBOX', 'RUNNING'] },
              resourceId: {
                in: (
                  await tx.registration.findMany({
                    where: { contestId: r.contestId },
                    select: { id: true },
                  })
                ).map((x) => x.id),
              },
            },
          });
          if (queued >= 200)
            throw new BadRequestException('此活动准考证队列已满，请等待完成后再生成');
          const currentContest = await tx.contest.findUniqueOrThrow({ where: { id: r.contestId } });
          if (!modulesFor(currentContest).admissions)
            throw new BadRequestException('此活动已关闭准考证');
          if (currentContest.version !== r.contest.version)
            throw new BadRequestException('活动配置已改变，请刷新后重新生成');
          const seats = await tx.seatAssignment.findMany({
            where: { registrationId: id },
            include: { room: true },
            orderBy: { seat: 'asc' },
          });
          if (modulesFor(r.contest).rooms) {
            const expected =
              r.contest.seatingMode === 'PERSON' ? r.people.filter((p) => p.active).length : 1;
            if (
              seats.length !== expected ||
              seats.some(
                (a) =>
                  !a.room.enabled ||
                  (r.examSiteId && a.room.examSiteId !== r.examSiteId) ||
                  (a.personId && !r.people.some((p) => p.id === a.personId && p.active)),
              )
            )
              throw new BadRequestException('请先完成此报名的有效排考');
            room = [...new Set(seats.map((a) => a.room.name))].join('、');
            location = [
              ...new Set(
                seats.map(
                  (a) =>
                    [examSiteLocation(r.examSite), a.room.location].filter(Boolean).join(' · ') ||
                    r.contest.location,
                ),
              ),
            ].join('、');
            seat = seats
              .map((a) =>
                a.personId
                  ? `${r.people.find((p) => p.id === a.personId)?.name}: ${a.seat}`
                  : String(a.seat),
              )
              .join('；');
          }
          const current = await tx.registration.findUniqueOrThrow({ where: { id } });
          if (!current.eligible || current.version !== r.version)
            throw new BadRequestException('报名资料已改变');
          await ensureCompetitionAccount(tx, id, r.version);
          const template = await activeTemplate(r.contestId, tx);
          if (!template) throw new BadRequestException('请先配置准考证模板');
          let document = await tx.admissionDocument.upsert({
            where: {
              registrationId_registrationVersion_templateId: {
                registrationId: id,
                registrationVersion: r.version,
                templateId: template.id,
              },
            },
            create: {
              registrationId: id,
              number:
                assignment?.number ??
                `${b.numberPrefix ?? 'CC'}${new Date().getFullYear()}${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
              location,
              room,
              seat,
              registrationVersion: r.version,
              templateId: template.id,
              templateVersion: template.version,
              releaseAt: b.releaseAt ? new Date(b.releaseAt) : null,
            },
            update: {},
          });
          const releaseAt =
            b.releaseAt === undefined
              ? document.releaseAt
              : b.releaseAt
                ? new Date(b.releaseAt)
                : null;
          if (
            document.room !== room ||
            document.seat !== seat ||
            document.location !== location ||
            (assignment?.number && document.number !== assignment.number) ||
            ['FAILED', 'STALE'].includes(document.state) ||
            document.releaseAt?.getTime() !== releaseAt?.getTime()
          ) {
            if (document.storageKey)
              await enqueue(
                tx,
                'OBJECT_DELETE',
                document.id,
                `replaced-document:${document.id}:${document.version}`,
                {
                  storageRef: {
                    storageKey: document.storageKey,
                    storageBackend: document.storageBackend,
                    storageConfigId: document.storageConfigId,
                    sha256: document.sha256,
                  },
                },
              );
            document = await tx.admissionDocument.update({
              where: { id: document.id },
              data: {
                location,
                room,
                seat,
                ...(assignment?.number ? { number: assignment.number } : {}),
                version: { increment: 1 },
                state: 'QUEUED',
                releasedAt: null,
                releaseAt,
                storageKey: null,
                error: null,
              },
            });
          }
          await enqueue(tx, 'ADMISSION', id, `admission:${document.id}:${document.version}`, {
            documentId: document.id,
            documentVersion: document.version,
          });
          await audit(tx, u.id, 'ADMISSION_GENERATE', id, { documentId: document.id, room, seat });
          return document;
        });
        results.push({ registrationId: id, documentId: a.id, state: a.state });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          // A failed SQL statement aborts the outer HTTP idempotency transaction.
          // Let it roll back before the interceptor writes a replay record.
          if (inRequestTransaction() || b.registrationIds.length === 1)
            throw new BadRequestException('准考证编号已被使用，请修改后重试');
          results.push({ registrationId: id, error: '准考证编号已被使用，请修改后重试' });
        } else throw error;
      }
    }
    return { results };
  }
  async release(u: Principal, id: string) {
    return db.$transaction(async (tx) => {
      let a = await tx.admissionDocument.findUniqueOrThrow({ where: { id } });
      await lock(tx, a.registrationId);
      a = await tx.admissionDocument.findUniqueOrThrow({ where: { id } });
      const r = await getRegistration(u, a.registrationId);
      requireManager(u, r.contestId, 'ADMISSIONS');
      if (
        !modulesFor(r.contest).admissions ||
        !r.eligible ||
        r.version !== a.registrationVersion ||
        (await activeTemplate(r.contestId, tx))?.id !== a.templateId ||
        !['READY', 'RELEASED'].includes(a.state)
      )
        throw new BadRequestException('准考证未完成或资料已经改变');
      if (a.state === 'RELEASED') return { ok: true };
      await tx.admissionDocument.update({
        where: { id, version: a.version },
        data: { state: 'RELEASED', releasedAt: new Date() },
      });
      await audit(tx, u.id, 'ADMISSION_RELEASE', r.id, { documentId: id });
      await event(tx, 'NOTIFY', r.id, {
        message: '您的准考证已发放，可以下载。',
        category: 'ADMISSION',
      });
      return { ok: true };
    });
  }
  async batchDocumentIds(u: Principal, registrationIds: string[]) {
    const rows = await db.registration.findMany({
      where: { id: { in: registrationIds } },
      include: {
        ...registrationInclude,
        admissions: {
          where: { state: { in: ['READY', 'RELEASED'] } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    const templates = new Map<string, string>();
    const ids: string[] = [];
    for (const id of new Set(registrationIds)) {
      const r = rows.find((row) => row.id === id);
      if (!r || !canRead(u, r)) throw new ForbiddenException('没有此报名的访问权限');
      if (!templates.has(r.contestId))
        templates.set(r.contestId, (await activeTemplate(r.contestId))?.id ?? '');
      const document = r.admissions.find(
        (d) => d.registrationVersion === r.version && d.templateId === templates.get(r.contestId),
      );
      if (!document)
        throw new BadRequestException(
          `${r.teamName || r.people[0]?.name || r.id}的准考证尚未生成或已失效`,
        );
      ids.push(document.id);
    }
    return ids;
  }
  async downloadLocation(u: Principal, id: string) {
    const a = await db.admissionDocument.findUniqueOrThrow({ where: { id } });
    const r = await getRegistration(u, a.registrationId);
    const manager = manages(u, r.contestId, 'ADMISSIONS');
    if (
      !modulesFor(r.contest).admissions ||
      !a.storageKey ||
      !['READY', 'RELEASED'].includes(a.state) ||
      !r.eligible ||
      r.version !== a.registrationVersion ||
      (await activeTemplate(r.contestId))?.id !== a.templateId ||
      (!manager && a.state !== 'RELEASED')
    )
      throw new ForbiddenException('准考证未发放或已经失效');
    return {
      name: `${a.number}.pdf`,
      buffer: await readBlob(a),
    };
  }
  async download(u: Principal, id: string) {
    const file = await this.downloadLocation(u, id);
    return { name: file.name, buffer: file.buffer };
  }
  async job(u: Principal, id: string) {
    const j = await db.job.findUniqueOrThrow({ where: { id } });
    if (j.resourceId !== u.id && !u.isAdmin) await getRegistration(u, j.resourceId);
    return {
      id: j.id,
      kind: j.kind,
      state: j.state,
      attempts: j.attempts,
      error: j.error,
      result: j.kind === 'PDF_PREVIEW' ? { downloadUrl: `/api/v1/jobs/${id}/download` } : j.result,
    };
  }
  async previewDownload(u: Principal, id: string) {
    const j = await db.job.findUniqueOrThrow({ where: { id } });
    if (j.createdAt.getTime() < Date.now() - 3600000)
      throw new BadRequestException('预览已过期，请重新生成');
    if (j.kind !== 'PDF_PREVIEW' || (j.resourceId !== u.id && !u.isAdmin) || j.state !== 'SUCCESS')
      throw new ForbiddenException();
    return {
      name: 'preview.pdf',
      buffer: await readBlob(j.result as unknown as StorageRef),
    };
  }
}
