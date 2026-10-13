import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const currentTag = `v${JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version}`;
const password = randomBytes(18).toString('base64url');
const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2);
if(a[0]==='info') {
  if(a.includes('--format')) console.log(process.env.FAKE_DAEMON_PLATFORM || 'linux/x86_64');
  process.exit(process.env.FAKE_INFO_FAIL ? 1 : 0);
}
if(a[0]==='volume' && process.env.FAKE_RESIDUAL_VOLUME) {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({action:'volume-'+a[1],args:a.slice(2),files:[]})+'\\n');
  if(a[1]==='ls') console.log(process.env.FAKE_RESIDUAL_VOLUME);
  process.exit(0);
}
if(a[0]==='ps' || a[0]==='volume') {
  if(process.env.FAKE_COLLISION) console.log('existing-volume');
  process.exit(0);
}
if(a[0]!=='compose') process.exit(1);
if(a[1]==='version') { console.log(process.env.FAKE_COMPOSE_VERSION || '2.24.4'); process.exit(0); }
let i=1, envFile;
const files=[];
while(['--project-directory','--env-file','-f','--parallel'].includes(a[i])) {
  if(a[i]==='--env-file') envFile=a[i+1];
  if(a[i]==='-f') files.push(a[i+1]);
  i+=2;
}
const action=a[i];
const text=envFile ? fs.readFileSync(envFile,'utf8') : '';
const tag=text.match(/^IMAGE_TAG=(.*)$/m)?.[1];
fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({action,args:a.slice(i+1),files,tag,adminPasswordPassed:!!process.env.ADMIN_PASSWORD})+'\\n');
if(action==='pull' && process.env.FAKE_PULL_FAIL) process.exit(8);
if(action==='up' && process.env.FAKE_UP_FAIL) process.exit(8);
if(action==='exec' && a.includes('pg_dump')) process.stdout.write('database dump');
if(action==='run' && a.includes('encrypt')) {
  if(process.env.FAKE_BACKUP_FAIL) process.exit(9);
  const mount=a[a.indexOf('-v')+1];
  fs.writeFileSync(path.join(mount.slice(0,-8),'encrypted.ccbak'),'encrypted fixture');
}
process.exit(0);
`;

test('源码构建分支无需镜像标签，使用 build 并保留项目配置', () =>
  fixture(async ({ run, envFile, calls }) => {
    const r = await run(
      'install.sh',
      'source-cli\n2\nhttp://localhost:18080\n18081\n13000\ny\nn\n',
    );
    assert.equal(r.code, 0, r.output);
    assert.match(await readFile(envFile, 'utf8'), /^INSTALL_MODE=source$/m);
    const commands = await calls();
    assert.ok(commands.some((c) => c.action === 'up' && c.args.includes('--build')));
    assert.ok(!commands.some((c) => c.action === 'pull'));
  }));

test('读取旧配置的引号和行内注释，不将注释作为项目名或版本', () =>
  fixture(async ({ run, init, envFile }) => {
    const original = await init();
    await writeFile(
      envFile,
      original
        .replace('INSTALL_MODE=images', 'export INSTALL_MODE="images" # mode')
        .replace(`IMAGE_TAG=${currentTag}`, `IMAGE_TAG='${currentTag}' # release`)
        .replace(
          'COMPOSE_PROJECT_NAME=nxopa-regsys',
          'COMPOSE_PROJECT_NAME=nxopa-regsys # project',
        ),
    );
    const r = await run('uninstall.sh', '2\nDELETE nxopa-regsys\nn\n');
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /卸载完成/);
  }));

test('默认备份成功后才执行卸载，保留环境及加密备份', () =>
  fixture(async ({ run, init, dir, envFile, calls }) => {
    const original = await init();
    const r = await run('uninstall.sh', `\ny\n\n${dir}/backups\n`);
    assert.equal(r.code, 0, r.output);
    const commands = await calls();
    const encrypted = commands.findIndex((c) => c.action === 'run' && c.args.includes('encrypt'));
    assert.ok(encrypted >= 0 && commands.findIndex((c) => c.action === 'down') > encrypted);
    assert.ok((await readdir(path.join(dir, 'backups'))).some((name) => name.endsWith('.ccbak')));
    assert.ok((await readFile(envFile, 'utf8')) === original);
  }));

