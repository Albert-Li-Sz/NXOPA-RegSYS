-- v0.10.0 is for fresh installations; platform-specific credentials are retired.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "PlatformExportAccount" LIMIT 1) THEN
    RAISE EXCEPTION 'v0.10.0 requires a fresh database; keep the existing installation and credentials in its original data volume';
  END IF;
END $$;
DROP TABLE "PlatformExportAccount";
CREATE TABLE "CompetitionAccount" (
  id UUID NOT NULL PRIMARY KEY,
  "registrationId" UUID NOT NULL UNIQUE REFERENCES "Registration"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "contestId" UUID NOT NULL REFERENCES "Contest"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  username TEXT NOT NULL,
  "usernameKey" TEXT NOT NULL,
  credential TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CompetitionAccount_contestId_usernameKey_key" ON "CompetitionAccount"("contestId", "usernameKey");
