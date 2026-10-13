import { BadRequestException } from '@nestjs/common';
import { defaultSite } from '@contest-center/contracts';
import { db } from './db.js';
import { config } from './config.js';
import { isIP } from 'node:net';

export function validatePublicUrl(value: string, _production = config.production) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException('公网地址格式无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !url.hostname ||
    /\s/.test(value)
  )
    throw new BadRequestException(
      '填写根路径 HTTP／HTTPS 地址，不含账号密码、路径、查询参数或片段',
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    (!isIP(hostname) &&
      (hostname.length > 253 ||
        hostname
          .split('.')
          .some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)))) ||
    (url.port && Number(url.port) < 1)
  )
    throw new BadRequestException('公网地址的域名或端口无效');
  return url.origin;
}
export async function siteSettings() {
  const row = await db.setting.findUnique({ where: { key: 'site' } });
  const value = row?.value as Record<string, unknown> | undefined;
  return {
    ...defaultSite,
    ...value,
    publicUrl: String(value?.publicUrl || config.publicUrl).replace(/\/$/, ''),
    version: row?.version ?? 0,
  };
}
export async function publicUrl() {
  return (await siteSettings()).publicUrl;
}
export async function publicLink(path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid public link path');
  return `${await publicUrl()}${path}`;
}
