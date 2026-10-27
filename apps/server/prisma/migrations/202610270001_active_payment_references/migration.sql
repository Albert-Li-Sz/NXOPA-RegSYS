BEGIN;

-- A reversal releases active ownership of a payment reference without rewriting
-- any historical reference, amount, voucher or audit event.
ALTER TABLE "LedgerEntry" ADD COLUMN "reversedAt" TIMESTAMP(3);
UPDATE "LedgerEntry" payment
SET "reversedAt" = reversal."createdAt"
FROM "LedgerEntry" reversal
WHERE payment.kind = 'PAYMENT'
  AND reversal.kind = 'REVERSAL'
  AND reversal."sourceId" = 'reverse:' || payment.id::text;

DROP INDEX "LedgerEntry_contestId_channelReference_key";
DROP INDEX "LedgerEntry_contestId_normalizedReference_key";
CREATE UNIQUE INDEX "LedgerEntry_contestId_channelReference_key"
  ON "LedgerEntry" ("contestId", "channelReference") WHERE "reversedAt" IS NULL;
CREATE UNIQUE INDEX "LedgerEntry_contestId_normalizedReference_key"
  ON "LedgerEntry" ("contestId", "normalizedReference") WHERE "reversedAt" IS NULL;

-- Re-uploading the same proof is allowed after its payment was reversed, while
-- active and pending vouchers retain their existing uniqueness protection.
DELETE FROM "PaymentProofClaim" claim
USING "LedgerEntry" payment
WHERE payment.kind = 'PAYMENT' AND payment."reversedAt" IS NOT NULL
  AND payment."sourceId" = 'voucher:' || claim."voucherId"::text;

COMMIT;
