import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  contestSchema,
  policySchema,
  fieldsSchema,
  registrationSchema,
  fieldsJsonSchema,
  fieldVisible,
  quoteFee,
  registrationEligible,
  contestStatus,
  type Principal,
  type ContestPolicy,
  type FieldDefinition,
  type Answers,
} from '@contest-center/contracts';
import {
  db,
  json,
  lock,
  audit,
  event,
  registrationInclude,
  type Registration,
  type Tx,
} from './db.js';
import {
  canRead,
  canEdit,
  requireAdmin,
  requireManager,
  manages,
  getRegistration,
  checkVersion,
  opaqueToken,
  sha,
} from './security.js';
import { config } from './config.js';

const ajv = new (Ajv as unknown as typeof import('ajv').Ajv)({ allErrors: true, strict: false });
(addFormats as unknown as (a: typeof ajv) => void)(ajv);
export const policy = (r: Registration) => policySchema.parse(r.policySnapshot ?? r.contest.policy);
export async function loaded(tx: Tx, id: string) {
  const r = await tx.registration.findUnique({ where: { id }, include: registrationInclude });
  if (!r) throw new NotFoundException('报名不存在');
  return r;
}
export async function refresh(tx: Tx, id: string) {
  const r = await loaded(tx, id);
  const eligible = registrationEligible(r, policy(r));
  if (r.eligible !== eligible) {
    await tx.registration.update({ where: { id }, data: { eligible } });
    await event(tx, 'ELIGIBILITY', id, { eligible, version: r.version });
  }
  if (!eligible)
    await tx.admissionDocument.updateMany({
      where: { registrationId: id, state: { in: ['READY', 'RELEASED'] } },
      data: { state: 'STALE', releasedAt: null },
    });
  return { ...r, eligible };
}
export async function dirty(tx: Tx, r: Registration, u: Principal, reason: string) {
  const next = r.status === 'SUBMITTED' || r.status === 'CORRECTION' ? 'CORRECTION' : r.status;
  await tx.registration.update({
    where: { id: r.id },
    data: { status: next, review: 'PENDING', eligible: false, version: { increment: 1 } },
  });
  await tx.admissionDocument.updateMany({
    where: { registrationId: r.id },
    data: { state: 'STALE', releasedAt: null },
  });
  await event(tx, 'ELIGIBILITY', r.id, { eligible: false, version: r.version + 1 });
  await audit(tx, u.id, reason, r.id);
}
function windowOpen(r: Registration) {
  const correction =
    r.status === 'CORRECTION' &&
    new Date() < new Date(r.contest.correctionUntil ?? r.contest.closesAt);
  if (contestStatus(r.contest) !== 'OPEN' && !correction)
    throw new BadRequestException('报名或补正时间已结束');
  if (['CANCELLED', 'CANCEL_REQUESTED'].includes(r.status))
    throw new BadRequestException('此报名已取消或正在取消');
}
export class RegistrationService {
  async statistics(u: Principal, contestId: string) {
    requireManager(u, contestId);
    const groups = await db.registration.groupBy({
      by: ['status', 'review', 'eligible'],
      where: { contestId },
      _count: { _all: true },
    });
    return groups.reduce(
      (sum, row) => {
        const n = row._count._all;
        sum.total += n;
        if (row.status === 'SUBMITTED' && row.review === 'PENDING') sum.pending += n;
        if (row.status === 'SUBMITTED' && row.review === 'APPROVED') sum.approved += n;
        if (row.review === 'REJECTED') sum.rejected += n;
        if (row.eligible) sum.eligible += n;
        return sum;
      },
      { total: 0, pending: 0, approved: 0, rejected: 0, eligible: 0 },
    );
  }
  async contests(u?: Principal, all = false) {
    const rows = await db.contest.findMany({
      where:
        all && u?.isAdmin
          ? {}
          : all && u
            ? { OR: [{ id: { in: u.contestIds } }, { published: true, archived: false }] }
            : { published: true, archived: false },
      orderBy: [{ opensAt: 'desc' }],
      include: {
        forms: { orderBy: { version: 'desc' }, take: 1 },
        _count: { select: { registrations: true } },
      },
    });
    return rows.map((c) => ({
      ...c,
      status: contestStatus(c),
      fields: c.forms[0]?.fields ?? [],
      forms: undefined,
    }));
  }
  async contest(id: string, u?: Principal) {
    const c = await db.contest.findUnique({
      where: { id },
      include: { forms: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!c || (!c.published && !u?.isAdmin && !u?.contestIds.includes(id)))
      throw new NotFoundException('竞赛不存在');
    return { ...c, forms: undefined, fields: c.forms[0]?.fields ?? [], status: contestStatus(c) };
  }
  async saveContest(u: Principal, id: string | undefined, body: unknown) {
    const b = contestSchema.parse(body);
    if (id) requireManager(u, id);
    else requireAdmin(u);
    return db.$transaction(async (tx) => {
      if (id) {
        await lock(tx, id);
        const c = await tx.contest.findUniqueOrThrow({ where: { id } });
        checkVersion(c.version, b.version);
      }
      const fields = b.fields;
      const { fields: _, version: __, policy: p, ...data } = b;
      const dates = {
        startsAt: new Date(b.startsAt),
        opensAt: new Date(b.opensAt),
        closesAt: new Date(b.closesAt),
        correctionUntil: b.correctionUntil ? new Date(b.correctionUntil) : null,
      };
      const c = id
        ? await tx.contest.update({
            where: { id },
            data: {
              ...data,
              ...dates,
              policy: json(p),
              version: { increment: 1 },
              formVersion: { increment: 1 },
            },
          })
        : await tx.contest.create({ data: { ...data, ...dates, policy: json(p) } });
      await tx.formVersion.create({
        data: {
          contestId: c.id,
          version: c.formVersion,
          fields: json(fields),
          schema: json(
            Object.fromEntries(
              ['PERSON', 'TEAM', 'COACH', 'REGISTRATION'].map((scope) => [
                scope,
                fieldsJsonSchema(fields, scope as FieldDefinition['scope']),
              ]),
            ),
          ),
        },
      });
      await audit(tx, u.id, id ? 'CONTEST_UPDATE' : 'CONTEST_CREATE', c.id);
      return c;
    });
  }
  async list(u: Principal, contestId?: string, cursor?: string, take = 500) {
    const where =
      contestId && manages(u, contestId)
        ? { contestId }
        : u.isAdmin
          ? { ...(contestId ? { contestId } : {}) }
          : {
              ...(contestId ? { contestId } : {}),
              OR: [
                { ownerId: u.id },
                { people: { some: { userId: u.id, active: true } } },
                { coaches: { some: { userId: u.id } } },
                { contestId: { in: u.contestIds } },
              ],
            };
    return db.registration.findMany({
      where,
      include: registrationInclude,
      orderBy: { id: 'asc' },
      take: Math.min(500, Math.max(1, take)),
      ...(cursor ? { cursor: { id: z.string().uuid().parse(cursor) }, skip: 1 } : {}),
    });
  }
  async detail(u: Principal, id: string) {
    const r = await getRegistration(u, id);
    const [vouchers, ledger, refunds, invoices, admissions, mappings, invitations] =
      await Promise.all([
        db.paymentVoucher.findMany({
          where: { registrationId: id },
          orderBy: { createdAt: 'desc' },
        }),
        db.ledgerEntry.findMany({ where: { registrationId: id }, orderBy: { createdAt: 'desc' } }),
        db.refund.findMany({ where: { registrationId: id } }),
        db.invoiceRequest.findMany({ where: { registrationId: id } }),
        db.admissionDocument.findMany({
          where: { registrationId: id },
          orderBy: { createdAt: 'desc' },
        }),
        db.accountMapping.findMany({
          where: { registrationId: id },
          select: {
            id: true,
            bindingId: true,
            username: true,
            state: true,
            remoteTeamId: true,
            remoteUserId: true,
            details: true,
          },
        }),
        canEdit(u, r)
          ? db.invitation.findMany({
              where: { registrationId: id },
              select: {
                id: true,
                kind: true,
                targetEmail: true,
                acceptedBy: true,
                expiresAt: true,
                revoked: true,
              },
            })
          : Promise.resolve([]),
      ]);
    const forms = await db.formVersion.findUnique({
      where: {
        contestId_version: {
          contestId: r.contestId,
          version: r.quoted ? r.formVersion : r.contest.formVersion,
        },
      },
    });
    return {
      ...r,
      latestFormVersion: forms?.version,
      formUpdated: !r.quoted && r.formVersion !== r.contest.formVersion,
      fields: forms?.fields ?? [],
      vouchers,
      ledger,
      refunds,
      invoices,
      admissions: admissions.map((a) => ({ ...a, storageKey: undefined })),
      mappings,
      invitations,
    };
  }
  async create(u: Principal, body: unknown) {
    if (!u.verified) throw new ForbiddenException('请先验证邮箱');
    const { contestId } = z.object({ contestId: z.string().uuid() }).parse(body);
    return db.$transaction(async (tx) => {
      const c = await tx.contest.findUniqueOrThrow({ where: { id: contestId } });
      if (!c.published || c.archived || contestStatus(c) !== 'OPEN')
        throw new BadRequestException('当前无法报名');
      const r = await tx.registration.create({
        data: {
          contestId,
          ownerId: u.id,
          formVersion: c.formVersion,
          people: {
            create: {
              contestId,
              userId: u.id,
              name: u.name,
              email: u.email,
              captain: true,
              confirmed: true,
              answers: json(u.profile),
            },
          },
        },
        include: registrationInclude,
      });
      await audit(tx, u.id, 'REGISTRATION_CREATE', r.id);
      return r;
    });
  }
  async save(u: Principal, id: string, body: unknown) {
    const b = registrationSchema.parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      checkVersion(r.version, b.version);
      windowOpen(r);
      const p = policy(r);
      if ((p.mode === 'INDIVIDUAL' && b.people.length !== 1) || b.people.length > p.maxMembers)
        throw new BadRequestException('参赛人数不符合规则');
      if (
        b.people.filter((x) => x.captain).length !== 1 ||
        !b.people.some(
          (x) => x.id === r.people.find((x) => x.userId === r.ownerId)?.id && x.captain,
        )
      )
        throw new BadRequestException('需要保留队长');
      const existing = new Map(r.people.map((x) => [x.id, x]));
      for (const x of b.people) {
        const old = x.id ? existing.get(x.id) : undefined;
        if (x.id && !old) throw new BadRequestException('成员不属于此报名');
        if (x.userId && x.userId !== old?.userId)
          throw new BadRequestException('账号绑定必须通过邀请确认');
        if (!old && p.memberMode !== 'MANUAL')
          throw new BadRequestException('此竞赛要求成员接受邀请');
      }
      const same =
        r.teamName === b.teamName &&
        r.teamEnglishName === b.teamEnglishName &&
        isDeepStrictEqual(r.answers, b.answers) &&
        r.people.length === b.people.length &&
        b.people.every((x) => {
          const old = x.id ? existing.get(x.id) : undefined;
          return (
            old &&
            old.name === x.name &&
            old.email === (old.userId ? old.email : x.email) &&
            old.captain === x.captain &&
            isDeepStrictEqual(old.answers, x.answers)
          );
        });
      if (same) return r;
      const ids = b.people.flatMap((x) => (x.id ? [x.id] : []));
      await tx.registrationPerson.deleteMany({ where: { registrationId: id, id: { notIn: ids } } });
      for (const x of b.people) {
        const old = x.id ? existing.get(x.id) : undefined;
        const data = {
          name: x.name,
          email: old?.userId ? old.email : x.email,
          captain: x.captain,
          answers: json(x.answers),
          uniqueKey: null,
        };
        if (old) await tx.registrationPerson.update({ where: { id: old.id }, data });
        else
          await tx.registrationPerson.create({
            data: { ...data, registrationId: id, contestId: r.contestId, confirmed: true },
          });
      }
      await tx.registration.update({
        where: { id },
        data: {
          teamName: b.teamName,
          teamEnglishName: b.teamEnglishName,
          answers: json(b.answers),
        },
      });
      await dirty(tx, r, u, 'REGISTRATION_EDIT');
      return loaded(tx, id);
    });
  }
  async submit(u: Principal, id: string, body: unknown) {
    const { version } = z.object({ version: z.number().int() }).parse(body);
    if (!u.verified) throw new ForbiddenException('请先验证邮箱');
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      let r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      checkVersion(r.version, version);
      windowOpen(r);
      const p = policy(r);
      if (
        r.people.length < p.minMembers ||
        r.people.length > p.maxMembers ||
        r.people.some((x) => !x.confirmed)
      )
        throw new BadRequestException('人数不符或成员尚未确认');
      if (p.mode === 'TEAM' && !r.teamName.trim()) throw new BadRequestException('请填写队名');
      if (
        (p.coachMode === 'REQUIRED' && !r.coaches.length) ||
        r.coaches.length > p.maxCoaches ||
        (p.coachMode === 'DISABLED' && r.coaches.length)
      )
        throw new BadRequestException('指导老师关联不符合竞赛要求');
      const formVersion = r.quoted ? r.formVersion : r.contest.formVersion;
      const form = await tx.formVersion.findUniqueOrThrow({
        where: { contestId_version: { contestId: r.contestId, version: formVersion } },
      });
      const fields = fieldsSchema.parse(form.fields);
      for (const person of r.people) {
        await this.validateAnswers(tx, u, r, fields, 'PERSON', person.answers as Answers);
        const uniqueKey = p.uniquePersonFields.length
          ? p.uniquePersonFields
              .map((k) =>
                String((person.answers as Answers)[k] ?? '')
                  .trim()
                  .toLowerCase(),
              )
              .join('|')
          : null;
        if (uniqueKey && uniqueKey.replaceAll('|', ''))
          await tx.registrationPerson.update({ where: { id: person.id }, data: { uniqueKey } });
      }
      const answers = r.answers as Record<string, Answers>;
      await this.validateAnswers(tx, u, r, fields, 'REGISTRATION', answers.registration ?? {});
      await this.validateAnswers(tx, u, r, fields, 'TEAM', answers.team ?? {});
      for (const coach of r.coaches) {
        await this.validateAnswers(tx, u, r, fields, 'COACH', coach.answers as Answers);
      }
      const fee = quoteFee(p, r.people.length);
      const delta = fee - r.feeCents;
      const snapshot = {
        teamName: r.teamName,
        teamEnglishName: r.teamEnglishName,
        answers: r.answers,
        people: r.people,
        coaches: r.coaches,
        fields,
        submittedAt: new Date().toISOString(),
      };
      await tx.registrationRevision.create({
        data: {
          registrationId: id,
          version: r.version + 1,
          actorId: u.id,
          snapshot: json(snapshot),
          reason: 'SUBMIT',
        },
      });
      await tx.registration.update({
        where: { id },
        data: {
          status: 'SUBMITTED',
          review: p.manualReview ? 'PENDING' : 'APPROVED',
          reviewReason: '',
          formVersion,
          policySnapshot: json(p),
          snapshot: json(snapshot),
          feeCents: fee,
          quoted: true,
          submittedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (delta)
        await tx.ledgerEntry.create({
          data: {
            registrationId: id,
            contestId: r.contestId,
            kind: 'RECEIVABLE',
            amountCents: delta,
            sourceId: `quote:${id}:${r.version + 1}`,
            actorId: u.id,
            note: '报名应收 / 人数调整',
          },
        });
      await audit(tx, u.id, 'REGISTRATION_SUBMIT', id);
      await event(tx, 'NOTIFY', id, { message: '您的报名已经提交。' });
      return refresh(tx, id);
    });
  }
  private async validateAnswers(
    tx: Tx,
    u: Principal,
    r: Registration,
    fields: FieldDefinition[],
    scope: FieldDefinition['scope'],
    answers: Answers,
  ) {
    const relevant = fields.filter((f) => f.scope === scope && fieldVisible(f, answers));
    const values = Object.fromEntries(
      Object.entries(answers).filter(([k]) => relevant.some((f) => f.key === k)),
    );
    const required = relevant.filter((f) => f.required).map((f) => f.key);
    const validator = ajv.compile({ ...fieldsJsonSchema(relevant, scope), required });
    if (!validator(values))
      throw new BadRequestException(
        `${scope}：${validator.errors?.map((e) => `${e.instancePath || e.params.missingProperty} ${e.message}`).join('；')}`,
      );
    for (const f of relevant) {
      if (
        f.required &&
        (values[f.key] === '' ||
          (Array.isArray(values[f.key]) && !(values[f.key] as unknown[]).length))
      )
        throw new BadRequestException(`请填写${f.label}`);
      if (['file', 'photo'].includes(f.type) && values[f.key]) {
        const file = await tx.attachment.findUnique({ where: { id: String(values[f.key]) } });
        if (!file || (file.registrationId !== r.id && file.ownerId !== u.id))
          throw new ForbiddenException('附件不属于此报名');
        if (f.type === 'photo' && !file.mime.startsWith('image/'))
          throw new BadRequestException('照片需要图片文件');
        await tx.attachment.update({ where: { id: file.id }, data: { registrationId: r.id } });
      }
    }
  }
  async review(u: Principal, id: string, body: unknown) {
    const b = z
      .object({
        version: z.number().int(),
        decision: z.enum(['APPROVED', 'CORRECTION', 'REJECTED']),
        reason: z.string().max(3000).default(''),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      requireManager(u, r.contestId);
      checkVersion(r.version, b.version);
      const p = policy(r);
      if (r.status !== 'SUBMITTED') throw new BadRequestException('当前报名不能审核');
      if (p.paymentSequence === 'PAYMENT_FIRST' && r.netPaidCents < r.feeCents)
        throw new BadRequestException('此竞赛需要先确认足额到账');
      if (b.decision !== 'APPROVED' && !b.reason.trim())
        throw new BadRequestException('请填写审核意见');
      await tx.registration.update({
        where: { id },
        data: {
          review: b.decision,
          status: b.decision === 'CORRECTION' ? 'CORRECTION' : 'SUBMITTED',
          reviewReason: b.reason,
          version: { increment: 1 },
        },
      });
      await audit(tx, u.id, 'REVIEW', id, b);
      await event(tx, 'NOTIFY', id, { message: `报名审核：${b.decision}。${b.reason}` });
      return refresh(tx, id);
    });
  }
  async cancel(u: Principal, id: string, body: unknown) {
    const { version } = z.object({ version: z.number().int() }).parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      checkVersion(r.version, version);
      const status =
        r.netPaidCents > 0 && !manages(u, r.contestId) ? 'CANCEL_REQUESTED' : 'CANCELLED';
      await tx.registration.update({
        where: { id },
        data: { status, eligible: false, version: { increment: 1 } },
      });
      await tx.registrationPerson.updateMany({
        where: { registrationId: id },
        data: { active: status !== 'CANCELLED' },
      });
      await audit(tx, u.id, 'CANCEL', id);
      return refresh(tx, id);
    });
  }
  async withdraw(u: Principal, id: string, body: unknown) {
    const { version } = z.object({ version: z.number().int() }).parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      checkVersion(r.version, version);
      windowOpen(r);
      if (r.netPaidCents > 0) throw new BadRequestException('已到账报名需要取消 / 退款');
      await tx.registration.update({
        where: { id },
        data: { status: 'DRAFT', review: 'PENDING', version: { increment: 1 } },
      });
      await audit(tx, u.id, 'WITHDRAW', id);
      return refresh(tx, id);
    });
  }
  async invite(u: Principal, id: string | undefined, body: unknown) {
    const b = z
      .object({
        kind: z.enum(['MEMBER', 'COACH', 'COACH_LINK']),
        targetEmail: z.email().optional(),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      if (b.kind !== 'MEMBER') await lock(tx, 'role-authorizations');
      if (b.kind === 'COACH_LINK') {
        const coach = await tx.user.findUnique({ where: { id: u.id } });
        if (!coach?.isCoach || !coach.verified)
          throw new ForbiddenException('请先通过授权链接获得指导老师身份并验证邮箱');
      }
      if (id) {
        await lock(tx, id);
        const r = await loaded(tx, id);
        if (!canEdit(u, r)) throw new ForbiddenException();
        windowOpen(r);
        const p = policy(r);
        if (b.kind === 'MEMBER' && (p.mode !== 'TEAM' || p.memberMode !== 'INVITE'))
          throw new BadRequestException('此竞赛不采用成员邀请');
        if (b.kind === 'COACH' && p.coachMode === 'DISABLED')
          throw new BadRequestException('此竞赛不允许老师');
      } else if (b.kind !== 'COACH_LINK') throw new BadRequestException('需要报名 ID');
      const raw = opaqueToken();
      const v = await tx.invitation.create({
        data: {
          tokenHash: sha(raw),
          kind: b.kind,
          registrationId: id,
          inviterId: u.id,
          targetEmail: b.targetEmail?.toLowerCase(),
          coachId: b.kind === 'COACH_LINK' ? u.id : null,
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      });
      return { id: v.id, url: `${config.publicUrl}/invite/${raw}`, expiresAt: v.expiresAt };
    });
  }
  async invitation(u: Principal, token: string) {
    const i = await db.invitation.findUnique({ where: { tokenHash: sha(token) } });
    if (!i || i.revoked || i.expiresAt < new Date()) throw new BadRequestException('邀请已失效');
    if (i.targetEmail && i.targetEmail !== u.email.toLowerCase())
      throw new ForbiddenException('邀请邮箱与当前账号不符');
    if (i.acceptedBy && i.acceptedBy !== u.id) throw new ConflictException('邀请已被使用');
    const r = i.registrationId
      ? await db.registration.findUnique({
          where: { id: i.registrationId },
          select: { teamName: true, contest: { select: { title: true } } },
        })
      : null;
    return {
      id: i.id,
      kind: i.kind,
      targetEmail: i.targetEmail,
      registration: r,
      accepted: i.acceptedBy === u.id,
      expiresAt: i.expiresAt,
    };
  }
  async accept(u: Principal, token: string, body: unknown) {
    if (!u.verified) throw new ForbiddenException('请先验证邮箱');
    const b = z.object({ registrationId: z.string().uuid().optional() }).parse(body);
    return db.$transaction(async (tx) => {
      const record = await tx.invitation.findUnique({ where: { tokenHash: sha(token) } });
      if (!record) throw new BadRequestException('邀请已失效');
      if (record.kind !== 'MEMBER') await lock(tx, 'role-authorizations');
      await lock(tx, `invitation:${record.id}`);
      const i = await tx.invitation.findUnique({ where: { id: record.id } });
      if (!i || i.revoked || i.expiresAt < new Date()) throw new BadRequestException('邀请已失效');
      if (i.acceptedBy) {
        if (i.acceptedBy === u.id) return { ok: true, registrationId: i.registrationId };
        throw new ConflictException('邀请已被使用');
      }
      if (i.targetEmail && i.targetEmail !== u.email)
        throw new ForbiddenException('邀请邮箱与当前账号不符');
      const receiver = await tx.user.findUnique({ where: { id: u.id } });
      if (!receiver?.verified || receiver.email !== u.email)
        throw new ForbiddenException('请验证当前账号邮箱后重新确认邀请');
      const id = i.registrationId ?? b.registrationId;
      if (!id) throw new BadRequestException('请选择关联报名');
      await lock(tx, id);
      const r = await loaded(tx, id);
      windowOpen(r);
      const p = policy(r);
      if (i.kind === 'MEMBER') {
        if (r.people.some((person) => person.userId === u.id && person.active))
          throw new ConflictException('您已是此队伍的成员');
        if (p.mode !== 'TEAM' || p.memberMode !== 'INVITE' || r.people.length >= p.maxMembers)
          throw new BadRequestException('无法加入此团队');
        await tx.registrationPerson.create({
          data: {
            registrationId: id,
            contestId: r.contestId,
            userId: u.id,
            name: u.name,
            email: u.email,
            answers: json(u.profile),
            confirmed: true,
          },
        });
      } else {
        const coachId = i.kind === 'COACH_LINK' ? i.coachId! : u.id;
        if (i.kind === 'COACH_LINK' && !canEdit(u, r)) throw new ForbiddenException();
        const coach = await tx.user.findUniqueOrThrow({ where: { id: coachId } });
        if (!coach.isCoach || !coach.verified)
          throw new ForbiddenException('老师需要通过授权链接获得身份并验证邮箱');
        if (p.coachMode === 'DISABLED' || r.coaches.length >= p.maxCoaches)
          throw new BadRequestException('老师人数已达上限或竞赛禁用老师');
        await tx.registrationCoach.create({
          data: { registrationId: id, userId: coachId, answers: json(coach.profile) },
        });
      }
      await tx.invitation.update({
        where: { id: i.id },
        data: { acceptedBy: u.id, acceptedAt: new Date(), registrationId: id },
      });
      await dirty(tx, r, u, 'INVITATION_ACCEPT');
      return { ok: true, registrationId: id };
    });
  }
  async revokeInvite(u: Principal, id: string) {
    return db.$transaction(async (tx) => {
      await lock(tx, `invitation:${id}`);
      const i = await tx.invitation.findUniqueOrThrow({ where: { id } });
      if (i.inviterId !== u.id) {
        if (!i.registrationId) throw new ForbiddenException();
        await getRegistration(u, i.registrationId, true);
      }
      await tx.invitation.update({ where: { id }, data: { revoked: true } });
      return { ok: true };
    });
  }
  async removeCoach(u: Principal, id: string, coachId: string, body: unknown) {
    const { version } = z.object({ version: z.number().int() }).parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      checkVersion(r.version, version);
      await tx.registrationCoach.deleteMany({ where: { registrationId: id, id: coachId } });
      await dirty(tx, r, u, 'COACH_REMOVE');
      return refresh(tx, id);
    });
  }
  async personAnswers(u: Principal, id: string, personId: string, body: unknown) {
    const b = z
      .object({
        version: z.number().int(),
        name: z.string().min(1).max(100),
        answers: z.record(z.string(), z.json()),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      const p = r.people.find((p) => p.id === personId && p.userId === u.id && p.active);
      if (!p) throw new ForbiddenException();
      checkVersion(r.version, b.version);
      windowOpen(r);
      await tx.registrationPerson.update({
        where: { id: p.id },
        data: { name: b.name, answers: json(b.answers), uniqueKey: null },
      });
      await dirty(tx, r, u, 'MEMBER_EDIT');
      return loaded(tx, id);
    });
  }
  async coachAnswers(u: Principal, id: string, coachId: string, body: unknown) {
    const b = z
      .object({ version: z.number().int(), answers: z.record(z.string(), z.json()) })
      .parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, id);
      const r = await loaded(tx, id);
      if (!canEdit(u, r)) throw new ForbiddenException();
      checkVersion(r.version, b.version);
      windowOpen(r);
      await tx.registrationCoach.update({
        where: { id: coachId, registrationId: id },
        data: { answers: json(b.answers) },
      });
      await dirty(tx, r, u, 'COACH_EDIT');
      return loaded(tx, id);
    });
  }
}
