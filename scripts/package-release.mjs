import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseImages } from './release-images.mjs';
import { validateFullRegression } from './release-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tag = process.argv[2];
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'Supply a stable tag, e.g. v0.6.7');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.version, tag.slice(1), 'Release tag must match package.json');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const output = join(root, 'dist/release');
const stage = join(root, '.runtime/release-package');
const folder = `nxopa-regsys-${tag}`;
const ownerArguments = /bsdtar/i.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }))
  ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
  : ['--owner=0', '--group=0', '--numeric-owner'];
async function normalizeModes(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await normalizeModes(file);
    else await chmod(file, entry.name.endsWith('.sh') ? 0o755 : 0o644);
  }
}
async function archiveBundle() {
  await normalizeModes(join(stage, folder));
  execFileSync(
    'tar',
    [...ownerArguments, '-czf', join(output, `${folder}-install.tar.gz`), '-C', stage, folder],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
}
await rm(output, { recursive: true, force: true });
await rm(stage, { recursive: true, force: true });
await mkdir(output, { recursive: true });
try {
  // Explicit allowlist: never package local environment files, credentials or runtime data.
  for (const name of [
    'install.sh',
    'SECURITY.md',
    'deploy/lib.sh',
    'deploy/compose.yaml',
    'deploy/compose.images.yaml',
    'deploy/compose.amd64.yaml',
    'deploy/compose.arm64.yaml',
    'deploy/compose.caddy.yaml',
    'deploy/compose.gateway.yaml',
    'deploy/compose.proxy.amd64.yaml',
    'deploy/compose.proxy.arm64.yaml',
    'deploy/nginx.conf.example',
    'deploy/.env.example',
    'deploy/README.md',
    'deploy/ACCEPTANCE.md',
    'docs/PLATFORM_GUIDE.md',
    'infra/caddy/Caddyfile',
    'infra/caddy-gateway/Caddyfile',
    'infra/minio/Dockerfile',
    'infra/minio/entrypoint.sh',
    'scripts/backup.sh',
    'scripts/restore.sh',
    'scripts/verify-backup.mjs',
    'scripts/compose-lib.sh',
  ]) {
    const destination = join(stage, folder, name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, name), destination);
  }
  const envExample = join(stage, folder, 'deploy/.env.example');
  const envText = (await readFile(envExample, 'utf8'))
    .replace(/^INSTALL_MODE=.+$/m, 'INSTALL_MODE=images')
    .replace(/^IMAGE_TAG=.+$/m, `IMAGE_TAG=${tag}`);
  await writeFile(envExample, envText);
  const imageCompose = join(stage, folder, 'deploy/compose.images.yaml');
  await writeFile(
    imageCompose,
    (await readFile(imageCompose, 'utf8')).replaceAll(
      /\$\{IMAGE_TAG:-[^}]+\}/g,
      `\${IMAGE_TAG:-${tag}}`,
    ),
  );
  await writeFile(
    join(stage, folder, 'RELEASE.json'),
    JSON.stringify({ tag, commit, mode: 'images' }, null, 2),
  );
  await archiveBundle();
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
  const images = ['api', 'worker', 'web', 'latex', 'minio'].map((service) => ({
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
    if (error.code !== 'ENOENT' || process.env.CI) throw error;
  }
  if (records) {
    validateReleaseImages({ records, tag, commit, prefix });
    await writeFile(
      join(output, 'images.json'),
      JSON.stringify(
        records.sort((a, b) => a.image.localeCompare(b.image)),
        null,
        2,
      ),
    );
    await writeFile(join(stage, folder, 'images.json'), JSON.stringify(records, null, 2));
    await archiveBundle();
  }
  for (const arch of ['amd64', 'arm64']) {
    const name = join(root, 'dist/installation-reports', `installation-${arch}`, 'install.json');
    let report;
    try {
      report = JSON.parse(await readFile(name, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' && !process.env.CI) continue;
      throw error;
    }
    assert.equal(report.success, true);
    assert.equal(report.installMode, 'images');
    assert.equal(report.imageTag, tag);
    assert.equal(report.platform, 'linux');
    assert.equal(report.architecture, arch === 'amd64' ? 'x64' : 'arm64');
    assert.ok(report.checks.length >= 12);
    assert.equal(report.upgradeFrom, 'v0.1.1', `${arch} must exercise the prior release upgrade`);
    assert.ok(
      report.checks.some((check) => check.includes('遗留的验证与重置链接失效')),
      `${arch} must invalidate legacy mailbox links during upgrade`,
    );
    await writeFile(join(output, `installation-${arch}.json`), JSON.stringify(report, null, 2));
    const interactive = JSON.parse(
      await readFile(
        join(root, 'dist/installation-reports', `installation-${arch}`, 'install-interactive.json'),
        'utf8',
      ),
    );
    assert.equal(interactive.success, true);
    assert.equal(interactive.targetTag, tag);
    assert.equal(interactive.initialTag, 'v0.1.5');
    assert.equal(interactive.platform, 'linux');
    assert.equal(interactive.architecture, arch === 'amd64' ? 'x64' : 'arm64');
    assert.ok(interactive.checks.length >= 4);
    await writeFile(
      join(output, `installation-interactive-${arch}.json`),
      JSON.stringify(interactive, null, 2),
    );
    const proxy = JSON.parse(
      await readFile(
        join(root, 'dist/installation-reports', `installation-${arch}`, 'install-proxy.json'),
        'utf8',
      ),
    );
    assert.equal(proxy.success, true);
    assert.equal(proxy.targetTag, tag);
    assert.equal(proxy.platform, 'linux');
    assert.equal(proxy.architecture, arch === 'amd64' ? 'x64' : 'arm64');
    assert.ok(proxy.checks.length >= 5);
    assert.ok(proxy.checks.some((check) => check.includes('真实 HTTPS Nginx → HTTP Caddy')));
    await writeFile(
      join(output, `installation-proxy-${arch}.json`),
      JSON.stringify(proxy, null, 2),
    );
  }
  const featurePath = join(root, 'dist/feature-reports/release-features.json');
  try {
    const features = JSON.parse(await readFile(featurePath, 'utf8'));
    assert.equal(features.success, true);
    assert.equal(features.sourceDirty, false);
    assert.equal(features.tag, tag);
    assert.equal(features.commit, commit);
    assert.equal(features.platform, 'linux');
    assert.ok(features.checks.length >= 6);
    await writeFile(join(output, 'release-features.json'), JSON.stringify(features, null, 2));
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.CI) throw error;
  }
  await cp(
    join(root, 'docs/PLATFORM_GUIDE.md'),
    join(output, `nxopa-regsys-${tag}-platform-guide.md`),
  );
  try {
    const report = JSON.parse(
      await readFile(join(root, 'dist/feature-reports/platform-features.json'), 'utf8'),
    );
    assert.equal(report.success, true);
    assert.equal(report.commit, commit);
    assert.ok(report.checks.length >= 10);
    await writeFile(join(output, 'platform-features.json'), JSON.stringify(report, null, 2));
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.CI) throw error;
  }
  try {
    const report = JSON.parse(
      await readFile(join(root, 'dist/feature-reports/full-regression.json'), 'utf8'),
    );
    validateFullRegression(report, commit);
    await writeFile(join(output, 'full-regression.json'), JSON.stringify(report, null, 2));
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.CI) throw error;
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
