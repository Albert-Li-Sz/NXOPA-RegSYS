import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { readBlob } from './storage.js';
import { config } from './config.js';
const [operation, directory] = process.argv.slice(2);
if (!directory || path.resolve(directory) !== path.join(config.storage, '.s3-backup'))
  throw new Error('Use the dedicated storage backup directory');
try {
  if (operation === 'export') {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = await db.attachment.findMany({
        where: { storageBackend: 'S3', deletedAt: null },
      }),
      documents = await db.admissionDocument.findMany({
        where: { storageBackend: 'S3', storageKey: { not: null } },
      });
    const previews = await db.job.findMany({ where: { kind: 'PDF_PREVIEW', state: 'SUCCESS' } });
    const records = [];
    for (const [kind, rows] of [
      ['attachment', files],
      ['admission', documents],
      [
        'preview',
        previews
          .filter((x) => (x.result as any)?.storageBackend === 'S3')
          .map((x) => ({ id: x.id, ...(x.result as any) })),
      ],
    ] as const)
      for (const row of rows) {
        const ref = row as any;
        const name = `${kind}-${row.id}`;
        await writeFile(path.join(directory, name), await readBlob(ref), { mode: 0o600 });
        records.push({ kind, id: row.id, name, sha256: ref.sha256 });
      }
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(records), {
      mode: 0o600,
    });
    console.log(`Exported ${records.length} S3 objects for the encrypted backup.`);
  } else if (operation === 'restore') {
    const manifest = path.join(directory, 'manifest.json');
    let rows: any[] = [];
    try {
      rows = JSON.parse(await readFile(manifest, 'utf8'));
    } catch (error) {
      if ((error as any).code !== 'ENOENT') throw error;
    }
    for (const row of rows) {
      if (!/^(attachment|admission|preview)-[a-f0-9-]{36}$/.test(row.name))
        throw new Error('Invalid backup object path');
      const key = `restored-${row.kind}-${row.id}`;
      const bytes = await readFile(path.join(directory, row.name));
      if (row.sha256 && createHash('sha256').update(bytes).digest('hex') !== row.sha256)
        throw new Error('Backup object checksum mismatch');
      await writeFile(path.join(config.storage, key), bytes, { mode: 0o600 });
      const ref = {
        storageKey: key,
        storageBackend: 'LOCAL',
        storageConfigId: null,
        sha256: row.sha256 ?? '',
      };
      if (row.kind === 'attachment')
        await db.attachment.update({ where: { id: row.id }, data: ref });
      else if (row.kind === 'admission')
        await db.admissionDocument.update({ where: { id: row.id }, data: ref });
      else await db.job.update({ where: { id: row.id }, data: { result: ref } });
    }
    console.log(
      `Restored ${rows.length} S3 objects as local copies; the administrator can migrate them to configured S3 storage.`,
    );
  } else if (operation === 'clean') await rm(directory, { recursive: true, force: true });
  else throw new Error('Unsupported storage operation');
} finally {
  await db.$disconnect();
}
