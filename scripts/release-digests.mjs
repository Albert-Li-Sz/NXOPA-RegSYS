import assert from 'node:assert/strict';

export function digestOverride({ records, tag, commit, prefix }) {
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
  return (
    [
      '# NXOPA_IMAGE_TAG=' + tag,
      'services:',
      ...['initialize', ...services].flatMap((service) => {
        const image = service === 'initialize' ? 'api' : service;
        const record = records.find((record) => record.image === `${prefix}-${image}`);
        return [
          `  ${service}:`,
          `    image: \${IMAGE_PREFIX:-${prefix}}-${image}@${record.digest}`,
        ];
      }),
    ].join('\n') + '\n'
  );
}
