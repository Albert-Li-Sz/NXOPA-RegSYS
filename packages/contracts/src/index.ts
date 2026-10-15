import { z } from 'zod';
export {
  defaultMailTemplate,
  mailTemplateForCategory,
  resolveMailTemplate,
  mailTemplateExample,
  mailVariables,
  authenticationMailCategories,
  renderMailTemplate,
  mailTemplateError,
  type MailTemplateContext,
} from './mail-template.js';
export {
  platformTemplates,
  requiredPlatformFields,
  mergePlatformFields,
} from './platform-fields.js';

export const defaultSite = {
  name: '南晓开放原子社在线报名系统',
  primaryColor: '#2080F0',
  footer: '南晓开放原子社 · 南京晓庄学院 ICPC 集训队',
};

export const uuid = z.string().uuid();
export const studentProfileSchema = z.object({
  student_id: z.string().trim().min(1, '请填写学号').max(100),
  class_name: z.string().trim().min(1, '请填写班级').max(100),
  college: z.string().trim().min(1, '请填写学院').max(100),
  gender: z.enum(['男', '女'], '请选择男或女'),
});
export const teacherProfileSchema = z.object({
  employee_id: z.string().trim().min(1, '请填写工号').max(100),
  employed_at: z.iso.date('请填写有效入职日期'),
  college: z.string().trim().min(1, '请填写院系').max(100),
  gender: z.enum(['男', '女'], '请选择男或女'),
});
export function profileComplete(value: { name: string; profile: unknown; kind?: string }) {
  return (
    !!value.name.trim() &&
    (value.kind === 'TEACHER' ? teacherProfileSchema : studentProfileSchema).safeParse(
      value.profile,
    ).success
  );
}
export const adminPermissions = [
  'VIEW',
  'CONTEST',
  'REGISTRATIONS',
  'FINANCE',
  'ADMISSIONS',
  'FILES',
  'SUPPORT',
  'STUDENTS',
  'INTEGRATIONS',
] as const;
export type AdminPermission = (typeof adminPermissions)[number];
export const adminPermissionLabels: Record<AdminPermission, string> = {
  VIEW: '查看竞赛',
  CONTEST: '竞赛与报名字段配置',
  REGISTRATIONS: '报名审核',
  FINANCE: '财务与开票',
  ADMISSIONS: '准考证',
  FILES: '附件分发与删除',
  SUPPORT: '工单处理',
  STUDENTS: '学生与教师视图',
  INTEGRATIONS: '竞赛平台联动',
};
export const adminLevelLabels = {
  SYSTEM: '系统管理员',
  SENIOR: '高级管理员',
  CONTEST: '竞赛管理员',
};
export const userTagsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(20)
  .transform((values) => [...new Set(values)]);
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export const participationSchema = z.enum(['OFFICIAL', 'UNOFFICIAL']);
export const organizationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  shortName: z.string().trim().min(1).max(80),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, '国家使用三位代码，例如 CHN'),
  icpcId: z.string().trim().max(40).default(''),
});
export type OrganizationInfo = z.infer<typeof organizationSchema>;
export const invoiceRequiredKeys = [
  'contactName',
  'phone',
  'address',
  'bankName',
  'bankAccount',
] as const;
export const invoiceSchema = z
  .object({
    amountCents: z.number().int().positive().max(100_000_000),
    title: z.string().trim().min(1).max(200),
    taxId: z.string().trim().max(100).default(''),
    email: z.email(),
    invoiceType: z.enum(['NORMAL', 'SPECIAL']).default('NORMAL'),
    titleType: z.enum(['PERSON', 'ENTERPRISE', 'ORGANIZATION']).default('PERSON'),
    contactName: z.string().trim().max(100).default(''),
    phone: z.string().trim().max(50).default(''),
    address: z.string().trim().max(300).default(''),
    bankName: z.string().trim().max(200).default(''),
    bankAccount: z.string().trim().max(100).default(''),
    remarks: z.string().trim().max(2000).default(''),
  })
  .superRefine((v, ctx) => {
    if ((v.titleType === 'ENTERPRISE' || v.invoiceType === 'SPECIAL') && !v.taxId)
      ctx.addIssue({ code: 'custom', path: ['taxId'], message: '企业或专票申请必须填写税号' });
    if (v.invoiceType === 'SPECIAL' && v.titleType === 'PERSON')
      ctx.addIssue({ code: 'custom', path: ['titleType'], message: '专票申请须使用单位抬头' });
  });
