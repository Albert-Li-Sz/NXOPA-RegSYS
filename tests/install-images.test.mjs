import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { verifyManifestGraph } from '../scripts/verify-registry.mjs';
import { validateReleaseImages } from '../scripts/release-images.mjs';
import { validateLatestPromotion } from '../scripts/release-publication.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/postgres-runtime.json', import.meta.url), 'utf8'),
);
const missing = 'sha256:f9989be93aaf18e0f2ee8da9e8cbaedc1979c5c1aa89e1c8a0dc18524e5eb7f9';
const hash = (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const currentTag = `v${JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version}`;

test('Latest 仅允许提升较新稳定草稿或继续当前公开版本', () => {
  for (const [tag, latestTag, draft] of [
    ['v0.10.1', 'v0.10.0', true],
    ['v0.10.10', 'v0.10.9', true],
    ['v1.0.0', 'v0.99.9', true],
    ['v0.10.1', 'v0.10.1', false],
  ])
    assert.doesNotThrow(() => validateLatestPromotion({ tag, latestTag, draft }));
  for (const [tag, latestTag, draft] of [
    ['v0.10.0', 'v0.10.1', true],
    ['v0.10.1', 'v0.10.1', true],
    ['v0.10.1', 'v0.10.0', false],
    ['v2.0.0-rc1', 'v0.10.1', true],
    ['v00.10.2', 'v0.10.1', true],
    ['latest', 'v0.10.1', true],
  ])
    assert.throws(() => validateLatestPromotion({ tag, latestTag, draft }));
});

test('发布镜像清单严格核验固定版本、来源提交及五类服务', () => {
  const prefix = 'ghcr.io/example/project',
    tag = 'v1.2.3',
    commit = 'fixture-commit';
  const records = ['api', 'worker', 'web', 'latex', 'minio'].map((service) => ({
    image: `${prefix}-${service}`,
    tag,
    commit,
    digest: hash(service),
  }));
  const options = { records, tag, commit, prefix };
  assert.doesNotThrow(() => validateReleaseImages(options));
  for (const change of [
    { records: records.slice(1) },
    { commit: 'stale-source' },
    { tag: 'v1.2.4' },
    { records: records.map((r) => ({ ...r, digest: 'sha256:invalid' })) },
    { records: [...records.slice(0, 4), records[0]] },
  ])
    assert.throws(() => validateReleaseImages({ ...options, ...change }));
});

for (const arch of ['amd64', 'arm64']) {
  for (const proxy of ['gateway', 'caddy', 'external']) {
    test(`${arch}/${proxy} 最终 Compose 对全部服务使用固定版本标签`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'nxopa-images-'));
      const deploy = fileURLToPath(new URL('../deploy/', import.meta.url));
      const envFile = join(dir, '.env');
      await writeFile(envFile, '');
      try {
        const args = [
          'compose',
          '--project-directory',
          deploy,
          '--env-file',
          envFile,
          '--profile',
          '*',
          '-f',
          join(deploy, 'compose.yaml'),
          '-f',
          join(deploy, `compose.${arch}.yaml`),
          '-f',
          join(deploy, 'compose.images.yaml'),
        ];
        if (proxy !== 'external')
          args.push(
            '-f',
            join(deploy, `compose.${proxy}.yaml`),
            '-f',
            join(deploy, `compose.proxy.${arch}.yaml`),
          );
        const prefix = 'ghcr.io/example/fixture';
        for (const tag of ['v1.2.3', '']) {
          const config = JSON.parse(
            execFileSync('docker', [...args, 'config', '--format', 'json'], {
              encoding: 'utf8',
              env: {
                ...process.env,
                INSTALL_ENV_FILE: envFile,
                IMAGE_PREFIX: prefix,
                IMAGE_TAG: tag,
                POSTGRES_PASSWORD: 'fixture-only',
                ENCRYPTION_KEY: '1'.repeat(64),
              },
            }),
          );
          for (const service of ['initialize', 'api', 'worker', 'web', 'latex', 'minio']) {
            const image = service === 'initialize' ? 'api' : service;
            assert.equal(config.services[service].image, `${prefix}-${image}:${tag || currentTag}`);
            assert.equal(config.services[service].build, undefined);
          }
          assert.equal(config.services.postgres.image, 'postgres:17.6-alpine');
          assert.equal(config.services.postgres.platform, `linux/${arch}`);
          assert.equal(config.services.redis.image, 'redis:7.4.5-alpine');
          if (proxy !== 'external') {
            assert.equal(config.services.caddy.image, 'caddy:2.10.2-alpine');
            assert.equal(config.services.caddy.platform, `linux/${arch}`);
          }
          for (const service of Object.values(config.services))
            assert.doesNotMatch(service.image, /@|:latest$/);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

async function withIncompleteMirror(check) {
  const bodies = new Map();
  const sizes = new Map();
  for (const record of Object.values(fixture)) {
    bodies.set(`manifests/${record.digest}`, record.manifest);
    bodies.set(`blobs/${hash(record.config)}`, record.config);
    for (const layer of JSON.parse(record.manifest).layers)
      sizes.set(`blobs/${layer.digest}`, layer.size);
  }
  assert.equal(hash(fixture.attestation.config), missing);
  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      { digest: fixture.amd64.digest, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: fixture.attestation.digest, platform: { os: 'unknown', architecture: 'unknown' } },
    ],
  });
  bodies.set('manifests/17.6-alpine', index);
  // Reproduce a mirror whose index is present but the exact reported config is absent.
  bodies.delete(`blobs/${missing}`);
  const visited = [];
  const server = createServer((req, res) => {
    const key = req.url.slice('/v2/library/postgres/'.length);
    visited.push(key);
    const body = bodies.get(key);
    if (req.method === 'HEAD' && sizes.has(key)) {
      res.writeHead(200, { 'Content-Length': sizes.get(key) });
      res.end();
    } else if (body !== undefined) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Docker-Content-Digest': hash(body),
      });
      res.end(body);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'BLOB_UNKNOWN' }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v2/library/postgres/`;
  const request = (kind, ref, method) => fetch(`${url}${kind}/${ref}`, { method });
  try {
    await check(request, visited);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('不完整镜像代理中的证明配置缺失会被捕获，不能只验证可运行架构', () =>
  withIncompleteMirror(async (request) => {
    await assert.rejects(
      verifyManifestGraph('17.6-alpine', request),
      (error) => error.message.includes(missing) && error.message.includes('HTTP 404'),
    );
  }));

for (const arch of ['amd64', 'arm64']) {
  test(`${arch} 发布核验能检查官方运行清单的架构及实际版本`, () =>
    withIncompleteMirror(async (request, visited) => {
      const result = await verifyManifestGraph(fixture[arch].digest, request);
      assert.equal(result.records[0].config.architecture, arch);
      assert.ok(result.records[0].config.config.Env.includes('PG_VERSION=17.6'));
      assert.ok(!visited.includes(`blobs/${missing}`));
    }));
}
