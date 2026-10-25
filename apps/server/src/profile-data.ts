import { defaultFields, normalizeProfileYears } from '@contest-center/contracts';
import { db, json, lock, event, type Tx } from './db.js';
import type { Prisma } from '@prisma/client';

type Data = Record<string, any>;
export function contactAnswers(answers: Data, email: string) {
  return { ...normalizeProfileYears(answers, true), email };
}
function snapshotProfile(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = { ...value } as Data;
  if (data.profile && typeof data.profile === 'object')
    data.profile = normalizeProfileYears(data.profile);
  return data;
}
export function normalizeRegistrationSnapshot(
  value: unknown,
  emails = new Map<string, string>(),
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = { ...value } as Data;
  if (data.answers) data.answers = normalizeRegistrationAnswers(data.answers);
  for (const key of ['people', 'coaches']) {
    if (!Array.isArray(data[key])) continue;
    data[key] = data[key].map((person: Data) => {
      const email = emails.get(person.userId);
      return {
        ...person,
        ...(key === 'people' && email !== undefined ? { email } : {}),
        answers: {
          ...normalizeProfileYears(person.answers ?? {}),
          ...(email !== undefined ? { email } : {}),
        },
        ...(person.user && email !== undefined ? { user: { ...person.user, email } } : {}),
      };
    });
  }
  return data;
}
export function normalizeRegistrationAnswers(value: Data, strict = false): Data {
  const result = { ...value };
  for (const scope of ['team', 'registration'])
    if (result[scope] && typeof result[scope] === 'object')
      result[scope] = normalizeProfileYears(result[scope], strict);
  return result;
}
async function invalidateContactDocuments(tx: Tx, id: string) {
  await tx.registration.update({ where: { id }, data: { version: { increment: 1 } } });
  await tx.admissionDocument.updateMany({
    where: { registrationId: id },
    data: { state: 'STALE', releasedAt: null },
  });
  await event(tx, 'REGISTRATION_CONTACT_CHANGED', id);
}
/** Called only after the new account email has been verified, in the same transaction. */
export async function syncRegistrationEmail(tx: Tx, userId: string, email: string) {
  const rows = await tx.registration.findMany({
    where: { OR: [{ people: { some: { userId } } }, { coaches: { some: { userId } } }] },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  for (const { id } of rows) {
    await lock(tx, id);
    const r = await tx.registration.findUniqueOrThrow({
      where: { id },
      include: { people: true, coaches: true },
    });
    for (const p of r.people.filter((p) => p.userId === userId))
      await tx.registrationPerson.update({
        where: { id: p.id },
        data: { email, answers: json(contactAnswers(p.answers as Data, email)) },
      });
    for (const p of r.coaches.filter((p) => p.userId === userId))
      await tx.registrationCoach.update({
        where: { id: p.id },
        data: { answers: json(contactAnswers(p.answers as Data, email)) },
      });
    if (r.snapshot)
      await tx.registration.update({
        where: { id },
        data: {
          snapshot: json(normalizeRegistrationSnapshot(r.snapshot, new Map([[userId, email]]))),
        },
      });
    await invalidateContactDocuments(tx, id);
  }
}

/** One-time, restart-safe compatibility pass over live records; immutable revision/audit history stays intact. */
export async function migrateProfileFields() {
  await db.$transaction(
    async (tx) => {
      const key = 'migration:profile-fields-v2';
      await lock(tx, key);
      if (await tx.setting.findUnique({ where: { key } })) return;
      const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
      // Ordered cursors bound the memory needed for existing deployments.
      let cursor: string | undefined;
      while (true) {
        const rows = await tx.user.findMany({
          take: 100,
          orderBy: { id: 'asc' },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const row of rows) {
          const profile = normalizeProfileYears(row.profile as Data);
          if (changed(profile, row.profile))
            await tx.user.update({
              where: { id: row.id },
              data: { profile: json(profile), version: { increment: 1 } },
            });
        }
        if (rows.length < 100) break;
        cursor = rows.at(-1)!.id;
      }
      for (const row of await tx.personRecord.findMany()) {
        const data = snapshotProfile(row.data);
        if (changed(data, row.data))
          await tx.personRecord.update({ where: { id: row.id }, data: { data: json(data) } });
      }
      for (const row of await tx.identityRequest.findMany({ where: { status: 'PENDING' } })) {
        const data = snapshotProfile(row.data);
        if (changed(data, row.data))
          await tx.identityRequest.update({ where: { id: row.id }, data: { data: json(data) } });
      }
      cursor = undefined;
      while (true) {
        const rows: Prisma.RegistrationGetPayload<{ include: { people: true; coaches: true } }>[] =
          await tx.registration.findMany({
            take: 50,
            orderBy: { id: 'asc' },
            include: { people: true, coaches: true },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
        for (const row of rows) {
          const accounts = await tx.user.findMany({
            where: {
              id: {
                in: [
                  ...row.people.flatMap((p) => (p.userId ? [p.userId] : [])),
                  ...row.coaches.map((p) => p.userId),
                ],
              },
            },
            select: { id: true, email: true },
          });
          const emails = new Map(accounts.map((p) => [p.id, p.email]));
          let updated = false;
          for (const p of row.people) {
            const email = (p.userId && emails.get(p.userId)) || p.email;
            const answers = { ...normalizeProfileYears(p.answers as Data), email };
            if (email !== p.email || changed(answers, p.answers)) {
              await tx.registrationPerson.update({
                where: { id: p.id },
                data: { email, answers: json(answers) },
              });
              updated = true;
            }
          }
          for (const p of row.coaches) {
            const email = emails.get(p.userId);
            const answers = {
              ...normalizeProfileYears(p.answers as Data),
              ...(email ? { email } : {}),
            };
            if (changed(answers, p.answers)) {
              await tx.registrationCoach.update({
                where: { id: p.id },
                data: { answers: json(answers) },
              });
              updated = true;
            }
          }
          const answers = normalizeRegistrationAnswers(row.answers as Data);
          const snapshot = normalizeRegistrationSnapshot(row.snapshot, emails);
          if (changed(answers, row.answers) || changed(snapshot, row.snapshot)) {
            await tx.registration.update({
              where: { id: row.id },
              data: { answers: json(answers), ...(snapshot ? { snapshot: json(snapshot) } : {}) },
            });
            updated = true;
          }
          if (updated) await invalidateContactDocuments(tx, row.id);
        }
        if (rows.length < 50) break;
        cursor = rows.at(-1)!.id;
      }
      const email = defaultFields.find((f) => f.key === 'email')!;
      await tx.fieldDefinition.upsert({
        where: { key: 'email' },
        create: { key: 'email', definition: json(email) },
        update: {},
      });
      await tx.setting.create({ data: { key, value: { completed: true } } });
    },
    { timeout: 120000 },
  );
}
