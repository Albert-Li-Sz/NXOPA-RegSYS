import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
test('release transport rejects HTTPS-to-HTTP redirects unless explicitly enabled', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxopa-transport-'));
  let hits = 0;
  const plain = httpServer((_req, res) => {
    hits++;
    res.end('fixture-release');
  });
  let secure;
  try {
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      path.join(directory, 'key.pem'),
      '-out',
      path.join(directory, 'cert.pem'),
    ]);
    await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
    secure = httpsServer(
      {
        key: await readFile(path.join(directory, 'key.pem')),
        cert: await readFile(path.join(directory, 'cert.pem')),
      },
      (_req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${plain.address().port}/release` });
        res.end();
      },
    );
    await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
    const source = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
    const fn = source.match(/release_curl\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(fn);
    const script = fn + '\nrelease_curl --cacert "$2" -fsSL "$1"';
    const url = `https://127.0.0.1:${secure.address().port}/release`;
    const env = {
      ...process.env,
      CURL_CA_BUNDLE: path.join(directory, 'cert.pem'),
      NXOPA_ALLOW_INSECURE_MIRROR: '',
    };
    await assert.rejects(
      exec('bash', ['-c', script, 'fixture', url, path.join(directory, 'cert.pem')], { env }),
    );
    assert.equal(hits, 0, 'Secure mode must not send the HTTP request');
    assert.equal(
      (
        await exec('bash', ['-c', script, 'fixture', url, path.join(directory, 'cert.pem')], {
          env: { ...env, NXOPA_ALLOW_INSECURE_MIRROR: '1' },
        })
      ).stdout,
      'fixture-release',
    );
    assert.equal(hits, 1);
  } finally {
    if (secure) await new Promise((resolve) => secure.close(resolve));
    await new Promise((resolve) => plain.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
