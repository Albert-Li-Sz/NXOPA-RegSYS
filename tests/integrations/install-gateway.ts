import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return address.port;
}

export async function verifyGatewayTransport() {
  const stage = await mkdtemp(path.join(root, '.runtime/gateway-transport-'));
  const project = `nxopa-gateway-transport-${process.pid}`;
  const gatewayPort = await unusedPort(),
    tlsPort = await unusedPort();
  const platform = (
    await exec('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}'])
  ).stdout.trim();
  assert.match(platform, /^linux\/(x86_64|amd64|aarch64|arm64)$/);
  const arch = /arm64|aarch64/.test(platform) ? 'arm64' : 'amd64';
  const env = {
    ...process.env,
    GATEWAY_PORT: String(gatewayPort),
    GATEWAY_BIND_ADDRESS: '127.0.0.1',
    GATEWAY_TEST_STAGE: stage,
    GATEWAY_TEST_ECHO: path.join(root, 'tests/fixtures/gateway-echo.mjs'),
    GATEWAY_TEST_TLS_PORT: String(tlsPort),
  };
  // Only test fixture settings enter Compose; the developer's root .env is never loaded.
  const envFile = path.join(stage, '.env');
  await writeFile(envFile, '', { mode: 0o600 });
  const args = [
    'compose',
    '--project-directory',
    path.join(root, 'deploy'),
    '--env-file',
    envFile,
    '-p',
    project,
    '-f',
    path.join(root, 'tests/fixtures/gateway-transport.yaml'),
    '-f',
    path.join(root, 'deploy/compose.gateway.yaml'),
    '-f',
    path.join(root, `deploy/compose.proxy.${arch}.yaml`),
  ];
  if (process.env.GATEWAY_TEST_CONFIG) {
    const override = path.join(stage, 'caddy-override.json');
    await writeFile(
      override,
      JSON.stringify({
        services: {
          caddy: {
            volumes: [`${path.resolve(process.env.GATEWAY_TEST_CONFIG)}:/etc/caddy/Caddyfile:ro`],
          },
        },
      }),
    );
    args.push('-f', override);
  }
  const compose = (action: string[]) =>
    exec('docker', [...args, ...action], { env, timeout: 240000, maxBuffer: 1024 * 1024 });
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
      path.join(stage, 'key.pem'),
      '-out',
      path.join(stage, 'cert.pem'),
    ]);
    await chmod(path.join(stage, 'key.pem'), 0o600);
    const nginx = (await readFile(path.join(root, 'deploy/nginx.conf.example'), 'utf8'))
      .replaceAll('/etc/nginx/certs/reg.example.org/fullchain.pem', '/fixture/cert.pem')
      .replaceAll('/etc/nginx/certs/reg.example.org/privkey.pem', '/fixture/key.pem')
      .replaceAll('http://127.0.0.1:8080', 'http://caddy:80');
    await writeFile(path.join(stage, 'nginx.conf'), nginx);
    await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
    await compose(['exec', '-T', 'outer-proxy', 'nginx', '-t']);
    const ca = await readFile(path.join(stage, 'cert.pem'));
    const host = 'reg.example.org';
    const origin = `https://${host}`;
    const body = JSON.stringify({ name: '报名验收', amount: 42 });
    async function throughTls(
      uri: string,
      method: string,
      content: string | Buffer = body,
      contentType = 'application/json',
    ) {
      return new Promise<{ payload: any; cookies: string[] }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: tlsPort,
            servername: 'localhost',
            ca,
            path: uri,
            method,
            headers: {
              Host: host,
              Origin: origin,
              Cookie: 'session=transport-fixture',
              'Content-Type': contentType,
              ...(method === 'POST'
                ? { 'Content-Length': String(Buffer.byteLength(content)) }
                : {}),
              'X-Forwarded-Proto': 'http',
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              try {
                assert.equal(response.statusCode, 200);
                resolve({
                  payload: JSON.parse(Buffer.concat(chunks).toString()),
                  cookies: response.headers['set-cookie'] ?? [],
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.setTimeout(10000, () => req.destroy(new Error('TLS proxy request timed out')));
        req.on('error', reject);
        req.end(method === 'POST' ? content : undefined);
      });
    }
    const upload = Buffer.concat([
      Buffer.from(
        '--gateway-boundary\r\nContent-Disposition: form-data; name="file"; filename="maximum.txt"\r\nContent-Type: text/plain\r\n\r\n',
      ),
      Buffer.alloc(50 * 1024 * 1024, 65),
      Buffer.from('\r\n--gateway-boundary--\r\n'),
    ]);
    const { payload: uploaded } = await throughTls(
      '/api/v1/upload-size',
      'POST',
      upload,
      'multipart/form-data; boundary=gateway-boundary',
    );
    assert.equal(uploaded.bodyBytes, upload.length);
    assert.equal(uploaded.bodySha256, createHash('sha256').update(upload).digest('hex'));
    for (const [uri, method, service] of [
      ['/api/v1/echo?name=%E6%8A%A5%E5%90%8D&path=%2Fapi%2F', 'POST', 'api'],
      ['/contests?next=%2Flogin', 'GET', 'web'],
    ]) {
      const { payload, cookies } = await throughTls(uri, method);
      assert.equal(payload.service, service);
      assert.equal(payload.url, uri);
      assert.equal(payload.method, method);
      assert.equal(payload.body, method === 'POST' ? body : '');
      assert.equal(payload.headers.host, host);
      assert.equal(payload.headers.origin, origin);
      assert.equal(payload.headers.cookie, 'session=transport-fixture');
      assert.equal(
        payload.headers['x-forwarded-proto'],
        'https',
        'Caddy must preserve the outer TLS protocol',
      );
      assert.equal(payload.headers['x-forwarded-host'], host);
      assert.ok(cookies.some((cookie) => cookie.includes('Secure; HttpOnly; SameSite=Lax')));
    }
    assert.equal(
      (await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/echo`).then((r) => r.json())).service,
      'api',
    );
    return '真实 HTTPS Nginx → HTTP Caddy 两层代理保留 API 路径、查询、正文、Host / Origin、Cookie 及 HTTPS 协议；50 MB 附件及表单边界完整传输，本机 HTTP 入口可用';
  } finally {
    await compose(['down', '--volumes', '--remove-orphans']);
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await verifyGatewayTransport());
}
