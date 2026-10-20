import { synchronizePlatform } from './platform-sync.js';
import { postWebhook } from './webhook-http.js';
import { Queue, Worker } from 'bullmq';
import { mkdir, writeFile, readFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { connector } from '@contest-center/connectors';
import { db, json, event, lock, enqueue, registrationInclude, type Registration } from './db.js';
import { claimJob, renewJobLease, recoverExpiredJobs } from './job-lease.js';
import { config } from './config.js';
import { decrypt, hmac, safeUrl, sha } from './security.js';
import { platformConfig, envelope, scheduleSync } from './integrations.js';
import { admissionMaterial, activeTemplate } from './admissions.js';
import { modulesFor } from './workflow.js';
import { migrateCancelledRegistrations } from './registration-removal.js';
import { renderTemplate } from './templates.js';
import { sendSystemMail } from './mail.js';
import { publicLink } from './site-settings.js';
import { putBlob, removeBlob, migrateObjects, type StorageRef } from './storage.js';
const redisUrl = new URL(config.redisUrl);
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password || undefined,
};
const queue = new Queue('contest-center', { connection });
async function compile(
  id: string,
  leaseToken: string,
  source: string,
  assets: Record<string, string> = {},
) {
  const dir = path.join(config.spool, `${id}-${leaseToken}`);
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'request.tmp'), JSON.stringify({ source, assets }), {
      mode: 0o600,
    });
    await rename(path.join(dir, 'request.tmp'), path.join(dir, 'request.json'));
    let result: { ok: boolean; error?: string } | undefined;
    for (let i = 0; i < 90; i++) {
      const current = await db.job.findUnique({
        where: { id },
        select: { state: true, leaseToken: true },
      });
      if (current?.state !== 'RUNNING' || current.leaseToken !== leaseToken)
        throw new Error('任务已取消或执行租约已失效');
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
    const storageKey = `pdf-${id}-${leaseToken}`;
    const ref = await putBlob(storageKey, pdf, 'application/pdf');
    return ref;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
await migrateCancelledRegistrations();
const worker = new Worker(
  'contest-center',
  async (qjob) => {
    const j = await db.job.findUniqueOrThrow({ where: { id: qjob.data.id } });
    if (j.state === 'SUCCESS') return;
    const leaseToken = await claimJob(j.id);
    if (!leaseToken) return;
    const owned = { id: j.id, state: 'RUNNING', leaseToken };
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        await renewJobLease(j.id, leaseToken);
      } catch (error) {
        console.warn('Job lease renewal failed:', error instanceof Error ? error.name : 'error');
      } finally {
        renewing = false;
      }
    }, 20000);
    heartbeat.unref();
    let producedBlob: StorageRef | undefined;
    try {
      const p = j.payload as Record<string, unknown>;
      let result: unknown = { ok: true };
      if (
        (j.kind === 'MAIL' &&
          String(p.actionPath ?? '').startsWith('/registrations/') &&
          p.finance !== true) ||
        ['ADMISSION', 'SYNC'].includes(j.kind)
      ) {
        if (!(await db.registration.count({ where: { id: j.resourceId } }))) {
          await db.job.updateMany({
            where: owned,
            data: { state: 'CANCELLED', payload: {}, result: { deleted: true } },
          });
          return;
        }
      }
      if (j.kind === 'MAIL') {
        if (p.templateTest === true) {
          const template = await db.mailTemplate.findUnique({ where: { key: String(p.category) } });
          if ((template?.version ?? 0) !== p.templateVersion)
            throw new Error('邮件模板已变更，请重新发送模板测试邮件');
        }
        if (typeof p.registrationTokenId === 'string') {
          const verification = await db.registrationVerification.findUnique({
            where: { id: p.registrationTokenId },
          });
          if (
            !verification ||
            verification.usedAt ||
            verification.expiresAt <= new Date() ||
            verification.email !== p.to
          ) {
            await db.job.updateMany({
              where: owned,
              data: { state: 'SUCCESS', result: { skipped: true, reason: '注册验证码已失效' } },
            });
            return;
          }
        }
        const token =
          typeof p.verificationTokenId === 'string'
            ? await db.emailToken.findUnique({
                where: { id: p.verificationTokenId },
              })
            : undefined;
        const tokenUser = token
          ? await db.user.findUnique({ where: { id: token.userId } })
          : undefined;
        if (
          typeof p.verificationTokenId === 'string' &&
          (!token ||
            token.usedAt ||
            token.expiresAt <= new Date() ||
            !tokenUser ||
            tokenUser.deactivatedAt ||
            tokenUser.bannedAt ||
            tokenUser.email !== p.to)
        ) {
          await db.job.updateMany({
            where: owned,
            data: { state: 'SUCCESS', result: { skipped: true, reason: '验证码已失效' } },
          });
          return;
        }
        result = await sendSystemMail(
          {
            to: String(p.to),
            subject: String(p.subject),
            text: String(p.text),
            actionPath: typeof p.actionPath === 'string' ? p.actionPath : undefined,
            category: String(p.category ?? 'GENERIC'),
            code: typeof p.encryptedCode === 'string' ? decrypt(p.encryptedCode) : undefined,
            name: typeof p.name === 'string' ? p.name : undefined,
            status: typeof p.status === 'string' ? p.status : undefined,
          },
          p.test === true ? Number(p.configurationVersion) : undefined,
          String(p.actionPath ?? '').startsWith('/registrations/') && p.finance !== true
            ? async () =>
                !!(await db.registration.count({ where: { id: j.resourceId } })) &&
                (await db.job.findUnique({ where: { id: j.id }, select: { state: true } }))
                  ?.state === 'RUNNING'
            : undefined,
        );
      } else if (j.kind === 'PDF_PREVIEW') {
        result = await compile(j.id, leaseToken, String(p.source));
        producedBlob = result as StorageRef;
      } else if (j.kind === 'STORAGE_MIGRATION') {
        result = await migrateObjects(String(p.profileId), j.id);
      } else if (j.kind === 'SPOOL_DELETE') {
        if (!/^[a-f0-9-]{36}$/.test(String(p.jobId))) throw new Error('Invalid spool job');
        for (const name of await readdir(config.spool))
          if (name === p.jobId || name.startsWith(`${p.jobId}-`))
            await rm(path.join(config.spool, name), { recursive: true, force: true });
      } else if (j.kind === 'OBJECT_DELETE') {
        await removeBlob(p.storageRef as StorageRef);
        await db.attachment.updateMany({
          where: {
            id: j.resourceId,
            deletedAt: { not: null },
            storageKey: (p.storageRef as StorageRef).storageKey!,
            storageBackend: (p.storageRef as StorageRef).storageBackend ?? 'LOCAL',
            storageConfigId: (p.storageRef as StorageRef).storageConfigId ?? null,
          },
          data: { purgedAt: new Date() },
        });
      } else if (j.kind === 'ADMISSION') {
        const document = await db.admissionDocument.findUniqueOrThrow({
          where: { id: String(p.documentId) },
        });
        const r = await db.registration.findUniqueOrThrow({
          where: { id: document.registrationId },
          include: registrationInclude,
        });
        if (
          !modulesFor(r.contest).admissions ||
          !r.eligible ||
          r.version !== document.registrationVersion
        )
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
        const storageRef = await compile(j.id, leaseToken, source, material.assets);
        producedBlob = storageRef;
        await db.$transaction(async (tx) => {
          await lock(tx, r.id);
          if (!(await tx.job.count({ where: owned }))) throw new Error('执行租约已失效');
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
              ...storageRef,
              state: document.releaseAt && document.releaseAt <= new Date() ? 'RELEASED' : 'READY',
              releasedAt:
                document.releaseAt && document.releaseAt <= new Date() ? new Date() : null,
              error: null,
            },
          });
          if (document.releaseAt && document.releaseAt <= new Date())
            await event(tx, 'NOTIFY', r.id, {
              message: '您的准考证已发放，可以下载。',
              category: 'ADMISSION',
              status: 'RELEASED',
            });
        });
        producedBlob = undefined;
        result = { documentId: document.id };
      } else if (j.kind === 'SYNC') {
        result = await synchronizePlatform(j);
      } else if (j.kind === 'WEBHOOK') {
        const hook = await db.webhook.findUniqueOrThrow({ where: { id: String(p.webhookId) } });
        if (!hook.enabled) throw new Error('Webhook disabled');
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify(p.body);
        const signature = hmac(decrypt(hook.secret), `${timestamp}.${body}`);
        await postWebhook(
          hook.url,
          body,
          {
            'Content-Type': 'application/json',
            'X-ContestCenter-Event': String((p.body as Record<string, unknown>).eventId),
            'X-ContestCenter-Timestamp': timestamp,
            'X-ContestCenter-Signature': `sha256=${signature}`,
          },
          !!hook.privateApprovedBy,
        );
      }
      const completed = await db.job.updateMany({
        where: owned,
        data: { state: 'SUCCESS', result: json(result), leaseToken: null, leaseUntil: null },
      });
      if (!completed.count) throw new Error('执行租约已失效');
      producedBlob = undefined;
    } catch (error) {
      if (producedBlob) await removeBlob(producedBlob).catch(() => undefined);
      if (!(await db.job.count({ where: owned }))) return;
      const message = (error instanceof Error ? error.message : 'Task failed').slice(0, 1500);
      await db.job.updateMany({
        where: owned,
        data: { state: 'FAILED', error: message, leaseToken: null, leaseUntil: null },
      });
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
        const payload = j.payload as Record<string, unknown>;
        const r = m && (await db.registration.findUnique({ where: { id: m.registrationId } }));
        const b = m && (await db.platformBinding.findUnique({ where: { id: m.bindingId } }));
        if (m && r?.version === payload.version && b?.version === payload.bindingVersion)
          await db.accountMapping.updateMany({
            where: {
              id: m.id,
              registration: { version: Number(payload.version) },
              binding: {
                version: Number(payload.bindingVersion),
                instance: { version: Number(payload.instanceVersion) },
              },
            },
            data: { state: 'FAILED', details: json({ ...(m.details as object), error: message }) },
          });
      }
      throw new Error(message);
    } finally {
      clearInterval(heartbeat);
      await db.job.updateMany({
        where: { id: j.id, leaseToken },
        data: { leaseToken: null, leaseUntil: null },
      });
    }
  },
  { connection, concurrency: 2 },
);
worker.on('error', (e) => console.error('Worker unavailable:', e.name));
worker.on('failed', (j) =>
  console.warn(`Task ${j?.id} failed; details available to its authorized administrator`),
);
let nextRetentionCleanup = 0;
async function dispatch() {
  if (Date.now() >= nextRetentionCleanup) {
    const expired = await db.idempotencyRecord.findMany({
      where: { createdAt: { lt: new Date(Date.now() - 86400000) } },
      select: { id: true },
      take: 1000,
    });
    if (expired.length)
      await db.idempotencyRecord.deleteMany({
        where: {
          id: { in: expired.map((r) => r.id) },
          createdAt: { lt: new Date(Date.now() - 86400000) },
        },
      });
    const unpurged = await db.attachment.findMany({
      where: { deletedAt: { not: null }, purgedAt: null },
      take: 100,
      orderBy: { deletedAt: 'asc' },
    });
    for (const file of unpurged)
      await db.$transaction((tx) =>
        enqueue(
          tx,
          'OBJECT_DELETE',
          file.id,
          `purge-file:${file.id}:${sha(JSON.stringify([file.storageBackend, file.storageConfigId, file.storageKey]))}`,
          { storageRef: file },
        ),
      );
    nextRetentionCleanup = Date.now() + 60000;
  }
  const events = await db.outboxEvent.findMany({
    where: {
      deliveredAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  for (const e of events) {
    try {
      await db.$transaction(async (tx) => {
        await lock(tx, `outbox:${e.id}`);
        const currentEvent = await tx.outboxEvent.findUnique({ where: { id: e.id } });
        if (!currentEvent || currentEvent.deliveredAt) return;
        const p = e.payload as Record<string, unknown>;
        const registrationMail =
          e.type === 'MAIL' &&
          String(p.actionPath ?? '').startsWith('/registrations/') &&
          p.finance !== true;
        if (['NOTIFY', 'ELIGIBILITY'].includes(e.type) || registrationMail)
          await lock(tx, e.resourceId);
        if (registrationMail && !(await tx.registration.count({ where: { id: e.resourceId } }))) {
          await tx.outboxEvent.deleteMany({ where: { id: e.id } });
          return;
        }
        if (e.type === 'TASK')
          await tx.job.updateMany({
            where: { id: String(p.jobId), state: 'OUTBOX' },
            data: { state: 'PENDING' },
          });
        else if (e.type === 'SYNC_REQUEST') {
          const registration = await tx.registration.findUnique({ where: { id: e.resourceId } });
          const binding = await tx.platformBinding.findUnique({
            where: { id: String(p.bindingId) },
            include: { instance: true },
          });
          if (registration?.eligible && binding?.enabled && binding.instance.enabled)
            await scheduleSync(tx, registration.id, binding.id, p.restart === true);
        } else if (e.type === 'MAIL')
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
            const people = await tx.registrationPerson.findMany({
              where: { registrationId: r.id, active: true },
              select: { userId: true },
            });
            const ids = [
              r.ownerId,
              ...r.coaches.map((c) => c.userId),
              ...people.flatMap((x) => (x.userId ? [x.userId] : [])),
            ];
            const personIds = (
              await tx.user.findMany({ where: { id: { in: ids } }, select: { personId: true } })
            ).flatMap((x) => (x.personId ? [x.personId] : []));
            const users = await tx.user.findMany({
              where: {
                OR: [{ id: { in: ids } }, { personId: { in: personIds } }],
                verified: true,
                deactivatedAt: null,
              },
            });
            for (const u of users)
              await tx.job.upsert({
                where: { dedupeKey: `mail:${e.id}:${u.id}` },
                create: {
                  kind: 'MAIL',
                  resourceId: r.id,
                  dedupeKey: `mail:${e.id}:${u.id}`,
                  payload: json({
                    to: u.email,
                    subject:
                      p.category === 'ADMISSION'
                        ? '准考证已发放'
                        : p.category === 'INVOICE'
                          ? '开票处理结果'
                          : '竞赛报名状态更新',
                    name: u.name,
                    status: typeof p.status === 'string' ? p.status : '',
                    text: String(p.message),
                    category: String(p.category ?? 'REGISTRATION'),
                    actionPath: `/registrations/${r.id}`,
                  }),
                },
                update: {},
              });
          }
        } else if (e.type === 'REGISTRATION_REMOVED') {
          const hooks = await tx.webhook.findMany({
            where: { enabled: true, OR: [{ contestId: String(p.contestId) }, { contestId: null }] },
          });
          for (const hook of hooks)
            await tx.job.upsert({
              where: { dedupeKey: `hook:${e.id}:${hook.id}` },
              create: {
                kind: 'WEBHOOK',
                resourceId: e.resourceId,
                dedupeKey: `hook:${e.id}:${hook.id}`,
                payload: json({
                  webhookId: hook.id,
                  body: {
                    schemaVersion: 1,
                    eventId: e.id,
                    type: 'registration.eligibility',
                    registrationId: e.resourceId,
                    contestId: p.contestId,
                    version: p.version,
                    eligible: false,
                    deleted: true,
                  },
                }),
              },
              update: {},
            });
        } else if (e.type === 'ELIGIBILITY') {
          const r = await tx.registration.findUnique({ where: { id: e.resourceId } });
          if (!r) {
            await tx.outboxEvent.updateMany({
              where: { id: e.id },
              data: { deliveredAt: new Date() },
            });
            return;
          }
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
        await tx.outboxEvent.updateMany({ where: { id: e.id }, data: { deliveredAt: new Date() } });
      });
    } catch (error) {
      await db.outboxEvent.updateMany({
        where: { id: e.id, deliveredAt: null },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(
            Date.now() + Math.min(300000, 30000 * 2 ** Math.min(e.attempts, 4)),
          ),
        },
      });
      console.warn(`Outbox event ${e.id} deferred:`, error instanceof Error ? error.name : 'error');
    }
  }
  await recoverExpiredJobs();
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
    const queueId = j.id;
    const previous = await queue.getJob(queueId);
    if (previous) {
      const state = await previous.getState();
      if (['completed', 'failed'].includes(state)) await previous.remove();
      else continue;
    }
    await queue.add(
      j.kind,
      { id: j.id },
      {
        jobId: queueId,
        removeOnComplete: 100,
        removeOnFail: 100,
        priority: j.kind === 'MAIL' ? 1 : j.kind === 'ADMISSION' ? 5 : 10,
      },
    );
  }
  const scheduled = await db.admissionDocument.findMany({
    where: { state: 'READY', releaseAt: { lte: new Date() } },
    take: 100,
  });
  for (const a of scheduled) {
    const r = await db.registration.findUnique({ where: { id: a.registrationId } });
    if (!r) continue;
    if (
      r.eligible &&
      r.version === a.registrationVersion &&
      (await activeTemplate(r.contestId))?.id === a.templateId
    )
      await db.$transaction(async (tx) => {
        await lock(tx, a.registrationId);
        const current = await tx.admissionDocument.findUniqueOrThrow({ where: { id: a.id } }),
          registration = await tx.registration.findUniqueOrThrow({
            where: { id: a.registrationId },
          });
        if (
          current.state !== 'READY' ||
          current.version !== a.version ||
          !registration.eligible ||
          registration.version !== a.registrationVersion ||
          (await activeTemplate(registration.contestId, tx))?.id !== a.templateId
        )
          return;
        const released = await tx.admissionDocument.updateMany({
          where: { id: a.id, version: a.version, state: 'READY' },
          data: { state: 'RELEASED', releasedAt: new Date() },
        });
        if (!released.count) return;
        await event(tx, 'NOTIFY', a.registrationId, {
          message: '您的准考证已发放，可以下载。',
          category: 'ADMISSION',
          status: 'RELEASED',
        });
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
