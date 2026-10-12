import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tag = process.argv[2];
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'Supply a stable tag, e.g. v0.1.1');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.version, tag.slice(1), 'Release tag must match package.json');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const output = join(root, 'dist/release');
const stage = join(root, '.runtime/release-package');
const folder = `nxopa-regsys-${tag}`;
await rm(output, { recursive: true, force: true });
await rm(stage, { recursive: true, force: true });
await mkdir(output, { recursive: true });
try {
  // Explicit allowlist: never package local environment files, credentials or runtime data.
  for (const name of [
    'install/install.sh',
    'install/compose.yaml',
    'install/compose.images.yaml',
    'install/.env.example',
    'install/README.md',
    'install/ACCEPTANCE.md',
    'infra/caddy/Caddyfile',
    'scripts/backup.sh',
    'scripts/restore.sh',
    'scripts/compose-lib.sh',
  ]) {
    const destination = join(stage, folder, name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, name), destination);
  }
  const envExample = join(stage, folder, 'install/.env.example');
  const envText = (await readFile(envExample, 'utf8'))
    .replace(/^INSTALL_MODE=.+$/m, 'INSTALL_MODE=images')
    .replace(/^IMAGE_TAG=.+$/m, `IMAGE_TAG=${tag}`);
  await writeFile(envExample, envText);
  await writeFile(
    join(stage, folder, 'RELEASE.json'),
    JSON.stringify({ tag, commit, mode: 'images' }, null, 2),
  );
  execFileSync('tar', ['-czf', join(output, `${folder}-install.tar.gz`), '-C', stage, folder], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  for (const name of ['configuration-guide.pdf', 'configuration-guide-source.zip']) {
    await cp(join(root, 'output/pdf', name), join(output, name));
  }
  execFileSync(
    'pnpm',
    ['--dir', 'plugins/hydro-contest-center', 'pack', '--pack-destination', output],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const prefix = process.env.IMAGE_PREFIX ?? 'ghcr.io/albert-li-sz/nxopa-regsys';
  const images = ['api', 'worker', 'web', 'latex'].map((service) => ({
    service,
    image: `${prefix}-${service}:${tag}`,
  }));
  await writeFile(
    join(output, 'release-info.json'),
    JSON.stringify({ tag, commit, images }, null, 2),
  );
  let records;
  try {
    const files = (await readdir(join(root, 'dist/image-manifests'))).filter((name) =>
      name.endsWith('.json'),
    );
    records = await Promise.all(
      files.map(async (name) =>
        JSON.parse(await readFile(join(root, 'dist/image-manifests', name), 'utf8')),
      ),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (records) {
    assert.equal(records.length, 4);
    for (const record of records) {
      assert.equal(record.tag, tag);
      assert.equal(record.commit, commit);
      assert.match(record.digest, /^sha256:[a-f0-9]{64}$/);
    }
    await writeFile(
      join(output, 'images.json'),
      JSON.stringify(
        records.sort((a, b) => a.image.localeCompare(b.image)),
        null,
        2,
      ),
    );
  }
  const names = (await readdir(output)).sort();
  const checksums = await Promise.all(
    names.map(
      async (name) =>
        `${createHash('sha256')
          .update(await readFile(join(output, name)))
          .digest('hex')}  ${name}`,
    ),
  );
  await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  console.log(`发布包已生成：${output}，提交 ${commit}，${names.length} 个附件。`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
