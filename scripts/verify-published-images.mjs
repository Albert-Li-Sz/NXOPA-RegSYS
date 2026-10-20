import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { verifyManifestGraph } from './verify-registry.mjs';

const tag = process.argv[2] ?? 'v0.6.5';
assert.match(tag, /^v\d+\.\d+\.\d+$/);
const prefix = process.env.IMAGE_PREFIX ?? 'ghcr.io/albert-li-sz/nxopa-regsys';
assert.ok(prefix.startsWith('ghcr.io/'));
const commit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
const accept =
  'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
const images = [];
for (const service of ['api', 'worker', 'web', 'latex', 'minio']) {
  const image = `${prefix}-${service}`;
  const repository = image.slice('ghcr.io/'.length);
  // Request an anonymous, pull-only registry token. No Docker or GitHub credentials are read.
  const auth = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(auth.status, 200, `${image} must permit anonymous pulls`);
  const token = (await auth.json()).token;
  assert.ok(token);
  const get = async (kind, reference) => {
    const response = await fetch(`https://ghcr.io/v2/${repository}/${kind}/${reference}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, `${image}/${kind}/${reference}`);
    const body = await response.text();
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if (kind === 'manifests') assert.equal(response.headers.get('docker-content-digest'), digest);
    return { digest, data: JSON.parse(body) };
  };
  const index = await verifyManifestGraph(tag, (kind, reference, method) =>
    fetch(`https://ghcr.io/v2/${repository}/${kind}/${reference}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal: AbortSignal.timeout(30000),
    }),
  );
  const platforms = index.data.manifests.filter(
    (m) => m.platform?.os === 'linux' && ['amd64', 'arm64'].includes(m.platform.architecture),
  );
  assert.deepEqual(platforms.map((m) => m.platform.architecture).sort(), ['amd64', 'arm64']);
  for (const record of index.records.filter((r) => r.platform?.os === 'linux')) {
    assert.equal(record.config.architecture, record.platform.architecture);
    assert.equal(record.config.config.Labels['org.opencontainers.image.revision'], commit);
    assert.equal(record.config.config.Labels['org.opencontainers.image.version'], tag);
  }
  const alias = await get('manifests', tag.replace(/\.\d+$/, ''));
  assert.equal(alias.digest, index.digest);
  const latest = await get('manifests', 'latest');
  assert.equal(latest.digest, index.digest);
  images.push({
    image,
    tag,
    digest: index.digest,
    commit,
    platforms: ['linux/amd64', 'linux/arm64'],
    anonymousPull: true,
    allConfigsAvailable: true,
    availableLayers: index.availableLayers,
  });
  console.log(`公开镜像核验通过：${image}:${tag}，amd64 / arm64，源提交一致。`);
}
await mkdir('.runtime/reports', { recursive: true });
await writeFile(
  '.runtime/reports/published-images.json',
  JSON.stringify({ success: true, checkedAt: new Date().toISOString(), images }, null, 2),
);
