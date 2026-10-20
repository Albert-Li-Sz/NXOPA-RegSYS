import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const base = process.env.DOCS_TEST_URL ?? 'http://localhost:5184/NXOPA-RegSYS/';
assert(base.endsWith('/NXOPA-RegSYS/'), 'Verify the actual project subpath');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: existsSync(chrome) ? chrome : undefined,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ['clipboard-read', 'clipboard-write'],
  reducedMotion: 'reduce',
});
const checks = [],
  errors = [],
  failedResources = [];
let passed = false;
const reportDirectory = '.runtime/reports';
await mkdir(reportDirectory, { recursive: true });
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  if (response.status() >= 400) failedResources.push(response.url());
});
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle('配置教程 · 南晓开放原子社在线报名系统');
  await expect(page.getByRole('heading', { name: '系统配置教程', exact: false })).toBeVisible();
  const info = await (await page.request.get(new URL('build-info.json', base).href)).json();
  await expect(page.locator('.chapter')).toHaveCount(info.chapters.length);
  await expect(page.locator('figure img')).toHaveCount(info.screenshots);
  assert.equal(info.chapters.length, 16);
  assert.ok(info.screenshots >= 15);
  await expect(page.locator('#mail')).toContainText('后台保存后优先使用数据库配置');
  await expect(page.locator('#operations pre').first()).toContainText('{{#each team.members}}');
  await expect(page.locator('#operations pre').first()).toContainText('{{this.name}}');
  checks.push(
    `${info.chapters.length} Chinese chapters and all ${info.screenshots} actual screenshots rendered from LaTeX; template variables are intact`,
  );

  const assets = await page.evaluate(async () => {
    const urls = [
      ...new Set([
        ...[...document.querySelectorAll('img[src],script[src]')].map((e) => e.src),
        ...[...document.querySelectorAll('link[href]')].map((e) => e.href),
      ]),
    ];
    return Promise.all(urls.map(async (url) => ({ url, status: (await fetch(url)).status })));
  });
  assert(
    assets.every((a) => a.status === 200),
    JSON.stringify(assets.filter((a) => a.status !== 200)),
  );
  checks.push('Every image, stylesheet, script and favicon resolves below /NXOPA-RegSYS/');
  await page.screenshot({ path: reportDirectory + '/docs-site-desktop.png', fullPage: false });

  await page.locator('#chapter-nav a[href="#deployment"]').click();
  await expect(
    page.getByRole('heading', { name: '首次部署与管理员初始化', exact: true }),
  ).toBeInViewport();
  await page.locator('#deployment .copy-code').first().click();
  await expect(page.getByRole('status')).toHaveText('配置示例已复制');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert(
    clipboard.startsWith(
      'curl -fsSL https://raw.githubusercontent.com/Albert-Li-Sz/NXOPA-RegSYS/main/install.sh -o install.sh\nbash install.sh',
    ),
  );
  await page.locator('#chapter-nav a[href="#mail"]').click();
  await expect(page.locator('#chapter-nav a[href="#mail"]')).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect(page.getByRole('status')).not.toHaveClass(/visible/);
  await page.screenshot({ path: reportDirectory + '/docs-site-mail.png', fullPage: false });
  checks.push('Chapter anchors and active navigation work; copied commands match the LaTeX source');

  await page.locator('#mail .screenshot-open').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#image-viewer img')).toHaveAttribute(
    'src',
    /\/assets\/images\/03-mail\.png$/,
  );
  await expect(page.locator('.viewer-original')).toHaveAttribute(
    'href',
    /\/assets\/images\/03-mail\.png$/,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  checks.push('Screenshot viewer opens the correct original image and closes with Escape');

  for (const [remote, local] of [
    ['configuration-guide.pdf', 'output/pdf/configuration-guide.pdf'],
    ['configuration-guide-source.zip', 'output/pdf/configuration-guide-source.zip'],
    ['CONFIGURATION_GUIDE.tex', 'docs/CONFIGURATION_GUIDE.tex'],
  ]) {
    const received = await page.evaluate(async (path) => {
      const r = await fetch(new URL('downloads/' + path, location.href));
      const data = await r.arrayBuffer();
      const hash = await crypto.subtle.digest('SHA-256', data);
      return {
        status: r.status,
        bytes: data.byteLength,
        hash: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    }, remote);
    const expected = await readFile(local);
    assert.equal(received.status, 200);
    assert.equal(received.bytes, expected.length);
    assert.equal(received.hash, createHash('sha256').update(expected).digest('hex'));
  }
  checks.push(
    'PDF, source ZIP and LaTeX downloads have the exact hashes of the delivered artifacts',
  );
  await expect(page.locator('#hydro')).toContainText('onsiteImport');
  await expect(page.locator('#domjudge')).toContainText('accounts.json');
  await expect(page.getByText('Hydro 插件下载', { exact: true })).toHaveCount(0);
  checks.push(
    'Hydro Onsite Toolkit and DOMjudge manual import tutorials replace the retired bridge download',
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(page.locator('#menu-toggle')).toBeVisible();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: reportDirectory + '/docs-site-mobile.png', fullPage: false });
  await page.locator('#menu-toggle').click();
  await expect(page.locator('#menu-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#chapter-nav a[href="#domjudge"]').click();
  await expect(page.locator('#menu-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('heading', { name: '导出 DOMjudge 导入文件', exact: true }),
  ).toBeInViewport();
  await page.locator('#menu-toggle').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#operations').scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(failedResources.length, 0, failedResources.join('\n'));
  checks.push(
    '390px mobile layout has no horizontal overflow; menu navigation and Escape work without script or asset failures',
  );
  passed = true;
  console.log('Tutorial website acceptance: ' + checks.length + ' checks passed');
} finally {
  await writeFile(
    reportDirectory + '/docs-site-browser.json',
    JSON.stringify(
      {
        passed,
        base,
        checks,
        errors,
        failedResources,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  await browser.close();
}
