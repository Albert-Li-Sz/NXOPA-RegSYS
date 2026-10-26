import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../integrations/client.js';
import { exportFixture } from '../integrations/platform-export-fixture.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';

test('room codes can be edited and the downloaded Hydro package uses student-ID logins and room-code seats', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  if (redis.status === 'end') await redis.connect();
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  await redis.del(`rate:exports:${admin.user.id}`);
  const fixture = await exportFixture(admin.user.id);
  const stage = await mkdtemp(path.join(tmpdir(), 'hydro-export-download-'));
  const evidence = path.join(tmpdir(), 'contest-center-hydro-qa');
  await mkdir(evidence, { recursive: true });
  try {
    const title = `2026 程序设计竞赛（配置示例 ${fixture.contest.id.slice(0, 4)}）`;
    await db.contest.update({
      where: { id: fixture.contest.id },
      data: { title, modules: { admissions: false, rooms: true, integrations: true } },
    });
    await db.formVersion.create({
      data: { contestId: fixture.contest.id, version: 1, fields: [], schema: {} },
    });
    await page.goto('/login');
    await page.locator('#account').fill('admin');
    await page.locator('#password').fill('DemoContest2026!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.user-menu')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/admin/contests/${fixture.contest.id}?tab=rooms`);
    await expect(page).toHaveURL(new RegExp(`/admin/contests/${fixture.contest.id}\\?tab=rooms$`));
    await expect(page).toHaveTitle(/南晓|报名|Contest/);
    await expect(page.getByRole('heading', { name: '考场与座位', exact: true })).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '新增考场', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '新增考场', exact: true });
    await dialog.getByLabel('考场名称', { exact: true }).fill('教学楼 101');
    await dialog.getByLabel('考场编号', { exact: true }).fill(' a ');
    await dialog.getByRole('spinbutton').first().fill('200');
    await dialog.getByRole('button', { name: '保存考场', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const room = (await admin.api(`/contests/${fixture.contest.id}/rooms`)).rooms[0];
    expect(room.code).toBe('A');
    const row = page.getByRole('row').filter({ hasText: '教学楼 101' });
    await expect(row.getByRole('cell', { name: 'A', exact: true })).toBeVisible();
    await row.getByRole('button', { name: '修改及查看', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '考场详情', exact: true });
    await expect(dialog.locator('#room-code')).toBeDisabled();
    await dialog.getByRole('button', { name: '编辑', exact: true }).click();
    await dialog.locator('#room-code').fill('b');
    await dialog.screenshot({ path: path.join(evidence, 'room-code-edit.png') });
    await dialog.getByRole('button', { name: '保存考场', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row.getByRole('cell', { name: 'B', exact: true })).toBeVisible();
    const request = {
      registrationIds: fixture.rows.slice(0, 2).map((r) => r.id),
      assignments: fixture.rows
        .slice(0, 2)
        .map((r, i) => ({ registrationId: r.id, roomId: room.id, seat: i === 0 ? 1 : 100 })),
    };
    const preview = await admin.api(
      `/contests/${fixture.contest.id}/seating/preview`,
      'POST',
      request,
    );
    expect(preview.errors).toEqual([]);
    await admin.api(`/contests/${fixture.contest.id}/seating/commit`, 'POST', {
      ...request,
      ...preview,
    });
    await page.getByRole('tab', { name: '平台文件导出', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '导出平台导入文件', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.platform-exports')).toContainText('学号作为登录名');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: path.join(evidence, 'hydro-export-desktop.png'),
      fullPage: false,
    });
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: /^(默认导出|导出平台导入包)$/, exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`hydro-${fixture.contest.id}.zip`);
    const zip = path.join(stage, 'hydro.zip');
    await download.saveAs(zip);
    const content = (name: string) =>
      execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8' });
    const teams = JSON.parse(content('teams.json'));
    expect(teams.map((team: any) => team.id)).toEqual(fixture.rows.slice(0, 2).map((r) => r.id));
    expect(teams.map((team: any) => team.name)).toEqual(fixture.studentIds.slice(0, 2));
    expect(teams.map((team: any) => team.seat)).toEqual(['B01', 'B100']);
    expect(teams.map((team: any) => team.rank)).toEqual([true, false]);
    expect(content('credentials.csv')).toContain(`"${teams[0].name}","${teams[0].password}","B01"`);
    expect(content('README.txt')).toContain('id 固定为报名 UUID');
    await page.goto('/admin/platforms');
    await page.locator('#export-contest').click();
    await page.getByRole('option', { name: title, exact: true }).click();
    await expect(page.getByRole('listbox')).toBeHidden();
    await page.locator('.platform-exports').screenshot({
      path: path.join(evidence, 'hydro-export-tutorial.png'),
      animations: 'disabled',
    });
    await page.getByText('DOMjudge 9.x', { exact: true }).click();
    await page.locator('.platform-exports').screenshot({
      path: path.join(evidence, 'domjudge-export-tutorial.png'),
      animations: 'disabled',
    });
    await page.getByText('Hydro 最新版（Onsite Toolkit）', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole('button', { name: /^(默认导出|导出平台导入包)$/, exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(evidence, 'hydro-export-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
    console.log(`Hydro UI evidence: ${evidence}`);
  } finally {
    await fixture.cleanup();
    await rm(stage, { recursive: true, force: true });
    await db.$disconnect();
    redis.disconnect();
  }
});
