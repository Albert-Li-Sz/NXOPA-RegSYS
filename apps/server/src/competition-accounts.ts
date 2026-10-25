import { randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import saslprep from '@mongodb-js/saslprep';
import { policySchema } from '@contest-center/contracts';
import { db, lock, type Tx } from './db.js';
import { decrypt, encrypt } from './security.js';
import { modulesFor } from './workflow.js';

type AccountRegistration = {
  id: string;
  number: number | null;
  policySnapshot: unknown;
  people: { active?: boolean; captain: boolean; answers: unknown }[];
};

// Match Hydro Types.Username, including SASLprep and case-insensitive uniqueness.
export function competitionUsername(studentId: unknown, registration: string | number) {
  if (typeof studentId !== 'string' || !studentId.trim())
    throw new BadRequestException(`报名 ${registration} 缺少本人／队长学号，请补正后重试`);
  try {
    const name = saslprep(studentId.trim());
    if (/^(?:.{3,31}|[\u4E00-\u9FA5]{2})$/.test(name)) return name;
  } catch {
    // The same prohibited Unicode and bidirectional strings are rejected by Hydro.
  }
  throw new BadRequestException(`报名 ${registration} 的本人／队长学号不符合 Hydro 用户名规则`);
}

export function registrationUsername(r: AccountRegistration, contestPolicy: unknown) {
  const people = r.people.filter((p) => p.active !== false);
  const individual = policySchema.parse(r.policySnapshot ?? contestPolicy).mode === 'INDIVIDUAL';
  const person = individual ? people[0] : people.find((p) => p.captain);
  return competitionUsername(
    (person?.answers as Record<string, unknown> | null)?.student_id,
    r.number ?? r.id,
  );
}

// Validate against all eligible entries, even when an export selects only one group.
// No credentials are created or changed during this preflight.
export async function validateCompetitionUsernames(
  tx: Tx,
  contestId: string,
  contestPolicy: unknown,
) {
  const names = new Map<string, string>();
  const defaultMode = policySchema.parse(contestPolicy).mode;
  // Project only the login field in SQL; unrelated form answers can be very large.
  const rows = await tx.$queryRaw<{ id: string; number: number | null; studentId: unknown }[]>`
    SELECT r.id, r.number, p."studentId"
    FROM "Registration" r
    LEFT JOIN LATERAL (
      SELECT person.answers->'student_id' AS "studentId"
      FROM "RegistrationPerson" person
      WHERE person."registrationId" = r.id AND person.active
        AND (COALESCE(r."policySnapshot"->>'mode', ${defaultMode}) = 'INDIVIDUAL' OR person.captain)
      ORDER BY person.captain DESC, person.id ASC LIMIT 1
    ) p ON true
    WHERE r."contestId" = ${contestId}::uuid AND r.eligible
      AND r.status NOT IN ('DRAFT', 'CANCELLED', 'CANCEL_REQUESTED')
    ORDER BY r.number ASC NULLS LAST, r.id ASC`;
  const keys = new Map<string, string | number>();
  for (const r of rows) {
    const name = competitionUsername(r.studentId, r.number ?? r.id);
    const key = name.toLowerCase();
    if (keys.has(key))
      throw new BadRequestException(
        `报名 ${keys.get(key)} 与 ${r.number ?? r.id} 的比赛登录学号重复：${name}`,
      );
    keys.set(key, r.number ?? r.id);
    names.set(r.id, name);
  }
  return names;
}

export async function ensureCompetitionAccount(
  tx: Tx,
  registrationId: string,
  expectedVersion?: number,
  validatedNames?: Map<string, string>,
) {
  const identity = await tx.registration.findUniqueOrThrow({
    where: { id: registrationId },
    select: { contestId: true },
  });
  // All credential consumers acquire the contest lock before registration locks.
  await lock(tx, `competition-accounts:${identity.contestId}`);
  await lock(tx, registrationId);
  const r = await tx.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: { contest: true, people: { where: { active: true } } },
  });
  if (!modulesFor(r.contest).integrations) return null;
  if (!r.eligible || ['DRAFT', 'CANCELLED', 'CANCEL_REQUESTED'].includes(r.status))
    throw new BadRequestException(`报名 ${r.number ?? r.id} 尚未取得参赛资格`);
  if (expectedVersion !== undefined && r.version !== expectedVersion)
    throw new BadRequestException('报名资料已改变，请刷新后重试');
  const names =
    validatedNames ?? (await validateCompetitionUsernames(tx, r.contestId, r.contest.policy));
  const username = registrationUsername(r, r.contest.policy);
  if (names.get(r.id) !== username) throw new BadRequestException('报名学号已改变，请刷新后重试');
  const prior = await tx.competitionAccount.findUnique({ where: { registrationId } });
  if (prior && prior.username !== username)
    await tx.admissionDocument.updateMany({
      where: { registrationId },
      data: { state: 'STALE', releasedAt: null, version: { increment: 1 } },
    });
  // Release an obsolete reservation when another entry has changed its captain/student ID.
  const held = await tx.competitionAccount.findUnique({
    where: {
      contestId_usernameKey: { contestId: r.contestId, usernameKey: username.toLowerCase() },
    },
  });
  if (held && held.registrationId !== registrationId) {
    if (names.get(held.registrationId)?.toLowerCase() === username.toLowerCase())
      throw new BadRequestException(
        `报名 ${r.number ?? r.id} 的比赛登录学号已被其他报名使用：${username}`,
      );
    await tx.competitionAccount.update({
      where: { id: held.id },
      data: { usernameKey: `retired:${held.id}` },
    });
  }
  const account = await tx.competitionAccount.upsert({
    where: { registrationId },
    create: {
      registrationId,
      contestId: r.contestId,
      username,
      usernameKey: username.toLowerCase(),
      credential: encrypt(`P${randomBytes(18).toString('base64url')}`, 'competition-account'),
    },
    update: { username, usernameKey: username.toLowerCase() },
  });
  return {
    username: account.username,
    password: decrypt(account.credential, 'competition-account'),
  };
}

export async function competitionCredentials(registrationId: string, expectedVersion?: number) {
  return db.$transaction((tx) => ensureCompetitionAccount(tx, registrationId, expectedVersion), {
    timeout: 120000,
  });
}
