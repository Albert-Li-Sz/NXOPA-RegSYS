-- Older releases did not bind email links to the mailbox that received them.
-- Their original recipient cannot be recovered reliably, so require fresh links.
UPDATE "EmailToken"
SET "usedAt" = CURRENT_TIMESTAMP
WHERE "usedAt" IS NULL AND "purpose" IN ('VERIFY', 'RESET');
