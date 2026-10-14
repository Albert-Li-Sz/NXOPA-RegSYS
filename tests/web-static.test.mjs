import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('production page server serves PDF module workers, compilable WASM and real missing-asset errors', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'nxopa-web-assets-'));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  let child;
  try {
    await cp(new URL('../infra/web/server.mjs', import.meta.url), join(stage, 'server.mjs'));
    await mkdir(join(stage, 'public/pdfjs/wasm'), { recursive: true });
    await mkdir(join(stage, 'public/assets'), { recursive: true });
    await writeFile(join(stage, 'public/index.html'), '<html><body>application</body></html>');
    await writeFile(join(stage, 'public/assets/pdf.worker.mjs'), 'export const worker = true;');
    await writeFile(
      join(stage, 'public/pdfjs/wasm/test.wasm'),
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    child = spawn(process.execPath, [join(stage, 'server.mjs')], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (true) {
      const ready = await fetch(base + '/healthz')
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) break;
      assert.ok(Date.now() < deadline, 'page server starts');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const worker = await fetch(base + '/assets/pdf.worker.mjs');
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('Content-Type'), /^text\/javascript/);
    const wasm = await fetch(base + '/pdfjs/wasm/test.wasm');
    assert.equal(wasm.headers.get('Content-Type'), 'application/wasm');
    assert.ok(
      (await WebAssembly.compileStreaming(Promise.resolve(wasm))) instanceof WebAssembly.Module,
    );
    const missing = await fetch(base + '/pdfjs/cmaps/missing.bcmap');
    assert.equal(missing.status, 404);
    assert.ok(!(await missing.text()).includes('<html>'));
    assert.equal((await fetch(base + '/me/files')).status, 200);
  } finally {
    if (child) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(stage, { recursive: true, force: true });
  }
});
