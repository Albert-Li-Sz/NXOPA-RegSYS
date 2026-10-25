CREATE TABLE "Institution" (
  "id" UUID NOT NULL,
  "code" TEXT,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "shortName" TEXT NOT NULL DEFAULT '',
  "country" TEXT NOT NULL DEFAULT 'CHN',
  "province" TEXT NOT NULL DEFAULT '',
  "city" TEXT NOT NULL DEFAULT '',
  "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "searchText" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'CUSTOM',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Institution_code_key" ON "Institution"("code");
CREATE UNIQUE INDEX "Institution_normalizedName_key" ON "Institution"("normalizedName");
CREATE INDEX "Institution_enabled_name_id_idx" ON "Institution"("enabled", "name", "id");
