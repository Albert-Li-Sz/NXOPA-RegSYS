import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Principal } from '@contest-center/contracts';
import { fieldsSchema } from '@contest-center/contracts';
import {
  db,
  json,
  audit,
  event,
  lock,
  enqueue,
  registrationInclude,
  type Registration,
  type Tx,
} from './db.js';
import { getRegistration, requireManager, requireAdmin, manages, canRead } from './security.js';
import { config } from './config.js';
import { renderTemplate } from './templates.js';

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
      ...r.contest,
      startsAt: r.contest.startsAt.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      }),
    },
    registration: { id: r.id, answers: snapshot.answers ?? r.answers },
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
      if (!file || file.registrationId !== r.id || !['image/png', 'image/jpeg'].includes(file.mime))
        throw new Error('Invalid admission photo');
      const name = `photo-${file.id}.${file.mime === 'image/png' ? 'png' : 'jpg'}`;
      if (!assets[name]) {
        const buffer = await readFile(path.join(config.storage, file.storageKey));
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
  return {
    context: { ...context, participant: members[0], team: { ...context.team, members }, coaches },
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
  async templates(u: Principal, contestId?: string) {
    if (contestId) requireManager(u, contestId);
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
        name: z.string().min(1).max(100),
        source: z.string().min(20).max(100000),
      })
      .parse(body);
    if (b.contestId) requireManager(u, b.contestId);
    else requireAdmin(u);
    renderTemplate(b.source, {});
    return db.$transaction(async (tx) => {
      await lock(tx, `template:${b.contestId ?? 'global'}`);
      const last = await tx.admissionTemplate.findFirst({
        where: { contestId: b.contestId ?? null },
        orderBy: { version: 'desc' },
      });
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
    const b = z
      .object({ contestId: z.string().uuid().optional(), source: z.string().max(100000) })
      .parse(body);
    if (b.contestId) requireManager(u, b.contestId);
    else requireAdmin(u);
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
      admission: { number: 'PREVIEW-001', location: '示例考点', room: 'A101', seat: '12' },
    });
    const id = randomUUID();
    return db.$transaction(async (tx) => {
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
        registrationIds: z.array(z.string().uuid()).min(1).max(10000),
        location: z.string().max(300).default(''),
        room: z.string().max(100).default(''),
        seat: z.string().max(100).default(''),
        incrementSeats: z.boolean().default(false),
        numberPrefix: z
          .string()
          .regex(/^[A-Z0-9-]{1,20}$/)
          .optional(),
        releaseAt: z.iso.datetime({ offset: true }).optional(),
        seats: z.array(seatSchema).max(10000).optional(),
      })
      .parse(body);
    const results = [];
    if (
      b.seats?.some((s) => !b.registrationIds.includes(s.registrationId)) ||
      (b.seats && new Set(b.seats.map((s) => s.registrationId)).size !== b.seats.length)
    )
      throw new BadRequestException('座位表包含重复或未选择的报名');
    for (const [index, id] of b.registrationIds.entries()) {
      const r = await getRegistration(u, id);
      requireManager(u, r.contestId);
      if (!r.eligible) {
        results.push({ registrationId: id, error: '尚未取得参赛资格' });
        continue;
      }
      const assignment = b.seats?.find((s) => s.registrationId === id);
      const room = assignment?.room ?? b.room;
      const seat =
        assignment?.seat ??
        (b.incrementSeats && /^\d+$/.test(b.seat) ? String(Number(b.seat) + index) : b.seat);
      const location = assignment?.location ?? (b.location || r.contest.location);
      const a = await db.$transaction(async (tx) => {
        await lock(tx, id);
        const current = await tx.registration.findUniqueOrThrow({ where: { id } });
        if (!current.eligible || current.version !== r.version)
          throw new BadRequestException('报名资料已改变');
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
        if (
          document.room !== room ||
          document.seat !== seat ||
          document.location !== location ||
          (assignment?.number && document.number !== assignment.number) ||
          ['FAILED', 'STALE'].includes(document.state)
        ) {
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
    }
    return { results };
  }
  async release(u: Principal, id: string) {
    return db.$transaction(async (tx) => {
      const a = await tx.admissionDocument.findUniqueOrThrow({ where: { id } });
      await lock(tx, a.registrationId);
      const r = await getRegistration(u, a.registrationId);
      requireManager(u, r.contestId);
      if (
        !r.eligible ||
        r.version !== a.registrationVersion ||
        (await activeTemplate(r.contestId, tx))?.id !== a.templateId ||
        !['READY', 'RELEASED'].includes(a.state)
      )
        throw new BadRequestException('准考证未完成或资料已经改变');
      await tx.admissionDocument.update({
        where: { id, version: a.version },
        data: { state: 'RELEASED', releasedAt: new Date() },
      });
      await audit(tx, u.id, 'ADMISSION_RELEASE', r.id, { documentId: id });
      await event(tx, 'NOTIFY', r.id, { message: '您的准考证已发放，可以下载。' });
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
    const manager = manages(u, r.contestId);
    if (
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
      path: path.join(config.storage, a.storageKey),
    };
  }
  async download(u: Principal, id: string) {
    const file = await this.downloadLocation(u, id);
    return { name: file.name, buffer: await readFile(file.path) };
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
    if (j.kind !== 'PDF_PREVIEW' || (j.resourceId !== u.id && !u.isAdmin) || j.state !== 'SUCCESS')
      throw new ForbiddenException();
    return {
      name: 'preview.pdf',
      buffer: await readFile(
        path.join(config.storage, String((j.result as Record<string, unknown>).storageKey)),
      ),
    };
  }
}