export const smtpServerSchema = z.object({
  enabled: z.boolean(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9._:-]+$/, '填写邮件服务器主机名，不含协议或路径'),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['TLS', 'STARTTLS', 'NONE']),
  authEnabled: z.boolean(),
  username: z.string().trim().max(254),
  password: z.string().max(2048).optional(),
  fromAddress: z.email(),
  fromName: z
    .string()
    .trim()
    .max(80)
    .regex(/^[^\r\n]*$/),
});
export const smtpFallbackSchema = smtpServerSchema.extend({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
});
export type SmtpServerInput = z.infer<typeof smtpServerSchema>;
const mailSettingsBaseSchema = smtpServerSchema.extend({
  version: z.number().int().min(0),
  fallbacks: z.array(smtpFallbackSchema).max(10).default([]),
});
export const mailSettingsSchema = mailSettingsBaseSchema.superRefine((value, ctx) => {
  if (new Set(value.fallbacks.map((s) => s.id)).size !== value.fallbacks.length)
    ctx.addIssue({ code: 'custom', path: ['fallbacks'], message: '备用 SMTP 标识不能重复' });
});
export type MailSettingsInput = z.infer<typeof mailSettingsSchema>;
export const mailSettingsViewSchema = mailSettingsBaseSchema.omit({ password: true }).extend({
  fallbacks: z.array(
    smtpFallbackSchema.omit({ password: true }).extend({ passwordConfigured: z.boolean() }),
  ),
  passwordConfigured: z.boolean(),
  source: z.enum(['DATABASE', 'ENVIRONMENT']),
});
export type MailSettingsView = z.infer<typeof mailSettingsViewSchema>;
export const accountInvitationKinds = [
  'ACCOUNT',
  'SYSTEM_ADMIN',
  'SENIOR_ADMIN',
  'CONTEST_ADMIN',
  'COACH_ROLE',
] as const;
export const accountInvitationLabels: Record<(typeof accountInvitationKinds)[number], string> = {
  ACCOUNT: '账号邀请',
  SYSTEM_ADMIN: '系统管理员',
  SENIOR_ADMIN: '高级管理员',
  CONTEST_ADMIN: '竞赛管理员',
  COACH_ROLE: '指导老师',
};
export const accountInvitationSchema = z
  .object({
    kind: z.enum(accountInvitationKinds),
    userId: uuid.optional(),
    targetEmail: z.email().optional(),
    contestId: uuid.optional(),
    expiresInDays: z.number().int().min(1).max(30).default(7),
    grantExpiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    permissions: z.array(z.enum(adminPermissions)).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.userId && !value.targetEmail)
      ctx.addIssue({ code: 'custom', message: '请指定受邀账号或邮箱', path: ['targetEmail'] });
    if ((value.kind === 'CONTEST_ADMIN') !== !!value.contestId)
      ctx.addIssue({
        code: 'custom',
        message: '仅竞赛管理员邀请需要指定竞赛',
        path: ['contestId'],
      });
  });
