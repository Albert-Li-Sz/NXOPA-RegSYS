import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { hash, verify, argon2id } from 'argon2';
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
import { opaqueToken, sha, hmac, same } from './security.js';

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
    isAdmin: u.isAdmin,
    isCoach: u.isCoach,
    hasPassword: !!u.passwordHash,
    profileComplete: profileComplete(u),
    profile: u.profile as Principal['profile'],
    version: u.version,
    contestIds: u.roles.map((r) => r.contestId),
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
  await db.$transaction(async (tx) => {
    await lock(tx, `auth:${id}`);
    const u = await tx.user.findUniqueOrThrow({ where: { id } });
    await tx.emailToken.create({
      data: { id: sha(raw), userId: id, purpose, expiresAt: new Date(Date.now() + 3600000) },
    });
    await event(tx, 'MAIL', id, {
      to: u.email,
      subject: purpose === 'VERIFY' ? '验证您的邮箱' : '重置登录密码',
      text: `${u.name}，请在一小时内打开以下链接。\n如果您未发起此操作，请忽略此邮件。`,
      actionPath: `/account/${purpose === 'VERIFY' ? 'verify' : 'reset'}?${new URLSearchParams({ token: raw, ...(next ? { next } : {}) })}`,
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
        next: invitationReturnPathSchema.optional(),
      })
      .parse(body);
    const u = await db.user.create({
      data: {
        name: b.name,
        username: b.username,
        email: b.email.toLowerCase(),
        passwordHash: await hash(b.password, { type: argon2id }),
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
    if (!u?.passwordHash || !(await verify(u.passwordHash, b.password)))
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
    if (u) await mailToken(u.id, 'RESET');
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
      })
      .parse(body);
    if (b.version !== u.version) throw new BadRequestException('资料已更新，请刷新');
    if (b.isCoach !== undefined && b.isCoach !== u.isCoach)
      throw new ForbiddenException('身份变更须由管理员生成邀请链接并确认');
    const email = b.email?.toLowerCase();
    const changedEmail = email && email !== u.email;
    await db.$transaction(async (tx) => {
      // Serialize mailbox changes with token creation and consumption.
      await lock(tx, `auth:${u.id}`);
      await tx.user.update({
        where: { id: u.id, version: u.version },
        data: {
          name: b.name,
          profile: json(b.profile),
          version: { increment: 1 },
          ...(changedEmail ? { email, verified: false } : {}),
        },
      });
      if (changedEmail)
        await tx.emailToken.updateMany({
          where: { userId: u.id, purpose: { in: ['VERIFY', 'RESET'] }, usedAt: null },
          data: { usedAt: new Date() },
        });
    });
    if (changedEmail) await mailToken(u.id, 'VERIFY');
    return publicUser(u.id);
  }
}
