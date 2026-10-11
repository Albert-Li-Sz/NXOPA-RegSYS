-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isCoach" BOOLEAN NOT NULL DEFAULT false,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailToken" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "contestId" UUID NOT NULL,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "OAuthProvider" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "issuer" TEXT,
    "authorizationUrl" TEXT,
    "tokenUrl" TEXT,
    "userinfoUrl" TEXT,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'openid email profile',
    "subjectField" TEXT NOT NULL DEFAULT 'sub',
    "emailField" TEXT NOT NULL DEFAULT 'email',
    "verifiedField" TEXT NOT NULL DEFAULT 'email_verified',
    "nameField" TEXT NOT NULL DEFAULT 'name',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OAuthProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalIdentity" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contest" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "announcement" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "correctionUntil" TIMESTAMP(3),
    "published" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "manuallyClosed" BOOLEAN NOT NULL DEFAULT false,
    "policy" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "formVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldDefinition" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormVersion" (
    "id" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "fields" JSONB NOT NULL,
    "schema" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registration" (
    "id" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "teamName" TEXT NOT NULL DEFAULT '',
    "teamEnglishName" TEXT NOT NULL DEFAULT '',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "review" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewReason" TEXT NOT NULL DEFAULT '',
    "formVersion" INTEGER NOT NULL,
    "snapshot" JSONB,
    "policySnapshot" JSONB,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "netPaidCents" INTEGER NOT NULL DEFAULT 0,
    "quoted" BOOLEAN NOT NULL DEFAULT false,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationPerson" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "userId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "uniqueKey" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "captain" BOOLEAN NOT NULL DEFAULT false,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "answers" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "RegistrationPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationCoach" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "RegistrationCoach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "registrationId" UUID,
    "inviterId" UUID NOT NULL,
    "targetEmail" TEXT,
    "coachId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedBy" UUID,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationRevision" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "actorId" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "registrationId" UUID,
    "ticketId" UUID,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentVoucher" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "reference" TEXT,
    "payer" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "attachmentId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL DEFAULT '',
    "confirmedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL,
    "channelReference" TEXT,
    "actorId" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reference" TEXT,
    "attachmentId" UUID,
    "handledBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRequest" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "taxId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "attachmentId" UUID,
    "handledBy" UUID,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" UUID NOT NULL,
    "contestId" UUID,
    "registrationId" UUID,
    "ownerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionTemplate" (
    "id" UUID NOT NULL,
    "contestId" UUID,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionDocument" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "room" TEXT NOT NULL DEFAULT '',
    "seat" TEXT NOT NULL DEFAULT '',
    "registrationVersion" INTEGER NOT NULL,
    "templateId" UUID NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "storageKey" TEXT,
    "error" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformInstance" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PlatformInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformBinding" (
    "id" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "remoteContestId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL DEFAULT 'system',
    "groupIds" JSONB NOT NULL DEFAULT '[]',
    "organizationId" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PlatformBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountMapping" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "remoteUserId" TEXT,
    "remoteTeamId" TEXT,
    "username" TEXT NOT NULL,
    "credential" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "details" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "contestIds" JSONB NOT NULL,
    "scopes" JSONB NOT NULL,
    "fields" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" UUID NOT NULL,
    "contestId" UUID,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleAssignment_userId_contestId_key" ON "RoleAssignment"("userId", "contestId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_providerId_subject_key" ON "ExternalIdentity"("providerId", "subject");

-- CreateIndex
CREATE INDEX "Contest_published_archived_opensAt_closesAt_idx" ON "Contest"("published", "archived", "opensAt", "closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "FieldDefinition_key_key" ON "FieldDefinition"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FormVersion_contestId_version_key" ON "FormVersion"("contestId", "version");

-- CreateIndex
CREATE INDEX "Registration_contestId_status_review_eligible_idx" ON "Registration"("contestId", "status", "review", "eligible");

-- CreateIndex
CREATE INDEX "Registration_ownerId_idx" ON "Registration"("ownerId");

-- CreateIndex
CREATE INDEX "RegistrationPerson_userId_active_idx" ON "RegistrationPerson"("userId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationCoach_registrationId_userId_key" ON "RegistrationCoach"("registrationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationRevision_registrationId_version_key" ON "RegistrationRevision"("registrationId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_sourceId_key" ON "LedgerEntry"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_contestId_channelReference_key" ON "LedgerEntry"("contestId", "channelReference");

-- CreateIndex
CREATE INDEX "AdmissionTemplate_contestId_active_idx" ON "AdmissionTemplate"("contestId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionDocument_number_key" ON "AdmissionDocument"("number");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionDocument_registrationId_registrationVersion_templa_key" ON "AdmissionDocument"("registrationId", "registrationVersion", "templateId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformBinding_contestId_instanceId_remoteContestId_key" ON "PlatformBinding"("contestId", "instanceId", "remoteContestId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountMapping_registrationId_bindingId_key" ON "AccountMapping"("registrationId", "bindingId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupeKey_key" ON "Job"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_deliveredAt_createdAt_idx" ON "OutboxEvent"("deliveredAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuditEvent_resourceId_createdAt_idx" ON "AuditEvent"("resourceId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OAuthProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationPerson" ADD CONSTRAINT "RegistrationPerson_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationCoach" ADD CONSTRAINT "RegistrationCoach_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationRevision" ADD CONSTRAINT "RegistrationRevision_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDocument" ADD CONSTRAINT "AdmissionDocument_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBinding" ADD CONSTRAINT "PlatformBinding_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBinding" ADD CONSTRAINT "PlatformBinding_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "PlatformInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX "active_contest_user" ON "RegistrationPerson" ("contestId", "userId") WHERE "active" = true AND "userId" IS NOT NULL;
CREATE UNIQUE INDEX "active_contest_identifier" ON "RegistrationPerson" ("contestId", "uniqueKey") WHERE "active" = true AND "uniqueKey" IS NOT NULL;
