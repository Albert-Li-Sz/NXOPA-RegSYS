import { z } from 'zod';
import {
  contestSchema,
  platformExportSchema,
  examSiteSchema,
  contestDeletionSchema,
  roomSchema,
  seatingRequestSchema,
  seatingClearSchema,
  seatingPreviewSchema,
  registrationDeletionSchema,
  registrationCancellationSchema,
  registrationDeletionReceiptSchema,
  registrationActionsSchema,
  registrationSchema,
  fieldSchema,
  registrationEnvelopeSchema,
  accountInvitationSchema,
  accountInvitationKinds,
  invitationReturnPathSchema,
  mailSettingsSchema,
  mailSettingsViewSchema,
  invoiceSchema,
  organizationSchema,
  participationSchema,
  adminPermissions,
  userTagsSchema,
  institutionInputSchema,
} from '@contest-center/contracts';
import type { OpenAPIObject } from '@nestjs/swagger';
const id = z.string().uuid(),
  version = z.number().int(),
  text = z.string(),
  cents = z.number().int().positive(),
  date = z.iso.datetime({ offset: true });
const object = (shape: z.ZodRawShape) => z.object(shape);
export function describeApi(document: OpenAPIObject) {
  document.components ??= {};
  document.components.securitySchemes ??= {};
  document.components.securitySchemes.hostCookie = {
    type: 'apiKey',
    in: 'cookie',
    name: '__Host-cc_session',
    description: 'HTTPS host-only browser session; cc_session is used only on HTTP entrances',
  };
  for (const scheme of Object.values(document.components?.securitySchemes ?? {}))
    if ('type' in scheme && scheme.type === 'http' && scheme.scheme === 'bearer')
      scheme.bearerFormat = 'Opaque';
  let schemaSequence = 0;
  const schema = (s: z.ZodType) => {
    const data = z.toJSONSchema(s, { target: 'openapi-3.0', unrepresentable: 'any' }) as any;
    const definitions = data.definitions ?? {};
    const prefix = `Value${schemaSequence++}_`;
    const replace = (value: any): any =>
      Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([k]) => k !== 'definitions')
                .map(([k, v]) => [
                  k,
                  k === '$ref' && typeof v === 'string' && v.startsWith('#/definitions/')
                    ? v.replace('#/definitions/', `#/components/schemas/${prefix}`)
                    : replace(v),
                ]),
            )
          : value;
    document.components ??= {};
    document.components.schemas ??= {};
    for (const [name, d] of Object.entries(definitions))
      document.components.schemas[prefix + name] = replace(d);
    return replace(data);
  };
  const named: Record<string, z.ZodType> = {
    PageResult: object({
      items: z.array(z.unknown()),
      total: z.number().int(),
      page: z.number().int(),
      pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]),
    }),
    ContestInput: contestSchema,
    ExamSite: examSiteSchema,
    RoomInput: roomSchema,
    SeatingRequest: seatingRequestSchema,
    SeatingPreview: seatingPreviewSchema,
    RegistrationDeletionReceipt: registrationDeletionReceiptSchema,
    RegistrationActions: registrationActionsSchema,
    RegistrationInput: registrationSchema,
    FieldDefinition: fieldSchema,
    InstitutionInput: institutionInputSchema,
    RegistrationEnvelopeV1: registrationEnvelopeSchema,
    AccountInvitationInput: accountInvitationSchema,
    MailSettingsInput: mailSettingsSchema,
    MailSettingsView: mailSettingsViewSchema,
    InvitationLink: object({
      id,
      kind: z.enum([...accountInvitationKinds, 'MEMBER', 'COACH', 'COACH_LINK']),
      url: z.url(),
      expiresAt: date,
    }),
    Job: object({
      id,
      state: text,
      kind: text,
      attempts: version,
      error: text.nullable().optional(),
      result: z.unknown().optional(),
    }),
    Error: object({ message: text, statusCode: version.optional() }),
  };
  document.components ??= {};
  document.components.schemas ??= {};
  for (const [name, s] of Object.entries(named))
    document.components.schemas[name] = schema(s) as never;
  const bodies: Record<string, z.ZodType | string> = {
    'post /api/v1/auth/reauth': object({
      password: text.max(128).optional(),
      code: z
        .string()
        .regex(/^\d{6}$/)
        .optional(),
    }),
    'put /api/v1/admin/webhooks/{id}': object({
      version,
      enabled: z.boolean().optional(),
      rotateSecret: z.boolean().optional(),
      revokePrivate: z.boolean().optional(),
    }),
    'delete /api/v1/admin/webhooks/{id}': object({ version }),
    'post /api/v1/finance/{id}/reconciliation': object({ reason: text.min(1).max(3000) }),
    'post /api/v1/finance/{id}/attribution': object({
      kind: z.enum(['vouchers', 'refunds', 'invoices']),
      recordId: id,
      createdBy: id,
      reason: text.min(1).max(3000),
    }),
    'put /api/v1/admin/storage': object({
      version,
      mode: z.enum(['LOCAL', 'S3']),
      name: text.optional(),
      endpoint: text.optional(),
      region: text.optional(),
      bucket: text.optional(),
      prefix: text.optional(),
      accessKey: text.optional(),
      secretKey: text.optional(),
      forcePathStyle: z.boolean().optional(),
      createBucket: z.boolean().optional(),
    }),
    'post /api/v1/admin/grants': object({
      userId: id,
      level: z.enum(['SYSTEM', 'SENIOR', 'CONTEST']),
      contestId: id.nullable().optional(),
      permissions: z.array(z.enum(adminPermissions)).optional(),
      expiresAt: date.nullable().optional(),
    }),
    'post /api/v1/admin/identities/{id}/review': object({
      decision: z.enum(['APPROVED', 'REJECTED']),
      reason: text.optional(),
    }),
    'post /api/v1/auth/identity': object({
      kind: z.enum(['STUDENT', 'TEACHER']),
      name: text,
      profile: z.record(text, z.json()),
      version,
    }),
    'post /api/v1/auth/verify-code': object({ code: z.string().regex(/^\d{6}$/) }),
    'post /api/v1/auth/reset-code': object({
      code: z.string().regex(/^\d{6}$/),
      email: z.email(),
      password: z.string().min(10).max(128),
    }),
    'delete /api/v1/auth/account': object({
      confirmation: z.literal('注销账号'),
      password: text.optional(),
      code: text.optional(),
    }),
    'put /api/v1/admin/mail/templates/{key}': object({
      version,
      enabled: z.boolean(),
      subject: text,
      text: text,
      html: text,
    }),
    'put /api/v1/registrations/{id}/public-rank': object({
      rank: z.number().int().positive().nullable(),
      expectedRank: z.number().int().nullable().optional(),
    }),
    'post /api/v1/contests/{id}/files/distribute': object({
      attachmentId: id,
      registrationIds: z.array(id).min(1).max(500),
    }),
    'put /api/v1/admin/github': object({
      version,
      enabled: z.boolean(),
      clientId: text,
      clientSecret: text.optional(),
      callbackUrl: text.optional(),
    }),
    'put /api/v1/admin/users/{id}/tags': object({ version, tags: userTagsSchema }),
    'delete /api/v1/registrations/{id}': registrationDeletionSchema,
    'post /api/v1/contests/{id}/rooms': roomSchema,
    'put /api/v1/contests/{id}/rooms/{roomId}': roomSchema,
    'delete /api/v1/contests/{id}/rooms/{roomId}': object({ version }),
    'post /api/v1/contests/{id}/seating/preview': seatingRequestSchema,
    'post /api/v1/contests/{id}/seating/commit': seatingRequestSchema,
    'post /api/v1/contests/{id}/seating/clear': seatingClearSchema,
    'post /api/v1/auth/register': object({
      email: z.email(),
      username: text,
      password: text,
      name: text,
      token: text,
      code: z.string().regex(/^\d{6}$/),
      feishuClaim: text.optional(),
      kind: z.enum(['STUDENT', 'TEACHER']).optional(),
      identifier: text.optional(),
      enrollmentYear: z.number().int().optional(),
      employedAt: z.iso.date().optional(),
      next: invitationReturnPathSchema.optional(),
    }),
    'post /api/v1/auth/register/code': object({
      email: z.email(),
      next: invitationReturnPathSchema.optional(),
    }),
    'put /api/v1/admin/users/{id}': object({
      version,
      name: text,
      email: z.email(),
      username: text,
      profile: z.record(text, z.unknown()),
      tags: z.array(text),
    }),
    'put /api/v1/admin/users/{id}/ban': object({
      version,
      banned: z.boolean(),
      reason: text.optional(),
    }),
    'delete /api/v1/admin/users/{id}': object({ version, confirmation: z.literal('删除账号') }),
    'post /api/v1/auth/login': object({ account: text, password: text }),
    'post /api/v1/auth/forgot': object({ email: z.email() }),
    'post /api/v1/auth/verify': object({ token: text }),
    'post /api/v1/auth/resend': object({ next: invitationReturnPathSchema.optional() }),
    'post /api/v1/auth/reset': object({ token: text, password: text }),
    'put /api/v1/auth/profile': object({
      version,
      name: text,
      isCoach: z
        .boolean()
        .optional()
        .describe(
          'Read-only compatibility field. Identity changes require an authorization invitation.',
        ),
      profile: z.record(text, z.unknown()),
      email: z.email().optional(),
    }),
    'post /api/v1/contests': 'ContestInput',
    'put /api/v1/contests/{id}': 'ContestInput',
    'delete /api/v1/contests/{id}': contestDeletionSchema,
    'post /api/v1/registrations': object({ contestId: id }),
    'put /api/v1/registrations/{id}': 'RegistrationInput',
    'post /api/v1/registrations/{id}/submit': object({ version }),
    'post /api/v1/registrations/{id}/cancel': registrationCancellationSchema,
    'post /api/v1/registrations/{id}/withdraw': object({ version }),
    'post /api/v1/registrations/{id}/review': object({
      version,
      decision: z.enum(['APPROVED', 'CORRECTION', 'REJECTED']),
      participationType: participationSchema.optional(),
      reason: text.optional(),
    }),
    'post /api/v1/registrations/{id}/invites': object({
      kind: z.enum(['MEMBER', 'COACH']),
      targetEmail: z.email().optional(),
    }),
    'post /api/v1/coach/links': object({ kind: z.literal('COACH_LINK') }),
    'post /api/v1/invitations/{token}/accept': object({ registrationId: id.optional() }),
    'delete /api/v1/registrations/{id}/coaches/{coachId}': object({ version }),
    'put /api/v1/registrations/{id}/coaches/{coachId}': object({
      version,
      answers: z.record(text, z.unknown()),
    }),
    'put /api/v1/registrations/{id}/people/{personId}': object({
      version,
      name: text,
      answers: z.record(text, z.unknown()),
    }),
    'post /api/v1/finance/{id}/vouchers': object({
      amountCents: cents,
      channel: text,
      reference: text.optional(),
      payer: text,
      paidAt: date,
      attachmentId: id,
    }),
    'post /api/v1/finance/vouchers/{id}/review': object({
      decision: z.enum(['CONFIRMED', 'REJECTED']),
      amountCents: cents.optional(),
      reference: text.optional(),
      reason: text.optional(),
    }),
    'post /api/v1/finance/ledger/{id}/reverse': object({ reason: text }),
    'post /api/v1/finance/{id}/refunds': object({ amountCents: cents, reason: text }),
    'post /api/v1/finance/refunds/{id}/review': object({
      decision: z.enum(['APPROVED', 'REJECTED', 'COMPLETED']),
      reference: text.optional(),
      attachmentId: id.optional(),
      reason: text.max(3000).optional(),
    }),
    'post /api/v1/finance/{id}/invoices': invoiceSchema,
    'post /api/v1/finance/invoices/{id}/review': object({
      decision: z.enum(['ISSUED', 'REJECTED', 'VOID']),
      attachmentId: id.optional(),
      reason: text.optional(),
    }),
    'post /api/v1/support': object({
      contestId: id.optional(),
      registrationId: id.optional(),
      title: text,
      category: text,
      text,
      attachments: z.array(id).optional(),
    }),
    'post /api/v1/support/{id}/messages': object({
      version,
      text,
      attachments: z.array(id).optional(),
      status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED']).optional(),
    }),
    'post /api/v1/admissions/templates': object({
      contestId: id.optional(),
      version: z.number().int().min(0).optional(),
      name: text,
      source: text,
    }),
    'post /api/v1/admissions/preview': object({ contestId: id.optional(), source: text }),
    'post /api/v1/admissions/batch': object({
      ids: z.array(id).min(1).max(1000).optional(),
      registrationIds: z.array(id).min(1).max(1000).optional(),
    }),
    'post /api/v1/admissions/generate': object({
      registrationIds: z.array(id),
      location: text.optional(),
      room: text.optional(),
      seat: text.optional(),
      incrementSeats: z.boolean().optional(),
      numberPrefix: text.optional(),
      releaseAt: date.optional(),
      seats: z
        .array(
          object({
            registrationId: id,
            number: text.optional(),
            location: text.optional(),
            room: text,
            seat: text,
          }),
        )
        .optional(),
    }),
    'post /api/v1/contests/{id}/platform-exports': platformExportSchema,
    'post /api/v1/admin/tokens': object({
      name: text,
      contestIds: z.array(id),
      scopes: z.array(text),
      fields: z.array(text),
      expiresAt: date,
    }),
    'post /api/v1/admin/webhooks': object({
      contestId: id.optional(),
      url: z.url(),
      allowPrivate: z.boolean().default(false),
    }),
    'post /api/v1/admin/fields': 'FieldDefinition',
    'post /api/v1/admin/institutions': 'InstitutionInput',
    'put /api/v1/admin/institutions/{id}': 'InstitutionInput',
    'post /api/v1/admin/roles': object({
      userId: id,
      contestId: id.optional(),
      isAdmin: z.boolean().optional(),
      isCoach: z.boolean().optional(),
      grant: z.boolean().optional(),
    }),
    'post /api/v1/admin/invitations': 'AccountInvitationInput',
    'put /api/v1/admin/site': object({
      version,
      name: text,
      primaryColor: text,
      footer: text.optional(),
      publicUrl: z.url().optional(),
      trustedOrigins: z.array(z.url()).max(50).optional(),
    }),
    'put /api/v1/admin/mail': 'MailSettingsInput',
    'post /api/v1/admin/mail/probe': object({ version, providerId: text.optional() }),
    'post /api/v1/admin/mail/templates/{key}/test': object({ version }),
    'put /api/v1/admin/feishu': object({
      version,
      enabled: z.boolean(),
      appId: text,
      appSecret: text.optional(),
      callbackUrl: text.optional(),
    }),
    'post /api/v1/admin/mail/test': object({ version }),
  };
  for (const [url, item] of Object.entries(document.paths))
    for (const [method, raw] of Object.entries(item ?? {})) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      const op = raw as any;
      const external = url.startsWith('/api/automation') || url.startsWith('/api/integration');
      const publicPath =
        (method === 'post' &&
          [
            '/api/v1/auth/login',
            '/api/v1/auth/register',
            '/api/v1/auth/register/code',
            '/api/v1/auth/forgot',
            '/api/v1/auth/verify',
            '/api/v1/auth/reset',
            '/api/v1/auth/reset-code',
          ].includes(url)) ||
        (url.startsWith('/api/v1/auth/feishu') && method === 'get') ||
        ([
          '/api/v1/health',
          '/api/v1/live',
          '/api/v1/site',
          '/api/v1/contests',
          '/api/v1/contests/{id}',
          '/api/v1/contests/{id}/public-teams',
          '/api/v1/contests/{id}/public-teams/export',
          '/api/v1/files/public/{id}',
          '/api/v1/auth/me',
          '/api/v1/auth/verify',
          '/api/v1/auth/providers',
          '/api/v1/auth/github',
          '/api/v1/auth/github/callback',
        ].includes(url) &&
          method === 'get');
      op.responses ??= {};
      op.security = external
        ? [{ bearer: [] }]
        : publicPath
          ? []
          : [{ cookie: [] }, { hostCookie: [] }];
      if (
        external &&
        [
          '/api/automation/v1/registrations',
          '/api/automation/v1/finance',
          '/api/integration/v1/registrations',
        ].includes(url)
      ) {
        const queries = ['contestId', ...(url.endsWith('/registrations') ? ['cursor'] : [])];
        op.parameters = [
          ...(op.parameters ?? []).filter((p: any) => !queries.includes(p.name)),
          ...queries.map((name) => ({
            name,
            in: 'query',
            required: name === 'contestId' && url !== '/api/automation/v1/registrations',
            schema: { type: 'string', format: 'uuid' },
          })),
        ];
      }
      if (method === 'post' && ['/api/v1/admin/tokens', '/api/v1/admin/webhooks'].includes(url)) {
        const secret = url.endsWith('/tokens') ? 'token' : 'secret';
        op.responses['201'] = {
          description: 'Created; secret is returned only once',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id', secret],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  [secret]: { type: 'string' },
                  ...(secret === 'token'
                    ? { expiresAt: { type: 'string', format: 'date-time' } }
                    : {}),
                },
              },
            },
          },
        };
      }
      op.tags = [external ? 'External API' : (url.split('/')[3] ?? 'System')];
      op.responses ??= {};
      for (const status of ['400', '401', '403', '404', '409', '429'])
        op.responses[status] = {
          description: (
            {
              400: 'Validation failed',
              401: 'Authentication required',
              403: 'Scope or role denied',
              404: 'Record missing',
              409: 'Version conflict or duplicate identity',
              429: 'Rate limit exceeded',
            } as Record<string, string>
          )[status],
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        };
      if (method !== 'get' && !external && !publicPath)
        op.parameters = [
          ...(op.parameters ?? []),
          { name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' } },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string', maxLength: 200 },
            description: 'Same actor, method, URL and body replay the encrypted saved result.',
          },
        ];
      if (
        method === 'get' &&
        ([
          '/api/v1/admin/jobs',
          '/api/v1/admin/users',
          '/api/v1/admin/institutions',
          '/api/v1/institutions',
          '/api/v1/admin/students',
          '/api/v1/admin/teachers',
          '/api/v1/admin/invitations',
          '/api/v1/admin/audit',
          '/api/v1/registrations',
          '/api/v1/support',
          '/api/v1/contests',
          '/api/v1/files',
          '/api/v1/notifications/mail',
        ].includes(url) ||
          url.endsWith('/finance/{collection}') ||
          url.endsWith('/schools'))
      ) {
        op.parameters = [
          ...(op.parameters ?? []).filter((p: any) => !['page', 'pageSize'].includes(p.name)),
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          {
            name: 'pageSize',
            in: 'query',
            required: false,
            schema: { type: 'integer', enum: [20, 50, 100], default: 20 },
          },
          ...['search', 'status', 'review', 'participationType', 'from', 'to'].map((name) => ({
            name,
            in: 'query' as const,
            required: false,
            schema: { type: 'string' },
          })),
        ];
        op.description =
          '显式传入 page 或 pageSize 返回 PageResult，列表与总数使用相同权限和筛选条件。旧调用保持数组／游标形式。';
        op.responses['200'] = {
          description: '分页结果或兼容数组',
          content: {
            'application/json': {
              schema: {
                oneOf: [{ $ref: '#/components/schemas/PageResult' }, { type: 'array', items: {} }],
              },
            },
          },
        };
      }
      if (
        (url === '/api/v1/registrations/{id}' && method === 'delete') ||
        (url === '/api/v1/registrations/{id}/cancel' && method === 'post')
      ) {
        op.description =
          'Permanently removes registration data, releases seats and invalidates admissions. Settlement data survives in an independent finance account; cancellation does not automatically refund. Creator may cancel; scoped registration managers may delete with a reason.';
        op.responses[method === 'post' ? '201' : '200'] = {
          description: 'Deletion receipt',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RegistrationDeletionReceipt' },
            },
          },
        };
      }
      if (url === '/api/v1/contests/{id}/platform-exports' && method === 'post') {
        op.description =
          'INTEGRATIONS permission required. Exports qualified registrations as an import ZIP; never contacts a judging platform. Hydro, DOMjudge and admission PDFs share the participant/captain student-ID username and one encrypted stable random password per registration. DOMjudge team/account IDs and team_id use the registration UUID. Maximum 10000 registrations and 50 MB. Response is no-store and is excluded from idempotency replay.';
        op.parameters = op.parameters.filter((p: any) => p.name !== 'Idempotency-Key');
        op.responses['201'] = {
          description: 'Platform import ZIP with plaintext competition credentials',
          content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
        };
      }
      if (url.endsWith('/seating/preview') || url.endsWith('/seating/commit')) {
        op.description =
          'ADMISSIONS permission required. Preview does not mutate data. Commit requires the preview seatingVersion and registrationVersions; validation errors abort the entire allocation. Rooms must belong to the registration selected exam site. Registrations without a site must be updated before allocation when exam sites are configured.';
        op.responses['201'] = {
          description: 'Allocation preview/result',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SeatingPreview' } },
          },
        };
      }
      if (
        method === 'get' &&
        [
          '/api/v1/registrations',
          '/api/v1/registrations/summary',
          '/api/v1/registrations/export',
          '/api/v1/registrations/review-queue',
          '/api/v1/contests/{id}/statistics',
        ].includes(url)
      ) {
        op.parameters = [
          ...(op.parameters ?? []),
          {
            name: 'examSiteId',
            in: 'query',
            required: false,
            description: '筛选参赛考点，与列表、统计、审核队列及导出共用权限范围。',
            schema: { type: 'string', format: 'uuid' },
          },
        ];
      }
      if (url.startsWith('/api/v1/finance/accounts'))
        op.description =
          'Independent settlement account. Owners can access their own accounts; listing by contestId requires FINANCE permission unless role=mine. Source registration may be permanently deleted. Account detail returns policy for historical fees/refunds and invoicePolicy for current invoice types, enabled status and required fields.';
      if (url === '/api/v1/finance/vouchers/{id}/review')
        op.description =
          'FINANCE permission required. Confirmation cannot change the declared amount; optional amountCents must match it. A nonempty channel/reference pair is required and cannot be credited twice. Owners and proof uploaders cannot confirm their own vouchers.';
      if (url === '/api/v1/registrations/export')
        op.description =
          'REGISTRATIONS permission required. CSV contains one active member per row, separate columns for every current or historical PERSON/TEAM/REGISTRATION/COACH field, and formula-safe escaped cells. FINANCE permission adds yuan totals on the first member row only. Maximum 10000 members, 500 columns and 25 MB per export; export filters and counts are audited.';
      if (url === '/api/v1/registrations/review-queue') {
        op.description =
          'Scoped REGISTRATIONS permission required. Returns all submitted IDs matching the current list filters in review order, independent of page size; defaults to pending review.';
        op.responses['200'] = {
          description: 'Review queue',
          content: { 'application/json': { schema: schema(object({ ids: z.array(id) })) } },
        };
      }
      if (url === '/api/v1/contests' && method === 'get') {
        op.parameters = [
          ...(op.parameters ?? []).filter(
            (p: any) => p.in !== 'query' || ['page', 'pageSize', 'search'].includes(p.name),
          ),
          ...['all', 'managed'].map((name) => ({
            name,
            in: 'query' as const,
            required: false,
            schema: { type: 'boolean' },
          })),
        ];
        op.description =
          '兼容原数组；传 page/pageSize 返回分页列表。managed=true 仅返回当前账号具有查看管理权限的活动，包含 registrationCounts.official/unofficial，按已提交及待补正报名中的有效成员人数统计，不含草稿、已撤回或删除报名，也不含指导老师。团队按成员人数计。';
      }
      if (url === '/api/v1/contests/{id}' && method === 'delete') {
        op.description =
          '仅系统管理员或高级管理员可永久删除无报名、无财务账户的活动。必须提供当前 version；草稿同样阻止删除。保留上传者私有附件和独立工单，撤销活动授权并清理配置、考场及平台关联。';
        op.responses['200'] = {
          description: 'Activity permanently deleted',
          content: {
            'application/json': {
              schema: schema(object({ deleted: z.literal(true), contestId: id })),
            },
          },
        };
      }
      if (url === '/api/v1/integrations/revocations' && method === 'get') {
        op.parameters = [
          {
            name: 'contestId',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'uuid' },
          },
        ];
        op.description =
          '指定活动需 INTEGRATIONS 权限；不指定活动仅系统管理员与高级管理员可查看全部待办，包含已删除活动。';
      }
      if (url === '/api/v1/files' && method === 'get') {
        op.parameters = [
          ...(op.parameters ?? []).filter(
            (p: any) => p.in !== 'query' || ['page', 'pageSize', 'search'].includes(p.name),
          ),
          ...['contestId', 'registrationId'].map((name) => ({
            name,
            in: 'query' as const,
            required: false,
            schema: { type: 'string', format: 'uuid' },
          })),
        ];
        op.description =
          '按账号、报名关联或 FILES 管理权限筛选附件。支持分页与名称搜索，权限条件同时作用于列表和总数。旧调用返回数组，个人附件旧调用最多 500 条；分页可读取更早记录。';
      }
      if (url === '/api/v1/notifications/mail' && method === 'get') {
        op.parameters = [
          ...(op.parameters ?? []).filter(
            (p: any) => p.in !== 'query' || ['page', 'pageSize'].includes(p.name),
          ),
          {
            name: 'resourceId',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ];
        op.description =
          '按创建时间与 ID 降序分页，合并邮件任务和未派发事件。必须有对应账号、报名、财务或工单资源的访问权限；其他收件人邮箱保持脱敏，重发操作独立校验。旧调用最多返回 200 条。';
      }
      const body = bodies[`${method} ${url}`];
      if (url === '/api/v1/auth/sessions' && method === 'get') {
        op.parameters = [
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          {
            name: 'pageSize',
            in: 'query',
            required: false,
            schema: { type: 'integer', enum: [20, 50, 100], default: 20 },
          },
        ];
        op.description =
          '仅返回当前账号尚未过期的会话，默认每页 20 条，可选择 20、50、100 条。显式传入 page 或 pageSize 返回分页结果；旧调用返回最多 20 条的数组。';
        op.responses['200'] = {
          description: '当前账号的登录会话',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    allOf: [
                      { $ref: '#/components/schemas/PageResult' },
                      {
                        type: 'object',
                        properties: {
                          pageSize: { type: 'integer', enum: [20, 50, 100] },
                          items: { type: 'array', maxItems: 100, items: {} },
                        },
                      },
                    ],
                  },
                  { type: 'array', maxItems: 20, items: {} },
                ],
              },
            },
          },
        };
      }
      if (url === '/api/v1/admin/mail' && ['get', 'put'].includes(method)) {
        op.description =
          'System administrators only. Passwords are encrypted, never returned and preserved when left blank. Database settings override environment defaults for subsequent worker jobs.';
        op.responses['200'] = {
          description: 'Mail settings without passwords',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/MailSettingsView' } },
          },
        };
      }
      if (url === '/api/v1/admin/mail/test' && method === 'post') {
        op.description =
          'Queue a persistent test email to the current administrator. Poll the returned job ID at /api/v1/admin/mail/tests/{id}. Never accepts an arbitrary recipient.';
        op.responses['201'] = {
          description: 'Persistent test mail queued',
          content: { 'application/json': { schema: schema(object({ jobId: id, to: z.email() })) } },
        };
      }
      if (url === '/api/v1/admin/roles' && method === 'post')
        op.description =
          'Positive role grants generate a targeted invitation URL without granting permissions. The verified recipient must POST acceptance. Negative grants revoke permissions and pending invitations immediately. Choose exactly one of contestId, isAdmin or isCoach.';
      if (url === '/api/v1/admin/invitations' && method === 'post') {
        op.description =
          'Create an account or role invitation for an existing user or specified email. Raw invitation URLs are returned only at creation; list and audit responses contain no token.';
        op.responses['201'] = {
          description: 'Invitation awaiting explicit acceptance',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/InvitationLink' } },
          },
        };
      }
      if (url === '/api/v1/invitations/{token}' && method === 'get')
        op.description =
          'Preview an invitation for the authenticated recipient. Opening this URL never changes permissions.';
      if (url === '/api/v1/invitations/{token}/accept' && method === 'post')
        op.description =
          'Explicitly accept a valid invitation as its verified recipient. Single-use, transactional and safe to retry. Replaying an accepted invitation never restores revoked permissions.';
      if (body)
        op.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema:
                typeof body === 'string' ? { $ref: `#/components/schemas/${body}` } : schema(body),
            },
          },
        };
      if (url === '/api/v1/files' && method === 'post')
        op.requestBody = {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        };
      if (url === '/api/integration/v1/registrations' && method === 'get')
        op.responses['200'] = {
          description: 'Eligible registrations with field permissions applied',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: '#/components/schemas/RegistrationEnvelopeV1' },
              },
            },
          },
        };
      if (url.endsWith('/jobs/{id}') && method === 'get')
        op.responses['200'] = {
          description: 'Persistent job state',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } },
        };
      for (const [, name] of url.matchAll(/\{([^}]+)\}/g)) {
        op.parameters ??= [];
        if (!op.parameters.some((p: any) => p.in === 'path' && p.name === name))
          op.parameters.push({
            name,
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              ...(['id', 'roomId', 'personId'].includes(name!) ? { format: 'uuid' } : {}),
            },
          });
      }
    }
  return document;
}
