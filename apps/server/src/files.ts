import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Principal } from '@contest-center/contracts';
import { db } from './db.js';
import { config } from './config.js';
import { getRegistration, canRead } from './security.js';
export class FileService {
  async upload(
    u: Principal,
    file: Express.Multer.File,
    registrationId?: string,
    ticketId?: string,
  ) {
    if (!file?.buffer?.length || file.size > 10 * 1024 * 1024)
      throw new BadRequestException('文件需小于 10 MB');
    if (registrationId) await getRegistration(u, registrationId);
    if (ticketId) {
      const t = await db.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
      if (t.registrationId) await getRegistration(u, t.registrationId);
      else if (t.ownerId !== u.id && !u.isAdmin && !u.contestIds.includes(t.contestId ?? ''))
        throw new ForbiddenException();
    }
    let mime = '';
    const b = file.buffer;
    if (b.subarray(0, 5).toString() === '%PDF-') mime = 'application/pdf';
    else if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      mime = 'image/png';
    else if (b[0] === 255 && b[1] === 216 && b[2] === 255) mime = 'image/jpeg';
    else if (file.mimetype === 'text/plain' && !b.includes(0)) mime = 'text/plain';
    if (!mime) throw new BadRequestException('支持 PDF、PNG、JPEG 和文本文件');
    const id = randomUUID();
    await mkdir(config.storage, { recursive: true, mode: 0o700 });
    await writeFile(path.join(config.storage, id), b, { mode: 0o600 });
    return db.attachment.create({
      data: {
        id,
        storageKey: id,
        ownerId: u.id,
        registrationId,
        ticketId,
        name: path
          .basename(file.originalname.replaceAll('\\', '/'))
          .replace(/[\r\n\u0000]/g, '')
          .slice(0, 200),
        mime,
        size: file.size,
      },
      select: { id: true, name: true, mime: true, size: true },
    });
  }
  async read(u: Principal, id: string) {
    const f = await db.attachment.findUnique({ where: { id } });
    if (!f) throw new NotFoundException();
    if (f.registrationId) await getRegistration(u, f.registrationId);
    else if (f.ticketId) {
      const t = await db.supportTicket.findUniqueOrThrow({ where: { id: f.ticketId } });
      if (t.ownerId !== u.id && !u.isAdmin && !u.contestIds.includes(t.contestId ?? '')) {
        if (!t.registrationId) throw new ForbiddenException();
        await getRegistration(u, t.registrationId);
      }
    } else if (f.ownerId !== u.id && !u.isAdmin) throw new ForbiddenException();
    return { ...f, buffer: await readFile(path.join(config.storage, f.storageKey)) };
  }
}
export async function bindFile(
  tx: import('./db.js').Tx,
  u: Principal,
  id: string,
  registrationId: string,
) {
  const f = await tx.attachment.findUnique({ where: { id } });
  if (
    !f ||
    (f.registrationId && f.registrationId !== registrationId) ||
    (!f.registrationId && f.ownerId !== u.id)
  )
    throw new ForbiddenException('附件不属于此报名');
  await tx.attachment.update({ where: { id }, data: { registrationId } });
  return f;
}
