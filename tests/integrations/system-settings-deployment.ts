import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { Client, until, base } from './client.js';
assert.equal(base, 'http://localhost:8080', 'Use only the isolated local Docker deployment');
const exec = promisify(execFile),
  checks: string[] = [];
let original: any,
  admin: Client | undefined,
  hadDatabaseSettings = false;
const dbCode = async (code: string) =>
  exec('docker', [
    'compose',
    'exec',
    '-T',
    'api',
    'node',
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    `import {db} from './src/db.ts'; try {${code}} finally {await db.$disconnect();}`,
  ]);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined });
let passed = false;
try {
  const credentials = JSON.parse(await readFile('.runtime/deployment-credentials.json', 'utf8'));
  assert.equal(credentials.email, 'deployment-fixture@example.test');
  admin = await new Client().login(credentials.email, credentials.password);
  original = await admin.api('/admin/mail');
  assert.equal(
    original.host,
    'host.docker.internal',
    'Do not send acceptance email through a real external server',
  );
  assert.equal(original.port, 51025);
  hadDatabaseSettings = original.source === 'DATABASE';
  assert.equal('password' in original, false);
  assert.equal((await new Client().raw('/api/v1/admin/mail')).status, 401);
  checks.push('Production health, initialized administrator and protected, masked mail settings');
  let saved = await admin.api('/admin/mail', 'PUT', { ...original, fromName: '容器邮件配置验收' });
  assert.equal(saved.source, 'DATABASE');
  assert.equal((await admin.api('/admin/mail/probe', 'POST', { version: saved.version })).ok, true);
  const task = await admin.api('/admin/mail/test', 'POST', { version: saved.version });
  const job = await until(
    () => admin!.api(`/admin/mail/tests/${task.jobId}`),
    (j) => j.state === 'SUCCESS' || j.state === 'FAILED',
  );
  assert.equal(job.state, 'SUCCESS', job.error);
  const delivered = await until(
    async () => {
      const result = (await (
        await fetch(
          `http://localhost:58025/api/v1/search?query=${encodeURIComponent(`to:${credentials.email}`)}`,
        )
      ).json()) as any;
      for (const entry of result.messages ?? []) {
        const message = (await (
          await fetch(`http://localhost:58025/api/v1/message/${entry.ID}`)
        ).json()) as any;
        if (
          message.Text?.includes(`配置版本：${saved.version}\n`) &&
          message.From?.Name === saved.fromName
        )
          return message;
      }
      return null;
    },
    (m) => !!m,
  );
  assert.equal(delivered.From.Address, saved.fromAddress);
  checks.push('Actual container Worker sends the saved sender through SMTP; Mailpit received it');
  await exec('docker', ['compose', 'restart', 'api', 'worker']);
  await until(
    () =>
      fetch(`${base}/api/v1/health`)
        .then((r) => r.ok)
        .catch(() => false),
    (v) => v,
    30000,
  );
  const retained = await admin.api('/admin/mail');
  assert.equal(retained.version, saved.version);
  assert.equal(retained.fromName, saved.fromName);
  checks.push('Saved mail configuration persists across API and Worker restart');
  const page = await browser.newPage({ baseURL: base, viewport: { width: 1366, height: 900 } });
  await page.goto('/');
  await page.locator('.hero-actions').getByRole('link', { name: '进入报名系统' }).click();
  await expect(page).toHaveURL(
    (u) => u.pathname === '/login' && u.searchParams.get('next') === '/contests',
  );
  await page.locator('#account').fill(credentials.email);
  await page.locator('#password').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '比赛列表', exact: true })).toBeVisible();
  checks.push('Built production website requires login and returns to the contest list');
  await page.goto('/admin?tab=mail');
  await expect(page.locator('#mail-from-name')).toHaveValue('容器邮件配置验收');
  await page.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(page.getByText('邮件服务器连接及认证正常', { exact: true })).toBeVisible();
  checks.push(
    'Production administrator UI renders mail settings and its authenticated CSRF-protected connection probe works',
  );
  passed = true;
  console.log(`Production system settings acceptance: ${checks.length} checks passed`);
} finally {
  if (original && admin) {
    const current = await admin.api('/admin/mail');
    await admin.api('/admin/mail', 'PUT', { ...original, version: current.version });
    if (!hadDatabaseSettings) await dbCode("await db.setting.deleteMany({where:{key:'mail'}});");
  }
  await browser.close();
  await writeFile(
    '.runtime/reports/system-settings-production.json',
    JSON.stringify({ passed, checks, checkedAt: new Date().toISOString() }, null, 2),
  );
}
