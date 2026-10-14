import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Response } from 'express';
import type { Principal } from '@contest-center/contracts';
import { db, lock, audit, json, type Tx } from './db.js';
import { redis, session, user, rateLimit, type AuthRequest } from './auth.js';
import {
  requireSystemAdmin,
  encrypt,
  decrypt,
  checkVersion,
  opaqueToken,
  sha,
  same,
} from './security.js';
import { githubReturnPath } from './github.js';

const settingKey = 'feishu-login',
  stateCookie = 'cc_feishu_state';
const signupCookie = 'cc_feishu_signup';
type Settings = { enabled: boolean; appId: string; encryptedSecret: string; callbackUrl: string };
type Signup = { subject: string; name: string; email: string; fingerprint: string; next: string };
class FeishuError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
async function settings(database: Tx = db) {
  const row = await database.setting.findUnique({ where: { key: settingKey } });
  return {
    value: row
      ? (row.value as unknown as Settings)
      : {
          enabled: !!process.env.FEISHU_APP_ID && !!process.env.FEISHU_APP_SECRET,
          appId: process.env.FEISHU_APP_ID ?? '',
          encryptedSecret: process.env.FEISHU_APP_SECRET
            ? encrypt(process.env.FEISHU_APP_SECRET)
            : '',
          callbackUrl: process.env.FEISHU_CALLBACK_URL ?? '',
        },
    version: row?.version ?? 0,
  };
}
function fingerprint(value: Settings) {
  return sha(`${value.appId}:${decrypt(value.encryptedSecret)}`);
}
function callbackUrl(req: AuthRequest, configured: string) {
  let url: URL;
  try {
    url = new URL(configured || `${req.protocol}://${req.get('host')}/api/v1/auth/feishu/callback`);
  } catch {
    throw new BadRequestException('飞书回调地址无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new BadRequestException('飞书回调地址须为 HTTP / HTTPS 地址，不含参数或片段');
  return url.href;
}
async function feishuJson(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      ...options.headers,
    },
  });
  if (!response.ok) throw new FeishuError('failed');
  return response.json() as Promise<Record<string, unknown>>;
}
async function signup(req: AuthRequest, claim: unknown): Promise<Signup> {
  const token = z.string().min(30).max(100).parse(claim);
  if (!same(token, String(req.cookies?.[signupCookie] ?? '')))
    throw new BadRequestException('飞书注册验证已过期，请重新授权');
  const raw = await redis.get(`feishu-signup:${sha(token)}`),
    s = await settings();
  if (!raw || !s.value.enabled || !s.value.encryptedSecret)
    throw new BadRequestException('飞书注册验证已过期，请重新授权');
  const value = JSON.parse(raw) as Signup;
  if (value.fingerprint !== fingerprint(s.value))
    throw new BadRequestException('飞书配置已更新，请重新授权');
  return value;
}
export async function feishuSignup(req: AuthRequest, claim?: string) {
  return claim ? signup(req, claim) : undefined;
}
export async function attachFeishuSignup(tx: Tx, accountId: string, value: Signup) {
  await lock(tx, `feishu:${sha(value.subject)}`);
  const provider = await tx.oAuthProvider.upsert({
    where: { slug: 'feishu' },
    create: { slug: 'feishu', name: '飞书', mode: 'FEISHU', clientId: '', clientSecret: '' },
    update: {},
  });
  if (
    await tx.externalIdentity.findUnique({
      where: { providerId_subject: { providerId: provider.id, subject: value.subject } },
    })
  )
    throw new BadRequestException('此飞书账号已绑定，请使用飞书登录');
  await tx.externalIdentity.create({
    data: { providerId: provider.id, subject: value.subject, userId: accountId },
  });
  await audit(tx, accountId, 'FEISHU_REGISTER', accountId);
}
export async function clearFeishuSignup(res: Response, claim?: string) {
  if (claim) {
    await redis.del(`feishu-signup:${sha(claim)}`);
    res.clearCookie(signupCookie, { path: '/' });
  }
}
export class FeishuService {
  async view(u: Principal, req: AuthRequest) {
    requireSystemAdmin(u);
    const s = await settings();
    return {
      enabled: s.value.enabled,
      appId: s.value.appId,
      callbackUrl: s.value.callbackUrl,
      effectiveCallbackUrl: callbackUrl(req, s.value.callbackUrl),
      secretConfigured: !!s.value.encryptedSecret,
      version: s.version,
    };
  }
  async save(u: Principal, req: AuthRequest, body: unknown) {
    requireSystemAdmin(u);
    const b = z
      .object({
        version: z.number().int().min(0),
        enabled: z.boolean(),
        appId: z.string().trim().max(200),
        appSecret: z.string().max(2048).optional(),
        callbackUrl: z.string().trim().max(2048).default(''),
      })
      .parse(body);
    if (b.callbackUrl) callbackUrl(req, b.callbackUrl);
    await db.$transaction(async (tx) => {
      await lock(tx, `setting:${settingKey}`);
      const previous = await settings(tx);
      checkVersion(previous.version, b.version);
      const encryptedSecret = b.appSecret
        ? encrypt(b.appSecret)
        : b.appId === previous.value.appId
          ? previous.value.encryptedSecret
          : '';
      if (b.enabled && (!b.appId || !encryptedSecret))
        throw new BadRequestException(
          '请填写飞书 App ID 和 App Secret；更换 App ID 后需重新填写密钥',
        );
      const value = {
        enabled: b.enabled,
        appId: b.appId,
        callbackUrl: b.callbackUrl,
        encryptedSecret,
      };
      await tx.setting.upsert({
        where: { key: settingKey },
        create: { key: settingKey, value: json(value) },
        update: { value: json(value), version: { increment: 1 } },
      });
      await audit(tx, u.id, 'FEISHU_SETTINGS_UPDATE', settingKey, { enabled: b.enabled });
    });
    return this.view(u, req);
  }
  async provider(req: AuthRequest) {
    const s = await settings(),
      provider = await db.oAuthProvider.findUnique({ where: { slug: 'feishu' } });
    const linked =
      req.principal && provider
        ? !!(await db.externalIdentity.findFirst({
            where: {
              providerId: provider.id,
              userId: req.principal.id,
              subject: { startsWith: `${s.value.appId}:` },
            },
          }))
        : false;
    return {
      enabled: s.value.enabled && !!s.value.appId && !!s.value.encryptedSecret,
      linked: !!linked,
    };
  }
  async signupView(req: AuthRequest) {
    const value = await signup(req, req.query.claim);
    return { name: value.name, email: value.email };
  }
  async start(req: AuthRequest, res: Response) {
    await rateLimit(`feishu-login:${req.ip}`, 20);
    const s = await settings();
    if (!s.value.enabled || !s.value.appId || !s.value.encryptedSecret)
      throw new BadRequestException('飞书登录尚未配置');
    const linking = req.query.mode === 'link';
    if (linking && !user(req).verified) throw new BadRequestException('请先验证本站邮箱再绑定飞书');
    const state = opaqueToken(),
      verifier = opaqueToken();
    const record = {
      redirectUri: callbackUrl(req, s.value.callbackUrl),
      verifier,
      fingerprint: fingerprint(s.value),
      next: githubReturnPath(req.query.next),
      userId: linking ? user(req).id : null,
    };
    await redis.set(`feishu-state:${sha(state)}`, JSON.stringify(record), 'EX', 600);
    res.cookie(stateCookie, state, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      maxAge: 600000,
      path: '/api/v1/auth/feishu',
    });
    const url = new URL(
      '/open-apis/authen/v1/authorize',
      process.env.FEISHU_ACCOUNTS_BASE_URL ?? 'https://accounts.feishu.cn',
    );
    for (const [key, value] of Object.entries({
      client_id: s.value.appId,
      response_type: 'code',
      redirect_uri: record.redirectUri,
      scope: 'contact:user.email:readonly',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    res.redirect(url.href);
  }
  async callback(req: AuthRequest, res: Response) {
    res.clearCookie(stateCookie, { path: '/api/v1/auth/feishu' });
    try {
      const state = z.string().min(30).max(100).parse(req.query.state);
      if (!same(state, String(req.cookies?.[stateCookie] ?? ''))) throw new FeishuError('state');
      const raw = await redis.getdel(`feishu-state:${sha(state)}`);
      if (!raw) throw new FeishuError('state');
      const record = JSON.parse(raw) as {
        redirectUri: string;
        verifier: string;
        fingerprint: string;
        next: string;
        userId: string | null;
      };
      const s = await settings();
      if (
        !s.value.enabled ||
        !s.value.encryptedSecret ||
        record.fingerprint !== fingerprint(s.value)
      )
        throw new FeishuError('state');
      if (req.query.error) throw new FeishuError('cancelled');
      if (record.userId && record.userId !== req.principal?.id) throw new FeishuError('state');
      const code = z.string().min(1).max(1000).parse(req.query.code);
      const token = await feishuJson(
        new URL(
          '/oauth/v3/token',
          process.env.FEISHU_ACCOUNTS_BASE_URL ?? 'https://accounts.feishu.cn',
        ).href,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: s.value.appId,
            client_secret: decrypt(s.value.encryptedSecret),
            code,
            redirect_uri: record.redirectUri,
            code_verifier: record.verifier,
          }),
        },
      );
      if (
        (token.code !== undefined && token.code !== 0) ||
        typeof token.access_token !== 'string' ||
        !token.access_token
      )
        throw new FeishuError('failed');
      const response = z
        .object({
          code: z.literal(0),
          data: z.object({
            open_id: z.string().min(1).max(300),
            name: z.string().min(1).max(100),
            email: z.string().optional(),
            enterprise_email: z.string().optional(),
          }),
        })
        .parse(
          await feishuJson(
            new URL(
              '/open-apis/authen/v1/user_info',
              process.env.FEISHU_API_BASE_URL ?? 'https://open.feishu.cn',
            ).href,
            { headers: { Authorization: `Bearer ${token.access_token}` } },
          ),
        );
      const subject = `${s.value.appId}:${response.data.open_id}`;
      const accountId = await db.$transaction(async (tx) => {
        await lock(tx, `feishu:${sha(subject)}`);
        const provider = await tx.oAuthProvider.upsert({
          where: { slug: 'feishu' },
          create: { slug: 'feishu', name: '飞书', mode: 'FEISHU', clientId: '', clientSecret: '' },
          update: {},
        });
        const existing = await tx.externalIdentity.findUnique({
          where: { providerId_subject: { providerId: provider.id, subject } },
        });
        if (existing) {
          if (record.userId && record.userId !== existing.userId) throw new FeishuError('bound');
          return existing.userId;
        }
        if (!record.userId) return null;
        await lock(tx, `auth:${record.userId}`);
        const target = await tx.user.findUniqueOrThrow({ where: { id: record.userId } });
        if (target.deactivatedAt || target.bannedAt || !target.verified)
          throw new FeishuError('state');
        if (
          await tx.externalIdentity.findFirst({
            where: {
              userId: record.userId,
              providerId: provider.id,
              subject: { startsWith: `${s.value.appId}:` },
            },
          })
        )
          throw new FeishuError('bound');
        await tx.externalIdentity.create({
          data: { providerId: provider.id, subject, userId: record.userId },
        });
        await audit(tx, record.userId, 'FEISHU_LINK', record.userId);
        return record.userId;
      });
      if (!accountId) {
        const claim = opaqueToken(),
          email = z.email().safeParse(response.data.email || response.data.enterprise_email);
        await redis.set(
          `feishu-signup:${sha(claim)}`,
          JSON.stringify({
            subject,
            name: response.data.name,
            email: email.success ? email.data : '',
            fingerprint: record.fingerprint,
            next: record.next,
          }),
          'EX',
          600,
        );
        res.cookie(signupCookie, claim, {
          httpOnly: true,
          secure: req.secure,
          sameSite: 'lax',
          maxAge: 600000,
          path: '/',
        });
        res.redirect(
          `/account?${new URLSearchParams({ mode: 'register', feishu_claim: claim, next: record.next })}`,
        );
        return;
      }
      const authenticated = await session(req, res, accountId);
      res.redirect(
        record.userId
          ? '/me/profile?tab=settings'
          : authenticated.user.profileComplete
            ? record.next
            : `/account?next=${encodeURIComponent(record.next)}`,
      );
    } catch (e) {
      res.redirect(`/login?feishu_error=${e instanceof FeishuError ? e.code : 'failed'}`);
    }
  }
  async unlink(req: AuthRequest) {
    const u = user(req),
      provider = await db.oAuthProvider.findUnique({ where: { slug: 'feishu' } });
    if (!provider) return { ok: true };
    await db.$transaction(async (tx) => {
      await lock(tx, `auth:${u.id}`);
      const target = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
      if (
        !target.passwordHash &&
        !(await tx.externalIdentity.count({
          where: { userId: u.id, providerId: { not: provider.id } },
        }))
      )
        throw new BadRequestException('请先设置密码或绑定另一登录方式');
      if (target.deactivatedAt || target.bannedAt) throw new ForbiddenException();
      await tx.externalIdentity.deleteMany({ where: { userId: u.id, providerId: provider.id } });
      await audit(tx, u.id, 'FEISHU_UNLINK', u.id);
    });
    return { ok: true };
  }
}
