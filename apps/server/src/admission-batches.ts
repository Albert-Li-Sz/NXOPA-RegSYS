import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  admissionBatchPreviewSchema,
  admissionBatchExecuteSchema,
  type Principal,
} from '@contest-center/contracts';
import archiver from 'archiver';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { db, json, lock, enqueue, audit } from './db.js';
import { requireManager } from './security.js';
import { publicUser, rateLimit } from './auth.js';
import { RegistrationService } from './registrations.js';
import { AdmissionService, activeTemplate } from './admissions.js';
import { modulesFor } from './workflow.js';
import { putBlob, readBlob, removeBlob, type StorageRef } from './storage.js';

type Target = {
  id: string;
  version: number;
  name: string;
  reason?: string;
  documentId?: string;
  documentVersion?: number;
};
type Item = Target & { state: 'QUEUED' | 'SUCCESS' | 'SKIPPED' | 'FAILED'; message: string };
type Part = StorageRef & { name: string; targets: Target[]; size: number };
type Result = { items: Item[]; files: Part[] };
const lifespan = 24 * 3600000;

export function batchView(batch: {
  id: string;
  state: string;
  action: string;
  targets: unknown;
  result: unknown;
  expiresAt: Date;
}) {
  const targets = batch.targets as Target[];
  const result = batch.result as Partial<Result>;
  const items = result.items ?? [];
  return {
    id: batch.id,
    state: batch.state,
    action: batch.action,
    total: targets.length,
    success: items.filter((i) => i.state === 'SUCCESS').length,
    skipped: items.filter((i) => i.state === 'SKIPPED').length,
    failed: items.filter((i) => i.state === 'FAILED').length,
    pending: targets.length - items.filter((i) => i.state !== 'QUEUED').length,
    items,
    expiresAt: batch.expiresAt,
    files: (result.files ?? []).map((part, index) => ({
      name: part.name,
      size: part.size,
      downloadUrl: `/api/v1/admission-batches/${batch.id}/files/${index}`,
    })),
  };
}

export class AdmissionBatchService {
  async preview(u: Principal, contestId: string, body: unknown) {
    requireManager(u, contestId, 'ADMISSIONS');
    await rateLimit(`admission-batch-preview:${u.id}`, 20);
    const b = admissionBatchPreviewSchema.parse(body);
    const contest = await db.contest.findUniqueOrThrow({ where: { id: contestId } });
    if (!modulesFor(contest).admissions) throw new BadRequestException('此活动未启用准考证');
    const template = await activeTemplate(contestId);
    if (!template) throw new BadRequestException('请先配置准考证模板');
    const rows = await new RegistrationService().batchTargets(
      u,
      contestId,
      b.scope.mode === 'FILTERED' ? b.scope.filters : {},
      b.scope.mode === 'SELECTED' ? b.scope.registrationIds : undefined,
    );
    if (!rows.length) throw new BadRequestException('当前范围没有报名');
    const documents =
      b.action === 'GENERATE'
        ? []
        : await db.admissionDocument.findMany({
            where: {
              registrationId: { in: rows.map((r) => r.id) },
              templateId: template.id,
              state: { in: ['READY', 'RELEASED'] },
              storageKey: { not: null },
            },
          });
    const targets: Target[] = rows.map((r) => {
      const document = documents.find(
        (d) => d.registrationId === r.id && d.registrationVersion === r.version,
      );
      return {
        id: r.id,
        version: r.version,
        name: r.teamName || `报名 ${r.number ?? r.id}`,
        ...(!r.eligible
          ? { reason: '尚未取得参赛资格' }
          : b.action !== 'GENERATE' && !document
            ? { reason: '准考证未生成完成或已经失效' }
            : {}),
        ...(document ? { documentId: document.id, documentVersion: document.version } : {}),
      };
    });
    const batch = await db.admissionBatch.create({
      data: {
        contestId,
        actorId: u.id,
        action: b.action,
        targets: json(targets),
        options: json({ ...b.options, contestVersion: contest.version, templateId: template.id }),
        expiresAt: new Date(Date.now() + 15 * 60000),
      },
    });
    return {
      previewId: batch.id,
      total: targets.length,
      processable: targets.filter((t) => !t.reason).length,
      skipped: targets.filter((t) => t.reason),
      expiresAt: batch.expiresAt,
    };
  }

