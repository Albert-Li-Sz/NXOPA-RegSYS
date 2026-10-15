import { BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import {
  roomSchema as roomInput,
  seatingRequestSchema as planInput,
  seatingClearSchema,
  type Principal,
} from '@contest-center/contracts';
import { db, audit, json, lock, type Tx } from './db.js';
import { requireManager, checkVersion } from './security.js';
import { modulesFor } from './workflow.js';
async function contest(tx: Tx, u: Principal, id: string) {
  requireManager(u, id, 'ADMISSIONS');
  const c = await tx.contest.findUniqueOrThrow({ where: { id } });
  if (!modulesFor(c).rooms) throw new BadRequestException('此活动未启用考场与座位');
  return c;
}
async function stale(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  await tx.admissionDocument.updateMany({
    where: { registrationId: { in: ids } },
    data: { state: 'STALE', releasedAt: null, version: { increment: 1 } },
  });
}
export class SeatingService {
  async view(u: Principal, id: string) {
    const c = await contest(db, u, id);
    const [rooms, seats] = await Promise.all([
      db.examRoom.findMany({
        where: { contestId: id },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }),
      db.seatAssignment.findMany({
        where: { registration: { contestId: id } },
        include: {
          room: true,
          registration: {
            select: {
              eligible: true,
              number: true,
              teamName: true,
              people: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [{ roomId: 'asc' }, { seat: 'asc' }],
      }),
    ]);
    return { rooms, seats, seatingVersion: c.seatingVersion, seatingMode: c.seatingMode };
  }
  async save(u: Principal, id: string, roomId: string | undefined, body: unknown) {
    const b = roomInput.parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, `seating:${id}`);
      await contest(tx, u, id);
      if (roomId) {
        const old = await tx.examRoom.findUniqueOrThrow({ where: { id: roomId } });
        if (old.contestId !== id) throw new BadRequestException('考场不属于此活动');
        checkVersion(old.version, b.version);
        const seats = await tx.seatAssignment.findMany({ where: { roomId } });
        if (seats.some((a) => a.seat > b.capacity) || (!b.enabled && seats.length))
          throw new BadRequestException('请先调整已有座位，再缩小容量或停用考场');
        await stale(
          tx,
          seats.map((a) => a.registrationId),
        );
      }
      const { version, ...data } = b;
      const r = roomId
        ? await tx.examRoom.update({
            where: { id: roomId },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.examRoom.create({ data: { ...data, contestId: id } });
      await tx.contest.update({ where: { id }, data: { seatingVersion: { increment: 1 } } });
      await audit(tx, u.id, 'ROOM_SAVE', id, { roomId: r.id });
      return r;
    });
  }
  async remove(u: Principal, id: string, roomId: string, body: unknown) {
    const { version } = z.object({ version: z.number().int() }).parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, `seating:${id}`);
      await contest(tx, u, id);
      const r = await tx.examRoom.findUniqueOrThrow({ where: { id: roomId } });
      if (r.contestId !== id) throw new BadRequestException('考场不属于此活动');
      checkVersion(r.version, version);
      if (await tx.seatAssignment.count({ where: { roomId } }))
        throw new BadRequestException('请先清空该考场的座位');
      await tx.examRoom.delete({ where: { id: roomId } });
      await tx.contest.update({ where: { id }, data: { seatingVersion: { increment: 1 } } });
      await audit(tx, u.id, 'ROOM_DELETE', id, { roomId });
      return { ok: true };
    });
  }
  async clear(u: Principal, id: string, body: unknown) {
    const b = seatingClearSchema.parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, `seating:${id}`);
      const c = await contest(tx, u, id);
      checkVersion(c.seatingVersion, b.seatingVersion);
      const where = { registration: { contestId: id }, ...(b.roomId ? { roomId: b.roomId } : {}) };
      const seats = await tx.seatAssignment.findMany({ where });
      await stale(
        tx,
        seats.map((a) => a.registrationId),
      );
      await tx.seatAssignment.deleteMany({ where });
      await tx.contest.update({ where: { id }, data: { seatingVersion: { increment: 1 } } });
      await audit(tx, u.id, 'SEATING_CLEAR', id, { count: seats.length });
      return { ok: true };
    });
  }
  async plan(u: Principal, id: string, body: unknown, commit = false) {
    const b = planInput.parse(body),
      ids = [...new Set(b.registrationIds)].sort();
    return db.$transaction(
      async (tx) => {
        if (commit) {
          for (const rid of ids) await lock(tx, rid);
          await lock(tx, `seating:${id}`);
        }
        const c = await contest(tx, u, id);
        if (commit && (b.seatingVersion === undefined || !b.registrationVersions))
          throw new BadRequestException('请先预览排考结果');
        if (commit) checkVersion(c.seatingVersion, b.seatingVersion);
        const registrations = await tx.registration.findMany({
          where: { id: { in: ids }, contestId: id },
          include: {
            people: { where: { active: true }, orderBy: [{ captain: 'desc' }, { id: 'asc' }] },
          },
          orderBy: [{ number: 'asc' }, { id: 'asc' }],
        });
        if (registrations.length !== ids.length)
          throw new BadRequestException('报名不存在或不属于此活动');
        if (registrations.some((r) => !r.eligible))
          throw new BadRequestException('仅可为已取得参加资格的报名排考');
        if (commit && registrations.some((r) => b.registrationVersions![r.id] !== r.version))
          throw new ConflictException('报名资料已更新，请重新预览');
        const rooms = await tx.examRoom.findMany({
          where: { contestId: id },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        });
        const old = await tx.seatAssignment.findMany({
          where: { registration: { contestId: id } },
        });
        const occupied = new Set(
          old
            .filter((a) => !(b.replace && ids.includes(a.registrationId)))
            .map((a) => `${a.roomId}:${a.seat}`),
        );
        const requestedUnits = registrations.reduce(
          (sum, r) => sum + (c.seatingMode === 'PERSON' ? r.people.length : 1),
          0,
        );
        if (requestedUnits > 30000)
          throw new BadRequestException('每次最多安排 30000 个座位，请分批处理');
        const freeSeats = new Map(
          rooms.map((room) => [
            room.id,
            {
              seats: Array.from({ length: room.capacity }, (_, i) => i + 1).filter(
                (seat) => !occupied.has(`${room.id}:${seat}`),
              ),
              cursor: 0,
            },
          ]),
        );
        const planned: {
          registrationId: string;
          personId: string | null;
          unitKey: string;
          roomId: string;
          seat: number;
        }[] = [];
        const errors: string[] = [];
        if (b.assignments?.some((a) => !ids.includes(a.registrationId)))
          throw new BadRequestException('座位表包含未选择的报名');
        for (const r of registrations) {
          const units =
            c.seatingMode === 'PERSON'
              ? r.people.map((p) => ({ key: p.id, personId: p.id }))
              : [{ key: 'REGISTRATION', personId: null }];
          const existing = b.replace ? [] : old.filter((a) => a.registrationId === r.id);
          if (existing.some((a) => !units.some((unit) => unit.key === a.unitKey))) {
            errors.push(`报名 #${r.number} 的成员已变化，请选择重新分配`);
            continue;
          }
          const missing = units.filter((unit) => !existing.some((a) => a.unitKey === unit.key));
          if (b.assignments) {
            const assigned = b.assignments.filter((a) => a.registrationId === r.id);
            if (assigned.length !== missing.length) {
              errors.push(`报名 #${r.number} 的座位数量不符合排考单位`);
              continue;
            }
            for (const unit of missing) {
              const matches = assigned.filter((a) => (a.personId ?? null) === unit.personId);
              const a = matches[0],
                room = rooms.find((room) => room.id === a?.roomId && room.enabled);
              if (
                matches.length !== 1 ||
                !a ||
                !room ||
                a.seat > room.capacity ||
                occupied.has(`${a.roomId}:${a.seat}`)
              ) {
                errors.push(`报名 #${r.number} 存在考场、成员、座号或占座冲突`);
                continue;
              }
              occupied.add(`${a.roomId}:${a.seat}`);
              planned.push({ ...a, personId: unit.personId, unitKey: unit.key });
            }
          } else if (missing.length) {
            const room = rooms.find(
              (room) =>
                room.enabled &&
                (!existing.length || existing.every((a) => a.roomId === room.id)) &&
                freeSeats.get(room.id)!.seats.length - freeSeats.get(room.id)!.cursor >=
                  missing.length,
            );
            if (!room) {
              errors.push(`报名 #${r.number} 没有足够的同场座位`);
              continue;
            }
            const free = freeSeats.get(room.id)!,
              available = free.seats.slice(free.cursor, free.cursor + missing.length);
            free.cursor += missing.length;
            missing.forEach((unit, index) => {
              const seat = available[index]!;
              occupied.add(`${room.id}:${seat}`);
              planned.push({
                registrationId: r.id,
                personId: unit.personId,
                unitKey: unit.key,
                roomId: room.id,
                seat,
              });
            });
          }
          const assignedRooms = new Set(
            [...existing, ...planned.filter((a) => a.registrationId === r.id)].map((a) => a.roomId),
          );
          if (c.seatingMode === 'PERSON' && assignedRooms.size > 1)
            errors.push(`报名 #${r.number} 的团队成员须安排在同一考场`);
        }
        if (commit && errors.length) throw new BadRequestException(errors.join('；'));
        if (commit) {
          if (b.replace)
            await tx.seatAssignment.deleteMany({ where: { registrationId: { in: ids } } });
          if (planned.length) await tx.seatAssignment.createMany({ data: planned });
          await stale(tx, b.replace ? ids : [...new Set(planned.map((a) => a.registrationId))]);
          await tx.contest.update({ where: { id }, data: { seatingVersion: { increment: 1 } } });
          await audit(tx, u.id, 'SEATING_COMMIT', id, { count: planned.length });
        }
        return {
          seatingVersion: c.seatingVersion,
          registrationVersions: Object.fromEntries(registrations.map((r) => [r.id, r.version])),
          errors,
          total: ids.length,
          assignments: planned.map((a) => ({
            ...a,
            roomName: rooms.find((room) => room.id === a.roomId)!.name,
            name: registrations
              .find((r) => r.id === a.registrationId)!
              .people.find((p) => !a.personId || p.id === a.personId)?.name,
            number: registrations.find((r) => r.id === a.registrationId)!.number,
          })),
        };
      },
      { timeout: 120000 },
    );
  }
}
