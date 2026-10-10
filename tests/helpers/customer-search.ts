import type { Page } from '@playwright/test';

export async function searchCustomers(page: Page, name: string) {
  await page.getByRole('textbox', { name: '顧客名' }).fill(name);
  await page.getByRole('button', { name: '検索', exact: true }).click();
}
