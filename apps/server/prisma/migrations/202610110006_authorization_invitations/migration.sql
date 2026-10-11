ALTER TABLE "Invitation" ADD COLUMN "targetUserId" UUID,
  ADD COLUMN "contestId" UUID,
  ADD COLUMN "acceptedAt" TIMESTAMP(3);
CREATE INDEX "Invitation_kind_createdAt_idx" ON "Invitation"("kind", "createdAt");
CREATE INDEX "Invitation_inviterId_idx" ON "Invitation"("inviterId");
