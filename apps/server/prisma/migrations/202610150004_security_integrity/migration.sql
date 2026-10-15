ALTER TABLE "PaymentVoucher" ADD COLUMN "createdBy" UUID;
ALTER TABLE "Refund" ADD COLUMN "requestedBy" UUID;
ALTER TABLE "Refund" ADD COLUMN "approvedBy" UUID;
UPDATE "Refund" SET "approvedBy" = "handledBy" WHERE status = 'APPROVED';
CREATE TABLE "PaymentProofClaim" (
  "attachmentId" UUID NOT NULL PRIMARY KEY,
  "voucherId" UUID NOT NULL UNIQUE REFERENCES "PaymentVoucher"(id) ON DELETE CASCADE
);
-- Preserve every historical financial document and balance. Claim each proof once;
-- duplicate pending vouchers can no longer be confirmed after the upgrade.
INSERT INTO "PaymentProofClaim" ("attachmentId", "voucherId")
SELECT DISTINCT ON ("attachmentId") "attachmentId", id FROM "PaymentVoucher"
ORDER BY "attachmentId", (status = 'CONFIRMED') DESC, "createdAt", id;
INSERT INTO "AuditEvent" (id,"actorId",action,"resourceId",details)
SELECT gen_random_uuid(), 'migration', 'VOUCHER_DUPLICATE_HISTORY', "registrationId"::text,
 jsonb_build_object('voucherId', id, 'attachmentId', "attachmentId", 'requiresManualReconciliation', true)
FROM "PaymentVoucher" v WHERE EXISTS (
 SELECT 1 FROM "PaymentProofClaim" c WHERE c."attachmentId"=v."attachmentId" AND c."voucherId"<>v.id
);
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
