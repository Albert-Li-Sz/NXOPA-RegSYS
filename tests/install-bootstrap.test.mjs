import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const parts = version.split('.').map(Number);
const nextTag = `v${parts[0]}.${parts[1]}.${parts[2] + 1}`;
async function fixture(fn, { legacyImages = false } = {}) {
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
  if (legacyImages) {
    // Reproduce a previously published bundle whose own entry/libraries still load digests.
    const entry = path.join(packRoot, 'install.sh');
    await writeFile(
      entry,
      (await readFile(entry, 'utf8'))
        .replace('  use_versioned_images "$output/nxopa-regsys-$tag"\n', '')
        .replace('  use_versioned_images "$target_root"\n', ''),
    );
    const lib = path.join(packRoot, 'deploy/lib.sh');
    await writeFile(
      lib,
      (await readFile(lib, 'utf8')).replace(
        'compose_args+=(-f "$install_dir/compose.images.yaml")',
        'compose_args+=(-f "$install_dir/compose.images.yaml"); if [[ -f "$install_dir/compose.digest.yaml" ]]; then compose_args+=(-f "$install_dir/compose.digest.yaml"); fi',
      ),
    );
    await writeFile(
      path.join(packRoot, 'deploy/compose.digest.yaml'),
      `# NXOPA_IMAGE_TAG=${tag}\nservices:\n  api:\n    image: ghcr.io/example/api@sha256:${'1'.repeat(64)}\n`,
    );
    for (const arch of ['amd64', 'arm64']) {
      for (const file of [`compose.${arch}.yaml`, `compose.proxy.${arch}.yaml`]) {
        const target = path.join(packRoot, 'deploy', file);
        await writeFile(
          target,
          (await readFile(target, 'utf8')).replace(
            /(image: [^\n]+)/,
            `$1@sha256:${'1'.repeat(64)}`,
          ),
        );
      }
    }
  }
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
  const visited = [];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    visited.push(req.url);
    req.url = req.url?.replace(
      /^\/accelerate\/https:\/\/github.com\/Albert-Li-Sz\/NXOPA-RegSYS\/releases\/download/,
      '',
    );
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
    else if (req.url?.endsWith('/' + `nxopa-regsys-${requestedTag}-install.tar.gz`)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(release.bytes);
    } else {
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
            NXOPA_ALLOW_INSECURE_MIRROR: '1',
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
      proxyPrefix: `http://127.0.0.1:${address.port}/accelerate/`,
      visited,
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
    const response = await run(
      [],
      '1\nbootstrap-check\n\n1\n\n3\n\nhttp://proxy.example.test\ny\nn\n',
    );
    assert.equal(response.code, 0, response.output);
    const envFile = path.join(target, 'deploy/.env'),
      before = await readFile(envFile, 'utf8');
    assert.match(before, /^ALLOW_PRIVATE_INTEGRATIONS=false$/m);
    assert.match(before, /^GATEWAY_PORT=8080$/m);
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
test('单文件安装及再次启动修复 Caddy 挂载权限，实例密钥保持私有', () =>
  fixture(async ({ run, target }) => {
    const response = await run(
      ['install'],
      'gateway-permissions\n\n1\n\n3\n\nhttp://proxy.example.test\ny\nn\n',
    );
    assert.equal(response.code, 0, response.output);
    const directory = path.join(target, 'infra/caddy-gateway');
    const config = path.join(directory, 'Caddyfile');
    const envFile = path.join(target, 'deploy/.env');
    const original = await readFile(envFile);
    const check = async () => {
      assert.equal((await stat(directory)).mode & 0o777, 0o755);
      assert.equal((await stat(config)).mode & 0o777, 0o644);
      assert.equal((await stat(envFile)).mode & 0o777, 0o600);
      assert.deepEqual(await readFile(envFile), original);
    };
    await check();
    // Existing installations may retain root-only modes from an older bootstrap.
    for (const mode of ['gateway', 'caddy']) {
      const mounted = path.join(target, 'infra', mode === 'gateway' ? 'caddy-gateway' : 'caddy');
      await chmod(mounted, 0o700);
      await chmod(path.join(mounted, 'Caddyfile'), 0o600);
      const restart = await run(['up'], '', {
        installed: true,
        env: { REVERSE_PROXY_MODE: mode },
      });
      assert.equal(restart.code, 0, restart.output);
      assert.equal((await stat(mounted)).mode & 0o777, 0o755);
      assert.equal((await stat(path.join(mounted, 'Caddyfile'))).mode & 0o777, 0o644);
      await check();
    }
  }));
test('新单文件入口转换旧发布包与已有材料的摘要覆盖，保留版本、平台及实例配置', () =>
  fixture(
    async ({ run, target, log }) => {
      const result = await run(
        ['install'],
        'legacy-images\n\n1\n\n3\n\nhttp://proxy.example.test\ny\nn\n',
      );
      assert.equal(result.code, 0, result.output);
      const envFile = path.join(target, 'deploy/.env');
      const previous = await readFile(envFile, 'utf8');
      const check = async () => {
        await assert.rejects(stat(path.join(target, 'deploy/compose.digest.yaml')), {
          code: 'ENOENT',
        });
        for (const arch of ['amd64', 'arm64']) {
          for (const [name, image] of [
            [`compose.${arch}.yaml`, 'postgres:17.6-alpine'],
            [`compose.proxy.${arch}.yaml`, 'caddy:2.10.2-alpine'],
          ]) {
            const text = await readFile(path.join(target, 'deploy', name), 'utf8');
            assert.ok(text.includes(`image: ${image}\n`));
            assert.ok(text.includes(`platform: linux/${arch}`));
            assert.doesNotMatch(text, /@sha256/);
          }
        }
        assert.equal(await readFile(envFile, 'utf8'), previous);
      };
      await check();
      // Reintroduce legacy installed material without downloading a new bundle.
      await writeFile(
        path.join(target, 'deploy/compose.digest.yaml'),
        `# NXOPA_IMAGE_TAG=${tag}\nservices: {}\n`,
      );
      const postgres = path.join(target, 'deploy/compose.amd64.yaml');
      await writeFile(
        postgres,
        (await readFile(postgres, 'utf8')).replace(
          'postgres:17.6-alpine',
          `postgres:17.6-alpine@sha256:${'2'.repeat(64)}`,
        ),
      );
      const config = await run(['config']);
      assert.equal(config.code, 0, config.output);
      await check();
      const backup = await run(['backup', path.join(target, 'backups')], '', { installed: true });
      assert.equal(backup.code, 0, backup.output);
      assert.doesNotMatch(await readFile(log, 'utf8'), /compose\.digest\.yaml/);
    },
    { legacyImages: true },
  ));
test('自定义 GitHub 加速前缀用于安装包和校验文件并保存在配置中', () =>
  fixture(async ({ run, target, proxyPrefix, visited }) => {
    const result = await run(
      ['--github-prefix', proxyPrefix, 'install'],
      'proxy-check\n\n1\n\n3\n\nhttp://proxy.example.test\ny\nn\n',
      {
        env: {
          NXOPA_ALLOW_INSECURE_MIRROR: '1',
          NXOPA_RELEASE_BASE_URL: 'https://github.com/Albert-Li-Sz/NXOPA-RegSYS/releases/download',
        },
      },
    );
    assert.equal(result.code, 0, result.output);
    assert.ok(
      visited.some(
        (url) => url.includes('/accelerate/https://github.com/') && url.endsWith('-install.tar.gz'),
      ),
    );
    assert.ok(
      visited.some(
        (url) => url.includes('/accelerate/https://github.com/') && url.endsWith('/SHA256SUMS'),
      ),
    );
    assert.ok(
      (await readFile(path.join(target, 'deploy/.env'), 'utf8')).includes(
        `NXOPA_GITHUB_PREFIX=${proxyPrefix}`,
      ),
    );
  }));
test('旧 install/.env 自动迁移，先备份并保留原项目名和密钥', () =>
  fixture(async ({ run, target }) => {
    assert.equal(
      (await run(['install'], 'legacy-check\n\n1\n\n3\n\nhttp://proxy.example.test\ny\nn\n')).code,
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
      (await run(['install'], 'update-check\n\n1\n\n3\n\nhttp://proxy.example.test\ny\nn\n')).code,
      0,
    );
    const previous = await readFile(path.join(target, 'deploy/.env'), 'utf8');
    await addRelease(nextTag);
    const response = await run(['update'], `\n${target}/backups\ny\n`, {
      installed: true,
      env: { NXOPA_UPDATE_TAG: nextTag },
    });
    assert.equal(response.code, 0, response.output);
    assert.ok(
      (await readFile(path.join(target, 'install.sh'), 'utf8')).includes(
        `NXOPA_INSTALLER_VERSION=${nextTag}`,
      ),
    );
    assert.equal(
      await readFile(path.join(target, 'deploy/.env'), 'utf8'),
      previous.replace(`IMAGE_TAG=${tag}`, `IMAGE_TAG=${nextTag}`),
    );
    assert.equal((await stat(path.join(target, 'infra/caddy-gateway'))).mode & 0o777, 0o755);
    assert.equal(
      (await stat(path.join(target, 'infra/caddy-gateway/Caddyfile'))).mode & 0o777,
      0o644,
    );
    assert.equal((await stat(path.join(target, 'deploy/.env'))).mode & 0o777, 0o600);
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const encrypted = calls.findIndex((call) => call.includes('encrypt'));
    assert.ok(encrypted >= 0 && calls.slice(encrypted + 1).some((call) => call.includes('pull')));
  }));
