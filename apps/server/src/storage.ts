import { BadRequestException } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile, rm, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { StorageConfiguration } from '@prisma/client';
import type { Principal } from '@contest-center/contracts';
import { db, json, lock, audit, enqueue } from './db.js';
import { config } from './config.js';
import { encrypt, decrypt, requireSystemAdmin, checkVersion } from './security.js';

export type StorageRef = {
  storageKey: string | null;
  storageBackend?: string;
  storageConfigId?: string | null;
  sha256?: string;
};
async function storageOwner() {
  const row = await db.setting.upsert({
    where: { key: 'storage-owner' },
    create: { key: 'storage-owner', value: { id: randomUUID() } },
    update: {},
  });
  const id = String((row.value as any).id ?? '');
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new BadRequestException('存储归属标记无效');
  return id;
}
const reconciliationCursors = new Map<string, string>();
export async function reconcileStorage(now = Date.now()) {
  const cutoff = now - 86400000;
  const owner = await storageOwner(),
    started = Date.now();
  const referenced = async (key: string, backend: string, profileId: string | null) =>
    (await db.attachment.count({
      where: { storageKey: key, storageBackend: backend, purgedAt: null },
    })) ||
    (await db.admissionDocument.count({ where: { storageKey: key, storageBackend: backend } })) ||
    (await db.job.count({
      where: { kind: 'PDF_PREVIEW', result: { path: ['storageKey'], equals: key } },
    })) ||
    (await db.admissionBatch.count({
      where: {
        expiresAt: { gt: new Date() },
        result: { path: ['files'], array_contains: [{ storageKey: key }] },
      },
    }));
  await mkdir(config.storage, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(config.storage, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]{1,200}$/.test(entry.name)) continue;
    if (Date.now() - started > 30000) break;
    if (
      (await readFile(path.join(config.storage, `${entry.name}.nxopa-owner`), 'utf8').catch(
        () => '',
      )) !== owner
    )
      continue;
    if (
      (await stat(path.join(config.storage, entry.name))).mtimeMs >= cutoff ||
      (await referenced(entry.name, 'LOCAL', null))
    )
      continue;
    await removeBlob({ storageKey: entry.name, storageBackend: 'LOCAL' });
  }
  for (const profile of await db.storageConfiguration.findMany()) {
    const s3 = client(profile),
      prefix = profile.prefix ? `${profile.prefix.replace(/\/+$/, '')}/` : '';
    if (Date.now() - started > 30000) break;
    try {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: profile.bucket,
          Prefix: prefix,
          ContinuationToken: reconciliationCursors.get(profile.id),
          MaxKeys: 100,
        }),
      );
      for (const object of page.Contents ?? []) {
        const key = object.Key?.slice(prefix.length);
        if (
          !key ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(key) ||
          !object.LastModified ||
          object.LastModified.getTime() >= cutoff ||
          (await referenced(key, 'S3', profile.id))
        )
          continue;
        if (Date.now() - started > 30000) break;
        const metadata = await s3.send(
          new HeadObjectCommand({ Bucket: profile.bucket, Key: object.Key }),
        );
        if (metadata.Metadata?.['nxopa-owner'] !== owner) continue;
        await removeBlob({ storageKey: key, storageBackend: 'S3', storageConfigId: profile.id });
      }
      if (page.IsTruncated && page.NextContinuationToken)
        reconciliationCursors.set(profile.id, page.NextContinuationToken);
      else reconciliationCursors.delete(profile.id);
    } catch (error) {
      console.warn(
        'Storage profile reconciliation failed:',
        profile.id,
        error instanceof Error ? error.name : 'error',
      );
    } finally {
      s3.destroy();
    }
  }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const storageSchema = z.object({
  version: z.number().int().min(0),
  mode: z.enum(['LOCAL', 'S3']),
  name: z.string().trim().min(1).max(100).default('S3 对象存储'),
  endpoint: z.string().trim().max(2048).default(''),
  region: z.string().trim().min(1).max(100).default('us-east-1'),
  bucket: z.string().trim().max(63).default(''),
  prefix: z
    .string()
    .regex(/^[A-Za-z0-9/_-]{0,100}$/)
    .default('nxopa'),
  accessKey: z.string().trim().max(300).default(''),
  secretKey: z.string().max(2048).optional(),
  forcePathStyle: z.boolean().default(true),
  createBucket: z.boolean().default(false),
});
function checkEndpoint(endpoint: string) {
  if (!endpoint) return;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BadRequestException('S3 端点格式无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new BadRequestException('S3 端点须为 HTTP(S) 地址，不包含账号、查询或片段');
}
function client(profile: StorageConfiguration) {
  return new S3Client({
    region: profile.region,
    ...(profile.endpoint ? { endpoint: profile.endpoint } : {}),
    forcePathStyle: profile.forcePathStyle,
    credentials: {
      accessKeyId: profile.accessKey,
      secretAccessKey: decrypt(profile.encryptedSecret),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
  });
}
function objectKey(profile: StorageConfiguration, key: string) {
  return [profile.prefix.replace(/^\/+|\/+$/g, ''), key].filter(Boolean).join('/');
}
function safeKey(key: string | null) {
  if (!key || !/^[A-Za-z0-9_-]{1,200}$/.test(key))
    throw new BadRequestException('存储对象标识无效');
  return key;
}
async function profileFor(id: string | null | undefined) {
  if (!id) throw new BadRequestException('对象缺少存储配置');
  return db.storageConfiguration.findUniqueOrThrow({ where: { id } });
}
async function active() {
  const row = await db.setting.findUnique({ where: { key: 'storage' } });
  if (row)
    return {
      mode: String((row.value as any).mode),
      profileId: (row.value as any).profileId as string | undefined,
      version: row.version,
    };
  const mode = process.env.STORAGE_MODE ?? 'LOCAL';
  if (mode === 'LOCAL') return { mode: 'LOCAL', version: 0, profileId: undefined };
  return db.$transaction(async (tx) => {
    await lock(tx, 'system:storage');
    const current = await tx.setting.findUnique({ where: { key: 'storage' } });
    if (current)
      return {
        mode: String((current.value as any).mode),
        profileId: (current.value as any).profileId as string | undefined,
        version: current.version,
      };
    const bucket = process.env.S3_BUCKET || 'nxopa-regsys',
      endpoint = process.env.S3_ENDPOINT || (mode === 'MINIO' ? 'http://minio:9000' : '');
    checkEndpoint(endpoint);
    const accessKey =
      process.env.S3_ACCESS_KEY || (mode === 'MINIO' ? process.env.MINIO_ROOT_USER : '') || '';
    const secret =
      process.env.S3_SECRET_KEY || (mode === 'MINIO' ? process.env.MINIO_ROOT_PASSWORD : '') || '';
    if (!accessKey || !secret) throw new BadRequestException('请配置 S3 访问密钥');
    const profile = await tx.storageConfiguration.create({
      data: {
        name: mode === 'MINIO' ? '内置 MinIO' : '安装时配置的 S3',
        endpoint,
        region: process.env.S3_REGION ?? 'us-east-1',
        bucket,
        prefix: process.env.S3_PREFIX ?? 'nxopa',
        accessKey,
        encryptedSecret: encrypt(secret),
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
        createBucket: mode === 'MINIO',
      },
    });
    const setting = await tx.setting.create({
      data: { key: 'storage', value: { mode: 'S3', profileId: profile.id } },
    });
    return { mode: 'S3', profileId: profile.id, version: setting.version };
  });
}
export async function putBlob(
  key: string,
  bytes: Buffer,
  mime: string,
  profileId?: string,
): Promise<{
  storageKey: string;
  storageBackend: string;
  sha256: string;
  storageConfigId: string | null;
}> {
  safeKey(key);
  const target = profileId ? { mode: 'S3', profileId } : await active();
  const owner = await storageOwner();
  if (target.mode === 'LOCAL') {
    await mkdir(config.storage, { recursive: true, mode: 0o700 });
    await writeFile(path.join(config.storage, `${key}.nxopa-owner`), owner, { mode: 0o600 });
    await writeFile(path.join(config.storage, key), bytes, { mode: 0o600 });
    return { storageKey: key, storageBackend: 'LOCAL', storageConfigId: null, sha256: hash(bytes) };
  }
  const profile = await profileFor(target.profileId),
    s3 = client(profile);
  const upload = () =>
    s3.send(
      new PutObjectCommand({
        Bucket: profile.bucket,
        Key: objectKey(profile, key),
        Body: bytes,
        ContentType: mime,
        Metadata: { 'nxopa-owner': owner },
      }),
    );
  try {
    try {
      await upload();
    } catch (error) {
      if (!profile.createBucket || (error as any).name !== 'NoSuchBucket') throw error;
      try {
        await s3.send(
          new CreateBucketCommand({
            Bucket: profile.bucket,
            ...(profile.region === 'us-east-1'
              ? {}
              : { CreateBucketConfiguration: { LocationConstraint: profile.region as any } }),
          }),
        );
      } catch (creation) {
        if (!['BucketAlreadyExists', 'BucketAlreadyOwnedByYou'].includes((creation as any).name))
          throw creation;
      }
      await upload();
    }
  } finally {
    s3.destroy();
  }
  return {
    storageKey: key,
    storageBackend: 'S3',
    storageConfigId: profile.id,
    sha256: hash(bytes),
  };
}
export async function readBlob(ref: StorageRef, maxBytes = 50 * 1024 * 1024) {
  const key = safeKey(ref.storageKey);
  let bytes: Buffer;
  if (!ref.storageBackend || ref.storageBackend === 'LOCAL') {
    const file = await open(path.join(config.storage, key), 'r');
    try {
      if ((await file.stat()).size > maxBytes)
        throw new BadRequestException('存储文件超出大小限制');
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
  } else {
    const profile = await profileFor(ref.storageConfigId),
      s3 = client(profile);
    try {
      const value = await s3.send(
        new GetObjectCommand({ Bucket: profile.bucket, Key: objectKey(profile, key) }),
      );
      if ((value.ContentLength ?? 0) > maxBytes)
        throw new BadRequestException('存储文件超出大小限制');
      bytes = Buffer.from(await value.Body!.transformToByteArray());
    } finally {
      s3.destroy();
    }
  }
  if (bytes.length > maxBytes) throw new BadRequestException('存储文件超出大小限制');
  if (ref.sha256 && hash(bytes) !== ref.sha256) throw new BadRequestException('文件摘要校验失败');
  return bytes;
}
export async function removeBlob(ref: StorageRef) {
  const key = safeKey(ref.storageKey);
  if (!ref.storageBackend || ref.storageBackend === 'LOCAL') {
    await rm(path.join(config.storage, key), { force: true });
    await rm(path.join(config.storage, `${key}.nxopa-owner`), { force: true });
  } else {
    const profile = await profileFor(ref.storageConfigId),
      s3 = client(profile);
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: profile.bucket, Key: objectKey(profile, key) }),
      );
    } finally {
      s3.destroy();
    }
  }
}
export class StorageService {
  async view(u: Principal) {
    requireSystemAdmin(u);
    let value: Awaited<ReturnType<typeof active>>;
    let configurationError = '';
    try {
      value = await active();
    } catch {
      value = { mode: 'S3', version: 0, profileId: undefined };
      configurationError = '环境中的存储配置不完整，请在此页面填写并保存配置';
    }
    const profile = value.profileId ? await profileFor(value.profileId) : undefined;
    const { encryptedSecret, ...fields } = profile ?? { encryptedSecret: '' };
    const counts = await Promise.all([
      db.attachment.count({ where: { deletedAt: null, storageBackend: 'LOCAL' } }),
      db.admissionDocument.count({ where: { storageKey: { not: null }, storageBackend: 'LOCAL' } }),
    ]);
    return {
      ...fields,
      configurationError,
      ...value,
      secretConfigured: !!encryptedSecret,
      localAttachments: counts[0],
      localAdmissions: counts[1],
    };
  }
  async save(u: Principal, body: unknown) {
    requireSystemAdmin(u);
    const b = storageSchema.parse(body);
    checkEndpoint(b.endpoint);
    if (b.mode === 'S3' && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b.bucket) || !b.accessKey))
      throw new BadRequestException('请填写有效桶名和访问密钥 ID');
    await db.$transaction(async (tx) => {
      await lock(tx, 'system:storage');
      const previous = await tx.setting.findUnique({ where: { key: 'storage' } });
      checkVersion(previous?.version ?? 0, b.version);
      let profileId: string | undefined;
      if (b.mode === 'S3') {
        const oldId = (previous?.value as any)?.profileId;
        const old = oldId
          ? await tx.storageConfiguration.findUnique({ where: { id: oldId } })
          : null;
        const encryptedSecret = b.secretKey
          ? encrypt(b.secretKey)
          : old && old.endpoint === b.endpoint && old.accessKey === b.accessKey
            ? old.encryptedSecret
            : '';
        if (!encryptedSecret)
          throw new BadRequestException('请填写 S3 密钥；更换端点或密钥 ID 时需要重新输入密钥');
        const profile = await tx.storageConfiguration.create({
          data: {
            name: b.name,
            endpoint: b.endpoint,
            region: b.region,
            bucket: b.bucket,
            prefix: b.prefix,
            accessKey: b.accessKey,
            encryptedSecret,
            forcePathStyle: b.forcePathStyle,
            createBucket: b.createBucket,
          },
        });
        profileId = profile.id;
      }
      await tx.setting.upsert({
        where: { key: 'storage' },
        create: { key: 'storage', value: json({ mode: b.mode, profileId }) },
        update: { value: json({ mode: b.mode, profileId }), version: { increment: 1 } },
      });
      await audit(tx, u.id, 'STORAGE_CONFIGURE', 'storage', {
        mode: b.mode,
        endpoint: b.endpoint,
        bucket: b.bucket,
      });
    });
    return this.view(u);
  }
  async probe(u: Principal) {
    requireSystemAdmin(u);
    try {
      const ref = await putBlob(
        `probe-${randomUUID()}`,
        Buffer.from('NXOPA storage connection test'),
        'text/plain',
      );
      try {
        if ((await readBlob(ref)).toString() !== 'NXOPA storage connection test')
          throw new Error('内容校验失败');
      } finally {
        await removeBlob(ref);
      }
      await audit(db, u.id, 'STORAGE_PROBE', 'storage', { ok: true });
      return { ok: true, message: '写入、读取和删除均通过' };
    } catch (error) {
      await audit(db, u.id, 'STORAGE_PROBE', 'storage', { ok: false });
      const name = error instanceof Error ? error.name : 'StorageError';
      throw new BadRequestException(`存储测试失败（${name}），请检查端点、桶名与对象读写删除权限`);
    }
  }
  async migrate(u: Principal) {
    requireSystemAdmin(u);
    const target = await active();
    if (target.mode !== 'S3' || !target.profileId)
      throw new BadRequestException('请先配置并测试 S3 存储');
    await audit(db, u.id, 'STORAGE_MIGRATE', 'storage', { profileId: target.profileId });
    return db.$transaction((tx) =>
      enqueue(tx, 'STORAGE_MIGRATION', target.profileId!, `storage-migration:${randomUUID()}`, {
        profileId: target.profileId,
      }),
    );
  }
}
export async function migrateObjects(profileId: string, jobId: string) {
  let copied = 0;
  for (const kind of ['attachment', 'admissionDocument'] as const) {
    const filter = { OR: [{ storageBackend: 'LOCAL' }, { storageConfigId: { not: profileId } }] };
    const rows =
      kind === 'attachment'
        ? await db.attachment.findMany({ where: { deletedAt: null, ...filter } })
        : await db.admissionDocument.findMany({ where: { storageKey: { not: null }, ...filter } });
    for (const row of rows) {
      const bytes = await readBlob(row),
        ref = await putBlob(
          `migrated-${randomUUID()}`,
          bytes,
          'mime' in row ? row.mime : 'application/pdf',
          profileId,
        );
      const unchanged = {
        id: row.id,
        storageKey: row.storageKey,
        storageBackend: row.storageBackend,
        storageConfigId: row.storageConfigId,
      };
      const updated =
        kind === 'attachment'
          ? await db.attachment.updateMany({
              where: { ...unchanged, storageKey: row.storageKey!, deletedAt: null },
              data: ref,
            })
          : await db.admissionDocument.updateMany({ where: unchanged, data: ref });
      if (!updated.count) {
        await removeBlob(ref);
        continue;
      }
      await db.job.update({ where: { id: jobId }, data: { result: { copied: ++copied } } });
    }
  }
  const previews = await db.job.findMany({ where: { kind: 'PDF_PREVIEW', state: 'SUCCESS' } });
  for (const preview of previews) {
    const old = preview.result as unknown as StorageRef | null;
    if (!old?.storageKey || (old.storageBackend === 'S3' && old.storageConfigId === profileId))
      continue;
    const bytes = await readBlob(old),
      ref = await putBlob(`migrated-${randomUUID()}`, bytes, 'application/pdf', profileId);
    const updated = await db.job.updateMany({
      where: { id: preview.id, state: 'SUCCESS', result: { equals: json(old) } },
      data: { result: json(ref) },
    });
    if (!updated.count) {
      await removeBlob(ref);
      continue;
    }
    await db.job.update({ where: { id: jobId }, data: { result: { copied: ++copied } } });
  }
  return { copied };
}
