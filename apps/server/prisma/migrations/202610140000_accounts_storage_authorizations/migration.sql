-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarAttachmentId" UUID,
ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "identityStatus" TEXT NOT NULL DEFAULT 'UNSUBMITTED',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'STUDENT',
ADD COLUMN     "personId" UUID,
ADD COLUMN     "previousEmailHash" TEXT;

-- AlterTable
ALTER TABLE "EmailToken" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeHash" TEXT;

-- AlterTable
ALTER TABLE "Contest" ADD COLUMN     "publicRosterEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicRosterReviews" TEXT[] DEFAULT ARRAY['APPROVED']::TEXT[];

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "publicRank" INTEGER;

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "grantExpiresAt" TIMESTAMP(3),
ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "contestId" UUID,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "public" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "sha256" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "storageBackend" TEXT NOT NULL DEFAULT 'LOCAL',
ADD COLUMN     "storageConfigId" UUID;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "emailNotifications" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "AdmissionDocument" ADD COLUMN     "sha256" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "storageBackend" TEXT NOT NULL DEFAULT 'LOCAL',
ADD COLUMN     "storageConfigId" UUID;

-- CreateTable
CREATE TABLE "PersonRecord" (
    "id" UUID NOT NULL,
    "identityKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL DEFAULT '',
    "reviewedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "IdentityRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminGrant" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "contestId" UUID,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedBy" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamFile" (
    "id" UUID NOT NULL,
    "attachmentId" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "assignedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageConfiguration" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'nxopa',
    "accessKey" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "forcePathStyle" BOOLEAN NOT NULL DEFAULT true,
    "createBucket" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailTemplate" (
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "MailTemplate_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonRecord_identityKey_key" ON "PersonRecord"("identityKey");

-- CreateIndex
CREATE INDEX "IdentityRequest_userId_status_idx" ON "IdentityRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "AdminGrant_userId_revokedAt_expiresAt_idx" ON "AdminGrant"("userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "AdminGrant_contestId_idx" ON "AdminGrant"("contestId");

-- CreateIndex
CREATE INDEX "TeamFile_registrationId_idx" ON "TeamFile"("registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamFile_attachmentId_registrationId_key" ON "TeamFile"("attachmentId", "registrationId");

-- CreateIndex
CREATE INDEX "User_personId_idx" ON "User"("personId");

-- CreateIndex
CREATE INDEX "Attachment_ownerId_deletedAt_idx" ON "Attachment"("ownerId", "deletedAt");

-- CreateIndex
CREATE INDEX "Attachment_contestId_purpose_idx" ON "Attachment"("contestId", "purpose");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityRequest" ADD CONSTRAINT "IdentityRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminGrant" ADD CONSTRAINT "AdminGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamFile" ADD CONSTRAINT "TeamFile_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Legacy flags are migrated once. Effective authority comes only from live grants.
INSERT INTO "AdminGrant" (id,"userId",level,permissions,"grantedBy","createdAt")
SELECT gen_random_uuid(),id,'SYSTEM',ARRAY['VIEW','CONTEST','REGISTRATIONS','FINANCE','ADMISSIONS','FILES','SUPPORT','STUDENTS','INTEGRATIONS'],id,now() FROM "User" WHERE "isAdmin";
INSERT INTO "AdminGrant" (id,"userId",level,"contestId",permissions,"grantedBy","createdAt")
SELECT gen_random_uuid(),"userId",'CONTEST',"contestId",ARRAY['VIEW','CONTEST','REGISTRATIONS','FINANCE','ADMISSIONS','FILES','SUPPORT','STUDENTS','INTEGRATIONS'],"userId",now() FROM "RoleAssignment";
UPDATE "User" SET "identityStatus"='RECORDED' WHERE trim(name)<>'' AND length(coalesce(profile->>'student_id',''))>0;
