-- Direct platform synchronization is retired. Keep historical mappings for manual cleanup.
INSERT INTO "RemoteRevocation" (id, "contestId", "bindingId", "registrationId", "remoteUserId", "remoteTeamId", target, state)
SELECT gen_random_uuid(), b."contestId", b.id, m."registrationId", m."remoteUserId", m."remoteTeamId",
  jsonb_build_object('platformName', i.name, 'baseUrl', i."baseUrl", 'remoteContestId', b."remoteContestId", 'reason', 'PLATFORM_SYNC_RETIRED'), 'PENDING'
FROM "AccountMapping" m
JOIN "PlatformBinding" b ON b.id = m."bindingId"
JOIN "PlatformInstance" i ON i.id = b."instanceId"
WHERE (m."remoteUserId" IS NOT NULL OR m."remoteTeamId" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "RemoteRevocation" r WHERE r."bindingId" = b.id AND r."registrationId" = m."registrationId" AND r.state = 'PENDING');
UPDATE "PlatformBinding" SET enabled = false, automatic = false, version = version + 1;
UPDATE "PlatformInstance" SET enabled = false, credentials = '', version = version + 1;
UPDATE "Job" SET state = 'CANCELLED', error = '平台同步已移除，请导出平台导入文件', "leaseToken" = NULL, "leaseUntil" = NULL WHERE kind = 'SYNC';
DELETE FROM "OutboxEvent" WHERE type = 'SYNC_REQUEST';
CREATE TABLE "PlatformExportAccount" (
  id UUID NOT NULL,
  "registrationId" UUID NOT NULL,
  platform TEXT NOT NULL,
  username TEXT NOT NULL,
  credential TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformExportAccount_pkey" PRIMARY KEY (id),
  CONSTRAINT "PlatformExportAccount_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlatformExportAccount_username_key" ON "PlatformExportAccount"(username);
CREATE UNIQUE INDEX "PlatformExportAccount_registrationId_platform_key" ON "PlatformExportAccount"("registrationId",platform);
