import { secureCookies, publicUrl } from './site-settings.js';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Response } from 'express';
import type { Principal } from '@contest-center/contracts';
import { db, lock, audit, json, type Tx } from './db.js';
import {
  requireSystemAdmin,
  encrypt,
  decrypt,
  checkVersion,
  opaqueToken,
  sha,
  same,
} from './security.js';
import { redis, session, user, type AuthRequest } from './auth.js';

// GitHub's web OAuth flow and Auth.js's GitHub provider are the protocol references.
// Tokens are used only to fetch /user and verified /user/emails; never persisted.
const settingKey = 'github-login';
const stateCookie = 'cc_github_state';
type Settings = {
  enabled: boolean;
  clientId: string;
  encryptedSecret: string;
  callbackUrl: string;
};
class GithubError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
async function settings(database: Tx = db) {
  const row = await database.setting.findUnique({ where: { key: settingKey } });
  const environment: Settings = {
    enabled: !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET,
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    encryptedSecret: process.env.GITHUB_CLIENT_SECRET
      ? encrypt(process.env.GITHUB_CLIENT_SECRET)
      : '',
    callbackUrl: process.env.GITHUB_CALLBACK_URL ?? '',
  };
  return {
    value: row ? (row.value as unknown as Settings) : environment,
    version: row?.version ?? 0,
  };
}
async function callbackUrl(req: AuthRequest, value: string) {
  const url = new URL(value || '/api/v1/auth/github/callback', await publicUrl());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new BadRequestException('GitHub 回调地址须为 HTTP / HTTPS 地址');
  return url.href;
}
export function githubReturnPath(value: unknown) {
  return typeof value === 'string' && value.length <= 2000 && /^\/(?!\/)[^\\\r\n]*$/.test(value)
    ? value
    : '/contests';
}
function fingerprint(value: Settings) {
  return sha(value.clientId + ':' + (value.encryptedSecret ? decrypt(value.encryptedSecret) : ''));
}
async function githubJson(url: string, options: RequestInit) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', 'User-Agent': 'NXOPA-RegSYS', ...options.headers },
  });
  if (!response.ok) throw new GithubError('failed');
  return response.json();
}
export class GithubService {
  async view(u: Principal, req: AuthRequest) {
    requireSystemAdmin(u);
    const s = await settings();
    return {
      enabled: s.value.enabled,
      clientId: s.value.clientId,
      callbackUrl: s.value.callbackUrl,
      effectiveCallbackUrl: await callbackUrl(req, s.value.callbackUrl),
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
        clientId: z.string().trim().max(200),
        clientSecret: z.string().max(2048).optional(),
        callbackUrl: z.string().trim().max(2048).default(''),
      })
      .parse(body);
    if (b.callbackUrl) await callbackUrl(req, b.callbackUrl);
    await db.$transaction(async (tx) => {
      await lock(tx, `setting:${settingKey}`);
      const previous = await settings(tx);
      checkVersion(previous.version, b.version);
      const encryptedSecret = b.clientSecret
        ? encrypt(b.clientSecret)
        : previous.value.encryptedSecret;
      if (b.enabled && (!b.clientId || !encryptedSecret))
        throw new BadRequestException('请填写 GitHub Client ID 和 Client Secret');
      const value = {
        enabled: b.enabled,
        clientId: b.clientId,
        callbackUrl: b.callbackUrl,
        encryptedSecret,
      };
      await tx.setting.upsert({
        where: { key: settingKey },
        create: { key: settingKey, value: json(value) },
        update: { value: json(value), version: { increment: 1 } },
      });
      await audit(tx, u.id, 'GITHUB_SETTINGS_UPDATE', settingKey, { enabled: b.enabled });
    });
    return this.view(u, req);
  }
  async providers(req: AuthRequest) {
    const s = await settings();
    const provider = await db.oAuthProvider.findUnique({ where: { slug: 'github' } });
    const linked =
      req.principal && provider
        ? !!(await db.externalIdentity.findFirst({
            where: { providerId: provider.id, userId: req.principal.id },
          }))
        : false;
    return {
      github: {
        enabled: s.value.enabled && !!s.value.clientId && !!s.value.encryptedSecret,
        linked: !!linked,
      },
    };
  }
  async start(req: AuthRequest, res: Response) {
    const s = await settings();
    if (!s.value.enabled || !s.value.clientId || !s.value.encryptedSecret)
      throw new BadRequestException('GitHub 登录尚未配置');
    const linking = req.query.mode === 'link';
    if (linking) user(req);
    const state = opaqueToken(),
      verifier = opaqueToken();
    const record = {
      redirectUri: await callbackUrl(req, s.value.callbackUrl),
      verifier,
      fingerprint: fingerprint(s.value),
      next: githubReturnPath(req.query.next),
      userId: linking ? req.principal!.id : null,
    };
    await redis.set(`github-state:${sha(state)}`, JSON.stringify(record), 'EX', 600);
    res.cookie(stateCookie, state, {
      httpOnly: true,
      secure: await secureCookies(req),
      sameSite: 'lax',
      maxAge: 600000,
      path: '/api/v1/auth/github',
    });
    const url = new URL(
      '/login/oauth/authorize',
      process.env.GITHUB_OAUTH_BASE_URL ?? 'https://github.com',
    );
    for (const [key, value] of Object.entries({
      client_id: s.value.clientId,
      redirect_uri: record.redirectUri,
      scope: 'read:user user:email',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    res.redirect(url.href);
  }
  async callback(req: AuthRequest, res: Response) {
    res.clearCookie(stateCookie, { path: '/api/v1/auth/github' });
    try {
      const state = z.string().min(30).max(100).parse(req.query.state);
      if (!same(state, String(req.cookies?.[stateCookie] ?? ''))) throw new GithubError('state');
      const raw = await redis.getdel(`github-state:${sha(state)}`);
      if (!raw) throw new GithubError('state');
      const record = JSON.parse(raw) as {
        redirectUri: string;
        verifier: string;
        fingerprint: string;
        next: string;
        userId: string | null;
      };
      const s = await settings();
      if (!s.value.enabled || record.fingerprint !== fingerprint(s.value))
        throw new GithubError('state');
      if (req.query.error) throw new GithubError('cancelled');
      const code = z.string().min(1).max(1000).parse(req.query.code);
      const tokens = await githubJson(
        new URL(
          '/login/oauth/access_token',
          process.env.GITHUB_OAUTH_BASE_URL ?? 'https://github.com',
        ).href,
        {
          method: 'POST',
          body: new URLSearchParams({
            client_id: s.value.clientId,
            client_secret: decrypt(s.value.encryptedSecret),
            code,
            redirect_uri: record.redirectUri,
            code_verifier: record.verifier,
          }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
      if (typeof tokens.access_token !== 'string' || !tokens.access_token)
        throw new GithubError('failed');
      const apiBase = (process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com').replace(
        /\/$/,
        '',
      );
      const headers = { Authorization: `Bearer ${tokens.access_token}` };
      const identity = z
        .object({
          id: z.number().int().positive(),
          login: z.string().min(1),
          name: z.string().nullable().optional(),
        })
        .parse(await githubJson(`${apiBase}/user`, { headers }));
      const emails = z
        .array(z.object({ email: z.email(), primary: z.boolean(), verified: z.boolean() }))
        .parse(await githubJson(`${apiBase}/user/emails`, { headers }));
      const email = (
        emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
      )?.email.toLowerCase();
      if (!email) throw new GithubError('email');
      if (record.userId && record.userId !== req.principal?.id) throw new GithubError('state');
      const account = await db.$transaction(async (tx) => {
        await lock(tx, `github:${identity.id}`);
        await lock(tx, `github-email:${email}`);
        const provider = await tx.oAuthProvider.upsert({
          where: { slug: 'github' },
          create: {
            slug: 'github',
            name: 'GitHub',
            mode: 'GITHUB',
            clientId: '',
            clientSecret: '',
          },
          update: {},
        });
        const existing = await tx.externalIdentity.findUnique({
          where: { providerId_subject: { providerId: provider.id, subject: String(identity.id) } },
        });
        if (existing) {
          if (record.userId && record.userId !== existing.userId) throw new GithubError('bound');
          return existing.userId;
        }
        let userId = record.userId;
        if (!userId) {
          if (await tx.user.findUnique({ where: { email } })) throw new GithubError('email_exists');
          const account = await tx.user.create({
            data: {
              email,
              username: `gh_${identity.id}_${opaqueToken()
                .replace(/[^a-zA-Z0-9_]/g, '')
                .slice(0, 6)}`,
              name: (identity.name || identity.login).trim().slice(0, 100),
              verified: true,
            },
          });
          userId = account.id;
        } else {
          await lock(tx, `auth:${userId}`);
          const another = await tx.externalIdentity.findFirst({
            where: { providerId: provider.id, userId },
          });
          if (another) throw new GithubError('bound');
          const current = await tx.user.findUniqueOrThrow({ where: { id: userId } });
          if (current.email === email && !current.verified)
            await tx.user.update({
              where: { id: userId },
              data: { verified: true, version: { increment: 1 } },
            });
        }
        await tx.externalIdentity.create({
          data: { providerId: provider.id, subject: String(identity.id), userId },
        });
        await audit(tx, userId, record.userId ? 'GITHUB_LINK' : 'GITHUB_REGISTER', userId);
        return userId;
      });
      const authenticated = await session(req, res, account);
      const next = githubReturnPath(record.next);
      res.redirect(
        record.userId
          ? '/account?github_linked=1'
          : authenticated.user.profileComplete ||
              authenticated.user.isAdmin ||
              authenticated.user.isCoach
            ? next
            : `/account?next=${encodeURIComponent(next)}`,
      );
    } catch (error) {
      const code = error instanceof GithubError ? error.code : 'failed';
      res.redirect(`/login?github_error=${encodeURIComponent(code)}`);
    }
  }
  async unlink(req: AuthRequest) {
    const u = user(req);
    return db.$transaction(async (tx) => {
      await lock(tx, `auth:${u.id}`);
      const current = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
      if (!current.passwordHash)
        throw new BadRequestException('请先通过邮箱找回流程设置密码，再解除 GitHub 绑定');
      const provider = await tx.oAuthProvider.findUnique({ where: { slug: 'github' } });
      if (provider)
        await tx.externalIdentity.deleteMany({ where: { providerId: provider.id, userId: u.id } });
      await audit(tx, u.id, 'GITHUB_UNLINK', u.id);
      return { ok: true };
    });
  }
}
