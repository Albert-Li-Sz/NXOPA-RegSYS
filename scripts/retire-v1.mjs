import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const [mode, file] = process.argv.slice(2);
assert.ok(['prepare', 'execute'].includes(mode));
assert.equal(file, '.runtime/retire-v1-inventory.json');
const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository?.toLowerCase(), 'albert-li-sz/nxopa-regsys');
const owner = repository.split('/')[0];
const run = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function api(path, method = 'GET') {
  try {
    const result = run(['api', '--method', method, path]);
    return result ? JSON.parse(result) : null;
  } catch (error) {
    if (String(error.stderr).includes('(HTTP 404)')) return null;
    throw error;
  }
}
assert.equal(
  api(`repos/${repository}/releases/latest`).tag_name,
  'v0.10.0',
  'Publish and verify v0.10.0 before retiring v1.0.0',
);
const registryTokens = new Map();
const accept =
  'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
async function manifest(name, reference) {
  const image = `${owner.toLowerCase()}/${name}`;
  if (!registryTokens.has(image)) {
    const response = await fetch(
      `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${image}:pull`)}`,
    );
    assert.equal(response.status, 200);
    registryTokens.set(image, (await response.json()).token);
  }
  const response = await fetch(`https://ghcr.io/v2/${image}/manifests/${reference}`, {
    headers: { Authorization: `Bearer ${registryTokens.get(image)}`, Accept: accept },
  });
  assert.equal(response.status, 200, `${image}:${reference}`);
  return { digest: response.headers.get('docker-content-digest'), data: await response.json() };
}
async function graph(name, root, visited = new Set()) {
  if (visited.has(root)) return visited;
  visited.add(root);
  const { data } = await manifest(name, root);
  for (const child of data.manifests ?? []) await graph(name, child.digest, visited);
  return visited;
}
function versions(name) {
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = api(
      `users/${owner}/packages/container/${encodeURIComponent(name)}/versions?per_page=100&page=${page}`,
    );
    assert.ok(Array.isArray(batch), `Cannot inventory ${name}`);
    rows.push(...batch);
    if (batch.length < 100) return rows;
    assert.ok(page < 100, 'Package inventory exceeds the expected bound');
  }
}
const retiredTags = new Set(['v1.0.0', 'v1.0']);
if (mode === 'prepare') {
  const release = api(`repos/${repository}/releases/tags/v1.0.0`);
  assert.ok(release && !release.immutable);
  const stage = '.runtime/retired-v1-assets';
  await mkdir(stage, { recursive: true });
  run([
    'release',
    'download',
    'v1.0.0',
    '--repo',
    repository,
    '--pattern',
    'images.json',
    '--dir',
    stage,
    '--clobber',
  ]);
  const images = JSON.parse(await readFile(`${stage}/images.json`, 'utf8'));
  assert.equal(images.length, 5);
  const inventory = [];
  for (const record of images) {
    assert.equal(record.tag, 'v1.0.0');
    const name = record.image.split('/').at(-1);
    assert.match(name, /^nxopa-regsys-(api|worker|web|latex|minio)$/);
    const before = versions(name);
    const oldRoot = await manifest(name, 'v1.0.0');
    assert.equal(oldRoot.digest, record.digest);
    const oldGraph = await graph(name, oldRoot.digest);
    const protectedGraph = new Set();
    for (const version of before.filter((v) =>
      v.metadata.container.tags.some((tag) => !retiredTags.has(tag)),
    ))
      await graph(name, version.name, protectedGraph);
    assert.ok(
      !protectedGraph.has(oldRoot.digest),
      `${name}: v1 root is still referenced by another tag`,
    );
    const deletions = before
      .filter((v) => oldGraph.has(v.name) && !protectedGraph.has(v.name))
      .map((v) => ({ id: v.id, digest: v.name, tags: v.metadata.container.tags }));
    assert.ok(deletions.some((v) => v.digest === oldRoot.digest));
    const legacy = await manifest(name, 'v0.9.2');
    const current = await manifest(name, 'v0.10.0');
    assert.equal((await manifest(name, 'latest')).digest, current.digest);
    inventory.push({
      name,
      before,
      deletions,
      legacyDigest: legacy.digest,
      currentDigest: current.digest,
    });
    console.log(
      `${name}: ${deletions.length} exclusive v1 manifests selected; ${protectedGraph.size} referenced manifests protected`,
    );
  }
  await writeFile(file, JSON.stringify({ repository, release, images: inventory }, null, 2));
} else {
  const inventory = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(inventory.repository, repository);
  assert.equal(inventory.release.tag_name, 'v1.0.0');
  assert.equal(inventory.images.length, 5);
  for (const image of inventory.images) {
    assert.equal((await manifest(image.name, 'latest')).digest, image.currentDigest);
    for (const deletion of image.deletions) {
      const path = `users/${owner}/packages/container/${encodeURIComponent(image.name)}/versions/${deletion.id}`;
      const current = api(path);
      if (!current) continue;
      assert.equal(current.name, deletion.digest);
      assert.deepEqual(
        [...current.metadata.container.tags].sort(),
        [...deletion.tags].sort(),
        'Tags changed after inventory; stop deletion',
      );
      assert.ok(current.metadata.container.tags.every((tag) => retiredTags.has(tag)));
      api(path, 'DELETE');
    }
    assert.ok(
      !versions(image.name).some((v) =>
        v.metadata.container.tags.some((tag) => retiredTags.has(tag)),
      ),
    );
    assert.equal((await manifest(image.name, 'v0.9.2')).digest, image.legacyDigest);
    assert.equal((await manifest(image.name, 'v0.10.0')).digest, image.currentDigest);
    console.log(`${image.name}: v1 removed; v0.9.2 and v0.10.0 digests unchanged`);
  }
  const current = api(`repos/${repository}/releases/tags/v1.0.0`);
  if (current) {
    assert.equal(current.id, inventory.release.id);
    run(['release', 'delete', 'v1.0.0', '--repo', repository, '--cleanup-tag', '--yes']);
  }
  assert.equal(api(`repos/${repository}/releases/tags/v1.0.0`), null);
  assert.equal(api(`repos/${repository}/git/ref/tags/v1.0.0`), null);
  assert.ok(api(`repos/${repository}/releases/tags/v0.9.2`));
  await writeFile(
    '.runtime/reports/retired-v1.json',
    JSON.stringify(
      {
        success: true,
        published: 'v0.10.0',
        retired: 'v1.0.0',
        images: inventory.images.map(({ name, deletions, legacyDigest, currentDigest }) => ({
          name,
          deletions,
          legacyDigest,
          currentDigest,
        })),
      },
      null,
      2,
    ),
  );
}
