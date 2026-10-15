-- DropForeignKey
ALTER TABLE "InvoiceRequest" DROP CONSTRAINT "InvoiceRequest_registrationId_fkey";

-- DropForeignKey
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_registrationId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentVoucher" DROP CONSTRAINT "PaymentVoucher_registrationId_fkey";

-- DropForeignKey
ALTER TABLE "Refund" DROP CONSTRAINT "Refund_registrationId_fkey";

-- AlterTable
ALTER TABLE "Contest" ADD COLUMN     "deletedCancelledCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deletedSubmittedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'COMPETITION',
ADD COLUMN     "modules" JSONB NOT NULL DEFAULT '{"admissions":true,"rooms":false,"integrations":true}',
ADD COLUMN     "seatingMode" TEXT NOT NULL DEFAULT 'REGISTRATION',
ADD COLUMN     "seatingVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN     "resourceId" TEXT;

-- CreateTable
CREATE TABLE "FinanceAccount" (
    "id" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "number" INTEGER,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "netPaidCents" INTEGER NOT NULL DEFAULT 0,
    "policySnapshot" JSONB NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamRoom" (
    "id" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "capacity" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ExamRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatAssignment" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "unitKey" TEXT NOT NULL,
    "personId" UUID,
    "seat" INTEGER NOT NULL,

    CONSTRAINT "SeatAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemoteRevocation" (
    "id" UUID NOT NULL,
    "contestId" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "remoteUserId" TEXT,
    "remoteTeamId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "handledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RemoteRevocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinanceAccount_ownerId_cancelledAt_idx" ON "FinanceAccount"("ownerId", "cancelledAt");

-- CreateIndex
CREATE INDEX "FinanceAccount_contestId_createdAt_id_idx" ON "FinanceAccount"("contestId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExamRoom_contestId_name_key" ON "ExamRoom"("contestId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SeatAssignment_roomId_seat_key" ON "SeatAssignment"("roomId", "seat");

-- CreateIndex
CREATE UNIQUE INDEX "SeatAssignment_registrationId_unitKey_key" ON "SeatAssignment"("registrationId", "unitKey");

-- CreateIndex
CREATE INDEX "RemoteRevocation_contestId_state_idx" ON "RemoteRevocation"("contestId", "state");

-- Backfill before switching finance foreign keys. No registration answers are copied.
INSERT INTO "FinanceAccount" ("id","contestId","ownerId","number","feeCents","netPaidCents","policySnapshot","version","createdAt")
SELECT r.id,r."contestId",r."ownerId",r.number,r."feeCents",r."netPaidCents",COALESCE(r."policySnapshot",c.policy),r.version,r."createdAt"
FROM "Registration" r JOIN "Contest" c ON c.id=r."contestId";
DO $$ BEGIN
 IF (SELECT COALESCE(SUM("netPaidCents"),0) FROM "FinanceAccount") <> (SELECT COALESCE(SUM("netPaidCents"),0) FROM "Registration") THEN
   RAISE EXCEPTION 'Finance account migration balance mismatch';
 END IF;
END $$;
ALTER TABLE "ExamRoom" ADD CONSTRAINT "ExamRoom_capacity_positive" CHECK (capacity > 0);
ALTER TABLE "SeatAssignment" ADD CONSTRAINT "SeatAssignment_seat_positive" CHECK (seat > 0);
CREATE INDEX "IdempotencyRecord_resourceId_idx" ON "IdempotencyRecord"("resourceId");

-- AddForeignKey
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAccount" ADD CONSTRAINT "FinanceAccount_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamRoom" ADD CONSTRAINT "ExamRoom_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatAssignment" ADD CONSTRAINT "SeatAssignment_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatAssignment" ADD CONSTRAINT "SeatAssignment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ExamRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
