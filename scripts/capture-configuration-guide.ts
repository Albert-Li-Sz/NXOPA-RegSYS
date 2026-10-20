import { chromium, expect, type Locator } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { defaultFields, policySchema } from '../packages/contracts/src/index.js';
import { Client, base } from '../tests/integrations/client.js';
import { db, json } from '../apps/server/src/db.js';
import { redis } from '../apps/server/src/auth.js';
if (
  process.env.NODE_ENV === 'production' ||
  !['localhost', '127.0.0.1'].includes(new URL(base).hostname)
)
  throw new Error('Tutorial screenshots use local development fixtures only');
const folder = 'docs/configuration-screenshots';
await mkdir(folder, { recursive: true });
await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
const originalMail = await db.setting.findUnique({ where: { key: 'mail' } });
const admin = await new Client().login('admin');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined });
const page = await browser.newPage({
  viewport: { width: 1100, height: 950 },
  deviceScaleFactor: 1.5,
});
const images: string[] = [];
let contestId = '';
let inviteId = '';
async function shot(name: string, locator: Locator, lastControl?: Locator) {
  await expect(locator).toBeVisible();
  if (lastControl) {
    const box = await locator.boundingBox(),
      end = await lastControl.boundingBox();
    if (!box || !end) throw new Error('Screenshot controls are not visible');
    await page.screenshot({
      path: `${folder}/${name}.png`,
      animations: 'disabled',
      clip: { x: box.x, y: box.y, width: box.width, height: end.y + end.height - box.y + 18 },
    });
  } else await locator.screenshot({ path: `${folder}/${name}.png`, animations: 'disabled' });
  images.push(name);
}
try {
  for (const [name, localized] of [
    ['Local HYDRO acceptance', '本地在线评测系统验收'],
    ['Local DOMJUDGE acceptance', '本地程序设计竞赛评测系统验收'],
  ]) {
    await db.platformInstance.updateMany({
      where: { name },
      data: { name: localized!, version: { increment: 1 } },
    });
  }
  const initial = await admin.api('/admin/mail');
  await admin.api('/admin/mail', 'PUT', {
    ...initial,
    enabled: true,
    host: 'localhost',
    port: 51025,
    security: 'NONE',
    authEnabled: false,
    fromAddress: 'noreply@example.test',
    fromName: '南晓开放原子社在线报名系统',
  });
  const contest = await admin.api('/contests', 'POST', {
    title: `社团程序设计竞赛（配置示例第 ${(await db.contest.count({ where: { title: { startsWith: '社团程序设计竞赛（配置示例' } } })) + 1} 版）`,
    season: '2026',
    location: '南京晓庄学院',
    description:
      '## 参赛须知\n\n| 项目 | 说明 |\n| --- | --- |\n| 报名方式 | 团队报名 |\n| 参赛要求 | 在校学生 |\n\n> 请核对报名信息后提交。\n\n```text\n报名 → 审核 → 缴费 → 入场\n```',
    descriptionFormat: 'MARKDOWN',
    startsAt: '2026-11-15T09:00:00+08:00',
    opensAt: '2026-10-12T00:00:00+08:00',
    closesAt: '2026-11-10T23:59:00+08:00',
    policy: policySchema.parse({
      mode: 'TEAM',
      minMembers: 3,
      maxMembers: 3,
      allowUnofficial: true,
      platformProfiles: ['HYDRO_5_0_7', 'DOMJUDGE_9_0_1'],
      invoiceTypes: ['NORMAL', 'SPECIAL'],
      feeMode: 'FIXED',
      feeCents: 15000,
      paymentInstructions: '线下转账后上传凭证，由管理员确认实际到账。',
    }),
    fields: defaultFields,
    published: false,
  });
  contestId = contest.id;
  await page.goto('http://localhost:5173/');
  await shot('01-home', page.locator('.home-hero'));
  await page.locator('.hero-actions').getByRole('link', { name: '进入报名系统' }).click();
  await expect(page.locator('#account')).toBeVisible();
  await shot('02-login', page.locator('.auth-card'));
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('DemoContest2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contests');
  await page.goto('http://localhost:5173/admin?tab=mail');
  await expect(page.locator('#mail-host')).toHaveValue('localhost');
  await page.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(page.getByText('邮件服务器连接及认证正常', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发送测试邮件', exact: true }).click();
  await expect(page.getByText(/测试邮件发送成功/)).toBeVisible({ timeout: 30000 });
  await shot('03-mail', page.locator('.mail-settings'));
  await page.getByRole('tab', { name: '全局设置', exact: true }).click();
  await shot('04-site', page.locator('.panel .card').first());
  await page.getByRole('tab', { name: '用户权限', exact: true }).click();
  await page.getByRole('button', { name: '生成邀请链接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator('.el-select')
    .filter({ has: page.locator('#authorization-kind') })
    .click();
  await page.getByRole('option', { name: '竞赛管理员', exact: true }).click();
  await dialog.locator('#authorization-email').fill('manager@example.test');
  await dialog
    .locator('.el-select')
    .filter({ has: page.locator('#authorization-contest') })
    .click();
  await page.getByRole('option', { name: contest.title, exact: true }).click();
  await dialog.locator('.el-dialog__header').click();
  await shot('05-role-invitation', dialog.locator('.el-dialog'));
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const invitation = await admin.api('/admin/invitations', 'POST', {
    kind: 'CONTEST_ADMIN',
    targetEmail: 'alice@example.test',
    contestId,
    expiresInDays: 7,
  });
  inviteId = invitation.id;
  const recipientPage = await browser.newPage({
    viewport: { width: 1100, height: 800 },
    deviceScaleFactor: 1.5,
  });
  await recipientPage.goto(invitation.url);
  await recipientPage.locator('#account').fill('alice');
  await recipientPage.locator('#password').fill('DemoContest2026!');
  await recipientPage.getByRole('button', { name: '登录', exact: true }).click();
  await expect(recipientPage.getByRole('button', { name: '确认接受', exact: true })).toBeVisible();
  await shot('06-role-confirmation', recipientPage.locator('.invitation-card'));
  await recipientPage.close();
  await page.goto('http://localhost:5173/admin/platforms');
  await page.locator('#export-contest').click();
  await page.getByRole('option', { name: contest.title, exact: true }).click();
  await shot('07-platform-hydro-export', page.locator('.platform-exports'));
  await page.getByText('DOMjudge 9.x', { exact: true }).click();
  await shot('08-platform-domjudge-export', page.locator('.platform-exports'));
  await page.goto(`http://localhost:5173/admin/contests/${contestId}`);
  await expect(page.locator('#contest-title')).toHaveValue(contest.title);
  await shot('10-contest-policy', page.locator('.panel .card').nth(1));
  await shot('11-contest-finance', page.locator('.panel .card').nth(2));
  await page.locator('.markdown-editor').getByText('预览', { exact: true }).click();
  await shot('23-markdown', page.locator('.markdown-editor'));
  await page.getByRole('tab', { name: '报名字段', exact: true }).click();
  await shot('12-fields', page.locator('.panel .card'));
  await page.getByRole('tab', { name: '准考证模板', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 1800 });
  await shot(
    '13-admission-template',
    page.locator('.panel .card').first(),
    page.getByRole('button', { name: '生成预览', exact: true }),
  );
  await page.setViewportSize({ width: 1100, height: 950 });
  await page.goto('http://localhost:5173/admin?tab=jobs');
  await expect(page.locator('.stats .stat').first()).toContainText('运行中');
  await shot('14-jobs', page.locator('.stats'));
  await writeFile(
    `${folder}/capture.json`,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source:
          'Local development UI with fictitious examples. Credentials and invitation tokens are not shown.',
        images,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Captured ${images.length} configuration tutorial screenshots`);
} finally {
  if (inviteId) await admin.api(`/invitations/${inviteId}`, 'DELETE').catch(() => {});
  if (contestId)
    await db.contest.update({
      where: { id: contestId },
      data: { archived: true, published: false },
    });
  if (originalMail)
    await db.setting.upsert({
      where: { key: 'mail' },
      create: { key: 'mail', value: json(originalMail.value), version: originalMail.version },
      update: { value: json(originalMail.value), version: originalMail.version },
    });
  else await db.setting.deleteMany({ where: { key: 'mail' } });
  await browser.close();
  await redis.quit();
  await db.$disconnect();
}
