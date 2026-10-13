import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tag = 'v0.2.0';
async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nxopa-bootstrap-'));
  const packRoot = path.join(dir, `nxopa-regsys-${tag}`),
    standalone = path.join(dir, 'standalone'),
    bin = path.join(dir, 'bin');
  await mkdir(packRoot);
  await mkdir(standalone);
  await mkdir(bin);
  for (const name of [
    'install.sh',
    'deploy',
    'infra/caddy',
    'infra/caddy-gateway',
    'scripts/backup.sh',
    'scripts/restore.sh',
    'scripts/compose-lib.sh',
  ]) {
    await mkdir(path.dirname(path.join(packRoot, name)), { recursive: true });
    await cp(path.join(root, name), path.join(packRoot, name), {
      recursive: true,
      filter: (src) => !src.endsWith('/.env') && !src.includes('/backups/'),
    });
  }
  const example = path.join(packRoot, 'deploy/.env.example');
  await writeFile(
    example,
    (await readFile(example, 'utf8')).replace('INSTALL_MODE=source', 'INSTALL_MODE=images'),
  );
  await cp(path.join(root, 'install.sh'), path.join(standalone, 'install.sh'));
  const archiveName = `nxopa-regsys-${tag}-install.tar.gz`,
    archive = path.join(dir, archiveName);
  execFileSync('tar', ['-czf', archive, '-C', dir, `nxopa-regsys-${tag}`], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = await readFile(archive),
    checksum = createHash('sha256').update(bytes).digest('hex');
  const releases = new Map([[tag, { bytes, checksum }]]);
  async function addRelease(nextTag) {
    const folder = path.join(dir, `nxopa-regsys-${nextTag}`);
    await cp(packRoot, folder, { recursive: true });
    for (const name of ['install.sh', 'deploy/.env.example']) {
      const file = path.join(folder, name);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll(tag, nextTag));
    }
    const nextArchive = path.join(dir, `nxopa-regsys-${nextTag}-install.tar.gz`);
    execFileSync('tar', ['-czf', nextArchive, '-C', dir, `nxopa-regsys-${nextTag}`], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const nextBytes = await readFile(nextArchive);
    releases.set(nextTag, {
      bytes: nextBytes,
      checksum: createHash('sha256').update(nextBytes).digest('hex'),
    });
  }
  let wrongHash = false;
  const server = createServer((req, res) => {
    const requestedTag = req.url?.split('/')[1],
      release = releases.get(requestedTag);
    if (!release) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url?.endsWith('/SHA256SUMS'))
      res.end(
        `${wrongHash ? '0'.repeat(64) : release.checksum}  nxopa-regsys-${requestedTag}-install.tar.gz\n`,
      );
    else if (req.url?.endsWith('/' + `nxopa-regsys-${requestedTag}-install.tar.gz`))
      res.end(release.bytes);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const docker = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'), a=process.argv.slice(2);
if(a[0]==='info'){if(a.includes('--format')) console.log('linux/x86_64');process.exit(0)}
if(a[0]==='ps'||a[0]==='volume')process.exit(0);
if(a[0]==='compose'&&a[1]==='version'){console.log('2.24.4');process.exit(0)}
if(a[0]==='compose'){
fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify(a)+'\\n');
if(a.includes('pg_dump'))process.stdout.write('fixture dump');
if(a.includes('encrypt')){const mount=a[a.indexOf('-v')+1];fs.writeFileSync(path.join(mount.slice(0,-8),'encrypted.ccbak'),'encrypted fixture')}
process.exit(0)}
process.exit(1);
`;
  await writeFile(path.join(bin, 'docker'), docker, { mode: 0o755 });
  const log = path.join(dir, 'docker.log'),
    target = path.join(dir, 'deployment');
  const run = (args, input = '', options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        'bash',
        [
          path.join(options.installed ? target : standalone, 'install.sh'),
          '--dir',
          target,
          ...args,
        ],
        {
          cwd: standalone,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            NXOPA_VERSION: tag,
            NXOPA_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
            FAKE_LOG: log,
            ...options.env,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Bootstrap timed out'));
      }, 30000);
      child.stdout.on('data', (b) => (output += b));
      child.stderr.on('data', (b) => (output += b));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
      child.on('error', reject);
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  try {
    await fn({
      run,
      target,
      log,
      addRelease,
      badChecksum: () => {
        wrongHash = true;
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
test('单文件启动下载并校验发布包，菜单安装后保留配置、仅加载内部 Caddy', () =>
  fixture(async ({ run, target, log }) => {
    const response = await run([], '1\nbootstrap-check\n1\n\n\nhttp://proxy.example.test\ny\nn\n');
    assert.equal(response.code, 0, response.output);
    const envFile = path.join(target, 'deploy/.env'),
      before = await readFile(envFile, 'utf8');
    assert.match(before, /^ALLOW_PRIVATE_INTEGRATIONS=true$/m);
    assert.match(before, /^GATEWAY_PORT=127\.0\.0\.1:8080$/m);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.equal((await run(['install'], 'y\nn\n')).code, 0);
    assert.equal(await readFile(envFile, 'utf8'), before);
    assert.match(await readFile(log, 'utf8'), /compose.gateway.yaml/);
    assert.equal((await run(['--help'])).code, 0);
  }));
test('校验和错误不会安装配置或调用 Docker', () =>
  fixture(async ({ run, target, log, badChecksum }) => {
    badChecksum();
    const response = await run(['install']);
    assert.notEqual(response.code, 0);
    assert.match(response.output, /SHA-256/);
    await assert.rejects(stat(path.join(target, 'deploy/.env')), { code: 'ENOENT' });
    await assert.rejects(stat(log), { code: 'ENOENT' });
  }));
test('旧 install/.env 自动迁移，先备份并保留原项目名和密钥', () =>
  fixture(async ({ run, target }) => {
    assert.equal(
      (await run(['install'], 'legacy-check\n1\n\n\nhttp://proxy.example.test\ny\nn\n')).code,
      0,
    );
    const previous = await readFile(path.join(target, 'deploy/.env'), 'utf8');
    await mkdir(path.join(target, 'install'));
    await writeFile(path.join(target, 'install/.env'), previous);
    await writeFile(
      path.join(target, 'install/install.sh'),
      '#!/usr/bin/env bash\nmkdir -p "$2"\nprintf backup > "$2/legacy-backup.ccbak"\n',
    );
    await rm(path.join(target, 'deploy'), { recursive: true });
    await rm(path.join(target, 'install.sh'));
    const response = await run(['install'], 'y\nn\n');
    assert.equal(response.code, 0, response.output);
    assert.equal(await readFile(path.join(target, 'deploy/.env'), 'utf8'), previous);
    assert.equal((await stat(path.join(target, 'deploy/.env'))).mode & 0o777, 0o600);
    assert.equal(
      await readFile(path.join(target, 'backups/legacy-backup.ccbak'), 'utf8'),
      'backup',
    );
  }));
test('跨版本更新先备份，下载新版材料并执行新入口，保留原实例密钥', () =>
  fixture(async ({ run, target, log, addRelease }) => {
    assert.equal(
      (await run(['install'], 'update-check\n1\n\n\nhttp://proxy.example.test\ny\nn\n')).code,
      0,
    );
    const previous = await readFile(path.join(target, 'deploy/.env'), 'utf8');
    await addRelease('v0.2.1');
    const response = await run(['update'], `\n${target}/backups\ny\n`, {
      installed: true,
      env: { NXOPA_UPDATE_TAG: 'v0.2.1' },
    });
    assert.equal(response.code, 0, response.output);
    assert.match(
      await readFile(path.join(target, 'install.sh'), 'utf8'),
      /NXOPA_INSTALLER_VERSION=v0\.2\.1/,
    );
    assert.equal(
      await readFile(path.join(target, 'deploy/.env'), 'utf8'),
      previous.replace(`IMAGE_TAG=${tag}`, 'IMAGE_TAG=v0.2.1'),
    );
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const encrypted = calls.findIndex((call) => call.includes('encrypt'));
    assert.ok(encrypted >= 0 && calls.slice(encrypted + 1).some((call) => call.includes('pull')));
  }));
