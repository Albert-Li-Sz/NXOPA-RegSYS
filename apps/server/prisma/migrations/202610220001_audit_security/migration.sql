BEGIN;
ALTER TABLE "User" ADD COLUMN "pendingEmail" TEXT;
ALTER TABLE "Session" ADD COLUMN "reauthenticatedAt" TIMESTAMP(3);
ALTER TABLE "PaymentProofClaim" ADD COLUMN "registrationId" UUID, ADD COLUMN "proofSha256" TEXT;
ALTER TABLE "LedgerEntry" ADD COLUMN "normalizedReference" TEXT, ADD COLUMN "requiresReconciliation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FinanceAccount" ADD COLUMN "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Refund" ADD COLUMN "secondReviewerId" UUID, ADD COLUMN "rejectionReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "InvoiceRequest" ADD COLUMN "requestedBy" UUID;
ALTER TABLE "ApiToken" ADD COLUMN "createdBy" UUID;
ALTER TABLE "Webhook" ADD COLUMN "privateApprovalExpiresAt" TIMESTAMP(3);
-- Legacy unowned credentials cannot be safely attributed. Explicitly reissue them.
UPDATE "ApiToken" SET revoked=true WHERE "createdBy" IS NULL;
UPDATE "Webhook" SET enabled=false,"privateApprovedBy"=NULL WHERE "privateApprovedBy" IS NOT NULL;
UPDATE "PaymentVoucher" v SET "createdBy"=a."actorId"::uuid FROM "AuditEvent" a
 WHERE v."createdBy" IS NULL AND a.action='VOUCHER_UPLOAD' AND a.details->>'voucherId'=v.id::text
 AND a."actorId" ~* '^[0-9a-f-]{36}$';

UPDATE "Refund" r SET "requestedBy"=a."actorId"::uuid FROM "AuditEvent" a WHERE r."requestedBy" IS NULL AND a.action='REFUND_REQUEST' AND a.details->>'refundId'=r.id::text AND a."actorId" ~* '^[0-9a-f-]{36}$';
UPDATE "InvoiceRequest" r SET "requestedBy"=a."actorId"::uuid FROM "AuditEvent" a WHERE a.action='INVOICE_REQUEST' AND a.details->>'invoiceId'=r.id::text AND a."actorId" ~* '^[0-9a-f-]{36}$';
UPDATE "FinanceAccount" SET "reconciliationRequired"=true WHERE id IN (
 SELECT "registrationId" FROM "PaymentVoucher" WHERE status='PENDING' AND "createdBy" IS NULL
 UNION SELECT "registrationId" FROM "Refund" WHERE status IN ('REQUESTED','APPROVED') AND "requestedBy" IS NULL
 UNION SELECT "registrationId" FROM "InvoiceRequest" WHERE status='REQUESTED' AND "requestedBy" IS NULL
);

