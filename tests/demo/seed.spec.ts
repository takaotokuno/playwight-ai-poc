import { test, expect } from '../fixtures/index.js';

test('seed: デモ環境への接続', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '顧客検索' })).toBeVisible();
});
