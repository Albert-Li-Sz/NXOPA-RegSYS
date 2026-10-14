import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  mailTemplateForCategory,
  resolveMailTemplate,
  mailTemplateExample,
  mailTemplateError,
  renderMailTemplate,
  authenticationMailCategories,
  type Principal,
} from '@contest-center/contracts';
import { randomUUID } from 'node:crypto';
import { db, audit, lock, enqueue } from './db.js';
import { encrypt } from './security.js';
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
  const template = {
    enabled: true,
    ...stored,
    ...resolveMailTemplate(category, stored ?? undefined),
  };
  if (!template.enabled && !authenticationMailCategories.includes(category))
    return { skipped: true as const };
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
  return {
    ...renderMailTemplate(
      template.enabled ? template : mailTemplateForCategory(category),
      context,
      category,
    ),
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
      ...mailTemplateForCategory(key),
      enabled: true,
      version: 0,
      ...stored.find((x) => x.key === key),
      ...resolveMailTemplate(
        key,
        stored.find((x) => x.key === key),
      ),
    }));
  }
  async test(u: Principal, key: string, body: unknown) {
    requireSystemAdmin(u);
    z.enum(mailCategories).parse(key);
    const { version } = z.object({ version: z.number().int().min(0) }).parse(body);
    return db.$transaction(async (tx) => {
      await lock(tx, 'mail-template:' + key);
      const template = await tx.mailTemplate.findUnique({ where: { key } });
      checkVersion(template?.version ?? 0, version);
      if (template?.enabled === false)
        throw new BadRequestException('此类邮件已停用，请先启用并保存');
      const example = mailTemplateExample(key);
      const job = await enqueue(
        tx,
        'MAIL',
        `mail-template:${key}`,
        `mail-template-test:${randomUUID()}`,
        {
          to: u.email,
          category: key,
          subject: example.subject,
          text: example.text,
          name: u.name,
          status: example.status,
          ...(example.code ? { encryptedCode: encrypt(example.code) } : {}),
          actionPath: example.actionPath,
          templateTest: true,
          templateVersion: version,
        },
      );
      await audit(tx, u.id, 'MAIL_TEMPLATE_TEST', key, { jobId: job.id });
      return { jobId: job.id, to: u.email };
    });
  }
  async testStatus(u: Principal, id: string) {
    requireSystemAdmin(u);
    const job = await db.job.findFirstOrThrow({
      where: {
        id: z.string().uuid().parse(id),
        kind: 'MAIL',
        resourceId: { startsWith: 'mail-template:' },
      },
    });
    return { state: job.state, attempts: job.attempts, error: job.error, result: job.result };
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
    const validation = mailTemplateError(b, key);
    if (validation) throw new BadRequestException(validation);
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
