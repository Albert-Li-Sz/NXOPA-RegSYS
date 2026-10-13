import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@contest-center/contracts';
import { db, audit, lock } from './db.js';
import { requireSystemAdmin, checkVersion } from './security.js';
import { siteSettings, publicLink } from './site-settings.js';
export const mailCategories = [
  'AUTH_VERIFY',
  'AUTH_RESET',
  'ACCOUNT_CLOSE',
  'REGISTRATION',
  'INVOICE',
  'SUPPORT_NEW',
  'SUPPORT_REPLY',
  'IDENTITY',
  'ADMISSION',
  'GENERIC',
] as const;
const variables = ['siteName', 'subject', 'message', 'actionUrl', 'code', 'name', 'status'];
const defaults = {
  subject: '{{subject}} · {{siteName}}',
  text: '{{message}}\n\n验证码：{{code}}\n{{actionUrl}}\n\n{{siteName}}',
  html: '<!DOCTYPE html><html><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif"><div style="max-width:640px;margin:24px auto;padding:28px;background:#fff;border-radius:12px"><h2 style="color:#2080f0">{{siteName}}</h2><h3>{{subject}}</h3><p style="line-height:1.8">{{message}}</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{code}}</p><p><a href="{{actionUrl}}" style="color:#2080f0">查看详情 / 完成操作</a></p><hr><p style="color:#8791a0;font-size:12px">此邮件由 {{siteName}} 自动发送。</p></div></body></html>',
};
export const mailCategoryLabels: Record<string, string> = {
  AUTH_VERIFY: '邮箱验证 / 注册验证码',
  AUTH_RESET: '密码重置',
  ACCOUNT_CLOSE: '注销验证码',
  REGISTRATION: '报名反馈',
  INVOICE: '开票反馈',
  SUPPORT_NEW: '新工单',
  SUPPORT_REPLY: '工单回复与状态',
  IDENTITY: '实名审核',
  ADMISSION: '准考证发放',
  GENERIC: '其他通知',
};
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
function render(source: string, context: Record<string, string>, html = false) {
  return source.replace(/{{\s*(\w+)\s*}}/g, (_m, key) =>
    html ? escape(context[key] ?? '').replaceAll('\n', '<br>') : (context[key] ?? ''),
  );
}
export async function formatMail(message: {
  subject: string;
  text: string;
  category?: string;
  code?: string;
  actionPath?: string;
  name?: string;
  status?: string;
}) {
  const category = mailCategories.includes(message.category as any) ? message.category! : 'GENERIC';
  const stored = await db.mailTemplate.findUnique({ where: { key: category } });
  const template = stored ?? { ...defaults, enabled: true };
  if (!template.enabled) return { skipped: true as const };
  const site = await siteSettings();
  const context = {
    siteName: site.name,
    subject: message.subject,
    message: message.text,
    code: message.code ?? '',
    actionUrl: message.actionPath ? await publicLink(message.actionPath) : '',
    name: message.name ?? '',
    status: message.status ?? '',
  };
  let html = template.html;
  if (!stored) {
    if (!context.code) html = html.replace(/<p style="font-size:28px[^>]*>.*?<\/p>/, '');
    if (!context.actionUrl) html = html.replace(/<p><a href="{{actionUrl}}".*?<\/p>/, '');
  }
  return {
    subject: render(template.subject, context).replace(/[\r\n]/g, ' '),
    text: render(template.text, context).replace(/\n验证码：\s*\n/, '\n'),
    html: render(html, context, true),
    category,
  };
}
export class MailTemplateService {
  async list(u: Principal) {
    requireSystemAdmin(u);
    const stored = await db.mailTemplate.findMany();
    return mailCategories.map((key) => ({
      key,
      label: mailCategoryLabels[key],
      ...defaults,
      enabled: true,
      version: 0,
      ...stored.find((x) => x.key === key),
    }));
  }
  async save(u: Principal, key: string, body: unknown) {
    requireSystemAdmin(u);
    z.enum(mailCategories).parse(key);
    const b = z
      .object({
        version: z.number().int().min(0),
        subject: z
          .string()
          .min(1)
          .max(500)
          .regex(/^[^\r\n]*$/),
        text: z.string().min(1).max(30000),
        html: z.string().max(100000),
        enabled: z.boolean(),
      })
      .parse(body);
    for (const source of [b.subject, b.text, b.html])
      for (const match of source.matchAll(/{{\s*(\w+)\s*}}/g))
        if (!variables.includes(match[1]!))
          throw new BadRequestException(`模板变量不支持：${match[1]}`);
    return db.$transaction(async (tx) => {
      await lock(tx, 'mail-template:' + key);
      const current = await tx.mailTemplate.findUnique({ where: { key } });
      checkVersion(current?.version ?? 0, b.version);
      const { version, ...data } = b;
      const result = await tx.mailTemplate.upsert({
        where: { key },
        create: { key, ...data },
        update: { ...data, version: { increment: 1 } },
      });
      await audit(tx, u.id, 'MAIL_TEMPLATE_SAVE', key);
      return result;
    });
  }
}
