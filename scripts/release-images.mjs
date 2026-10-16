import assert from 'node:assert/strict';

// Digests remain release-verification metadata; installation uses fixed version tags.
export function validateReleaseImages({ records, tag, commit, prefix }) {
  const services = ['api', 'worker', 'web', 'latex', 'minio'];
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.equal(records.length, services.length);
  assert.deepEqual(
    records.map((record) => record.image).sort(),
    services.map((service) => `${prefix}-${service}`).sort(),
  );
  for (const record of records) {
    assert.equal(record.tag, tag);
    assert.equal(record.commit, commit);
    assert.match(record.digest, /^sha256:[a-f0-9]{64}$/);
  }
}
