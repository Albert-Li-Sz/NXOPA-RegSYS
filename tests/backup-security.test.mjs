import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateBackup } from '../scripts/verify-backup.mjs';
import { execFileSync } from 'node:child_process';
function entry(name, body = Buffer.from('fixture'), type = '0', link = '') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000600\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(link, 157, 100);
  header.write('ustar\0', 257);
  const sum = [...header].reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const archive = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
async function fixture(body, run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nxopa-backup-audit-'));
  try {
    const file = path.join(dir, 'input.tgz');
    await writeFile(file, body);
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test('accept the generated three-file outer backup', () =>
  fixture(
    archive(entry('database.dump'), entry('files.tgz'), entry('environment.env')),
    async (file) => {
      assert.equal((await validateBackup(file, 'outer')).entries, 3);
    },
  ));
test('accept ordinary private objects and S3 staging files', () =>
  fixture(
    archive(
      entry('./', Buffer.alloc(0), '5'),
      entry('./object-key'),
      entry('./.s3-backup/', Buffer.alloc(0), '5'),
      entry('./.s3-backup/manifest.json'),
    ),
    async (file) => {
      assert.equal((await validateBackup(file, 'files')).entries, 4);
    },
  ));
for (const name of ['../../outside', '/absolute', 'folder/../outside', 'C:\\outside'])
  test(`reject nested traversal ${name}`, () =>
    fixture(archive(entry(name)), (file) => assert.rejects(validateBackup(file, 'files'))));
for (const type of ['1', '2', '3', '4', '6'])
  test(`reject link or special entry type ${type}`, () =>
    fixture(archive(entry('object', Buffer.alloc(0), type, '../../outside')), (file) =>
      assert.rejects(validateBackup(file, 'files')),
    ));
test('reject duplicate archive members', () =>
  fixture(archive(entry('object'), entry('object')), (file) =>
    assert.rejects(validateBackup(file, 'files')),
  ));
test('reject expansion before extraction', () =>
  fixture(archive(entry('object', Buffer.alloc(4096))), (file) =>
    assert.rejects(validateBackup(file, 'files', { maxBytes: 100 })),
  ));
test('reject unexpected outer member', () =>
  fixture(
    archive(entry('database.dump'), entry('files.tgz'), entry('environment.env'), entry('extra')),
    (file) => assert.rejects(validateBackup(file, 'outer')),
  ));
test('reject truncated tar', () =>
  fixture(gzipSync(entry('object')), (file) => assert.rejects(validateBackup(file, 'files'))));
test('PAX paths receive the same traversal checks', () => {
  let value = 'path=../../outside\n',
    length = value.length + 3;
  while (`${length} ${value}`.length !== length) length = `${length} ${value}`.length;
  return fixture(
    archive(entry('PaxHeaders/object', Buffer.from(`${length} ${value}`), 'x'), entry('object')),
    (file) => assert.rejects(validateBackup(file, 'files')),
  );
});
test('GNU long names receive the same traversal checks', () =>
  fixture(
    archive(entry('././@LongLink', Buffer.from('../../outside\0'), 'L'), entry('object')),
    (file) => assert.rejects(validateBackup(file, 'files')),
  ));
test('valid long object names are retained', () =>
  fixture(
    archive(entry('././@LongLink', Buffer.from('a'.repeat(150) + '\0'), 'L'), entry('object')),
    async (file) => {
      assert.equal((await validateBackup(file, 'files')).entries, 1);
    },
  ));
test('host tar omits platform metadata and produces a strictly valid backup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nxopa-backup-host-'));
  try {
    const members = ['database.dump', 'files.tgz', 'environment.env'];
    for (const name of members) await writeFile(path.join(dir, name), 'fixture');
    if (process.platform === 'darwin')
      execFileSync('xattr', [
        '-w',
        'user.nxopa-test',
        'unnecessary metadata',
        path.join(dir, members[0]),
      ]);
    const flags = ['--no-xattrs', '--no-acls'];
    if (/bsdtar/i.test(execFileSync('tar', ['--version'], { encoding: 'utf8' })))
      flags.push('--no-fflags');
    const file = path.join(dir, 'backup.tgz');
    execFileSync('tar', [...flags, '-czf', file, '-C', dir, ...members], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    assert.equal((await validateBackup(file, 'outer')).entries, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('storage preflight validates batch archive hashes and rejects traversal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nxopa-storage-preflight-'));
  try {
    const objects = path.join(dir, 'files/.s3-backup');
    await mkdir(objects, { recursive: true });
    await writeFile(path.join(dir, 'environment.env'), 'STORAGE_MODE=S3\n');
    await writeFile(path.join(dir, 'settings.sql'), '');
    const name = 'batch-11111111-1111-4111-8111-111111111111-0';
    const bytes = Buffer.from('PK archive');
    const manifest = path.join(objects, 'manifest.json');
    const row = { name, sha256: createHash('sha256').update(bytes).digest('hex') };
    await writeFile(path.join(objects, name), bytes);
    await writeFile(manifest, JSON.stringify([row]));
    const verify = () =>
      execFileSync(process.execPath, ['scripts/verify-storage-backup.mjs', dir], { stdio: 'pipe' });
    assert.match(verify().toString(), /1 objects/);
    await writeFile(path.join(objects, name), 'damaged');
    assert.throws(verify);
    await writeFile(manifest, JSON.stringify([{ ...row, name: `../${name}` }]));
    assert.throws(verify);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
