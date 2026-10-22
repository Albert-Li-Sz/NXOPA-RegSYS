import type { Job } from '@prisma/client';
import { db, type Tx } from './db.js';
// Keep at most two compiler slots (running plus queued) per activity. Prefer the
// activity that has waited longest, so a large batch cannot fill the shared queue.
export async function pendingPdfJobs(database: Tx = db) {
  return database.$queryRaw<Job[]>`WITH classified AS (
    SELECT j.id,j.state,j.attempts,j."createdAt",j."updatedAt",
      CASE WHEN j.kind='ADMISSION' THEN COALESCE(r."contestId"::text,j."resourceId") ELSE 'preview:'||j."resourceId" END AS tenant
    FROM "Job" j LEFT JOIN "Registration" r ON j."resourceId"=r.id::text AND j.kind='ADMISSION'
    WHERE j.kind IN ('ADMISSION','PDF_PREVIEW')
  ), last_run AS (
    SELECT tenant,max("updatedAt") FILTER (WHERE attempts>0) AS started FROM classified GROUP BY tenant
  ), ranked AS (
    SELECT c.*,row_number() OVER (PARTITION BY tenant ORDER BY (state='RUNNING') DESC,"createdAt",id) AS n
    FROM classified c WHERE state='RUNNING' OR (attempts<4 AND (state='PENDING' OR (state='FAILED' AND "updatedAt"<NOW()-interval '30 seconds')))
  ) SELECT j.* FROM ranked c JOIN "Job" j ON j.id=c.id JOIN last_run l ON l.tenant=c.tenant
    WHERE c.n<=2 AND c.state<>'RUNNING' ORDER BY l.started NULLS FIRST,c."createdAt",c.id LIMIT 50`;
}