export type AccountInvitationInput = z.infer<typeof accountInvitationSchema>;
export const invitationReturnPathSchema = z.string().regex(/^\/invite\/[A-Za-z0-9_-]{30,100}$/);
export const answersSchema = z.record(z.string().max(80), z.json());
export const fieldSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .refine((v) => !['constructor', 'prototype', '__proto__'].includes(v)),
  label: z.string().min(1).max(100),
  scope: z.enum(['PERSON', 'TEAM', 'COACH', 'REGISTRATION']),
  type: z.enum([
    'text',
    'textarea',
    'number',
    'date',
    'select',
    'multiselect',
    'boolean',
    'file',
    'photo',
  ]),
  required: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  options: z.array(z.string().max(100)).max(100).default([]),
  help: z.string().max(500).default(''),
  group: z.string().max(100).default('基本信息'),
  locked: z.boolean().default(false),
  source: z.string().max(80).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  condition: z
    .object({ key: z.string(), equals: z.json().optional(), includes: z.string().optional() })
    .optional(),
});
export type FieldDefinition = z.infer<typeof fieldSchema>;
export const fieldsSchema = z
  .array(fieldSchema)
  .max(100)
  .superRefine((fields, ctx) => {
    const keys = new Set<string>();
    fields.forEach((f, i) => {
      const k = `${f.scope}:${f.key}`;
      if (keys.has(k))
        ctx.addIssue({ code: 'custom', path: [i, 'key'], message: '同一作用域字段键不能重复' });
      keys.add(k);
      if (['select', 'multiselect'].includes(f.type) && !f.options.length)
        ctx.addIssue({ code: 'custom', path: [i, 'options'], message: '选项不能为空' });
    });
  });
export const policySchema = z
  .object({
    mode: z.enum(['INDIVIDUAL', 'TEAM']).default('INDIVIDUAL'),
    memberMode: z.enum(['INVITE', 'MANUAL']).default('INVITE'),
    minMembers: z.number().int().min(1).max(30).default(1),
    maxMembers: z.number().int().min(1).max(30).default(1),
    coachMode: z.enum(['DISABLED', 'OPTIONAL', 'REQUIRED']).default('OPTIONAL'),
    maxCoaches: z.number().int().min(0).max(10).default(1),
    manualReview: z.boolean().default(true),
    allowUnofficial: z.boolean().default(false),
    platformProfiles: z.array(z.enum(['HYDRO_5_0_7', 'DOMJUDGE_9_0_1'])).default([]),
    feeMode: z.enum(['FREE', 'FIXED', 'PER_PERSON']).default('FREE'),
    feeCents: z.number().int().min(0).max(100_000_000).default(0),
    paymentSequence: z.enum(['REVIEW_FIRST', 'PAYMENT_FIRST']).default('REVIEW_FIRST'),
    paymentInstructions: z.string().max(10000).default(''),
    refundsEnabled: z.boolean().default(true),
    invoicesEnabled: z.boolean().default(true),
    invoiceTypes: z
      .array(z.enum(['NORMAL', 'SPECIAL']))
      .min(1)
      .default(['NORMAL']),
    invoiceRequiredFields: z.array(z.enum(invoiceRequiredKeys)).default([]),
    uniquePersonFields: z.array(z.string()).max(5).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.minMembers > p.maxMembers)
      ctx.addIssue({ code: 'custom', message: '最少人数不能超过最多人数' });
    if (p.mode === 'INDIVIDUAL' && (p.minMembers !== 1 || p.maxMembers !== 1))
      ctx.addIssue({ code: 'custom', message: '个人赛固定一人' });
    if (p.coachMode === 'REQUIRED' && !p.maxCoaches)
      ctx.addIssue({ code: 'custom', message: '必需老师时至少允许一位老师' });
  });
export type ContestPolicy = z.infer<typeof policySchema>;
export const activityModulesSchema = z.object({
  admissions: z.boolean().default(true),
  rooms: z.boolean().default(false),
  integrations: z.boolean().default(true),
});
export const contestDeletionSchema = z.object({ version: z.number().int().positive() });
export const contestSchema = z
  .object({
    version: z.number().int().optional(),
    kind: z.enum(['ACTIVITY', 'COMPETITION']).default('COMPETITION'),
    confirmModuleChanges: z.boolean().optional(),
    modules: activityModulesSchema.default(() => ({
      admissions: true,
      rooms: false,
      integrations: true,
    })),
    seatingMode: z.enum(['REGISTRATION', 'PERSON']).default('REGISTRATION'),
    title: z.string().min(2).max(200),
    season: z.string().max(40),
    description: z.string().max(30000),
    descriptionFormat: z.enum(['TEXT', 'MARKDOWN']).default('TEXT'),
    announcement: z.string().max(10000).default(''),
    location: z.string().max(300).default(''),
    startsAt: z.iso.datetime({ offset: true }),
    opensAt: z.iso.datetime({ offset: true }),
    closesAt: z.iso.datetime({ offset: true }),
    correctionUntil: z.iso.datetime({ offset: true }).nullable().optional(),
    published: z.boolean().default(false),
    archived: z.boolean().default(false),
    manuallyClosed: z.boolean().default(false),
    publicRosterEnabled: z.boolean().default(false),
    publicRosterReviews: z
      .array(z.enum(['PENDING', 'APPROVED', 'REJECTED']))
      .max(3)
      .default(['APPROVED']),
    policy: policySchema,
    fields: fieldsSchema,
  })
  .refine((c) => new Date(c.opensAt) < new Date(c.closesAt), { message: '报名截止须晚于开放时间' })
  .refine((c) => !c.correctionUntil || new Date(c.correctionUntil) >= new Date(c.closesAt), {
    message: '补正截止不能早于报名截止',
  });