  async start(u: Principal, contestId: string, body: unknown) {
    requireManager(u, contestId, 'ADMISSIONS');
    const { previewId } = admissionBatchExecuteSchema.parse(body);
    await rateLimit(`admission-batch-start:${u.id}`, 10);
    return db.$transaction(async (tx) => {
      await lock(tx, `admission-batches:${contestId}`);
      const batch = await tx.admissionBatch.findUniqueOrThrow({ where: { id: previewId } });
      if (batch.actorId !== u.id || batch.contestId !== contestId) throw new ForbiddenException();
      const prior = await tx.job.findUnique({
        where: { dedupeKey: `admission-batch:${batch.id}` },
      });
      if (prior) return { jobId: prior.id, batchId: batch.id };
      if (batch.state !== 'PREVIEW' || batch.expiresAt <= new Date())
        throw new BadRequestException('批次预览已过期，请重新核对范围');
      if (
        await tx.admissionBatch.count({
          where: { contestId, state: { in: ['QUEUED', 'RUNNING'] } },
        })
      )
        throw new BadRequestException('此活动已有准考证批次正在处理，请等待完成');
      await tx.admissionBatch.update({
        where: { id: batch.id },
        data: { state: 'QUEUED', expiresAt: new Date(Date.now() + lifespan) },
      });
      const job = await enqueue(tx, 'ADMISSION_BATCH', batch.id, `admission-batch:${batch.id}`, {
        contestId,
        batchId: batch.id,
      });
      await audit(tx, u.id, 'ADMISSION_BATCH_START', contestId, {
        batchId: batch.id,
        action: batch.action,
        total: (batch.targets as Target[]).length,
      });
      return { jobId: job.id, batchId: batch.id };
    });
  }

  async file(u: Principal, batchId: string, part: number) {
    const batch = await db.admissionBatch.findUniqueOrThrow({ where: { id: batchId } });
    requireManager(u, batch.contestId, 'ADMISSIONS');
    if (batch.actorId !== u.id && !u.isAdmin) throw new ForbiddenException();
    if (batch.expiresAt <= new Date())
      throw new BadRequestException('批量下载已过期，请重新生成下载包');
    const file = (batch.result as unknown as Result).files?.[part];
    if (!file || batch.state !== 'SUCCESS') throw new BadRequestException('下载包尚未完成');
    for (const target of file.targets)
      await checkTarget(u, batch.contestId, target, batch.options as any, true);
    // The archive holds up to 100 MiB of source PDFs plus ZIP metadata.
    return { name: file.name, buffer: await readBlob(file, 101 * 1024 * 1024) };
  }
}

async function checkTarget(
  u: Principal,
  contestId: string,
  target: Target,
  options: any,
  document = false,
) {
  requireManager(u, contestId, 'ADMISSIONS');
  const r = await db.registration.findUnique({
    where: { id: target.id },
    include: { contest: true },
  });
  if (!r || r.contestId !== contestId || !r.eligible || r.version !== target.version)
    throw new BadRequestException('报名已删除、资料变化或资格失效');
  if (
    r.contest.version !== options.contestVersion ||
    !modulesFor(r.contest).admissions ||
    (await activeTemplate(contestId))?.id !== options.templateId
  )
    throw new BadRequestException('活动配置或准考证模板已改变');
  if (document) {
    const d = await db.admissionDocument.findUnique({ where: { id: target.documentId ?? '' } });
    if (
      !d ||
      d.version !== target.documentVersion ||
      d.registrationId !== r.id ||
      d.registrationVersion !== r.version ||
      d.templateId !== options.templateId ||
      !d.storageKey ||
      !['READY', 'RELEASED'].includes(d.state)
    )
      throw new BadRequestException('准考证已改变或失效');
  }
}

async function zipBuffer(documents: { name: string; buffer: Buffer }[]) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });
  for (const document of documents) archive.append(document.buffer, { name: document.name });
  await archive.finalize();
  return result;
}

