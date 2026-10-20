import { connector } from '@contest-center/connectors';
import { provisioningResultSchema, type ProvisioningResultV1 } from '@contest-center/contracts';
import { db, lock, json, registrationInclude, type Tx } from './db.js';
import { decrypt } from './security.js';
import { envelope, platformConfig } from './integrations.js';
import { modulesFor } from './workflow.js';
import { recordRemoteRevocation, supersedeRemoteRevocations } from './registration-removal.js';
import { redis } from './auth.js';

export async function synchronizePlatform(job: { id: string; payload: unknown }) {
  const payload = job.payload as Record<string, any>;
  const mappingId = String(payload.mappingId);
  const initial = await db.$transaction(async (tx) => {
    const found = await tx.accountMapping.findUniqueOrThrow({
      where: { id: mappingId },
      include: { binding: { select: { instanceId: true } } },
    });
    await lock(tx, `platform-instance:${found.binding.instanceId}`);
    await lock(tx, found.registrationId);
    await lock(tx, `sync:${mappingId}`);
    const mapping = await tx.accountMapping.findUniqueOrThrow({ where: { id: mappingId } });
    const registration = await tx.registration.findUniqueOrThrow({
      where: { id: mapping.registrationId },
      include: registrationInclude,
    });
    if (
      mapping.syncJobId &&
      mapping.syncJobId !== job.id &&
      mapping.syncLeaseUntil &&
      mapping.syncLeaseUntil > new Date()
    )
      throw new Error('此平台映射仍有同步任务执行中，请稍后重试');
    await tx.accountMapping.update({
      where: { id: mappingId },
      data: { syncJobId: job.id, syncLeaseUntil: new Date(Date.now() + 120000) },
    });
    const binding = await tx.platformBinding.findUniqueOrThrow({
      where: { id: mapping.bindingId },
      include: { instance: true },
    });
    return { mapping, registration, binding };
  });
  const { mapping, registration, binding } = initial;
  const breakerKey = `platform-breaker:${binding.instanceId}`;
  const target = {
    platformName: binding.instance.name,
    baseUrl: binding.instance.baseUrl,
    remoteContestId: binding.remoteContestId,
    username: mapping.username,
    reason: 'STALE_SYNC_RESULT',
  };
  let remoteStarted = false;
  let latest: ProvisioningResultV1 | undefined;
  async function current(tx: Tx) {
    const r = await tx.registration.findUnique({
      where: { id: registration.id },
      include: { contest: true },
    });
    const b = await tx.platformBinding.findUnique({
      where: { id: mapping.bindingId },
      include: { instance: true },
    });
    const m = await tx.accountMapping.findUnique({ where: { id: mappingId } });
    const school = payload.organizationMappingId
      ? await tx.organizationMapping.findUnique({
          where: { id: String(payload.organizationMappingId) },
        })
      : undefined;
    const running = await tx.job.count({ where: { id: job.id, state: 'RUNNING' } });
    return !!(
      r &&
      b &&
      m &&
      running &&
      m.syncJobId === job.id &&
      r.eligible &&
      r.version === payload.version &&
      modulesFor(r.contest).integrations &&
      b.enabled &&
      b.instance.enabled &&
      b.version === payload.bindingVersion &&
      b.instance.version === payload.instanceVersion &&
      (!payload.organizationMappingId ||
        (school && school.status === 'CONFIRMED' && school.version === payload.organizationVersion))
    );
  }
  async function checkpoint(output?: ProvisioningResultV1) {
    const valid = await db.$transaction(async (tx) => {
      await lock(tx, registration.id);
      await lock(tx, `sync:${mappingId}`);
      if (!(await current(tx))) {
        if (output)
          await recordRemoteRevocation(
            tx,
            {
              bindingId: mapping.bindingId,
              registrationId: registration.id,
              remoteUserId: output.remoteUserId ?? null,
              remoteTeamId: output.remoteTeamId ?? null,
            },
            registration.contestId,
            target,
          );
        return false;
      }
      if (output) {
        await tx.accountMapping.update({
          where: { id: mappingId },
          data: {
            state: output.state,
            remoteUserId: output.remoteUserId,
            remoteTeamId: output.remoteTeamId,
            details: json({
              ...output,
              registrationVersion: payload.version,
              bindingVersion: payload.bindingVersion,
            }),
          },
        });
        if (output.state === 'VERIFIED')
          await supersedeRemoteRevocations(tx, {
            ...output,
            bindingId: mapping.bindingId,
            registrationId: registration.id,
          });
        await tx.job.updateMany({
          where: { id: job.id, state: 'RUNNING' },
          data: { result: json(output) },
        });
      }
      return true;
    });
    if (!valid) throw new Error('报名、学校或平台配置已改变；远端结果已登记撤权待办');
  }
  try {
    if (Number(await redis.get(breakerKey)) >= 3)
      throw new Error('平台连续失败，暂停重试一分钟后再尝试');
    const config = await platformConfig(mapping.bindingId);
    config.configuration.organizationId = payload.organizationId
      ? String(payload.organizationId)
      : undefined;
    config.configuration.requestDeadline = Date.now() + 60000;
    if (
      mapping.remoteTeamId &&
      config.type === 'DOMJUDGE' &&
      (await db.accountMapping.count({
        where: {
          id: { not: mappingId },
          remoteTeamId: mapping.remoteTeamId,
          binding: { instanceId: binding.instanceId },
        },
      }))
    )
      throw new Error('历史远端队伍被其他绑定共享，请先解除映射冲突');
    await checkpoint();
    remoteStarted = true;
    const output = provisioningResultSchema.parse(
      await connector(config.type).provisionRegistration(config.configuration, {
        envelope: await envelope(registration),
        username: mapping.username,
        password: decrypt(mapping.credential),
        remoteTeamId: payload.remoteTeamId ? String(payload.remoteTeamId) : undefined,
        remoteUserId: mapping.remoteUserId ?? undefined,
        onProgress: async (value) => {
          latest = provisioningResultSchema.parse(value);
          await checkpoint(latest);
        },
      }),
    );
    latest = output;
    if (output.state !== 'VERIFIED') throw new Error('平台未确认账号、队伍及目标比赛访问');
    await checkpoint(output);
    await redis.del(breakerKey);
    return output;
  } catch (error) {
    if (remoteStarted) {
      await db.$transaction(async (tx) => {
        await lock(tx, registration.id);
        if (!(await current(tx))) {
          await recordRemoteRevocation(
            tx,
            {
              bindingId: mapping.bindingId,
              registrationId: registration.id,
              remoteUserId: latest?.remoteUserId ?? mapping.remoteUserId,
              remoteTeamId:
                latest?.remoteTeamId ??
                mapping.remoteTeamId ??
                (payload.remoteTeamId ? String(payload.remoteTeamId) : null),
            },
            registration.contestId,
            target,
          );
        }
      });
      if ((await redis.incr(breakerKey)) === 1) await redis.expire(breakerKey, 60);
    }
    throw error;
  } finally {
    await db.accountMapping.updateMany({
      where: { id: mappingId, syncJobId: job.id },
      data: { syncJobId: null, syncLeaseUntil: null },
    });
  }
}
