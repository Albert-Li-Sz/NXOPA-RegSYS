ALTER TABLE "AccountMapping" ADD COLUMN "syncJobId" UUID;
ALTER TABLE "AccountMapping" ADD COLUMN "syncLeaseUntil" TIMESTAMP(3);
