import { BadRequestException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  mailSettingsSchema,
  type MailSettingsInput,
  type MailSettingsView,
  type Principal,
} from '@contest-center/contracts';
import { db, lock, audit, enqueue, json, type Tx } from './db.js';
import { requireSystemAdmin, encrypt, decrypt, checkVersion } from './security.js';
import { config } from './config.js';
import { formatMail } from './mail-templates.js';

const key = 'mail';
type StoredMail = Omit<MailSettingsInput, 'version' | 'password'> & { encryptedPassword: string };
function environmentMail(): StoredMail {
  const from = process.env.SMTP_FROM ?? '南晓开放原子社在线报名系统 <noreply@example.test>';
  const formatted = from.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  const port = Number(process.env.SMTP_PORT ?? (config.production ? 587 : 51025));
  return {
    enabled: !!process.env.SMTP_HOST || !config.production,
    host: process.env.SMTP_HOST ?? 'localhost',
    port,
    security:
      process.env.SMTP_SECURITY === 'STARTTLS'
        ? 'STARTTLS'
        : process.env.SMTP_SECURITY === 'NONE'
          ? 'NONE'
          : process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURITY === 'TLS'
            ? 'TLS'
            : port === 587
              ? 'STARTTLS'
              : 'NONE',
    authEnabled: !!process.env.SMTP_USER,
    username: process.env.SMTP_USER ?? '',
    encryptedPassword: process.env.SMTP_PASSWORD ? encrypt(process.env.SMTP_PASSWORD) : '',
    fromAddress: formatted ? formatted[2]!.trim() : from.trim(),
    fromName: formatted ? formatted[1]!.trim().replace(/^"|"$/g, '') : '',
  };
}
async function settings(database: Tx = db) {
  const row = await database.setting.findUnique({ where: { key } });
  return {
    value: row ? (row.value as unknown as StoredMail) : environmentMail(),
    version: row?.version ?? 0,
    source: row ? ('DATABASE' as const) : ('ENVIRONMENT' as const),
  };
}
function view(s: Awaited<ReturnType<typeof settings>>): MailSettingsView {
  const { encryptedPassword, ...value } = s.value;
  return {
    ...value,
    version: s.version,
    source: s.source,
    passwordConfigured: !!encryptedPassword,
  };
}
function transport(s: StoredMail) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'TLS',
    requireTLS: s.security === 'STARTTLS',
    ignoreTLS: s.security === 'NONE',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    ...(s.authEnabled ? { auth: { user: s.username, pass: decrypt(s.encryptedPassword) } } : {}),
  });
}
function mailError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === 'EAUTH') return '邮件服务器认证失败，请检查用户名和授权码';
  if (code === 'ETIMEDOUT') return '邮件服务器连接超时，请检查地址、端口和网络';
  if (code === 'ECONNECTION' || code === 'EDNS' || code === 'ESOCKET')
    return '无法连接邮件服务器，请检查地址、端口和加密方式';
  if (code === 'ETLS') return '邮件服务器加密连接失败，请检查证书和加密方式';
  if (code === 'EENVELOPE' || code === 'EMESSAGE')
    return '邮件服务器拒绝发件人或邮件内容，请检查发件邮箱';
  return '邮件发送失败，请检查邮件服务器设置后重试';
}
export async function sendSystemMail(
  message: {
    to: string;
    subject: string;
    text: string;
    category?: string;
    code?: string;
    actionPath?: string;
    name?: string;
    status?: string;
  },
  expectedVersion?: number,
) {
  const s = await settings();
  if (expectedVersion !== undefined && expectedVersion !== s.version)
    throw new Error('邮件设置已变更，请重新发送测试邮件');
  if (!s.value.enabled) throw new Error('邮件服务已停用，请启用邮件服务后重试');
  const client = transport(s.value);
  try {
    const formatted = await formatMail(message);
    if ('skipped' in formatted) return { configurationVersion: s.version, skipped: true };
    await client.sendMail({
      to: message.to,
      subject: formatted.subject,
      text: formatted.text,
      html: formatted.html,
      from: { name: s.value.fromName, address: s.value.fromAddress },
    });
    return { configurationVersion: s.version };
  } catch (error) {
    throw new Error(mailError(error));
  } finally {
    client.close();
  }
}
export class MailService {
  async get(u: Principal) {
    requireSystemAdmin(u);
    return view(await settings());
  }
  async save(u: Principal, body: unknown) {
    requireSystemAdmin(u);
    const b = mailSettingsSchema.parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, 'system:mail');
      const current = await settings(tx);
      checkVersion(current.version, b.version);
      if (b.authEnabled && !b.username)
        throw new BadRequestException('启用邮件认证时需要填写用户名');
      let encryptedPassword = '';
      if (b.authEnabled) {
        if (b.password) encryptedPassword = encrypt(b.password);
        else if (current.value.username === b.username)
          encryptedPassword = current.value.encryptedPassword;
        if (!encryptedPassword) throw new BadRequestException('请填写邮件服务器密码或授权码');
      }
      const { version, password, ...value } = b;
      const row = await tx.setting.upsert({
        where: { key },
        create: { key, value: json({ ...value, encryptedPassword }) },
        update: { value: json({ ...value, encryptedPassword }), version: { increment: 1 } },
      });
      await audit(tx, u.id, 'MAIL_SETTINGS_UPDATED', key, {
        version: row.version,
        enabled: b.enabled,
        host: b.host,
        port: b.port,
        security: b.security,
        authEnabled: b.authEnabled,
      });
      return view({
        value: row.value as unknown as StoredMail,
        version: row.version,
        source: 'DATABASE',
      });
    });
  }
  async probe(u: Principal, body: unknown) {
    requireSystemAdmin(u);
    const { version } = z.object({ version: z.number().int().min(0) }).parse(body);
    const s = await settings();
    checkVersion(s.version, version);
    if (!s.value.enabled) throw new BadRequestException('请先启用并保存邮件服务');
    const client = transport(s.value);
    try {
      await client.verify();
      return { ok: true, message: '邮件服务器连接及认证正常' };
    } catch (error) {
      throw new BadRequestException(mailError(error));
    } finally {
      client.close();
    }
  }
  async test(u: Principal, body: unknown) {
    requireSystemAdmin(u);
    const { version } = z.object({ version: z.number().int().min(0) }).parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, 'system:mail');
      const s = await settings(tx);
      checkVersion(s.version, version);
      if (!s.value.enabled) throw new BadRequestException('请先启用并保存邮件服务');
      const job = await enqueue(tx, 'MAIL', key, `mail-test:${randomUUID()}`, {
        to: u.email,
        subject: '系统邮件配置测试',
        text: `这是一封由管理中心发出的测试邮件。\n配置版本：${s.version}\n发送时间：${new Date().toISOString()}\n收到此邮件说明后台邮件任务已使用当前配置完成发送。`,
        test: true,
        configurationVersion: s.version,
      });
      await audit(tx, u.id, 'MAIL_TEST_REQUESTED', key, { jobId: job.id, version: s.version });
      return { jobId: job.id, to: u.email };
    });
  }
  async testStatus(u: Principal, id: string) {
    requireSystemAdmin(u);
    const job = await db.job.findFirstOrThrow({
      where: { id: z.string().uuid().parse(id), kind: 'MAIL', resourceId: key },
    });
    return {
      id: job.id,
      state: job.state,
      attempts: job.attempts,
      error: job.error,
      result: job.result,
    };
  }
}
