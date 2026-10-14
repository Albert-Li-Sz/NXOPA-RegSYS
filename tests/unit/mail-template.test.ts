import { describe, it, expect } from 'vitest';
import {
  defaultMailTemplate,
  mailTemplateForCategory,
  mailTemplateExample,
  resolveMailTemplate,
  renderMailTemplate,
  mailTemplateError,
  type MailTemplateContext,
} from '../../packages/contracts/src/index.js';
const context: MailTemplateContext = {
  siteName: '测试系统',
  subject: '测试标题',
  message: '<script>bad()</script>\n第二行',
  code: '',
  actionUrl: '',
  name: '用户',
  status: '通过',
};
describe('mail template rendering and validation', () => {
  it('gives every notification its own content and sample without verification codes', () => {
    for (const category of [
      'REGISTRATION',
      'INVOICE',
      'SUPPORT_NEW',
      'SUPPORT_REPLY',
      'IDENTITY',
      'ADMISSION',
      'GENERIC',
    ]) {
      const template = mailTemplateForCategory(category),
        example = mailTemplateExample(category);
      expect(template.text).not.toMatch(/code|验证码/);
      expect(template.html).not.toMatch(/code|验证码/);
      expect(example).not.toHaveProperty('code');
      expect(mailTemplateError({ ...template, enabled: true }, category)).toBeUndefined();
      const output = renderMailTemplate(
        template,
        {
          ...context,
          subject: example.subject,
          message: example.text,
          status: example.status,
          actionUrl: 'https://example.test' + example.actionPath,
        },
        category,
      );
      expect(output.text).not.toMatch(/123456|验证码/);
      expect(output.html).not.toMatch(/123456|验证码/);
    }
    expect(mailTemplateForCategory('SUPPORT_NEW').text).toContain('新工单');
    expect(mailTemplateForCategory('SUPPORT_REPLY').text).toContain('新回复');
    for (const category of ['AUTH_VERIFY', 'AUTH_RESET', 'ACCOUNT_CLOSE']) {
      expect(mailTemplateForCategory(category).text).toContain('{{code}}');
      expect(mailTemplateExample(category).code).toBe('123456');
    }
  });
  it('updates only unchanged bundled defaults while preserving customized template content', () => {
    expect(resolveMailTemplate('SUPPORT_NEW', defaultMailTemplate)).toEqual(
      mailTemplateForCategory('SUPPORT_NEW'),
    );
    const custom = { ...defaultMailTemplate, subject: '管理员自定义 {{subject}}' };
    expect(resolveMailTemplate('SUPPORT_NEW', custom)).toEqual(custom);
    const legacy = {
      ...defaultMailTemplate,
      text: '{{message}}\n\n验证码：{{code}}\n{{actionUrl}}\n\n{{siteName}}',
      html: defaultMailTemplate.html.replace(/{{[#/](?:code|actionUrl)}}/g, ''),
    };
    expect(resolveMailTemplate('SUPPORT_NEW', legacy)).toEqual(
      mailTemplateForCategory('SUPPORT_NEW'),
    );
  });
  it('uses conditional blocks consistently in text and full HTML, preserving CSS and escaping data', () => {
    const result = renderMailTemplate(defaultMailTemplate, context);
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;bad()&lt;/script&gt;<br>第二行');
    expect(result.html).not.toContain('href=""');
    expect(result.text).not.toContain('验证码：');
    expect(result.html).toContain('<html>');
    expect(result.html).not.toContain('{{');
  });
  it('preserves a usable code when a legacy authentication template omitted it', () => {
    const result = renderMailTemplate(
      { subject: '验证', text: '原模板', html: '<p>原模板</p>' },
      { ...context, code: '123456' },
      'AUTH_VERIFY',
    );
    expect(result.text).toContain('验证码：123456');
    expect(result.html).toContain('123456');
  });
  it('rejects broken variables, disabled verification and unpaired conditions while accepting CSS braces', () => {
    const template = { ...defaultMailTemplate, enabled: true };
    expect(mailTemplateError(template, 'AUTH_VERIFY')).toBeUndefined();
    expect(
      mailTemplateError(
        { ...template, html: '<style>@media screen{p{color:red}}</style>{{message}}' },
        'GENERIC',
      ),
    ).toBeUndefined();
    expect(mailTemplateError({ ...template, enabled: false }, 'AUTH_VERIFY')).toContain('必须启用');
    for (const text of ['{{ unknown }}', '{{code', '{{#code}}未关闭', '{{/code}}'])
      expect(mailTemplateError({ ...template, text }, 'GENERIC')).toBeDefined();
  });
});
