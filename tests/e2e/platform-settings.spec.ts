import { test, expect, type Page } from '@playwright/test';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { decrypt } from '../../apps/server/src/security.js';
import { Client } from '../integrations/client.js';

const prefix = `平台界面验收 ${Date.now()}`;
const contestId = '33333333-3333-4333-8333-333333333333';
const ids: string[] = [];
let contestTitle: string;
let admin: Client;
test.use({ actionTimeout: 15000 });
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  admin = await new Client().login('admin');
  contestTitle = (await admin.api(`/contests/${contestId}`)).title;
});
test.beforeEach(async () => {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
});
test.afterAll(async () => {
  await db.platformBinding.deleteMany({ where: { instanceId: { in: ids } } });
  await db.platformInstance.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
async function login(page: Page, name: string) {
  await page.goto('/login');
  await page.locator('#account').fill(name);
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/contests$/);
  await page.goto('/admin/platforms');
}
test('system administrator configures both platforms and preserves saved credentials', async ({
  page,
}) => {
  await login(page, 'admin');
  for (const type of ['HYDRO', 'DOMJUDGE'] as const) {
    const name = `${prefix} ${type}`;
    await page.getByRole('button', { name: /添加 Hydro.*DOMjudge 实例/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#platform-name').fill(name);
    if (type === 'DOMJUDGE') {
      await dialog.locator('.el-select').first().click();
      await page.getByRole('option', { name: 'DOMjudge 9.0.1', exact: true }).click();
    }
    await dialog
      .locator('#platform-url')
      .fill(`http://localhost:${type === 'HYDRO' ? 58888 : 58901}`);
    const credentials =
      type === 'HYDRO'
        ? { token: 'local-fixture-token-32characters-for-testing-only' }
        : { username: 'cc_api', password: 'FixtureAPI2026!' };
    if (type === 'HYDRO') await dialog.locator('#platform-token').fill(credentials.token!);
    else {
      await dialog.locator('#platform-username').fill(credentials.username!);
      await dialog.locator('#platform-password').fill(credentials.password!);
    }
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '允许使用的竞赛' })
      .locator('.el-select')
      .click();
    await page.getByRole('option', { name: contestTitle, exact: true }).click();
    await dialog.locator('.el-dialog__header').click();
    await dialog.getByRole('button', { name: '保存实例', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();
    const saved = await db.platformInstance.findFirstOrThrow({ where: { name } });
    ids.push(saved.id);
    expect(JSON.parse(decrypt(saved.credentials))).toEqual(credentials);
    await row.getByRole('button', { name: '编辑实例', exact: true }).click();
    const credentialInput = dialog.locator(
      type === 'HYDRO' ? '#platform-token' : '#platform-password',
    );
    await expect(credentialInput).toHaveValue('');
    await dialog.locator('#platform-name').fill(`${name} 已编辑`);
    await dialog.getByRole('button', { name: '保存实例', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const changed = await db.platformInstance.findUniqueOrThrow({ where: { id: saved.id } });
    expect(changed.version).toBe(saved.version + 1);
    expect(JSON.parse(decrypt(changed.credentials))).toEqual(credentials);
    const body = {
      name: changed.name,
      type,
      baseUrl: changed.baseUrl,
      allowedContestIds: [contestId],
      credentials: {},
      version: saved.version,
    };
    expect(
      (await admin.raw(`/api/v1/integrations/instances/${saved.id}`, 'PUT', body)).status,
    ).toBe(409);
    expect(
      (await admin.raw('/api/v1/integrations/instances', 'POST', { ...body, name: '缺失凭据验收' }))
        .status,
    ).toBe(400);
  }
  const instances = await admin.api('/integrations/instances');
  expect(instances.every((i: any) => !('credentials' in i))).toBe(true);
});
test('contest administrator binds an authorized platform without accessing instance secrets', async ({
  page,
}) => {
  await login(page, 'manager');
  await expect(page.getByRole('button', { name: /添加 Hydro.*DOMjudge 实例/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑实例', exact: true })).toHaveCount(0);
  await page
    .locator('.el-select')
    .filter({ has: page.locator('#binding-contest') })
    .click();
  await page.getByRole('option', { name: contestTitle, exact: true }).click();
  await page
    .locator('.el-select')
    .filter({ has: page.locator('#binding-instance') })
    .click();
  await page
    .getByRole('option', { name: `${prefix} DOMJUDGE 已编辑 · DOMjudge`, exact: true })
    .click();
  await page.locator('#binding-remote').fill(`cc-ui-${Date.now()}`);
  await page.locator('#binding-organization').fill('test-org');
  await page.locator('#binding-group').fill('1');
  await page
    .locator('.el-switch')
    .filter({ has: page.getByRole('switch', { name: '参赛资格生效时自动同步' }) })
    .locator('.el-switch__core')
    .click();
  await page.getByRole('button', { name: '保存比赛绑定' }).click();
  await expect(page.getByText('比赛绑定已保存', { exact: true })).toBeVisible();
  const instance = await db.platformInstance.findFirstOrThrow({
    where: { name: `${prefix} DOMJUDGE 已编辑` },
  });
  const binding = await db.platformBinding.findFirstOrThrow({ where: { instanceId: instance.id } });
  expect(binding.contestId).toBe(contestId);
  expect(binding.groupIds).toEqual(['1']);
  expect(binding.automatic).toBe(false);
  await page
    .getByRole('row')
    .filter({ hasText: binding.remoteContestId })
    .getByRole('button', { name: '编辑绑定' })
    .click();
  await expect(page.locator('#binding-remote')).toBeDisabled();
  await page.locator('#binding-organization').fill('');
  await page.getByRole('button', { name: '保存比赛绑定' }).click();
  await expect
    .poll(
      async () =>
        (await db.platformBinding.findUniqueOrThrow({ where: { id: binding.id } })).organizationId,
    )
    .toBeNull();
  await page.screenshot({
    path: '.runtime/reports/platform-admin.png',
    fullPage: true,
    animations: 'disabled',
  });
  const manager = await new Client().login('manager');
  const alice = await new Client().login('alice');
  expect((await manager.raw('/api/v1/integrations/instances', 'POST', {})).status).toBe(403);
  expect((await alice.raw('/api/v1/integrations/instances')).status).toBe(403);
  expect((await alice.raw(`/api/v1/integrations/bindings?contestId=${contestId}`)).status).toBe(
    403,
  );
});
