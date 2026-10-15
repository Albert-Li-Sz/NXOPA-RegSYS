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
  name: z.string().trim().min(1).max(100),
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
  registrationIds: z.array(z.string().uuid()).min(1).max(10000),
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
