import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { verifyManifestGraph } from '../scripts/verify-registry.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/postgres-runtime.json', import.meta.url), 'utf8'),
);
const missing = 'sha256:f9989be93aaf18e0f2ee8da9e8cbaedc1979c5c1aa89e1c8a0dc18524e5eb7f9';
const hash = (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`;

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
  test(`${arch} 安装使用同版本官方运行摘要，不访问缺失的证明配置`, () =>
    withIncompleteMirror(async (request, visited) => {
      const compose = await readFile(
        new URL(`../deploy/compose.${arch}.yaml`, import.meta.url),
        'utf8',
      );
      const reference = compose.match(/image: postgres:17\.6-alpine@(sha256:[a-f0-9]{64})/)[1];
      assert.equal(reference, fixture[arch].digest);
      const result = await verifyManifestGraph(reference, request);
      assert.equal(result.records[0].config.architecture, arch);
      assert.ok(result.records[0].config.config.Env.includes('PG_VERSION=17.6'));
      assert.ok(!visited.includes(`blobs/${missing}`));
    }));
}
