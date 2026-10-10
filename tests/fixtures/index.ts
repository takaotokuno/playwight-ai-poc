import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    if (!baseURL) {
      throw new Error('BASE_URL が未設定です。.env にテスト環境の URL を設定してください。');
    }
    await use(page);
  },
});
export { expect };
