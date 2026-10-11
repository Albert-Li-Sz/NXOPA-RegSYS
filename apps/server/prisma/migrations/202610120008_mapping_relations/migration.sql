ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_bindingId_fkey"
  FOREIGN KEY ("bindingId") REFERENCES "PlatformBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "AccountMapping_bindingId_idx" ON "AccountMapping"("bindingId");
