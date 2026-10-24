import { config as dotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const serverRoot = path.join(root, 'apps/server');
dotenv({ path: path.join(root, '.env'), quiet: true });
dotenv({ quiet: true });
export const config = {
  root,
  port: Number(process.env.PORT ?? 3000),
  production: process.env.NODE_ENV === 'production',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:56379',
  storage: path.resolve(serverRoot, process.env.STORAGE_DIR ?? '../../.runtime/storage'),
  spool: path.resolve(serverRoot, process.env.LATEX_SPOOL ?? '../../.runtime/latex'),
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
};
if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535');
if (
  process.env.UPLOAD_QUOTA_MB !== undefined &&
  (!Number.isFinite(Number(process.env.UPLOAD_QUOTA_MB)) ||
    Number(process.env.UPLOAD_QUOTA_MB) <= 0)
)
  throw new Error('UPLOAD_QUOTA_MB must be a positive number');
if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey))
  throw new Error('ENCRYPTION_KEY must be 32 random bytes in hexadecimal; run pnpm setup');
