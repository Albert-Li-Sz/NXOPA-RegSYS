import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { validateReleaseImages } from './release-images.mjs';

const tag = process.env.RELEASE_TAG;
assert.match(tag, /^v0\.10\.0$/);
assert.equal(JSON.parse(await readFile('package.json')).version, tag.slice(1));
const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository?.toLowerCase(), 'albert-li-sz/nxopa-regsys');
const prefix = `ghcr.io/${repository.toLowerCase()}`;
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
const stage = '.runtime/release-publication';
await mkdir(stage, { recursive: true });
run('gh', ['release', 'download', tag, '--repo', repository, '--dir', stage, '--clobber']);
run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: stage });
const commit = run('git', ['rev-parse', 'HEAD']);
const records = JSON.parse(await readFile(`${stage}/images.json`, 'utf8'));
validateReleaseImages({ records, tag, commit, prefix });
run('node', ['scripts/verify-published-images.mjs', tag], {
  env: { ...process.env, VERIFY_IMAGE_ALIASES: '0' },
});
for (const record of records) {
  run('docker', [
    'buildx',
    'imagetools',
    'create',
    '--tag',
    `${record.image}:${tag.slice(0, tag.lastIndexOf('.'))}`,
    '--tag',
    `${record.image}:latest`,
    `${record.image}@${record.digest}`,
  ]);
  const latest = JSON.parse(
    run('docker', [
      'buildx',
      'imagetools',
      'inspect',
      `${record.image}:latest`,
      '--format',
      '{{json .Manifest}}',
    ]),
  );
  assert.equal(latest.digest, record.digest);
}
run('node', ['scripts/verify-published-images.mjs', tag]);
run('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
const latest = JSON.parse(run('gh', ['api', `repos/${repository}/releases/latest`]));
assert.equal(latest.tag_name, tag);
await writeFile(
  '.runtime/reports/publication.json',
  JSON.stringify({ success: true, tag, commit, images: records, url: latest.html_url }, null, 2),
);
console.log(`Published ${tag}; all five latest image digests match the verified release.`);