export const personSchema = z.object({
  id: uuid.optional(),
  userId: uuid.nullable().optional(),
  name: z.string().trim().min(1).max(100),
  email: z.union([z.email(), z.literal('')]).default(''),
  captain: z.boolean().default(false),
  answers: answersSchema.default({}),
});
export const registrationSchema = z.object({
  version: z.number().int().positive(),
  teamName: z.string().trim().max(100).default(''),
  teamEnglishName: z.string().max(100).default(''),
  participationType: participationSchema.optional(),
  organization: organizationSchema.nullable().optional(),
  answers: answersSchema.default({}),
  people: z.array(personSchema).min(1).max(30),
  coaches: z
    .array(z.object({ id: uuid, answers: answersSchema }))
    .max(10)
    .optional(),
});
export type PersonInput = z.infer<typeof personSchema>;
export type Answers = z.infer<typeof answersSchema>;
export interface Principal {
  id: string;
  email: string;
  username: string;
  name: string;
  verified: boolean;
  isAdmin: boolean;
  isCoach: boolean;
  hasPassword: boolean;
  profileComplete: boolean;
  profile: Answers;
  version: number;
  contestIds: string[];
  kind?: 'STUDENT' | 'TEACHER';
  isSystemAdmin?: boolean;
  isSeniorAdmin?: boolean;
  adminLevel?: 'SYSTEM' | 'SENIOR' | 'CONTEST' | null;
  permissions?: Record<string, string[]>;
  grants?: {
    id: string;
    level: string;
    contestId: string | null;
    permissions: string[];
    expiresAt: string | null;
  }[];
  relatedUserIds?: string[];
  avatarUrl?: string | null;
  identityStatus?: string;
}
export type ContestStatus = 'UPCOMING' | 'OPEN' | 'CLOSED';
export function contestStatus(
  c: { opensAt: string | Date; closesAt: string | Date; manuallyClosed: boolean },
  now = new Date(),
): ContestStatus {
  if (c.manuallyClosed || now >= new Date(c.closesAt)) return 'CLOSED';
  return now < new Date(c.opensAt) ? 'UPCOMING' : 'OPEN';
}
export function quoteFee(p: ContestPolicy, n: number) {
  return p.feeMode === 'FREE' ? 0 : p.feeCents * (p.feeMode === 'PER_PERSON' ? n : 1);
}
export function fieldVisible(f: FieldDefinition, answers: Answers) {
  if (!f.condition) return true;
  const value = answers[f.condition.key];
  return f.condition.includes !== undefined
    ? Array.isArray(value) && value.includes(f.condition.includes)
    : JSON.stringify(value) === JSON.stringify(f.condition.equals);
}
export function fieldsJsonSchema(fields: FieldDefinition[], scope: FieldDefinition['scope']) {
  const properties: Record<string, unknown> = {};
  for (const f of fields.filter((f) => f.scope === scope)) {
    const type = ['number', 'boolean'].includes(f.type)
      ? f.type
      : f.type === 'multiselect'
        ? 'array'
        : 'string';
    properties[f.key] = {
      type,
      ...(f.type === 'select' ? { enum: f.key === 'gender' ? ['男', '女'] : f.options } : {}),
      ...(f.type === 'multiselect'
        ? { items: { type: 'string', enum: f.options }, uniqueItems: true }
        : {}),
      ...(f.type === 'date' ? { format: 'date' } : {}),
      ...(type === 'number'
        ? {
            ...(f.min !== undefined ? { minimum: f.min } : {}),
            ...(f.max !== undefined ? { maximum: f.max } : {}),
          }
        : type === 'string'
          ? {
              maxLength: f.max ?? (f.type === 'textarea' ? 10000 : 1000),
              ...(f.min !== undefined ? { minLength: f.min } : {}),
            }
          : {}),
    };
  }
  return { type: 'object', properties, additionalProperties: false };
}
export function registrationEligible(
  r: {
    status: string;
    review: string;
    participationType?: string;
    feeCents: number;
    netPaidCents: number;
    people: { confirmed: boolean; active: boolean }[];
    coaches: unknown[];
  },
  p: ContestPolicy,
) {
  const n = r.people.filter((x) => x.active).length;
  return (
    r.status === 'SUBMITTED' &&
    r.review !== 'REJECTED' &&
    (r.review === 'APPROVED' || (!p.manualReview && r.participationType !== 'UNOFFICIAL')) &&
    n >= p.minMembers &&
    n <= p.maxMembers &&
    r.people.filter((x) => x.active).every((x) => x.confirmed) &&
    (p.coachMode !== 'REQUIRED' || r.coaches.length > 0) &&
    (p.coachMode !== 'DISABLED' || r.coaches.length === 0) &&
    r.coaches.length <= p.maxCoaches &&
    r.netPaidCents >= r.feeCents
  );
}
export interface RegistrationEnvelopeV1 {
  schemaVersion: 1;
  sourceInstance: string;
  registrationId: string;
  registrationVersion: number;
  contest: { id: string; title: string; mode: 'INDIVIDUAL' | 'TEAM' };
  teamName: string;
  teamEnglishName?: string;
  participationType?: 'OFFICIAL' | 'UNOFFICIAL';
  organization?: OrganizationInfo;
  people: { id?: string; name?: string; captain: boolean; email?: string; answers?: Answers }[];
  form?: { version: number; fields: FieldDefinition[]; answers: Answers };
  coaches?: { id: string; name?: string; email?: string; answers: Answers }[];
  qualification?: { eligible: boolean; review: string; feeCents?: number; netPaidCents?: number };
}
export interface ProvisioningResultV1 {
  schemaVersion: 1;
  registrationId: string;
  state: 'VERIFIED' | 'FAILED' | 'ACCOUNT_CREATED' | 'TEAM_CREATED';
  remoteUserId?: string;
  remoteTeamId?: string;
  username?: string;
  error?: string;
  verification?: Record<string, unknown>;
}
export interface ConnectorConfiguration {
  baseUrl: string;
  credentials: { username?: string; password?: string; token?: string };
  remoteContestId: string;
  domainId: string;
  groupIds: string[];
  organizationId?: string;
  importMode?: 'FOLLOW' | 'FORCE_UNOFFICIAL';
  includeUnofficial?: boolean;
  unofficialGroupId?: string;
  nickname?: boolean;
}
export interface ProvisioningInput {
  envelope: RegistrationEnvelopeV1;
  username: string;
  password: string;
  remoteTeamId?: string;
  remoteUserId?: string;
  allowSharedTeamUpdate?: boolean;
  onProgress?: (result: ProvisioningResultV1) => Promise<void>;
}
export const provisioningResultSchema = z.object({
  schemaVersion: z.literal(1),
  registrationId: uuid,
  state: z.enum(['VERIFIED', 'FAILED', 'ACCOUNT_CREATED', 'TEAM_CREATED']),
  remoteUserId: z.string().max(100).optional(),
  remoteTeamId: z.string().max(100).optional(),
  username: z.string().max(100).optional(),
  error: z.string().max(1500).optional(),
  verification: z.record(z.string(), z.json()).optional(),
});
export const registrationEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  sourceInstance: uuid,
  registrationId: uuid,
  registrationVersion: z.number().int(),
  contest: z.object({ id: uuid, title: z.string(), mode: z.enum(['INDIVIDUAL', 'TEAM']) }),
  teamName: z.string(),
  teamEnglishName: z.string().optional(),
  participationType: participationSchema.optional(),
  organization: organizationSchema.optional(),
  people: z.array(
    z.object({
      id: uuid.optional(),
      name: z.string().optional(),
      captain: z.boolean(),
      email: z.string().optional(),
      answers: answersSchema.optional(),
    }),
  ),
  form: z
    .object({ version: z.number().int(), fields: fieldsSchema, answers: answersSchema })
    .optional(),
  coaches: z
    .array(
      z.object({
        id: uuid,
        name: z.string().optional(),
        email: z.string().optional(),
        answers: answersSchema,
      }),
    )
    .optional(),
  qualification: z
    .object({
      eligible: z.boolean(),
      review: z.string(),
      feeCents: z.number().int().optional(),
      netPaidCents: z.number().int().optional(),
    })
    .optional(),
});
export interface ContestPlatformConnector {
  probe(config: ConnectorConfiguration): Promise<{ version: string; capabilities: string[] }>;
  provisionRegistration(
    config: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1>;
  getProvisioningResult(
    config: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1>;
}
export interface PaymentProvider {
  createPayment(order: { id: string; amountCents: number }): Promise<{ url: string }>;
  verifyCallback(payload: unknown, signature: string): Promise<boolean>;
  queryPayment(id: string): Promise<{ paidCents: number }>;
  refund(id: string, amountCents: number): Promise<string>;
}

export const defaultFields: FieldDefinition[] = fieldsSchema.parse([
  { key: 'school', label: '学校 / 单位', scope: 'PERSON', type: 'text' },
  {
    key: 'student_id',
    label: '学号 / 参赛编号',
    scope: 'PERSON',
    type: 'text',
    required: true,
    sensitive: true,
  },
  { key: 'class_name', label: '班级', scope: 'PERSON', type: 'text', required: true },
  { key: 'college', label: '学院', scope: 'PERSON', type: 'text', required: true },
  {
    key: 'gender',
    label: '性别',
    scope: 'PERSON',
    type: 'select',
    required: true,
    options: ['男', '女'],
  },
  { key: 'major', label: '专业', scope: 'PERSON', type: 'text' },
  {
    key: 'phone',
    label: '联系电话',
    scope: 'PERSON',
    type: 'text',
    required: true,
    sensitive: true,
  },
  {
    key: 'size',
    label: '衣服尺码',
    scope: 'PERSON',
    type: 'select',
    options: ['S', 'M', 'L', 'XL', '2XL', '3XL'],
  },
]);
export const defaultTemplate = String.raw`\documentclass[UTF8,fontset=fandol,a4paper,12pt]{ctexart}
\usepackage[margin=22mm]{geometry}
\usepackage{longtable,array}
\pagestyle{empty}
\begin{document}
\begin{center}{\LARGE\bfseries {{contest.title}}}\\[8mm]{\Large 准考证}\end{center}
\vspace{5mm}
\noindent 准考证号：{{admission.number}}\\[3mm]
比赛时间：{{contest.startsAt}}\\[3mm]
考点：{{admission.location}}\quad 考场：{{admission.room}}\quad 座位：{{admission.seat}}\\[3mm]
{{#if team.name}}队伍名称：{{team.name}}\\[3mm]{{/if}}
\begin{longtable}{|p{25mm}|p{65mm}|p{35mm}|}\hline
姓名 & 学校 / 单位 & 队长\\\hline
{{#each team.members}}{{this.name}} & {{this.answers.school}} & {{this.captainLabel}}\\\hline
{{/each}}
\end{longtable}
\vspace{6mm}\noindent 请携带有效身份证件及本准考证，按竞赛公告要求提前到场。\\[3mm]
本准考证按报名单位发放，团队成员共用一张。
\end{document}`;

export * from './activity-workflows.js';
