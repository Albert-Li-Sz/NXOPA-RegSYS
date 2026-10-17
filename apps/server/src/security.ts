import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  createHmac,
  timingSafeEqual,
  hkdfSync,
} from 'node:crypto';
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
export const secretKey = (purpose: string) =>
  Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(config.encryptionKey, 'hex'),
      Buffer.from('NXOPA-RegSYS'),
      Buffer.from(purpose),
      32,
    ),
  ).toString('hex');
export function otpHash(body: string) {
  return `v2:${hmac(secretKey('otp:v2'), body)}`;
}
export function checkOtp(stored: string, body: string) {
  return stored.startsWith('v2:')
    ? same(stored, otpHash(body))
    : same(stored, hmac(config.encryptionKey, body));
}
export function encrypt(s: string, context = 'secret') {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(secretKey(`encryption:v2:${context}`), 'hex'),
    iv,
  );
  cipher.setAAD(Buffer.from(`NXOPA-RegSYS:v2:${context}`));
  const body = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return ['v2', iv.toString('hex'), body.toString('hex'), cipher.getAuthTag().toString('hex')].join(
    '.',
  );
}
export function decrypt(s: string, context = 'secret') {
  try {
    const parts = s.split('.');
    const versioned = parts[0] === 'v2';
    if (versioned) parts.shift();
    if (parts.length !== 3) throw new Error('Invalid ciphertext');
    const [iv, body, tag] = parts;
    if (
      !/^[a-f0-9]{24}$/i.test(iv!) ||
      !/^(?:[a-f0-9]{2})*$/i.test(body!) ||
      !/^[a-f0-9]{32}$/i.test(tag!)
    )
      throw new Error('Invalid ciphertext');
    const cipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(versioned ? secretKey(`encryption:v2:${context}`) : config.encryptionKey, 'hex'),
      Buffer.from(iv!, 'hex'),
    );
    if (versioned) cipher.setAAD(Buffer.from(`NXOPA-RegSYS:v2:${context}`));
    cipher.setAuthTag(Buffer.from(tag!, 'hex'));
    return Buffer.concat([cipher.update(Buffer.from(body!, 'hex')), cipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new BadRequestException('加密配置无法读取，请重新保存该配置');
  }
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
  return manages(u, r.contestId, 'REGISTRATIONS') || canActForApplicant(u, r);
}
export function canActForApplicant(u: Principal, r: Registration) {
  return owns(u, r.ownerId) || r.coaches.some((c) => owns(u, c.userId));
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
  const { integrationTarget } = await import('./integration-http.js');
  return (await integrationTarget(raw)).url;
}