-- Preserve the ledger. Flag every account involved in duplicate transfers for reconciliation.
CREATE FUNCTION nxopa_normalize_payment_text(value TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT lower(btrim(regexp_replace(normalize(value,NFKC), U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g')))
$$;
CREATE TEMP TABLE normalized_payments ON COMMIT DROP AS
 SELECT p.*, row_number() OVER (PARTITION BY "contestId",ref ORDER BY reversed,"createdAt",id) AS n,
 count(*) FILTER (WHERE NOT reversed) OVER (PARTITION BY "contestId",ref) AS total
 FROM (
   SELECT l.id,l."registrationId",l."contestId",l."createdAt",'payment:'||nxopa_normalize_payment_text(v.reference) AS ref,
   EXISTS (SELECT 1 FROM "LedgerEntry" rev WHERE rev.kind='REVERSAL' AND rev."sourceId"='reverse:'||l.id::text) AS reversed
   FROM "LedgerEntry" l JOIN "PaymentVoucher" v ON l."sourceId"='voucher:'||v.id::text WHERE l.kind='PAYMENT' AND v.reference IS NOT NULL
 ) p;
UPDATE "LedgerEntry" l SET "normalizedReference"=n.ref FROM normalized_payments n WHERE l.id=n.id AND n.n=1;
UPDATE "FinanceAccount" SET "reconciliationRequired"=true WHERE id IN (SELECT "registrationId" FROM normalized_payments WHERE total>1);
UPDATE "LedgerEntry" l SET "requiresReconciliation"=true FROM normalized_payments n WHERE l.id=n.id AND n.n>1 AND NOT n.reversed;
UPDATE "FinanceAccount" SET "reconciliationRequired"=true WHERE id::text IN (SELECT "resourceId" FROM "AuditEvent" WHERE action='VOUCHER_DUPLICATE_HISTORY');
CREATE TEMP TABLE normalized_refunds ON COMMIT DROP AS
 SELECT id,'refund:'||nxopa_normalize_payment_text(substr("channelReference",8)) AS ref,
 row_number() OVER (PARTITION BY "contestId",nxopa_normalize_payment_text(substr("channelReference",8)) ORDER BY "createdAt",id) AS n
 FROM "LedgerEntry" WHERE kind='REFUND' AND "channelReference" LIKE 'refund:%';
UPDATE "LedgerEntry" l SET "normalizedReference"=n.ref FROM normalized_refunds n WHERE l.id=n.id AND n.n=1;

CREATE TEMP TABLE normalized_proofs ON COMMIT DROP AS
 SELECT c."attachmentId",v."registrationId",a.sha256,
 row_number() OVER (PARTITION BY v."registrationId",a.sha256 ORDER BY v."createdAt",v.id) AS n,
 count(*) OVER (PARTITION BY v."registrationId",a.sha256) AS total
 FROM "PaymentProofClaim" c JOIN "PaymentVoucher" v ON v.id=c."voucherId" JOIN "Attachment" a ON a.id=c."attachmentId" WHERE v.status<>'REJECTED';
UPDATE "PaymentProofClaim" c SET "registrationId"=n."registrationId","proofSha256"=n.sha256 FROM normalized_proofs n WHERE c."attachmentId"=n."attachmentId" AND n.n=1;
UPDATE "FinanceAccount" SET "reconciliationRequired"=true WHERE id IN (SELECT "registrationId" FROM normalized_proofs WHERE total>1);
DELETE FROM "PaymentProofClaim" WHERE "voucherId" IN (SELECT id FROM "PaymentVoucher" WHERE status='REJECTED');
UPDATE "LedgerEntry" l SET "requiresReconciliation"=true WHERE l."sourceId" IN (
 SELECT 'voucher:'||c."voucherId"::text FROM "PaymentProofClaim" c JOIN normalized_proofs n ON n."attachmentId"=c."attachmentId" WHERE n.n>1
 UNION SELECT 'voucher:'||(details->>'voucherId') FROM "AuditEvent" WHERE action='VOUCHER_DUPLICATE_HISTORY'
);
CREATE UNIQUE INDEX "PaymentProofClaim_registrationId_proofSha256_key" ON "PaymentProofClaim"("registrationId","proofSha256");
CREATE UNIQUE INDEX "LedgerEntry_contestId_normalizedReference_key" ON "LedgerEntry"("contestId","normalizedReference");

CREATE INDEX "RegistrationPerson_registrationId_idx" ON "RegistrationPerson"("registrationId");
CREATE INDEX "Attachment_registrationId_idx" ON "Attachment"("registrationId");
CREATE INDEX "PaymentVoucher_registrationId_idx" ON "PaymentVoucher"("registrationId");
CREATE INDEX "Refund_registrationId_idx" ON "Refund"("registrationId");
CREATE INDEX "InvoiceRequest_registrationId_idx" ON "InvoiceRequest"("registrationId");
CREATE INDEX "LedgerEntry_registrationId_idx" ON "LedgerEntry"("registrationId");
CREATE INDEX "SupportTicket_ownerId_idx" ON "SupportTicket"("ownerId");
CREATE INDEX "SupportTicket_contestId_idx" ON "SupportTicket"("contestId");
CREATE INDEX "EmailToken_userId_purpose_idx" ON "EmailToken"("userId",purpose);
CREATE INDEX "Job_kind_resourceId_createdAt_idx" ON "Job"(kind,"resourceId","createdAt");

-- Pre-registration role invitations cannot be safely attributed to past mailbox owners.
UPDATE "Invitation" SET revoked=true WHERE "targetUserId" IS NULL AND "acceptedBy" IS NULL AND kind IN ('ACCOUNT','SYSTEM_ADMIN','SENIOR_ADMIN','CONTEST_ADMIN','COACH_ROLE');
DELETE FROM "IdempotencyRecord";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Registration_answers_reference_idx" ON "Registration" USING gin ((answers::text) gin_trgm_ops);
CREATE INDEX "Registration_snapshot_reference_idx" ON "Registration" USING gin ((snapshot::text) gin_trgm_ops);
CREATE INDEX "RegistrationRevision_snapshot_reference_idx" ON "RegistrationRevision" USING gin ((snapshot::text) gin_trgm_ops);
CREATE INDEX "RegistrationPerson_answers_reference_idx" ON "RegistrationPerson" USING gin ((answers::text) gin_trgm_ops);
CREATE INDEX "RegistrationCoach_answers_reference_idx" ON "RegistrationCoach" USING gin ((answers::text) gin_trgm_ops);
CREATE INDEX "SupportMessage_attachments_reference_idx" ON "SupportMessage" USING gin ((attachments::text) gin_trgm_ops);
CREATE INDEX "User_avatar_reference_idx" ON "User"("avatarAttachmentId");
DELETE FROM "TeamFile" WHERE NOT EXISTS (SELECT 1 FROM "Registration" r WHERE r.id="TeamFile"."registrationId");
ALTER TABLE "TeamFile" ADD CONSTRAINT "TeamFile_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"(id) ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
