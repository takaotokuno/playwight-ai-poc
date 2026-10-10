import { test, expect } from '../fixtures/index.js';
import { searchCustomers } from '../helpers/customer-search.js';

// spec: specs/demo-customer.md
// ledger: migration/features/demo-customer.md
test('F-001/AC-001 部分一致の結果を顧客番号順に表示する', async ({ page }) => {
  await page.goto('/');
  await searchCustomers(page, '山田');
  await expect(page.getByRole('columnheader')).toHaveText(['顧客番号', '顧客名', '契約状態']);
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole('cell')).toHaveText(['001', '山田太郎', '解約']);
  await expect(rows.nth(1).getByRole('cell')).toHaveText(['002', '山田花子', '契約中']);
});

test('F-001/AC-002 該当なしのメッセージを表示する', async ({ page }) => {
  await page.goto('/');
  await searchCustomers(page, '存在しない顧客');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('該当する顧客はありません');
});
