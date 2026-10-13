import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Check every descriptor, including attestations: runtimes may copy them even when
// an index's runnable platform manifests are healthy.
export async function verifyManifestGraph(reference, request) {
  const manifests = new Set();
  const blobs = new Set();
  const records = [];
  const json = async (kind, ref) => {
    const response = await request(kind, ref, 'GET');
    assert.equal(
      response.status,
      200,
      `could not fetch content descriptor ${ref} (${kind}): HTTP ${response.status}`,
    );
    const body = Buffer.from(await response.arrayBuffer());
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if (ref.startsWith('sha256:')) assert.equal(digest, ref, `${kind}/${ref} checksum`);
    const advertised = response.headers.get('docker-content-digest');
    if (advertised) assert.equal(digest, advertised);
    return { digest, data: JSON.parse(body.toString('utf8')) };
  };
  const walk = async (ref, platform) => {
    if (manifests.has(ref)) return;
    manifests.add(ref);
    const manifest = await json('manifests', ref);
    if (manifest.data.manifests) {
      for (const child of manifest.data.manifests) await walk(child.digest, child.platform);
      return manifest;
    }
    const config = await json('blobs', manifest.data.config.digest);
    for (const layer of manifest.data.layers) {
      if (blobs.has(layer.digest)) continue;
      const response = await request('blobs', layer.digest, 'HEAD');
      assert.equal(
        response.status,
        200,
        `could not fetch content descriptor ${layer.digest} (layer): HTTP ${response.status}`,
      );
      const size = response.headers.get('content-length');
      if (size !== null) assert.equal(Number(size), layer.size, `${layer.digest} size`);
      blobs.add(layer.digest);
    }
    records.push({ platform, manifest: manifest.digest, config: config.data });
    return manifest;
  };
  const root = await walk(reference);
  return { ...root, records, availableLayers: blobs.size };
}
