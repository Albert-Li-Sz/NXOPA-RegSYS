import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:5173',
    headless: true,
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
