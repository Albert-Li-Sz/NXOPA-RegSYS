import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, until } from '../integrations/client.js';
import { exportFixture } from '../integrations/platform-export-fixture.js';
import { pdfText } from '../integrations/pdf-text.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { defaultTemplate } from '../../packages/contracts/src/index.js';

test('admission template exposes shared credential variables and a real preview follows the activity switch', async ({
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
  const f = await exportFixture(admin.user.id);
  const previewJobs: string[] = [];
  const evidence = path.join(tmpdir(), 'contest-center-accounts-qa');
  await mkdir(evidence, { recursive: true });
  try {
    await db.contest.update({
      where: { id: f.contest.id },
      data: { modules: { admissions: true, rooms: false, integrations: true } },
    });
    await db.formVersion.create({
      data: { contestId: f.contest.id, version: 1, fields: [], schema: {} },
    });
    await page.goto('/login');
    await page.locator('#account').fill('admin');
    await page.locator('#password').fill('DemoContest2026!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.user-menu')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/admin/contests/${f.contest.id}?tab=templates`);
    await expect(page).toHaveTitle(/南晓|报名|Contest/);
    await expect(page.getByRole('heading', { name: 'LaTeX 模板', exact: true })).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'account.username', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'account.password', exact: true })).toBeVisible();
    const editor = page
      .locator('.card')
      .filter({ has: page.getByRole('heading', { name: 'LaTeX 模板', exact: true }) });
    await editor.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('textbox', { name: 'LaTeX 模板源码' }).fill(defaultTemplate);
    await editor.getByRole('button', { name: '保存为新版本', exact: true }).click();
    await expect(page.getByText('模板新版本已保存', { exact: true })).toBeVisible();
    async function preview() {
      const requested = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/admissions/preview') &&
          response.request().method() === 'POST',
      );
      await editor.getByRole('button', { name: '生成预览', exact: true }).click();
      const job = await (await requested).json();
      previewJobs.push(job.id);
      await until(
        () => admin.api(`/jobs/${job.id}`),
        (result) => {
          expect(result.state, result.error).not.toBe('FAILED');
          return result.state === 'SUCCESS';
        },
        90000,
      );
      await editor.getByRole('button', { name: '检查预览任务', exact: true }).click();
      await expect(page.getByRole('link', { name: '下载预览 PDF', exact: true })).toBeVisible();
      const response = await admin.raw(`/api/v1/jobs/${job.id}/download`);
      expect(response.status).toBe(200);
      return pdfText(new Uint8Array(await response.arrayBuffer()));
    }
    const shown = await preview();
    expect(shown.replace(/\s/g, '')).toContain('0020260001');
    expect(shown.replace(/\s/g, '')).toContain('PreviewContest2026!');
    expect(await db.competitionAccount.count({ where: { contestId: f.contest.id } })).toBe(0);
    await page.screenshot({ path: path.join(evidence, 'credential-template-desktop.png') });
    await editor.screenshot({ path: path.join(evidence, 'credential-template-tutorial.png') });

    await page.getByRole('tab', { name: '活动设置', exact: true }).click();
    await page.locator('.edit-actions').getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByText('启用平台文件导出', { exact: true }).click();
    await page.getByRole('button', { name: '保存活动配置', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '确认关闭功能', exact: true });
    await confirm.getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.getByRole('tab', { name: '平台文件导出', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: '准考证模板', exact: true }).click();
    const hidden = await preview();
    expect(hidden).not.toContain('0020260001');
    expect(hidden).not.toContain('PreviewContest2026!');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(0);
    await page.screenshot({
      path: path.join(evidence, 'credential-template-mobile.png'),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    console.log(`Browser plugin not available; repository Playwright evidence: ${evidence}`);
  } finally {
    await db.job.deleteMany({ where: { id: { in: previewJobs } } });
    await f.cleanup();
    await db.$disconnect();
    redis.disconnect();
  }
});
