import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const env = {
  ...process.env,
  DOCS_PORT: String(port),
  DOCS_TEST_URL: `http://localhost:${port}/NXOPA-RegSYS/`,
};
const server = spawn(process.execPath, ['scripts/serve-docs-site.mjs'], { env, stdio: 'ignore' });
try {
  let ready = false;
  for (let n = 0; n < 50; n++) {
    if (
      await fetch(env.DOCS_TEST_URL)
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Documentation server did not start');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/docs-site.browser.mjs'], {
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Documentation checks failed (${code})`)),
    );
  });
} finally {
  server.kill('SIGTERM');
}
