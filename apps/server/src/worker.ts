import { Queue, Worker } from 'bullmq';
import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { connector } from '@contest-center/connectors';
import { db, json, event, lock, registrationInclude, type Registration } from './db.js';
import { config } from './config.js';
import { decrypt, hmac, safeUrl } from './security.js';
import { platformConfig, envelope, scheduleSync } from './integrations.js';
import { admissionMaterial, activeTemplate } from './admissions.js';
import { renderTemplate } from './templates.js';
import { sendSystemMail } from './mail.js';
const redisUrl = new URL(config.redisUrl);
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password || undefined,
};
const queue = new Queue('contest-center', { connection });
async function compile(id: string, source: string, assets: Record<string, string> = {}) {
  const dir = path.join(config.spool, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, 'request.tmp'), JSON.stringify({ source, assets }), {
    mode: 0o600,
  });
  await rename(path.join(dir, 'request.tmp'), path.join(dir, 'request.json'));
  let result: { ok: boolean; error?: string } | undefined;
  for (let i = 0; i < 90; i++) {
    try {
      result = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'));
      break;
    } catch {
      await pause(1000);
    }
  }
  if (!result?.ok)
    throw new Error(result?.error ?? 'LaTeX runner did not complete within 90 seconds');
  const pdf = await readFile(path.join(dir, 'document.pdf'));
  if (pdf.length > 10 * 1024 * 1024 || pdf.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('Invalid compiler output');
  await mkdir(config.storage, { recursive: true, mode: 0o700 });
  const storageKey = `pdf-${id}`;
  await writeFile(path.join(config.storage, storageKey), pdf, { mode: 0o600 });
  await rm(dir, { recursive: true, force: true });
  return storageKey;
}
const worker = new Worker(
  'contest-center',
  async (qjob) => {
    const j = await db.job.findUniqueOrThrow({ where: { id: qjob.data.id } });
    if (j.state === 'SUCCESS') return;
    const claimed = await db.job.updateMany({
      where: { id: j.id, state: { in: ['PENDING', 'FAILED'] } },
      data: { state: 'RUNNING', attempts: { increment: 1 }, error: null },
    });
    if (!claimed.count) return;
    try {
      const p = j.payload as Record<string, unknown>;
      let result: unknown = { ok: true };
      if (j.kind === 'MAIL') {
        result = await sendSystemMail(
          {
            to: String(p.to),
            subject: String(p.subject),
            text: String(p.text),
          },
          p.test === true ? Number(p.configurationVersion) : undefined,
        );
      } else if (j.kind === 'PDF_PREVIEW') {
        result = { storageKey: await compile(j.id, String(p.source)) };
      } else if (j.kind === 'ADMISSION') {
        const document = await db.admissionDocument.findUniqueOrThrow({
          where: { id: String(p.documentId) },
        });
        const r = await db.registration.findUniqueOrThrow({
          where: { id: document.registrationId },
          include: registrationInclude,
        });
        if (!r.eligible || r.version !== document.registrationVersion)
          throw new Error('Registration changed or no longer eligible');
        const template = await activeTemplate(r.contestId);
        if (
          !template ||
          template.id !== document.templateId ||
          document.version !== p.documentVersion
        )
          throw new Error('Document or template version has changed');
        const material = await admissionMaterial(r, document);
        const source = renderTemplate(template.source, material.context);
        const storageKey = await compile(j.id, source, material.assets);
        await db.$transaction(async (tx) => {
          await lock(tx, r.id);
          const current = await tx.registration.findUniqueOrThrow({ where: { id: r.id } });
          if (
            !current.eligible ||
            current.version !== document.registrationVersion ||
            (await activeTemplate(r.contestId, tx))?.id !== template.id
          )
            throw new Error('Registration changed during compilation');
          await tx.admissionDocument.update({
            where: { id: document.id, version: Number(p.documentVersion) },
            data: {
              storageKey,
              state: document.releaseAt && document.releaseAt <= new Date() ? 'RELEASED' : 'READY',
              releasedAt:
                document.releaseAt && document.releaseAt <= new Date() ? new Date() : null,
              error: null,
            },
          });
        });
        result = { documentId: document.id };
      } else if (j.kind === 'SYNC') {
        const mapping = await db.accountMapping.findUniqueOrThrow({
          where: { id: String(p.mappingId) },
        });
        const r = await db.registration.findUniqueOrThrow({
          where: { id: mapping.registrationId },
          include: registrationInclude,
        });
        if (!r.eligible) throw new Error('Registration no longer eligible');
        if (r.version !== p.version)
          throw new Error('Registration version changed before synchronization');
        const c = await platformConfig(mapping.bindingId);
        const input = {
          envelope: await envelope(r),
          username: mapping.username,
          password: decrypt(mapping.credential),
          onProgress: async (output: import('@contest-center/contracts').ProvisioningResultV1) => {
            await db.accountMapping.update({
              where: { id: mapping.id },
              data: {
                state: output.state,
                remoteUserId: output.remoteUserId,
                remoteTeamId: output.remoteTeamId,
                details: json(output),
              },
            });
            await db.job.update({ where: { id: j.id }, data: { result: json(output) } });
          },
        };
        const output = await connector(c.type).provisionRegistration(c.configuration, input);
        if (output.state !== 'VERIFIED')
          throw new Error('Platform did not verify account and contest access');
        const current = await db.registration.findUniqueOrThrow({ where: { id: r.id } });
        await db.accountMapping.update({
          where: { id: mapping.id },
          data: {
            state:
              current.eligible && current.version === p.version ? 'VERIFIED' : 'REVOKED_LOCALLY',
            remoteUserId: output.remoteUserId,
            remoteTeamId: output.remoteTeamId,
            details: json(output),
          },
        });
        result = output;
      } else if (j.kind === 'WEBHOOK') {
        const hook = await db.webhook.findUniqueOrThrow({ where: { id: String(p.webhookId) } });
        if (!hook.enabled) throw new Error('Webhook disabled');
        await safeUrl(hook.url);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify(p.body);
        const signature = hmac(decrypt(hook.secret), `${timestamp}.${body}`);
        const response = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-ContestCenter-Event': String((p.body as Record<string, unknown>).eventId),
            'X-ContestCenter-Timestamp': timestamp,
            'X-ContestCenter-Signature': `sha256=${signature}`,
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
      }
      await db.job.update({
        where: { id: j.id },
        data: { state: 'SUCCESS', result: json(result) },
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Task failed').slice(0, 1500);
      await db.job.update({ where: { id: j.id }, data: { state: 'FAILED', error: message } });
      if (j.kind === 'ADMISSION')
        await db.admissionDocument.updateMany({
          where: {
            id: String((j.payload as Record<string, unknown>).documentId),
            version: Number((j.payload as Record<string, unknown>).documentVersion),
          },
          data: { state: 'FAILED', error: message },
        });
      if (j.kind === 'SYNC') {
        const m = await db.accountMapping.findUnique({
          where: { id: String((j.payload as Record<string, unknown>).mappingId) },
        });
        if (m)
          await db.accountMapping.update({
            where: { id: m.id },
            data: { state: 'FAILED', details: json({ ...(m.details as object), error: message }) },
          });
      }
      throw new Error(message);
    }
  },
  { connection, concurrency: 2 },
);
worker.on('error', (e) => console.error('Worker unavailable:', e.name));
worker.on('failed', (j) =>
  console.warn(`Task ${j?.id} failed; details available to its authorized administrator`),
);
async function dispatch() {
  const events = await db.outboxEvent.findMany({
    where: { deliveredAt: null },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  for (const e of events) {
    await db.$transaction(async (tx) => {
      await lock(tx, `outbox:${e.id}`);
      if ((await tx.outboxEvent.findUniqueOrThrow({ where: { id: e.id } })).deliveredAt) return;
      const p = e.payload as Record<string, unknown>;
      if (e.type === 'TASK')
        await tx.job.updateMany({
          where: { id: String(p.jobId), state: 'OUTBOX' },
          data: { state: 'PENDING' },
        });
      else if (e.type === 'MAIL')
        await tx.job.upsert({
          where: { dedupeKey: `event:${e.id}` },
          create: {
            kind: 'MAIL',
            resourceId: e.resourceId,
            dedupeKey: `event:${e.id}`,
            payload: json(p),
          },
          update: {},
        });
      else if (e.type === 'NOTIFY') {
        const r = await tx.registration.findUnique({
          where: { id: e.resourceId },
          include: { coaches: true },
        });
        if (r) {
          const ids = [r.ownerId, ...r.coaches.map((c) => c.userId)];
          const users = await tx.user.findMany({ where: { id: { in: ids }, verified: true } });
          for (const u of users)
            await tx.job.upsert({
              where: { dedupeKey: `mail:${e.id}:${u.id}` },
              create: {
                kind: 'MAIL',
                resourceId: r.id,
                dedupeKey: `mail:${e.id}:${u.id}`,
                payload: json({
                  to: u.email,
                  subject: '竞赛报名状态更新',
                  text: `${p.message}\n${config.publicUrl}/registrations/${r.id}`,
                }),
              },
              update: {},
            });
        }
      } else if (e.type === 'ELIGIBILITY') {
        const r = await tx.registration.findUniqueOrThrow({ where: { id: e.resourceId } });
        if (r.eligible) {
          const bindings = await tx.platformBinding.findMany({
            where: {
              contestId: r.contestId,
              automatic: true,
              enabled: true,
              instance: { enabled: true },
            },
          });
          for (const b of bindings) await scheduleSync(tx, r.id, b.id);
        } else
          await tx.accountMapping.updateMany({
            where: { registrationId: r.id, state: 'VERIFIED' },
            data: { state: 'REVOKED_LOCALLY' },
          });
        const hooks = await tx.webhook.findMany({
          where: { enabled: true, OR: [{ contestId: r.contestId }, { contestId: null }] },
        });
        for (const hook of hooks)
          await tx.job.upsert({
            where: { dedupeKey: `hook:${e.id}:${hook.id}` },
            create: {
              kind: 'WEBHOOK',
              resourceId: r.id,
              dedupeKey: `hook:${e.id}:${hook.id}`,
              payload: json({
                webhookId: hook.id,
                body: {
                  schemaVersion: 1,
                  eventId: e.id,
                  type: 'registration.eligibility',
                  registrationId: r.id,
                  contestId: r.contestId,
                  version: r.version,
                  eligible: r.eligible,
                },
              }),
            },
            update: {},
          });
      }
      await tx.outboxEvent.update({ where: { id: e.id }, data: { deliveredAt: new Date() } });
    });
  }
  await db.job.updateMany({
    where: { state: 'RUNNING', updatedAt: { lt: new Date(Date.now() - 5 * 60000) } },
    data: { state: 'PENDING' },
  });
  const pending = await db.job.findMany({
    where: {
      OR: [
        { state: 'PENDING' },
        { state: 'FAILED', attempts: { lt: 4 }, updatedAt: { lt: new Date(Date.now() - 30000) } },
      ],
    },
    take: 50,
  });
  for (const j of pending) {
    const queueId = `${j.id}-${j.attempts}`;
    const previous = await queue.getJob(queueId);
    if (previous) {
      const state = await previous.getState();
      if (['completed', 'failed'].includes(state)) await previous.remove();
      else continue;
    }
    await queue.add(
      j.kind,
      { id: j.id },
      { jobId: queueId, removeOnComplete: 100, removeOnFail: 100 },
    );
  }
  const scheduled = await db.admissionDocument.findMany({
    where: { state: 'READY', releaseAt: { lte: new Date() } },
    take: 100,
  });
  for (const a of scheduled) {
    const r = await db.registration.findUniqueOrThrow({ where: { id: a.registrationId } });
    if (
      r.eligible &&
      r.version === a.registrationVersion &&
      (await activeTemplate(r.contestId))?.id === a.templateId
    )
      await db.admissionDocument.update({
        where: { id: a.id },
        data: { state: 'RELEASED', releasedAt: new Date() },
      });
  }
  await db.setting.upsert({
    where: { key: 'workerHeartbeat' },
    create: { key: 'workerHeartbeat', value: { at: new Date().toISOString() } },
    update: { value: { at: new Date().toISOString() } },
  });
}
console.log('Contest Center worker ready');
while (true) {
  try {
    await dispatch();
  } catch (e) {
    console.error('Dispatcher retry:', e instanceof Error ? e.name : 'error');
  }
  await pause(1500);
}
