export const mailVariables = [
  'siteName',
  'subject',
  'message',
  'actionUrl',
  'code',
  'name',
  'status',
] as const;
export const authenticationMailCategories = ['AUTH_VERIFY', 'AUTH_RESET', 'ACCOUNT_CLOSE'];
export const defaultMailTemplate = {
  subject: '{{subject}} · {{siteName}}',
  text: '{{message}}\n\n{{#code}}验证码：{{code}}\n{{/code}}{{#actionUrl}}{{actionUrl}}\n{{/actionUrl}}\n{{siteName}}',
  html: '<!DOCTYPE html><html><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif"><div style="max-width:640px;margin:24px auto;padding:28px;background:#fff;border-radius:12px"><h2 style="color:#2080f0">{{siteName}}</h2><h3>{{subject}}</h3><p style="line-height:1.8">{{message}}</p>{{#code}}<p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{code}}</p>{{/code}}{{#actionUrl}}<p><a href="{{actionUrl}}" style="color:#2080f0">查看详情 / 完成操作</a></p>{{/actionUrl}}<hr><p style="color:#8791a0;font-size:12px">此邮件由 {{siteName}} 自动发送。</p></div></body></html>',
};
const notificationContent: Record<string, { intro: string; action: string }> = {
  REGISTRATION: { intro: '报名进度已更新，请查看反馈。', action: '查看报名' },
  INVOICE: { intro: '开票进度已更新，请查看反馈。', action: '查看开票详情' },
  SUPPORT_NEW: { intro: '收到一条新工单，请及时查看并处理。', action: '查看工单' },
  SUPPORT_REPLY: { intro: '工单收到新回复或状态更新。', action: '查看工单' },
  IDENTITY: { intro: '实名信息审核进度已更新。', action: '查看实名审核' },
  ADMISSION: { intro: '准考证已生成或发放，请查看详情。', action: '查看准考证' },
  GENERIC: { intro: '您有一条新的系统通知。', action: '查看详情' },
};
export function mailTemplateForCategory(category: string) {
  if (authenticationMailCategories.includes(category)) return { ...defaultMailTemplate };
  const content = notificationContent[category] ?? notificationContent.GENERIC!;
  return {
    subject: defaultMailTemplate.subject,
    text: `${content.intro}\n\n{{message}}\n\n{{#status}}状态：{{status}}\n{{/status}}{{#actionUrl}}${content.action}：{{actionUrl}}\n{{/actionUrl}}\n{{siteName}}`,
    html: defaultMailTemplate.html
      .replace(/{{#code}}[\s\S]*?{{\/code}}/g, '')
      .replace(
        '<p style="line-height:1.8">{{message}}</p>',
        `<p>${content.intro}</p><p style="line-height:1.8">{{message}}</p>{{#status}}<p>状态：{{status}}</p>{{/status}}`,
      )
      .replace('查看详情 / 完成操作', content.action),
  };
}
const legacyMailTemplate = {
  subject: defaultMailTemplate.subject,
  text: '{{message}}\n\n验证码：{{code}}\n{{actionUrl}}\n\n{{siteName}}',
  html: defaultMailTemplate.html.replace(/{{[#/](?:code|actionUrl)}}/g, ''),
};
export function resolveMailTemplate(category: string, template?: typeof defaultMailTemplate) {
  // Replace only unchanged bundled defaults; customized templates keep their exact content.
  if (
    !template ||
    [defaultMailTemplate, legacyMailTemplate].some((defaults) =>
      (['subject', 'text', 'html'] as const).every((field) => template[field] === defaults[field]),
    )
  )
    return mailTemplateForCategory(category);
  return { subject: template.subject, text: template.text, html: template.html };
}
export function mailTemplateExample(category: string): {
  subject: string;
  text: string;
  status: string;
  actionPath: string;
  code?: string;
} {
  const examples: Record<
    string,
    { subject: string; details: string; status: string; actionPath: string }
  > = {
    AUTH_VERIFY: {
      subject: '邮箱验证 / 注册验证码',
      details: '请使用下方示例验证码完成邮箱验证或账号注册。',
      status: '',
      actionPath: '/me/profile',
    },
    AUTH_RESET: {
      subject: '密码重置验证码',
      details: '请使用下方示例验证码重置密码。',
      status: '',
      actionPath: '/account/reset',
    },
    ACCOUNT_CLOSE: {
      subject: '注销验证码',
      details: '请使用下方示例验证码确认账号注销。',
      status: '',
      actionPath: '/me/profile?tab=settings',
    },
    REGISTRATION: {
      subject: '报名审核结果',
      details: '您提交的示例活动报名已通过审核。',
      status: '审核通过',
      actionPath: '/registrations',
    },
    INVOICE: {
      subject: '开票结果通知',
      details: '示例开票申请已处理，请查看开票详情。',
      status: '已开票',
      actionPath: '/registrations',
    },
    SUPPORT_NEW: {
      subject: '新工单待处理',
      details: '工单标题：报名资料咨询\n有用户提交了新工单，请及时查看并处理。',
      status: '待处理',
      actionPath: '/support',
    },
    SUPPORT_REPLY: {
      subject: '工单有新回复',
      details: '工单「报名资料咨询」收到新回复：您的资料已收到，正在处理中。',
      status: '处理中',
      actionPath: '/support',
    },
    IDENTITY: {
      subject: '实名审核结果',
      details: '您的示例实名信息已通过审核。',
      status: '已通过',
      actionPath: '/me/profile?tab=identity',
    },
    ADMISSION: {
      subject: '准考证已发放',
      details: '示例活动的准考证已发放，请查看并下载。',
      status: '已发放',
      actionPath: '/me/admissions',
    },
    GENERIC: {
      subject: '系统通知',
      details: '这是一条示例系统通知。',
      status: '',
      actionPath: '/contests',
    },
  };
  const example = examples[category] ?? examples.GENERIC!;
  return {
    subject: example.subject,
    text: `这是使用当前已保存模板发送的测试邮件。\n${example.details}`,
    status: example.status,
    actionPath: example.actionPath,
    ...(authenticationMailCategories.includes(category) ? { code: '123456' } : {}),
  };
}
export type MailTemplateContext = Record<(typeof mailVariables)[number], string>;
export function mailTemplateError(
  template: { subject: string; text: string; html: string; enabled: boolean },
  category: string,
): string | undefined {
  if (
    authenticationMailCategories.includes(category) &&
    (!template.enabled ||
      !/{{\s*code\s*}}/.test(template.text) ||
      (template.html.trim() && !/{{\s*code\s*}}/.test(template.html)))
  )
    return '验证类邮件必须启用，并在纯文本及非空 HTML 中保留 {{code}} 验证码变量';
  for (const source of [template.subject, template.text, template.html]) {
    let block = '';
    for (const token of source.matchAll(/{{\s*([#/]?)\s*(\w+)\s*}}/g)) {
      if (!mailVariables.includes(token[2]! as (typeof mailVariables)[number]))
        return `模板变量不支持：${token[2]}`;
      if (token[1] === '#') {
        if (block) return '条件区块不支持嵌套';
        block = token[2]!;
      }
      if (token[1] === '/') {
        if (block !== token[2]) return '模板条件区块没有正确配对';
        block = '';
      }
    }
    if (block || source.replace(/{{\s*([#/]?)\s*(\w+)\s*}}/g, '').includes('{{'))
      return '模板变量或条件区块格式有误';
  }
}
const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export function renderMailTemplate(
  template: { subject: string; text: string; html: string },
  context: MailTemplateContext,
  category = 'GENERIC',
) {
  const render = (source: string, html = false) =>
    source
      .replace(/{{\s*#\s*(\w+)\s*}}([\s\S]*?){{\s*\/\s*\1\s*}}/g, (_match, key, content) =>
        context[key as keyof MailTemplateContext] ? content : '',
      )
      .replace(/{{\s*(\w+)\s*}}/g, (_match, key) =>
        html
          ? escape(context[key as keyof MailTemplateContext] ?? '').replaceAll('\n', '<br>')
          : (context[key as keyof MailTemplateContext] ?? ''),
      );
  let html = template.html;
  // Older saved defaults did not have conditional blocks.
  if (!context.code)
    html = html.replace(/<p style="font-size:28px[^>]*>\s*{{\s*code\s*}}\s*<\/p>/g, '');
  if (!context.actionUrl)
    html = html.replace(/<p>\s*<a href="{{\s*actionUrl\s*}}"[^>]*>[\s\S]*?<\/a>\s*<\/p>/g, '');
  let text = render(template.text).replace(/\n验证码：\s*\n/, '\n');
  html = render(html, true);
  if (authenticationMailCategories.includes(category) && context.code) {
    if (!/{{\s*code\s*}}/.test(template.text)) text += `\n验证码：${context.code}`;
    if (html && !/{{\s*code\s*}}/.test(template.html))
      html += `<p>验证码：${escape(context.code)}</p>`;
  }
  return { subject: render(template.subject).replace(/[\r\n]/g, ' '), text, html };
}
