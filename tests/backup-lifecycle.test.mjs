import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
for (const [running, restartFails] of [
  [true, false],
  [true, true],
  [false, false],
]) {
  test(`backup always removes plaintext after failure (running=${running}, restartFails=${restartFails})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxopa-backup-lifecycle-'));
    try {
      await mkdir(path.join(root, 'scripts'));
      await mkdir(path.join(root, 'bin'));
      for (const name of ['backup.sh', 'compose-lib.sh'])
        await cp(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
      await writeFile(path.join(root, '.env'), 'STORAGE_MODE=LOCAL\n');
      await writeFile(
        path.join(root, 'bin/docker'),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$BACKUP_TRACE"
case "$*" in
  inspect*State.Running*) if [[ "$*" == *fixture-api && "$BACKUP_WAS_RUNNING" == 1 ]]; then echo true; else echo false; fi ;;
  inspect*Image*) echo 'sha256:${'1'.repeat(64)}' ;;
  *' ps -a -q api') echo fixture-api ;;
  *' ps -a -q worker') echo fixture-worker ;;
  *' start '*) exit "$BACKUP_RESTART_FAIL" ;;
  *pg_dump*) printf 'sensitive-fixture'; exit 42 ;;
esac
`,
        { mode: 0o755 },
      );
      await assert.rejects(
        exec('bash', ['scripts/backup.sh', 'backups'], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${root}/bin:${process.env.PATH}`,
            BACKUP_TRACE: path.join(root, 'trace'),
            BACKUP_WAS_RUNNING: running ? '1' : '0',
            BACKUP_RESTART_FAIL: restartFails ? '1' : '0',
          },
        }),
        (error) => error.code === (restartFails ? 1 : 42),
      );
      assert.deepEqual(await readdir(path.join(root, 'backups')), []);
      const starts = (await readFile(path.join(root, 'trace'), 'utf8'))
        .split('\n')
        .filter((line) => line.includes(' start '));
      assert.equal(starts.length, running ? 1 : 0);
      if (running) assert.match(starts[0], / start api$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
