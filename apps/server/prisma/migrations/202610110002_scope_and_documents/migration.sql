ALTER TABLE "PlatformInstance" ADD COLUMN "allowedContestIds" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AdmissionDocument" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
