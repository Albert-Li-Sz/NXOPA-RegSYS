import { z } from 'zod';
import {
  contestSchema,
  registrationSchema,
  fieldSchema,
  registrationEnvelopeSchema,
  provisioningResultSchema,
  accountInvitationSchema,
  accountInvitationKinds,
  invitationReturnPathSchema,
  mailSettingsSchema,
  mailSettingsViewSchema,
  invoiceSchema,
  organizationSchema,
  participationSchema,
} from '@contest-center/contracts';
import type { OpenAPIObject } from '@nestjs/swagger';
const id = z.string().uuid(),
  version = z.number().int(),
  text = z.string(),
  cents = z.number().int().positive(),
  date = z.iso.datetime({ offset: true });
const object = (shape: z.ZodRawShape) => z.object(shape);
export function describeApi(document: OpenAPIObject) {
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
    RegistrationInput: registrationSchema,
    FieldDefinition: fieldSchema,
    RegistrationEnvelopeV1: registrationEnvelopeSchema,
    ProvisioningResultV1: provisioningResultSchema,
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
    'post /api/v1/auth/register': object({
      email: z.email(),
      username: text,
      password: text,
      name: text,
      next: invitationReturnPathSchema.optional(),
    }),
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
    'post /api/v1/registrations': object({ contestId: id }),
    'put /api/v1/registrations/{id}': 'RegistrationInput',
    'post /api/v1/registrations/{id}/submit': object({ version }),
    'post /api/v1/registrations/{id}/cancel': object({ version }),
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
      reason: text.optional(),
    }),
    'post /api/v1/finance/ledger/{id}/reverse': object({ reason: text }),
    'post /api/v1/finance/{id}/refunds': object({ amountCents: cents, reason: text }),
    'post /api/v1/finance/refunds/{id}/review': object({
      decision: z.enum(['APPROVED', 'REJECTED', 'COMPLETED']),
      reference: text.optional(),
      attachmentId: id.optional(),
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
    'post /api/v1/integrations/bindings': object({
      contestId: id,
      instanceId: id,
      remoteContestId: text,
      domainId: text.optional(),
      groupIds: z.array(text).optional(),
      organizationId: text.nullish(),
      version: version.optional(),
      importMode: z.enum(['FOLLOW', 'FORCE_UNOFFICIAL']).optional(),
      includeUnofficial: z.boolean().optional(),
      nickname: z.boolean().optional(),
      unofficialGroupId: text.nullable().optional(),
      automatic: z.boolean().optional(),
      enabled: z.boolean().optional(),
    }),
    'post /api/v1/integrations/registrations/{id}/sync': object({ bindingId: id }),
    'put /api/v1/integrations/bindings/{id}/schools/{schoolId}': organizationSchema.extend({
      version,
      remoteId: text.optional(),
      create: z.boolean().optional(),
    }),
    'post /api/v1/admin/tokens': object({
      name: text,
      contestIds: z.array(id),
      scopes: z.array(text),
      fields: z.array(text),
      expiresAt: date,
    }),
    'post /api/v1/admin/webhooks': object({ contestId: id.optional(), url: z.url() }),
    'post /api/v1/admin/fields': 'FieldDefinition',
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
    }),
    'put /api/v1/admin/mail': 'MailSettingsInput',
    'post /api/v1/admin/mail/probe': object({ version }),
    'post /api/v1/admin/mail/test': object({ version }),
    'post /api/integration/v1/registrations/{id}/provision': object({ bindingId: id }),
    'post /api/integration/v1/registrations/{id}/result': object({
      bindingId: id,
      registrationVersion: version,
      result: provisioningResultSchema,
    }),
  };
  const instance = object({
    version: version.optional(),
    name: text,
    type: z.enum(['HYDRO', 'DOMJUDGE']),
    baseUrl: z.url(),
    credentials: object({
      username: text.optional(),
      password: text.optional(),
      token: text.optional(),
    }),
    allowedContestIds: z.array(id),
    enabled: z.boolean().optional(),
  });
  bodies['post /api/v1/integrations/instances'] = instance;
  bodies['put /api/v1/integrations/instances/{id}'] = instance;
  for (const [url, item] of Object.entries(document.paths))
    for (const [method, raw] of Object.entries(item ?? {})) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      const op = raw as any;
      const external = url.startsWith('/api/automation') || url.startsWith('/api/integration');
      const publicPath =
        /\/auth\/(me|login|register|forgot|reset|verify)/.test(url) ||
        (['/api/v1/health', '/api/v1/site', '/api/v1/contests', '/api/v1/contests/{id}'].includes(
          url,
        ) &&
          method === 'get');
      op.security = external ? [{ bearer: [] }] : publicPath ? [] : [{ cookie: [] }];
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
          '/api/v1/admin/invitations',
          '/api/v1/admin/audit',
          '/api/v1/registrations',
          '/api/v1/support',
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
      const body = bodies[`${method} ${url}`];
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
    }
  return document;
}