export async function runAdmissionBatch(batchId: string, active: () => Promise<boolean>) {
  const batch = await db.admissionBatch.findUniqueOrThrow({ where: { id: batchId } });
  const targets = batch.targets as Target[],
    options = batch.options as any;
  const result = batch.result as unknown as Result;
  result.items ??= [];
  result.files ??= [];
  const service = new AdmissionService();
  const actor = async () => {
    if (!(await active())) throw new Error('批次执行租约已失效');
    const user = await db.user.findUniqueOrThrow({ where: { id: batch.actorId } });
    if (user.deactivatedAt || user.bannedAt) throw new ForbiddenException('操作账号已停用');
    const u = await publicUser(batch.actorId);
    requireManager(u, batch.contestId, 'ADMISSIONS');
    return u;
  };
  const save = async (state = 'RUNNING') => {
    if (!(await active())) throw new Error('批次执行租约已失效');
    await db.admissionBatch.update({
      where: { id: batch.id },
      data: { state, result: json(result) },
    });
  };
  await save();
  // A retry resumes successful/queued targets. Download parts are rebuilt so a
  // changed qualification cannot leave an old ZIP available as a new result.
  if (batch.action === 'DOWNLOAD') {
    for (const file of result.files) await removeBlob(file);
    result.files = [];
    result.items = [];
  }
  let documents: { name: string; buffer: Buffer }[] = [],
    partTargets: Target[] = [],
    bytes = 0;
  const flush = async () => {
    if (!documents.length) return;
    const part = result.files.length;
    const buffer = await zipBuffer(documents);
    const ref = await putBlob(
      `batch-${batch.id}-${part}-${randomUUID()}`,
      buffer,
      'application/zip',
    );
    result.files.push({
      ...ref,
      name: `admissions-${part + 1}.zip`,
      size: buffer.length,
      targets: partTargets,
    });
    documents = [];
    partTargets = [];
    bytes = 0;
    await save();
  };
  for (const [index, target] of targets.entries()) {
    if (
      result.items.some(
        (item) => item.id === target.id && ['SUCCESS', 'SKIPPED', 'QUEUED'].includes(item.state),
      )
    )
      continue;
    result.items = result.items.filter((item) => item.id !== target.id);
    if (target.reason) {
      result.items.push({ ...target, state: 'SKIPPED', message: target.reason });
      continue;
    }
    try {
      const u = await actor();
      await checkTarget(u, batch.contestId, target, options, batch.action !== 'GENERATE');
      if (batch.action === 'GENERATE') {
        while (
          Number(
            (
              await db.$queryRaw<
                { count: bigint }[]
              >`SELECT count(*) AS count FROM "Job" j JOIN "Registration" r ON j."resourceId"=r.id::text WHERE j.kind='ADMISSION' AND j.state IN ('OUTBOX','PENDING','RUNNING') AND r."contestId"=${batch.contestId}::uuid`
            )[0]?.count ?? 0,
          ) >= 100
        ) {
          await save();
          await pause(1500);
          await actor();
        }
        const generated = await service.generate(
          u,
          {
            registrationIds: [target.id],
            location: options.location,
            room: options.room,
            seat: /^\d+$/.test(options.seat) ? String(Number(options.seat) + index) : options.seat,
            expectedVersions: { [target.id]: target.version },
            expectedContestVersion: options.contestVersion,
            expectedTemplateId: options.templateId,
          },
          true,
        );
        const item = generated.results[0];
        if (!item || 'error' in item) throw new BadRequestException(item?.error ?? '生成失败');
        result.items.push({
          ...target,
          documentId: item.documentId,
          state: 'QUEUED',
          message: '正在生成 PDF',
        });
      } else if (batch.action === 'RELEASE') {
        await service.release(u, target.documentId!, {
          registrationVersion: target.version,
          documentVersion: target.documentVersion!,
          contestVersion: options.contestVersion,
        });
        result.items.push({ ...target, state: 'SUCCESS', message: '已发放' });
      } else {
        const document = await service.downloadLocation(u, target.documentId!);
        if (bytes + document.buffer.length > 100 * 1024 * 1024 || documents.length >= 1000)
          await flush();
        documents.push(document);
        partTargets.push(target);
        bytes += document.buffer.length;
        result.items.push({ ...target, state: 'SUCCESS', message: '已加入下载包' });
      }
    } catch (error) {
      result.items.push({
        ...target,
        state: 'FAILED',
        message: error instanceof Error ? error.message : '处理失败',
      });
    }
    if (index % 10 === 0) await save();
  }
  await flush();
  while (result.items.some((item) => item.state === 'QUEUED')) {
    await actor();
    for (const item of result.items.filter((item) => item.state === 'QUEUED')) {
      const d = await db.admissionDocument.findUnique({ where: { id: item.documentId! } });
      if (!d || ['STALE', 'FAILED'].includes(d.state)) {
        item.state = 'FAILED';
        item.message = d?.error ?? '文档生成失败或已经失效';
      } else if (['READY', 'RELEASED'].includes(d.state)) {
        item.state = 'SUCCESS';
        item.message = 'PDF 已生成，待管理员发放';
      } else {
        const job = await db.job.findUnique({
          where: { dedupeKey: `admission:${d.id}:${d.version}` },
        });
        if (job?.state === 'CANCELLED' || (job?.state === 'FAILED' && job.attempts >= 4)) {
          item.state = 'FAILED';
          item.message = job.error ?? 'PDF 任务失败';
        }
      }
    }
    await save();
    if (result.items.some((item) => item.state === 'QUEUED')) await pause(1500);
  }
  await save('SUCCESS');
  return { batchId: batch.id };
}
