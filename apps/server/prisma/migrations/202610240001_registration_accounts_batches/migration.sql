-- The external platform/open API subsystem is retired. No old account conversion.
DROP TABLE IF EXISTS "AccountMapping", "PlatformExportAccount", "OrganizationMapping", "PlatformBinding", "PlatformInstance", "RemoteRevocation", "ApiToken", "Webhook" CASCADE;
ALTER TABLE "Contest" ADD COLUMN "accountSettings" JSONB NOT NULL DEFAULT '{"enabled":false,"prefix":"","showOnAdmission":true}';
ALTER TABLE "Contest" ADD COLUMN "accountPrefixLocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contest" ALTER COLUMN modules SET DEFAULT '{"admissions":true,"rooms":false}';
UPDATE "Contest" SET modules = modules - 'integrations', policy = policy - 'platformProfiles';
UPDATE "AdminGrant" SET permissions = array_remove(permissions, 'INTEGRATIONS');
UPDATE "Job" SET state='CANCELLED', payload='{}', result='{}', "leaseToken"=NULL, "leaseUntil"=NULL WHERE kind IN ('SYNC','WEBHOOK');
CREATE TABLE "CompetitionAccount" (
  id UUID PRIMARY KEY,
  "registrationId" UUID NOT NULL UNIQUE REFERENCES "Registration"(id) ON DELETE CASCADE,
  "contestId" UUID NOT NULL,
  username TEXT NOT NULL,
  credential TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CompetitionAccount_contestId_username_key" ON "CompetitionAccount"("contestId",username);
CREATE TABLE "AdmissionBatch" (
  id UUID PRIMARY KEY,
  "contestId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  action TEXT NOT NULL,
  targets JSONB NOT NULL,
  options JSONB NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'PREVIEW',
  result JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AdmissionBatch_contestId_createdAt_idx" ON "AdmissionBatch"("contestId","createdAt");
CREATE INDEX "AdmissionBatch_expiresAt_idx" ON "AdmissionBatch"("expiresAt");
