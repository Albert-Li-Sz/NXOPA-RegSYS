import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../integrations/client.js';
import { exportFixture } from '../integrations/platform-export-fixture.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { policySchema } from '../../packages/contracts/src/index.js';

const evidence = process.env.ACCOUNT_QA_DIR ?? path.join(tmpdir(), 'contest-center-accounts-qa');
async function login(page: Page) {
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  await page.goto('/login');
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.user-menu')).toBeVisible();
}
test.afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
});

test('Hydro default and selected ZIP downloads obey field selection on desktop and mobile', async ({
  page,
}) => {
  await mkdir(evidence, { recursive: true });
  const stage = await mkdtemp(path.join(tmpdir(), 'hydro-ui-'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const admin = await new Client().login('admin');
  const f = await exportFixture(admin.user.id);
  try {
    await db.formVersion.create({
      data: { contestId: f.contest.id, version: 1, fields: [], schema: {} },
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/admin/contests/${f.contest.id}?tab=integrations`);
    await expect(page.getByRole('heading', { name: '导出平台导入文件' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /报名 ID/ })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: /登录学号/ })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: /排名性质/ })).toBeDisabled();
    await page.locator('label.el-checkbox').filter({ hasText: '比赛密码' }).click();
    await expect(page.getByRole('checkbox', { name: /比赛密码/ })).not.toBeChecked();
    async function downloaded(button: string) {
      const requested = page.waitForRequest(
        (request) => request.url().endsWith('/platform-exports') && request.method() === 'POST',
      );
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: button, exact: true }).click();
      const file = path.join(stage, `${button}.zip`);
      await (await download).saveAs(file);
      return {
        request: (await requested).postDataJSON(),
        get: (name: string) => execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' }),
      };
    }
    const full = await downloaded('默认导出');
    expect(full.request.hydroFields).toBeUndefined();
    const teams = JSON.parse(full.get('teams.json'));
    expect(teams[0].password.length).toBeGreaterThan(20);
    const custom = await downloaded('自选字段导出');
    expect(custom.request.hydroFields).not.toContain('password');
    expect(JSON.parse(custom.get('teams.json'))[0].password).toBeUndefined();
    for (const file of ['teams.json', 'credentials.csv', 'README.txt'])
      for (const team of teams) expect(custom.get(file)).not.toContain(team.password);
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: /比赛密码/ })).toBeChecked();
    await page
      .locator('.platform-exports')
      .screenshot({ path: path.join(evidence, 'hydro-fields-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await expect(page.getByRole('button', { name: '自选字段导出', exact: true })).toBeVisible();
    await page
      .locator('.platform-exports')
      .screenshot({ path: path.join(evidence, 'hydro-fields-mobile.png') });
    expect(errors).toEqual([]);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally {
    await f.cleanup();
    await rm(stage, { recursive: true, force: true });
  }
});

test('administrator edits a closed approved registration and directly reviews it without applicant resubmission', async ({
  page,
}) => {
  await mkdir(evidence, { recursive: true });
  await login(page);
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice');
  const c = await admin.api('/contests', 'POST', {
    title: `管理员代改浏览器 ${Date.now()}`,
    season: 'UI',
    description: '截止后直接代改并复核',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 3600000).toISOString(),
    closesAt: new Date(Date.now() + 3600000).toISOString(),
    published: true,
    modules: { admissions: true, rooms: false, integrations: false },
    policy: policySchema.parse({ manualReview: true, coachMode: 'DISABLED' }),
    fields: [],
  });
  try {
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'APPROVED',
    });
    await db.contest.update({
      where: { id: c.id },
      data: {
        closesAt: new Date(Date.now() - 10000),
        correctionUntil: new Date(Date.now() - 5000),
      },
    });
    await page.goto(`/registrations/${r.id}`);
    await page.getByRole('button', { name: '编辑报名资料', exact: true }).click();
    await expect(page.getByText(/管理员修正须填写完整资料/)).toBeVisible();
    await page.getByRole('button', { name: '保存并送复核', exact: true }).click();
    await expect(page.getByRole('button', { name: '编辑报名资料', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '编辑报名资料', exact: true }).click();
    await page.locator('#person-0-name').fill('管理员浏览器修正姓名');
    await page.getByRole('button', { name: '保存并送复核', exact: true }).click();
    await expect(
      page.getByText('修改已保存并送管理员复核，无需选手重新提交', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑报名资料', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '提交报名', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '审核报名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '报名审核', exact: true });
    await expect(dialog.getByText('管理员浏览器修正姓名', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/本次提交变化：.*成员资料/)).toBeVisible();
    await dialog.getByRole('button', { name: '确认审核', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '编辑报名资料', exact: true })).toBeVisible();
    const current = await admin.api(`/registrations/${r.id}`);
    expect(current.eligible).toBe(true);
    expect(current.snapshot.people[0].name).toBe('管理员浏览器修正姓名');
    await page.screenshot({
      path: path.join(evidence, 'admin-edit-reviewed.png'),
      fullPage: false,
    });
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally {
    await db.contest.update({ where: { id: c.id }, data: { archived: true } });
  }
});
