import { expect, type Page } from '@playwright/test';
export async function chooseInstitution(page: Page, selector: string, name: string) {
  const input = page.locator(selector);
  await input.click();
  await input.fill(name);
  await page
    .locator('.el-select-dropdown:visible')
    .getByRole('option')
    .filter({ hasText: name })
    .first()
    .click();
  await expect(
    input.locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]'),
  ).toContainText(name);
}
export async function editRegistration(page: Page) {
  const edit = page.getByRole('button', { name: '编辑报名资料', exact: true });
  await expect(
    edit.or(page.getByRole('button', { name: /^(保存草稿|保存修改|保存并送复核)$/ })),
  ).toBeVisible();
  if (await edit.count()) await edit.click();
}
export async function approveRegistration(page: Page) {
  await page.getByRole('button', { name: '审核报名', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '报名审核', exact: true });
  await expect(dialog.getByRole('button', { name: '确认审核', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '确认审核', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
