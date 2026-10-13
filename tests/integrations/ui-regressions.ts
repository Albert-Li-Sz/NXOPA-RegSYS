import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';

export async function checkUserInterfaces(
  page: Page,
  base: string,
  contestId: string,
  registrationId: string,
  recovery: { path: string; password: string },
) {
  const directory = '.runtime/reports/ui-audit';
  await mkdir(directory, { recursive: true });
  const failures: string[] = [];
  const errors: string[] = [];
  const checks: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const routes = [
    '/',
    '/contests',
    `/contests/${contestId}`,
    '/registrations',
    `/registrations/${registrationId}`,
    `/registrations/${registrationId}?tab=finance`,
    '/account',
    '/support',
    ...['contests', 'jobs', 'users', 'instances', 'tokens', 'site', 'mail', 'github', 'audit'].map(
      (tab) => `/admin?tab=${tab}`,
    ),
    ...['settings', 'fields', 'registrations', 'templates', 'integrations'].map(
      (tab) => `/admin/contests/${contestId}?tab=${tab}`,
    ),
  ];
  for (const width of process.env.UI_AUDIT_QUICK ? [360] : [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [index, route] of routes.entries()) {
      if (process.env.UI_AUDIT_QUICK && route !== '/admin?tab=github') continue;
      await page.goto(base + route);
      await page.waitForLoadState('networkidle');
      const bounds = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      if (bounds.scroll > bounds.width + 1) {
        const controls = await page.locator('input,button,label').evaluateAll((elements) =>
          elements
            .map((element) => ({
              tag: element.tagName,
              type: element.getAttribute('type'),
              class: element.className,
              right: Math.round(element.getBoundingClientRect().right),
              width: Math.round(element.getBoundingClientRect().width),
            }))
            .filter((element) => element.width && element.right > window.innerWidth + 1)
            .slice(0, 15),
        );
        failures.push(
          `${width}px ${route}: document width ${bounds.scroll}px ${JSON.stringify(controls)}`,
        );
      } else checks.push(`Layout ${width}px ${route}`);
      if (width === 360 || bounds.scroll > bounds.width + 1)
        await page.screenshot({ path: `${directory}/${width}-${index}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(base + '/account');
  const originalName = await page.locator('#profile-name').inputValue(),
    originalNickname = await page.locator('#profile-nickname').inputValue(),
    originalPhone = await page.locator('#profile-phone').inputValue();
  await expect(page.locator('#profile-name')).toBeDisabled();
  try {
    await page.locator('#profile-nickname').fill('参赛用户'.repeat(20));
    await page.locator('#profile-phone').fill('13800000000');
    await page.getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(page.locator('.user-menu')).toContainText('参赛用户'.repeat(20));
    await expect(page.locator('#profile-phone')).toHaveValue('13800000000');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    if (width > 361) failures.push(`Long profile nickname: 360px viewport expanded to ${width}px`);
    else checks.push('Long profile nicknames fit mobile navigation while real names stay locked');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${directory}/long-profile-name.png`, fullPage: true });
  } finally {
    await page.locator('#profile-nickname').fill(originalNickname);
    await page.locator('#profile-phone').fill(originalPhone);
    await page.getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(page.locator('.user-menu')).toContainText(originalNickname || originalName);
  }
  const browser = page.context().browser()!;
  const httpContext = await browser.newContext();
  try {
    const httpPage = await httpContext.newPage();
    const httpErrors: string[] = [];
    httpPage.on('pageerror', (error) => httpErrors.push(error.message));
    await httpPage.goto(base.replace('127.0.0.1', 'nxopa-ui.test') + '/login');
    assert.equal(await httpPage.evaluate(() => window.isSecureContext), false);
    assert.equal(await httpPage.evaluate(() => typeof crypto.randomUUID), 'undefined');
    const keys: string[] = [];
    httpPage.on('request', (request) => {
      const key = request.headers()['idempotency-key'];
      if (key) keys.push(key);
    });
    await httpPage.locator('#account').fill('feature_admin');
    await httpPage.locator('#password').fill(recovery.password);
    await httpPage.getByRole('button', { name: '登录', exact: true }).click();
    await expect(httpPage).toHaveURL(/\/contests$/, { timeout: 5000 });
    await httpPage.goto(base.replace('127.0.0.1', 'nxopa-ui.test') + '/account');
    await httpPage.getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(httpPage.getByText('资料已保存', { exact: true })).toBeVisible();
    assert.ok(keys.length >= 2);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys)
      assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(httpErrors, []);
    checks.push('HTTP login and profile save use unique UUID request keys');
  } catch (error) {
    failures.push(`HTTP login: ${String(error).slice(0, 1200)}`);
  } finally {
    await httpContext.close();
  }
  try {
    await page.goto(base + recovery.path);
    await page.locator('#password').fill(recovery.password + '-new');
    await page.getByRole('button', { name: '重置密码', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    await expect(page.locator('.user-menu')).toHaveCount(0);
    checks.push('Password reset clears expired login state');
    await page.locator('#account').fill('feature_admin');
    await page.locator('#password').fill(recovery.password + '-new');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/contests$/);
    await page.goto(base + '/account');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.user-menu')).toHaveCount(0);
    await expect(page.locator('#account')).toBeVisible();
    checks.push('Revoking the current session returns to login');
  } catch (error) {
    failures.push(`Account session recovery: ${String(error).slice(0, 1200)}`);
  }
  await writeFile(
    `${directory}/result.json`,
    JSON.stringify({ checks, failures, errors }, null, 2),
  );
  assert.deepEqual(errors, [], 'Pages should not raise script errors');
  assert.deepEqual(failures, [], 'Layout, HTTP forms and account session regressions');
}
