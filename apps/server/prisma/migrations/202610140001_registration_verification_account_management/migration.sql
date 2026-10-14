ALTER TABLE "User" ADD COLUMN "bannedAt" TIMESTAMP(3), ADD COLUMN "banReason" TEXT NOT NULL DEFAULT '';

CREATE TABLE "RegistrationVerification" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistrationVerification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RegistrationVerification_email_usedAt_idx" ON "RegistrationVerification"("email", "usedAt");
