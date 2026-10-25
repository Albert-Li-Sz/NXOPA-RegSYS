import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Pass the extracted backup root');
const environment = await readFile(path.join(root, 'environment.env'), 'utf8');
const settings = await readFile(path.join(root, 'settings.sql'), 'utf8');
const directory = path.join(root, 'files/.s3-backup');
let rows;
try {
  rows = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
} catch (error) {
  if (
    error.code !== 'ENOENT' ||
    /^(?:STORAGE_MODE)=(?:S3|MINIO)\s*$/m.test(environment) ||
    /^storage\t.*"mode"\s*:\s*"(?:S3|MINIO)"/m.test(settings)
  )
    throw new Error('S3 backup manifest is missing or invalid');
  rows = [];
}
if (!Array.isArray(rows) || new Set(rows.map((r) => r.name)).size !== rows.length)
  throw new Error('S3 manifest must contain distinct objects');
for (const row of rows) {
  if (
    !/^(attachment|admission|preview)-[a-f0-9-]{36}$/i.test(row.name) ||
    !/^[a-f0-9]{64}$/i.test(row.sha256)
  )
    throw new Error('Invalid S3 backup entry');
  const file = path.join(directory, row.name);
  if (
    !(await stat(file)).isFile() ||
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex') !== row.sha256
  )
    throw new Error('S3 backup object is missing or damaged');
}
console.log(`Storage backup preflight passed: ${rows.length} objects`);
