import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db, json } from './db.js';
import { readBlob } from './storage.js';
import { config } from './config.js';
const [operation, directory] = process.argv.slice(2);
async function batchParts() {
  const batches = await db.admissionBatch.findMany();
  return batches.flatMap((batch) =>
    ((batch.result as any)?.files ?? []).flatMap((file: any, part: number) =>
      file.storageBackend === 'S3' ? [{ ...file, id: batch.id, part }] : [],
    ),
  );
}
const objectName = (kind: string, id: string, part?: number) =>
  `${kind}-${id}${kind === 'batch' ? `-${part}` : ''}`;
if (!directory || path.resolve(directory) !== path.join(config.storage, '.s3-backup'))
  throw new Error('Use the dedicated storage backup directory');
try {
  if (operation === 'export') {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = await db.attachment.findMany({
        where: { storageBackend: 'S3', purgedAt: null },
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
      ['batch', await batchParts()],
    ] as const)
      for (const row of rows) {
        const ref = row as any;
        const name = objectName(kind, row.id, ref.part);
        await writeFile(
          path.join(directory, name),
          await readBlob(ref, kind === 'batch' ? 101 * 1024 * 1024 : undefined),
          { mode: 0o600 },
        );
        records.push({
          kind,
          id: row.id,
          ...(kind === 'batch' ? { part: ref.part } : {}),
          name,
          sha256: ref.sha256,
        });
      }
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(records), {
      mode: 0o600,
    });
    console.log(`Exported ${records.length} S3 objects for the encrypted backup.`);
  } else if (operation === 'restore') {
    const manifest = path.join(directory, 'manifest.json');
    const [attachments, admissions, previews] = await Promise.all([
      db.attachment.findMany({ where: { storageBackend: 'S3', purgedAt: null } }),
      db.admissionDocument.findMany({ where: { storageBackend: 'S3', storageKey: { not: null } } }),
      db.job.findMany({ where: { kind: 'PDF_PREVIEW', state: 'SUCCESS' } }),
    ]);
    const expected = [
      ...attachments.map((r) => `attachment-${r.id}`),
      ...admissions.map((r) => `admission-${r.id}`),
      ...previews
        .filter((r) => (r.result as any)?.storageBackend === 'S3')
        .map((r) => `preview-${r.id}`),
      ...(await batchParts()).map((r) => objectName('batch', r.id, r.part)),
    ];
    let rows: any[] = [];
    try {
      rows = JSON.parse(await readFile(manifest, 'utf8'));
    } catch (error) {
      if ((error as any).code !== 'ENOENT' || expected.length) throw error;
    }
    if (
      !Array.isArray(rows) ||
      new Set(rows.map((r) => r.name)).size !== rows.length ||
      expected.some((name) => !rows.some((r) => r.name === name))
    )
      throw new Error('Storage backup manifest is incomplete or invalid');
    // Validate the complete manifest and every object before mutating restored references.
    for (const row of rows) {
      if (
        !['attachment', 'admission', 'preview', 'batch'].includes(row.kind) ||
        !/^[a-f0-9-]{36}$/.test(row.id) ||
        (row.kind === 'batch' &&
          (!Number.isInteger(row.part) || row.part < 0 || row.part > 10000)) ||
        row.name !== objectName(row.kind, row.id, row.part) ||
        !expected.includes(row.name)
      )
        throw new Error('Invalid backup object path');
      const bytes = await readFile(path.join(directory, row.name));
      if (row.sha256 && createHash('sha256').update(bytes).digest('hex') !== row.sha256)
        throw new Error('Backup object checksum mismatch');
    }
    for (const row of rows) {
      const key = `restored-${objectName(row.kind, row.id, row.part)}`;
      const bytes = await readFile(path.join(directory, row.name));
      if (row.sha256 && createHash('sha256').update(bytes).digest('hex') !== row.sha256)
        throw new Error('Backup object checksum mismatch');
      await writeFile(path.join(config.storage, key), bytes, { mode: 0o600 });
      const ref = {
        storageKey: key,
        storageBackend: 'LOCAL',
        storageConfigId: null,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      if (row.kind === 'attachment')
        await db.attachment.update({ where: { id: row.id }, data: ref });
      else if (row.kind === 'admission')
        await db.admissionDocument.update({ where: { id: row.id }, data: ref });
      else if (row.kind === 'batch') {
        const batch = await db.admissionBatch.findUniqueOrThrow({ where: { id: row.id } });
        const result = batch.result as any;
        result.files[row.part] = { ...result.files[row.part], ...ref };
        await db.admissionBatch.update({ where: { id: batch.id }, data: { result: json(result) } });
      } else await db.job.update({ where: { id: row.id }, data: { result: ref } });
    }
    console.log(
      `Restored ${rows.length} S3 objects as local copies; the administrator can migrate them to configured S3 storage.`,
    );
  } else if (operation === 'clean') await rm(directory, { recursive: true, force: true });
  else throw new Error('Unsupported storage operation');
} finally {
  await db.$disconnect();
}
