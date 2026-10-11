ALTER TABLE "Contest" ADD COLUMN "descriptionFormat" TEXT NOT NULL DEFAULT 'TEXT';
ALTER TABLE "Registration" ADD COLUMN "participationType" TEXT NOT NULL DEFAULT 'OFFICIAL', ADD COLUMN "organization" JSONB;
CREATE INDEX "Registration_contestId_createdAt_id_idx" ON "Registration"("contestId", "createdAt", "id");
ALTER TABLE "InvoiceRequest" ADD COLUMN "invoiceType" TEXT, ADD COLUMN "titleType" TEXT,
  ADD COLUMN "contactName" TEXT, ADD COLUMN "phone" TEXT, ADD COLUMN "address" TEXT,
  ADD COLUMN "bankName" TEXT, ADD COLUMN "bankAccount" TEXT, ADD COLUMN "remarks" TEXT, ADD COLUMN "snapshot" JSONB;
ALTER TABLE "PlatformBinding" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "importMode" TEXT NOT NULL DEFAULT 'FOLLOW', ADD COLUMN "includeUnofficial" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "nickname" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "unofficialGroupId" TEXT;
CREATE TABLE "OrganizationMapping" (
  "id" UUID NOT NULL, "instanceId" UUID NOT NULL, "nameKey" TEXT NOT NULL, "name" TEXT NOT NULL,
  "shortName" TEXT NOT NULL, "country" TEXT NOT NULL, "icpcId" TEXT NOT NULL DEFAULT '', "remoteId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationMapping_instanceId_nameKey_key" ON "OrganizationMapping"("instanceId", "nameKey");
CREATE INDEX "OrganizationMapping_instanceId_status_idx" ON "OrganizationMapping"("instanceId", "status");
CREATE INDEX "AuditEvent_createdAt_id_idx" ON "AuditEvent"("createdAt", "id");
CREATE INDEX "Job_createdAt_id_idx" ON "Job"("createdAt", "id");
CREATE INDEX "SupportTicket_createdAt_id_idx" ON "SupportTicket"("createdAt", "id");