async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nxopa-cli-'));
  const bin = path.join(dir, 'bin');
  const envFile = path.join(dir, '.env');
  const log = path.join(dir, 'commands.jsonl');
  await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), fakeDocker, { mode: 0o755 });
  const calls = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  const run = (entry, input = '', overrides = {}, args = []) =>
    new Promise((resolve, reject) => {
      const child = spawn('bash', [path.join(root, 'install', entry), ...args], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          INSTALL_ENV_FILE: envFile,
          FAKE_LOG: log,
          ...overrides,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('CLI timeout'));
      }, 15000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  const init = async () => {
    assert.equal((await run('install.sh', '', {}, ['init'])).code, 0);
    const text = (await readFile(envFile, 'utf8')).replace(
      'INSTALL_MODE=source',
      'INSTALL_MODE=images',
    );
    await writeFile(envFile, text);
    return text;
  };
  try {
    await fn({ dir, envFile, log, calls, run, init });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('帮助无需 Docker，保留原有维护命令', () =>
  fixture(async ({ run, calls }) => {
    for (const entry of ['install.sh', 'update.sh', 'uninstall.sh']) {
      const r = await run(entry, '', {}, ['--help']);
      assert.equal(r.code, 0);
      assert.match(r.output, /用法/);
    }
    assert.equal((await calls()).length, 0);
  }));

test('首次安装选择镜像版本、端口、隐藏管理员密码，校验重输', () =>
  fixture(async ({ run, envFile, calls }) => {
    const r = await run(
      'install.sh',
      `test-cli\n1\nv0.2.3\nhttp://localhost:18080\n70000\n18081\n13000\ny\ny\ninstaller\ninvalid\nadmin@example.test\nshort\nshort\n${password}\nmismatch\n${password}\n${password}\n`,
    );
    assert.equal(r.code, 0, r.output);
    const text = await readFile(envFile, 'utf8');
    assert.match(text, /^IMAGE_TAG=v0.2.3$/m);
    assert.match(text, /^WEB_PORT=127\.0\.0\.1:18081$/m);
    assert.match(text, /^API_PORT=127\.0\.0\.1:13000$/m);
    assert.match(text, /^REVERSE_PROXY_MODE=external$/m);
    assert.match(text, /^PUBLIC_URL=http:\/\/localhost:18080$/m);
    assert.match(text, /^POSTGRES_PASSWORD=[a-f0-9]{48}$/m);
    assert.match(text, /^ENCRYPTION_KEY=[a-f0-9]{64}$/m);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.ok(!r.output.includes(password));
    assert.ok(!text.includes(password));
    assert.ok((await calls()).some((c) => c.action === 'exec' && c.adminPasswordPassed));
  }));

test('默认安装由用户配置 HTTPS 代理，只绑定本机上游且不包含 Caddy', () =>
  fixture(async ({ run, envFile, calls }) => {
    const r = await run(
      'install.sh',
      'https-cli\n1\n\nhttps://wrong/path\nhttp://reg.example.org\nhttps://reg.example.org\n19081\n13000\ny\nn\n',
    );
    assert.equal(r.code, 0, r.output);
    const text = await readFile(envFile, 'utf8');
    assert.match(text, /^REVERSE_PROXY_MODE=external$/m);
    assert.match(text, /^PUBLIC_URL=https:\/\/reg.example.org$/m);
    assert.match(text, /^WEB_PORT=127\.0\.0\.1:19081$/m);
    assert.match(text, /^API_PORT=127\.0\.0\.1:13000$/m);
    assert.ok(!/^(SITE_ADDRESS|HTTP_PORT|HTTPS_PORT)=/m.test(text));
    assert.ok((await calls()).every((c) => !c.files.some((f) => f.endsWith('compose.caddy.yaml'))));
    assert.match(r.output, /\/api\//);
  }));

test('旧配置继续启用 Caddy，显式切换 external 后不再加载 Caddy', () =>
  fixture(async ({ run, init, envFile, calls }) => {
    const fresh = await init();
    const legacy =
      fresh.replace(/^REVERSE_PROXY_MODE=.*\n/m, '') +
      '\nSITE_ADDRESS=:80\nHTTP_PORT=8080\nHTTPS_PORT=8443\n';
    await writeFile(envFile, legacy);
    assert.equal((await run('install.sh', '', {}, ['config'])).code, 0);
    assert.ok((await calls()).at(-1).files.some((f) => f.endsWith('compose.caddy.yaml')));
    await writeFile(envFile, legacy + '\nREVERSE_PROXY_MODE=external\n');
    assert.equal((await run('install.sh', '', {}, ['config'])).code, 0);
    assert.ok(!(await calls()).at(-1).files.some((f) => f.endsWith('compose.caddy.yaml')));
  }));

test('取消与输入结束不会生成配置或启动服务', () =>
  fixture(async ({ run, envFile, calls }) => {
    const r = await run('install.sh', 'cancel-cli\n1\n\nhttps://reg.example.org\n\n\nn\n');
    assert.equal(r.code, 0);
    await assert.rejects(stat(envFile), { code: 'ENOENT' });
    assert.notEqual((await run('install.sh')).code, 0);
    assert.ok(!(await calls()).some((c) => c.action === 'up'));
  }));

test('没有原配置时拒绝复用已有项目；过旧 Compose 在写入前拒绝', () =>
  fixture(async ({ run, envFile }) => {
    assert.notEqual((await run('install.sh', '\n', { FAKE_COLLISION: '1' })).code, 0);
    assert.notEqual((await run('install.sh', '', { FAKE_COMPOSE_VERSION: '2.24.3' })).code, 0);
    await assert.rejects(stat(envFile), { code: 'ENOENT' });
  }));

test('按 Docker 服务端架构选择 PostgreSQL 运行摘要，备份也沿用同一覆盖文件', () =>
  fixture(async ({ run, init, dir, calls }) => {
    await init();
    for (const [reported, file] of [
      ['linux/x86_64', 'compose.amd64.yaml'],
      ['linux/aarch64', 'compose.arm64.yaml'],
    ]) {
      const r = await run(
        'install.sh',
        '',
        { FAKE_DAEMON_PLATFORM: reported, DOCKER_DEFAULT_PLATFORM: '' },
        ['backup', `${dir}/backups`],
      );
      assert.equal(r.code, 0, r.output);
      assert.ok((await calls()).at(-1).files.some((f) => f.endsWith(file)));
    }
    assert.notEqual(
      (
        await run(
          'install.sh',
          '',
          { FAKE_DAEMON_PLATFORM: 'linux/arm', DOCKER_DEFAULT_PLATFORM: '' },
          ['config'],
        )
      ).code,
      0,
    );
  }));

test('重复安装保留密钥，选定环境文件不执行代码且不受 shell 覆盖', () =>
  fixture(async ({ run, init, envFile, dir }) => {
    const text = await init();
    const marker = path.join(dir, 'unexpected');
    const augmented = `${text}\nUNTRUSTED=$(touch '${marker}')\n`;
    await writeFile(envFile, augmented);
    const r = await run('install.sh', 'y\nn\n', {
      IMAGE_TAG: 'evil',
      INSTALL_MODE: 'bogus',
      COMPOSE_PROJECT_NAME: 'other-project',
    });
    assert.equal(r.code, 0, r.output);
    assert.ok((await readFile(envFile, 'utf8')) === augmented);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  }));

test('更新先使用旧版备份，然后启动所选新版，保留密钥', () =>
  fixture(async ({ run, init, envFile, dir, calls }) => {
    const text = await init();
    const r = await run('update.sh', `v0.2.3\n${dir}/backups\ny\n`);
    assert.equal(r.code, 0, r.output);
    const updated = await readFile(envFile, 'utf8');
    assert.ok(updated === text.replace(`IMAGE_TAG=${currentTag}`, 'IMAGE_TAG=v0.2.3'));
    const commands = await calls();
    const backupIndex = commands.findIndex((c) => c.action === 'run' && c.args.includes('encrypt'));
    const pullIndex = commands.findIndex((c) => c.action === 'pull');
    assert.ok(backupIndex >= 0 && pullIndex > backupIndex);
    assert.equal(commands[backupIndex].tag, currentTag);
    assert.equal(commands[pullIndex].tag, 'v0.2.3');
  }));

for (const failure of ['FAKE_BACKUP_FAIL', 'FAKE_PULL_FAIL', 'FAKE_UP_FAIL']) {
  test(`${failure} 中止更新并保留原配置`, () =>
    fixture(async ({ run, init, envFile, dir, calls }) => {
      const original = await init();
      const r = await run('update.sh', `v0.2.3\n${dir}/backups\ny\n`, { [failure]: '1' });
      assert.notEqual(r.code, 0);
      assert.ok((await readFile(envFile, 'utf8')) === original);
      assert.ok(!(await readdir(dir)).some((name) => name.includes('before-update')));
      if (failure === 'FAKE_BACKUP_FAIL')
        assert.ok(!(await calls()).some((c) => ['pull', 'up'].includes(c.action)));
    }));
}

test('未明确确认永久删除时，卸载不做任何删除', () =>
  fixture(async ({ run, init, calls }) => {
    await init();
    const r = await run('uninstall.sh', '2\ny\n');
    assert.equal(r.code, 0);
    assert.ok(!(await calls()).some((c) => c.action === 'down'));
    assert.notEqual((await run('uninstall.sh', '2\n')).code, 0);
  }));

test('默认卸载保留卷；明确选择永久删除仅作用于当前项目，配置保留', () =>
  fixture(async ({ run, init, envFile, calls }) => {
    const original = await init();
    let r = await run('uninstall.sh', '\ny\nn\n');
    assert.equal(r.code, 0, r.output);
    let downs = (await calls()).filter((c) => c.action === 'down');
    assert.ok(!downs[0].args.includes('--volumes'));
    r = await run('uninstall.sh', '2\nDELETE nxopa-regsys\nn\n');
    assert.equal(r.code, 0, r.output);
    downs = (await calls()).filter((c) => c.action === 'down');
    assert.ok(downs[1].args.includes('--volumes'));
    assert.ok((await readFile(envFile, 'utf8')) === original);
  }));

test('卸载前备份失败，中止删除', () =>
  fixture(async ({ run, init, dir, calls }) => {
    await init();
    const r = await run('uninstall.sh', `2\nDELETE nxopa-regsys\ny\n${dir}/backups\n`, {
      FAKE_BACKUP_FAIL: '1',
    });
    assert.notEqual(r.code, 0);
    assert.ok(!(await calls()).some((c) => c.action === 'down'));
  }));

test('切换自配代理后，永久卸载也清理当前项目残留的旧证书卷', () =>
  fixture(async ({ run, init, calls }) => {
    await init();
    const r = await run('uninstall.sh', '2\nDELETE nxopa-regsys\nn\n', {
      FAKE_RESIDUAL_VOLUME: 'nxopa-regsys_caddy_data',
    });
    assert.equal(r.code, 0, r.output);
    const commands = await calls();
    assert.ok(
      commands.some(
        (c) =>
          c.action === 'volume-ls' &&
          c.args.includes('label=com.docker.compose.project=nxopa-regsys'),
      ),
    );
    assert.ok(
      commands.some((c) => c.action === 'volume-rm' && c.args.includes('nxopa-regsys_caddy_data')),
    );
  }));
