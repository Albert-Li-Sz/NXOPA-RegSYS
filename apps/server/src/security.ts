import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import dns from 'node:dns/promises';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Principal, AdminPermission } from '@contest-center/contracts';
import { config } from './config.js';
import { db, registrationInclude, type Registration } from './db.js';
export const opaqueToken = () => randomBytes(32).toString('base64url');
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export function encrypt(s: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), iv);
  const body = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), body.toString('hex'), cipher.getAuthTag().toString('hex')].join('.');
}
export function decrypt(s: string) {
  const [iv, body, tag] = s.split('.');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(config.encryptionKey, 'hex'),
    Buffer.from(iv!, 'hex'),
  );
  cipher.setAuthTag(Buffer.from(tag!, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(body!, 'hex')), cipher.final()]).toString('utf8');
}
export const manages = (u: Principal, contestId: string, permission: AdminPermission = 'VIEW') =>
  u.isAdmin ||
  (u.contestIds.includes(contestId) &&
    (!u.permissions || u.permissions[contestId]?.includes(permission)));
export const ownerIds = (u: Principal) => (u.relatedUserIds?.length ? u.relatedUserIds : [u.id]);
export const owns = (u: Principal, id: string) => ownerIds(u).includes(id);
export function requireSystemAdmin(u: Principal) {
  if (!(u.isSystemAdmin ?? u.isAdmin)) throw new ForbiddenException('核心配置需要系统管理员授权');
}
export function requireAdmin(u: Principal) {
  if (!u.isAdmin) throw new ForbiddenException('需要系统管理员权限');
}
export function requireManager(
  u: Principal,
  contestId: string,
  permission: AdminPermission = 'VIEW',
) {
  if (!manages(u, contestId, permission)) throw new ForbiddenException('没有此竞赛的相应管理权限');
}
export function canRead(u: Principal, r: Registration) {
  return (
    manages(u, r.contestId) ||
    owns(u, r.ownerId) ||
    r.people.some((p) => !!p.userId && owns(u, p.userId) && p.active) ||
    r.coaches.some((c) => owns(u, c.userId))
  );
}
export function canEdit(u: Principal, r: Registration) {
  return (
    manages(u, r.contestId, 'REGISTRATIONS') ||
    owns(u, r.ownerId) ||
    r.coaches.some((c) => owns(u, c.userId))
  );
}
export async function getRegistration(u: Principal, id: string, edit = false) {
  const r = await db.registration.findUnique({ where: { id }, include: registrationInclude });
  if (!r) throw new NotFoundException('报名不存在');
  if (!(edit ? canEdit(u, r) : canRead(u, r))) throw new ForbiddenException('没有此报名的访问权限');
  return r;
}
export async function getSupportTicket(u: Principal, id: string) {
  const ticket = await db.supportTicket.findUniqueOrThrow({ where: { id } });
  if (owns(u, ticket.ownerId) || u.isAdmin || manages(u, ticket.contestId ?? '', 'SUPPORT'))
    return ticket;
  if (ticket.registrationId) {
    const registration = await getRegistration(u, ticket.registrationId);
    if (
      owns(u, registration.ownerId) ||
      registration.people.some((p) => p.active && p.userId && owns(u, p.userId)) ||
      registration.coaches.some((c) => owns(u, c.userId))
    )
      return ticket;
  }
  throw new ForbiddenException('没有此工单的访问权限');
}
export function checkVersion(current: number, expected: unknown) {
  if (expected !== current) throw new ConflictException('资料已被更新，请刷新后重试');
}
export function hmac(secret: string, body: string) {
  return createHmac('sha256', secret).update(body).digest('hex');
}
export function same(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function safeUrl(raw: string) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new BadRequestException('仅支持 HTTP(S) 地址');
  if (config.production && u.protocol !== 'https:')
    throw new BadRequestException('生产环境外部连接需要 HTTPS');
  if (!config.allowPrivate) {
    const records = await dns.lookup(u.hostname, { all: true });
    if (
      records.some((x) =>
        /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i.test(
          x.address,
        ),
      )
    )
      throw new BadRequestException('此地址不在允许的公网范围');
  }
  return u;
}
