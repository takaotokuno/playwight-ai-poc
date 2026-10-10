import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

const demoPort = Number(process.env.DEMO_PORT || 4173);
const demoUrl = `http://127.0.0.1:${demoPort}`;

export default defineConfig({
  testDir: './tests/demo',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: demoUrl, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node demo/server.mjs',
    url: demoUrl,
    reuseExistingServer: false,
  },
});
