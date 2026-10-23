ALTER TABLE "ExamRoom" ADD COLUMN "code" TEXT;
CREATE UNIQUE INDEX "ExamRoom_contestId_code_key" ON "ExamRoom"("contestId", "code");
