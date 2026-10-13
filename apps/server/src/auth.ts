import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { hash, verify, argon2id } from 'argon2';
import { randomInt } from 'node:crypto';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  invitationReturnPathSchema,
  profileComplete,
  type Principal,
} from '@contest-center/contracts';
import { db, audit, event, json, lock } from './db.js';
import { config } from './config.js';
import { publicLink } from './site-settings.js';
import { opaqueToken, sha, hmac, same, encrypt } from './security.js';
import { effectiveAuthorization } from './authorization.js';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
export type AuthRequest = Request & {
  principal?: Principal;
  sessionId?: string;
};
export function user(req: AuthRequest) {
  if (!req.principal) throw new UnauthorizedException('请先登录');
  return req.principal;
}
export async function rateLimit(key: string, max = 20) {
  const n = await redis.incr(`rate:${key}`);
  if (n === 1) await redis.expire(`rate:${key}`, 60);
  if (n > max) throw new ForbiddenException('请求过于频繁，请稍后重试');
}
export const passwordSchema = z.string().min(10, '密码至少 10 位').max(128);
const publicUser = async (id: string): Promise<Principal> => {
  const u = await db.user.findUniqueOrThrow({ where: { id }, include: { roles: true } });
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    verified: u.verified,
    ...(await effectiveAuthorization(id)),
    isCoach: u.isCoach,
    hasPassword: !!u.passwordHash,
    profileComplete: profileComplete(u),
    profile: u.profile as Principal['profile'],
    version: u.version,
    kind: u.kind === 'TEACHER' ? 'TEACHER' : 'STUDENT',
    identityStatus: u.identityStatus,
    avatarUrl: u.avatarAttachmentId ? `/api/v1/files/public/${u.avatarAttachmentId}` : null,
    relatedUserIds: u.personId
      ? (
          await db.user.findMany({
            where: { personId: u.personId, OR: [{ id: u.id }, { deactivatedAt: { not: null } }] },
            select: { id: true },
          })
        ).map((x) => x.id)
      : [u.id],
  };
};
export async function attachPrincipal(req: AuthRequest) {
  const token = req.cookies?.cc_session;
  if (!token) return;
  const id = sha(String(token));
  const s = await db.session.findUnique({
    where: { id },
    include: { user: { select: { passwordHash: true } } },
  });
  if (s && s.expiresAt > new Date()) {
    if (
      (await db.user.findUnique({ where: { id: s.userId }, select: { deactivatedAt: true } }))
        ?.deactivatedAt
    )
      return;
    req.sessionId = id;
    req.principal = await publicUser(s.userId);
  }
}
export async function checkCsrf(req: AuthRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (
    req.sessionId &&
    !same(String(req.headers['x-csrf-token'] ?? ''), hmac(config.encryptionKey, req.sessionId))
  )
    throw new ForbiddenException('CSRF 校验失败，请刷新页面');
}
export function csrf(req: AuthRequest) {
  return req.sessionId ? hmac(config.encryptionKey, req.sessionId) : '';
}
export async function session(req: AuthRequest, res: Response, id: string) {
  const token = opaqueToken();
  await db.session.create({
    data: {
      id: sha(token),
      userId: id,
      expiresAt: new Date(Date.now() + 7 * 86400000),
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    },
  });
  res.cookie('cc_session', token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    maxAge: 7 * 86400000,
    path: '/',
  });
  return { user: await publicUser(id), csrf: hmac(config.encryptionKey, sha(token)) };
}
async function mailToken(id: string, purpose: string, next?: string) {
  const raw = opaqueToken();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.$transaction(async (tx) => {
    await lock(tx, `auth:${id}`);
    const u = await tx.user.findUniqueOrThrow({ where: { id } });
    await tx.emailToken.updateMany({
      where: { userId: id, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.emailToken.create({
      data: {
        id: sha(raw),
        userId: id,
        purpose,
        codeHash: hmac(config.encryptionKey, `${sha(raw)}:${code}`),
        expiresAt: new Date(Date.now() + (purpose === 'CLOSE' ? 600000 : 3600000)),
      },
    });
    await event(tx, 'MAIL', id, {
      to: u.email,
      subject:
        purpose === 'VERIFY'
          ? '验证您的邮箱'
          : purpose === 'CLOSE'
            ? '注销账号验证码'
            : '重置登录密码',
      category:
        purpose === 'VERIFY' ? 'AUTH_VERIFY' : purpose === 'CLOSE' ? 'ACCOUNT_CLOSE' : 'AUTH_RESET',
      encryptedCode: encrypt(code),
      verificationTokenId: sha(raw),
      name: u.name,
      text: `${u.name}，${purpose === 'CLOSE' ? '注销验证码在 10 分钟内有效' : '验证码及链接在一小时内有效'}。\n如果您未发起此操作，请忽略此邮件。`,
      ...(purpose === 'CLOSE'
        ? {}
        : {
            actionPath: `/account/${purpose === 'VERIFY' ? 'verify' : 'reset'}?${new URLSearchParams({ token: raw, ...(next ? { next } : {}) })}`,
          }),
    });
  });
}
export class AuthService {
  async register(body: unknown, req: AuthRequest, res: Response) {
    await rateLimit(`register:${req.ip}`, 10);
    const b = z
      .object({
        email: z.email(),
        username: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/),
        name: z.string().trim().min(1).max(100),
        password: passwordSchema,
        kind: z.enum(['STUDENT', 'TEACHER']).default('STUDENT'),
        identifier: z.string().trim().min(1).max(100).optional(),
        enrollmentYear: z
          .number()
          .int()
          .min(1950)
          .max(new Date().getFullYear() + 1)
          .optional(),
        employedAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        next: invitationReturnPathSchema.optional(),
      })
      .parse(body);
    if (
      (body as Record<string, unknown>).kind !== undefined &&
      (!b.identifier ||
        (b.kind === 'STUDENT'
          ? !b.enrollmentYear
          : !b.employedAt ||
            !Number.isFinite(Date.parse(b.employedAt)) ||
            new Date(b.employedAt).toISOString().slice(0, 10) !== b.employedAt))
    )
      throw new BadRequestException('学生需填写学号和入学年份，教师需填写工号和有效入职日期');
    const u = await db.user.create({
      data: {
        name: b.name,
        username: b.username,
        email: b.email.toLowerCase(),
        passwordHash: await hash(b.password, { type: argon2id }),
        kind: b.kind,
        isCoach: b.kind === 'TEACHER',
        profile: json(
          b.kind === 'TEACHER'
            ? { employee_id: b.identifier, employed_at: b.employedAt }
            : { student_id: b.identifier, enrollment_year: b.enrollmentYear },
        ),
      },
    });
    await mailToken(u.id, 'VERIFY', b.next);
    return session(req, res, u.id);
  }
  async login(body: unknown, req: AuthRequest, res: Response) {
    await rateLimit(`login:${req.ip}`, 12);
    const b = z
      .object({ account: z.string().min(1).max(254), password: z.string().max(128) })
      .parse(body);
    const u = await db.user.findFirst({
      where: { OR: [{ email: b.account.toLowerCase() }, { username: b.account }] },
    });
    if (!u?.passwordHash || u.deactivatedAt || !(await verify(u.passwordHash, b.password)))
      throw new UnauthorizedException('账号或密码错误');
    return session(req, res, u.id);
  }
  async logout(req: AuthRequest, res: Response) {
    if (req.sessionId) await db.session.deleteMany({ where: { id: req.sessionId } });
    res.clearCookie('cc_session', { path: '/' });
    return { ok: true };
  }
  async sessions(req: AuthRequest) {
    return db.session.findMany({
      where: { userId: user(req).id, expiresAt: { gt: new Date() } },
      select: { id: true, createdAt: true, expiresAt: true, userAgent: true },
      orderBy: { createdAt: 'desc' },
    });
  }
  async revoke(req: AuthRequest, id: string) {
    await db.session.deleteMany({ where: { id, userId: user(req).id } });
    return { ok: true };
  }
  async resend(req: AuthRequest, body: unknown = {}) {
    const u = user(req);
    const b = z.object({ next: invitationReturnPathSchema.optional() }).parse(body ?? {});
    await rateLimit(`verify:${u.id}`, 3);
    if (!u.verified) await mailToken(u.id, 'VERIFY', b.next);
    return { ok: true };
  }
  async forgot(body: unknown, req: AuthRequest) {
    await rateLimit(`forgot:${req.ip}`, 5);
    const { email } = z.object({ email: z.email() }).parse(body);
    const u = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (u && !u.deactivatedAt) await mailToken(u.id, 'RESET');
    return { ok: true };
  }
  async consume(body: unknown, purpose: string) {
    const b = z
      .object({
        token: z.string().min(30).max(100),
        password: purpose === 'RESET' ? passwordSchema : z.string().optional(),
      })
      .parse(body);
    const pw = purpose === 'RESET' ? await hash(b.password!, { type: argon2id }) : undefined;
    return db.$transaction(async (tx) => {
      const record = await tx.emailToken.findUnique({ where: { id: sha(b.token) } });
      if (!record) throw new BadRequestException('链接已失效');
      await lock(tx, `auth:${record.userId}`);
      const t = await tx.emailToken.findUnique({ where: { id: sha(b.token) } });
      if (!t || t.purpose !== purpose || t.usedAt || t.expiresAt < new Date())
        throw new BadRequestException('链接已失效');
      const changed = await tx.emailToken.updateMany({
        where: { id: t.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (!changed.count) throw new BadRequestException('链接已使用');
      await tx.user.update({
        where: { id: t.userId },
        data: purpose === 'RESET' ? { passwordHash: pw } : { verified: true },
      });
      if (purpose === 'RESET') await tx.session.deleteMany({ where: { userId: t.userId } });
      await audit(tx, t.userId, purpose, t.userId);
      return { ok: true };
    });
  }
  async profile(req: AuthRequest, body: unknown) {
    const u = user(req);
    const b = z
      .object({
        version: z.number().int(),
        name: z.string().trim().min(1).max(100),
        isCoach: z.boolean().optional(),
        profile: z.record(z.string(), z.json()),
        email: z.email().optional(),
        avatarAttachmentId: z.string().uuid().nullable().optional(),
      })
      .parse(body);
    if (b.version !== u.version) throw new BadRequestException('资料已更新，请刷新');
    if (b.isCoach !== undefined && b.isCoach !== u.isCoach)
      throw new ForbiddenException('身份变更须由管理员生成邀请链接并确认');
    const email = b.email?.toLowerCase();
    const changedEmail = email && email !== u.email;
    const current = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    if (['VERIFIED', 'RECORDED', 'PENDING'].includes(current.identityStatus)) {
      const keys = [
        'student_id',
        'employee_id',
        'class_name',
        'college',
        'school',
        'enrollment_year',
        'employed_at',
        'gender',
      ];
      if (
        b.name !== current.name ||
        keys.some(
          (key) => JSON.stringify(b.profile[key]) !== JSON.stringify((current.profile as any)[key]),
        )
      )
        throw new BadRequestException('实名信息变更需要提交审核，请前往实名认证');
    }
    if (
      b.avatarAttachmentId &&
      !(await db.attachment.findFirst({
        where: { id: b.avatarAttachmentId, ownerId: u.id, purpose: 'AVATAR', deletedAt: null },
      }))
    )
      throw new BadRequestException('头像不属于当前账号');
    await db.$transaction(async (tx) => {
      // Serialize mailbox changes with token creation and consumption.
      await lock(tx, `auth:${u.id}`);
      await tx.user.update({
        where: { id: u.id, version: u.version },
        data: {
          name: b.name,
          profile: json(b.profile),
          version: { increment: 1 },
          ...(b.avatarAttachmentId !== undefined
            ? { avatarAttachmentId: b.avatarAttachmentId }
            : {}),
          ...(changedEmail ? { email, verified: false } : {}),
        },
      });
      if (changedEmail)
        await tx.emailToken.updateMany({
          where: { userId: u.id, purpose: { in: ['VERIFY', 'RESET', 'CLOSE'] }, usedAt: null },
          data: { usedAt: new Date() },
        });
    });
    if (changedEmail) await mailToken(u.id, 'VERIFY');
    return publicUser(u.id);
  }
  async closureCode(req: AuthRequest) {
    const u = user(req);
    await rateLimit(`close-code:${u.id}`, 3);
    await mailToken(u.id, 'CLOSE');
    return { ok: true };
  }
  async verifyCode(req: AuthRequest, body: unknown, purpose = 'VERIFY') {
    const b = z
      .object({
        code: z.string().regex(/^\d{6}$/, '请输入六位验证码'),
        email: z.email().optional(),
        password: passwordSchema.optional(),
      })
      .parse(body);
    if (purpose === 'RESET' && !b.email) throw new BadRequestException('请填写邮箱');
    const u =
      purpose === 'RESET'
        ? await db.user.findFirst({ where: { email: b.email?.toLowerCase(), deactivatedAt: null } })
        : await db.user.findUnique({ where: { id: user(req).id } });
    if (!u || (purpose === 'RESET' && !b.email))
      throw new BadRequestException('验证码无效或已过期');
    await rateLimit(`email-code:${u.id}:${purpose}`, 10);
    const record = await db.emailToken.findFirst({
      where: { userId: u.id, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
    });
    if (!record?.codeHash) throw new BadRequestException('请重新发送验证码');
    const attempts = await redis.incr(`email-code-attempts:${record.id}`);
    if (attempts === 1) await redis.expire(`email-code-attempts:${record.id}`, 3600);
    if (
      attempts > 5 ||
      !same(record.codeHash, hmac(config.encryptionKey, `${record.id}:${b.code}`))
    )
      throw new BadRequestException('验证码无效或尝试次数过多，请重新发送');
    if (purpose === 'RESET' && !b.password) throw new BadRequestException('请填写新密码');
    const passwordHash =
      purpose === 'RESET' ? await hash(b.password!, { type: argon2id }) : undefined;
    await db.$transaction(async (tx) => {
      await lock(tx, `auth:${u.id}`);
      const fresh = await tx.emailToken.findUniqueOrThrow({ where: { id: record.id } });
      const account = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
      if (
        fresh.usedAt ||
        fresh.expiresAt <= new Date() ||
        account.deactivatedAt ||
        account.email !== u.email
      )
        throw new BadRequestException('验证码已失效');
      await tx.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      if (purpose === 'VERIFY')
        await tx.user.update({ where: { id: u.id }, data: { verified: true } });
      if (purpose === 'RESET') {
        await tx.user.update({ where: { id: u.id }, data: { passwordHash } });
        await tx.session.deleteMany({ where: { userId: u.id } });
      }
      await audit(tx, u.id, `${purpose}_CODE`, u.id);
    });
    return { ok: true };
  }
}
