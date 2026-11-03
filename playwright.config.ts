import { defineConfig } from '@playwright/test';

if (!process.env.RECSTEAD_TEST_URL) throw new Error('Run npm run test:browser to test an installed package.');
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  maxFailures: 1,
  timeout: 30_000,
  outputDir: '.artifacts/browser-results',
  reporter: [['list'], ['json', { outputFile: `.artifacts/browser-${process.env.RECSTEAD_TEST_PUBLISHED ? 'published' : 'candidate'}-results.json` }]],
  use: {
    baseURL: process.env.RECSTEAD_TEST_URL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  },
});
