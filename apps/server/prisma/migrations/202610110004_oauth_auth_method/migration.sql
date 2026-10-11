ALTER TABLE "OAuthProvider" ADD COLUMN "tokenAuthMethod" TEXT NOT NULL DEFAULT 'client_secret_post';
CREATE INDEX "Job_state_updatedAt_idx" ON "Job" ("state", "updatedAt");
