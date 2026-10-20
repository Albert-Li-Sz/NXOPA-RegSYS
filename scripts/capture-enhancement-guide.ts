import { chromium, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Client } from '../tests/integrations/client.js';
import { db } from '../apps/server/src/db.js';
import { redis } from '../apps/server/src/auth.js';
import { policySchema } from '../packages/contracts/src/index.js';
const mode = process.argv[2] ?? 'DOMJUDGE';
const folder = 'docs/configuration-screenshots';
const manifest = JSON.parse(await readFile(`${folder}/capture.json`, 'utf8'));
const images = new Set<string>(manifest.images);
let exampleContestId = '';
let financeGrantId = '';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1.25,
  reducedMotion: 'reduce',
});
async function screenshot(page: Page, name: string, selector = 'body') {
  await expect(page.locator(selector)).toBeVisible();
  await page
    .locator(selector)
    .screenshot({ path: `${folder}/${name}.png`, animations: 'disabled' });
  images.add(name);
}
try {
  await mkdir(folder, { recursive: true });
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  await db.contest.updateMany({
    where: { title: '开票配置示例竞赛' },
    data: { archived: true, published: false },
  });
  if (mode === 'DOMJUDGE') {
    const report = JSON.parse(
      await readFile('.runtime/reports/domjudge-enhancements.json', 'utf8'),
    );
    const p = await context.newPage();
    await p.goto('http://localhost:58901/login');
    await p.locator('#username').fill('admin');
    await p
      .locator('#inputPassword')
      .fill(
        execFileSync(
          'docker',
          [
            'compose',
            '-f',
            'infra/fixtures/domjudge/compose.yaml',
            'exec',
            '-T',
            'domserver',
            'cat',
            '/opt/domjudge/domserver/etc/initial_admin_password.secret',
          ],
          { encoding: 'utf8' },
        ).trim(),
      );
    await p.locator('button[type="submit"]').click();
    await p.waitForURL('**/jury');
    await p.goto('http://localhost:58901/jury/users');
    await p.locator('input[type="search"]').fill('cc_');
    await screenshot(p, '16-domjudge-users');
    await p.goto('http://localhost:58901/jury/categories');
    await p.locator('input[type="search"]').fill(report.remoteContestId.replace('enhanced-', ''));
    await screenshot(p, '17-domjudge-groups');
    await p.goto('http://localhost:58901/jury/affiliations');
    await p.locator('input[type="search"]').fill(report.organizationId);
    await screenshot(p, '19-domjudge-organizations');
    await p.goto('http://localhost:58901/jury/teams');
    await p.locator('input[type="search"]').fill(report.remoteTeamId);
    const row = p.locator('tr').filter({ hasText: report.remoteTeamId });
    await expect(row).toBeVisible();
    await row.locator('a').filter({ hasText: '增强验收团队' }).first().click();
    await expect(p.getByText('增强验收团队', { exact: false }).first()).toBeVisible();
    await screenshot(p, '20-domjudge-team');
    await p.close();
    const web = await context.newPage();
    await web.goto('http://localhost:5173/login');
    await web.locator('#account').fill('admin');
    await web.locator('#password').fill('DemoContest2026!');
    await web.getByRole('button', { name: '登录', exact: true }).click();
    await expect(web.locator('.user-menu')).toBeVisible();
    const registration = await admin.api(`/registrations/${report.registrationId}`);
    await web.goto(
      `http://localhost:5173/admin/contests/${registration.contestId}?tab=integrations`,
    );
    const bindingRow = web
      .locator('.platform-bindings tr')
      .filter({ hasText: report.remoteContestId });
    await bindingRow.getByRole('button', { name: '学校映射', exact: true }).click();
    await expect(web.getByRole('dialog')).toBeVisible();
    await expect(
      web.getByRole('dialog').getByText('已确认', { exact: true }).first(),
    ).toBeVisible();
    const mappingBox = await web.locator('[role="dialog"] .el-dialog').boundingBox();
    const paginationBox = await web.getByRole('dialog').locator('.list-pagination').boundingBox();
    if (!mappingBox || !paginationBox) throw new Error('School mapping controls are not visible');
    await web.screenshot({
      path: `${folder}/18-school-mapping.png`,
      animations: 'disabled',
      clip: { ...mappingBox, height: paginationBox.y - mappingBox.y - 8 },
    });
    images.add('18-school-mapping');
    await web.keyboard.press('Escape');
    await web.goto('http://localhost:5173/admin?tab=audit');
    await web.getByPlaceholder('搜索日志', { exact: true }).fill(registration.contestId);
    await web.locator('.panel .toolbar .el-select').click();
    await web.getByRole('option', { name: '保存平台绑定', exact: true }).click();
    await expect(web.locator('.list-pagination')).toBeVisible();
    await expect(web.locator('.el-table__body tr').first()).toContainText('保存平台绑定');
    await screenshot(web, '22-pagination', '.panel .card');
    const example = await admin.api('/contests', 'POST', {
      title: '开票配置示例竞赛',
      season: '2026',
      description: '教程虚构示例，不公开发布。',
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      startsAt: new Date(Date.now() + 172800000).toISOString(),
      policy: policySchema.parse({
        mode: 'TEAM',
        memberMode: 'MANUAL',
        minMembers: 2,
        maxMembers: 3,
        coachMode: 'DISABLED',
        feeMode: 'FIXED',
        feeCents: 15000,
        invoiceTypes: ['NORMAL', 'SPECIAL'],
        invoiceRequiredFields: ['contactName', 'phone'],
      }),
      fields: [],
      published: true,
    });
    exampleContestId = example.id;
    let r = await admin.api('/registrations', 'POST', { contestId: example.id });
    r = await admin.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      teamName: '晓庄示例队',
      people: [
        ...r.people,
        { name: '示例队员', email: 'member@example.test', captain: false, answers: {} },
      ],
    });
    r = await admin.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'APPROVED',
    });
    const attachment = await admin.upload(r.id);
    const voucher = await admin.api(`/finance/${r.id}/vouchers`, 'POST', {
      amountCents: 15000,
      payer: '示例队长',
      channel: '教程线下收款示例',
      reference: `guide-${Date.now()}`,
      paidAt: new Date().toISOString(),
      attachmentId: attachment.id,
    });
    const finance = await new Client().login('bob');
    financeGrantId = (
      await admin.api('/admin/grants', 'POST', {
        userId: finance.user.id,
        level: 'CONTEST',
        contestId: example.id,
        permissions: ['FINANCE'],
      })
    ).id;
    await finance.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
    await web.goto(`http://localhost:5173/registrations/${r.id}?tab=finance`);
    await web.getByRole('button', { name: '申请开票', exact: true }).click();
    const dialog = web.getByRole('dialog');
    await dialog.locator('.el-select').nth(1).click();
    await web.getByRole('option', { name: '非企业单位', exact: true }).click();
    await dialog.locator('#invoice-title').fill('南京晓庄学院');
    await dialog.locator('#invoice-email').fill('finance@example.org');
    await dialog.locator('#invoice-contactName').fill('示例联系人');
    await dialog.locator('#invoice-phone').fill('025-00000000');
    await dialog.locator('#invoice-address').fill('江苏省南京市江宁区');
    await dialog.locator('#invoice-bankName').fill('示例银行南京分行');
    await dialog.locator('#invoice-bankAccount').fill('0000000000000000');
    await dialog.locator('#invoice-remarks').fill('程序设计竞赛报名费用，请核对抬头及接收邮箱。');
    await screenshot(web, '21-invoice-application', '[role="dialog"] .el-dialog');
    await writeFile(
      '.runtime/guide-invoice-context.json',
      JSON.stringify({ registrationId: r.id, contestId: example.id }),
    );
    await db.contest.update({
      where: { id: example.id },
      data: { archived: true, published: false },
    });
    await web.close();
  } else if (mode === 'HYDRO') {
    const report = JSON.parse(await readFile('.runtime/reports/hydro-enhancements.json', 'utf8'));
    const accounts = await admin.api(
      `/integrations/registrations/${report.registrationId}/credentials`,
    );
    const account = accounts.find((x: any) => x.bindingId === report.bindingId);
    const p = await context.newPage();
    await p.goto('http://localhost:58888/login');
    await p.locator('input[name="uname"]:visible').fill(account.username);
    await p.locator('input[name="password"]:visible').fill(account.password);
    await p.locator('[type="submit"]:visible').click();
    await p.waitForURL((url) => url.pathname !== '/login');
    await p.goto(`http://localhost:58888/d/system/contest/${report.remoteContestId}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(
      p.getByText('Contest Center local acceptance', { exact: true }).first(),
    ).toBeVisible();
    await screenshot(p, '15-hydro-contest');
    await p.close();
  } else throw new Error('Expected DOMJUDGE or HYDRO');
  const current = JSON.parse(await readFile(`${folder}/capture.json`, 'utf8'));
  manifest.images = [...new Set([...current.images, ...images])].sort();
  manifest.capturedAt = new Date().toISOString();
  manifest.source =
    'Actual local development UI and isolated Hydro 5.0.7 / DOMjudge 9.0.1 pages; fictitious contest and financial examples; no credentials or invitation tokens displayed.';
  await writeFile(`${folder}/capture.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Tutorial screenshots: ${images.size} captured; ${mode} complete`);
} finally {
  if (financeGrantId)
    await db.adminGrant.update({ where: { id: financeGrantId }, data: { revokedAt: new Date() } });
  if (exampleContestId)
    await db.contest.update({
      where: { id: exampleContestId },
      data: { archived: true, published: false },
    });
  await browser.close();
  await db.$disconnect();
  await redis.quit();
}
