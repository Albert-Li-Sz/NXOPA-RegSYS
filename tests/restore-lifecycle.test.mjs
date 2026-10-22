import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile),
  source = new URL('../', import.meta.url);
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'nxopa-restore-'));
  try {
    for (const dir of ['scripts', 'bin', 'fixture', 'fixture/files'])
      await mkdir(path.join(root, dir), { recursive: true });
    for (const name of [
      'restore.sh',
      'compose-lib.sh',
      'verify-backup.mjs',
      'verify-storage-backup.mjs',
    ])
      await cp(new URL(`scripts/${name}`, source), path.join(root, 'scripts', name));
    await writeFile(path.join(root, '.env'), 'STORAGE_MODE=LOCAL\n');
    await writeFile(path.join(root, 'compose.yaml'), 'services: {}\n');
    await writeFile(path.join(root, 'input.ccbak'), 'encrypted fixture');
    await writeFile(path.join(root, 'fixture/database.dump'), 'database fixture');
    await writeFile(path.join(root, 'fixture/environment.env'), 'STORAGE_MODE=LOCAL\n');
    await writeFile(path.join(root, 'fixture/files/data'), 'private fixture');
    await exec(
      'tar',
      ['-czf', path.join(root, 'fixture/files.tgz'), '-C', path.join(root, 'fixture/files'), '.'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    await exec(
      'tar',
      [
        '-czf',
        path.join(root, 'fixture/raw.tgz'),
        '-C',
        path.join(root, 'fixture'),
        'database.dump',
        'files.tgz',
        'environment.env',
      ],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    await writeFile(
      path.join(root, 'scripts/backup.sh'),
      '#!/usr/bin/env bash\n: > "$RESTORE_TRACE.snapshot"\nexit "${RESTORE_BACKUP_STATUS:-0}"\n',
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, 'bin/docker'),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RESTORE_TRACE"
stage=""
for argument in "$@"; do if [[ "$argument" == */.restore-*:/backup ]]; then stage="${'${argument%:/backup}'}"; fi; done
case "$*" in
 *' ps --status running -q api') echo fixture-api ;;
 *' ps --status running -q worker') echo fixture-worker ;;
 *'archive-crypto.ts decrypt'*) cp "$RESTORE_FIXTURE/raw.tgz" "$stage/raw.tgz" ;;
 *'/verify-backup.mjs /backup/raw.tgz outer'*) node "$RESTORE_HELPERS/verify-backup.mjs" "$stage/raw.tgz" outer ;;
 *'/verify-backup.mjs /backup/files.tgz files'*) node "$RESTORE_HELPERS/verify-backup.mjs" "$stage/files.tgz" files ;;
 *'pg_restore --data-only --table=Setting'*) if [[ "${'${RESTORE_S3:-0}'}" == 1 ]]; then printf 'storage\\t{"mode":"S3"}\\t1\\n'; fi ;;
 *'/verify-storage-backup.mjs /backup'*) node "$RESTORE_HELPERS/verify-storage-backup.mjs" "$stage" ;;
 *'pg_restore '*--clean*) test -f "$RESTORE_TRACE.snapshot"; exit "${'${RESTORE_DATABASE_STATUS:-0}'}" ;;
 *'find /data/storage -mindepth 1 -delete'*) exit "${'${RESTORE_FILES_STATUS:-0}'}" ;;
esac
`,
      { mode: 0o755 },
    );
    const trace = path.join(root, 'trace');
    const invoke = (args = [], variables = {}) => {
      const promise = exec('bash', ['scripts/restore.sh', 'input.ccbak', ...args], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          RESTORE_TRACE: trace,
          RESTORE_FIXTURE: path.join(root, 'fixture'),
          RESTORE_HELPERS: path.join(root, 'scripts'),
          ...variables,
        },
      });
      promise.child.stdin.end();
      return promise;
    };
    await run({ root, trace, invoke, log: () => readFile(trace, 'utf8').catch(() => '') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('restore requires confirmation before any container call', () =>
  fixture(async ({ invoke, log }) => {
    await assert.rejects(invoke());
    assert.equal(await log(), '');
  }));
test('restore rejects a missing S3 manifest even when only the saved DB setting selects S3', () =>
  fixture(async ({ invoke, log, trace }) => {
    await assert.rejects(invoke(['--yes'], { RESTORE_S3: '1' }), /S3 backup manifest/);
    assert.doesNotMatch(await log(), / stop |pg_restore .*--clean/);
    await assert.rejects(readFile(trace + '.snapshot'));
  }));
for (const [name, variables, status] of [
  ['pre-restore snapshot', { RESTORE_BACKUP_STATUS: '47' }, 47],
  ['database restore', { RESTORE_DATABASE_STATUS: '48' }, 48],
  ['private file restore', { RESTORE_FILES_STATUS: '49' }, 49],
])
  test(`restore failure in ${name} stops safely and removes plaintext`, () =>
    fixture(async ({ invoke, log, root }) => {
      await assert.rejects(invoke(['--yes'], variables), (error) => error.code === status);
      const output = await log();
      assert.doesNotMatch(output, / start api/);
      if (status === 47) assert.doesNotMatch(output, / stop |pg_restore .*--clean/);
      else assert.match(output, / stop api worker/);
      assert.ok(
        !(await readdir(path.join(root, '.runtime'))).some((name) => name.startsWith('.restore-')),
      );
    }));
test('successful restore restarts the original services after validation and snapshot', () =>
  fixture(async ({ invoke, log, root }) => {
    await invoke(['--yes']);
    const output = await log();
    assert.match(output, / start api worker/);
    assert.ok(output.indexOf('verify-storage-backup.mjs') < output.indexOf(' stop api worker'));
    assert.equal(
      await readFile(path.join(root, '.runtime/restored-environment.env'), 'utf8'),
      'STORAGE_MODE=LOCAL\n',
    );
  }));
