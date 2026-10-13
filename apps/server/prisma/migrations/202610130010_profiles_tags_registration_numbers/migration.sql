ALTER TABLE "User" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "User_tags_idx" ON "User" USING GIN ("tags");
ALTER TABLE "OAuthProvider" ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "OAuthProvider_slug_key" ON "OAuthProvider" ("slug");
ALTER TABLE "Contest" ADD COLUMN "nextRegistrationNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Registration" ADD COLUMN "number" INTEGER;

-- Older releases overwrite submittedAt on correction. Recover the first submission
-- from the existing audit log, retaining deterministic order for equal timestamps.
WITH first_submissions AS (
  SELECT r."id", r."contestId", COALESCE(MIN(a."createdAt"), r."submittedAt") AS first_at,
         r."createdAt"
  FROM "Registration" r
  LEFT JOIN "AuditEvent" a ON a."resourceId" = r."id"::text AND a."action" = 'REGISTRATION_SUBMIT'
  WHERE r."submittedAt" IS NOT NULL
  GROUP BY r."id", r."contestId", r."submittedAt", r."createdAt"
), numbered AS (
  SELECT "id", first_at, ROW_NUMBER() OVER (PARTITION BY "contestId" ORDER BY first_at, "createdAt", "id")::INTEGER AS n
  FROM first_submissions
)
UPDATE "Registration" r SET "number" = numbered.n, "submittedAt" = numbered.first_at
FROM numbered WHERE r."id" = numbered."id";

UPDATE "Contest" c SET "nextRegistrationNumber" = COALESCE((
  SELECT MAX(r."number") + 1 FROM "Registration" r WHERE r."contestId" = c."id"
), 1);
CREATE UNIQUE INDEX "Registration_contestId_number_key" ON "Registration" ("contestId", "number");
