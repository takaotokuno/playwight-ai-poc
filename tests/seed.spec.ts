import { test, expect } from './fixtures/index.js';

test('seed: テスト環境に接続する', async ({ page }) => {
  const response = await page.goto('/');
  expect(response, '接続先から HTTP 応答が必要です').not.toBeNull();
  expect(response!.ok(), '接続先の HTTP ステータスを確認してください').toBeTruthy();
  await expect(page.locator('body')).toBeVisible();
});
