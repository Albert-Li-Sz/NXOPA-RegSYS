import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const fixture = vi.hoisted(() => ({
  config: { storage: '' },
  files: [],
  documents: [],
  previews: [],
  batches: [],
  update: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('../../apps/server/src/config.js', () => ({ config: fixture.config }));
vi.mock('../../apps/server/src/db.js', () => ({
  db: {
    attachment: { findMany: async () => fixture.files, update: fixture.update },
    admissionDocument: { findMany: async () => fixture.documents, update: fixture.update },
    job: { findMany: async () => fixture.previews, update: fixture.update },
    admissionBatch: {
      findMany: async () => fixture.batches,
      findUniqueOrThrow: async ({ where }) =>
        fixture.batches.find((batch) => batch.id === where.id),
      update: fixture.update,
    },
    $disconnect: fixture.disconnect,
  },
  json: (value) => value,
}));
vi.mock('../../apps/server/src/storage.js', () => ({ readBlob: vi.fn() }));
const originalArgs = [...process.argv];
const id = '11111111-1111-4111-8111-111111111111';
const name = `attachment-${id}`;
let directory;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.files = [];
  fixture.documents = [];
  fixture.previews = [];
  fixture.batches = [];
  fixture.config.storage = await mkdtemp(path.join(tmpdir(), 'nxopa-storage-restore-'));
  directory = path.join(fixture.config.storage, '.s3-backup');
  await mkdir(directory);
  process.argv = [process.execPath, 'storage-cli.ts', 'restore', directory];
});
afterEach(async () => {
  process.argv = [...originalArgs];
  await rm(fixture.config.storage, { recursive: true, force: true });
});
it('accepts a legacy LOCAL-only backup without a manifest', async () => {
  await import('../../apps/server/src/storage-cli.ts');
  expect(fixture.update).not.toHaveBeenCalled();
});
it('refuses a missing manifest when the database requires an S3 object', async () => {
  fixture.files = [{ id }];
  await expect(import('../../apps/server/src/storage-cli.ts')).rejects.toThrow('ENOENT');
  expect(fixture.update).not.toHaveBeenCalled();
});
it('refuses an incomplete manifest before rewriting any references', async () => {
  fixture.files = [{ id }];
  await writeFile(path.join(directory, 'manifest.json'), '[]');
  await expect(import('../../apps/server/src/storage-cli.ts')).rejects.toThrow('incomplete');
  expect(fixture.update).not.toHaveBeenCalled();
});
it('validates content before writing and recomputes missing historical hashes', async () => {
  fixture.files = [{ id }];
  const bytes = Buffer.from('historical object');
  await writeFile(path.join(directory, name), bytes);
  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify([{ kind: 'attachment', id, name }]),
  );
  await import('../../apps/server/src/storage-cli.ts');
  expect(fixture.update).toHaveBeenCalledWith({
    where: { id },
    data: {
      storageKey: `restored-attachment-${id}`,
      storageBackend: 'LOCAL',
      storageConfigId: null,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
  expect(await readFile(path.join(fixture.config.storage, `restored-attachment-${id}`))).toEqual(
    bytes,
  );
});
it('requires and restores every batch ZIP part while preserving its target snapshot', async () => {
  const file = {
    storageKey: 'archive',
    storageBackend: 'S3',
    name: 'admissions-1.zip',
    targets: [{ id, version: 3 }],
  };
  fixture.batches = [{ id, result: { files: [file], items: [] } }];
  await writeFile(path.join(directory, 'manifest.json'), '[]');
  await expect(import('../../apps/server/src/storage-cli.ts')).rejects.toThrow('incomplete');
  expect(fixture.update).not.toHaveBeenCalled();
  vi.resetModules();
  const bytes = Buffer.from('PK archive bytes');
  const batchName = `batch-${id}-0`;
  await writeFile(path.join(directory, batchName), bytes);
  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify([{ kind: 'batch', id, part: 0, name: batchName }]),
  );
  await import('../../apps/server/src/storage-cli.ts');
  expect(fixture.update).toHaveBeenCalledWith({
    where: { id },
    data: {
      result: {
        files: [
          {
            ...file,
            storageKey: `restored-${batchName}`,
            storageBackend: 'LOCAL',
            storageConfigId: null,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
        items: [],
      },
    },
  });
});
