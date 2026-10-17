ALTER TABLE "Job" ADD COLUMN "leaseToken" UUID, ADD COLUMN "leaseUntil" TIMESTAMP(3);
CREATE INDEX "Job_state_leaseUntil_idx" ON "Job"("state", "leaseUntil");
ALTER TABLE "OutboxEvent" ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0, ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
CREATE INDEX "OutboxEvent_deliveredAt_nextAttemptAt_createdAt_idx" ON "OutboxEvent"("deliveredAt", "nextAttemptAt", "createdAt");
ALTER TABLE "Attachment" ADD COLUMN "purgedAt" TIMESTAMP(3);
CREATE INDEX "Attachment_ownerId_purgedAt_idx" ON "Attachment"("ownerId", "purgedAt");
UPDATE "Attachment" AS a SET "purgedAt" = j."updatedAt"
FROM "Job" AS j WHERE a."deletedAt" IS NOT NULL AND j.kind = 'OBJECT_DELETE'
AND j.state = 'SUCCESS' AND j."resourceId" = a.id::text
AND j.payload->'storageRef'->>'storageKey' = a."storageKey"
AND COALESCE(j.payload->'storageRef'->>'storageBackend','LOCAL') = a."storageBackend"
AND (j.payload->'storageRef'->>'storageConfigId') IS NOT DISTINCT FROM a."storageConfigId"::text;
UPDATE "Contest" SET "publicRosterReviews" = ARRAY['APPROVED']::TEXT[] WHERE "publicRosterReviews" IS NULL;
UPDATE "Invitation" SET permissions = ARRAY[]::TEXT[] WHERE permissions IS NULL;
UPDATE "AdminGrant" SET permissions = ARRAY[]::TEXT[] WHERE permissions IS NULL;
ALTER TABLE "Contest" ALTER COLUMN "publicRosterReviews" SET NOT NULL;
ALTER TABLE "Invitation" ALTER COLUMN permissions SET NOT NULL;
ALTER TABLE "AdminGrant" ALTER COLUMN permissions SET NOT NULL;
ALTER TABLE "PaymentProofClaim" DROP CONSTRAINT "PaymentProofClaim_voucherId_fkey";
ALTER TABLE "PaymentProofClaim" ADD CONSTRAINT "PaymentProofClaim_voucherId_fkey"
FOREIGN KEY ("voucherId") REFERENCES "PaymentVoucher"(id) ON DELETE CASCADE ON UPDATE CASCADE;
