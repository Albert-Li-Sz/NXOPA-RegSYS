import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  PayloadTooLargeException,
} from '@nestjs/common';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '@contest-center/contracts';
import { dirty, loaded } from './registrations.js';
import { db, audit, enqueue, lock, event } from './db.js';
import {
  getRegistration,
  getSupportTicket,
  owns,
  ownerIds,
  manages,
  requireManager,
} from './security.js';
import { putBlob, readBlob, removeBlob, type StorageRef } from './storage.js';
import { getFinance } from './finance-accounts.js';
import { publicLink } from './site-settings.js';
import { paginated, pageOptions, type ListQuery } from './pagination.js';
const purposeSchema = z.enum([
  'PRIVATE',
  'PERSONAL',
  'TEAM',
  'CONTEST_PUBLIC',
  'CONTEST_PRIVATE',
  'AVATAR',
]);
function uploadFilename(name: string) {
  // Ordinary multipart filename parameters arrive as Latin-1, even when browsers send UTF-8.
  if ([...name].every((character) => character.charCodeAt(0) <= 255)) {
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
    } catch {}
  }
  return path
    .basename(name.replaceAll('\\', '/'))
    .replace(/[\r\n\u0000]/g, '')
    .slice(0, 200);
}
async function fileRegistrations(tx: import('./db.js').Tx, id: string) {
  z.string().uuid().parse(id);
  return tx.$queryRaw<
    { id: string; used: boolean }[]
  >`SELECT "registrationId" AS id,false AS used FROM "Attachment" WHERE id=${id}::uuid AND "registrationId" IS NOT NULL
    UNION SELECT id,true FROM "Registration" WHERE answers::text ILIKE ${`%${id}%`}
    UNION SELECT "registrationId",true FROM "RegistrationPerson" WHERE answers::text ILIKE ${`%${id}%`}
    UNION SELECT "registrationId",true FROM "RegistrationCoach" WHERE answers::text ILIKE ${`%${id}%`}`;
}
export class FileService {
  async upload(
    u: Principal,
    file: Express.Multer.File,
    registrationId?: string,
    ticketId?: string,
    options: { contestId?: string; purpose?: string } = {},
  ) {
    const purpose = purposeSchema.parse(options.purpose ?? 'PRIVATE');
    const limit = purpose === 'AVATAR' ? 5 : purpose === 'PRIVATE' ? 10 : 50;
    if (!file?.buffer?.length || file.size > limit * 1024 * 1024)
      throw new BadRequestException(`文件需小于 ${limit} MB`);
    let stored: StorageRef | undefined;
    try {
      return await db.$transaction(async (tx) => {
        // Serialize with removal before checking ownership or writing the object.
        if (registrationId) await lock(tx, registrationId);
        if (ticketId) await lock(tx, ticketId);
        let contestId = options.contestId;
        if (registrationId) {
          const registration = await getRegistration(u, registrationId);
          if (contestId && contestId !== registration.contestId)
            throw new BadRequestException('文件的竞赛与队伍不一致');
          contestId = registration.contestId;
          if (
            !owns(u, registration.ownerId) &&
            !registration.people.some((p) => p.active && p.userId && owns(u, p.userId)) &&
            !registration.coaches.some((c) => owns(u, c.userId))
          )
            requireManager(u, contestId, 'FILES');
        }
        if (purpose.startsWith('CONTEST_')) {
          if (!contestId || registrationId || ticketId)
            throw new BadRequestException('竞赛材料需指定竞赛');
          requireManager(u, contestId, 'FILES');
        } else if (purpose === 'TEAM' && !registrationId)
          throw new BadRequestException('队伍附件需指定报名');
        else if (
          ['PERSONAL', 'AVATAR'].includes(purpose) &&
          (registrationId || ticketId || contestId)
        )
          throw new BadRequestException('个人文件不能绑定其他对象');
        if (purpose === 'PRIVATE' && contestId && !registrationId && !ticketId)
          requireManager(u, contestId, 'FILES');
        if (ticketId) {
          const ticket = await getSupportTicket(u, ticketId);
          if (
            (contestId && contestId !== ticket.contestId) ||
            (registrationId && registrationId !== ticket.registrationId)
          )
            throw new BadRequestException('工单与文件的竞赛或报名不一致');
          contestId = ticket.contestId ?? undefined;
        }
        let mime = '';
        const bytes = file.buffer;
        if (bytes.subarray(0, 5).toString() === '%PDF-') mime = 'application/pdf';
        else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
          mime = 'image/png';
        else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
        else if (file.mimetype === 'text/plain' && !bytes.includes(0)) mime = 'text/plain';
        else if (
          purpose !== 'PRIVATE' &&
          bytes[0] === 80 &&
          bytes[1] === 75 &&
          [3, 5, 7].includes(bytes[2]!)
        )
          mime = 'application/zip';
        if (!mime || (purpose === 'AVATAR' && !mime.startsWith('image/')))
          throw new BadRequestException(
            purpose === 'AVATAR'
              ? '头像支持 PNG、JPEG 图片'
              : '支持 PDF、PNG、JPEG、文本及附件 ZIP 文件',
          );
        if (contestId) {
          await lock(tx, contestId);
          await tx.contest.findUniqueOrThrow({ where: { id: contestId } });
        }
        await lock(tx, `upload-owner:${u.id}`);
        const used = await tx.attachment.aggregate({
          where: { ownerId: u.id, purgedAt: null },
          _sum: { size: true },
        });
        const quota = Number(process.env.UPLOAD_QUOTA_MB ?? (u.isAdmin ? 10240 : 1024));
        if (
          !Number.isFinite(quota) ||
          quota <= 0 ||
          (used._sum.size ?? 0) + file.size > quota * 1024 * 1024
        )
          throw new PayloadTooLargeException(
            '附件总量已达到账号配额，请清理不再使用的文件或联系管理员',
          );
        const id = randomUUID(),
          ref = await putBlob(id, bytes, mime);
        stored = ref;
        const result = await tx.attachment.create({
          data: {
            id,
            ...ref,
            ownerId: u.id,
            registrationId,
            ticketId,
            contestId,
            purpose,
            public: ['CONTEST_PUBLIC', 'AVATAR'].includes(purpose),
            name: uploadFilename(file.originalname),
            mime,
            size: file.size,
          },
        });
        if (purpose === 'TEAM')
          await tx.teamFile.create({
            data: { attachmentId: id, registrationId: registrationId!, assignedBy: u.id },
          });
        await audit(tx, u.id, 'FILE_UPLOAD', id, {
          purpose,
          contestId,
          registrationId,
          size: file.size,
        });
        return {
          id,
          name: result.name,
          mime,
          size: file.size,
          public: result.public,
          url: await publicLink(`/api/v1/files/${result.public ? 'public/' : ''}${id}`),
        };
      });
    } catch (error) {
      if (stored) {
        try {
          await removeBlob(stored);
        } catch {
          await db.$transaction((tx) =>
            enqueue(
              tx,
              'OBJECT_DELETE',
              stored!.storageKey!,
              `orphan-upload:${stored!.storageKey}`,
              { storageRef: stored },
            ),
          );
        }
      }
      throw error;
    }
  }
  async read(u: Principal | null, id: string) {
    const file = await db.attachment.findUnique({ where: { id } });
    if (!file || file.deletedAt) throw new NotFoundException('文件不存在或已删除');
    let publicRead = file.public;
    if (file.purpose === 'AVATAR')
      publicRead =
        publicRead &&
        !!(await db.user.findFirst({
          where: { id: file.ownerId, deactivatedAt: null, avatarAttachmentId: file.id },
        }));
    else if (publicRead && file.contestId)
      publicRead = !!(await db.contest.findFirst({
        where: { id: file.contestId, published: true, archived: false },
      }));
    if (!publicRead) {
      if (!u) throw new ForbiddenException('请先登录');
      if (file.ticketId) await getSupportTicket(u, file.ticketId);
      else if (file.registrationId) {
        const financial =
          (await db.paymentVoucher.count({ where: { attachmentId: id } })) +
          (await db.invoiceRequest.count({ where: { attachmentId: id } })) +
          (await db.refund.count({ where: { attachmentId: id } }));
        if (financial) await getFinance(u, file.registrationId);
        else {
          try {
            await getRegistration(u, file.registrationId);
          } catch (error) {
            const assigned = await db.teamFile.findMany({
              where: { attachmentId: id },
              select: { registrationId: true },
            });
            let allowed = owns(u, file.ownerId);
            for (const a of assigned) {
              try {
                await getRegistration(u, a.registrationId);
                allowed = true;
                break;
              } catch {}
            }
            if (!allowed) throw error;
          }
        }
      } else if (file.contestId && !manages(u, file.contestId, 'FILES') && !owns(u, file.ownerId)) {
        const assignments = await db.teamFile.findMany({ where: { attachmentId: id } });
        let allowed = false;
        for (const assignment of assignments) {
          try {
            await getRegistration(u, assignment.registrationId);
            allowed = true;
            break;
          } catch {}
        }
        if (!allowed) throw new ForbiddenException();
      } else if (!file.contestId && !owns(u, file.ownerId) && !u.isAdmin) {
        const assignments = await db.teamFile.findMany({ where: { attachmentId: file.id } });
        let allowed = false;
        for (const assignment of assignments) {
          try {
            await getRegistration(u, assignment.registrationId);
            allowed = true;
            break;
          } catch {}
        }
        if (!allowed) throw new ForbiddenException();
      }
    }
    return {
      ...file,
      buffer: await readBlob(file),
      inline: publicRead && file.mime.startsWith('image/'),
    };
  }
  async list(u: Principal, query: ListQuery = {}) {
    const search = query.search
      ? { name: { contains: query.search, mode: 'insensitive' as const } }
      : {};
    if (query.registrationId) {
      await getRegistration(u, query.registrationId);
      const where = {
        registrationId: query.registrationId,
        attachment: { deletedAt: null, ...search },
      };
      const find = async (options: { skip?: number; take?: number } = {}) =>
        (
          await db.teamFile.findMany({
            where,
            ...options,
            include: { attachment: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          })
        ).map((x) => ({ ...x.attachment, assignmentId: x.id, assignedAt: x.createdAt }));
      return pageOptions(query)
        ? paginated(query, find, () => db.teamFile.count({ where }))
        : find();
    }
    if (query.contestId) {
      requireManager(u, query.contestId, 'FILES');
      const where = {
        contestId: query.contestId,
        ...search,
        deletedAt: null,
        purpose: { in: ['CONTEST_PUBLIC', 'CONTEST_PRIVATE'] },
      };
      const find = (options: { skip?: number; take?: number } = {}) =>
        db.attachment.findMany({
          where,
          ...options,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
      return pageOptions(query)
        ? paginated(query, find, () => db.attachment.count({ where }))
        : find();
    }
    const ids = ownerIds(u);
    const teams = await db.registration.findMany({
      where: {
        OR: [
          { ownerId: { in: ids } },
          { people: { some: { userId: { in: ids }, active: true } } },
          { coaches: { some: { userId: { in: ids } } } },
        ],
      },
      select: { id: true },
    });
    const assigned = await db.teamFile.findMany({
      where: { registrationId: { in: teams.map((x) => x.id) }, attachment: { deletedAt: null } },
      select: { attachmentId: true },
    });
    const where = {
      ...search,
      deletedAt: null,
      OR: [{ ownerId: { in: ids } }, { id: { in: assigned.map((x) => x.attachmentId) } }],
    };
    return paginated(
      query,
      (options) =>
        db.attachment.findMany({
          where,
          ...options,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      () => db.attachment.count({ where }),
    );
  }
  async distribute(u: Principal, contestId: string, body: unknown) {
    requireManager(u, contestId, 'FILES');
    const b = z
      .object({
        attachmentId: z.string().uuid(),
        registrationIds: z.array(z.string().uuid()).min(1).max(500),
      })
      .parse(body);
    const ids = [...new Set(b.registrationIds)].sort();
    return db.$transaction(
      async (tx) => {
        // Match removal's lock order and recheck both sides after waiting.
        for (const id of ids) await lock(tx, id);
        await lock(tx, `file:${b.attachmentId}`);
        const file = await tx.attachment.findFirst({
          where: { id: b.attachmentId, contestId, purpose: 'CONTEST_PRIVATE', deletedAt: null },
        });
        if (!file) throw new BadRequestException('请选择当前活动的私有材料');
        const registrations = await tx.registration.findMany({
          where: { id: { in: ids }, contestId },
          select: { id: true },
        });
        if (registrations.length !== ids.length)
          throw new BadRequestException('报名已删除或不属于此活动，请刷新后重新选择');
        await tx.teamFile.createMany({
          data: registrations.map((r) => ({
            attachmentId: file.id,
            registrationId: r.id,
            assignedBy: u.id,
          })),
          skipDuplicates: true,
        });
        await audit(tx, u.id, 'FILE_DISTRIBUTE', file.id, { registrationIds: ids });
        return { count: registrations.length };
      },
      { timeout: 120000 },
    );
  }
  async remove(u: Principal, id: string) {
    const initial = await fileRegistrations(db, id),
      ids = [...new Set(initial.map((r) => r.id))].sort();
    return db.$transaction(async (tx) => {
      for (const rid of ids) await lock(tx, rid);
      await lock(tx, `file:${id}`);
      const refs = await fileRegistrations(tx, id);
      if (refs.some((r) => !ids.includes(r.id)))
        throw new ConflictException('附件引用已变化，请刷新后重试');
      const file = await tx.attachment.findUniqueOrThrow({ where: { id } });
      if (!owns(u, file.ownerId) && !u.isAdmin) {
        if (!file.contestId) throw new ForbiddenException('仅可删除本人上传的文件');
        requireManager(u, file.contestId, 'FILES');
      }
      if (file.deletedAt) return { ok: true };
      const linked = [
        await tx.paymentVoucher.count({ where: { attachmentId: id } }),
        await tx.invoiceRequest.count({ where: { attachmentId: id } }),
        await tx.refund.count({ where: { attachmentId: id } }),
      ];
      if (linked.some(Boolean)) throw new BadRequestException('文件已用于财务记录，需保留凭证');
      await tx.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.user.updateMany({
        where: { avatarAttachmentId: id },
        data: { avatarAttachmentId: null },
      });
      await enqueue(tx, 'OBJECT_DELETE', id, `file-delete:${id}`, {
        storageRef: file as unknown as StorageRef,
      });
      for (const rid of new Set(refs.filter((r) => r.used).map((r) => r.id))) {
        if (await tx.registration.count({ where: { id: rid } })) {
          await dirty(tx, await loaded(tx, rid), u, 'REGISTRATION_ATTACHMENT_DELETE');
          await event(tx, 'NOTIFY', rid, { message: '报名附件已删除，请补充资料后重新提交。' });
        }
      }
      await audit(tx, u.id, 'FILE_DELETE', id);
      return { ok: true };
    });
  }
}
export async function bindFile(
  tx: import('./db.js').Tx,
  u: Principal,
  id: string,
  registrationId: string,
) {
  await lock(tx, `file:${id}`);
  const file = await tx.attachment.findUnique({ where: { id } });
  const context =
    (await tx.registration.findUnique({
      where: { id: registrationId },
      select: { contestId: true },
    })) ??
    (await tx.financeAccount.findUnique({
      where: { id: registrationId },
      select: { contestId: true },
    }));
  if (
    !context ||
    !file ||
    file.deletedAt ||
    file.public ||
    file.ticketId ||
    (file.contestId && file.contestId !== context.contestId) ||
    (file.registrationId && file.registrationId !== registrationId) ||
    (!file.registrationId && !owns(u, file.ownerId))
  )
    throw new ForbiddenException('附件不属于此报名或不能用于私有资料');
  await tx.attachment.update({ where: { id }, data: { registrationId } });
  return file;
}
