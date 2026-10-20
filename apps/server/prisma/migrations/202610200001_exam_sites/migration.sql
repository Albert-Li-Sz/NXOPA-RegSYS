CREATE TABLE "ExamSite" (
    "id" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ExamSite_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Registration" ADD COLUMN "examSiteId" UUID;
ALTER TABLE "ExamRoom" ADD COLUMN "examSiteId" UUID;
CREATE INDEX "ExamSite_contestId_sortOrder_idx" ON "ExamSite"("contestId", "sortOrder");
CREATE INDEX "Registration_examSiteId_idx" ON "Registration"("examSiteId");
CREATE INDEX "ExamRoom_examSiteId_idx" ON "ExamRoom"("examSiteId");
ALTER TABLE "ExamSite" ADD CONSTRAINT "ExamSite_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_examSiteId_fkey" FOREIGN KEY ("examSiteId") REFERENCES "ExamSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExamRoom" ADD CONSTRAINT "ExamRoom_examSiteId_fkey" FOREIGN KEY ("examSiteId") REFERENCES "ExamSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
