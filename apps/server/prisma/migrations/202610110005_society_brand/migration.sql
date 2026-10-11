-- Brand existing installations without changing their configured theme.
UPDATE "Setting"
SET "value" = jsonb_set(
  jsonb_set("value", '{name}', '"南晓开放原子社在线报名系统"'::jsonb, true),
  '{footer}', '"南晓开放原子社 · 南京晓庄学院 ICPC 集训队"'::jsonb, true
), "version" = "version" + 1
WHERE "key" = 'site';

-- Third-party sign-in is retired. Keep historical identity records for recovery.
UPDATE "OAuthProvider" SET "enabled" = false, "version" = "version" + 1
WHERE "enabled" = true;
DELETE FROM "Session" WHERE "userId" IN (
  SELECT "id" FROM "User" WHERE "passwordHash" IS NULL
);
