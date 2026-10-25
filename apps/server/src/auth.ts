import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { hash, verify, argon2id } from 'argon2';
import { randomInt } from 'node:crypto';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  invitationReturnPathSchema,
  answersSchema,
  profileComplete,
  enrollmentYearSchema,
  normalizeEnrollmentYear,
  normalizeProfileYears,
  type Principal,
} from '@contest-center/contracts';
import { db, audit, event, json, lock, type Tx } from './db.js';
import { config } from './config.js';
import {
  publicLink,
  siteSettings,
  environmentTrustedOrigins,
  secureCookies,
} from './site-settings.js';
import { opaqueToken, sha, hmac, same, encrypt, secretKey, otpHash, checkOtp } from './security.js';
import { effectiveAuthorization, revokeRecipientInvitations } from './authorization.js';
import { feishuSignup, attachFeishuSignup, clearFeishuSignup } from './feishu.js';
import { paginated, type ListQuery } from './pagination.js';
import { syncRegistrationEmail } from './profile-data.js';
import { validateInstitution } from './institutions.js';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
export async function incrementExpiring(key: string, seconds: number) {
  return Number(
    await redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if redis.call('TTL',KEYS[1])<0 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      1,
      key,
      seconds,
    ),
  );
}
export function cookieName(name: string, secure: boolean) {
  return secure ? `__Host-${name}` : name;
}
export async function cookieValue(req: AuthRequest, name: string) {
  // HTTPS ignores legacy names completely. HTTP and HTTPS sessions may coexist.
  const selected = cookieName(name, await secureCookies(req));
  const counts = new Map<string, number>();
  for (const item of String(req.headers.cookie ?? '').split(';')) {
    const key = item.trim().split('=')[0]!;
    if (key === selected) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if ([...counts.values()].some((n) => n > 1))
    throw new UnauthorizedException('Cookie 冲突，请清除站点 Cookie 后重新登录');
  return req.cookies?.[selected];
}
const requestDetails = (req?: AuthRequest) => ({
  ip: req?.ip ?? '',
  userAgent: String(req?.headers['user-agent'] ?? '').slice(0, 300),
});
export async function requireReauthentication(req: AuthRequest, database: Tx = db) {
  const u = user(req);
  const s = req.sessionId
    ? await database.session.findUnique({ where: { id: req.sessionId } })
    : null;
  if (
    !s ||
    s.userId !== u.id ||
    s.expiresAt <= new Date() ||
    !s.reauthenticatedAt ||
    s.reauthenticatedAt.getTime() < Date.now() - 5 * 60000
  )
    throw new ForbiddenException('请先在账号设置中验证当前密码或原邮箱验证码');
}
const missingAccountHash = hash(opaqueToken(), { type: argon2id });
export type AuthRequest = Request & {
  principal?: Principal;
  sessionId?: string;
};
export function user(req: AuthRequest) {
  if (!req.principal) throw new UnauthorizedException('请先登录');
  return req.principal;
}
export async function rateLimit(key: string, max = 20) {
  const n = await incrementExpiring(`rate:${key}`, 60);
  if (n > max) throw new HttpException('请求过于频繁，请稍后重试', 429);
}
export const passwordSchema = z.string().min(10, '密码至少 10 位').max(128);
export const publicUser = async (id: string, database: Tx = db): Promise<Principal> => {
  const u = await database.user.findUniqueOrThrow({ where: { id }, include: { roles: true } });
  return {
    id: u.id,
    email: u.email,
    pendingEmail: u.pendingEmail,
    username: u.username,
    name: u.name,
    verified: u.verified,
    ...(await effectiveAuthorization(id, database)),
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
          await database.user.findMany({
            where: { personId: u.personId, OR: [{ id: u.id }, { deactivatedAt: { not: null } }] },
            select: { id: true },
          })
        ).map((x) => x.id)
      : [u.id],
  };
};
export async function attachPrincipal(req: AuthRequest) {
  const token = await cookieValue(req, 'cc_session');
  if (!token) return;
  const id = sha(String(token));
  const s = await db.session.findUnique({
    where: { id },
    include: { user: { select: { deactivatedAt: true, bannedAt: true } } },
  });
  if (s && s.expiresAt > new Date()) {
    if (s.user.deactivatedAt || s.user.bannedAt) return;
    req.sessionId = id;
    req.principal = await publicUser(s.userId);
  }
}
export async function checkCsrf(req: AuthRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  // Browsers send Origin / Fetch Metadata even before a session exists.
  // Keep non-browser API clients working while rejecting cross-site login forms.
  const origin = req.headers.origin;
  const origins = new Set([
    new URL(config.publicUrl).origin,
    `${req.protocol}://${req.get('host')}`,
    ...environmentTrustedOrigins(),
    ...(!config.production ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
  ]);
  if (origin && !origins.has(origin)) {
    const site = await siteSettings();
    origins.add(new URL(site.publicUrl).origin);
    for (const value of site.trustedOrigins) origins.add(value);
  }
  if (
    (origin !== undefined && !origins.has(origin)) ||
    (!origin && req.headers['sec-fetch-site'] === 'cross-site')
  )
    throw new ForbiddenException('请求来源不受信任');
  if (
    req.sessionId &&
    !same(String(req.headers['x-csrf-token'] ?? ''), hmac(secretKey('csrf:v2'), req.sessionId))
  )
    throw new ForbiddenException('CSRF 校验失败，请刷新页面');
}
export function csrf(req: AuthRequest) {
  return req.sessionId ? hmac(secretKey('csrf:v2'), req.sessionId) : '';
}
export async function session(req: AuthRequest, res: Response, id: string) {
  const token = opaqueToken();
  const principal = await db.$transaction(async (tx) => {
    await lock(tx, `auth:${id}`);
    const current = await tx.user.findUniqueOrThrow({ where: { id } });
    if (current.deactivatedAt || current.bannedAt) throw new ForbiddenException('账号已停用或封禁');
    await tx.session.create({
      data: {
        id: sha(token),
        userId: id,
        expiresAt: new Date(Date.now() + 7 * 86400000),
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      },
    });
    return publicUser(id, tx);
  });
  const secure = await secureCookies(req);
  res.clearCookie(secure ? 'cc_session' : '__Host-cc_session', { path: '/' });
  res.cookie(cookieName('cc_session', secure), token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 7 * 86400000,
    path: '/',
  });
  return { user: principal, csrf: hmac(secretKey('csrf:v2'), sha(token)) };
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
        codeHash: otpHash(`${sha(raw)}:${code}`),
        expiresAt: new Date(
          Date.now() + (['CLOSE', 'REAUTH'].includes(purpose) ? 600000 : 3600000),
        ),
      },
    });
    await event(tx, 'MAIL', id, {
      to: purpose === 'EMAIL_CHANGE' ? u.pendingEmail! : u.email,
      subject: ['VERIFY', 'EMAIL_CHANGE'].includes(purpose)
        ? '验证您的邮箱'
        : purpose === 'REAUTH'
          ? '敏感操作身份验证码'
          : purpose === 'CLOSE'
            ? '注销账号验证码'
            : '重置登录密码',
      category: ['VERIFY', 'EMAIL_CHANGE'].includes(purpose)
        ? 'AUTH_VERIFY'
        : purpose === 'CLOSE'
          ? 'ACCOUNT_CLOSE'
          : 'AUTH_RESET',
      encryptedCode: encrypt(code),
      verificationTokenId: sha(raw),
      name: u.name,
      text: `${u.name}，${purpose === 'CLOSE' ? '注销验证码在 10 分钟内有效' : '验证码及链接在一小时内有效'}。\n如果您未发起此操作，请忽略此邮件。`,
      ...(['CLOSE', 'REAUTH'].includes(purpose)
        ? {}
        : {
            actionPath: `/account/${['VERIFY', 'EMAIL_CHANGE'].includes(purpose) ? 'verify' : 'reset'}?${new URLSearchParams({ token: raw, ...(next ? { next } : {}) })}`,
          }),
    });
  });
}
export class AuthService {
  async reauthenticationCode(req: AuthRequest) {
    const u = user(req);
    await rateLimit(`reauth-code:${u.id}`, 3);
    if (!u.verified) throw new BadRequestException('请先验证当前邮箱');
    await mailToken(u.id, 'REAUTH');
    return { ok: true };
  }
  async reauthenticate(req: AuthRequest, body: unknown) {
    const u = user(req);
    await rateLimit(`reauth:${u.id}`, 5);
    const b = z
      .object({
        password: z.string().max(128).optional(),
        code: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      })
      .parse(body);
    if (b.code) await this.verifyCode(req, { code: b.code }, 'REAUTH');
    else {
      const account = await db.user.findUniqueOrThrow({ where: { id: u.id } });
      if (!b.password || !account.passwordHash || !(await verify(account.passwordHash, b.password)))
        throw new ForbiddenException('当前密码错误');
    }
    await db.$transaction(async (tx) => {
      await lock(tx, `auth:${u.id}`);
      const account = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
      if (account.bannedAt || account.deactivatedAt) throw new UnauthorizedException();
      await tx.session.update({
        where: { id: req.sessionId!, userId: u.id },
        data: { reauthenticatedAt: new Date() },
      });
      await audit(tx, u.id, 'REAUTHENTICATE', u.id, requestDetails(req));
    });
    return { ok: true };
  }
  async registrationCode(body: unknown, req: AuthRequest) {
    const b = z
      .object({ email: z.email(), next: invitationReturnPathSchema.optional() })
      .parse(body);
    const email = b.email.toLowerCase();
    await rateLimit(`register-code:${req.ip}`, 10);
    await rateLimit(`register-code-email:${sha(email)}`, 3);
    const token = opaqueToken(),
      id = sha(token);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db.$transaction(async (tx) => {
      await lock(tx, `register:${email}`);
      if (await tx.user.findUnique({ where: { email } })) return;
      await tx.registrationVerification.updateMany({
        where: { email, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.registrationVerification.create({
        data: {
          id,
          email,
          codeHash: otpHash(`${id}:${code}`),
          expiresAt: new Date(Date.now() + 600000),
        },
      });
      await event(tx, 'MAIL', id, {
        to: email,
        subject: '注册邮箱验证码',
        category: 'AUTH_VERIFY',
        encryptedCode: encrypt(code),
        registrationTokenId: id,
        text: '请在注册页面填写六位验证码，完成邮箱验证后创建账号。验证码在 10 分钟内有效。',
      });
    });
    return { token, expiresIn: 600 };
  }
  async register(body: unknown, req: AuthRequest, res: Response) {
    await rateLimit(`register:${req.ip}`, 10);
    const b = z
      .object({
        email: z.email(),
        username: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/),
        name: z.string().trim().min(1).max(100),
        password: passwordSchema,
        token: z.string().min(30).max(100),
        code: z.string().regex(/^\d{6}$/, '请输入邮箱中的六位验证码'),
        kind: z.enum(['STUDENT', 'TEACHER']).default('STUDENT'),
        identifier: z.string().trim().min(1).max(100).optional(),
        enrollmentYear: enrollmentYearSchema.optional(),
        employedAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        next: invitationReturnPathSchema.optional(),
        feishuClaim: z.string().min(30).max(100).optional(),
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
      throw new BadRequestException('学生需填写学号和入学年份，教师需填写职工号和有效入职日期');
    const email = b.email.toLowerCase(),
      tokenId = sha(b.token);
    const feishu = await feishuSignup(req, b.feishuClaim);
    const attempts = await incrementExpiring(`register-code-attempts:${tokenId}`, 600);
    if (attempts > 5) throw new BadRequestException('验证码尝试次数过多，请重新发送');
    const u = await db.$transaction(async (tx) => {
      await lock(tx, `register:${email}`);
      const verification = await tx.registrationVerification.findUnique({ where: { id: tokenId } });
      if (
        !verification ||
        verification.email !== email ||
        verification.usedAt ||
        verification.expiresAt <= new Date() ||
        !checkOtp(verification.codeHash, `${tokenId}:${b.code}`)
      )
        throw new BadRequestException('邮箱验证码无效或已过期，请重新发送');
      const passwordHash = await hash(b.password, { type: argon2id });
      const account = await tx.user.create({
        data: {
          name: b.name,
          username: b.username,
          email,
          passwordHash,
          verified: true,
          kind: b.kind,
          isCoach: b.kind === 'TEACHER',
          profile: json(
            b.kind === 'TEACHER'
              ? { employee_id: b.identifier, employed_at: b.employedAt }
              : {
                  student_id: b.identifier,
                  enrollment_year: normalizeEnrollmentYear(b.enrollmentYear),
                },
          ),
        },
      });
      await tx.registrationVerification.update({
        where: { id: tokenId },
        data: { usedAt: new Date() },
      });
      await tx.invitation.updateMany({
        where: { targetUserId: null, targetEmail: email, acceptedBy: null, revoked: false },
        data: { targetUserId: account.id },
      });
      await audit(tx, account.id, 'ACCOUNT_REGISTER', account.id);
      if (feishu) await attachFeishuSignup(tx, account.id, feishu);
      return account;
    });
    await clearFeishuSignup(res, b.feishuClaim);
    return session(req, res, u.id);
  }
  async login(body: unknown, req: AuthRequest, res: Response) {
    await rateLimit(`login:${req.ip}`, 12);
    const b = z
      .object({ account: z.string().min(1).max(254), password: z.string().max(128) })
      .parse(body);
    const failureKey = `login-failures:${sha(b.account.trim().toLowerCase())}`;
    if (Number(await redis.get(failureKey)) >= 10)
      throw new ForbiddenException('此账号登录失败次数过多，请稍后重试或找回密码');
    const u = await db.user.findFirst({
      where: { OR: [{ email: b.account.toLowerCase() }, { username: b.account }] },
    });
    const validPassword = await verify(u?.passwordHash ?? (await missingAccountHash), b.password);
    if (!u?.passwordHash || u.deactivatedAt || !validPassword) {
      await incrementExpiring(failureKey, 900);
      await audit(
        db,
        u?.id ?? 'anonymous',
        'LOGIN_FAILURE',
        u?.id ?? sha(b.account.toLowerCase()),
        requestDetails(req),
      );
      throw new UnauthorizedException('账号或密码错误');
    }
    if (u.bannedAt) throw new ForbiddenException('账号已被封禁，请联系管理员');
    await redis.del(failureKey);
    await audit(db, u.id, 'LOGIN_SUCCESS', u.id, requestDetails(req));
    return session(req, res, u.id);
  }
  async logout(req: AuthRequest, res: Response) {
    if (req.principal)
      await audit(db, req.principal.id, 'LOGOUT', req.principal.id, requestDetails(req));
    if (req.sessionId) await db.session.deleteMany({ where: { id: req.sessionId } });
    res.clearCookie('cc_session', { path: '/' });
    res.clearCookie('__Host-cc_session', { path: '/', secure: true });
    return { ok: true };
  }
  async sessions(req: AuthRequest, query: ListQuery = {}) {
    const where = { userId: user(req).id, expiresAt: { gt: new Date() } };
    return paginated(
      query,
      (options) =>
        db.session.findMany({
          where,
          select: { id: true, createdAt: true, expiresAt: true, userAgent: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...options,
        }),
      () => db.session.count({ where }),
      20,
    );
  }
  async revoke(req: AuthRequest, id: string) {
    await db.session.deleteMany({ where: { id, userId: user(req).id } });
    await audit(db, user(req).id, 'SESSION_REVOKE', id, requestDetails(req));
    return { ok: true };
  }
  async resend(req: AuthRequest, body: unknown = {}) {
    const u = user(req);
    const b = z.object({ next: invitationReturnPathSchema.optional() }).parse(body ?? {});
    await rateLimit(`verify:${u.id}`, 3);
    const account = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    if (account.pendingEmail) await mailToken(u.id, 'EMAIL_CHANGE', b.next);
    else if (!u.verified) await mailToken(u.id, 'VERIFY', b.next);
    return { ok: true };
  }
  async forgot(body: unknown, req: AuthRequest) {
    await rateLimit(`forgot:${req.ip}`, 5);
    const { email } = z.object({ email: z.email() }).parse(body);
    await rateLimit(`forgot-email:${sha(email.toLowerCase())}`, 3);
    const u = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (u?.verified && !u.deactivatedAt && !u.bannedAt) await mailToken(u.id, 'RESET');
    return { ok: true };
  }
  async consume(body: unknown, purpose: string, req?: AuthRequest) {
    await rateLimit(`consume-${purpose}:${req?.ip ?? 'internal'}`, 5);
    const b = z
      .object({
        token: z.string().min(30).max(100),
        password: purpose === 'RESET' ? passwordSchema : z.string().optional(),
      })
      .parse(body);
    return db.$transaction(async (tx) => {
      const record = await tx.emailToken.findUnique({ where: { id: sha(b.token) } });
      if (!record) throw new BadRequestException('链接已失效');
      await lock(tx, `auth:${record.userId}`);
      const t = await tx.emailToken.findUnique({ where: { id: sha(b.token) } });
      if (
        !t ||
        !(t.purpose === purpose || (purpose === 'VERIFY' && t.purpose === 'EMAIL_CHANGE')) ||
        t.usedAt ||
        t.expiresAt < new Date()
      )
        throw new BadRequestException('链接已失效');
      const account = await tx.user.findUniqueOrThrow({ where: { id: t.userId } });
      if (account.deactivatedAt || account.bannedAt) throw new BadRequestException('链接已失效');
      if (purpose === 'RESET' && !account.verified) throw new BadRequestException('链接已失效');
      const pw = purpose === 'RESET' ? await hash(b.password!, { type: argon2id }) : undefined;
      const changed = await tx.emailToken.updateMany({
        where: { id: t.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (!changed.count) throw new BadRequestException('链接已使用');
      if (t.purpose === 'EMAIL_CHANGE') await this.completeEmailChange(tx, t.userId, req);
      else
        await tx.user.update({
          where: { id: t.userId },
          data: purpose === 'RESET' ? { passwordHash: pw, pendingEmail: null } : { verified: true },
        });
      if (purpose === 'RESET') {
        await tx.session.deleteMany({ where: { userId: t.userId } });
        await tx.emailToken.updateMany({
          where: { userId: t.userId, usedAt: null },
          data: { usedAt: new Date() },
        });
      }
      await audit(tx, t.userId, purpose, t.userId, requestDetails(req));
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
        profile: answersSchema,
        email: z.email().optional(),
        avatarAttachmentId: z.string().uuid().nullable().optional(),
      })
      .parse(body);
    if (b.profile.display_name !== undefined)
      b.profile.display_name = z.string().trim().max(100).parse(b.profile.display_name);
    if (b.profile.gender !== undefined)
      z.enum(['男', '女'], '请选择男或女').parse(b.profile.gender);
    b.profile = normalizeProfileYears(b.profile, true);
    // Login email is a verified account property, never an independently editable profile answer.
    delete b.profile.email;
    if (b.version !== u.version) throw new BadRequestException('资料已更新，请刷新');
    if (b.isCoach !== undefined && b.isCoach !== u.isCoach)
      throw new ForbiddenException('身份变更须由管理员生成邀请链接并确认');
    const email = b.email?.toLowerCase();
    const changedEmail = email && email !== u.email;
    if (changedEmail) await requireReauthentication(req);
    const current = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    if (['VERIFIED', 'RECORDED', 'PENDING', 'REJECTED'].includes(current.identityStatus)) {
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
      if (changedEmail) await requireReauthentication(req, tx);
      await validateInstitution(
        tx,
        b.profile.school,
        (current.profile as Record<string, unknown>).school,
      );
      await tx.user.update({
        where: { id: u.id, version: u.version },
        data: {
          name: b.name,
          profile: json(b.profile),
          ...(current.identityStatus === 'UNSUBMITTED' &&
          profileComplete({ kind: current.kind, name: b.name, profile: b.profile })
            ? { identityStatus: 'RECORDED' }
            : {}),
          version: { increment: 1 },
          ...(b.avatarAttachmentId !== undefined
            ? { avatarAttachmentId: b.avatarAttachmentId }
            : {}),
          ...(changedEmail ? { pendingEmail: email } : {}),
        },
      });
      if (changedEmail)
        await tx.emailToken.updateMany({
          where: {
            userId: u.id,
            purpose: { in: ['VERIFY', 'RESET', 'CLOSE', 'EMAIL_CHANGE'] },
            usedAt: null,
          },
          data: { usedAt: new Date() },
        });
    });
    if (changedEmail) {
      await audit(db, u.id, 'EMAIL_CHANGE_REQUEST', u.id, {
        oldEmailHash: sha(u.email),
        newEmailHash: sha(email),
        ...requestDetails(req),
      });
      await mailToken(u.id, 'EMAIL_CHANGE');
    }
    return publicUser(u.id);
  }
  async closureCode(req: AuthRequest) {
    const u = user(req);
    await rateLimit(`close-code:${u.id}`, 3);
    await mailToken(u.id, 'CLOSE');
    return { ok: true };
  }
  async verifyCode(req: AuthRequest, body: unknown, purpose = 'VERIFY') {
    const started = Date.now();
    try {
      if (purpose === 'RESET') await rateLimit(`email-code-ip:${req.ip}`, 10);
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
          ? await db.user.findFirst({
              where: { email: b.email?.toLowerCase(), deactivatedAt: null },
            })
          : await db.user.findUnique({ where: { id: user(req).id } });
      if (!u || (purpose === 'RESET' && (!b.email || !u.verified)))
        throw new BadRequestException('验证码无效或已过期');
      await rateLimit(`email-code:${u.id}:${purpose}`, 10);
      const record = await db.emailToken.findFirst({
        where: {
          userId: u.id,
          purpose: purpose === 'VERIFY' ? { in: ['VERIFY', 'EMAIL_CHANGE'] } : purpose,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { expiresAt: 'desc' },
      });
      if (!record?.codeHash) throw new BadRequestException('验证码无效或已过期');
      const attempts = await incrementExpiring(`email-code-attempts:${record.id}`, 3600);
      if (attempts > 5 || !checkOtp(record.codeHash, `${record.id}:${b.code}`))
        throw new BadRequestException('验证码无效或已过期');
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
          account.bannedAt ||
          account.email !== u.email
        )
          throw new BadRequestException('验证码无效或已过期');
        await tx.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
        if (record.purpose === 'EMAIL_CHANGE') await this.completeEmailChange(tx, u.id, req);
        else if (purpose === 'VERIFY')
          await tx.user.update({ where: { id: u.id }, data: { verified: true } });
        if (purpose === 'RESET') {
          if (!account.verified) throw new BadRequestException('验证码无效或已过期');
          await tx.user.update({ where: { id: u.id }, data: { passwordHash, pendingEmail: null } });
          await tx.session.deleteMany({ where: { userId: u.id } });
          await tx.emailToken.updateMany({
            where: { userId: u.id, usedAt: null },
            data: { usedAt: new Date() },
          });
        }
        await audit(tx, u.id, `${purpose}_CODE`, u.id, requestDetails(req));
      });
      return { ok: true };
    } finally {
      if (purpose === 'RESET')
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, 150 - (Date.now() - started))),
        );
    }
  }
  private async completeEmailChange(tx: Tx, id: string, req?: AuthRequest) {
    const account = await tx.user.findUniqueOrThrow({ where: { id } });
    if (!account.pendingEmail) throw new BadRequestException('邮箱变更已失效');
    await revokeRecipientInvitations(tx, id);
    await tx.user.update({
      where: { id },
      data: {
        email: account.pendingEmail,
        pendingEmail: null,
        verified: true,
        version: { increment: 1 },
      },
    });
    await syncRegistrationEmail(tx, id, account.pendingEmail);
    await tx.session.deleteMany({
      where: { userId: id, ...(req?.sessionId ? { id: { not: req.sessionId } } : {}) },
    });
    await tx.emailToken.updateMany({
      where: { userId: id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await event(tx, 'MAIL', id, {
      to: account.email,
      subject: '登录邮箱已变更',
      text: '您的登录邮箱已完成变更。如非本人操作，请立即联系系统管理员。',
      category: 'AUTH_VERIFY',
    });
    await audit(tx, id, 'EMAIL_CHANGE', id, {
      oldEmailHash: sha(account.email),
      newEmailHash: sha(account.pendingEmail),
      ...requestDetails(req),
    });
  }
}
