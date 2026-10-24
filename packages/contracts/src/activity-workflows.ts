import { z } from 'zod';
export const registrationCancellationSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().max(3000).default('用户取消报名'),
});
export const registrationDeletionSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(3000),
});
export const registrationDeletionReceiptSchema = z.object({
  deleted: z.literal(true),
  registrationId: z.string().uuid(),
  financeAccountId: z.string().uuid().nullable(),
});
export const registrationActionsSchema = z.object({
  edit: z.boolean(),
  editOwnMember: z.boolean(),
  submit: z.boolean(),
  withdraw: z.boolean(),
  cancel: z.boolean(),
  delete: z.boolean(),
  review: z.boolean(),
  amendReview: z.boolean(),
  requestFinance: z.boolean(),
  credentials: z.boolean(),
  editReason: z.string(),
});
export function registrationReviewPhase(r: { status: string; review: string }) {
  if (r.status === 'SUBMITTED') return r.review === 'PENDING' ? 'INITIAL' : 'AMEND';
  if (r.status === 'CORRECTION' && r.review === 'CORRECTION') return 'AMEND';
  return null;
}
export const roomSchema = z.object({
  version: z.number().int().optional(),
  examSiteId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(100),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .max(20)
    .regex(/^[A-Z0-9_-]*$/, '考场编号只允许字母、数字、下划线和连字符')
    .nullable()
    .optional(),
  location: z.string().trim().max(300).default(''),
  capacity: z.number().int().min(1).max(10000),
  sortOrder: z.number().int().default(0),
  enabled: z.boolean().default(true),
});
export const seatAssignmentSchema = z.object({
  registrationId: z.string().uuid(),
  personId: z.string().uuid().nullable().optional(),
  roomId: z.string().uuid(),
  seat: z.number().int().positive(),
});
export const seatingRequestSchema = z.object({
  registrationIds: z.array(z.string().uuid()).min(1).max(200),
  replace: z.boolean().default(false),
  assignments: z.array(seatAssignmentSchema).max(30000).optional(),
  seatingVersion: z.number().int().optional(),
  registrationVersions: z.record(z.string(), z.number().int()).optional(),
});
export const seatingClearSchema = z.object({
  seatingVersion: z.number().int(),
  roomId: z.string().uuid().optional(),
});
export const seatingPreviewSchema = z.object({
  seatingVersion: z.number().int(),
  registrationVersions: z.record(z.string(), z.number().int()),
  errors: z.array(z.string()),
  total: z.number().int(),
  assignments: z.array(
    seatAssignmentSchema.extend({
      unitKey: z.string(),
      roomName: z.string(),
      name: z.string().optional(),
      number: z.number().nullable(),
    }),
  ),
});
export type RegistrationActions = z.infer<typeof registrationActionsSchema>;
export type RegistrationDeletionReceipt = z.infer<typeof registrationDeletionReceiptSchema>;
export type RoomInput = z.infer<typeof roomSchema>;
export type SeatingRequest = z.infer<typeof seatingRequestSchema>;
export type SeatingPreview = z.infer<typeof seatingPreviewSchema>;

export const admissionBatchActionSchema = z.enum(['GENERATE', 'RELEASE', 'DOWNLOAD']);
export const batchScopeSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('SELECTED'),
    registrationIds: z.array(z.string().uuid()).min(1).max(10000),
  }),
  z.object({ mode: z.literal('FILTERED'), filters: z.record(z.string(), z.string()).default({}) }),
]);
export const admissionBatchPreviewSchema = z.object({
  action: admissionBatchActionSchema,
  scope: batchScopeSchema,
  options: z
    .object({
      location: z.string().max(300).default(''),
      room: z.string().max(100).default(''),
      seat: z.string().max(100).default(''),
    })
    .default(() => ({ location: '', room: '', seat: '' })),
});
export const admissionBatchExecuteSchema = z.object({ previewId: z.string().uuid() });
export type BatchScope = z.infer<typeof batchScopeSchema>;
