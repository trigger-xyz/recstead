import { defineConfig } from '@playwright/test';

if (!process.env.RECSTEAD_TEST_URL) throw new Error('Run npm run test:browser to test an installed package.');
const target = process.env.RECSTEAD_TEST_PUBLISHED ? 'published' : 'candidate';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  // A focused run would still write an evidence record, so test.only always fails.
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
  outputDir: '.artifacts/browser-results',
  reporter: [['list'], ['json', { outputFile: `.artifacts/browser-${target}-results.json` }]],
  use: {
    baseURL: process.env.RECSTEAD_TEST_URL,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Each engine records through its own native MediaRecorder. Chromium and Firefox
  // generate microphone input themselves; the WebKit build has no capture device,
  // so tests/browser/capture.ts supplies a generated tone at acquisition there.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } } },
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: {
      'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true,
      'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0, 'media.autoplay.block-webaudio': false } } } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
